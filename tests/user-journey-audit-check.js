#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: user-journey audit (2026-11-21)
// =============================================================================
// Runs against the live gateway and the real edge, not a mock:
//   - /health, frontend bytes, one real chat completion;
//   - MCP tools/list + a real system_info tool call;
//   - HTTPS localhost + the seven per-tool vhosts;
//   - the missing upload endpoint and the documented row-14 gap;
//   - the runbook audit section and the real Edge TTS MP3.
//
// Run: node tests/user-journey-audit-check.js
// Exit 0 + USER_JOURNEY_AUDIT_OK only when every check passes.
// =============================================================================

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const PORT = 5050;
const RUNBOOK = path.join(ROOT, "docs/RUNBOOK-OPTIMIZATION-2026-11-19.md");
const AUDIO = "/home/sahon/Music/mp3/zc lama/zc-audit-2026-11-21.mp3";
const VHOSTS = [
  "ocr.localhost",
  "screen.localhost",
  "tts.localhost",
  "ads.localhost",
  "public.localhost",
  "combined.localhost",
  "adapter.localhost",
];

let pass = 0;
let fail = 0;
const rows = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } catch (err) {
    fail += 1;
    rows.push(["FAIL", name, String((err && err.message) || err)]);
  }
}

function request(method, pathname, body, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        timeout: timeoutMs || 30000,
        headers: Object.assign(
          payload
            ? {
                "content-type": "application/json",
                "content-length": payload.length,
              }
            : {},
          headers || {},
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

function requestHttps(servername, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: HOST,
        port: 443,
        path: pathname,
        method: "GET",
        servername,
        rejectUnauthorized: false,
        timeout: timeoutMs || 10000,
        headers: { host: servername },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port });
    let settled = false;
    const done = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.setTimeout(800);
    socket.on("connect", () => done(false));
    socket.on("timeout", () => done(true));
    socket.on("error", () => done(true));
  });
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  await check("live /health is 200 with 268 models and 9 agents", async () => {
    const res = await request("GET", "/health");
    assert(res.status === 200, "status=" + res.status);
    const json = JSON.parse(res.text);
    assert(json.healthy === true, "healthy=" + json.healthy);
    assert(json.version === "3.2.1", "version=" + json.version);
    assert(json.models === 268, "models=" + json.models);
    assert(json.agents === 9, "agents=" + json.agents);
    return "healthy=true version=3.2.1 models=268 agents=9";
  });

  await check("frontend / is the real index.html", async () => {
    const res = await request("GET", "/");
    assert(res.status === 200, "status=" + res.status);
    assert(/text\/html/.test(String(res.headers["content-type"] || "")), "content-type=" + res.headers["content-type"]);
    const source = fs.readFileSync(path.join(ROOT, "public/index.html"));
    assert(res.body.length === source.length, "served=" + res.body.length + " file=" + source.length);
    assert(sha256(res.body) === sha256(source), "served bytes differ from public/index.html");
    return "bytes=" + res.body.length + " sha=" + sha256(res.body).slice(0, 12);
  });

  await check("one real chat completion returns USER_JOURNEY_OK", async () => {
    const res = await request(
      "POST",
      "/v1/chat/completions",
      {
        model: "code-guru",
        messages: [{ role: "user", content: "Reply with exactly: USER_JOURNEY_OK" }],
        stream: false,
        max_tokens: 20,
      },
      null,
      90000,
    );
    assert(res.status === 200, "status=" + res.status + " body=" + res.text.slice(0, 200));
    const json = JSON.parse(res.text);
    const content =
      json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : "";
    assert(String(content).includes("USER_JOURNEY_OK"), "content=" + String(content).slice(0, 120));
    return "content=" + String(content).trim();
  });

  await check("MCP tools/list and a real system_info call", async () => {
    const init = await request(
      "POST",
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "user-journey-audit", version: "1" },
        },
      },
      { "mcp-protocol-version": "2025-06-18" },
    );
    assert(init.status === 200, "initialize status=" + init.status);
    const sid = init.headers["mcp-session-id"];
    assert(sid, "no Mcp-Session-Id");
    const list = await request(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { "mcp-protocol-version": "2025-06-18", "mcp-session-id": sid },
    );
    assert(list.status === 200, "tools/list status=" + list.status);
    const tools = JSON.parse(list.text).result.tools || [];
    assert(tools.length >= 100, "tools=" + tools.length);
    const call = await request(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system_info", arguments: {} } },
      { "mcp-protocol-version": "2025-06-18", "mcp-session-id": sid },
    );
    assert(call.status === 200, "tools/call status=" + call.status);
    const result = JSON.parse(call.text).result;
    const text = (result.content || []).map((part) => part.text || "").join("\n");
    assert(text.includes('"node"'), "system_info output missing node");
    return "tools=" + tools.length + " system_info=ok";
  });

  await check("upload endpoint is 404 and the UI is name-only", async () => {
    const res = await request("POST", "/api/chat/upload", Buffer.from("x"), {
      "content-type": "image/png",
      "x-file-name": "x.png",
    });
    assert(res.status === 404, "upload status=" + res.status);
    const index = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    assert(index.includes('id="fileUpload"'), "file input missing");
    assert(index.includes("function handleFile"), "handleFile missing");
    assert(!index.includes("/api/chat/upload"), "UI already calls an upload endpoint");
    return "upload=404 fileInput=present apiCall=absent";
  });

  await check("https://localhost/health is 200", async () => {
    const res = await requestHttps("localhost", "/health");
    assert(res.status === 200, "status=" + res.status);
    const json = JSON.parse(res.body.toString("utf8"));
    assert(json.healthy === true, "healthy=" + json.healthy);
    return "status=200 healthy=true";
  });

  await check("seven per-tool vhosts return 502", async () => {
    const statuses = [];
    for (const host of VHOSTS) {
      const res = await requestHttps(host, "/health");
      statuses.push(host + "=" + res.status);
      assert(res.status === 502, host + " status=" + res.status);
    }
    return statuses.join(" ");
  });

  await check("per-tool upstream ports are closed", async () => {
    const ports = [3110, 3111, 3112, 3121, 3122, 3123, 5400];
    for (const port of ports) {
      assert(await portClosed(port), "port " + port + " is listening");
    }
    return "closed=" + ports.join(",");
  });

  await check("runbook records the audit and row 14 TODO", async () => {
    const text = fs.readFileSync(RUNBOOK, "utf8");
    assert(text.includes("<!-- USER_JOURNEY_AUDIT_2026_11_21 -->"), "audit start marker missing");
    assert(text.includes("<!-- /USER_JOURNEY_AUDIT_2026_11_21 -->"), "audit end marker missing");
    const start = text.indexOf("<!-- USER_JOURNEY_AUDIT_2026_11_21 -->");
    const end = text.indexOf("<!-- /USER_JOURNEY_AUDIT_2026_11_21 -->");
    const block = text.slice(start, end);
    assert(block.includes("CHAT_UPLOAD=404"), "CHAT_UPLOAD=404 missing");
    assert(block.includes("VHOSTS_502=7"), "VHOSTS_502=7 missing");
    assert(/AUDIO=.*zc-audit-2026-11-21\.mp3/.test(block), "AUDIO path missing");
    assert(/^\|\s*14\s*\|.*CHAT_UPLOAD.*\|\s*TODO\s*\|/m.test(text), "row 14 is not TODO");
    return "markers=present row14=TODO";
  });

  await check("Edge TTS audio is a real MP3 longer than 60s", () => {
    const stat = fs.statSync(AUDIO);
    assert(stat.size > 100000, "size=" + stat.size);
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration,size,format_name", "-of", "default=nw=1", AUDIO],
      { encoding: "utf8" },
    );
    assert(probe.status === 0, "ffprobe failed: " + probe.stderr);
    const duration = Number((probe.stdout.match(/duration=([\d.]+)/) || [])[1]);
    const size = Number((probe.stdout.match(/size=(\d+)/) || [])[1]);
    const format = (probe.stdout.match(/format_name=(\S+)/) || [])[1] || "";
    assert(duration > 60, "duration=" + duration);
    assert(size === stat.size, "ffprobe size=" + size + " stat=" + stat.size);
    assert(/mp3/.test(format), "format=" + format);
    return "bytes=" + stat.size + " duration=" + duration.toFixed(2) + " format=" + format;
  });

  for (const [status, name, detail] of rows) {
    console.log(`${status}  ${name}${detail ? " — " + detail : ""}`);
  }
  console.log(`\n${pass} passed, ${fail} failed`);

  if (fail > 0) {
    console.error("\nUSER_JOURNEY_AUDIT_FAIL");
    process.exit(1);
  }
  console.log("\nUSER_JOURNEY_AUDIT_OK");
}

main().catch((err) => {
  console.error("USER_JOURNEY_AUDIT_FAIL " + err.message);
  process.exit(1);
});
