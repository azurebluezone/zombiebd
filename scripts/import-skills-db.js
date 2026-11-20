#!/usr/bin/env node
"use strict";

// =============================================================================
// scripts/import-skills-db.js — one-time copy of the skill SQLite data
// =============================================================================
// The experiment project at the --source path is NOT a runtime dependency.
// This script copies only its SQLite database into this repository; every
// later read (CLI, MCP server, agents) resolves skills/skills.db locally.
//
// Run once:
//   node scripts/import-skills-db.js --source /path/to/experiment/skills.db
// Re-import:
//   node scripts/import-skills-db.js --source ... --force
// =============================================================================

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

const source = arg("source", "");
const out = path.resolve(arg("out", path.join(ROOT, "skills", "skills.db")));
const force = process.argv.includes("--force");

if (!source) {
  console.error("SKILLS_DB_IMPORT_FAIL --source is required");
  process.exit(2);
}
if (!fs.existsSync(source)) {
  console.error("SKILLS_DB_IMPORT_FAIL source not found: " + source);
  process.exit(2);
}
if (path.resolve(source) === out) {
  console.error("SKILLS_DB_IMPORT_FAIL source and out are the same file");
  process.exit(2);
}
if (fs.existsSync(out) && !force) {
  console.error("SKILLS_DB_IMPORT_FAIL out exists (use --force): " + out);
  process.exit(2);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
if (fs.existsSync(out)) fs.unlinkSync(out);

const src = new DatabaseSync(source, { readOnly: true });
try {
  // VACUUM INTO writes a clean copy with no WAL/journal side files.
  src.exec("VACUUM INTO '" + out.replace(/'/g, "''") + "'");
} finally {
  src.close();
}

const db = new DatabaseSync(out, { readOnly: true });
try {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  for (const required of ["skills", "skill_terms", "skill_sources"]) {
    if (!tables.has(required)) {
      throw new Error("missing table: " + required);
    }
  }
  const active = db.prepare("SELECT COUNT(*) AS n FROM skills WHERE active = 1").get().n;
  const terms = db.prepare("SELECT COUNT(*) AS n FROM skill_terms").get().n;
  if (active < 1 || terms < 100) {
    throw new Error("copy looks empty: active=" + active + " terms=" + terms);
  }
  console.log(
    "SKILLS_DB_IMPORTED active=" + active + " terms=" + terms + " bytes=" + fs.statSync(out).size,
  );
  console.log("SKILLS_DB_PATH " + out);
} catch (err) {
  console.error("SKILLS_DB_IMPORT_FAIL " + err.message);
  process.exit(1);
} finally {
  db.close();
}
