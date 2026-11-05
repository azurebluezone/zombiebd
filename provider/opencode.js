"use strict";
// ─── provider/opencode.js ─────────────────────────────────────────────
// OpenCode adapter — OpenAI-compatible endpoint.
//
//   POST {base}/chat/completions     (OpenCode exposes an OpenAI-shaped API)
//   Authorization: Bearer $OPENCODE_API_KEY
//
// OpenCode differs from stock OpenAI in two ways this adapter owns:
//   • response `provider` field names the upstream vendor
//     (e.g. "Xiaomi", "Cohere", "Nvidia") — surfaced as `upstream`
//   • deprecated model IDs come back HTTP 410 with a `deprecated` body,
//     which we translate into a normal retriable failure so the caller's
//     fallback chain can move on instead of surfacing a raw 410.
//
// Dialect on the wire is plain OpenAI, so request/response building lives
// in provider/openai.js; this file only adds OpenCode-specific headers,
// error handling, and model listing.

const openai = require("./openai");
const { normalize } = require("../normalizer");

const DIALECT = "openai";
const OPENCODE_DEFAULT_BASE = "https://opencode.ai/zen/v1";

function cfgOf(cfg) {
  return Object.assign({}, cfg, {
    baseUrl: cfg.baseUrl || OPENCODE_DEFAULT_BASE,
    headers: Object.assign(
      {
        // OpenCode's API accepts requests that present as its own CLI.
        // These are the headers the API server has always sent; kept
        // identical so behaviour does not change on migration.
        "User-Agent": "opencode/latest/1.3.15/cli",
        "x-opencode-client": "cli",
        "x-opencode-session": uuid(),
        "x-opencode-project": uuid(),
        "x-opencode-request": uuid(),
      },
      cfg.headers || {},
    ),
  });
}

function uuid() {
  try { return require("crypto").randomUUID(); }
  catch (e) { return "00000000-0000-4000-8000-000000000000"; }
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
