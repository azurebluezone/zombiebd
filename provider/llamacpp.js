"use strict";

/**
 * provider/llamacpp.js - llama.cpp native /completion adapter.
 *
 * llama-server exposes two dialects:
 *   POST {root}/completion                  native (this adapter)
 *   POST {root}/v1/chat/completions         OpenAI-compatible (provider/openai)
 *
 * The native path has no OpenAI chat envelope. The model's own chat template
 * is applied by the server via POST /apply-template, so this adapter never
 * hardcodes a prompt format for a model family.
 */

const transport = require("./transport");

const DIALECT = "llamacpp";

function nativeBase(cfg) {
  return String(cfg.baseUrl || "").replace(/\/+$/, "").replace(/\/v1$/, "");
}

function endpoint(cfg) {
  return nativeBase(cfg) + "/completion";
}

function headers(cfg) {
  const out = {};
  if (cfg.key) out.Authorization = "Bearer " + cfg.key;
  return Object.assign(out, cfg.headers || {});
}

function fallbackPrompt(messages) {
  const lines = [];
  for (const message of messages || []) {
    const role = String((message && message.role) || "user");
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content || "");
    lines.push(role + ": " + content);
  }
  lines.push("assistant:");
  return lines.join("\n");
}

async function applyTemplate(cfg, messages) {
  const base = nativeBase(cfg);
  try {
    const res = await transport.request(
      { baseUrl: base, key: cfg.key, headers: headers(cfg), timeout: cfg.timeout },
      base + "/apply-template",
      { messages: messages || [] },
    );
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const parsed = JSON.parse(res.body);
      if (parsed && typeof parsed.prompt === "string" && parsed.prompt) return parsed.prompt;
    }
  } catch (_) {
    // Older llama-server builds have no /apply-template; use the plain fallback.
  }
  return fallbackPrompt(messages);
}

function buildBody(params, prompt, stream) {
  const body = {
    prompt: prompt,
    stream: !!stream,
    n_predict: params.max_tokens != null ? params.max_tokens : -1,
  };
  if (params.temperature != null && params.temperature !== "") body.temperature = params.temperature;
  if (params.top_p != null) body.top_p = params.top_p;
  if (params.stop) body.stop = Array.isArray(params.stop) ? params.stop : [params.stop];
  return body;
}

function usageOf(raw) {
  const prompt = Number(raw && raw.tokens_evaluated) || 0;
  const completion = Number(raw && raw.tokens_predicted) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

async function chat(cfg, params) {
  const prompt = await applyTemplate(cfg, params.messages);
  const res = await transport.request(
    { baseUrl: nativeBase(cfg), key: cfg.key, headers: headers(cfg), timeout: cfg.timeout },
    endpoint(cfg),
    buildBody(params, prompt, false),
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

  let raw;
  try {
    raw = JSON.parse(res.body);
  } catch (error) {
    return { ok: false, statusCode: res.statusCode, error: "invalid JSON: " + error.message, raw: res.body };
  }

  const content = String((raw && raw.content) || "");
  const normalized = {
    id: "chatcmpl-llamacpp-" + Date.now(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: content },
      finish_reason: raw && raw.stop === false ? "length" : "stop",
    }],
    usage: usageOf(raw),
  };

  return {
    ok: !!content,
    statusCode: res.statusCode,
    raw: raw,
    normalized: normalized,
    content: content,
  };
}

async function chatStream(cfg, params, onDelta) {
  const prompt = await applyTemplate(cfg, params.messages);
  const id = "chatcmpl-llamacpp-" + Date.now();
  const created = Math.floor(Date.now() / 1000);
  let content = "";
  let finish = null;
  let streamError = null;

  const emit = function (delta, finishReason) {
    if (typeof onDelta !== "function") return;
    onDelta({
      id: id,
      object: "chat.completion.chunk",
      created: created,
      model: params.model,
      choices: [{ index: 0, delta: delta, finish_reason: finishReason || null }],
    });
  };

  emit({ role: "assistant", content: "" }, null);

  const res = await transport.stream(
    { baseUrl: nativeBase(cfg), key: cfg.key, headers: headers(cfg), streamTimeout: cfg.streamTimeout },
    endpoint(cfg),
    buildBody(params, prompt, true),
    function (line) {
      let frame;
      try { frame = JSON.parse(line); } catch (_) { return; }
      if (frame && frame.error) {
        streamError = {
          message: String((frame.error && frame.error.message) || frame.error),
          rate_limited: /rate.?limit|quota|too many requests|429/i.test(String(frame.error && frame.error.message ? frame.error.message : frame.error)),
        };
        return;
      }
      if (typeof frame.content === "string" && frame.content) {
        content += frame.content;
        emit({ content: frame.content }, null);
      }
      if (frame.stop === true) finish = "stop";
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

  if (finish === null) finish = "stop";
  emit({}, finish);

  if (streamError) {
    return {
      ok: false,
      statusCode: res.statusCode,
      error: streamError.message,
      rate_limited: !!streamError.rate_limited,
      stream_error: true,
      content: content,
      raw: res.text,
    };
  }

  return {
    ok: !!content,
    statusCode: res.statusCode,
    content: content,
    finish_reason: finish,
    raw: res.text,
  };
}

async function listModels(cfg) {
  const base = nativeBase(cfg);
  const response = await fetch(base + "/v1/models", {
    signal: AbortSignal.timeout(20000),
    headers: headers(cfg),
  });
  const text = await response.text();
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: transport.errorMessage(response.status, text) };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "invalid JSON: " + error.message };
  }
  const ids = [];
  for (const model of raw.data || []) {
    if (typeof model === "string") ids.push(model);
    else if (model && model.id) ids.push(model.id);
  }
  for (const model of raw.models || []) {
    const id = typeof model === "string" ? model : model && (model.name || model.model);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return { ok: ids.length > 0, models: ids, raw: raw };
}

module.exports = {
  id: "llamacpp",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
  nativeBase,
  fallbackPrompt,
};
