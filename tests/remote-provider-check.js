#!/usr/bin/env node
"use strict";

/*
 * Remote-provider smoke gate.
 *
 * Proves the deployed stack without Ollama or llama.cpp:
 *   1. the public HTTPS origin reaches a healthy API through Caddy
 *   2. every agent row has a concrete model (not the empty-seed failure)
 *   3. a real agent completion returns non-empty text
 *   4. the public MCP endpoint advertises the full tool catalog
 *
 * All calls go to the real Caddy origin and the real gateway. Nothing is
 * stubbed; a provider quota error is a FAIL, not a SKIP.
 */

const path = require("path");
const { execFileSync } = require("child_process");
const { loadEnv } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const APP_URL = String(ENV.derived.publicOrigin || "https://localhost").replace(/\/$/, "");
const MAIN_HOST = ENV.derived.mainHost || "localhost";
const ORIGIN = "https://" + MAIN_HOST;

function curl(args, timeoutMs) {
  const text = execFileSync("curl", ["-sS", "-m", String(Math.ceil(timeoutMs / 1000)), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs + 5000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const cut = text.lastIndexOf("\n");
  if (cut === -1) return { body: text, status: 0 };
  return { body: text.slice(0, cut), status: Number(text.slice(cut + 1)) };
}

function getJson(pathname, timeoutMs) {
  const res = curl(["-w", "\n%{http_code}", APP_URL + pathname], timeoutMs);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_) {}
  return { status: res.status, json, body: res.body };
}

function postJson(pathname, payload, timeoutMs) {
  const res = curl(
    [
      "-w",
      "\n%{http_code}",
      "-X",
      "POST",
      APP_URL + pathname,
      "-H",
      "Content-Type: application/json",
      "-H",
      "Origin: " + ORIGIN,
      "--data-binary",
      JSON.stringify(payload),
    ],
    timeoutMs,
  );
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_) {}
  return { status: res.status, json, body: res.body };
}

let failures = 0;
function pass(message) {
  console.log("PASS " + message);
}
function fail(message) {
  failures++;
  console.log("FAIL " + message);
}

(async () => {
  console.log("=== remote provider check ===");
  console.log("origin=" + APP_URL + " host=" + MAIN_HOST);

  const health = getJson("/health", 10000);
  if (health.status === 200 && health.json && health.json.healthy === true && health.json.agents === 9) {
    pass("health status=200 healthy=true agents=9 via " + APP_URL);
  } else {
    fail("health status=" + health.status + " body=" + health.body.slice(0, 160));
  }

  const agents = getJson("/api/agents", 10000);
  const rows = (agents.json && agents.json.agents) || [];
  const missing = rows.filter((a) => !a || !a.model).map((a) => (a && a.id) || "?");
  if (agents.status === 200 && rows.length === 9 && missing.length === 0) {
    pass("agents=9 models=" + rows.map((a) => a.model).filter((v, i, all) => all.indexOf(v) === i).join(","));
  } else {
    fail("agents status=" + agents.status + " rows=" + rows.length + " missing_model=" + (missing.join(",") || "none"));
  }

  const chat = postJson(
    "/v1/chat/completions",
    {
      model: "team-heart",
      messages: [{ role: "user", content: "Reply with exactly: REMOTE-OK" }],
      max_tokens: 64,
      temperature: 0,
      stream: false,
    },
    90000,
  );
  const reply =
    chat.json && chat.json.choices && chat.json.choices[0] && chat.json.choices[0].message
      ? String(chat.json.choices[0].message.content || "").trim()
      : "";
  if (chat.status === 200 && reply) {
    pass("chat status=200 reply=" + reply.slice(0, 40).replace(/\s+/g, " "));
  } else {
    fail("chat status=" + chat.status + " reply=" + JSON.stringify(reply) + " body=" + chat.body.slice(0, 200));
  }

  const tools = postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, 15000);
  const count = tools.json && tools.json.result && Array.isArray(tools.json.result.tools) ? tools.json.result.tools.length : 0;
  if (tools.status === 200 && count === 153) {
    pass("mcp tools=153 via " + APP_URL + "/mcp");
  } else {
    fail("mcp status=" + tools.status + " tools=" + count);
  }

  if (failures) {
    console.log("RESULT: REMOTE PROVIDERS FAIL failures=" + failures);
    process.exitCode = 1;
    return;
  }
  console.log("RESULT: REMOTE PROVIDERS PASS health=ok agents=9 chat=ok tools=153 origin=" + APP_URL);
})().catch((err) => {
  console.log("FAIL " + (err && err.message ? err.message : String(err)));
  console.log("RESULT: REMOTE PROVIDERS FAIL error");
  process.exitCode = 1;
});
