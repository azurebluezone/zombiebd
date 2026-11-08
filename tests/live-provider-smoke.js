#!/usr/bin/env node
"use strict";

/*
 * Live gateway smoke after the provider-matrix deploy.
 *
 * Reads only the running service on 127.0.0.1:5050:
 *   - local Ollama is a first-class provider on 11434
 *   - ollama_cloud owns the cloud key and serves gpt-oss:20b
 *   - /v1/chat/completions returns an OpenAI envelope for both
 *   - the stream path returns OpenAI chunk frames
 */

const path = require("path");
const http = require("http");
const { readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const PORT = Number(ENV.PORT || 5050);
const BASE = process.env.ZOMBIE_API_URL || "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN = ENV.ADMIN_TOKEN || ENV.ADMIN_API_KEY || "";

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  failed++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}
function expect(name, ok, detail) {
  if (ok) pass(name, detail);
  else fail(name, detail);
}

function request(pathname, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL(pathname, BASE);
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (ADMIN_TOKEN) headers["X-Admin-Token"] = ADMIN_TOKEN;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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

function sse(body, timeoutMs) {
  return new Promise((resolve) => {
    const url = new URL("/v1/chat/completions", BASE);
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const v = line.slice(5).trim();
            if (!v || v === "[DONE]") continue;
            try { frames.push(JSON.parse(v)); } catch (_) {}
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

function validCompletion(json) {
  return !!json && json.object === "chat.completion" &&
    typeof json.id === "string" && typeof json.created === "number" &&
    Array.isArray(json.choices) && json.choices[0] &&
    json.choices[0].message && json.choices[0].message.role === "assistant" &&
    (typeof json.choices[0].message.content === "string" || json.choices[0].message.content === null) &&
    !!json.choices[0].finish_reason && !!json.usage;
}

function validChunk(json) {
  return !!json && json.object === "chat.completion.chunk" &&
    typeof json.id === "string" && typeof json.created === "number" &&
    Array.isArray(json.choices) && json.choices[0] && !!json.choices[0].delta;
}

async function main() {
  const health = await request("/health", "GET", undefined, 10000);
  expect("live gateway healthy", health.status === 200 && health.json && health.json.healthy === true,
    health.status === 200 ? "models=" + health.json.models : "HTTP " + health.status);

  const models = await request("/api/v1/models", "GET", undefined, 20000);
  const list = models.json && (models.json.data || models.json.models) || [];
  const cloud = list.find((m) => m.id === "gpt-oss:20b" && m.provider === "ollama_cloud");
  const local = list.find((m) => m.id === "qwen3:0.6b" && m.provider === "ollama");
  expect("live catalog lists ollama_cloud/gpt-oss:20b", !!cloud, cloud ? "provider=" + cloud.provider : "missing");
  expect("live catalog lists local ollama/qwen3:0.6b", !!local, local ? "provider=" + local.provider : "missing");

  const cloudChat = await request("/v1/chat/completions", "POST", {
    model: "gpt-oss:20b",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }, 120000);
  expect("live cloud non-stream OpenAI envelope", cloudChat.status === 200 && validCompletion(cloudChat.json),
    cloudChat.status === 200 ? "content=" + JSON.stringify((cloudChat.json.choices[0].message.content || "").slice(0, 20)) : "HTTP " + cloudChat.status);

  const localChat = await request("/v1/chat/completions", "POST", {
    model: "qwen2:0.5b",
    stream: false,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }, 120000);
  expect("live local non-stream OpenAI envelope", localChat.status === 200 && validCompletion(localChat.json),
    localChat.status === 200 ? "content=" + JSON.stringify((localChat.json.choices[0].message.content || "").slice(0, 20)) : "HTTP " + localChat.status);

  const cloudStream = await sse({
    model: "gpt-oss:20b",
    stream: true,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  }, 120000);
  const bad = cloudStream.status !== 200 ? ["HTTP " + cloudStream.status] : cloudStream.frames.filter((f) => !validChunk(f));
  const terminal = cloudStream.frames.some((f) => f.choices && f.choices[0] && f.choices[0].finish_reason);
  expect("live cloud stream OpenAI chunks", bad.length === 0 && cloudStream.frames.length > 0 && terminal,
    bad.length ? "bad=" + bad.length : "frames=" + cloudStream.frames.length + " terminal=" + terminal);

  const providers = await request("/api/admin/providers", "GET", undefined, 10000);
  const plist = providers.json && (providers.json.providers || providers.json);
  const arr = Array.isArray(plist) ? plist : [];
  const cloudRow = arr.find((p) => p.id === "ollama_cloud");
  const localRow = arr.find((p) => p.id === "ollama");
  const cloudKeyOk = !!(cloudRow && (cloudRow.hasKey === true || cloudRow.keySource === "env" || cloudRow.keySource === "db"));
  const localKeyOk = !!(localRow && (localRow.hasKey === false || localRow.keySource === "none"));
  expect("live key mapping is one-way", cloudKeyOk && localKeyOk,
    "cloud=" + (cloudRow ? cloudRow.keySource || cloudRow.hasKey : "missing") + " local=" + (localRow ? localRow.keySource || localRow.hasKey : "missing"));

  console.log("");
  if (failed === 0) {
    console.log("RESULT: LIVE PROVIDER SMOKE PASS cloud=ok local=ok stream=ok keymap=ok");
  } else {
    console.log("RESULT: LIVE PROVIDER SMOKE FAIL (" + failed + " failed, " + passed + " passed)");
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.stack ? e.stack : e));
  console.log("RESULT: LIVE PROVIDER SMOKE FAIL");
  process.exit(1);
});
