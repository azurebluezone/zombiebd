"use strict";

// OpenCode adapter — OpenAI-compatible endpoint with OpenCode-specific
// model listing and error translation. Auth is the standard bearer key;
// no client identity is impersonated.

const openai = require("./openai");
const defaults = require("./defaults");
const { normalize } = require("../normalizer");

const DIALECT = "openai";

function cfgOf(cfg) {
  return Object.assign({}, cfg, {
    baseUrl: defaults.resolveBaseUrl("opencode", cfg.baseUrl, { env: process.env }),
  });
}

async function chat(cfg, params) {
  const c = cfgOf(cfg);
  const res = await openai.chat(c, params);
  return decorate(res, c);
}

async function chatStream(cfg, params, onDelta) {
  const c = cfgOf(cfg);
  const res = await openai.chatStream(c, params, onDelta);
  return decorate(res, c);
}

// Tag with upstream vendor + translate OpenCode's own error dialect.
function decorate(res, c) {
  if (res.ok && res.raw) {
    const parsed = res.raw;
    if (parsed.provider) res.upstream = parsed.provider;
    // Re-normalize so `provider` reflects the configured provider id rather
    // than OpenCode's vendor string.
    res.normalized = normalize(parsed, { dialect: DIALECT, provider: c.id });
    if (parsed.provider) res.normalized.upstream = parsed.provider;
  }
  if (!res.ok) {
    const e = String(res.error || "");
    // 410 = model deprecated → retriable, not fatal.
    if (res.statusCode === 410 || /deprecat/i.test(e)) {
      res.retriable = true;
      res.deprecated = true;
    }
    // 400 "free tier can only be used from within OpenCode" → not usable here.
    if (/free tier|within opencode/i.test(e)) {
      res.retriable = true;
      res.unavailable = true;
    }
  }
  return res;
}

// GET {base}/models
async function listModels(cfg) {
  return openai.listModels(cfgOf(cfg));
}

module.exports = {
  id: "opencode",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
};
