"use strict";

/**
 * modules/project-memory.js — project session archives in SQLite.
 *
 * The per-project memory used to be one JSON file per archived session
 * (`.zombiecoder/agents/sessions/ctx_*.json`) plus `memory.json` and
 * `_index.json`. Each mission rewrote two of those files and created a third.
 * This module keeps the same data in the gateway SQLite DB:
 *
 *   project_memory        one row per archived session (recent + search)
 *   project_memory_state  memory.json equivalent (recent_context, counters)
 *   project_memory_meta   one-time legacy file import marker
 *
 * WAL is enabled on the connection because the gateway is the only writer and
 * still needs readers (admin pages, checks) to work concurrently.
 *
 * Legacy JSON is imported once per project; it is never rewritten after that.
 * `data/mem-*.json` and `.zombiecoder/memory/ses_*.jsonl` are NOT touched.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = () => ({
  current_session: {
    id: null,
    started_at: null,
    message_count: 0,
    summary: null,
  },
  recent_context: [],
  session_index: {
    last_accessed: null,
    total_sessions: 0,
    total_archived: 0,
  },
});

const MAX_RECENT_CONTEXT = 20;
const AGENTS_DIR = ".zombiecoder/agents";

/**
 * Every archive row records the immutable system identity. callers may pass
 * their own metadata; this default makes the identity mandatory even when a
 * caller forgets (or archives straight through the module).
 */
function defaultArchiveMetadata() {
  try {
    const identity = require("./system-identity");
    return { system_identity: identity.identityMetadata(identity.getIdentity()) };
  } catch (_) {
    return {};
  }
}

function cleanDir(projectDir) {
  return path.resolve(String(projectDir || process.cwd()));
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function jsonArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  const parsed = safeJson(value);
  return Array.isArray(parsed) ? parsed : [];
}

function createProjectMemory(options) {
  const o = options || {};
  const db = o.db;
  if (!db || typeof db.prepare !== "function") {
    throw new Error("createProjectMemory needs an open SQLite database handle");
  }
  const log = typeof o.log === "function" ? o.log : () => {};

  // WAL: one writer (the gateway) and concurrent readers. NORMAL is the
  // documented safe pairing for WAL and avoids an fsync per transaction.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_dir TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      key_points TEXT NOT NULL DEFAULT '[]',
      decisions TEXT NOT NULL DEFAULT '[]',
      files_changed TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      prev_session TEXT,
      next_session TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(project_dir, session_id)
    );
    CREATE INDEX IF NOT EXISTS idx_project_memory_recent
      ON project_memory(project_dir, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_memory_state (
      project_dir TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_memory_meta (
      project_dir TEXT PRIMARY KEY,
      legacy_imported_at TEXT,
      legacy_files INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Older databases were created before `metadata` existed. Add it in place;
  // existing archives keep an empty object and new ones carry system identity.
  const archiveCols = db
    .prepare("PRAGMA table_info(project_memory)")
    .all()
    .map((c) => c.name);
  if (!archiveCols.includes("metadata")) {
    db.exec("ALTER TABLE project_memory ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  }

  const readStateRow = db.prepare(
    "SELECT data FROM project_memory_state WHERE project_dir = ?",
  );
  const upsertState = db.prepare(
    `INSERT INTO project_memory_state (project_dir, data, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(project_dir) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  );
  const readMeta = db.prepare(
    "SELECT legacy_imported_at, legacy_files FROM project_memory_meta WHERE project_dir = ?",
  );
  const upsertMeta = db.prepare(
    `INSERT INTO project_memory_meta (project_dir, legacy_imported_at, legacy_files)
     VALUES (?, ?, ?)
     ON CONFLICT(project_dir) DO UPDATE SET
       legacy_imported_at = excluded.legacy_imported_at,
       legacy_files = excluded.legacy_files`,
  );
  const insertArchive = db.prepare(
    `INSERT OR IGNORE INTO project_memory
       (project_dir, session_id, created_at, message_count, summary,
        key_points, decisions, files_changed, tags, prev_session, next_session,
        metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const recentRows = db.prepare(
    `SELECT * FROM project_memory
     WHERE project_dir = ?
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  const searchRows = db.prepare(
    `SELECT session_id FROM project_memory
     WHERE project_dir = ?
       AND (
         lower(summary) LIKE ? OR
         lower(key_points) LIKE ? OR
         lower(decisions) LIKE ? OR
         lower(tags) LIKE ?
       )
     ORDER BY created_at DESC, id DESC
     LIMIT 200`,
  );
  const searchArchiveRows = db.prepare(
    `SELECT * FROM project_memory
     WHERE project_dir = ?
       AND (
         lower(summary) LIKE ? OR
         lower(key_points) LIKE ? OR
         lower(decisions) LIKE ? OR
         lower(tags) LIKE ?
       )
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
  );
  const datedCount = db.prepare(
    "SELECT COUNT(*) c FROM project_memory WHERE project_dir = ? AND session_id LIKE ?",
  );
  const countRows = db.prepare(
    "SELECT COUNT(*) c FROM project_memory WHERE project_dir = ?",
  );

  function agentsDir(projectDir) {
    return path.join(cleanDir(projectDir), AGENTS_DIR);
  }

  function sessionsDir(projectDir) {
    return path.join(agentsDir(projectDir), "sessions");
  }

  function readStateFromDb(projectDir) {
    const dir = cleanDir(projectDir);
    const row = readStateRow.get(dir);
    if (!row || !row.data) return null;
    const parsed = safeJson(row.data);
    if (!parsed || typeof parsed !== "object") return null;
    return Object.assign(DEFAULT_STATE(), parsed);
  }

  function readStateFromFile(projectDir) {
    const file = path.join(agentsDir(projectDir), "memory.json");
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = safeJson(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      return Object.assign(DEFAULT_STATE(), parsed);
    } catch (_) {
      return null;
    }
  }

  /** memory.json equivalent; SQLite first, legacy file second. */
  function readState(projectDir) {
    return readStateFromDb(projectDir) || readStateFromFile(projectDir) || DEFAULT_STATE();
  }

  /** Persist the memory.json equivalent in SQLite (no file write). */
  function writeState(projectDir, data) {
    const dir = cleanDir(projectDir);
    const payload = Object.assign(DEFAULT_STATE(), data || {});
    upsertState.run(dir, JSON.stringify(payload), new Date().toISOString());
    return payload;
  }

  function rowToArchive(row) {
    return {
      id: row.id,
      session_id: row.session_id,
      created_at: row.created_at,
      message_count: row.message_count,
      summary: row.summary || "",
      key_points: parseArray(row.key_points),
      decisions: parseArray(row.decisions),
      files_changed: parseArray(row.files_changed),
      tags: parseArray(row.tags),
      prev_session: row.prev_session || null,
      next_session: row.next_session || null,
      metadata: safeJson(row.metadata) || {},
    };
  }

  /**
   * Delete the legacy JSON archives for a project that is already in SQLite.
   * Refuses to delete anything until the import marker exists, so a database
   * failure can never destroy the only copy.
   */
  function purgeLegacyFiles(projectDir) {
    const dir = cleanDir(projectDir);
    const meta = readMeta.get(dir);
    if (!meta || !meta.legacy_imported_at) {
      return { purged: 0, skipped: true, reason: "no_import_marker" };
    }
    let purged = 0;
    const sdir = sessionsDir(dir);
    try {
      for (const file of fs.readdirSync(sdir)) {
        const isArchive = file.startsWith("ctx_") && file.endsWith(".json");
        if (!isArchive && file !== "_index.json") continue;
        try {
          fs.unlinkSync(path.join(sdir, file));
          purged++;
        } catch (err) {
          log("WARN", "PROJECT_MEMORY_PURGE_SKIP", { file, error: err.message });
        }
      }
    } catch (_) {
      /* sessions dir already gone — nothing to purge */
    }
    const memFile = path.join(agentsDir(dir), "memory.json");
    try {
      if (fs.existsSync(memFile)) {
        fs.unlinkSync(memFile);
        purged++;
      }
    } catch (err) {
      log("WARN", "PROJECT_MEMORY_PURGE_SKIP", { file: "memory.json", error: err.message });
    }
    log("INFO", "PROJECT_MEMORY_LEGACY_PURGED", { project: dir, purged });
    return { purged, skipped: false };
  }

  /**
   * Import legacy ctx_*.json files and memory.json once per project.
   * Returns { imported, files } and is safe to call repeatedly.
   */
  function migrateFromFiles(projectDir) {
    const dir = cleanDir(projectDir);
    const meta = readMeta.get(dir);
    if (meta && meta.legacy_imported_at) {
      const purge = purgeLegacyFiles(dir);
      return {
        imported: 0,
        files: Number(meta.legacy_files) || 0,
        skipped: true,
        purged: purge.purged || 0,
      };
    }

    const sdir = sessionsDir(dir);
    let files = [];
    try {
      files = fs
        .readdirSync(sdir)
        .filter((f) => f.startsWith("ctx_") && f.endsWith(".json"))
        .sort();
    } catch (_) {
      files = [];
    }

    let imported = 0;
    try {
      db.exec("BEGIN");
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(sdir, file), "utf8");
          const data = safeJson(raw);
          if (!data || typeof data !== "object") continue;
          const sessionId = String(data.session_id || file.replace(/\.json$/, ""));
          const changes = insertArchive.run(
            dir,
            sessionId,
            String(data.created_at || new Date().toISOString()),
            Number(data.message_count) || 0,
            String(data.summary || ""),
            jsonArray(data.key_points),
            jsonArray(data.decisions),
            jsonArray(data.files_changed),
            jsonArray(data.tags),
            data.prev_session || null,
            data.next_session || null,
            "{}",
          );
          if (changes.changes > 0) {
            imported++;
          }
        } catch (err) {
          log("WARN", "PROJECT_MEMORY_IMPORT_SKIP", { file, error: err.message });
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch (_) {
        /* already rolled back */
      }
      log("WARN", "PROJECT_MEMORY_IMPORT_FAIL", { error: err.message });
      return { imported: 0, files: files.length, error: err.message };
    }

    // Merge the archives that are really stored in SQLite with any legacy
    // recent_context rows that were not imported (e.g. older purged sessions).
    const state = readStateFromDb(dir) || readStateFromFile(dir) || DEFAULT_STATE();
    if (!Array.isArray(state.recent_context)) state.recent_context = [];
    const seen = new Set(
      state.recent_context.map((c) => String((c && c.session_id) || "")),
    );
    const storedArchives = recentRows
      .all(dir, MAX_RECENT_CONTEXT)
      .map(rowToArchive)
      .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
    for (const archive of storedArchives) {
      const sid = String(archive.session_id || "");
      if (!sid || seen.has(sid)) continue;
      seen.add(sid);
      state.recent_context.push({
        session_id: sid,
        summary: archive.summary || "No summary",
        timestamp: archive.created_at || new Date().toISOString(),
        agent_count: 0,
        tags: Array.isArray(archive.tags) ? archive.tags : [],
      });
    }
    if (state.recent_context.length > MAX_RECENT_CONTEXT) {
      state.recent_context = state.recent_context.slice(-MAX_RECENT_CONTEXT);
    }
    const total = Number(countRows.get(dir).c) || 0;
    state.session_index = Object.assign(
      { last_accessed: null, total_sessions: 0, total_archived: 0 },
      state.session_index || {},
    );
    state.session_index.total_sessions = Math.max(
      Number(state.session_index.total_sessions) || 0,
      total,
    );
    state.session_index.total_archived = Math.max(
      Number(state.session_index.total_archived) || 0,
      total,
    );
    writeState(dir, state);

    upsertMeta.run(dir, new Date().toISOString(), files.length);
    const skipped = files.length - imported;
    // The DB now holds every parseable archive and the marker is written.
    // Remove the legacy files so no future turn reads or rewrites them.
    const purge = purgeLegacyFiles(dir);
    log("INFO", "PROJECT_MEMORY_MIGRATED", {
      project: dir,
      files: files.length,
      imported,
      skipped,
      purged: purge.purged || 0,
    });
    return { imported, files: files.length, skipped, purged: purge.purged || 0 };
  }

  function ensureMigrated(projectDir) {
    const dir = cleanDir(projectDir);
    const meta = readMeta.get(dir);
    if (!meta || !meta.legacy_imported_at) migrateFromFiles(dir);
    else purgeLegacyFiles(dir);
  }

  /**
   * Archive one session. Writes exactly one SQLite row and updates state.
   * Returns the archive id (same `ctx_YYYYMMDD_NNN` shape as before).
   */
  function archive(projectDir, sessionId, messages, summary, extra) {
    const dir = cleanDir(projectDir);
    ensureMigrated(dir);

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const like = "ctx_" + dateStr + "%";
    const seq = (Number(datedCount.get(dir, like)?.c) || 0) + 1;
    const archiveId = "ctx_" + dateStr + "_" + String(seq).padStart(3, "0");
    const e = extra || {};
    const keyPoints = e.key_points || [];
    const decisions = e.decisions || [];
    const filesChanged = e.files_changed || [];
    const tags = e.tags || [];

    insertArchive.run(
      dir,
      archiveId,
      now.toISOString(),
      (messages || []).length,
      String(summary || "No summary provided"),
      jsonArray(keyPoints),
      jsonArray(decisions),
      jsonArray(filesChanged),
      jsonArray(tags),
      e.prev_session || null,
      e.next_session || null,
      JSON.stringify(
        Object.assign(
          defaultArchiveMetadata(),
          e.metadata && typeof e.metadata === "object" ? e.metadata : {},
        ),
      ),
    );

    const state = writeState(dir, Object.assign(readState(dir), {}));
    state.session_index.last_accessed = now.toISOString();
    state.session_index.total_sessions =
      (Number(state.session_index.total_sessions) || 0) + 1;
    state.session_index.total_archived =
      (Number(state.session_index.total_archived) || 0) + 1;
    if (!Array.isArray(state.recent_context)) state.recent_context = [];
    state.recent_context.push({
      session_id: archiveId,
      summary: String(summary || "No summary"),
      timestamp: now.toISOString(),
      agent_count: 0,
      tags,
    });
    if (state.recent_context.length > MAX_RECENT_CONTEXT) {
      state.recent_context = state.recent_context.slice(-MAX_RECENT_CONTEXT);
    }
    writeState(dir, state);

    return archiveId;
  }

  /** Newest archives first, for context restoration. */
  function recent(projectDir, limit) {
    const dir = cleanDir(projectDir);
    ensureMigrated(dir);
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 3;
    return recentRows.all(dir, n).map(rowToArchive);
  }

  /**
   * Keyword search over summary/key points/decisions/tags.
   * Returns the same deduplicated session-id list the JSON index used to.
   */
  function search(projectDir, keyword) {
    const dir = cleanDir(projectDir);
    ensureMigrated(dir);
    const kw = "%" + String(keyword || "").toLowerCase() + "%";
    const rows = searchRows.all(dir, kw, kw, kw, kw);
    return [...new Set(rows.map((r) => r.session_id))];
  }

  /**
   * Keyword search that returns full archive rows (for the memory_search
   * tool). `search()` stays id-only for the legacy API callers.
   */
  function find(projectDir, keyword, limit) {
    const dir = cleanDir(projectDir);
    ensureMigrated(dir);
    const kw = "%" + String(keyword || "").toLowerCase() + "%";
    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 10;
    return searchArchiveRows.all(dir, kw, kw, kw, kw, n).map(rowToArchive);
  }

  return {
    archive,
    readState,
    writeState,
    recent,
    search,
    find,
    migrateFromFiles,
    purgeLegacyFiles,
    ensureMigrated,
  };
}

module.exports = { createProjectMemory, DEFAULT_STATE };
