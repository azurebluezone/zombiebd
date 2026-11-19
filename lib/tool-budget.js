"use strict";

/**
 * lib/tool-budget.js - the ONE tool-catalog budget resolver.
 *
 * Every model call gets its tool catalog from here. No caller slices a tool
 * array on its own: this module owns the count, byte and prefill budgets, and
 * it is the only place that reads MCP_TOOL_BUDGET_*.
 *
 * Rules:
 *   1. limit = min(MCP_TOOL_BUDGET_MAX, provider maxTools).
 *   2. Tools listed in MCP_TOOL_BUDGET_PIN are always sent. More pinned tools
 *      than the limit allows is a boot error (CONFIG_FATAL).
 *   3. Pinned tools first, then intent/name score, deterministic name tie-break.
 *   4. bytes <= MCP_TOOL_BUDGET_MAX_BYTES and estPrefillMs <=
 *      min(timeoutMs * 0.5, MCP_TOOL_BUDGET_MAX_PREFILL_MS).
 *   5. The caller logs one TOOL_BUDGET record per model call.
 *   6. A provider can only lower the global ceiling, never raise it.
 */

const DEFAULTS = Object.freeze({
  MCP_TOOL_BUDGET_MAX: 24,
  MCP_TOOL_BUDGET_PIN: "tts__tts_speak,ocr__ocr_image",
  MCP_TOOL_BUDGET_STRATEGY: "intent",
  MCP_TOOL_BUDGET_MAX_BYTES: 12000,
  MCP_TOOL_BUDGET_MAX_PREFILL_MS: 45000,
  MCP_TOOL_PREFILL_TOKENS_PER_SEC: 30,
  PROVIDER_BRIDGE_MAX_TOOLS: 5,
  BYTES_PER_TOKEN: 4,
  DEFAULT_TIMEOUT_MS: 60000,
});

const STRATEGIES = new Set(["intent", "catalog"]);

function parseEnvInt(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return { present: false };
  const value = Number(raw);
  return { present: true, value, valid: Number.isFinite(value) };
}

function intEnv(name, fallback, min, max) {
  const parsed = parseEnvInt(name);
  if (!parsed.present || !parsed.valid) return fallback;
  const n = Math.floor(parsed.value);
  if (n < min || n > max) return fallback;
  return n;
}

function listEnv(name, fallback) {
  const raw = process.env[name];
  const source = raw === undefined || String(raw).trim() === "" ? fallback : raw;
  const seen = new Set();
  return String(source)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      if (!item || seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function strategyEnv() {
  const raw = String(process.env.MCP_TOOL_BUDGET_STRATEGY || "").toLowerCase();
  return STRATEGIES.has(raw) ? raw : DEFAULTS.MCP_TOOL_BUDGET_STRATEGY;
}

function config() {
  return {
    max: intEnv("MCP_TOOL_BUDGET_MAX", DEFAULTS.MCP_TOOL_BUDGET_MAX, 1, 128),
    pinned: listEnv("MCP_TOOL_BUDGET_PIN", DEFAULTS.MCP_TOOL_BUDGET_PIN),
    strategy: strategyEnv(),
    maxBytes: intEnv(
      "MCP_TOOL_BUDGET_MAX_BYTES",
      DEFAULTS.MCP_TOOL_BUDGET_MAX_BYTES,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    maxPrefillMs: intEnv(
      "MCP_TOOL_BUDGET_MAX_PREFILL_MS",
      DEFAULTS.MCP_TOOL_BUDGET_MAX_PREFILL_MS,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    tokensPerSec: intEnv(
      "MCP_TOOL_PREFILL_TOKENS_PER_SEC",
      DEFAULTS.MCP_TOOL_PREFILL_TOKENS_PER_SEC,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function bridgeMaxTools() {
  const primary = parseEnvInt("PROVIDER_BRIDGE_MAX_TOOLS");
  if (primary.present && primary.valid && primary.value >= 0) {
    return Math.floor(primary.value);
  }
  const legacy = parseEnvInt("BRIDGE_MAX_TOOLS");
  if (legacy.present && legacy.valid && legacy.value >= 0) {
    return Math.floor(legacy.value);
  }
  return DEFAULTS.PROVIDER_BRIDGE_MAX_TOOLS;
}

function normalizeProviderMax(value) {
  if (value === undefined || value === null || value === "") return Infinity;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return Infinity;
  return Math.floor(n);
}

/**
 * Effective maxTools declared by a provider config. A provider may either
 * put it top-level (custom_N) or inside capabilities (bridge). Anything else
 * means "no provider ceiling" and the global limit applies.
 */
function providerMaxOf(cfg) {
  if (!cfg || typeof cfg !== "object") return Infinity;
  const candidates = [cfg.capabilities && cfg.capabilities.maxTools, cfg.maxTools];
  for (const value of candidates) {
    if (value === undefined || value === null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return Infinity;
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (tool.function && typeof tool.function.name === "string") return tool.function.name;
  if (typeof tool.name === "string") return tool.name;
  return "";
}

function toolDescription(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (tool.function && typeof tool.function.description === "string") {
    return tool.function.description;
  }
  return typeof tool.description === "string" ? tool.description : "";
}

function toolBytes(tool) {
  try {
    return Buffer.byteLength(JSON.stringify(tool), "utf8");
  } catch (_) {
    return 0;
  }
}

function intentTerms(intent) {
  const words = String(intent || "")
    .toLowerCase()
    .match(/[a-z0-9_]{3,}/g);
  if (!words) return [];
  return Array.from(new Set(words)).slice(0, 40);
}

function scoreTool(tool, terms) {
  if (!terms.length) return 0;
  const name = toolName(tool).toLowerCase();
  const hay = name + " " + toolDescription(tool).toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (hay.indexOf(term) === -1) continue;
    score += 1;
    if (name.indexOf(term) !== -1) score += 1;
  }
  return score;
}

function orderTools(tools, cfg, intent) {
  const pinnedSet = new Set(cfg.pinned);
  const terms = cfg.strategy === "catalog" ? [] : intentTerms(intent);
  return tools
    .map((tool, index) => {
      const name = toolName(tool);
      return {
        tool,
        index,
        name,
        pinned: pinnedSet.has(name),
        score: scoreTool(tool, terms),
      };
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.tool);
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the tool catalog for one model call.
 *
 * @param {object} opts
 * @param {Array}  opts.tools       canonical OpenAI tools[]
 * @param {number} opts.providerMax effective provider maxTools (optional)
 * @param {number} opts.timeoutMs   provider timeout for this call (optional)
 * @param {string} opts.intent      user intent text for ranking (optional)
 * @returns {{tools: Array, limit: number, bytes: number, estTokens: number,
 *            estPrefillMs: number, dropped: number, pinned: number,
 *            providerMax: number, timeoutMs: number, prefillCapMs: number,
 *            strategy: string}}
 */
function resolveToolBudget(opts) {
  const options = opts || {};
  const cfg = config();
  const tools = Array.isArray(options.tools) ? options.tools.filter(Boolean) : [];
  const providerMax = normalizeProviderMax(options.providerMax);
  const limit = Math.min(cfg.max, providerMax);
  const timeoutMs = positiveNumber(options.timeoutMs, DEFAULTS.DEFAULT_TIMEOUT_MS);
  const prefillCapMs = Math.min(timeoutMs * 0.5, cfg.maxPrefillMs);
  const ordered = orderTools(tools, cfg, options.intent);
  const pinnedSet = new Set(cfg.pinned);

  const selected = [];
  let bytes = 0;
  let pinnedCount = 0;

  for (const tool of ordered) {
    const name = toolName(tool);
    const pinned = pinnedSet.has(name);
    if (pinned) pinnedCount += 1;
    if (!pinned && selected.length >= limit) continue;

    const nextBytes = bytes + toolBytes(tool);
    const nextTokens = Math.ceil(nextBytes / DEFAULTS.BYTES_PER_TOKEN);
    const nextPrefillMs = (nextTokens / cfg.tokensPerSec) * 1000;
    const fits = nextBytes <= cfg.maxBytes && nextPrefillMs <= prefillCapMs;

    // Pinned tools are mandatory. If a pin alone breaks a budget the config is
    // wrong; keep it so the model still gets the capability, and expose the
    // real bytes/prefill in the returned record.
    if (!pinned && !fits) continue;

    selected.push(tool);
    bytes = nextBytes;
  }

  const estTokens = Math.ceil(bytes / DEFAULTS.BYTES_PER_TOKEN);
  const estPrefillMs = Math.round((estTokens / cfg.tokensPerSec) * 1000);

  return {
    tools: selected,
    limit,
    bytes,
    estTokens,
    estPrefillMs,
    dropped: tools.length - selected.length,
    pinned: pinnedCount,
    providerMax,
    timeoutMs,
    prefillCapMs,
    strategy: cfg.strategy,
  };
}

/**
 * Hard cap used by the tool register. Preserves pinned tools and is a no-op
 * once resolveToolBudget() has already produced a fitting list.
 */
function capTools(tools, providerMax) {
  const cfg = config();
  const limit = Math.min(cfg.max, normalizeProviderMax(providerMax));
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) return list;
  const pinnedSet = new Set(cfg.pinned);
  const pinned = list.filter((tool) => pinnedSet.has(toolName(tool)));
  const floor = Math.max(limit, pinned.length);
  if (list.length <= floor) return list;
  const rest = list.filter((tool) => !pinnedSet.has(toolName(tool)));
  return pinned.concat(rest).slice(0, floor);
}

/** Same cap for a reporting list of tool names (never used for model calls). */
function rankNames(names, providerMax) {
  const cfg = config();
  const limit = Math.min(cfg.max, normalizeProviderMax(providerMax));
  const list = Array.isArray(names) ? names.map(String) : [];
  const pinnedSet = new Set(cfg.pinned);
  const pinned = list.filter((name) => pinnedSet.has(name));
  const rest = list.filter((name) => !pinnedSet.has(name));
  return pinned.concat(rest).slice(0, Math.max(limit, pinned.length));
}

function limitFor(providerMax) {
  return Math.min(config().max, normalizeProviderMax(providerMax));
}

/**
 * Boot gate. Invalid values or more pinned tools than the limit stop the
 * gateway with CONFIG_FATAL; api.js owns the exit so a library import never
 * kills a test process.
 */
function validateConfig() {
  const errors = [];
  const maxRaw = parseEnvInt("MCP_TOOL_BUDGET_MAX");
  if (maxRaw.present) {
    if (!maxRaw.valid) errors.push("MCP_TOOL_BUDGET_MAX is not a number");
    else if (maxRaw.value < 1 || maxRaw.value > 128) {
      errors.push("MCP_TOOL_BUDGET_MAX must be between 1 and 128");
    }
  }
  for (const name of [
    "MCP_TOOL_BUDGET_MAX_BYTES",
    "MCP_TOOL_BUDGET_MAX_PREFILL_MS",
    "MCP_TOOL_PREFILL_TOKENS_PER_SEC",
  ]) {
    const parsed = parseEnvInt(name);
    if (!parsed.present) continue;
    if (!parsed.valid) errors.push(name + " is not a number");
    else if (parsed.value < 1) errors.push(name + " must be >= 1");
  }
  const strategyRaw = process.env.MCP_TOOL_BUDGET_STRATEGY;
  if (strategyRaw && !STRATEGIES.has(String(strategyRaw).toLowerCase())) {
    errors.push("MCP_TOOL_BUDGET_STRATEGY must be intent or catalog");
  }
  const cfg = config();
  if (cfg.pinned.length > cfg.max) {
    errors.push(
      "MCP_TOOL_BUDGET_PIN lists " + cfg.pinned.length +
      " tools but MCP_TOOL_BUDGET_MAX is " + cfg.max,
    );
  }
  return { ok: errors.length === 0, errors, config: cfg };
}

module.exports = {
  DEFAULTS,
  config,
  bridgeMaxTools,
  providerMaxOf,
  resolveToolBudget,
  capTools,
  rankNames,
  limitFor,
  validateConfig,
  toolName,
  toolBytes,
};
