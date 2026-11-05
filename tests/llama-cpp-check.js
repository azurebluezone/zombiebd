#!/usr/bin/env node
"use strict";

/**
 * llama-cpp-check.js - prove the live llama.cpp provider end to end.
 *
 *   1. The llama.cpp endpoint advertises the configured model.
 *   2. A direct completion returns real content (not just reasoning tokens).
 *   3. The gateway advertises that model under the llama-cpp provider.
 *   4. Every enabled agent row is bound to that model.
 *
 * Every check is a live request. Nothing is read from a fixture.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { loadEnv } = require("../lib/env");

const ROOT = path.resolve(__dirname, "..");
const env = loadEnv({ root: ROOT });
const PORT = env.ports.api;

function envValue(key) {
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    const match = text.match(new RegExp("^" + key + "=(.*)$", "m"));
    return match ? match[1].replace(/^["']|["']$/g, "").trim() : "";
  } catch (_) {
    return "";
  }
}

const LLAMA_URL = (envValue("LLAMA_CPP_URL") || envValue("CUSTOM_PROVIDER_5_URL") || "http://127.0.0.1:9932/v1").replace(/\/+$/, "");
const CONFIGURED_MODEL = envValue("CUSTOM_PROVIDER_5_MODELS").split(",")[0].trim();
const failures = [];

function fail(message) {
  failures.push(message);
  console.log("FAIL " + message);
}
function pass(message) {
  console.log("PASS " + message);
}

async function jsonRequest(url, options) {
  const response = await fetch(url, Object.assign({
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(120000),
  }, options || {}));
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: response.status, json, text };
}

function gateway(pathname, method, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path: pathname,
      method: method || "GET",
      timeout: 15000,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length, Accept: "application/json" }
        : { Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, text: "timeout" }); });
    req.on("error", (err) => resolve({ status: 0, json: null, text: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  let model = CONFIGURED_MODEL;
  try {
    const models = await jsonRequest(LLAMA_URL + "/models");
    const ids = (models.json && Array.isArray(models.json.data) ? models.json.data : [])
      .map((m) => (typeof m === "string" ? m : m && m.id))
      .filter(Boolean);
    if (models.status !== 200 || ids.length === 0) {
      fail("llama.cpp /v1/models status=" + models.status + " models=" + ids.length);
    } else {
      if (!model) model = ids[0];
      if (!ids.includes(model)) fail("configured model " + model + " is not advertised: " + ids.join(","));
      else pass("llama-models model=" + model);
    }
  } catch (err) {
    fail("llama.cpp unreachable at " + LLAMA_URL + ": " + err.message);
  }

  if (model) {
    try {
      const chat = await jsonRequest(LLAMA_URL + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          max_tokens: 200,
          stream: false,
        }),
      });
      const message = chat.json && chat.json.choices && chat.json.choices[0] && chat.json.choices[0].message;
      const content = String((message && message.content) || "").trim();
      if (chat.status !== 200 || !content) {
        fail("llama.cpp chat status=" + chat.status + " content_empty=" + !content);
      } else {
        pass("llama-chat content=" + JSON.stringify(content.slice(0, 60)));
      }
    } catch (err) {
      fail("llama.cpp chat failed: " + err.message);
    }
  }

  const catalogue = await gateway("/api/v0/models");
  const advertised = (catalogue.json && Array.isArray(catalogue.json.data) ? catalogue.json.data : [])
    .filter((m) => m && m.id === model);
  if (catalogue.status !== 200 || advertised.length === 0) {
    fail("gateway does not advertise " + (model || "the llama model") + " (status " + catalogue.status + ")");
  } else {
    const owner = advertised[0].owned_by || advertised[0].provider || "";
    if (!/llama|custom_5/i.test(String(owner))) fail("model owner is not llama-cpp: " + owner);
    else pass("gateway-model owner=" + owner);
  }

  const status = await gateway("/status");
  const agents = status.json && Array.isArray(status.json.agents) ? status.json.agents : [];
  if (status.status !== 200 || agents.length !== 9) {
    fail("gateway status=" + status.status + " agents=" + agents.length + " (expected 9)");
  } else {
    const wrong = agents.filter((a) => a.model !== model);
    if (wrong.length) fail("agents not bound to " + model + ": " + wrong.map((a) => a.id + "=" + a.model).join(","));
    else pass("agents-bound=9 model=" + model);
  }

  // Without these budgets the local request either aborts on the 60s cloud
  // default or prefills a 5.7k-token prompt. Their absence is a real failure.
  const timeoutMs = parseInt(envValue("CUSTOM_PROVIDER_5_TIMEOUT_MS") || "0", 10);
  const promptBudget = parseInt(envValue("CUSTOM_PROVIDER_5_MAX_PROMPT_CHARS") || "0", 10);
  if (timeoutMs < 60000) fail("CUSTOM_PROVIDER_5_TIMEOUT_MS is " + timeoutMs + " (expected >= 60000)");
  else if (!(promptBudget > 0)) fail("CUSTOM_PROVIDER_5_MAX_PROMPT_CHARS is not set");
  else pass("llama-budget timeout_ms=" + timeoutMs + " prompt_chars=" + promptBudget);

  if (failures.length) {
    console.log("LLAMA_CHECK_FAIL count=" + failures.length);
    process.exit(1);
  }
  console.log("LLAMA_CHECK_OK url=" + LLAMA_URL + " model=" + model + " agents=9");
}

main().catch((err) => {
  console.error("LLAMA_CHECK_FAIL " + err.message);
  process.exit(1);
});
