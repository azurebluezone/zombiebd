"use strict";
// ─── provider/groq.js ─────────────────────────────────────────────────
// Groq adapter — https://console.groq.com/docs/api-reference
//
// Groq is OpenAI-compatible on the wire:
//   POST https://api.groq.com/openai/v1/chat/completions
//   Authorization: Bearer $GROQ_API_KEY
//
// Groq-only details handled here:
//   • `x_groq` metadata object in the response (Groq §Response Object)
//   • `reasoning_format` / `reasoning_effort` request fields
//   • `service_tier`, `parallel_tool_calls`
//   • Response `usage` carries Groq timing fields (queue_time, prompt_time,
//     completion_time, total_time) — kept intact by the normalizer.
//
// Everything else is delegated to the OpenAI adapter, which is the correct
// base: Groq's docs describe the same request and response schemas.

const openai = require("./openai");
const { normalize } = require("../normalizer");

const DIALECT = "groq";
const GROQ_DEFAULT_BASE = "https://api.groq.com/openai/v1";

function cfgOf(cfg) {
  return Object.assign({}, cfg, {
    baseUrl: cfg.baseUrl || GROQ_DEFAULT_BASE,
    headers: Object.assign({ "x-title": "zombiecoder" }, cfg.headers || {}),
  });
}

// Groq accepts the OpenAI body plus these Groq-specific fields.
function buildBody(params) {
  const body = openai.buildBody(params);
  // https://console.groq.com/docs/api-reference#reasoning
  if (params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
  if (params.reasoning_format) body.reasoning_format = params.reasoning_format;
  if (params.parallel_tool_calls != null) body.parallel_tool_calls = params.parallel_tool_calls;
  if (params.service_tier) body.service_tier = params.service_tier;
  if (params.seed != null) body.seed = params.seed;
  // Groq n=1 only (any other value → 400).
  body.n = 1;
  return body;
}

async function chat(cfg, params) {
  const c = cfgOf(cfg);
  const res = await openai.chat(c, Object.assign({}, params, { _build: buildBody }));
  // Re-tag so downstream logging shows the real dialect.
  if (res.ok && res.normalized) {
    const re = normalize(res.raw, { dialect: DIALECT, provider: c.id });
    res.normalized = re;
    if (re.x_groq) res.x_groq = re.x_groq;
  }
  return res;
}

async function chatStream(cfg, params, onDelta) {
  const c = cfgOf(cfg);
  return openai.chatStream(c, params, onDelta);
}

async function listModels(cfg) {
  return openai.listModels(cfgOf(cfg));
}

module.exports = {
  id: "groq",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
  buildBody,
};
