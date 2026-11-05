#!/usr/bin/env node
// =============================================================================
// TEST: Fallback hot-loop fix + multipart content normalization
//       (লগে পাওয়া ২টা বাগের regression গার্ড)
//
// বাগ ১ — api.js callModelStream model-hop recursion-এ `model` না পাঠিয়ে
//         `fb` (fallback model) পাঠাতে হবে। পুরনো কোডে `model` পাস করা হতো →
//         exclude-set কখনো বাড়ত না → infinite hot loop (~২৮০ warn/sec,
//         ৪৭,০০০+ লাইন / ১৮.৬ MB লগ, `boundary_reject … got array`)।
// বাগ ২ — OpenAI multipart content array ([{type:"text",…}]) vs বাউন্ডারি
//         schema (string|null)। এখন provider/index.js-এ normalizeMessages
//         দিয়ে সব message flatten হয় (text-only gateway)।
//
// পদ্ধতি (evidence-based, এই রিপোর কনভেনশন অনুযায়ী):
//    PART A — api.js সোর্সে ফিক্স-লাইন static assert
//    PART B — provider/index.js-এর normalizeMessages dynamic assert +
//             validator দিয়ে boundary pass যাচাই
//
// চলার পদ্ধতি:  node tests/fallback-hotloop-fix.test.js
// শেষে exit code 0 = সব assertion pass।
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
// PART A — STATIC: api.js-এ আসল ফিক্স-লাইন আছে কি না
// ═══════════════════════════════════════════════════════════════════════════
const SRC = path.resolve(__dirname, "..", "api.js");
const src = fs.readFileSync(SRC, "utf8");

// A1. মডেল-হপ recursion এখন fallback model (fb) পাস করে
const modelHopStart = src.indexOf("const fb = getFallbackModel(model, triedModels);");
assert(
  "A1  getFallbackModel ব্লক বিদ্যমান",
  modelHopStart > 0,
  "offset " + modelHopStart
);
const modelHopBlock = src.slice(modelHopStart, modelHopStart + 700);
assert(
  "A2  model-hop recursion-এ callModelStream(fb, …) — আগের বাগ 'callModelStream(model' নেই",
  /callModelStream\(fb, messages, temperature, onChunk, tools,/.test(modelHopBlock) &&
    !/callModelStream\(model, messages, temperature, onChunk, tools,\s*tool_choice, retry \+ 1, undefined,/.test(modelHopBlock),
  "recurse with fb, never with the original model"
);
assert(
  "A3  triedModels-এ আসল মডেলটাই accumulate হয় (exclude-set বাড়ে)",
  /\[\.\.\.\(triedModels \|\| \[\]\), model\]\)/.test(modelHopBlock),
  "triedModels grows with each tried model"
);

// A4. stream path-এ boundary_reject = deterministic → fail fast (লুপ নয়)
const fallbackStreamStart = src.indexOf("const fallbackStream = function (errMsg) {");
const fallbackStreamBlock = src.slice(
  fallbackStreamStart,
  fallbackStreamStart + 400
);
assert(
  "A4  stream fallbackStream-এ boundary_reject fail-fast গার্ড",
  /if \(\/\^boundary_reject\/\.test\(errMsg \|\| ""\)\) return false;/.test(fallbackStreamBlock) &&
    fallbackStreamBlock.indexOf("boundary_reject") < fallbackStreamBlock.indexOf("retry < 3"),
  "deterministic reject → no provider/model hop"
);

// A5. non-stream callModel-এও boundary_reject fail-fast (provider fail-mark নয়)
const nonStreamIdx = src.indexOf('if (/^boundary_reject/.test(errMsg)) {');
assert(
  "A5  callModel (non-stream)-এ boundary_reject fail-fast + boundary field",
  nonStreamIdx > 0 &&
    /success: false,\s*error: errMsg,\s*raw: r\.raw,\s*boundary: r\.boundary,/.test(
      src.slice(nonStreamIdx, nonStreamIdx + 260)
    ),
  "fails fast without markProviderFailure/fallback chain"
);

// ═══════════════════════════════════════════════════════════════════════════
// PART B — DYNAMIC: normalizeMessages + boundary validator
// ═══════════════════════════════════════════════════════════════════════════
const provider = require(path.resolve(__dirname, "..", "provider", "index.js"));
const validator = require(path.resolve(__dirname, "..", "provider", "validator.js"));

assert(
  "B1  normalizeMessages export করা আছে",
  typeof provider.normalizeMessages === "function",
  "provider/index.js exports normalizeMessages"
);

// B1.b — bug reproduce: raw multipart array boundary-এ reject হয়
const raw = [
  { role: "user", content: "x" },
  { role: "assistant", content: "y" },
  { role: "user", content: [{ type: "text", text: "z" }] },
];
const vRaw = validator.validateRequest({ model: "m", apiModel: "m", messages: raw, stream: false });
assert(
  "B2  raw content-array boundary-এ reject (original bug reproduced)",
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
  "B4  string content অক্ষত",
  out[1].content === "plain string",
  "no mutation"
);
assert(
  "B5  null content অক্ষত (schema-allowable)",
  out[2].content === null,
  "null passes through"
);

// B6 — একাধিক টেক্সট-পার্ট "\n" দিয়ে join
const multi = provider.normalizeMessages([
  { role: "tool", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "input_text", text: "c" }] },
]);
assert(
  "B6  multi-part text → 'a\\nb' (non-text 'input_text' বাদ)",
  multi[0].content === "a\nb",
  JSON.stringify(multi[0].content)
);

// B7 — normalize-এর পরে boundary ভ্যালিডেশন PASS হয়
const vNorm = validator.validateRequest({
  model: "m",
  apiModel: "m",
  messages: provider.normalizeMessages(raw),
  stream: false,
});
assert(
  "B7  normalize-এর পর boundary valid (fallback চেইন আর দরকারই পড়বে না)",
  vNorm.valid,
  vNorm.errors ? vNorm.errors.join("; ") : "valid"
);

// ═══════════════════════════════════════════════════════════════════════════
// RESULT
// ═══════════════════════════════════════════════════════════════════════════
const W = Math.max(...rows.map((r) => r[1].length + (r[2] ? 1 : 0))) + 1;
console.log("\n══════════════════════════════════════════════════════════");
for (const [tag, name, detail] of rows) {
  const icon = tag === "PASS" ? "✅" : "❌";
  console.log(`  ${icon} ${name.padEnd(W - 2, " ")} ${tag === "PASS" ? "" : "[" + detail + "]"}`);
}
console.log("────────────────────────────────────────────────────────────");
console.log(`  RESULT: ${pass} passed, ${fail} failed`);
console.log("══════════════════════════════════════════════════════════");
process.exit(fail > 0 ? 1 : 0);