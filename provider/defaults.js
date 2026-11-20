"use strict";

// ─── provider/defaults.js ─────────────────────────────────────────────
// One source of truth for the built-in provider endpoints.
//
// Before this module the same four URLs lived in api.js and again in
// provider/index.js, and the copies disagreed: Api.js defaulted Ollama to
// port 5051 while every documented install uses 11434, and provider/index.js
// could not resolve the bridge at all. A provider id must have one endpoint
// definition, whether the caller is api.js or a standalone adapter.
//
// `resolveBaseUrl` also completes a host-only official URL with the version
// path from the provider's own docs:
//   groq    https://api.groq.com                    -> /openai/v1
//   gemini  https://generativelanguage.googleapis.com -> /v1beta
//   ollama  http://127.0.0.1:11434 (openai dialect)  -> /v1
//   bridge  http://localhost:11435                   -> /v1
// A URL that already carries a path is returned unchanged: a reverse proxy
// or a self-hosted endpoint keeps the path the operator configured.

const { DEFAULTS } = require("../lib/env");

const BUILTINS = Object.freeze({
  opencode: {
    name: "OpenCode",
    type: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
  },
  groq: {
    name: "Groq",
    type: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  gemini: {
    name: "Gemini",
    type: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  ollama: {
    name: "Ollama",
    type: "openai",
    // The OpenAI-compatible surface is /v1. The native adapter strips it
    // again for /api/chat, so one default works for both dialects.
    baseUrl: "http://localhost:11434/v1",
  },
  ollama_cloud: {
    name: "Ollama Cloud",
    type: "openai",
    baseUrl: "https://ollama.com",
  },
  bridge: {
    name: "Local LLM Bridge",
    type: "openai",
    baseUrl: "",
  },
});

function envOf(options) {
  return (options && options.env) || process.env;
}

function bridgeBase(env) {
  return (
    env.BRIDGE_BASE ||
    "http://localhost:" + (env.BRIDGE_PORT || DEFAULTS.BRIDGE_PORT) + "/v1"
  );
}

/**
 * Resolve one built-in provider base URL.
 *
 * @param {string} id        provider id (groq, gemini, ollama, bridge, …)
 * @param {string} raw       configured value; empty means "use the default"
 * @param {{env?: object, dialect?: string}} [options]
 * @returns {string} base URL without a trailing slash, or "" for an unknown id
 */
function resolveBaseUrl(id, raw, options) {
  const key = String(id || "").toLowerCase();
  const opts = options || {};
  const env = envOf(opts);
  const configured = String(raw == null ? "" : raw).trim();

  if (!configured) {
    if (key === "bridge") return bridgeBase(env);
    return BUILTINS[key] ? BUILTINS[key].baseUrl : "";
  }

  try {
    const url = new URL(configured);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/") {
      if (key === "groq" && url.hostname === "api.groq.com") {
        url.pathname = "/openai/v1";
      } else if (
        key === "gemini" &&
        url.hostname === "generativelanguage.googleapis.com"
      ) {
        url.pathname = "/v1beta";
      } else if (
        (key === "ollama" || key === "ollama_cloud") &&
        opts.dialect === "openai"
      ) {
        url.pathname = "/v1";
      } else if (key === "bridge") {
        url.pathname = "/v1";
      }
    }
    return url.toString().replace(/\/+$/, "");
  } catch (_) {
    // A non-URL value is passed through for the transport to reject with a
    // real error; silently inventing a host would hide the misconfiguration.
    return configured.replace(/\/+$/, "");
  }
}

/**
 * Minimal provider config used when a caller has only an id (no api.js
 * registry object). Same defaults as the full api.js entry.
 */
function builtinConfig(id, env) {
  const key = String(id || "").toLowerCase();
  const source = env || process.env;
  const base = BUILTINS[key];
  if (!base) return null;

  const prefix = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const dialect =
    key === "ollama"
      ? source.OLLAMA_DIALECT || ""
      : key === "ollama_cloud"
        ? source.OLLAMA_CLOUD_DIALECT || ""
        : "";
  const config = {
    id: key,
    name: base.name,
    type: source[prefix + "_TYPE"] || base.type,
    baseUrl: resolveBaseUrl(key, source[prefix + "_BASE"] || "", {
      env: source,
      dialect,
    }),
    key: source[prefix + "_API_KEY"] || "",
  };
  if (dialect) config.dialect = dialect;
  return config;
}

module.exports = {
  BUILTINS,
  builtinConfig,
  resolveBaseUrl,
};
