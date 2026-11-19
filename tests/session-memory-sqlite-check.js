#!/usr/bin/env node
"use strict";

/*
 * Project memory → SQLite acceptance check.
 *
 * What it proves (real files, real SQLite, no mocks):
 *   1. modules/project-memory.js migrates legacy ctx_*.json archives once.
 *   2. A new archive writes ONE SQLite row, not a new ctx_*.json file.
 *   3. memory state (recent_context / session_index) lives in SQLite and does
 *      not rewrite .zombiecoder/agents/memory.json.
 *   4. recent() and search() read the SQLite rows.
 *   5. The live gateway DB uses WAL and exposes the project_memory tables.
 *   6. The live project's legacy archives were imported into that DB.
 *
 * The JSON session memory (.zombiecoder/memory/ses_*.jsonl) and the per-session
 * data/mem-*.json files are intentionally NOT touched.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "memory-sqlite-check-" + process.pid);
const DB_PATH = path.join(TMP, "memory.db");
const PROJECT = path.join(TMP, "project");
const AGENTS_DIR = path.join(PROJECT, ".zombiecoder", "agents");
const SESSIONS_DIR = path.join(AGENTS_DIR, "sessions");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function seedLegacyArchive(file, seq, summary, keyword) {
  const archive = {
    session_id: "ctx_20260101_" + String(seq).padStart(3, "0"),
    created_at: "2026-01-01T00:0" + seq + ":00.000Z",
    message_count: 2,
    summary,
    key_points: [keyword],
    decisions: [],
    files_changed: [],
    tags: [keyword.toLowerCase()],
    prev_session: null,
    next_session: null,
  };
  fs.writeFileSync(file, JSON.stringify(archive, null, 2));
  return archive;
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const legacy1 = seedLegacyArchive(
  path.join(SESSIONS_DIR, "ctx_20260101_001.json"),
  1,
  "Legacy project memory one SQLITE_LEGACY_ONE",
  "SQLITE_LEGACY_ONE",
);
seedLegacyArchive(
  path.join(SESSIONS_DIR, "ctx_20260101_002.json"),
  2,
  "Legacy project memory two SQLITE_LEGACY_TWO",
  "SQLITE_LEGACY_TWO",
);
// A truncated archive (real data loss) must be skipped, not crash the import.
fs.writeFileSync(
  path.join(SESSIONS_DIR, "ctx_20260101_003.json"),
  '{"session_id":"ctx_truncated","summary":"half a fi',
);
fs.writeFileSync(
  path.join(AGENTS_DIR, "memory.json"),
  JSON.stringify({
    current_session: { id: null, started_at: null, message_count: 0, summary: null },
    recent_context: [
      {
        session_id: legacy1.session_id,
        summary: legacy1.summary,
        timestamp: legacy1.created_at,
        agent_count: 0,
        tags: legacy1.tags,
      },
    ],
    session_index: { last_accessed: legacy1.created_at, total_sessions: 2, total_archived: 2 },
  }),
);

// ── 1. Module contract ──────────────────────────────────────
let createProjectMemory = null;
try {
  ({ createProjectMemory } = require(path.join(ROOT, "modules", "project-memory.js")));
} catch (e) {
  console.log("FAIL module — modules/project-memory.js is missing: " + e.message);
}
check("module exports createProjectMemory", typeof createProjectMemory === "function");

if (typeof createProjectMemory !== "function") {
  console.log("\nRESULT: MEMORY_SQLITE_FAIL module missing");
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
let store = null;
try {
  store = createProjectMemory({ db });
} catch (e) {
  console.log("FAIL store — createProjectMemory threw: " + e.message);
}
check("store created", !!store);

if (!store) {
  console.log("\nRESULT: MEMORY_SQLITE_FAIL store not created");
  process.exit(1);
}

// ── 2. WAL ─────────────────────────────────────────────────
const mode = db.prepare("PRAGMA journal_mode").get().journal_mode;
check("sqlite journal_mode is wal", String(mode).toLowerCase() === "wal", String(mode));

// ── 3. Legacy migration ────────────────────────────────────
// Snapshot the fixture before the one-time import: the migration imports then
// purges legacy files, so reading it afterwards would always be ENOENT.
const memoryJsonBefore = fs.readFileSync(path.join(AGENTS_DIR, "memory.json"), "utf8");
const migrated = store.migrateFromFiles(PROJECT);
check(
  "legacy ctx archives imported",
  migrated && migrated.imported === 2,
  JSON.stringify(migrated),
);
const migratedAgain = store.migrateFromFiles(PROJECT);
check(
  "migration is idempotent (no duplicate import)",
  migratedAgain && migratedAgain.imported === 0,
  JSON.stringify(migratedAgain),
);
check(
  "truncated legacy archive is skipped, not fatal",
  migrated.files === 3 && migrated.skipped === 1 && migrated.imported === 2,
  JSON.stringify(migrated),
);

const stateAfterMigration = store.readState(PROJECT);
check(
  "legacy recent_context migrated into state",
  Array.isArray(stateAfterMigration.recent_context) &&
    stateAfterMigration.recent_context.length === 2,
  String((stateAfterMigration.recent_context || []).length),
);

// ── 4. New archive writes SQLite, not a file ───────────────
const filesBefore = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).length;
check(
  "migration purged the legacy memory.json after import",
  memoryJsonBefore.length > 0 && !fs.existsSync(path.join(AGENTS_DIR, "memory.json")),
);
const archiveId = store.archive(
  PROJECT,
  "sess-sqlite-check",
  [
    { role: "user", content: "remember SQLITE_ARCHIVE_MARKER" },
    { role: "assistant", content: "stored" },
  ],
  "New project memory SQLITE_ARCHIVE_MARKER",
  { tags: ["sqlite", "memory"] },
);
const filesAfter = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).length;
check("archive returns an id", typeof archiveId === "string" && archiveId.length > 0, archiveId);
check(
  "archive created no new ctx json file",
  filesAfter === filesBefore,
  filesBefore + " → " + filesAfter,
);

const rowCount = db
  .prepare("SELECT COUNT(*) c FROM project_memory WHERE project_dir = ?")
  .get(PROJECT).c;
check("archive row exists in sqlite", rowCount === 3, "rows=" + rowCount);

check(
  "archive did not recreate legacy memory.json",
  !fs.existsSync(path.join(AGENTS_DIR, "memory.json")),
);

// ── 5. Reads come from SQLite ───────────────────────────────
const recent = store.recent(PROJECT, 5);
check(
  "recent() reads sqlite rows",
  Array.isArray(recent) && recent.length === 3,
  "rows=" + (recent || []).length,
);
check(
  "recent() is newest first",
  recent.length > 0 && recent[0].summary.includes("SQLITE_ARCHIVE_MARKER"),
  recent.length ? recent[0].summary : "",
);
const found = store.search(PROJECT, "SQLITE_ARCHIVE_MARKER");
check("search() finds the sqlite row", Array.isArray(found) && found.length >= 1, JSON.stringify(found));

const state = store.readState(PROJECT);
check(
  "state recent_context includes new archive",
  state.recent_context.some((c) => String(c.summary || "").includes("SQLITE_ARCHIVE_MARKER")),
);
check(
  "state session_index counted archives",
  state.session_index && state.session_index.total_sessions === 3,
  JSON.stringify(state.session_index),
);

store.writeState(PROJECT, {
  current_session: {
    id: "sess-sqlite-check",
    started_at: null,
    message_count: 1,
    summary: "x",
  },
  recent_context: [],
  session_index: {
    last_accessed: new Date().toISOString(),
    total_sessions: 3,
    total_archived: 3,
  },
});
const roundTrip = store.readState(PROJECT);
check("writeState() persists in sqlite", roundTrip.current_session.id === "sess-sqlite-check");

// ── 6. Live gateway DB (integration) ───────────────────────
const LIVE_DB = path.resolve(ROOT, process.env.DB_SQLITE_PATH || "data/models.db");
let live = null;
try {
  live = new DatabaseSync(LIVE_DB, { readOnly: true });
} catch (e) {
  console.log("FAIL live db open — " + e.message);
}
if (live) {
  const liveMode = String(
    live.prepare("PRAGMA journal_mode").get().journal_mode || "",
  ).toLowerCase();
  check("live gateway DB uses wal", liveMode === "wal", liveMode);
  const tables = live
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  check("live DB has project_memory table", tables.includes("project_memory"), tables.join(","));
  check("live DB has project_memory_state table", tables.includes("project_memory_state"));
  check("live DB has project_memory_meta table", tables.includes("project_memory_meta"));

  const liveProject = ROOT;
  let imported = 0;
  let liveRows = 0;
  try {
    imported =
      live
        .prepare("SELECT legacy_files FROM project_memory_meta WHERE project_dir = ?")
        .get(liveProject)?.legacy_files || 0;
    liveRows = live
      .prepare("SELECT COUNT(*) c FROM project_memory WHERE project_dir = ?")
      .get(liveProject).c;
  } catch (e) {
    console.log("FAIL live db query — " + e.message);
  }

  // Count the parseable, unique legacy archives independently. Corrupt or
  // duplicate files are expected to be skipped by the importer, so they must
  // not inflate the expected row count.
  let validLegacy = 0;
  try {
    const liveSessions = path.join(ROOT, ".zombiecoder", "agents", "sessions");
    const ids = new Set();
    for (const f of fs.readdirSync(liveSessions)) {
      if (!f.startsWith("ctx_") || !f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(liveSessions, f), "utf8"));
        ids.add(String(d.session_id || f.replace(/\.json$/, "")));
      } catch (_) {
        /* corrupt legacy file — skipped by design */
      }
    }
    validLegacy = ids.size;
  } catch (_) {
    validLegacy = 0;
  }

  check("live project legacy archives imported", imported >= 1, "legacy_files=" + imported);
  check(
    "live project memory rows cover every valid legacy archive",
    liveRows >= validLegacy && liveRows <= imported,
    "rows=" + liveRows + " validLegacy=" + validLegacy + " files=" + imported,
  );
}

// ── Result ─────────────────────────────────────────────────
console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
if (fail > 0) {
  console.log("MEMORY_SQLITE_FAIL");
  process.exit(1);
}
console.log("MEMORY_SQLITE_OK");
