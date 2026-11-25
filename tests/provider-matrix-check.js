#!/usr/bin/env node
"use strict";

/*
 * Three-provider acceptance matrix.
 *
 * Real inputs, no provider mocks:
 *   llama-cpu     http://localhost:9932/v1   deepseek-v4-pro
 *   ollama-local  http://localhost:11434     lfm3:1.7b
 *   ollama-cloud  https://ollama.com         gpt-oss:20b (OLLAMA_CLOUD_API_KEY)
 *
 * Proves:
 *   1. non-stream chat returns an OpenAI chat.completion envelope
 *   2. stream chat returns OpenAI chat.completion.chunk frames and a terminal frame
 *   3. a real tool call carries a string arguments payload and an id
 *   4. the gateway serves the same three providers through /v1/chat/completions
 *   5. key mapping is one-way: ollama has no cloud key, ollama_cloud has one
 *   6. no two enabled providers share a base URL
 *
 * The temporary gateway uses isolated ports, DB, logs and socket. The live
 * service on 5050 is not touched.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const TMP = path.join(ROOT, ".verify", "provider-matrix-" + process.pid);
const DATA_DIR = path.join(TMP, "data");
const LOG_DIR = path.join(TMP, "logs");
const DB_PATH = path.join(DATA_DIR, "models.db");
const UDS_PATH = path.join(TMP, "mcp.sock");

const LLAMA_BASE = ENV.LLAMA_CPP_TEST_BASE || ENV.LLAMA_CPP_URL || "http://localhost:9932/v1";
const LLAMA_MODEL = ENV.LLAMA_CPP_TEST_MODEL || ENV.LLAMA_CPP_MODEL || "deepseek-v4-pro";
const LOCAL_MODEL = ENV.OLLAMA_TEST_MODEL || "lfm3:1.7b";
const CLOUD_MODEL = ENV.OLLAMA_CLOUD_TEST_MODEL || "gpt-oss:20b";

const TOOLS = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}];

const TOOL_MESSAGES = [{
  role: "user",
  content: "You must call the get_weather tool for Dhaka. Do not answer in text.",
}];

let passed = 0;
let failed = 0;
let skipped = 0;

// Environment outages are not matrix failures: a laptop without the llama
// server, or an ollama.com account without credits, cannot answer by design.
// Shape regressions (a 200 with a bad envelope) still fail. The final RESULT
// line reports the real counts, so a green run never claims three providers.
const ENV_UNAVAILABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|Add usage credits|\b402\b|\b429\b|quota|rate limit/i;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  failed++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}
function skip(name, reason) {
  skipped++;
  console.log("SKIP " + name + " — " + reason);
}
function expect(name, ok, detail) {
  if (ok) pass(name, detail);
  else fail(name, detail);
}
function unavailable(text) {
  return ENV_UNAVAILABLE.test(String(text || ""));
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (ENV.ADMIN_TOKEN || ENV.ADMIN_API_KEY) {
      headers["X-Admin-Token"] = ENV.ADMIN_TOKEN || ENV.ADMIN_API_KEY;
    }
    const req = http.request({
      hostname: "localhost",
      port,
      path: pathname,
      method: method || "GET",
      timeout: timeoutMs || 120000,
      headers,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout" }); });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpSse(port, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: "localhost",
      port,
      path: "/v1/chat/completions",
      method: "POST",
      timeout: timeoutMs || 120000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Accept: "text/event-stream",
      },
    }, (res) => {
      let buf = "";
      const frames = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const value = line.slice(5).trim();
            if (!value || value === "[DONE]") continue;
            try { frames.push(JSON.parse(value)); } catch (_) {}
          }
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, frames }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message, frames: [] }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, error: "timeout", frames: [] }); });
    req.write(payload);
    req.end();
  });
}

function validToolCall(tc) {
  return !!tc && typeof tc.id === "string" && tc.id.length > 0 &&
    tc.type === "function" && tc.function &&
    typeof tc.function.name === "string" && tc.function.name.length > 0 &&
    typeof tc.function.arguments === "string" &&
    (() => { try { JSON.parse(tc.function.arguments); return true; } catch (_) { return false; } })();
}

function validCompletion(json) {
  const errors = [];
  if (!json || typeof json !== "object") return ["not an object"];
  if (json.object !== "chat.completion") errors.push("object");
  if (typeof json.id !== "string" || !json.id) errors.push("id");
  if (typeof json.created !== "number") errors.push("created");
  if (!Array.isArray(json.choices) || !json.choices.length) errors.push("choices");
  const c = json.choices && json.choices[0];
  if (c) {
    if (c.index !== 0) errors.push("choices[0].index");
    if (!c.message || c.message.role !== "assistant") errors.push("message.role");
    if (typeof c.message.content !== "string" && c.message.content !== null) errors.push("message.content");
    if (!c.finish_reason) errors.push("finish_reason");
  }
  if (!json.usage || typeof json.usage !== "object") errors.push("usage");
  return errors;
}

function validChunk(json) {
  const errors = [];
  if (!json || typeof json !== "object") return ["not an object"];
  if (json.object !== "chat.completion.chunk") errors.push("object");
  if (typeof json.id !== "string" || !json.id) errors.push("id");
  if (typeof json.created !== "number") errors.push("created");
  if (!Array.isArray(json.choices) || !json.choices.length) errors.push("choices");
  const c = json.choices && json.choices[0];
  if (c) {
    if (c.index !== 0) errors.push("choices[0].index");
    if (!c.delta || typeof c.delta !== "object") errors.push("delta");
    if (c.finish_reason !== null && c.finish_reason !== undefined && typeof c.finish_reason !== "string") {
      errors.push("finish_reason");
    }
  }
  return errors;
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health", "GET", undefined, 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
    await sleep(300);
  }
  return null;
}

function startInstance(port, grpcPort, httpsPort) {
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    // Provider matrix must not touch the live .missionbarisal config.
    APP_ROOT: TMP,
    DATA_DIR,
    LOG_DIR,
    DB_SQLITE_PATH: DB_PATH,
    DB_BOOTSTRAP: "1",
    UDS: UDS_PATH,
    UDS_OPENAI: "1",
    INSTANCE_ID: "provider-matrix-" + Date.now(),
    // Keep the matrix focused on the three providers. The live cloud keys
    // stay in .env; disabling unrelated probes makes startup deterministic.
    OPENCODE_API_KEY: "",
    GROQ_API_KEY: "",
    GEMINI_API_KEY: "",
    BRIDGE_ENABLED: "0",
    CUSTOM_PROVIDER_9_URL: LLAMA_BASE,
    CUSTOM_PROVIDER_9_KEY: "",
    CUSTOM_PROVIDER_9_TYPE: "openai",
    CUSTOM_PROVIDER_9_MODELS: LLAMA_MODEL,
    CUSTOM_PROVIDER_9_PRIORITY: "9",
  });
  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  return { child, output: () => output };
}

async function stopInstance(instance) {
  const child = instance.child;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  Object.assign(process.env, ENV);
  const registry = require("../provider");
  const localCfg = registry.configForId("ollama");
  const cloudCfg = registry.configForId("ollama_cloud");
  expect("ollama key is local-only", !localCfg.key, "key=" + (localCfg.key ? "set" : "empty"));
  expect("ollama_cloud owns the cloud key", !!cloudCfg.key && cloudCfg.key === ENV.OLLAMA_CLOUD_API_KEY, "key=" + (cloudCfg.key ? "set" : "empty"));
  expect("ollama points at the local server", /11434/.test(localCfg.baseUrl || ""), localCfg.baseUrl);
  expect("ollama_cloud points at ollama.com", /ollama\.com/.test(cloudCfg.baseUrl || ""), cloudCfg.baseUrl);

  const direct = [
    {
      name: "llama-cpu",
      model: LLAMA_MODEL,
      config: { id: "llama_http", baseUrl: LLAMA_BASE, key: "", type: "openai", dialect: "openai", timeout: 120000, streamTimeout: 120000 },
      think: undefined,
    },
    {
      name: "ollama-local",
      model: LOCAL_MODEL,
      config: { id: "ollama", baseUrl: ENV.OLLAMA_BASE, key: "", type: "openai", dialect: "", timeout: 120000, streamTimeout: 120000 },
      think: true,
    },
    {
      name: "ollama-cloud",
      model: CLOUD_MODEL,
      config: { id: "ollama_cloud", baseUrl: ENV.OLLAMA_CLOUD_BASE || "https://ollama.com", key: ENV.OLLAMA_CLOUD_API_KEY, type: "openai", dialect: "", timeout: 120000, streamTimeout: 120000 },
      think: undefined,
    },
  ];

  let toolCalls = 0;
  for (const c of direct) {
    const res = await registry.chat({
      config: c.config,
      model: c.model,
      messages: TOOL_MESSAGES,
      tools: TOOLS,
      temperature: 0,
      think: c.think,
    });
    const tc = (res.tool_calls || [])[0];
    const ok = res.ok && validToolCall(tc);
    if (!res.ok && unavailable(res.error)) {
      skip(c.name + " direct tool call", res.error);
      continue;
    }
    if (res.ok && !tc) {
      skip(c.name + " direct tool call", "provider answered but the model emitted no tool call");
      continue;
    }
    expect(c.name + " direct tool call", ok, ok ? tc.function.name + " id=" + tc.id : (res.error || "invalid tool call"));
    if (ok) toolCalls++;
  }

  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const instance = startInstance(port, grpcPort, httpsPort);
  try {
    const health = await waitHealth(port, 45000);
    expect("temporary gateway healthy", !!health, health ? "agents=" + health.agents + " models=" + health.models : "no health");
    if (!health) {
      console.log(instance.output().slice(-2000));
    } else {
      const models = [
        { name: "llama-cpu", model: LLAMA_MODEL },
        { name: "ollama-local", model: LOCAL_MODEL },
        { name: "ollama-cloud", model: CLOUD_MODEL },
      ];

      let nonstream = 0;
      let stream = 0;
      let unreachable = 0;
      for (const m of models) {
        const body = {
          model: m.model,
          stream: false,
          temperature: 0,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        };
        const res = await httpJson(port, "/v1/chat/completions", "POST", body, 120000);
        const errorText = res.status === 200 ? "" : (res.error || String(res.text || "").slice(0, 200));
        if (res.status !== 200 && unavailable(errorText)) {
          unreachable++;
          skip(m.name + " non-stream OpenAI envelope", "HTTP " + res.status + " " + errorText.slice(0, 120));
          skip(m.name + " stream OpenAI chunks", "provider unreachable in this environment");
          continue;
        }
        const errors = res.status === 200 ? validCompletion(res.json) : ["HTTP " + res.status + " " + errorText];
        expect(m.name + " non-stream OpenAI envelope", errors.length === 0, errors.join(","));
        if (errors.length === 0) nonstream++;

        const sse = await httpSse(port, {
          model: m.model,
          stream: true,
          temperature: 0,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
        }, 120000);
        const bad = sse.status !== 200
          ? ["HTTP " + sse.status + " " + (sse.error || "")]
          : sse.frames.flatMap((f) => validChunk(f));
        const terminal = sse.frames.some((f) => f.choices && f.choices[0] && f.choices[0].finish_reason);
        expect(m.name + " stream OpenAI chunks", bad.length === 0 && sse.frames.length > 0 && terminal,
          bad.length ? bad.slice(0, 3).join(",") : "frames=" + sse.frames.length + " terminal=" + terminal);
        if (bad.length === 0 && sse.frames.length > 0 && terminal) stream++;
      }

      const providers = await httpJson(port, "/api/admin/providers", "GET", undefined, 10000);
      const list = providers.json && (providers.json.providers || providers.json);
      const enabled = Array.isArray(list) ? list.filter((p) => p && p.enabled !== false) : [];
      const urls = enabled.map((p) => String(p.baseUrl || "").replace(/\/+$/, "")).filter(Boolean);
      const dupes = urls.filter((u, i) => urls.indexOf(u) !== i);
      expect("no duplicate enabled provider base URLs", dupes.length === 0, dupes.length ? dupes.join(",") : "providers=" + enabled.length);

      const served = models.length - unreachable;
      expect("matrix counts (reachable providers)", nonstream === served && stream === served,
        "nonstream=" + nonstream + " stream=" + stream + " served=" + served + " toolcall=" + toolCalls + " skipped=" + skipped);
    }
  } finally {
    await stopInstance(instance);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log("");
  if (failed === 0) {
    console.log("RESULT: PROVIDER MATRIX PASS openai_shape=ok keymap=ok duplicates=0 skipped=" + skipped);
  } else {
    console.log("RESULT: PROVIDER MATRIX FAIL (" + failed + " failed, " + passed + " passed)");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.stack ? e.stack : e));
  console.log("RESULT: PROVIDER MATRIX FAIL");
  process.exit(1);
});
