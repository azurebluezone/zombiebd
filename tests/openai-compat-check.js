#!/usr/bin/env node
"use strict";

/*
 * OpenAI-compatible client gate for the main gateway port.
 *
 * Contract gc-mwpy13or — prints OPENAI_COMPAT_OK only when every live check
 * passes. No mocks: the real Caddy edge (https://localhost -> 127.0.0.1:5050),
 * the real SQLite users table, the real provider adapters and the real MCP
 * server are used.
 *
 * Checks:
 *   1. TLS-verified /health through the Caddy edge.
 *   2. Standard OpenAI auth: Authorization: Bearer <users.api_key> is accepted
 *      on /v1/chat/completions (not only session tokens).
 *   3. Non-stream response is a valid chat.completion.
 *   4. SSE stream frames are valid chat.completion.chunk objects and end with
 *      data: [DONE].
 *   5. A live model emits a tool_call with a JSON-string arguments field.
 *   6. MCP initialize over the same trusted edge returns a session id and a
 *      JSON-RPC result; notifications/initialized and tools/list work with it.
 *
 * The 5011 endpoint is probed only to document the VS Code client failure; it
 * never decides this gate (the main port is the Caddy edge).
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { readEnvFile } = require("../lib/env.js");
const validator = require("../provider/validator.js");

const ROOT = path.resolve(__dirname, "..");
const RAW = Object.assign(
  {},
  readEnvFile(path.join(ROOT, ".env")),
  process.env,
);
const BASE = String(RAW.COMPAT_BASE_URL || "https://localhost").replace(/\/+$/, "");
const CA_PATH = String(RAW.COMPAT_CA_BUNDLE || "/etc/ssl/certs/ca-certificates.crt");
const CA = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : undefined;
const KEY = String(RAW.ADMIN_API_KEY || "").trim();
const AUTH = {
  "Content-Type": "application/json",
  Authorization: "Bearer " + KEY,
};

const failures = [];
function ok(name, detail) {
  console.log("ok   " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  const line = name + (detail ? ": " + detail : "");
  failures.push(line);
  console.log("FAIL " + line);
}
function info(name, detail) {
  console.log("info " + name + (detail ? " — " + detail : ""));
}

function request(method, url, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const proto = isHttps ? https : http;
    const headers = opts.headers || {};
    const body = opts.body == null
      ? null
      : (typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body));
    const req = proto.request(
      {
        method: method,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers: body && !headers["Content-Length"]
          ? Object.assign({}, headers, { "Content-Length": Buffer.byteLength(body) })
          : headers,
        ca: isHttps ? (opts.ca === undefined ? CA : opts.ca) : undefined,
        servername: isHttps ? u.hostname : undefined,
        rejectUnauthorized: opts.rejectUnauthorized !== false,
        timeout: opts.timeout || 60000,
      },
      function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("timeout", function () { req.destroy(new Error("request timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(label + " is not JSON: " + e.message);
  }
}

function parseJsonRpc(text, label) {
  const trimmed = String(text || "").trim();
  if (trimmed.startsWith("{")) return parseJson(trimmed, label);
  const line = trimmed.split(/\r?\n/).find(function (l) {
    return l.startsWith("data: ");
  });
  if (!line) throw new Error(label + " carries no JSON-RPC payload");
  return parseJson(line.slice(6).trim(), label);
}

async function main() {
  if (!KEY) {
    fail("admin-api-key", "ADMIN_API_KEY is empty in .env");
    return;
  }

  // 1. TLS-verified health through the same edge a native client uses.
  try {
    const r = await request("GET", BASE + "/health");
    const j = parseJson(r.body, "health");
    if (r.status !== 200) fail("health-status", String(r.status));
    else if (j.healthy !== true) fail("health-flag", String(j.healthy));
    else ok("health", "version=" + j.version + " models=" + j.models + " agents=" + j.agents);
  } catch (e) {
    fail("health-tls", e.code || e.message);
  }

  // 2 + 3. Bearer API key on the standard OpenAI chat path.
  let chatModel = "";
  try {
    const r = await request("POST", BASE + "/v1/chat/completions", {
      headers: AUTH,
      body: {
        model: "code-guru",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 32,
      },
    });
    const j = parseJson(r.body, "chat.completion");
    if (r.status !== 200) {
      fail("bearer-auth", "HTTP " + r.status + " " + (j.error && j.error.message || ""));
    } else if (j.object !== "chat.completion") {
      fail("chat-object", String(j.object));
    } else if (!Array.isArray(j.choices) || !j.choices[0] || !j.choices[0].message) {
      fail("chat-choices", "missing choices[0].message");
    } else if (j.choices[0].message.role !== "assistant") {
      fail("chat-role", String(j.choices[0].message.role));
    } else if (typeof j.choices[0].message.content !== "string") {
      fail("chat-content", typeof j.choices[0].message.content);
    } else {
      chatModel = j.model || "code-guru";
      ok("bearer-auth", "HTTP 200, model=" + chatModel);
      ok("non-stream", "chat.completion with assistant content");
    }
  } catch (e) {
    fail("non-stream", e.code || e.message);
  }

  // 4. SSE stream — every frame must satisfy the canonical chunk schema.
  try {
    const r = await request("POST", BASE + "/v1/chat/completions", {
      headers: Object.assign({ Accept: "text/event-stream" }, AUTH),
      body: {
        model: chatModel || "code-guru",
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 32,
        stream: true,
      },
    });
    if (r.status !== 200) {
      fail("stream-status", String(r.status));
    } else {
      const blocks = r.body.split(/\n\n/).filter(function (b) { return b.trim(); });
      let frames = 0;
      let done = false;
      let invalid = 0;
      for (const block of blocks) {
        const line = block.split(/\r?\n/).find(function (l) { return l.startsWith("data: "); });
        if (!line) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") { done = true; continue; }
        let chunk;
        try { chunk = JSON.parse(payload); } catch (e) { invalid++; continue; }
        const v = validator.validateDelta(chunk);
        if (!v.valid) {
          invalid++;
          info("stream-frame", v.errors.join("; "));
        } else {
          frames++;
        }
      }
      if (frames < 2) fail("stream-frames", "valid frames=" + frames);
      else if (invalid > 0) fail("stream-invalid", String(invalid));
      else if (!done) fail("stream-done", "missing data: [DONE]");
      else ok("stream", frames + " valid chunks, data: [DONE]");
    }
  } catch (e) {
    fail("stream", e.code || e.message);
  }

  // 5. Live tool call. Forced function choice, then validate the wire shape.
  const toolModels = ["openai/gpt-oss-20b", "hy4-flash:free", "Qwen/Qwen3.8-Flash"];
  let toolProven = false;
  for (const model of toolModels) {
    try {
      const r = await request("POST", BASE + "/v1/chat/completions", {
        headers: AUTH,
        body: {
          model: model,
          messages: [{ role: "user", content: "Call get_time now. Do not answer in text." }],
          tools: [{
            type: "function",
            function: {
              name: "get_time",
              description: "Return the current time",
              parameters: { type: "object", properties: {} },
            },
          }],
          tool_choice: { type: "function", function: { name: "get_time" } },
          max_tokens: 64,
        },
      });
      if (r.status !== 200) continue;
      const j = parseJson(r.body, "tool response");
      const msg = j.choices && j.choices[0] && j.choices[0].message;
      const calls = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      if (!calls.length) continue;
      const call = calls[0];
      const args = call.function && call.function.arguments;
      let parsedArgs = null;
      try { parsedArgs = JSON.parse(args); } catch (e) { parsedArgs = null; }
      if (call.type !== "function") continue;
      if (!call.function || call.function.name !== "get_time") continue;
      if (typeof args !== "string" || !parsedArgs || typeof parsedArgs !== "object") continue;
      ok("tool-call", model + " emitted get_time with JSON-string arguments");
      toolProven = true;
      break;
    } catch (e) {
      info("tool-call-try", model + ": " + (e.code || e.message));
    }
  }
  if (!toolProven) fail("tool-call", "no live model emitted a valid get_time tool_call");

  // 6. MCP initialize + session + tools/list over the trusted edge.
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let sessionId = "";
  try {
    const r = await request("POST", BASE + "/mcp", {
      headers: mcpHeaders,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "openai-compat-check", version: "1.0.0" },
          capabilities: {},
        },
      },
    });
    const j = parseJsonRpc(r.body, "mcp initialize");
    sessionId = String(r.headers["mcp-session-id"] || "");
    const version = String(r.headers["mcp-protocol-version"] || "");
    if (r.status !== 200) fail("mcp-status", String(r.status));
    else if (!sessionId) fail("mcp-session", "Mcp-Session-Id header missing");
    else if (!version) fail("mcp-version", "MCP-Protocol-Version header missing");
    else if (!j.result || !j.result.serverInfo) fail("mcp-result", "serverInfo missing");
    else ok("mcp-initialize", "protocol=" + version + " session=" + sessionId.slice(0, 12) + "…");
  } catch (e) {
    fail("mcp-initialize", e.code || e.message);
  }

  if (sessionId) {
    try {
      const r = await request("POST", BASE + "/mcp", {
        headers: Object.assign({ "Mcp-Session-Id": sessionId }, mcpHeaders),
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      if (r.status !== 200 && r.status !== 202 && r.status !== 204) {
        fail("mcp-initialized", "HTTP " + r.status);
      } else {
        ok("mcp-initialized", "HTTP " + r.status);
      }
    } catch (e) {
      fail("mcp-initialized", e.code || e.message);
    }
    try {
      const r = await request("POST", BASE + "/mcp", {
        headers: Object.assign({ "Mcp-Session-Id": sessionId }, mcpHeaders),
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      const j = parseJsonRpc(r.body, "mcp tools/list");
      const tools = j.result && Array.isArray(j.result.tools) ? j.result.tools : [];
      if (r.status !== 200) fail("mcp-tools-status", String(r.status));
      else if (!tools.length) fail("mcp-tools", "empty tools array");
      else ok("mcp-tools", tools.length + " tools");
    } catch (e) {
      fail("mcp-tools", e.code || e.message);
    }
  }

  // 7. VS Code root-cause evidence: the 5011 self-signed endpoint must not be
  // trusted by the system CA bundle. This is informational, not a gate.
  try {
    const r = await request("POST", "https://127.0.0.1:5011/mcp", {
      headers: mcpHeaders,
      body: { jsonrpc: "2.0", id: 9, method: "initialize", params: {} },
      timeout: 5000,
    });
    info("vscode-5011", "TLS verified (HTTP " + r.status + ") — endpoint is trusted");
  } catch (e) {
    info("vscode-5011", "TLS rejected: " + (e.code || e.message) + " — use https://localhost/mcp");
  }

  if (failures.length) {
    console.error("\nOPENAI_COMPAT_FAILED (" + failures.length + " failing check(s))");
    process.exitCode = 1;
    return;
  }
  console.log("\nOPENAI_COMPAT_OK");
}

main().catch(function (e) {
  console.error("OPENAI_COMPAT_FAILED: " + (e.stack || e.message));
  process.exitCode = 1;
});
