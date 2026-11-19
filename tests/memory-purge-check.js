#!/usr/bin/env node
"use strict";

/*
 * Memory purge + lazy retrieval acceptance check.
 *
 * Proves:
 *   1. Legacy ctx_*.json / memory.json / _index.json are imported once and then
 *      deleted; corrupt archives are skipped, never fatal.
 *   2. The archives stay readable from SQLite after the files are gone
 *      (recent / search / find).
 *   3. Corrupt state rows, missing rows and a deleted project directory do not
 *      throw — a response can always fall back to defaults.
 *   4. New archives carry the system identity metadata.
 *   5. Session history is no longer auto-injected into the mission context;
 *      agents get memory_recent / memory_search MCP tools instead.
 *   6. The live gateway DB holds the real archives and the sessions directory
 *      is empty of legacy ctx files.
 *
 * Run: node tests/memory-purge-check.js
 * Exit 0 prints MEMORY_PURGE_OK.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "memory-purge-check-" + process.pid);
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

function seedArchive(file, seq, summary, keyword) {
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

const legacy = seedArchive(
  path.join(SESSIONS_DIR, "ctx_20260101_001.json"),
  1,
  "Purge check one PURGE_ONE",
  "PURGE_ONE",
);
seedArchive(
  path.join(SESSIONS_DIR, "ctx_20260101_002.json"),
  2,
  "Purge check two PURGE_TWO",
  "PURGE_TWO",
);
fs.writeFileSync(
  path.join(SESSIONS_DIR, "ctx_20260101_003.json"),
  '{"session_id":"ctx_broken","summary":"torn wri',
);
fs.writeFileSync(
  path.join(AGENTS_DIR, "memory.json"),
  JSON.stringify({
    current_session: { id: null, started_at: null, message_count: 0, summary: null },
    recent_context: [
      {
        session_id: legacy.session_id,
        summary: legacy.summary,
        timestamp: legacy.created_at,
        agent_count: 0,
        tags: legacy.tags,
      },
    ],
    session_index: { last_accessed: legacy.created_at, total_sessions: 2, total_archived: 2 },
  }),
);
fs.writeFileSync(
  path.join(SESSIONS_DIR, "_index.json"),
  JSON.stringify({ version: 1, index: { purge_one: [legacy.session_id] } }),
);

const { createProjectMemory } = require(path.join(ROOT, "modules", "project-memory.js"));
const db = new DatabaseSync(DB_PATH);
const store = createProjectMemory({ db });

// ── 1. Import + purge ──────────────────────────────────────
const migrated = store.migrateFromFiles(PROJECT);
check("valid archives imported", migrated.imported === 2, JSON.stringify(migrated));
check("corrupt archive skipped", migrated.skipped === 1, JSON.stringify(migrated));
check("migration purged the legacy files", migrated.purged >= 5, JSON.stringify(migrated));

const left = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
check("no ctx/_index json left on disk", left.length === 0, left.join(",") || "empty");
check(
  "memory.json removed after consolidation",
  !fs.existsSync(path.join(AGENTS_DIR, "memory.json")),
);

const rows = db
  .prepare("SELECT COUNT(*) c FROM project_memory WHERE project_dir = ?")
  .get(PROJECT).c;
check("sqlite keeps both valid archives", rows === 2, "rows=" + rows);

// ── 2. Reads survive the purge ─────────────────────────────
const recent = store.recent(PROJECT, 5);
check("recent() works after files are deleted", recent.length === 2, "rows=" + recent.length);
check("recent() is newest first", recent[0].summary.includes("PURGE_TWO"), recent[0].summary);
const found = store.search(PROJECT, "PURGE_ONE");
check("search() works after purge", found.includes("ctx_20260101_001"), JSON.stringify(found));
const full = store.find(PROJECT, "PURGE_ONE");
check(
  "find() returns full archive rows after purge",
  full.length === 1 && Array.isArray(full[0].key_points),
  JSON.stringify(full),
);

const state = store.readState(PROJECT);
check(
  "state recent_context survived the purge",
  state.recent_context.some((c) => String(c.summary || "").includes("PURGE_TWO")),
);
check(
  "session_index counts stored rows, not corrupt files",
  state.session_index.total_sessions === 2 && state.session_index.total_archived === 2,
  JSON.stringify(state.session_index),
);

const second = store.migrateFromFiles(PROJECT);
check(
  "second migration is a no-op (idempotent)",
  second.imported === 0 && second.skipped === true && second.purged === 0,
  JSON.stringify(second),
);

// ── 3. Corruption / deletion resilience ────────────────────
db.prepare("UPDATE project_memory_state SET data = ? WHERE project_dir = ?").run(
  "{ this is not json",
  PROJECT,
);
let corruptState = null;
let corruptThrew = false;
try {
  corruptState = store.readState(PROJECT);
} catch (_) {
  corruptThrew = true;
}
check("corrupt state row does not throw", !corruptThrew);
check(
  "corrupt state row falls back to a default shape",
  corruptState &&
    corruptState.current_session &&
    Array.isArray(corruptState.recent_context),
  JSON.stringify(corruptState && corruptState.session_index),
);

const missingProject = path.join(TMP, "never-existed");
let missingThrew = false;
let missingRecent = null;
let missingSearch = null;
try {
  missingRecent = store.recent(missingProject, 3);
  missingSearch = store.search(missingProject, "anything");
} catch (_) {
  missingThrew = true;
}
check("missing project does not throw", !missingThrew);
check("missing project returns no recent rows", Array.isArray(missingRecent) && missingRecent.length === 0);
check("missing project returns no search rows", Array.isArray(missingSearch) && missingSearch.length === 0);

// A project directory that disappears after migration must still be readable.
store.archive(PROJECT, "sess-purge", [{ role: "user", content: "x" }], "Archive before delete PURGE_ARCHIVE");
fs.rmSync(PROJECT, { recursive: true, force: true });
let goneThrew = false;
let goneRecent = null;
try {
  goneRecent = store.recent(PROJECT, 3);
} catch (_) {
  goneThrew = true;
}
check("deleted project directory does not throw", !goneThrew);
check(
  "archives remain readable from sqlite after the directory is gone",
  Array.isArray(goneRecent) && goneRecent.some((a) => a.summary.includes("PURGE_ARCHIVE")),
  JSON.stringify(goneRecent && goneRecent.map((a) => a.summary)),
);

// ── 4. Identity metadata on new archives ───────────────────
const metaRow = db
  .prepare("SELECT metadata FROM project_memory WHERE project_dir = ? AND summary LIKE ?")
  .get(PROJECT, "%PURGE_ARCHIVE%");
let archiveMeta = {};
try {
  archiveMeta = JSON.parse(metaRow.metadata);
} catch (_) {
  archiveMeta = {};
}
check(
  "new archive carries system identity metadata",
  archiveMeta.system_identity && archiveMeta.system_identity.owner === "Sahon Srabon",
  JSON.stringify(archiveMeta),
);

// ── 5. Lazy retrieval wiring (no auto-injection) ───────────
const apiSrc = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
check(
  "memory_recent tool is declared",
  /memory_recent:\s*\{/.test(apiSrc) && /case "memory_recent":/.test(apiSrc),
);
check(
  "memory_search tool is declared",
  /memory_search:\s*\{/.test(apiSrc) && /case "memory_search":/.test(apiSrc),
);
check(
  "mission context no longer injects session history",
  !apiSrc.includes("--- Session Memory ---") &&
    !/const restoredContext = restoreRecentContext\(\)/.test(apiSrc),
);
check(
  "archives are not written back to disk",
  /store\.archive\(dir, sessionId, messages, summary/.test(apiSrc),
);

// ── 6. Live gateway state ──────────────────────────────────
const LIVE_DB = path.resolve(ROOT, "data/models.db");
let live = null;
try {
  live = new DatabaseSync(LIVE_DB, { readOnly: true });
} catch (e) {
  console.log("FAIL live db open — " + e.message);
}
if (live) {
  const liveRows = live
    .prepare("SELECT COUNT(*) c FROM project_memory WHERE project_dir = ?")
    .get(ROOT).c;
  check("live DB still holds the imported archives", liveRows >= 786, "rows=" + liveRows);
}
const liveSessions = path.join(ROOT, ".zombiecoder", "agents", "sessions");
let liveLeft = [];
try {
  liveLeft = fs.readdirSync(liveSessions).filter((f) => f.endsWith(".json"));
} catch (_) {
  liveLeft = [];
}
check(
  "live sessions dir has no legacy ctx/_index json",
  liveLeft.length === 0,
  String(liveLeft.length) + " file(s)",
);
check(
  "live memory.json is gone",
  !fs.existsSync(path.join(ROOT, ".zombiecoder", "agents", "memory.json")),
);
let sessionJsonl = 0;
try {
  sessionJsonl = fs
    .readdirSync(path.join(ROOT, ".zombiecoder", "memory"))
    .filter((f) => f.endsWith(".jsonl")).length;
} catch (_) {
  sessionJsonl = 0;
}
check("session JSONL memory is left untouched", sessionJsonl > 0, String(sessionJsonl) + " jsonl");

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: 5050, path: pathname, timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: e.message }));
  });
}

(async () => {
  const mem = await get("/api/memory");
  if (mem.error) {
    console.log("FAIL live /api/memory — " + mem.error);
  } else {
    let json = null;
    try {
      json = JSON.parse(mem.body);
    } catch (_) {
      json = null;
    }
    check(
      "live /api/memory reports sqlite storage",
      json && json.storage === "sqlite:project_memory",
      json && json.storage,
    );
  }

  const search = await get("/api/sessions/search?q=bug-hunter");
  if (search.error) {
    console.log("FAIL live session search — " + search.error);
  } else {
    let json = null;
    try {
      json = JSON.parse(search.body);
    } catch (_) {
      json = null;
    }
    check(
      "live session search still answers from sqlite after purge",
      json && json.ok === true && json.count >= 92,
      json && "count=" + json.count,
    );
  }

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    console.log("MEMORY_PURGE_FAIL");
    process.exit(1);
  }
  console.log("MEMORY_PURGE_OK");
})();
