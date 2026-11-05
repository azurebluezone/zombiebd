#!/usr/bin/env node
/**
 * sync-agents.js — Load agent/*.js personas into the SQLite agents table
 * ═══════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *   api.js:3114 reads `persona` from the agents table and — because the DB
 *   row is pushed to `merged` BEFORE agent/*.js is read, and the file loop
 *   guards with `!seen.has(a.id)` — the DB stub (24-206 chars) always wins.
 *   The real persona in agent/*.js (260-1935 chars) is loaded but discarded.
 *
 *   This script closes that gap at the source: the DB gets the full persona,
 *   so whichever branch reads it later gets the right text.
 *
 * WHAT IT DOES
 *   1. Reads every agent/*.js through the project's own loader (same code
 *      path api.js uses — no parallel parsing that can drift).
 *   2. Writes id, name, role, expertise, persona, priority, enabled.
 *   3. Leaves `model` ALONE. agent/*.js sets model:"MODELS_DB" (a sentinel),
 *      and the live value comes from the admin panel / provider DB. Overwriting
 *      it here would destroy operator choices.
 *   4. Backups the DB first. --dry-run is the default.
 *
 * USAGE
 *   node tools/sync-agents.js            # report only
 *   node tools/sync-agents.js --write    # actually update
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const { loadAgentFiles } = require("../agent");

const WRITE = process.argv.includes("--write");
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = process.env.DB_SQLITE_PATH
  ? path.resolve(process.cwd(), process.env.DB_SQLITE_PATH)
  : path.join(ROOT, "data", "models.db");

const log = (...a) => console.log("[sync-agents]", ...a);

if (!fs.existsSync(DB_PATH)) {
  console.error("[sync-agents] DB not found:", DB_PATH);
  process.exit(1);
}

// ── Backup before any write ─────────────────────────────────────────────────
if (WRITE) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${DB_PATH}.bak-agents-${stamp}`;
  fs.copyFileSync(DB_PATH, bak);
  log(`DB backup -> ${bak}`);
}

// ── Column discovery: never assume the schema still matches an old build ────
const db = new DatabaseSync(DB_PATH);
const cols = db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);

if (!cols.includes("agents") && !cols.includes("id")) {
  console.error("[sync-agents] `agents` table not found in", DB_PATH);
  process.exit(1);
}
log(`agents table columns: ${cols.join(", ")}`);

const before = new Map(
  db.prepare("SELECT id, name, role, expertise, persona, priority FROM agents").all().map((r) => [r.id, r]),
);

const fileAgents = loadAgentFiles();
if (!fileAgents.length) {
  console.error("[sync-agents] no agents loaded from agent/*.js — aborting");
  process.exit(1);
}

const upsert = db.prepare(`
  INSERT INTO agents (id, name, role, expertise, persona, priority, enabled, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name       = excluded.name,
    role       = excluded.role,
    expertise  = excluded.expertise,
    persona    = excluded.persona,
    priority   = excluded.priority,
    enabled    = excluded.enabled,
    updated_at = excluded.updated_at
`);

let changed = 0,
  same = 0,
  inserted = 0;
// Counters that also move in dry-run, so "would change N" is accurate.
let pendingUpdate = 0,
  pendingInsert = 0;

console.log("");
console.log("  agent".padEnd(34) + "persona chars".padEnd(16) + "verdict");
console.log("  " + "─".repeat(66));

for (const a of fileAgents) {
  const prev = before.get(a.id);
  const persona = (a.persona || "").trim();

  if (!persona) {
    log(`skip ${a.id}: empty persona`);
    continue;
  }

  let verdict;
  if (!prev) {
    verdict = "INSERT (was missing)";
    pendingInsert++;
    if (WRITE) {
      upsert.run(a.id, a.name || a.id, a.role || "general", a.expertise || "", persona, a.priority ?? 99, a.enabled ?? 1);
      inserted++;
    }
  } else if ((prev.persona || "").trim() === persona && prev.name === (a.name || a.id) && prev.role === (a.role || "general")) {
    verdict = "already in sync";
    same++;
    continue;
  } else {
    const grew = persona.length - (prev.persona || "").length;
    verdict = `UPDATE (persona ${grew >= 0 ? "+" : ""}${grew} chars)`;
    // Count intent regardless of --write, so the dry-run summary is truthful.
    pendingUpdate++;
    if (WRITE) {
      upsert.run(a.id, a.name || a.id, a.role || "general", a.expertise || "", persona, a.priority ?? 99, a.enabled ?? 1);
      changed++;
    }
  }

  console.log(
    "  " +
      a.id.padEnd(34) +
      `${(prev?.persona || "(none)").length}→${persona.length}`.padEnd(16) +
      verdict,
  );
}

console.log("");
log(
  WRITE
    ? `done — ${changed} updated, ${inserted} inserted, ${same} already in sync`
    : `dry run — ${pendingUpdate} would be updated, ${pendingInsert} would be inserted, ${same} already in sync`,
);
if (!WRITE) log("pass --write to apply (DB is untouched right now)");

db.close();