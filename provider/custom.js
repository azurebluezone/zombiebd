"use strict";

/**
 * provider/custom.js — one resolver for CUSTOM_PROVIDER_<N>_* env seeds.
 *
 * A custom provider is ALWAYS OpenAI-compatible. N is any positive integer;
 * there is no list and no cap here. This module is the only place that maps
 * env names to a custom provider, so api.js (full registry entry) and
 * provider/index.js (standalone dispatch) cannot disagree about an id,
 * endpoint or dialect.
 *
 * DB rows are loaded by api.js on top of this env seed; env only seeds the
 * first default, the database owns the rest.
 */

const { expandEnv } = require("../lib/expand-env.js");

const ENV_KEY = /^CUSTOM_PROVIDER_(\d+)_([A-Za-z0-9_]+)$/;
const CUSTOM_ID = /^custom_(\d+)$/i;

function customNumber(id) {
  const m = CUSTOM_ID.exec(String(id == null ? "" : id));
  return m ? m[1] : null;
}

function isCustomId(id) {
  return customNumber(id) !== null;
}

function customNumberFromEnvKey(key) {
  const m = ENV_KEY.exec(String(key || ""));
  return m ? m[1] : null;
}

/**
 * All numeric custom provider ids present in the environment, in numeric
 * order. No cap: the loop reads every KEY the process actually has.
 */
function listCustomNumbers(env) {
  const source = env || process.env;
  const numbers = new Set();
  for (const key of Object.keys(source)) {
    const n = customNumberFromEnvKey(key);
    if (n !== null) numbers.add(n);
  }
  return [...numbers].sort(
    (a, b) => a.length - b.length || a.localeCompare(b),
  );
}

function read(n, name, env) {
  return (env || process.env)["CUSTOM_PROVIDER_" + n + "_" + name] || "";
}

function expanded(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  // expandEnv loads .env lazily; only strings that actually reference a
  // variable pay that cost, and a plain value can never be rewritten.
  return raw.includes("${") ? expandEnv(raw).trim() : raw;
}

function enabledFromEnv(id, env) {
  const n = customNumber(id) || String(id || "");
  return String(read(n, "ENABLED", env) || "true").toLowerCase() !== "false";
}

/**
 * The configured dialect for a custom id. The answer is always "openai";
 * this helper exists so callers can warn when the env asked for a native
 * dialect that custom_N ids do not support.
 */
function requestedType(id, env) {
  const n = customNumber(id) || String(id || "");
  const type = String(read(n, "TYPE", env) || "").trim().toLowerCase();
  return type && type !== "openai" ? type : "";
}

/**
 * Build the custom provider config from env. Returns null when neither URL
 * nor SOCKET is set (the provider does not exist), matching the old loader.
 * `enabled` is reported, not enforced, so provider/index.js can still resolve
 * a disabled id for diagnostics.
 */
function fromEnv(id, env) {
  const n = customNumber(id) || String(id || "");
  if (!/^\d+$/.test(n)) return null;

  const source = env || process.env;
  const url = expanded(read(n, "URL", source));
  const socketPath = expanded(read(n, "SOCKET", source));
  if (!url && !socketPath) return null;

  const apiKey = read(n, "KEY", source);
  const models = String(read(n, "MODELS", source) || "").trim();
  const priority = parseInt(read(n, "PRIORITY", source) || "10", 10);
  const timeout = parseInt(read(n, "TIMEOUT_MS", source) || "", 10);
  const streamTimeout = parseInt(read(n, "STREAM_TIMEOUT_MS", source) || "", 10);
  const maxPromptChars = parseInt(read(n, "MAX_PROMPT_CHARS", source) || "", 10);
  const maxTools = parseInt(read(n, "MAX_TOOLS", source) || "", 10);
  const contextWindow = parseInt(read(n, "CONTEXT_WINDOW", source) || "", 10);
  const media = String(read(n, "MEDIA", source) || "").toLowerCase() === "true";

  return Object.assign(
    {
      id: "custom_" + n,
      name: read(n, "NAME", source) || "Custom-" + n,
      baseUrl: url || "http://localhost",
      socketPath,
      key: apiKey,
      envKey: apiKey,
      keySource: apiKey ? "env" : "none",
      source: "env",
      priority: Number.isFinite(priority) ? priority : 10,
      type: "openai",
      adapter: "openai",
      modelsStr: models,
      enabled: enabledFromEnv(n, source),
      custom: true,
      ...(media ? { media: true } : {}),
    },
    Number.isFinite(timeout) && timeout > 0 ? { timeout } : {},
    Number.isFinite(streamTimeout) && streamTimeout > 0 ? { streamTimeout } : {},
    Number.isFinite(maxPromptChars) && maxPromptChars > 0
      ? { maxPromptChars }
      : {},
    Number.isFinite(maxTools) && maxTools >= 0 ? { maxTools } : {},
    Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {},
  );
}

module.exports = {
  CUSTOM_ID,
  ENV_KEY,
  customNumber,
  customNumberFromEnvKey,
  isCustomId,
  listCustomNumbers,
  enabledFromEnv,
  requestedType,
  fromEnv,
};
