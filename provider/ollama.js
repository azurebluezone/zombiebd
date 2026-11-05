"use strict";
// ─── provider/ollama.js ───────────────────────────────────────────────
// Ollama adapter — https://docs.ollama.com/api/chat
//
// ⚠️ NO local/cloud distinction anywhere in this file. Ollama is one
// provider; a model is a model; whether the process behind the base URL
// runs on this box or at ollama.com is irrelevant to request construction.
// The base URL and key come from configuration, nothing else.
//
// Two official endpoints exist:
//   • POST {base}/api/chat         native Ollama dialect (ChatRequest/ChatResponse)
//   • POST {base}/v1/chat/completions   OpenAI-compatible dialect
//
// We default to the NATIVE endpoint because only it exposes:
//   • `images: ["<base64>"]` on messages            (§ChatMessage.images)
//   • `thinking` / `think` on responses             (§ChatStreamEvent.thinking)
//   • `done_reason` precise stop reason
//   • NDJSON streaming (application/x-ndjson, NOT SSE)
//
// Set `dialect: "openai"` on the config to route through /v1 instead.
//
// Native request shape (§ChatRequest):
//   { model, messages, tools?, stream?, options?: { temperature }, think? }
// Native message shape (§ChatMessage):
//   { role, content, images?: [base64], tool_calls?: [{function:{name,arguments}}] }
// Note `arguments` here is an OBJECT, not a JSON string (unlike OpenAI).

const transport = require("./transport");
const { normalize, createStreamNormalizer, asArgObject } = require("../normalizer");
const openaiAdapter = require("./openai");

const DIALECT = "ollama";

function cfgOf(cfg) {
  const headers = Object.assign(
    { Accept: "application/x-ndjson, application/json" },
    cfg.headers || {},
  );
  // §Authentication — ollama.com cloud requires the API key as a Bearer
  // token (docs: curl https://ollama.com/api/chat -H "Authorization: Bearer
  // $OLLAMA_API_KEY"). Local keyless servers simply ignore the header.
  // Without this, the native path reached ollama.com anonymously → 401.
  if (cfg.key && !headers.Authorization) headers.Authorization = "Bearer " + cfg.key;
  return Object.assign({}, cfg, { headers: headers });
}

// Native endpoints live at the SERVER ROOT (/api/chat, /api/tags), but base
// URLs often carry a trailing /v1 (e.g. OLLAMA_BASE=https://ollama.com/v1).
// Strip it so the native path never becomes /v1/api/chat — evidence:
// GET https://ollama.com/v1/api/tags → 404, GET https://ollama.com/api/tags → 200.
function nativeBase(cfg) {
  return String(cfg.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function endpoint(cfg) {
  if (cfg.dialect === "openai") {
    // Same rule as provider/openai.js: {base}/chat/completions, base as-is.
    return String(cfg.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  }
  return nativeBase(cfg) + "/api/chat";
}

// ─── Message conversion: OpenAI-ish → Ollama native ───────────────────
// The server hands us OpenAI-format messages. Ollama wants:
//   • content as a plain string
//   • media parts flattened into `images: [base64]`
//   • assistant tool_calls kept but with OBJECT arguments
//   • tool results as role:"tool"
function toOllamaMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    const role = m.role || "user";
    const entry = { role, content: "" };
    const images = [];

    if (typeof m.content === "string") {
      entry.content = m.content;
    } else if (Array.isArray(m.content)) {
      const texts = [];
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") {
          texts.push(part.text);
        } else if (part.type === "image_url" && part.image_url) {
          const b64 = imageDataToBase64(part.image_url.url || part.image_url);
          if (b64) images.push(b64);
        } else if (part.type === "input_audio" && part.input_audio) {
          // Ollama /api/chat has no audio input channel (§ChatMessage has no
          // audio field) — drop it rather than send a malformed message.
        } else if (typeof part.text === "string") {
          texts.push(part.text);
        }
      }
      entry.content = texts.join("\n");
    } else if (m.content == null) {
      entry.content = "";
    } else {
      entry.content = String(m.content);
    }

    // Assistant tool calls → native object-argument form.
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      entry.tool_calls = m.tool_calls.map(function (t) {
        const fn = t.function || {};
        return { function: { name: fn.name || "", arguments: asArgObject(fn.arguments) } };
      });
      if (!entry.content) entry.content = "";
    }

    // Tool result message: Ollama §ChatMessage role "tool".
    if (role === "tool") entry.role = "tool";

    if (images.length) entry.images = images;
    out.push(entry);
  }
  return out;
}

// "data:image/png;base64,AAAA…" or bare base64 or a URL → raw base64.
// Remote URLs are left alone (Ollama wants base64 only), so we return null
// and the caller omits the image instead of sending a broken field.
function imageDataToBase64(url) {
  if (typeof url !== "string") return null;
  const m = /^data:image\/[^;]+;base64,(.+)$/.exec(url);
  if (m) return m[1];
  if (/^https?:\/\//i.test(url)) return null;   // can't inline a remote URL
  if (/^[A-Za-z0-9+/=\s]+$/.test(url) && url.length > 64) return url.replace(/\s/g, "");
  return null;
}

function buildBody(params) {
  const body = {
    model: params.apiModel || params.model,
    messages: params.ollamaMessages || toOllamaMessages(params.messages),
    stream: !!params.stream,
  };
  if (params.tools && params.tools.length) body.tools = params.tools;
  if (params.temperature != null && params.temperature !== "") {
    // §ModelOptions.temperature
    body.options = Object.assign({}, body.options, { temperature: params.temperature });
  }
  if (params.max_tokens != null) {
    body.options = Object.assign({}, body.options, { num_predict: params.max_tokens });
  }
  if (params.think != null) body.think = params.think;
  if (params.format) body.format = params.format;
  return body;
}

// ─── Non-streaming ────────────────────────────────────────────────────
async function chat(cfg, params) {
  // OpenAI dialect requested → delegate entirely.
  if (cfg.dialect === "openai") {
    return openaiAdapter.chat(cfgOf(cfg), params);
  }

  const url = endpoint(cfg);
  const body = buildBody(Object.assign({}, params, { stream: false }));
  const res = await transport.request(
    { baseUrl: cfg.baseUrl, key: cfg.key, headers: cfgOf(cfg).headers,
      socketPath: cfg.socketPath, timeout: cfg.timeout },
    url, body,
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false, statusCode: res.statusCode,
      error: transport.errorMessage(res.statusCode, res.body),
      rate_limited: res.statusCode === 429,
      raw: res.body,
    };
  }
  let parsed;
  try { parsed = JSON.parse(res.body); }
  catch (e) {
    return { ok: false, statusCode: res.statusCode, error: "invalid JSON: " + e.message, raw: res.body };
  }
  return {
    ok: true, statusCode: res.statusCode, raw: parsed,
    normalized: normalize(parsed, { dialect: DIALECT, provider: cfg.id }),
  };
}

// ─── Streaming: NDJSON, NOT SSE ───────────────────────────────────────
// §"application/x-ndjson" — each line is a complete ChatStreamEvent.
async function chatStream(cfg, params, onDelta) {
  if (cfg.dialect === "openai") {
    return openaiAdapter.chatStream(cfgOf(cfg), params, onDelta);
  }

  const url = endpoint(cfg);
  const body = buildBody(Object.assign({}, params, { stream: true }));
  const norm = createStreamNormalizer({
    dialect: DIALECT, model: params.model, provider: cfg.id,
  });

  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];
  let sawPayload = false;
  // Ollama emits {"error":"…"} as an NDJSON line — evidence: ollama.com
  // returns HTTP 200 + {"error":"<model> was retired…"} for a bad model.
  let streamErr = null;

  const res = await transport.stream(
    { baseUrl: cfg.baseUrl, key: cfg.key, headers: cfgOf(cfg).headers,
      socketPath: cfg.socketPath, streamTimeout: cfg.streamTimeout },
    url, body,
    function onLine(line) {
      let frame;
      try { frame = JSON.parse(line); } catch (e) { return; }
      if (frame && frame.error && !frame.message && typeof frame.done !== "boolean") {
        const msg = typeof frame.error === "string" ? frame.error : (frame.error.message || JSON.stringify(frame.error));
        streamErr = {
          message: String(msg),
          rate_limited: /rate.?limit|quota|too many requests|429/i.test(String(msg)),
        };
        return;
      }
      const chunk = norm.normalize(frame);
      if (chunk) { sawPayload = true; if (onDelta) onDelta(chunk); }

      const m = frame.message || {};
      if (m.content) content += m.content;
      if (m.thinking) reasoning += m.thinking;
      if (Array.isArray(m.tool_calls)) {
        for (const t of m.tool_calls) {
          const fn = t.function || {};
          calls.push({
            index: calls.length,
            id: "call_ollama_" + calls.length,
            name: fn.name || "",
            arguments: JSON.stringify(asArgObject(fn.arguments)),
          });
        }
      }
      if (frame.done) finish = calls.length ? "tool_calls"
        : (frame.done_reason === "length" ? "length" : "stop");
    },
    { ndjson: true },   // no "data:" prefix to strip
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false, statusCode: res.statusCode,
      error: transport.errorMessage(res.statusCode, res.text),
      rate_limited: res.statusCode === 429,
      raw: res.text,
    };
  }

  const tail = norm.flush();
  if (tail && !sawPayload && onDelta) onDelta(tail);

  if (streamErr) {
    return {
      ok: false,
      statusCode: res.statusCode,
      error: streamErr.message,
      rate_limited: !!streamErr.rate_limited,
      stream_error: true,
      content,
      raw: res.text,
    };
  }

  return {
    ok: !!(content || calls.length),
    content,
    reasoning_content: reasoning || null,
    tool_calls: calls.length ? calls : null,
    finish_reason: finish || (calls.length ? "tool_calls" : "stop"),
    raw: res.text,
  };
}

// ─── Model discovery ──────────────────────────────────────────────────
// Native: GET {base}/api/tags  → {models:[{name,model,...}]}
async function listModels(cfg) {
  if (cfg.dialect === "openai") return openaiAdapter.listModels(cfgOf(cfg));
  const http = require("http");
  const https = require("https");
  const { URL } = require("url");
  const base = nativeBase(cfg);
  const url = new URL(base + "/api/tags");
  const proto = url.protocol === "https:" ? https : http;
  return new Promise(function (resolve) {
    const req = proto.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: cfg.key ? { Authorization: "Bearer " + cfg.key } : {},
      timeout: 20000,
    }, function (res) {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { data += c; });
      res.on("end", function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: transport.errorMessage(res.statusCode, data) });
          return;
        }
        try {
          const j = JSON.parse(data);
          const ids = (j.models || []).map(function (m) { return m.name || m.model; }).filter(Boolean);
          resolve({ ok: true, models: ids, raw: j });
        } catch (e) {
          resolve({ ok: false, error: "invalid JSON: " + e.message });
        }
      });
    });
    req.on("error", function (e) { resolve({ ok: false, error: e.message }); });
    req.on("timeout", function () { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

module.exports = {
  id: "ollama",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
  buildBody,
  toOllamaMessages,
};
