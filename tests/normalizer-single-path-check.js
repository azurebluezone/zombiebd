#!/usr/bin/env node
"use strict";

/** NORMALIZER_SINGLE_PATH_OK — row 5 (response path). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const canonical = require(path.join(ROOT, "normalizer/index.js"));
const { createNormalizeResponse } = require(path.join(ROOT, "normalizer/api-response.js"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
const normalizeResponse = createNormalizeResponse({ maskModelName: (m) => m });

check("canonical detects the newly supported text dialects", () => {
  assert.strictEqual(canonical.detect({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn" }), "anthropic");
  assert.strictEqual(canonical.detect({ output: { message: { content: [{ text: "x" }] } } }), "bedrock");
  assert.strictEqual(canonical.detect({ content: "x", stop: true }), "llamacpp");
  assert.strictEqual(canonical.detect({ content: "x", n_predict: 4 }), "llamacpp");
});

check("canonical converts Anthropic text and tool use", () => {
  const text = canonical.normalize({ model: "claude", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } });
  assert.strictEqual(text.choices[0].message.content, "hello");
  assert.strictEqual(text.choices[0].finish_reason, "stop");
  assert.strictEqual(text.usage.total_tokens, 5);
  const tool = canonical.normalize({ content: [{ type: "tool_use", id: "tu", name: "f", input: { a: 1 } }], stop_reason: "tool_use" });
  assert.strictEqual(tool.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(tool.choices[0].message.tool_calls[0].function.arguments, '{"a":1}');
});

check("canonical converts Bedrock and llama.cpp text", () => {
  const bedrock = canonical.normalize({ output: { message: { content: [{ text: "bed" }] } }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 2 } });
  assert.strictEqual(bedrock.choices[0].message.content, "bed");
  assert.strictEqual(bedrock.usage.total_tokens, 3);
  const llama = canonical.normalize({ content: "llama", stop: false, timings: { prompt_n: 4, predicted_n: 5 } });
  assert.strictEqual(llama.choices[0].message.content, "llama");
  assert.strictEqual(llama.choices[0].finish_reason, "length");
  assert.strictEqual(llama.usage.total_tokens, 9);
});

check("api wrapper keeps the legacy OpenAI contract", () => {
  const out = normalizeResponse({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }, "m");
  assert.strictEqual(out.provider, "ZombieCoder");
  assert.strictEqual(out.choices[0].message.content, "hi");
  assert.strictEqual(out.choices[0].message.role, "assistant");
  assert.ok(!("tool_calls" in out.choices[0].message), "empty tool_calls key present");
  assert.strictEqual(out.meta.requestedModel, "m");
});

check("api wrapper keeps reasoning-as-content fallback", () => {
  const out = normalizeResponse({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "why" }, finish_reason: "stop" }] }, "m");
  assert.strictEqual(out.choices[0].message.content, "why");
  assert.strictEqual(out.meta.contentWasEmpty, true);
  assert.strictEqual(out.meta.hasReasoning, true);
});

check("api wrapper still extracts foreign tool calls", () => {
  const gem = normalizeResponse({ candidates: [{ content: { parts: [{ functionCall: { name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }] }, "gem");
  assert.strictEqual(gem.choices[0].finish_reason, "tool_calls");
  assert.strictEqual(gem.toolCallsFrom, "universal-adapter");
  assert.strictEqual(JSON.parse(gem.choices[0].message.tool_calls[0].function.arguments).a, 1);
  const anthropic = normalizeResponse({ content: [{ type: "tool_use", id: "tu", name: "f", input: { a: 1 } }], stop_reason: "tool_use" }, "claude");
  assert.strictEqual(typeof anthropic.choices[0].message.tool_calls[0].function.arguments, "string");
});

check("api wrapper keeps the unknown external fallback", () => {
  const out = normalizeResponse({ foo: 1 }, "mystery");
  assert.strictEqual(out.originalFormat, "unknown_external");
  assert.strictEqual(out.choices[0].message.role, "assistant");
  assert.ok(out.choices[0].message.content.includes("foo"));
});

check("api.js has one normalizer entry point", () => {
  const api = read("api.js");
  assert.ok(api.includes('require("./normalizer/api-response.js")'), "api adapter not imported");
  assert.ok(/createNormalizeResponse\(\{ maskModelName, log \}\)/.test(api), "adapter not constructed");
  assert.ok(!api.includes("function normalizeResponse(raw, modelHint) {"), "legacy inline normalizer remains");
  const provider = read("provider/openai.js");
  assert.ok(provider.includes('require("../normalizer")'), "provider layer bypasses canonical normalizer");
});

console.log("\nNORMALIZER_SINGLE_PATH_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
process.exitCode = fail === 0 ? 0 : 1;
