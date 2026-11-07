"use strict";
// ─── provider/index.js ────────────────────────────────────────────────
// Provider registry + single entry point for the API server.
//
// ARCHITECTURE
//   ┌────────────┐   provider-native    ┌──────────────┐   OpenAI shape   ┌──────────┐
//   │ api.js     │ ───────────────────▶ │ provider/*   │ ───────────────▶ │normalizer│
//   │ (agents,   │   chat/chatStream    │ (per-official │                  │→ api.js  │
//   │  tools,    │ ◀─────────────────── │  doc dialect) │                  │          │
//   │  routes)   │   normalized result  └──────────────┘                  └──────────┘
//   └────────────┘
//
// Rules enforced here (per project brief):
//   1. NO hardcoded model names anywhere — capabilities come from the DB.
//   2. NO local/cloud distinction — a provider is a response source, full stop.
//   3. Models are looked up DIRECTLY in the DB, never from an in-memory copy.
//   4. Each adapter implements its own official dialect; api.js never branches
//      on provider type.
//
// Capabilities (supports_tools / supports_media / supports_stream) are read
// from the `models` table so adding a model never requires a code change.

const openai = require("./openai");
const groq = require("./groq");
const gemini = require("./gemini");
const ollama = require("./ollama");
const opencode = require("./opencode");
const llamacpp = require("./llamacpp");
const validator = require("./validator");
const zclog = require("../lib/zc-log");
const { expandEnv } = require("../lib/expand-env");

// Adapter keyed by WIRE dialect — not by vendor marketing name.
// `openai` covers OpenAI, vLLM, and every custom_N endpoint.
const ADAPTERS = {
  openai: openai,
  "openai-compatible": openai,
  groq: groq,
  gemini: gemini,
  ollama: ollama,
  opencode: opencode,
  llamacpp: llamacpp,
  "llama-cpp": llamacpp,
};

// Selection order (evidence: PROVIDER_CONFIG sets type:"openai" for
// OpenCode/Groq/Ollama — selecting on `type` first silently dropped the
// OpenCode headers, the Groq dialect and the Ollama native endpoint):
//   1. explicit cfg.adapter / cfg.dialect  (opt-in, e.g. dialect:"openai")
//   2. dedicated adapter by provider id    (opencode, groq, ollama, gemini)
//   3. wire type                           (gemini, groq, openai, …)
//   4. OpenAI-compatible fallback
function adapterFor(cfg) {
  if (!cfg) return openai;
  const explicit = cfg.adapter || cfg.dialect;
  if (explicit) {
    const e = String(explicit).toLowerCase();
    if (ADAPTERS[e]) return ADAPTERS[e];
  }
  const id = String(cfg.id || "").toLowerCase();
  if (ADAPTERS[id]) return ADAPTERS[id];
  const key = String(cfg.type || "openai").toLowerCase();
  return ADAPTERS[key] || openai;
}

// ─── Capability lookup (DB-direct, no hardcoding) ─────────────────────
// mode: "tools" | "media" | "stream"
// Returns true unless the DB explicitly says 0 — unknown ⇒ allow, because
// an over-eager "no" would silently disable working models.
let MODELS_DB = null;
function setDatabase(db) {
  MODELS_DB = db;
  require("./tools").setDatabase(db);   // tool register shares the same DB handle
}

function supports(providerId, modelName, mode) {
  if (!MODELS_DB) return true;
  const col = mode === "tools" ? "supports_tools"
    : mode === "media" ? "supports_media"
    : mode === "stream" ? "supports_stream"
    : null;
  if (!col) return true;
  try {
    const row = MODELS_DB.prepare(
      "SELECT " + col + " FROM models WHERE provider = ? AND (name = ? OR api_model = ?) LIMIT 1",
    ).get(providerId, modelName, modelName);
    if (!row) return true;                       // not in DB ⇒ assume yes
    const v = row[col];
    if (v === null || v === undefined) return true;
    return v === 1 || v === true || v === "1";
  } catch (e) {
    return true;                                 // table/column missing ⇒ allow
  }
}

// ─── Provider config resolution ───────────────────────────────────────
// cfg may be: a config object already resolved by the caller, or a provider
// id string that we expand from environment.
function resolveConfig(cfg) {
  if (cfg && typeof cfg === "object") return cfg;
  return configForId(cfg);
}

function configForId(id) {
  const env = process.env;
  const P = {
    opencode: { baseUrl: env.OPENCODE_BASE, key: env.OPENCODE_API_KEY, type: "opencode" },
    groq:     { baseUrl: env.GROQ_BASE || "https://api.groq.com/openai/v1",
                key: env.GROQ_API_KEY, type: "groq" },
    gemini:   { baseUrl: env.GEMINI_BASE || "https://generativelanguage.googleapis.com/v1beta",
                key: env.GEMINI_API_KEY, type: "gemini" },
    ollama:   { baseUrl: env.OLLAMA_BASE, key: env.OLLAMA_API_KEY || env.OLLAMA_CLOUD_API_KEY,
                type: "openai", dialect: env.OLLAMA_DIALECT || "" },
  };
  if (P[id]) return Object.assign({ id: id }, P[id]);

  // custom_N providers: CUSTOM_PROVIDER_<n>_{URL,KEY,TYPE,...}
  const m = /^custom_(\d+)$/i.exec(id);
  if (m) {
    const n = m[1];
    // A CPU llama.cpp server can take far longer than the 60s default to
    // prefill a large prompt. The timeout is per provider because a local
    // box and a cloud API must not share one budget.
    const timeout = parseInt(env["CUSTOM_PROVIDER_" + n + "_TIMEOUT_MS"] || "", 10);
    const streamTimeout = parseInt(env["CUSTOM_PROVIDER_" + n + "_STREAM_TIMEOUT_MS"] || "", 10);
    return {
      id: id,
      baseUrl: expandEnv(env["CUSTOM_PROVIDER_" + n + "_URL"] || "").trim(),
      key: env["CUSTOM_PROVIDER_" + n + "_KEY"],
      type: (env["CUSTOM_PROVIDER_" + n + "_TYPE"] || "openai").toLowerCase(),
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeout } : {}),
      ...(Number.isFinite(streamTimeout) && streamTimeout > 0 ? { streamTimeout } : {}),
    };
  }
  return { id: id, baseUrl: "", key: "", type: "openai" };
}

// ─── Message content normalization ─────────────────────────────────────
// OpenAI-compatible clients send multipart content as arrays:
//   content: [{ type: "text", text: "hi" }, { type: "image_url", ... }]
// The boundary contract (provider/schema.json) accepts only string|null
// for message.content, so multipart arrays are flattened to their text
// parts BEFORE request validation and adapter calls. Non-text parts
// (images/files) are dropped — this gateway is text-only. Messages whose
// content is already a string or null pass through untouched.
function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(function (m) {
    if (!m || typeof m !== "object") return m;

    // ── Outbound sanitiser ──────────────────────────────────────────────
    // `reasoning_content` / `reasoning` / `thinking` are RESPONSE fields
    // that several upstreams emit. They get stored in the session history
    // and then replayed verbatim on the next turn, at which point strict
    // providers reject the whole request:
    //     'messages.N' : for 'role:assistant' the following must be
    //     satisfied[('messages.N' : property 'reasoning_content' is
    //     unsupported)]
    // Strip them before anything leaves the server. They are never needed
    // upstream, and their absence is harmless everywhere.
    const out = Object.assign({}, m);
    delete out.reasoning_content;
    delete out.reasoning;
    delete out.thinking;

    if (!Array.isArray(out.content)) return out;
    out.content = out.content
      .filter(function (p) {
        return p && (typeof p === "string" || p.type === "text");
      })
      .map(function (p) {
        return typeof p === "string" ? p : p.text || "";
      })
      .join("\n");
    return out;
  });
}

// ─── Public: non-streaming chat ───────────────────────────────────────
// opts: { providerId|config, model, apiModel, messages, temperature,
//         tools, tool_choice, capabilities:{tools,media,stream} }
// Returns { ok, content, tool_calls, reasoning_content, normalized, raw,
//           provider, model, error, rate_limited }
async function chatImpl(opts) {
  const cfg = resolveConfig(opts.config || opts.providerId);
  const adapter = adapterFor(cfg);
  const providerId = cfg.id || opts.providerId || adapter.id;
  const messages = normalizeMessages(opts.messages);

  let tools = opts.tools;
  const model = opts.apiModel || opts.model;
  if (tools && tools.length) {
    const cap = opts.capabilities || {};
    const allowed = cap.tools != null ? cap.tools
      : supports(providerId, model, "tools");
    if (!allowed) tools = undefined;   // DB says this model can't take tools
  }

  const params = {
    model: opts.model,
    apiModel: opts.apiModel || opts.model,
    messages: messages,
    temperature: opts.temperature,
    tools: tools,
    tool_choice: opts.tool_choice,
    max_tokens: opts.max_tokens,
    top_p: opts.top_p,
    stop: opts.stop,
    user: opts.user,
    response_format: opts.response_format,
    reasoning_effort: opts.reasoning_effort,
    stream: false,
  };

  // Boundary validation — reject malformed requests BEFORE they leave the
  // server (schema: provider/schema.json -> #/$defs/chatRequest).
  const vReq = validator.validateRequest(params);
  if (!vReq.valid) {
    return {
      ok: false,
      error: "boundary_reject request: " + vReq.errors.join("; "),
      boundary: vReq.errors,
      provider: providerId,
      model: opts.model,
    };
  }

  let res;
  try {
    res = await adapter.chat(cfg, params);
  } catch (e) {
    return { ok: false, error: e.message, provider: providerId, model: opts.model };
  }

  // Boundary validation — reject provider output that does not match the
  // normalized contract (schema: provider/schema.json -> #/$defs/chatCompletion).
  // `res.ok` without a normalized payload is unvalidated output, not a pass:
  // it is rejected too, so no provider reply reaches api.js unchecked.
  if (validator.enabled() && res.ok) {
    const vRes = res.normalized == null
      ? {
          valid: false,
          errors: ["$: normalized payload missing — response cannot be validated"],
        }
      : validator.validateResponse(res.normalized);
    if (!vRes.valid) {
      return {
        ok: false,
        statusCode: res.statusCode,
        error: "boundary_reject response: " + vRes.errors.join("; "),
        boundary: vRes.errors,
        raw: res.raw,
        provider: providerId,
        model: opts.model,
      };
    }
  }

  // HTTP 200 + {"error":{…}} body — OpenAI-compatible servers do this for
  // auth/quota failures. Treat it as a failure so the fallback chain runs
  // instead of reporting "empty content".
  if (res.ok && res.raw && res.raw.error && !res.raw.choices) {
    const er = res.raw.error;
    const msg = typeof er === "string" ? er : (er.message || JSON.stringify(er));
    return {
      ok: false,
      statusCode: res.statusCode || 200,
      error: msg,
      rate_limited: res.raw.status === 429 || er.status === 429 ||
        /rate.?limit|quota|too many requests|429/i.test(msg),
      raw: res.raw,
      provider: providerId,
      model: opts.model,
    };
  }

  const normalized = res.normalized;
  const message = (normalized && normalized.choices &&
    normalized.choices[0] && normalized.choices[0].message) || {};

  return {
    ok: !!res.ok,
    statusCode: res.statusCode,
    content: message.content || "",
    tool_calls: message.tool_calls || null,
    reasoning_content: message.reasoning_content || null,
    finish_reason: (normalized && normalized.choices &&
      normalized.choices[0] && normalized.choices[0].finish_reason) || null,
    usage: (normalized && normalized.usage) || null,
    normalized: normalized,
    raw: res.raw,
    upstream: res.upstream,
    error: res.error,
    rate_limited: !!res.rate_limited,
    retriable: !!res.retriable,
    provider: providerId,
    dialect: adapter.dialect,
    model: opts.model,
  };
}

// ─── Public: streaming chat ───────────────────────────────────────────
// onDelta receives OpenAI chat.completion.chunk objects (already normalized).
async function chatStreamImpl(opts, onDelta) {
  const cfg = resolveConfig(opts.config || opts.providerId);
  const adapter = adapterFor(cfg);
  const providerId = cfg.id || opts.providerId || adapter.id;
  const messages = normalizeMessages(opts.messages);

  let tools = opts.tools;
  const model = opts.apiModel || opts.model;
  if (tools && tools.length) {
    const cap = opts.capabilities || {};
    const allowed = cap.tools != null ? cap.tools
      : supports(providerId, model, "tools");
    if (!allowed) tools = undefined;
  }

  let res;
  let deltaFrames = 0;
  let invalidFrames = 0;
  try {
    // Boundary validation — reject malformed requests before they leave the
    // server (same request schema as the non-stream path).
    const vReq = validator.validateRequest({
      model: opts.model,
      apiModel: opts.apiModel || opts.model,
      messages: messages,
      temperature: opts.temperature,
      tools: tools,
      tool_choice: opts.tool_choice,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      stop: opts.stop,
      stream: true,
    });
    if (!vReq.valid) {
      return {
        ok: false,
        error: "boundary_reject request: " + vReq.errors.join("; "),
        boundary: vReq.errors,
        provider: providerId,
        model: opts.model,
      };
    }

    // Boundary validation — every normalized frame is checked against
    // #/$defs/chatCompletionChunk before it reaches api.js. Frames that
    // violate the contract are dropped (never forwarded downstream).
    const boundaryDelta = function (chunk) {
      deltaFrames++;
      const v = validator.validateDelta(chunk);
      if (v.valid) onDelta(chunk);
      else invalidFrames++;
    };

    res = await adapter.chatStream(cfg, {
      model: opts.model,
      apiModel: opts.apiModel || opts.model,
      messages: messages,
      temperature: opts.temperature,
      tools: tools,
      tool_choice: opts.tool_choice,
      max_tokens: opts.max_tokens,
      top_p: opts.top_p,
      stop: opts.stop,
      stream: true,
    }, boundaryDelta);
  } catch (e) {
    return { ok: false, error: e.message, provider: providerId, model: opts.model };
  }

  // ANY frame rejected at the boundary makes the stream untrusted. One bad
  // frame is enough to disown the reply; forwarding the rest would deliver
  // content the contract never approved. Frames already handed to onDelta
  // cannot be recalled, so the terminal result fails instead of passing.
  const boundaryRejected = invalidFrames > 0;

  // Adapter-level tool_calls are flat {index,id,name,arguments}; the API
  // server consumes the OpenAI streaming shape {id,type,function:{…}}.
  const flat = res.tool_calls;
  const toolCalls = Array.isArray(flat) && flat.length
    ? flat.map(function (t, i) {
        if (t && t.function) return t;               // already nested
        return {
          id: t.id || "call_stream_" + i,
          type: "function",
          function: { name: t.name || "", arguments: t.arguments || "" },
        };
      })
    : null;

  return {
    ok: !!res.ok && !boundaryRejected,
    statusCode: res.statusCode,
    content: res.content || "",
    tool_calls: toolCalls,
    reasoning_content: res.reasoning_content || null,
    finish_reason: res.finish_reason || null,
    error: res.error || (boundaryRejected
      ? "boundary_reject response: " + invalidFrames + " invalid stream frame(s)"
      : undefined),
    rate_limited: !!res.rate_limited,
    stream_error: !!res.stream_error || boundaryRejected,
    boundary_dropped: invalidFrames,
    provider: providerId,
    dialect: adapter.dialect,
    model: opts.model,
  };
}

// ─── Public: model discovery ──────────────────────────────────────────
async function listModels(providerIdOrCfg) {
  const cfg = resolveConfig(providerIdOrCfg);
  const adapter = adapterFor(cfg);
  try {
    return await adapter.listModels(cfg);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── Public: logging wrappers ─────────────────────────────────────────
// The *Impl bodies above own the actual logic and can return from a dozen
// places. Wrapping here means every exit — success, ok:false, or throw —
// passes through exactly one logging point, and no return path is touched.

/** One record per call: which provider/model, ok flag, latency, error text. */
function logChatResult(label, opts, providerId, t0, res, thrown) {
  const ms = Date.now() - t0;
  const base = {
    label,
    provider: providerId || (res && res.provider) || opts.providerId || null,
    model: opts.model,
    ms,
    status_code: res && res.statusCode,
    rate_limited: res && !!res.rate_limited,
  };
  if (thrown) {
    zclog.fail("provider", label, { ...base, ok: false, error: thrown.message || String(thrown) });
    return;
  }
  if (res && res.ok) {
    zclog.info("provider", label, { ...base, ok: true });
  } else {
    zclog.fail("provider", label, {
      ...base,
      ok: false,
      error: (res && res.error) || "unknown provider failure",
      boundary: res && res.boundary,
      stream_error: res && res.stream_error,
    });
  }
}

async function chat(opts) {
  const providerId = opts.providerId || (opts.config && opts.config.id) || null;
  const t0 = Date.now();
  let res;
  try {
    res = await chatImpl(opts);
  } catch (e) {
    logChatResult("CHAT", opts, providerId, t0, null, e);
    throw e;
  }
  logChatResult("CHAT", opts, providerId, t0, res, null);
  return res;
}

async function chatStream(opts, onDelta) {
  const providerId = opts.providerId || (opts.config && opts.config.id) || null;
  const t0 = Date.now();
  let res;
  try {
    res = await chatStreamImpl(opts, onDelta);
  } catch (e) {
    logChatResult("CHAT_STREAM", opts, providerId, t0, null, e);
    throw e;
  }
  logChatResult("CHAT_STREAM", opts, providerId, t0, res, null);
  return res;
}

module.exports = {
  chat,
  chatStream,
  listModels,
  supports,
  normalizeMessages,
  setDatabase,
  resolveConfig,
  configForId,
  adapterFor,
  ADAPTERS,
  // Adapters are exported individually for tests / direct use.
  adapters: { openai, groq, gemini, ollama, opencode, llamacpp },
};
