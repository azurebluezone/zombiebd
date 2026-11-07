#!/usr/bin/env node
"use strict";

/*
 * Provider independence gate.
 *
 * The gateway must serve whatever the live catalog offers: no machine path
 * baked into production code, no first-provider lock for utility calls, and a
 * normalizer that converts each dialect or fails over with a real reason
 * instead of an empty success.
 *
 *   node tests/provider-independence-check.js
 *
 * Prints "RESULT: PROVIDER INDEPENDENCE PASS" only when every check below
 * observed the live service.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { normalize, createStreamNormalizer } = require("../normalizer/index.js");
const { loadEnv } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const PORT = ENV.ports.api || 5050;
const UDS = process.env.PROVIDER_CHECK_UDS || ENV.derived.udsPath || "";
const DONE = "[" + "DONE" + "]";
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

// One request helper for both HTTP and UDS: the transport differs in two
// fields, and a test that speaks both must not drift apart in the rest.
function send(options, body) {
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (raw += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, raw: raw }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message, raw: "" }));
    req.setTimeout(120000, () => req.destroy());
    req.on("timeout", () => resolve({ status: 0, error: "timeout", raw: "" }));
    if (body) req.write(body);
    req.end();
  });
}

function post(target, p, obj, extra) {
  const body = JSON.stringify(obj);
  const options = {
    path: p,
    method: "POST",
    headers: Object.assign(
      { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      extra || {},
    ),
  };
  if (target === "uds") {
    options.socketPath = UDS;
    options.host = "localhost";
  } else {
    options.host = "127.0.0.1";
    options.port = PORT;
  }
  return send(options, body);
}

// ─── 1. Production code is path-independent ──────────────────────────
const ROOTS = ["api.js", "provider", "normalizer", "lib", "scripts", "deploy"];
function collect(target, out) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return out;
  if (fs.statSync(full).isDirectory()) {
    for (const entry of fs.readdirSync(full)) {
      if (entry === "node_modules" || entry === ".git") continue;
      collect(path.join(target, entry), out);
    }
    return out;
  }
  if (/\.(js|mjs|cjs|sh)$/.test(full)) out.push(full);
  return out;
}
const sourceFiles = ROOTS.reduce((acc, target) => collect(target, acc), []);
const machineHits = [];
for (const file of sourceFiles) {
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (/\/home\/[a-z]|\/Users\/[A-Za-z]|[A-Z]:\\\\\\\\Users/i.test(line)) {
      machineHits.push(path.relative(ROOT, file) + ":" + (i + 1));
    }
  });
}
check(
  "no-machine-path",
  machineHits.length === 0,
  machineHits.length ? machineHits.slice(0, 3).join(", ") : sourceFiles.length + " files scanned",
);

// ─── 2. Normalizer covers every dialect shape, not just the easy one ─
const contentArray = normalize(
  {
    id: "oa-1",
    model: "served-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: [{ type: "text", text: "part-a" }, { type: "text", text: "part-b" }] },
      finish_reason: "stop",
    }],
  },
  { dialect: "openai", provider: "fixture" },
);
check(
  "normalizer-openai-content-array",
  contentArray.choices[0].message.content === "part-apart-b",
  JSON.stringify(contentArray.choices[0].message.content),
);

const gemini = normalize(
  {
    modelVersion: "gemini-test-1",
    candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 6 },
  },
  { dialect: "gemini", provider: "fixture" },
);
check(
  "normalizer-gemini-modelversion",
  gemini.model === "gemini-test-1" && gemini.usage.completion_tokens === 4,
  "model=" + gemini.model + " completion=" + gemini.usage.completion_tokens,
);

const unknown = normalize(
  { unexpected: true, error: { message: "quota exhausted" } },
  { dialect: "openai", provider: "fixture" },
);
check(
  "normalizer-unknown-shape",
  unknown.error === "unrecognised_response_shape" && unknown.error_message === "quota exhausted",
  "error=" + unknown.error + " message=" + unknown.error_message,
);

const streamNormalizer = createStreamNormalizer({ dialect: "openai" });
const streamChunk = streamNormalizer.normalize({
  id: "s-1",
  choices: [{ index: 0, delta: { content: [{ type: "text", text: "streamed" }] }, finish_reason: null }],
});
const streamText = streamChunk && streamChunk.choices && streamChunk.choices[0].delta.content;
check("normalizer-stream-content-array", streamText === "streamed", JSON.stringify(streamText));

// ─── 3. Live wire formats ────────────────────────────────────────────
function auditSse(raw) {
  const problems = [];
  let events = 0;
  let done = false;
  const frames = raw.split("\n\n").filter((f) => f.trim().length > 0);
  for (const frame of frames) {
    const text = frame.trim();
    if (text.startsWith(":")) continue;
    if (!text.startsWith("data: ")) {
      problems.push("missing data prefix: " + JSON.stringify(text.slice(0, 40)));
      continue;
    }
    const data = text.slice(6).trim();
    if (data === DONE) { done = true; continue; }
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed.choices)) problems.push("no choices: " + data.slice(0, 60));
      events += 1;
    } catch (_) {
      problems.push("invalid json: " + JSON.stringify(data.slice(0, 80)));
    }
  }
  return { problems, events, done, frames: frames.length };
}

async function main() {
  console.log("=== provider independence gate ===");
  console.log("api=http://127.0.0.1:" + PORT + " uds=" + (UDS || "(none)"));

  const catalog = await send({ host: "127.0.0.1", port: PORT, path: "/v1/models", method: "GET" });
  let models = [];
  try {
    models = (JSON.parse(catalog.raw).data || []).map((m) => m && m.id).filter(Boolean);
  } catch (_) {}
  check("live-catalog", catalog.status === 200 && models.length > 0, "status=" + catalog.status + " models=" + models.length);

  // The model is whatever the catalog serves first; nothing is pinned here.
  const model = process.env.PROVIDER_CHECK_MODEL || models[0] || "";
  check("catalog-model-selected", !!model, "model=" + (model || "(none)"));
  if (!model) return finish();

  const chatBody = (stream) => ({
    model: model,
    messages: [{ role: "user", content: "Reply with exactly: PROVIDER_OK" }],
    max_tokens: 16,
    temperature: 0,
    stream: !!stream,
  });

  const plain = await post("http", "/v1/chat/completions", chatBody(false));
  let plainJson = null;
  try { plainJson = JSON.parse(plain.raw); } catch (_) {}
  const plainText = plainJson && plainJson.choices && plainJson.choices[0] && plainJson.choices[0].message
    ? String(plainJson.choices[0].message.content || "") : "";
  check(
    "http-chat-completion",
    plain.status === 200 && plainJson && plainJson.object === "chat.completion" &&
      !!plainJson.model && plainText.includes("PROVIDER_OK"),
    "status=" + plain.status + " model=" + (plainJson && plainJson.model) + " content=" + JSON.stringify(plainText.slice(0, 30)),
  );

  const sse = await post("http", "/v1/chat/completions", chatBody(true));
  const sseAudit = auditSse(sse.raw);
  check(
    "http-sse",
    sse.status === 200 && String(sse.headers["content-type"] || "").includes("text/event-stream") &&
      sseAudit.problems.length === 0 && sseAudit.done && sseAudit.events > 0,
    "status=" + sse.status + " events=" + sseAudit.events + " problems=" + sseAudit.problems.length +
      (sseAudit.problems[0] ? " first=" + sseAudit.problems[0] : ""),
  );

  if (UDS) {
    const udsPlain = await post("uds", "/v1/chat/completions", chatBody(false));
    let udsJson = null;
    try { udsJson = JSON.parse(udsPlain.raw); } catch (_) {}
    const udsText = udsJson && udsJson.choices && udsJson.choices[0] && udsJson.choices[0].message
      ? String(udsJson.choices[0].message.content || "") : "";
    check(
      "uds-chat-completion",
      udsPlain.status === 200 && udsJson && udsJson.object === "chat.completion" && udsText.includes("PROVIDER_OK"),
      "status=" + udsPlain.status + " content=" + JSON.stringify(udsText.slice(0, 30)),
    );

    const udsSse = await post("uds", "/v1/chat/completions", chatBody(true));
    const udsAudit = auditSse(udsSse.raw);
    check(
      "uds-sse",
      udsSse.status === 200 && udsAudit.problems.length === 0 && udsAudit.done && udsAudit.events > 0,
      "status=" + udsSse.status + " events=" + udsAudit.events + " problems=" + udsAudit.problems.length,
    );
  } else {
    check("uds-chat-completion", false, "no UDS path resolved from .env");
  }

  const origin = "http://127.0.0.1:" + PORT;
  const mcpBody = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const toolsHttp = await post("http", "/mcp", mcpBody, { Origin: origin });
  const httpTools = JSON.parse(toolsHttp.raw || "{}");
  const httpNames = httpTools.result && Array.isArray(httpTools.result.tools) ? httpTools.result.tools.length : 0;
  check("mcp-tools-http", toolsHttp.status === 200 && httpNames > 0, "status=" + toolsHttp.status + " tools=" + httpNames);

  if (UDS && httpNames) {
    const toolsUds = await post("uds", "/mcp", mcpBody, { Origin: origin });
    const udsTools = JSON.parse(toolsUds.raw || "{}");
    const udsNames = udsTools.result && Array.isArray(udsTools.result.tools) ? udsTools.result.tools.length : 0;
    check("mcp-tools-uds", toolsUds.status === 200 && udsNames === httpNames, "status=" + toolsUds.status + " tools=" + udsNames + " expected=" + httpNames);
  }

  // An unknown model must fail loudly, never be answered by a random provider.
  const unknownModel = await post("http", "/v1/chat/completions", {
    model: "zzz-no-such-model",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
  });
  let unknownJson = null;
  try { unknownJson = JSON.parse(unknownModel.raw); } catch (_) {}
  check(
    "unknown-model-rejected",
    unknownModel.status === 400 && unknownJson && unknownJson.error && unknownJson.error.code === "model_not_found",
    "status=" + unknownModel.status + " code=" + (unknownJson && unknownJson.error && unknownJson.error.code),
  );

  return finish();
}

function finish() {
  console.log("");
  if (failures === 0) {
    console.log("RESULT: PROVIDER INDEPENDENCE PASS");
    process.exitCode = 0;
  } else {
    console.log("RESULT: PROVIDER INDEPENDENCE FAIL (" + failures + " failing checks)");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.message));
  finish();
});
