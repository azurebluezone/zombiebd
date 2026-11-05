"use strict";
// ─── provider/gemini.js ───────────────────────────────────────────────
// Google Gemini adapter — https://ai.google.dev/api/generate-content
//
// Gemini is NOT OpenAI-compatible on the wire. Official shape:
//
//   POST {base}/models/{model}:generateContent          (non-streaming)
//   POST {base}/models/{model}:streamGenerateContent?alt=sse   (streaming)
//   Auth: ?key=<API_KEY>  OR  x-goog-api-key header
//
//   request  : { contents:[{role:"user"|"model", parts:[…]}],
//                systemInstruction?, tools:[{functionDeclarations:[…]}],
//                toolConfig?, generationConfig:{temperature} }
//   response : { candidates:[{content:{parts:[…]}, finishReason}], usageMetadata }
//
// Parts dialect:
//   {text:"…"}                                  text
//   {inlineData:{mimeType,data}}                media (base64)   ← was `inline_data`
//   {functionCall:{name,args}}                  tool call (args = OBJECT)
//   {functionResponse:{name,response}}          tool result
//
// Note the role rename: OpenAI `assistant` ⇄ Gemini `model`.

const transport = require("./transport");
const { normalize, createStreamNormalizer, asArgString } = require("../normalizer");

const DIALECT = "gemini";
const GEMINI_DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

function cfgOf(cfg) {
  return Object.assign({}, cfg, { baseUrl: cfg.baseUrl || GEMINI_DEFAULT_BASE });
}

// ─── URL builders ─────────────────────────────────────────────────────
function chatUrl(cfg, model, streaming) {
  const base = String(cfg.baseUrl || GEMINI_DEFAULT_BASE).replace(/\/+$/, "");
  const action = streaming ? "streamGenerateContent" : "generateContent";
  const url = new URL(base + "/models/" + model + ":" + action);
  if (streaming) url.searchParams.set("alt", "sse");
  if (cfg.key) url.searchParams.set("key", cfg.key);   // §Endpoint: ?key=
  return url.toString();
}

function headers(cfg) {
  const h = { "Content-Type": "application/json; charset=utf-8" };
  // Header auth works alongside query auth and is the documented alternative.
  if (cfg.key) h["x-goog-api-key"] = cfg.key;
  return Object.assign(h, cfg.headers || {});
}

// ─── Message conversion: OpenAI-ish → Gemini contents ─────────────────
function toContents(messages) {
  if (!Array.isArray(messages)) return [];
  const contents = [];
  let systemText = "";

  for (const m of messages) {
    const rawRole = m.role || "user";
    // OpenAI roles → Gemini roles (§Content.role: "user" | "model")
    let role;
    if (rawRole === "system") {
      role = null;                       // handled as systemInstruction
    } else if (rawRole === "assistant" || rawRole === "model") {
      role = "model";
    } else {
      role = "user";                     // user + tool both fold into user
    }

    const parts = [];
    const textPieces = [];

    if (typeof m.content === "string") {
      if (m.content) textPieces.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") {
          textPieces.push(part.text);
        } else if (part.type === "image_url" && part.image_url) {
          const p = imagePart(part.image_url.url || part.image_url);
          if (p) parts.push(p);
        } else if (part.type === "input_audio" && part.input_audio) {
          const p = audioPart(part.input_audio);
          if (p) parts.push(p);
        } else if (typeof part.text === "string" && part.text) {
          textPieces.push(part.text);
        }
      }
    } else if (m.content != null) {
      textPieces.push(String(m.content));
    }

    // Assistant tool_calls → functionCall parts (§Part.functionCall)
    if (Array.isArray(m.tool_calls)) {
      for (const t of m.tool_calls) {
        const fn = t.function || {};
        parts.push({
          functionCall: {
            name: fn.name || "",
            args: safeArgs(fn.arguments),
          },
        });
      }
    }

    // Tool result → functionResponse part (§Part.functionResponse)
    if (rawRole === "tool") {
      const name = m.name || (m.tool_call_id ? String(m.tool_call_id) : "tool_result");
      parts.push({
        functionResponse: {
          name: name,
          response: { name: name, content: textPieces.join("\n") || "(empty)" },
        },
      });
      contents.push({ role: "user", parts: parts });
      continue;
    }

    if (textPieces.length) parts.unshift({ text: textPieces.join("\n") });

    if (role === null) {
      if (textPieces.length) systemText += (systemText ? "\n" : "") + textPieces.join("\n");
      continue;
    }
    if (!parts.length) continue;
    contents.push({ role: role, parts: parts });
  }

  return { contents, systemInstruction: systemText || undefined };
}

// OpenAI `image_url` (URL or data URI) → Gemini inlineData (§Part.inlineData).
// Gemini accepts base64 only for inline media, so http(s) URLs are fetched
// into base64; fetch failures omit the part rather than fail the request.
function imagePart(url) {
  if (typeof url !== "string" || !url) return null;
  const dataUri = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (dataUri) {
    const mime = dataUri[1] || "image/png";
    const data = dataUri[2] ? dataUri[3] : Buffer.from(dataUri[3], "utf8").toString("base64");
    return { inlineData: { mimeType: mime, data: data } };
  }
  if (/^https?:\/\//i.test(url)) {
    // Synchronous constraint: callers wanting remote images should send a
    // data URI. We return a fileData part only for already-uploaded files.
    return null;
  }
  // Bare base64
  if (/^[A-Za-z0-9+/=\s]+$/.test(url) && url.length > 64) {
    return { inlineData: { mimeType: "image/png", data: url.replace(/\s/g, "") } };
  }
  return null;
}

function audioPart(inputAudio) {
  if (!inputAudio || !inputAudio.data) return null;
  const fmt = inputAudio.format === "mp3" ? "audio/mpeg"
    : inputAudio.format === "wav" ? "audio/wav"
    : "application/octet-stream";
  return { inlineData: { mimeType: fmt, data: inputAudio.data } };
}

function safeArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string") {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; }
    catch (e) { return {}; }
  }
  return {};
}

// ─── OpenAI tools → Gemini functionDeclarations (§Tool.functionDeclarations) ──
function toGeminiTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const decls = [];
  for (const t of tools) {
    const fn = (t && t.function) || t;
    if (!fn || !fn.name) continue;
    const decl = { name: fn.name };
    if (fn.description) decl.description = fn.description;
    if (fn.parameters) decl.parameters = sanitizeSchema(fn.parameters);
    decls.push(decl);
  }
  if (!decls.length) return undefined;
  return [{ functionDeclarations: decls }];
}

// Gemini rejects JSON Schema keywords like `$schema`, `additionalProperties`,
// `exclusiveMinimum` — strip them (§Schema supports a subset).
function sanitizeSchema(schema, depth) {
  depth = depth || 0;
  if (!schema || typeof schema !== "object" || depth > 12) return undefined;
  if (Array.isArray(schema)) return schema.map(function (s) { return sanitizeSchema(s, depth + 1); });
  const out = {};
  const ALLOWED = ["type", "title", "description", "enum", "format", "nullable",
    "properties", "required", "items", "anyOf", "minimum", "maximum",
    "minItems", "maxItems", "minLength", "maxLength", "default"];
  for (const k of ALLOWED) {
    if (schema[k] === undefined) continue;
    if (k === "properties") {
      out.properties = {};
      for (const pk of Object.keys(schema.properties)) {
        const sub = sanitizeSchema(schema.properties[pk], depth + 1);
        if (sub) out.properties[pk] = sub;
      }
    } else if (k === "items" || k === "anyOf") {
      out[k] = sanitizeSchema(schema[k], depth + 1);
    } else {
      out[k] = schema[k];
    }
  }
  if (out.type === "integer") out.type = "integer";
  return out;
}

function buildBody(params) {
  const { contents, systemInstruction } = toContents(params.messages);
  const body = { contents: contents };
  if (systemInstruction) {
    body.systemInstruction = { parts: [{ text: systemInstruction }] };
  }
  const tools = toGeminiTools(params.tools);
  if (tools) {
    body.tools = tools;
    // §ToolConfig — "auto" mirrors OpenAI tool_choice:"auto"
    if (params.tool_choice === "none") {
      body.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    } else if (params.tool_choice && typeof params.tool_choice === "object" &&
               params.tool_choice.function && params.tool_choice.function.name) {
      body.toolConfig = { functionCallingConfig: {
        mode: "ANY", allowedFunctionNames: [params.tool_choice.function.name],
      } };
    } else if (params.tool_choice === "required") {
      body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    }
  }
  const gen = {};
  if (params.temperature != null && params.temperature !== "") {
    gen.temperature = Number(params.temperature);
  }
  if (params.max_tokens != null) gen.maxOutputTokens = Number(params.max_tokens);
  if (params.top_p != null) gen.topP = Number(params.top_p);
  if (params.stop) gen.stopSequences = Array.isArray(params.stop) ? params.stop : [params.stop];
  if (params.response_format && params.response_format.type === "json_object") {
    gen.responseMimeType = "application/json";
  }
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

// ─── Non-streaming ────────────────────────────────────────────────────
async function chat(cfg, params) {
  const c = cfgOf(cfg);
  const model = params.apiModel || params.model;
  const url = chatUrl(c, model, false);
  const body = buildBody(params);
  const res = await transport.request(
    { baseUrl: c.baseUrl, key: c.key, headers: headers(c),
      socketPath: c.socketPath, timeout: c.timeout },
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
    normalized: normalize(parsed, { dialect: DIALECT, provider: c.id }),
  };
}

// ─── Streaming: ?alt=sse ──────────────────────────────────────────────
async function chatStream(cfg, params, onDelta) {
  const c = cfgOf(cfg);
  const model = params.apiModel || params.model;
  const url = chatUrl(c, model, true);
  const body = buildBody(params);
  const norm = createStreamNormalizer({
    dialect: DIALECT, model: params.model, provider: c.id,
  });

  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];
  let sawPayload = false;
  // Gemini SSE error frames: {"error":{"code":429,"message":…}} on HTTP 200.
  let streamErr = null;

  const res = await transport.stream(
    { baseUrl: c.baseUrl, key: c.key, headers: headers(c),
      socketPath: c.socketPath, streamTimeout: c.streamTimeout },
    url, body,
    function onLine(line) {
      let frame;
      try { frame = JSON.parse(line); } catch (e) { return; }
      if (frame && frame.error && !Array.isArray(frame.candidates)) {
        const msg = (frame.error && (frame.error.message || frame.error)) || JSON.stringify(frame.error);
        streamErr = {
          message: String(msg),
          rate_limited: frame.error.code === 429 ||
            /rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(String(msg)),
        };
        return;
      }
      const chunk = norm.normalize(frame);
      if (chunk) { sawPayload = true; if (onDelta) onDelta(chunk); }

      const cand = (frame.candidates && frame.candidates[0]) || {};
      for (const p of (cand.content && cand.content.parts) || []) {
        if (typeof p.text === "string") {
          if (p.thought) reasoning += p.text; else content += p.text;
        }
        if (p.functionCall) {
          calls.push({
            index: calls.length,
            id: "call_gemini_" + calls.length,
            name: p.functionCall.name || "",
            arguments: asArgString(p.functionCall.args),
          });
        }
      }
      if (cand.finishReason) {
        finish = calls.length ? "tool_calls"
          : ({ STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter",
               RECITATION: "content_filter", OTHER: "stop" }[cand.finishReason] || "stop");
      }
    },
    { sse: true },
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

// ─── Model discovery: GET {base}/models ───────────────────────────────
async function listModels(cfg) {
  const c = cfgOf(cfg);
  const base = String(c.baseUrl || GEMINI_DEFAULT_BASE).replace(/\/+$/, "");
  const http = require("http");
  const https = require("https");
  const { URL } = require("url");
  const url = new URL(base + "/models");
  if (c.key) url.searchParams.set("key", c.key);
  const proto = url.protocol === "https:" ? https : http;
  return new Promise(function (resolve) {
    const req = proto.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "GET",
      headers: headers(c),
      timeout: 20000,
    }, function (res) {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", function (ch) { data += ch; });
      res.on("end", function () {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: transport.errorMessage(res.statusCode, data) });
          return;
        }
        try {
          const j = JSON.parse(data);
          // §models.list → {models:[{name:"models/gemini-2.0-flash",...}]}
          const ids = (j.models || [])
            .map(function (mm) { return String(mm.name || mm.model || "").replace(/^models\//, ""); })
            .filter(Boolean);
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
  id: "gemini",
  dialect: DIALECT,
  chat,
  chatStream,
  listModels,
  buildBody,
  toContents,
  toGeminiTools,
};
