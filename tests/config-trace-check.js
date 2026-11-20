#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: config SSOT for size budgets + request_log routing trace
//       (runbook P1-10 + P1-02, gate CONFIG_TRACE_OK)
// =============================================================================
// Method:
//   1) lib/env.js owns every size default and rejects invalid values
//   2) lib/size-budget.js really caps text, messages and SSE payloads
//   3) api.js/transport have no literal size fallbacks and wire the helpers
//   4) the live request_log has the upstream_provider trace column and the
//      bridge -> adapter -> api chain fills it from the real call result
//
// Run: node tests/config-trace-check.js
// Exit 0 + CONFIG_TRACE_OK only when every assertion passes.
// =============================================================================
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail += 1;
    rows.push(["FAIL", name, detail || ""]);
  }
}
function fact(name, detail) {
  rows.push(["INFO", name, detail || ""]);
}

const { DEFAULTS, SIZE_KEYS, loadEnv } = require("../lib/env.js");
const sizeBudget = require("../lib/size-budget.js");

const api = read("api.js");
const transport = read("provider/transport.js");
const bridge = read("local-llm-bridge.js");
const openai = read("provider/openai.js");

// ─────────────────────────────────────────────────────────────
// 1) Defaults live in lib/env.js only
// ─────────────────────────────────────────────────────────────
const EXPECTED = {
  MAX_BODY_SIZE: 10485760,
  SESSION_MAX_BYTES: 2097152,
  WEB_UI_MAX_BYTES: 524288,
  MAX_FRAME_BYTES: 8388608,
  TOOL_RESULT_MAX_BYTES: 65536,
};
for (const [key, value] of Object.entries(EXPECTED)) {
  assert(
    "DEFAULTS." + key + " = " + value,
    Number(DEFAULTS[key]) === value,
    String(DEFAULTS[key]),
  );
}
assert(
  "SIZE_KEYS lists every bounded payload",
  Object.keys(EXPECTED).every((key) => SIZE_KEYS.includes(key)),
  SIZE_KEYS.join(","),
);

const pure = loadEnv({ root: ROOT, env: {}, fileVars: {} });
for (const [key, value] of Object.entries(EXPECTED)) {
  assert(
    "loadEnv exposes " + key,
    Number(pure.values[key]) === value,
    String(pure.values[key]),
  );
}

for (const bad of ["0", "-5", "abc"]) {
  const cfg = loadEnv({
    root: ROOT,
    env: { SESSION_MAX_BYTES: bad },
    fileVars: {},
  });
  assert(
    "loadEnv rejects SESSION_MAX_BYTES=" + bad,
    cfg.errors.some((e) => e.startsWith("SESSION_MAX_BYTES")),
    JSON.stringify(cfg.errors.slice(0, 2)),
  );
}

// ─────────────────────────────────────────────────────────────
// 2) No literal fallback outside lib/env.js
// ─────────────────────────────────────────────────────────────
assert(
  "api.js reads MAX_BODY_SIZE from lib/size-budget",
  api.includes('sizeBudget.limit("MAX_BODY_SIZE")') &&
    !api.includes("String(10 * 1024 * 1024)"),
);
assert(
  "provider/transport.js reads MAX_FRAME_BYTES from lib/size-budget",
  transport.includes('sizeBudget.limit("MAX_FRAME_BYTES")') &&
    !transport.includes('"8388608"'),
);

// ─────────────────────────────────────────────────────────────
// 3) lib/size-budget.js behaviour (real calls, env-driven)
// ─────────────────────────────────────────────────────────────
process.env.TOOL_RESULT_MAX_BYTES = "100";
const bigText = "x".repeat(500);
const capped = sizeBudget.capText(bigText, "TOOL_RESULT_MAX_BYTES");
assert(
  "capText reports the real byte count",
  capped.truncated && capped.bytes === 500 && capped.limit === 100,
  "bytes=" + capped.bytes + " limit=" + capped.limit,
);
assert(
  "capText marker names key/limit/actual",
  capped.text.includes("[truncated: TOOL_RESULT_MAX_BYTES=100 actual=500]"),
  capped.text.slice(-70),
);
assert(
  "capText output fits the byte budget",
  Buffer.byteLength(capped.text, "utf8") <= 100,
  "kept=" + Buffer.byteLength(capped.text, "utf8"),
);

const bengali = "ক".repeat(200); // 3 bytes each
const cappedBn = sizeBudget.capText(bengali, "TOOL_RESULT_MAX_BYTES");
assert(
  "capText never returns mojibake",
  cappedBn.truncated && !cappedBn.text.includes("\uFFFD"),
  "replacement=" + cappedBn.text.includes("\uFFFD"),
);

process.env.SESSION_MAX_BYTES = "300";
const messages = [
  { role: "system", content: "system" },
  { role: "user", content: "a".repeat(120) },
  { role: "assistant", content: "b".repeat(120) },
  { role: "user", content: "newest" },
];
const trimmed = sizeBudget.trimMessages(messages, "SESSION_MAX_BYTES");
assert(
  "trimMessages drops the oldest non-system message",
  trimmed.dropped >= 1,
  "dropped=" + trimmed.dropped,
);
assert(
  "trimMessages keeps the system prompt first",
  trimmed.messages[0].role === "system",
);
assert(
  "trimMessages keeps the newest turn",
  trimmed.messages[trimmed.messages.length - 1].content === "newest",
);
assert(
  "trimMessages fits SESSION_MAX_BYTES",
  trimmed.bytes <= 300,
  "bytes=" + trimmed.bytes,
);

process.env.WEB_UI_MAX_BYTES = "200";
const smallFrame = sizeBudget.ssePayload({ content: "ok" });
const hugeFrame = sizeBudget.ssePayload({ content: "x".repeat(500) });
assert(
  "ssePayload keeps a normal event",
  !smallFrame.tooLarge && smallFrame.payload.startsWith("data: "),
);
assert(
  "ssePayload flags an oversized event",
  hugeFrame.tooLarge && hugeFrame.limit === 200,
  "bytes=" + hugeFrame.bytes,
);

// ─────────────────────────────────────────────────────────────
// 4) api.js wires the helpers and logs BUDGET_EXCEEDED
// ─────────────────────────────────────────────────────────────
assert("api.js logs BUDGET_EXCEEDED", api.includes('"BUDGET_EXCEEDED"'));
assert(
  "api.js caps tool results with TOOL_RESULT_MAX_BYTES",
  api.includes('sizeBudget.capText(text, "TOOL_RESULT_MAX_BYTES")'),
);
assert(
  "api.js applies SESSION_MAX_BYTES in both chat paths",
  (api.match(/sizeBudget\.trimMessages\(/g) || []).length >= 2,
  "calls=" + (api.match(/sizeBudget\.trimMessages\(/g) || []).length,
);
assert(
  "api.js bounds chat SSE with writeWebChunk",
  api.includes("function writeWebChunk(res, chunk)") &&
    (api.match(/writeWebChunk\(res, /g) || []).length >= 4,
  "writes=" + (api.match(/writeWebChunk\(res, /g) || []).length,
);

// ─────────────────────────────────────────────────────────────
// 5) request_log trace: schema + end-to-end producer chain
// ─────────────────────────────────────────────────────────────
const { DatabaseSync } = require("node:sqlite");
const dbPath = path.join(ROOT, "data", "models.db");
let columns = [];
try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  columns = db
    .prepare("PRAGMA table_info(request_log)")
    .all()
    .map((c) => c.name);
  db.close();
} catch (e) {
  fact("request_log read failed", e.message);
}
assert(
  "live request_log has upstream_provider",
  columns.includes("upstream_provider"),
  columns.join(","),
);
assert(
  "recordRequestLog inserts upstream_provider",
  /INSERT INTO request_log \([^)]*upstream_provider[^)]*\)/.test(api) &&
    api.includes("row.upstream_provider || null"),
);
assert(
  "local-llm-bridge sends x-zc-upstream-provider",
  (bridge.match(/x-zc-upstream-provider/g) || []).length >= 2,
);
assert(
  "openai adapter maps the header to upstream",
  openai.includes('res.headers["x-zc-upstream-provider"]'),
);
assert(
  "chat telemetry records upstream_provider from the call result",
  (api.match(/upstream_provider: (singleResult\.upstream_provider|_finUpstream)/g) || [])
    .length >= 3,
);

// ─────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════");
console.log("  TEST: config SSOT + request_log trace");
console.log("══════════════════════════════════════════════════════════");
for (const [status, name, detail] of rows) {
  const tag = status === "PASS" ? "  PASS " : status === "FAIL" ? "  FAIL " : "  INFO ";
  console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
}
console.log("────────────────────────────────────────────────────────────");
console.log(
  "  RESULT: " + pass + " passed, " + fail + " failed, " +
    rows.filter((r) => r[0] === "INFO").length + " facts",
);
if (!fail) console.log("CONFIG_TRACE_OK");
console.log("══════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
