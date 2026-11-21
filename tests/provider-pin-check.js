#!/usr/bin/env node
"use strict";

/*
 * Provider pin gate.
 *
 * The gateway normally routes a model to the highest-priority provider that
 * advertises it (api.js:3164). That makes some providers unprovable through
 * the gateway when two providers share a model (lfm3:1.7b is served by both
 * bridge priority 8 and ollama priority 9).
 *
 * This gate proves the optional per-request pin:
 *   1. no pin        -> default routing is unchanged (bridge)
 *   2. pin ollama    -> HTTP 200, provider=ollama, marker in the answer
 *   3. pin bridge    -> HTTP 200, provider=bridge
 *   4. unknown pin   -> 400 provider_not_found
 *   5. wrong model   -> 400 provider_model_mismatch
 *   6. stream + pin  -> SSE 200 with x-zc-chat-provider: bridge
 *
 * Every assertion is a real HTTP call to the running gateway. The marker is
 * unique per run, so a cached or fabricated answer cannot satisfy case 2.
 */

const http = require("http");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5050);
const RUN = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const MARKER = "HALAL-OLLAMA-PIN-" + RUN;
const STARTED = Date.now();
const DEADLINE_MS = 105000;

function request(method, pathname, body, timeoutMs) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { Accept: "application/json, text/event-stream" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const startedAt = Date.now();
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: method, headers: headers },
      function (res) {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          text += chunk;
        });
        res.on("end", function () {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: text,
            json: json,
            elapsed: Date.now() - startedAt,
          });
        });
      },
    );
    req.setTimeout(timeoutMs || 30000, function () {
      req.destroy(new Error("timeout after " + (timeoutMs || 30000) + "ms"));
    });
    req.on("error", function (err) {
      resolve({
        status: 0,
        headers: {},
        text: "",
        json: null,
        elapsed: Date.now() - startedAt,
        error: err.message,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function contentOf(json) {
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  return msg && typeof msg.content === "string" ? msg.content : "";
}

function errorCode(res) {
  return res.json && res.json.error && res.json.error.code
    ? String(res.json.error.code)
    : "";
}

function outOfTime() {
  return Date.now() - STARTED > DEADLINE_MS;
}

async function main() {
  console.log("=== provider pin gate " + RUN + " ===");
  console.log("base=http://" + HOST + ":" + PORT + " marker=" + MARKER);
  console.log("");

  const results = [];
  function check(name, ok, detail) {
    results.push({ name: name, ok: ok });
    console.log((ok ? "PASS" : "FAIL") + " " + name.padEnd(16) + " " + detail);
  }

  // 1. Default routing must not change.
  let res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    },
    30000,
  );
  check(
    "default-routing",
    res.status === 200 && res.json && res.json.provider === "bridge",
    "HTTP " + res.status + " provider=" + (res.json && res.json.provider),
  );

  if (outOfTime()) {
    console.error("PROVIDER_PIN_FAIL: deadline exceeded before pin tests");
    process.exitCode = 1;
    return;
  }

  // 2. Pin the provider that is normally shadowed by priority.
  res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      provider: "ollama",
      messages: [
        {
          role: "user",
          content:
            "Answer with only this exact token, no reasoning: " + MARKER,
        },
      ],
      max_tokens: 400,
      temperature: 0,
      stream: false,
    },
    75000,
  );
  const ollamaContent = contentOf(res.json);
  check(
    "pin-ollama",
    res.status === 200 &&
      res.json &&
      res.json.provider === "ollama" &&
      ollamaContent.includes(MARKER),
    "HTTP " +
      res.status +
      " provider=" +
      (res.json && res.json.provider) +
      " marker=" +
      ollamaContent.includes(MARKER) +
      " " +
      res.elapsed +
      "ms",
  );

  // 3. Pin the higher-priority provider explicitly.
  res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      provider: "bridge",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      temperature: 0,
      stream: false,
    },
    30000,
  );
  check(
    "pin-bridge",
    res.status === 200 && res.json && res.json.provider === "bridge",
    "HTTP " + res.status + " provider=" + (res.json && res.json.provider),
  );

  // 4. Unknown provider is a direct 400, not a silent fallback.
  res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      provider: "does-not-exist",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      stream: false,
    },
    15000,
  );
  check(
    "unknown-provider",
    res.status === 400 && errorCode(res) === "provider_not_found",
    "HTTP " + res.status + " code=" + (errorCode(res) || "missing"),
  );

  // 5. A provider that does not advertise the model is rejected.
  res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      provider: "groq",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      stream: false,
    },
    15000,
  );
  check(
    "model-mismatch",
    res.status === 400 && errorCode(res) === "provider_model_mismatch",
    "HTTP " + res.status + " code=" + (errorCode(res) || "missing"),
  );

  // 6. Streaming honors the same pin and reports it in a real header.
  res = await request(
    "POST",
    "/v1/chat/completions",
    {
      model: "lfm3:1.7b",
      provider: "bridge",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 8,
      temperature: 0,
      stream: true,
    },
    30000,
  );
  const streamProvider = res.headers["x-zc-chat-provider"];
  const hasChunk = res.text.indexOf("data: {") !== -1;
  const hasDone = res.text.indexOf("data: [DONE]") !== -1;
  check(
    "stream-pin",
    res.status === 200 &&
      streamProvider === "bridge" &&
      hasChunk &&
      hasDone,
    "HTTP " +
      res.status +
      " header=" +
      (streamProvider || "missing") +
      " chunk=" +
      hasChunk +
      " done=" +
      hasDone,
  );

  const failed = results.filter(function (r) {
    return !r.ok;
  });
  console.log("");
  if (failed.length) {
    console.error(
      "PROVIDER_PIN_FAIL: " +
        failed.map(function (r) {
          return r.name;
        }).join(", "),
    );
    process.exitCode = 1;
    return;
  }
  console.log("PROVIDER_PIN_OK");
}

main().catch(function (err) {
  console.error("PROVIDER_PIN_FAIL: " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
