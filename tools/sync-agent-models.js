#!/usr/bin/env node
/**
 * sync-agent-models.js — validate & repair agent → model mappings
 * ═══════════════════════════════════════════════════════════════════════
 * WHY
 *   Every agent row pointed at a model id that exists on NO configured
 *   provider:
 *       code-guru  → llama-local      (no such model anywhere)
 *       bug-hunter → llama3.1:8b      (not in any provider list)
 *       doc-king   → mistral-small:free (absent from the synced catalog)
 *
 *   resolveProvider() therefore failed to match them, and routing silently
 *   fell through to getDefaultModel(). The agent answered — with a model
 *   nobody asked for. That is the "swimming blind" failure: a working
 *   response from the wrong model.
 *
 * WHAT IT DOES
 *   1. Reads the live provider model lists (same source resolveProvider uses).
 *   2. Marks each agent's model VALID / MISSING.
 *   3. For missing ones, proposes a replacement by ROLE affinity
 *      (debugging → code models, documentation → long-context models, …),
 *      choosing only from models a provider actually serves.
 *   4. Applies with --write. DB is backed up first. Dry run is the default.
 *
 * No hardcoded model names: the candidates come from the live catalog.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DB_SQLITE_PATH
  ? path.resolve(process.cwd(), process.env.DB_SQLITE_PATH)
  : path.join(ROOT, "data", "models.db");
const WRITE = process.argv.includes("--write");

const log = (...a) => console.log("[agent-models]", ...a);

// ─── Load .env the same way api.js does (no dotenv dependency) ──────────────
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^=+$/.test(t)) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    if (!k || process.env[k]) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

// ─── Rebuild the set of models providers actually serve ─────────────────────
// Mirrors api.js loadCustomProviders() + PROVIDER_CONFIG, including the
// "publicName:apiModel" syntax that parseModelsEnv() (api.js:823) splits on
// the FIRST colon. Treating the raw string as a model id produced invented
// ids like "gemini-flash:gemini-3.6-flash" — hence the shared parser.
function parseModelsEnv(str) {
  if (!str || !str.trim()) return [];
  return String(str)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx > 0) {
        return { name: entry.slice(0, idx).trim(), apiModel: entry.slice(idx + 1).trim() };
      }
      return entry;
    });
}

/**
 * @returns Map<publicName, { apiModel, providers:Set<string> }>
 * The provider set matters: `qwen2.5:7b` is served by Colab-GPU, not by the
 * local Ollama, so assigning it to a local role would break at call time.
 */
function liveModels() {
  const map = new Map();

  const absorb = (entry, providerId) => {
    if (typeof entry === "string") {
      if (entry && entry !== "*") {
        if (!map.has(entry)) map.set(entry, { apiModel: entry, providers: new Set() });
        map.get(entry).providers.add(providerId);
      }
    } else if (entry && entry.name) {
      if (!map.has(entry.name)) map.set(entry.name, { apiModel: entry.apiModel || entry.name, providers: new Set() });
      map.get(entry.name).providers.add(providerId);
    }
  };

  for (const [key, val] of Object.entries(process.env)) {
    const std = /^(OLLAMA|GROQ|GEMINI|OPENCODE)_MODELS$/.exec(key);
    if (std) {
      parseModelsEnv(val).forEach((e) => absorb(e, std[1].toLowerCase()));
    }
    const cp = /^CUSTOM_PROVIDER_(\d+)_ENABLED$/.exec(key);
    if (cp) {
      if (String(val).toLowerCase() === "false") continue;
      const n = cp[1];
      const pid = `custom_${n}`;
      parseModelsEnv(process.env[`CUSTOM_PROVIDER_${n}_MODELS`] || "").forEach((e) => absorb(e, pid));
    }
  }

  // The synced SQLite catalog is authoritative for what a provider actually
  // reported, so accept both its public name and its raw api_model.
  if (fs.existsSync(DB_PATH)) {
    try {
      const db = new DatabaseSync(DB_PATH, { readOnly: true });
      for (const r of db
        .prepare("SELECT name, api_model, provider FROM models WHERE enabled = 1")
        .all()) {
        const prov = String(r.provider || "unknown").toLowerCase();
        if (r.name && !map.has(r.name)) map.set(r.name, { apiModel: r.api_model || r.name, providers: new Set([prov]) });
        else if (r.name) map.get(r.name).providers.add(prov);
        if (r.api_model && !map.has(r.api_model)) map.set(r.api_model, { apiModel: r.api_model, providers: new Set([prov]) });
      }
      db.close();
    } catch (_) {}
  }
  return map;
}

/**
 * Role affinity. Keys are agent roles; values describe what a good model
 * for that role looks like. Scored against the live catalog — no model id
 * is written here, only the criteria used to pick one.
 */
const AFFINITY = {
  debugging:      [/qwen/i, /deepseek/i, /gpt-oss/i, /codestral/i],
  architecture:   [/qwen/i, /gpt-oss/i, /mistral/i, /deepseek/i],
  performance:    [/nemotron/i, /gpt-oss/i, /flash/i],
  documentation:  [/mistral/i, /flash/i, /gemini/i, /qwen/i],
  quality:        [/glm/i, /flash/i, /qwen/i, /gpt-oss/i],
  security:       [/north-mini/i, /glm/i, /qwen/i, /gpt-oss/i],
  general:        [/qwen/i, /flash/i, /mistral/i],
  "customer-experience": [/flash/i, /gemini/i, /mistral/i, /qwen/i],
  "ecommerce-operations": [/flash/i, /gemini/i, /mistral/i, /qwen/i],
};

/** Models served by the local Ollama never hit a rate limit — prefer them. */
function isLocal(model, catalog) {
  const info = catalog.get(model);
  return !!info && [...info.providers].some((pr) => pr === "ollama");
}

/**
 * Returns the PUBLIC model name for a role. `used` is threaded through so
 * different agents get different models instead of everyone collapsing onto
 * the first regex match — variety also spreads provider rate-limit load.
 */
function pickForRole(role, catalog, exclude, used = new Set()) {
  const prefs = AFFINITY[role] || AFFINITY.general;
  const pool = [...catalog.keys()].filter((m) => m !== exclude);
  const rank = (m) => (isLocal(m, catalog) ? 0 : 1);   // local first
  const ordered = [...pool].sort((x, y) => rank(x) - rank(y));
  for (const rx of prefs) {
    const hits = ordered.filter((m) => rx.test(m));
    const fresh = hits.find((m) => !used.has(m));
    if (fresh) return fresh;
    if (hits.length) return hits[0];   // role pool exhausted — reuse is fine
  }
  const anyFresh = ordered.find((m) => !used.has(m));
  return anyFresh || ordered[0] || null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  console.error("[agent-models] DB not found:", DB_PATH);
  process.exit(1);
}

const catalog = liveModels();
log(`live model catalog: ${catalog.size} models (public name → api model)`);

if (WRITE) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(DB_PATH, `${DB_PATH}.bak-models-${stamp}`);
  log(`DB backup -> ${DB_PATH}.bak-models-${stamp}`);
}

const db = new DatabaseSync(DB_PATH);
const agents = db.prepare("SELECT id, role, model FROM agents ORDER BY priority ASC").all();

const upd = db.prepare("UPDATE agents SET model = ?, updated_at = datetime('now') WHERE id = ?");

console.log("");
console.log("  agent".padEnd(34) + "current".padEnd(26) + "verdict");
console.log("  " + "─".repeat(78));

let fixed = 0, valid = 0, unfixable = 0;
const used = new Set();

for (const a of agents) {
  const ok = catalog.has(a.model);
  if (ok) {
    console.log("  " + a.id.padEnd(34) + a.model.slice(0, 24).padEnd(26) + "✅ valid");
    used.add(a.model);
    valid++;
    continue;
  }
  const suggestion = pickForRole(a.role, catalog, a.model, used);
  if (!suggestion) {
    console.log("  " + a.id.padEnd(34) + a.model.slice(0, 24).padEnd(26) + "❌ missing (no candidate)");
    unfixable++;
    continue;
  }
  console.log(
    "  " + a.id.padEnd(34) +
    a.model.slice(0, 24).padEnd(26) +
    `🔧 → ${suggestion}  [${[...(catalog.get(suggestion)?.providers || [])].join(",")}]  (${a.role})`,
  );
  // Reserve regardless of --write so the dry run shows the same variety the
  // real run would produce.
  used.add(suggestion);
  if (WRITE) upd.run(suggestion, a.id);
  fixed++;
}

console.log("");
log(
  WRITE
    ? `done — ${fixed} remapped, ${valid} already valid, ${unfixable} unfixable`
    : `dry run — ${fixed} would be remapped, ${valid} already valid, ${unfixable} unfixable`,
);
if (!WRITE) log("pass --write to apply (DB untouched right now)");

db.close();