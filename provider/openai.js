"use strict";
// ─── provider/openai.js ───────────────────────────────────────────────
// OpenAI-compatible adapter.
//
// Covers every provider that speaks the OpenAI Chat Completions dialect:
//   • OpenAI itself        https://platform.openai.com/docs/api-reference/chat
//   • OpenCode             (OpenAI-compatible endpoint)
//   • Cloudflare AI Gateway(OpenAI-compatible)
//   • custom_N providers   (OpenAI-compatible)
//   • Ollama /v1, vLLM, LM Studio, llama.cpp server — anything /v1/chat/completions
//
// Dialect is "openai": request and response both follow the OpenAI shape, so
// the normalizer passes responses straight through its openai path.
//
// Doc: POST {base}/chat/completions
//   body   : {model, messages, tools?, tool_choice?, temperature?, stream?}
//   auth   : Authorization: Bearer <key>
//   media  : messages[].content = [{type:"text"},{type:"image_url",image_url:{url}}]
//   stream : SSE, `data: {json}` frames terminated by `data: [DONE]`

const transport = require("./transport");
const { normalize, createStreamNormalizer } = require("../normalizer");

const DIALECT = "openai";

function endpoint(cfg, stream) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  return base + "/chat/completions";
}

function authHeaders(cfg) {
  const h = {};
  // OpenAI-compatible servers accept Bearer; empty key ⇒ no header
  // (local servers like vLLM/llama.cpp often need none).
  if (cfg.key) h.Authorization = "Bearer " + cfg.key;
  return Object.assign(h, cfg.headers || {});
}

// ─── Request body (OpenAI doc §Body Parameters) ───────────────────────
function buildBody(params) {
  const body = {
    model: params.apiModel || params.model,
    messages: params.messages,
  };
  if (params.tools && params.tools.length) {
    body.tools = params.tools;
    if (params.tool_choice) body.tool_choice = params.tool_choice;
  }
  if (params.temperature != null && params.temperature !== "")
    body.temperature = params.temperature;
  if (params.max_tokens != null) body.max_tokens = params.max_tokens;
  if (params.stream) {
    body.stream = true;
    // include_usage gives us a final chunk with token counts (OpenAI §stream_options)
    body.stream_options = { include_usage: true };
  }
  if (params.response_format) body.response_format = params.response_format;
  if (params.stop) body.stop = params.stop;
  if (params.user) body.user = params.user;
  return body;
}

// ─── Non-streaming ────────────────────────────────────────────────────
// Returns { ok, normalized, raw, statusCode, error }.
async function chat(cfg, params) {
  const url = endpoint(cfg, false);
  // A subclass adapter (e.g. Groq) may supply its own body builder.
  const builder = typeof params._build === "function" ? params._build : buildBody;
  const body = builder(Object.assign({}, params, { stream: false }));
  delete body._build;
  const res = await transport.request(
    { baseUrl: cfg.baseUrl, key: cfg.key, headers: authHeaders(cfg),
      socketPath: cfg.socketPath, timeout: cfg.timeout },
    url, body,
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      statusCode: res.statusCode,
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
    ok: true,
    statusCode: res.statusCode,
    raw: parsed,
    normalized: normalize(parsed, { dialect: DIALECT, provider: cfg.id }),
  };
}

// ─── Streaming ────────────────────────────────────────────────────────
// onDelta(chunk) receives OpenAI chat.completion.chunk objects.
// Returns { ok, content, tool_calls, reasoning_content, raw, error }.
async function chatStream(cfg, params, onDelta) {
  const url = endpoint(cfg, true);
  const builder = typeof params._build === "function" ? params._build : buildBody;
  const body = builder(Object.assign({}, params, { stream: true }));
  delete body._build;
  const norm = createStreamNormalizer({
    dialect: DIALECT, model: params.model, provider: cfg.id,
  });

  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];
  let sawPayload = false;
  // HTTP 200 + an error FRAME (OpenCode FreeUsageLimitError, quota notices,
  // {"type":"error"} events) — without this the failure is swallowed as
  // "empty content" and the rate-limit cooldown never fires.
  let streamErr = null;

  const res = await transport.stream(
    { baseUrl: cfg.baseUrl, key: cfg.key, headers: authHeaders(cfg),
      socketPath: cfg.socketPath, streamTimeout: cfg.streamTimeout },
    url, body,
    function onLine(line) {
      let frame;
      try { frame = JSON.parse(line); } catch (e) { return; }
      if (frame && (frame.error || frame.type === "error") &&
          frame.choices === undefined && frame.usage === undefined) {
        const msg = (frame.error && (frame.error.message || frame.error)) ||
          frame.message || JSON.stringify(frame);
        streamErr = {
          message: String(msg),
          rate_limited: /rate.?limit|quota|too many requests|429|FreeUsageLimit|usage limit/i.test(String(msg)),
        };
        return;
      }
      const chunk = norm.normalize(frame);
      if (chunk) {
        sawPayload = true;
        if (typeof onDelta === "function") onDelta(chunk);
      }
      // Accumulate for the caller's fallback decisions.
      const c = (frame.choices && frame.choices[0]) || {};
      if (c.delta) {
        if (c.delta.content) content += c.delta.content;
        if (c.delta.reasoning_content) reasoning += c.delta.reasoning_content;
        if (Array.isArray(c.delta.tool_calls)) {
          for (const tc of c.delta.tool_calls) {
            const i = typeof tc.index === "number" ? tc.index : calls.length;
            if (!calls[i]) calls[i] = { index: i, id: tc.id, name: "", arguments: "" };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function) {
              if (tc.function.name) calls[i].name = tc.function.name;
              if (tc.function.arguments) calls[i].arguments += tc.function.arguments;
            }
          }
        }
        if (c.finish_reason) finish = c.finish_reason;
      }
      if (frame.usage) sawPayload = true;
    },
    { sse: true },
  );

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return {
      ok: false,
      statusCode: res.statusCode,
      error: transport.errorMessage(res.statusCode, res.text),
      rate_limited: res.statusCode === 429,
      raw: res.text,
    };
  }

  const tail = norm.flush();
  if (tail && !sawPayload && typeof onDelta === "function") onDelta(tail);
  if (tail && tail.choices && tail.choices[0] && tail.choices[0].finish_reason) {
    finish = finish || tail.choices[0].finish_reason;
  }

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
    finish_reason: finish,
    raw: res.text,
  };
}

// ─── Model discovery: GET {base}/models ───────────────────────────────
// Doc: https://platform.openai.com/docs/api-reference/models/list
async function listModels(cfg) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const res = await transport.request(
    { baseUrl: cfg.baseUrl, key: cfg.key, headers: authHeaders(cfg),
      socketPath: cfg.socketPath, timeout: 20000, method: "GET" },
    base + "/models", null,
  ).catch(function (e) { return { statusCode: 0, body: e.message }; });

  // transport.request always POSTs; for a GET we do a direct call instead.
  if (res.statusCode === 405 || res.statusCode === 404 || res.statusCode === 0) {
    return listModelsGet(cfg);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { ok: false, error: transport.errorMessage(res.statusCode, res.body) };
  }
  return parseModelList(res.body);
}

function listModelsGet(cfg) {
  const { URL } = require("url");
  const http = require("http");
  const https = require("https");
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const url = new URL(base + "/models");
  const proto = url.protocol === "https:" ? https : http;
  const headers = authHeaders(cfg);
  return new Promise(function (resolve) {
    const req = proto.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers,
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
        resolve(parseModelList(data));
      });
    });
    req.on("error", function (e) { resolve({ ok: false, error: e.message }); });
    req.on("timeout", function () { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

function parseModelList(body) {
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j) ? j : (j.data || j.models || []);
    const ids = arr.map(function (m) {
      return typeof m === "string" ? m : (m.id || m.name || m.model);
    }).filter(Boolean);
    return { ok: true, models: ids, raw: j };
  } catch (e) {
    return { ok: false, error: "invalid model list JSON: " + e.message };
  }
}

module.exports = {
  id: "openai",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
  buildBody,
  authHeaders,
};
