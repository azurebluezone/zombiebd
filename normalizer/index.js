"use strict";
// ─── normalizer/index.js ──────────────────────────────────────────────
// HAQ MAWLA NORMALIZER — provider-native responses → OpenAI chat.completion
//
// The API server only ever consumes ONE shape:
//     { choices:[{ message:{ role, content, tool_calls, reasoning_content },
//                  finish_reason }], usage, model, provider }
// Streaming consumers only ever consume ONE shape:
//     { choices:[{ delta:{ role?, content?, tool_calls? }, index, finish_reason }] }
//
// This module is the single conversion point. Providers stay dumb (they only
// know how to speak their own official dialect); the API server stays dumb
// (it only knows OpenAI format). Everything else lives here.
//
// Dialects handled, each written from its official docs:
//   openai   https://platform.openai.com/docs/api-reference/chat
//   groq     https://console.groq.com/docs/api-reference      (OpenAI + x_groq)
//   ollama   https://docs.ollama.com/api/chat                 (message.content/tools)
//   gemini   https://ai.google.dev/api/generate-content       (candidates/parts)
//   anthropic/vllm/etc. — detected, mapped through the same OpenAI path.
//
// Nothing here is keyed on a model name. Detection is purely structural:
// which top-level fields exist in the payload.

// ─── Dialect detection (structural — no model names) ──────────────────
function detect(raw) {
  if (!raw || typeof raw !== "object") return "unknown";
  if (Array.isArray(raw.candidates)) return "gemini";
  if (raw.choices) return "openai";
  // Ollama /api/chat non-stream: {model, message:{role,content}, done}
  if (raw.message && typeof raw.done === "boolean") return "ollama";
  // Ollama list endpoints etc.
  if (Array.isArray(raw.models) && raw.models[0] && raw.models[0].name) return "ollama-list";
  return "unknown";
}

// ─── Tool-call helpers ────────────────────────────────────────────────
// OpenAI:   tool_calls[].function.arguments is a JSON *string*
// Ollama:   message.tool_calls[].function.arguments is a JSON *object*
// Gemini:   candidates[].content.parts[].functionCall = {name, args}
function asArgString(args) {
  if (typeof args === "string") return args;
  if (args && typeof args === "object") {
    try { return JSON.stringify(args); } catch (e) { return "{}"; }
  }
  return "{}";
}

function asArgObject(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string") {
    try { const o = JSON.parse(args); return o && typeof o === "object" ? o : {}; }
    catch (e) { return {}; }
  }
  return {};
}

// Streaming callers accumulate raw argument *fragments* (a partial JSON
// string split across SSE frames). Joining them yields the real arguments;
// only if there are no fragments do we fall back to the object form.
function joinedArgs(call) {
  if (call.fragments && call.fragments.length) return call.fragments.join("");
  return asArgString(call.args);
}

let toolCallSeq = 0;
function nextToolId(prefix) {
  toolCallSeq = (toolCallSeq + 1) % 1e9;
  return (prefix || "call_") + Date.now().toString(36) + "_" + toolCallSeq;
}

// ─── OpenAI dialect ───────────────────────────────────────────────────
function fromOpenAI(raw) {
  const choice = (raw.choices && raw.choices[0]) || {};
  const msg = choice.message || {};
  const content = msg.content == null ? "" : msg.content;
  const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
    ? msg.tool_calls.map(function (t, i) {
        const fn = t.function || {};
        return {
          id: t.id || nextToolId("call_"),
          type: t.type || "function",
          function: {
            name: fn.name || "",
            arguments: asArgString(fn.arguments),
          },
          index: typeof t.index === "number" ? t.index : i,
        };
      })
    : null;

  const finishMap = {
    // OpenAI/Groq values are already canonical.
    stop: "stop", length: "length", tool_calls: "tool_calls",
    content_filter: "content_filter", function_call: "function_call",
    // Ollama emits done_reason.
    stop_sequence: "stop", max_tokens: "length",
  };
  let finish = choice.finish_reason || raw.finish_reason || raw.done_reason || null;
  if (finish && !finishMap[finish]) finish = finishMap[finish] || finish;
  if (toolCalls && (!finish || finish === "stop")) finish = "tool_calls";

  return {
    choices: [{
      index: 0,
      message: Object.assign(
        { role: "assistant", content: content },
        toolCalls ? { tool_calls: toolCalls } : {},
        msg.reasoning_content ? { reasoning_content: msg.reasoning_content } :
          (msg.reasoning ? { reasoning_content: msg.reasoning } : {}),
        msg.reasoning ? { reasoning: msg.reasoning } : {},
      ),
      finish_reason: finish,
      logprobs: choice.logprobs == null ? null : choice.logprobs,
    }],
    usage: normalizeUsage(raw.usage),
    model: raw.model,
    id: raw.id,
    created: raw.created,
    provider: raw.provider || raw.x_groq || undefined,
    raw_format: "openai",
  };
}

function fromGroq(raw) {
  const out = fromOpenAI(raw);
  out.raw_format = "groq";
  // Groq-specific, but harmless to keep: https://console.groq.com/docs/api-reference
  if (raw.x_groq) out.x_groq = raw.x_groq;
  if (raw.system_fingerprint) out.system_fingerprint = raw.system_fingerprint;
  return out;
}

// ─── Ollama dialect ───────────────────────────────────────────────────
// https://docs.ollama.com/api/chat — ChatResponse / ChatStreamEvent
function fromOllama(raw) {
  const msg = raw.message || {};
  const content = msg.content == null ? "" : msg.content;
  const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length
    ? msg.tool_calls.map(function (t, i) {
        const fn = t.function || {};
        return {
          id: nextToolId("call_"),
          type: "function",
          function: { name: fn.name || "", arguments: asArgString(fn.arguments) },
          index: i,
        };
      })
    : null;

  const finish = toolCalls ? "tool_calls"
    : (raw.done_reason === "length" ? "length" : "stop");

  return {
    choices: [{
      index: 0,
      message: Object.assign(
        { role: "assistant", content: content },
        toolCalls ? { tool_calls: toolCalls } : {},
        msg.thinking ? { reasoning_content: msg.thinking } : {},
      ),
      finish_reason: raw.done === false && !toolCalls ? null : finish,
      logprobs: null,
    }],
    usage: {
      prompt_tokens: raw.prompt_eval_count || 0,
      completion_tokens: raw.eval_count || 0,
      total_tokens: (raw.prompt_eval_count || 0) + (raw.eval_count || 0),
    },
    model: raw.model,
    provider: "ollama",
    raw_format: "ollama",
  };
}

// ─── Gemini dialect ───────────────────────────────────────────────────
// https://ai.google.dev/api/generate-content
//   candidates[].content.parts[].text
//   candidates[].content.parts[].functionCall = {name, args}
function fromGemini(raw) {
  const cand = (raw.candidates && raw.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  let text = "";
  const toolCalls = [];
  let reasoning = "";

  for (const p of parts) {
    if (typeof p.text === "string") {
      // Gemini has no separate reasoning channel; `thought` marks it.
      if (p.thought) reasoning += p.text;
      else text += p.text;
    }
    if (p.functionCall) {
      toolCalls.push({
        id: nextToolId("call_"),
        type: "function",
        function: {
          name: p.functionCall.name || "",
          arguments: asArgString(p.functionCall.args),
        },
        index: toolCalls.length,
      });
    }
  }

  const finishMap = {
    STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter",
    RECITATION: "content_filter", OTHER: "stop",
    MALFORMED_FUNCTION_CALL: "tool_calls",
  };
  const finish = toolCalls.length
    ? "tool_calls"
    : (cand.finishReason ? (finishMap[cand.finishReason] || "stop") : "stop");

  const u = raw.usageMetadata || {};
  return {
    choices: [{
      index: 0,
      message: Object.assign(
        { role: "assistant", content: text },
        toolCalls.length ? { tool_calls: toolCalls } : {},
        reasoning ? { reasoning_content: reasoning } : {},
      ),
      finish_reason: finish,
      logprobs: null,
    }],
    usage: {
      prompt_tokens: u.promptTokenCount || 0,
      completion_tokens: u.candidatesTokenCount || 0,
      total_tokens: u.totalTokenCount ||
        (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0),
    },
    model: raw.model || undefined,
    provider: "gemini",
    raw_format: "gemini",
  };
}

// ─── Usage ────────────────────────────────────────────────────────────
function normalizeUsage(u) {
  if (!u) return null;
  return {
    prompt_tokens: u.prompt_tokens || u.input_tokens || 0,
    completion_tokens: u.completion_tokens || u.output_tokens || 0,
    total_tokens: u.total_tokens ||
      ((u.prompt_tokens || u.input_tokens || 0) +
       (u.completion_tokens || u.output_tokens || 0)),
    // Groq/Ollama timing extras survive when present.
    ...(u.prompt_time != null ? { prompt_time: u.prompt_time } : {}),
    ...(u.completion_time != null ? { completion_time: u.completion_time } : {}),
    ...(u.total_time != null ? { total_time: u.total_time } : {}),
  };
}

// ─── Public: non-streaming ────────────────────────────────────────────
// raw    : parsed provider response (already JSON.parse'd)
// opts   : { dialect } — pass the adapter's declared dialect, or omit to detect
// Returns an OpenAI chat.completion-shaped object. Never throws on shape
// surprises: an unrecognised payload comes back with empty choices so the
// caller's fallback policy can kick in instead of crashing.
function normalize(raw, opts) {
  opts = opts || {};
  let dialect = opts.dialect || detect(raw);
  if (dialect === "openai-compatible") dialect = "openai";

  let out;
  switch (dialect) {
    case "groq":     out = fromGroq(raw); break;
    case "ollama":   out = fromOllama(raw); break;
    case "gemini":   out = fromGemini(raw); break;
    case "openai":   out = fromOpenAI(raw); break;
    default:
      // Unknown dialect — try structurally before giving up.
      if (Array.isArray(raw && raw.candidates)) out = fromGemini(raw);
      else if (raw && raw.choices) out = fromOpenAI(raw);
      else if (raw && raw.message) out = fromOllama(raw);
      else out = null;
  }

  if (!out || !out.choices || !out.choices.length) {
    return {
      choices: [],
      usage: null,
      model: (raw && raw.model) || undefined,
      provider: opts.provider,
      raw_format: dialect,
      error: "unrecognised_response_shape",
      raw: raw,
    };
  }
  if (opts.provider) out.provider = opts.provider;
  return out;
}

// ─── Public: streaming ────────────────────────────────────────────────
// createStreamNormalizer returns a function that accepts ONE provider frame
// (already parsed JSON) and emits zero or one OpenAI chat.completion.chunk.
//
// Providers emit partial deltas; tool-call arguments arrive fragmented across
// frames in OpenAI and Ollama dialects, so argument fragments are accumulated
// and only emitted once complete (on finish, or when a new call index starts).
function createStreamNormalizer(opts) {
  opts = opts || {};
  const dialect = opts.dialect || "openai";
  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];               // {index, id, name, args}
  const emittedIds = new Set();

  function normalizeFrame(frame) {
    if (!frame || typeof frame !== "object") return null;

    // ── Ollama NDJSON frame ─────────────────────────────────────────
    if (dialect === "ollama" || (frame.message && typeof frame.done === "boolean")) {
      const m = frame.message || {};
      if (typeof m.content === "string" && m.content) content += m.content;
      if (typeof m.thinking === "string" && m.thinking) reasoning += m.thinking;
      if (Array.isArray(m.tool_calls)) {
        for (const t of m.tool_calls) {
          const fn = t.function || {};
          calls.push({
            index: calls.length,
            id: nextToolId("call_"),
            name: fn.name || "",
            args: asArgObject(fn.arguments),
            fragments: typeof fn.arguments === "string" ? [fn.arguments] : [],
          });
        }
      }
      if (frame.done) {
        finish = calls.length ? "tool_calls"
          : (frame.done_reason === "length" ? "length" : "stop");
      }
      return buildChunk();
    }

    // ── Gemini SSE frame ────────────────────────────────────────────
    if (dialect === "gemini" || Array.isArray(frame.candidates)) {
      const cand = (frame.candidates && frame.candidates[0]) || {};
      const parts = (cand.content && cand.content.parts) || [];
      for (const p of parts) {
        if (typeof p.text === "string") {
          if (p.thought) reasoning += p.text;
          else content += p.text;
        }
        if (p.functionCall) {
          calls.push({
            index: calls.length,
            id: nextToolId("call_"),
            name: p.functionCall.name || "",
            args: asArgObject(p.functionCall.args),
            fragments: [],
          });
        }
      }
      if (cand.finishReason) {
        finish = calls.length ? "tool_calls"
          : ({ STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter",
               RECITATION: "content_filter", OTHER: "stop" }[cand.finishReason] || "stop");
      }
      return buildChunk();
    }

    // ── OpenAI / Groq SSE frame ─────────────────────────────────────
    const choice = (frame.choices && frame.choices[0]) || {};
    const d = choice.delta || {};
    if (typeof d.content === "string" && d.content) content += d.content;
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
    if (typeof d.reasoning === "string") reasoning += d.reasoning;
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = typeof tc.index === "number" ? tc.index : calls.length;
        if (!calls[i]) {
          calls[i] = {
            index: i,
            id: tc.id || nextToolId("call_"),
            name: "",
            args: {},
            fragments: [],
          };
        }
        const c = calls[i];
        if (tc.id) c.id = tc.id;
        if (tc.function) {
          if (tc.function.name) c.name = tc.function.name;
          if (typeof tc.function.arguments === "string" && tc.function.arguments) {
            c.fragments.push(tc.function.arguments);
          }
        }
      }
    }
    if (choice.finish_reason) {
      finish = choice.finish_reason === "tool_calls" || calls.length
        ? (choice.finish_reason || "tool_calls")
        : choice.finish_reason;
    }
    return buildChunk();
  }

  // Emit a chunk carrying whatever is new since the last emission.
  function buildChunk() {
    const delta = {};
    const isNew = !emittedIds.size;
    if (isNew) delta.role = "assistant";
    if (content) { delta.content = content; content = ""; }
    if (reasoning) { delta.reasoning_content = reasoning; reasoning = ""; }

    const hasPayload = delta.content || delta.reasoning_content || delta.role;

    // Tool calls are NOT emitted incrementally: OpenAI and Ollama both
    // fragment `arguments` across frames, so emitting on first sight would
    // ship a truncated JSON string downstream. Hold them until finish/flush.
    const newCalls = finish
      ? calls.filter(function (c) { return !emittedIds.has(c.id); })
      : [];
    if (newCalls.length) {
      delta.tool_calls = newCalls.map(function (c) {
        emittedIds.add(c.id);
        return {
          index: c.index,
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: joinedArgs(c) },
        };
      });
    }

    if (!hasPayload && !delta.tool_calls && !finish) return null;

    return {
      id: "chatcmpl_stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: opts.model,
      provider: opts.provider,
      choices: [{
        index: 0,
        delta: delta,
        finish_reason: finish,
        logprobs: null,
      }],
      ...(finish ? { finish_reason: finish } : {}),
    };
  }

  // Flush: called at end-of-stream so nothing buffered is lost.
  function flush() {
    if (!content && !reasoning && !finish && !calls.length) return null;
    if (!finish) finish = calls.length ? "tool_calls" : "stop";
    return buildChunk() || {
      id: "chatcmpl_stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: opts.model,
      choices: [{ index: 0, delta: {}, finish_reason: finish, logprobs: null }],
    };
  }

  return { normalize: normalizeFrame, flush: flush };
}

module.exports = {
  normalize,
  detect,
  createStreamNormalizer,
  normalizeUsage,
  // Exposed for tests / adapters that need the same coercion.
  asArgString,
  asArgObject,
  joinedArgs,
  nextToolId,
};
