"use strict";

/**
 * Provider capabilities are declared, never inferred from a hostname.
 *
 * A provider is a response source. "Local" and "cloud" are deployment facts,
 * not capabilities, so they are deliberately absent from this module. DB
 * model flags (supports_tools / supports_media / supports_stream) can still
 * veto a capability per model in provider/index.js.
 */

const DEFAULTS = Object.freeze({
  stream: true,
  tools: true,
  media: false,
  maxTools: 15,
  // The model list follows a server that can start or stop while the
  // gateway runs. Ollama and the bridge declare this; a cloud API does not.
  dynamicModels: false,
});

// Wire-dialect defaults. Keys are adapter ids from provider/index.js, not
// vendor marketing names. Keep this table small: a capability belongs to a
// config or to the DB, not to a brand.
const ADAPTER_CAPABILITIES = Object.freeze({
  gemini: { media: true },
  ollama: { dynamicModels: true },
  llamacpp: { dynamicModels: true },
  "llama-cpp": { dynamicModels: true },
});

function forConfig(cfg, providerId) {
  const config = cfg && typeof cfg === "object" ? cfg : {};
  const id = String(providerId || config.id || "").toLowerCase();
  const dialect = String(
    config.adapter || config.dialect || config.type || "openai",
  ).toLowerCase();
  const declared =
    config.capabilities && typeof config.capabilities === "object"
      ? config.capabilities
      : {};

  // A provider may state a capability at the top level (e.g. Ollama and the
  // bridge both declare dynamicModels:true) without nesting it. Read both
  // shapes; the nested object wins because it is the more specific one.
  const topLevel = {};
  for (const key of ["stream", "tools", "media", "maxTools", "dynamicModels"]) {
    if (config[key] !== undefined) topLevel[key] = config[key];
  }

  const caps = {
    ...DEFAULTS,
    ...(ADAPTER_CAPABILITIES[id] || ADAPTER_CAPABILITIES[dialect] || {}),
    ...topLevel,
    ...declared,
  };

  // maxTools is a count, not a boolean. A bad value must not disable tools.
  const n = Number(caps.maxTools);
  caps.maxTools = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULTS.maxTools;
  caps.stream = caps.stream !== false;
  caps.tools = caps.tools !== false;
  caps.media = caps.media === true;
  caps.dynamicModels = caps.dynamicModels === true;
  return caps;
}

module.exports = { DEFAULTS, ADAPTER_CAPABILITIES, forConfig };
