"use strict";
// ─── provider/tools.js — THE TOOL REGISTER ─────────────────────────────
// The API server's ONE point of contact for tool calling. Built by reading
// the official tool-calling docs of every dialect (the same sources as
// `external tools/tool.js` UTCA and the individual adapters):
//
//   [openai]    https://platform.openai.com/docs/api-reference/chat
//               tools: [{type:"function", function:{name,description,parameters}}]
//               result message: {role:"tool", tool_call_id, content}
//   [groq]      https://console.groq.com/docs/tool-use/overview
//               chat-style tools; response carries x_groq metadata
//   [ollama]    https://docs.ollama.com/capabilities/tool-calling
//               chat-style tools, arguments are OBJECTS (not JSON strings),
//               result message: {role:"tool", tool_name, content}
//   [gemini]    https://ai.google.dev/api/generate-content (§Tool, §Part)
//               tools: [{functionDeclarations:[…]}] with a Schema SUBSET,
//               history: functionCall / functionResponse parts,
//               result part: {functionResponse:{name,response:{…}}}
//   [opencode]  OpenAI dialect on the wire; its headers live in
//               provider/opencode.js — never in api.js.
//
// DIVISION OF LABOUR (project rule):
//   • The register decides WHETHER tools may be sent (DB capability gate —
//     no hardcoded model names anywhere).
//   • The adapters decide HOW tools are serialised (headers + payload per
//     official docs) — that is adapter-layer work, never server work.
//   • The normalizer decides HOW tool calls come back (one OpenAI shape).

const openaiAdapter = require("./openai");
const ollamaAdapter = require("./ollama");
const geminiAdapter = require("./gemini");

// ─── Register ─────────────────────────────────────────────────────────
// Each spec is documentation + converters in one place. `args` records the
// dialect's canonical argument representation, which the normalizer enforces
// on the way back (string everywhere, object only inside Ollama's native
// request builder).
const SPECS = {
  openai: {
    doc: "https://platform.openai.com/docs/api-reference/chat",
    dialect: "openai",
    args: "json-string",
    toolsField: "chat-style",
    history: "chat-style",
    toTools: function (tools) { return tools; },
    toMessages: function (messages) { return messages; },
  },
  groq: {
    doc: "https://console.groq.com/docs/tool-use/overview",
    dialect: "groq",
    args: "json-string",
    toolsField: "chat-style",
    history: "chat-style",
    toTools: function (tools) { return tools; },
    toMessages: function (messages) { return messages; },
  },
  opencode: {
    doc: "https://opencode.ai/docs",
    dialect: "openai",
    args: "json-string",
    toolsField: "chat-style",
    history: "chat-style",
    toTools: function (tools) { return tools; },
    toMessages: function (messages) { return messages; },
  },
  ollama: {
    doc: "https://docs.ollama.com/capabilities/tool-calling",
    dialect: "ollama",
    args: "object",                 // §ChatMessage tool_calls[].function.arguments
    toolsField: "chat-style",       // same wrapper as OpenAI
    history: "native",              // role:"tool" + tool_name
    toTools: function (tools) { return tools; },
    toMessages: function (messages) { return ollamaAdapter.toOllamaMessages(messages); },
  },
  gemini: {
    doc: "https://ai.google.dev/api/generate-content",
    dialect: "gemini",
    args: "object",                 // §Part.functionCall.args
    toolsField: "functionDeclarations",
    history: "contents-parts",
    toTools: function (tools) { return geminiAdapter.toGeminiTools(tools); },
    toMessages: function (messages) { return geminiAdapter.toContents(messages).contents; },
  },
};

// Resolve a spec for a resolved provider config (id / type / dialect).
function specFor(cfg) {
  if (!cfg) return SPECS.openai;
  const explicit = String(cfg.adapter || cfg.dialect || "").toLowerCase();
  if (explicit && SPECS[explicit]) return SPECS[explicit];
  const id = String(cfg.id || "").toLowerCase();
  if (SPECS[id]) return SPECS[id];
  const type = String(cfg.type || "openai").toLowerCase();
  return SPECS[type] || SPECS.openai;
}

// ─── DB capability gate ───────────────────────────────────────────────
// Returns the tools array to send, or undefined when the DB says this
// model cannot take tools. Unknown ⇒ allow (an over-eager "no" would
// silently disable working models).
let MODELS_DB = null;
function setDatabase(db) { MODELS_DB = db; }

function allowsTools(providerId, modelName) {
  if (!MODELS_DB) return true;
  try {
    const row = MODELS_DB.prepare(
      "SELECT supports_tools FROM models WHERE provider = ? AND (name = ? OR api_model = ?) LIMIT 1",
    ).get(providerId, modelName, modelName);
    if (!row || row.supports_tools === null || row.supports_tools === undefined) return true;
    return row.supports_tools === 1 || row.supports_tools === true || row.supports_tools === "1";
  } catch (e) {
    return true;   // table/column missing ⇒ allow
  }
}

// prepare() — the function api.js calls right before every model call.
//   providerId : resolved provider id (opencode, gemini, custom_3, …)
//   model      : the API model name actually sent on the wire
//   tools      : canonical OpenAI tools[] from the server
// Returns tools (possibly unchanged) or undefined when unsupported.
function prepare(providerId, model, tools, cfg) {
  if (!tools || !tools.length) return undefined;
  if (!allowsTools(providerId, model)) return undefined;
  return tools;
}

function register(dialect, spec) {
  SPECS[dialect] = spec;
  return spec;
}

module.exports = {
  SPECS,
  register,
  specFor,
  prepare,
  allowsTools,
  setDatabase,
};
