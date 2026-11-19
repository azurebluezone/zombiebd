"use strict";

/**
 * modules/provider-models.js — deterministic provider model lists.
 *
 * An env-declared model is a user promise, not a cache entry. A partial or
 * transient `/models` response must never delete it. A custom provider's env
 * list is a strict allowlist: live discovery may not expand it.
 *
 * The functions are pure so the merge rules can be tested without a provider
 * or a running gateway.
 */

function modelName(entry) {
  if (typeof entry === "string") return entry;
  return entry && typeof entry.name === "string" ? entry.name : "";
}

function apiModelName(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return entry.apiModel || entry.name || "";
}

function dedupeByName(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const name = modelName(entry);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(entry);
  }
  return out;
}

/**
 * Reconcile the current list with a live `/models` response.
 *
 * - envModels are always kept, even when the live response omits them.
 * - `strict` means envModels is the whole answer; live models are not added.
 * - non-strict keeps env rows, drops stale non-env rows, appends new live ones.
 */
function reconcileModels(current, live, options) {
  const opts = options || {};
  const envModels = Array.isArray(opts.envModels) ? opts.envModels : [];
  const strict = opts.strict === true;
  if (strict && envModels.length > 0) return envModels.slice();

  const liveSet = new Set((live || []).filter(Boolean));
  const envApi = new Set(envModels.map(apiModelName).filter(Boolean));
  const kept = (current || []).filter((entry) => {
    const api = apiModelName(entry);
    return api === "*" || liveSet.has(api) || envApi.has(api);
  });
  const merged = dedupeByName(kept);
  const seen = new Set(merged.map(modelName));
  for (const name of live || []) {
    if (!name || name === "*" || seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
}

/**
 * A dynamic provider can start or stop while the gateway runs. Keep the env
 * list first; append live models that are not already named there. With no
 * env list the live response is the list (deduplicated).
 */
function mergeDynamicModels(live, envModels) {
  const env = Array.isArray(envModels) ? envModels : [];
  const base = dedupeByName(env);
  if (base.length === 0) return dedupeByName((live || []).filter(Boolean));
  const seen = new Set(base.map(modelName));
  for (const name of live || []) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    base.push(name);
  }
  return base;
}

/**
 * DB rows are a cache of an earlier discovery. Keep env rows first and append
 * cached rows that are not already named.
 */
function mergeDbModels(envModels, dbModels) {
  return mergeDynamicModels(dbModels, envModels);
}

module.exports = {
  modelName,
  apiModelName,
  reconcileModels,
  mergeDynamicModels,
  mergeDbModels,
};
