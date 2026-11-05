#!/usr/bin/env node
// =============================================================================
// TEST: Fallback hot-loop fix + multipart content normalization
//       (regression guard for two bugs found in the logs)
//
// Bug 1 — api.js callModelStream model-hop recursion passed `model` instead of
//         `fb` (the fallback model). The exclude-set therefore never grew and
//         the loop ran forever (~280 warnings/sec, 47,000+ lines / 18.6 MB of
//         logs, `boundary_reject … got array`).
// Bug 2 — OpenAI multipart content array ([{type:"text",…}]) versus the
//         boundary schema (string|null). provider/index.js now flattens every
//         message through normalizeMessages (text-only gateway).
//
// Method (evidence-based, following this repo's convention):
//    PART A — static assert on the fix lines inside api.js
//    PART B — dynamic assert of provider/index.js normalizeMessages plus a
//             boundary pass through the validator
//
// Run: node tests/fallback-hotloop-fix.test.js
// Exit code 0 = every assertion passed.
// =============================================================================
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) { pass++; rows.push(["PASS", name, detail || ""]); }
  else { fail++; rows.push(["FAIL", name, detail || ""]); }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — STATIC: the real fix lines exist in api.js
// ═══════════════════════════════════════════════════════════════════════════
const SRC = path.resolve(__dirname, "..", "api.js");
const src = fs.readFileSync(SRC, "utf8");

// A1. Model-hop fallback is removed by design: only providers that serve the
// requested model may be tried. Without a model hop the old hot loop cannot
// recur.
assert(
  "A1  model-hop fallback removed (no getFallbackModel)",
  !src.includes("getFallbackModel") && !src.includes("triedModels"),
  "no model hop, no exclude-set recursion",
);
assert(
  "A2  proxy fallback keeps the requested model across providers",
  src.includes("resolveAllProviders(model)") &&
    !src.includes("callModelStream(fb,") &&
    !src.includes("callModel(fb,"),
  "provider fallback only",
);
assert(
  "A3  PROXY_TRY logs the requested model and candidate provider",
  /PROXY_TRY[\s\S]{0,120}candidate\.providerId/.test(src),
  "one model per provider",
);

// A4. boundary_reject on the stream path is deterministic -> fail fast, no loop
const fallbackStreamStart = src.indexOf("const fallbackStream = function (errMsg) {");
const fallbackStreamBlock = src.slice(
  fallbackStreamStart,
  fallbackStreamStart + 400
);
assert(
  "A4  stream fallbackStream has the boundary_reject fail-fast guard",
  /if \(\/\^boundary_reject\/\.test\(errMsg \|\| ""\)\) return false;/.test(fallbackStreamBlock) &&
    fallbackStreamBlock.indexOf("boundary_reject") < fallbackStreamBlock.indexOf("retry < 3"),
  "deterministic reject → no provider/model hop"
);

// A5. non-stream callModel also fails fast on boundary_reject (no provider fail mark)
const nonStreamIdx = src.indexOf('if (/^boundary_reject/.test(errMsg)) {');
assert(
  "A5  callModel (non-stream) fails fast on boundary_reject and keeps boundary",
  nonStreamIdx > 0 &&
    /success: false,\s*error: errMsg,\s*raw: r\.raw,\s*boundary: r\.boundary,/.test(
      src.slice(nonStreamIdx, nonStreamIdx + 260)
    ),
  "fails fast without markProviderFailure/fallback chain"
);

// ═══════════════════════════════════════════════════════════════════════════
// PART A2 — DYNAMIC: fallback must reach a second provider for a shared model
//   The real functions are extracted from api.js, not reimplemented.
// ═══════════════════════════════════════════════════════════════════════════
function extractFallbackFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("extract: not found in api.js: " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("extract: unbalanced braces for " + name);
}
const fallbackSrc = ["providerPriority", "resolveProvider", "resolveAllProviders", "findNextProvider"]
  .map(extractFallbackFn)
  .join("\n");
const sharedProviders = {
  p0: { enabled: true, priority: 0, models: ["shared-model"] },
  p1: { enabled: true, priority: 1, models: ["shared-model"] },
  p2: { enabled: true, priority: 2, models: ["other-model"] },
};
const fallbackApi = new Function(
  "PROVIDER_CONFIG", "DISABLED_MODELS", "isProviderHealthy", "applyModelAlias",
  "getModelName", "getApiModelName", "log", "MODELS_DB", "ALLOW_WILDCARD_MODEL",
  fallbackSrc + "\nreturn { findNextProvider, resolveAllProviders };",
)(
  sharedProviders, new Set(), () => true,
  require(path.resolve(__dirname, "..", "tools", "model-alias.js")).makeAliasResolver(""),
  (m) => String(m), (m) => String(m), () => {}, null, "0",
);
const sharedNext = fallbackApi.findNextProvider("shared-model", "p0");
assert(
  "A6  shared model falls back to the second provider",
  fallbackApi.resolveAllProviders("shared-model").length === 2 &&
    sharedNext && sharedNext.providerId === "p1",
  "next=" + (sharedNext ? sharedNext.providerId : "null"),
);
assert(
  "A7  a model nobody advertises has no fallback (no model hop)",
  fallbackApi.findNextProvider("unknown-model", "p0") === null,
  "resolveAllProviders=0",
);

// ═══════════════════════════════════════════════════════════════════════════
// PART B — DYNAMIC: normalizeMessages + boundary validator
// ═══════════════════════════════════════════════════════════════════════════
const provider = require(path.resolve(__dirname, "..", "provider", "index.js"));
const validator = require(path.resolve(__dirname, "..", "provider", "validator.js"));

assert(
  "B1  normalizeMessages is exported",
  typeof provider.normalizeMessages === "function",
  "provider/index.js exports normalizeMessages"
);

// B1.b — reproduce the bug: a raw multipart array is rejected by the boundary
const raw = [
  { role: "user", content: "x" },
  { role: "assistant", content: "y" },
  { role: "user", content: [{ type: "text", text: "z" }] },
];
const vRaw = validator.validateRequest({ model: "m", apiModel: "m", messages: raw, stream: false });
assert(
  "B2  raw content array rejected by boundary (original bug reproduced)",
  !vRaw.valid && /content/.test((vRaw.errors || [""])[0]),
  vRaw.errors ? vRaw.errors[0] : ""
);

// B3 — normalize: array → string
const out = provider.normalizeMessages([
  { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "x" } }] },
  { role: "assistant", content: "plain string" },
  { role: "user", content: null },
]);
assert(
  "B3  multipart array → text flattened, image parts dropped",
  out[0].content === "hello",
  JSON.stringify(out[0].content)
);
assert(
  "B4  string content untouched",
  out[1].content === "plain string",
  "no mutation"
);
assert(
  "B5  null content untouched (schema-allowable)",
  out[2].content === null,
  "null passes through"
);

// B6 — multiple text parts join with "\n"
const multi = provider.normalizeMessages([
  { role: "tool", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "input_text", text: "c" }] },
]);
assert(
  "B6  multi-part text -> 'a\\nb' (non-text 'input_text' dropped)",
  multi[0].content === "a\nb",
  JSON.stringify(multi[0].content)
);

// B7 — boundary validation passes after normalization
const vNorm = validator.validateRequest({
  model: "m",
  apiModel: "m",
  messages: provider.normalizeMessages(raw),
  stream: false,
});
assert(
  "B7  boundary valid after normalize (the fallback chain is no longer needed)",
  vNorm.valid,
  vNorm.errors ? vNorm.errors.join("; ") : "valid"
);

// ═══════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════
const W = Math.max(...rows.map((r) => r[1].length + (r[2] ? 1 : 0))) + 1;
console.log("\n══════════════════════════════════════════════════════════");
for (const [tag, name, detail] of rows) {
  console.log(`  ${tag.padEnd(4)} ${name.padEnd(W - 2, " ")} ${tag === "PASS" ? "" : "[" + detail + "]"}`);
}
console.log("────────────────────────────────────────────────────────────");
console.log(`  RESULT: ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════");
process.exit(fail > 0 ? 1 : 0);