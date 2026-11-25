"use strict";

/**
 * normalizer/api-response.js — the API response adapter.
 *
 * This used to be a 287-line function inside api.js. It now delegates every
 * non-tool-call dialect to normalizer/index.js, the same module the provider
 * layer uses. The external tool adapter still runs first for payloads whose
 * calls are embedded in a non-OpenAI envelope (Responses output[], Gemini
 * functionCall, Anthropic tool_use, ...).
 *
 * The public shape stays exactly what api.js consumers expect:
 *   { id, object, created, model (masked), provider:"ZombieCoder",
 *     choices[], usage, normalized:true, meta?, originalProvider? }
 */

const canonical = require("./index.js");

let TOOLADAPTER;
try {
  TOOLADAPTER = require("../external tools/tool.js");
} catch (e) {
  TOOLADAPTER = {
    parseToolCalls: () => [],
    normalizeChatToolCalls: (t) => t,
    extractText: () => "",
    detectApi: () => "unknown",
  };
  console.warn("[TOOL_ADAPTER_LOAD_FAIL] " + e.message);
}

function createNormalizeResponse(deps) {
  const options = deps || {};
  const mask =
    typeof options.maskModelName === "function"
      ? options.maskModelName
      : (name) => name;

  return function normalizeResponse(raw, modelHint) {
    // Empty/null input -> error response
    if (!raw) {
      return {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: mask(modelHint || "unknown"),
        provider: "ZombieCoder",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "error",
          },
        ],
        usage: {},
        normalized: true,
        error: true,
      };
    }

    // UTF-8 fix: a Buffer wrapper is decoded, then parsed as JSON.
    if (raw.type === "Buffer") {
      raw = Buffer.from(raw.data || raw).toString("utf8");
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch (e) {}
      }
    }

    const id = raw.id || `chatcmpl-${Date.now()}`;
    const created = raw.created || Math.floor(Date.now() / 1000);
    const model = raw.model || modelHint || "unknown";
    const choice = raw.choices && raw.choices[0] ? raw.choices[0] : null;

    // Universal adapter pass for tool calls embedded in foreign envelopes.
    if (!choice) {
      const autoToolCalls = TOOLADAPTER.parseToolCalls(raw);
      if (autoToolCalls.length) {
        return {
          id,
          object: "chat.completion",
          created,
          model: mask(model),
          provider: "ZombieCoder",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: TOOLADAPTER.extractText(raw) || "",
                tool_calls: autoToolCalls,
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: raw.usage || {},
          normalized: true,
          originalFormat: TOOLADAPTER.detectApi(raw),
          toolCallsFrom: "universal-adapter",
        };
      }
    }

    // Every remaining text dialect goes through the canonical normalizer.
    const normalized = canonical.normalize(raw);
    if (normalized && Array.isArray(normalized.choices) && normalized.choices.length) {
      const outChoice = normalized.choices[0];
      const message = outChoice.message || {};
      let content = message.content == null ? "" : String(message.content);
      const reasoning = message.reasoning_content || message.reasoning || null;
      let contentWasEmpty = false;
      if (!content && reasoning) {
        content = typeof reasoning === "string" ? reasoning : JSON.stringify(reasoning);
        contentWasEmpty = true;
      }
      const toolCalls = TOOLADAPTER.normalizeChatToolCalls(message.tool_calls);
      const finish = outChoice.finish_reason || "stop";
      return {
        id,
        object: "chat.completion",
        created,
        model: mask(model),
        provider: "ZombieCoder",
        choices: [
          {
            index: 0,
            message: {
              role: message.role || "assistant",
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finish,
          },
        ],
        usage: raw.usage || normalized.usage || {},
        normalized: true,
        ...(normalized.raw_format && normalized.raw_format !== "openai"
          ? { originalProvider: normalized.raw_format }
          : {}),
        meta: {
          contentWasEmpty,
          hasReasoning: !!reasoning,
          provider: "ZombieCoder",
          latency: raw._latency || 0,
          requestedModel: mask(modelHint || null),
          rawFinish: finish,
        },
      };
    }

    // Unknown external format: keep the provider text visible, never lose it.
    if (typeof console !== "undefined" && options.log) {
      options.log("WARN", "HAQ_MAWLA_UNKNOWN_FORMAT", {
        model: String(model).slice(0, 30),
        keys: raw && typeof raw === "object" ? Object.keys(raw).slice(0, 8) : [],
        type: typeof raw,
        hint: modelHint || "none",
      });
    }
    return {
      id,
      object: "chat.completion",
      created,
      model: mask(model),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 500),
          },
          finish_reason: "stop",
        },
      ],
      usage: (raw && raw.usage) || {},
      normalized: true,
      originalFormat: "unknown_external",
      provider: "ZombieCoder",
    };
  };
}

module.exports = { createNormalizeResponse };
