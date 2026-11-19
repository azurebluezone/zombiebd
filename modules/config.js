"use strict";

// One lookup order for every runtime setting: DB, env, then a loud error.
// The .env file itself is read by lib/env.js (loadProcessEnv); this module
// only resolves keys that are already in process.env or the database.

const BOOLEAN_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE = new Set(["0", "false", "no", "off"]);

class ConfigError extends Error {
  constructor(key, detail) {
    super(
      'Missing configuration "' +
        key +
        '": checked the database settings table, then the environment.' +
        (detail ? " " + detail : ""),
    );
    this.name = "ConfigError";
    this.code = "ZC_CONFIG_MISSING";
    this.key = key;
  }
}

function clean(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/**
 * Read one key from the settings KV table.
 * A missing table is treated as "not configured", never as a crash: an old
 * database must not stop the gateway from reading env values.
 */
function readSettingRow(db, key) {
  if (!db || typeof db.prepare !== "function") return undefined;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return undefined;
    return clean(row.value);
  } catch (_) {
    return undefined;
  }
}

/**
 * Resolve one setting without guessing.
 * @param {string} key
 * @param {{db?: object, env?: object, allowEmpty?: boolean}} [opts]
 * @returns {{key: string, value: string, source: "db"|"env"|"empty"}}
 */
function resolveSetting(key, opts) {
  const o = opts || {};
  const name = clean(key);
  if (!name) {
    throw new ConfigError("<empty>", "The setting key itself is empty.");
  }
  const env = o.env || process.env;

  const fromDb = readSettingRow(o.db, name);
  if (fromDb !== undefined) return { key: name, value: fromDb, source: "db" };

  const fromEnv = clean(env[name]);
  if (fromEnv !== undefined) return { key: name, value: fromEnv, source: "env" };

  if (o.allowEmpty) return { key: name, value: "", source: "empty" };
  throw new ConfigError(name);
}

/** Resolve one setting and return only its value. */
function requireSetting(key, opts) {
  return resolveSetting(key, opts).value;
}

/** Integer resolver with an explicit range check. */
function resolveInt(key, opts) {
  const o = opts || {};
  const resolved = resolveSetting(key, o);
  const value = Number(resolved.value);
  const min = Number.isFinite(o.min) ? o.min : Number.MIN_SAFE_INTEGER;
  const max = Number.isFinite(o.max) ? o.max : Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < min || value > max) {
    const err = new ConfigError(
      resolved.key,
      'Value "' +
        resolved.value +
        '" from ' +
        resolved.source +
        " is not an integer in [" +
        min +
        ", " +
        max +
        "].",
    );
    err.code = "ZC_CONFIG_INVALID";
    throw err;
  }
  return { key: resolved.key, value, source: resolved.source };
}

/** TCP/UDP port resolver: 1..65535. */
function resolvePort(key, opts) {
  return resolveInt(key, Object.assign({ min: 1, max: 65535 }, opts || {}));
}

/** Boolean resolver: 1/0, true/false, yes/no, on/off. */
function resolveBool(key, opts) {
  const resolved = resolveSetting(key, opts);
  const lowered = resolved.value.toLowerCase();
  if (BOOLEAN_TRUE.has(lowered)) {
    return { key: resolved.key, value: true, source: resolved.source };
  }
  if (BOOLEAN_FALSE.has(lowered)) {
    return { key: resolved.key, value: false, source: resolved.source };
  }
  const err = new ConfigError(
    resolved.key,
    'Value "' + resolved.value + '" from ' + resolved.source + " is not a boolean.",
  );
  err.code = "ZC_CONFIG_INVALID";
  throw err;
}

/** JSON resolver for settings stored as text (DB) or env strings. */
function resolveJson(key, opts) {
  const resolved = resolveSetting(key, opts);
  try {
    return { key: resolved.key, value: JSON.parse(resolved.value), source: resolved.source };
  } catch (e) {
    const err = new ConfigError(
      resolved.key,
      "Value from " + resolved.source + " is not valid JSON: " + e.message,
    );
    err.code = "ZC_CONFIG_INVALID";
    throw err;
  }
}

module.exports = {
  ConfigError,
  resolveSetting,
  requireSetting,
  resolveInt,
  resolvePort,
  resolveBool,
  resolveJson,
};
