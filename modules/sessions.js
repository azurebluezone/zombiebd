"use strict";

/**
 * modules/sessions.js — bounded RAM, append-only archive.
 *
 * Policy (mandatory):
 *   - At most 10 sessions stay resident in RAM (LRU).
 *   - Every turn is appended to the session's JSONL archive as it arrives,
 *     so an evicted session is never lost and a crash loses at most the
 *     in-flight write.
 *   - Reading an archived session does NOT promote it back into RAM; the
 *     caller gets the turns it asked for and the 10-slot budget stays intact.
 *
 * Archive layout: <archiveDir>/<safe-id>.jsonl
 *   line 1  { type: "session", id, agent_id, workspace, metadata, created_at }
 *   line n  { type: "turn", role, content, at, seq }
 */

const fs = require("fs");
const path = require("path");

const MAX_RESIDENT_TURNS = 40;

function safeId(id) {
  return String(id || "anonymous")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
}

function readJsonLines(file) {
  const out = [];
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (_) {
    return out;
  }
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      out.push(JSON.parse(text));
    } catch (_) {
      // A torn final line after a crash must not hide the earlier turns.
    }
  }
  return out;
}

class SessionStore {
  constructor(opts) {
    const o = opts || {};
    this.maxResident = Number.isInteger(o.maxResident) && o.maxResident > 0 ? o.maxResident : 10;
    this.archiveDir = path.resolve(o.archiveDir || path.join(process.cwd(), ".zombiecoder", "agents", "sessions"));
    this.ttlMs = Number.isFinite(o.ttlMs) ? o.ttlMs : 24 * 60 * 60 * 1000;
    this.now = typeof o.now === "function" ? o.now : Date.now;
    this.resident = new Map(); // id -> session (Map order == LRU order)
    this.evictions = 0;
    this.appends = 0;
    fs.mkdirSync(this.archiveDir, { recursive: true });
  }

  archivePath(id) {
    return path.join(this.archiveDir, safeId(id) + ".jsonl");
  }

  _writeLine(id, record) {
    try {
      fs.appendFileSync(this.archivePath(id), JSON.stringify(record) + "\n", "utf8");
      return true;
    } catch (_) {
      return false;
    }
  }

  _touch(id) {
    const session = this.resident.get(id);
    if (!session) return null;
    this.resident.delete(id);
    this.resident.set(id, session);
    return session;
  }

  _evictIfNeeded() {
    while (this.resident.size > this.maxResident) {
      const oldest = this.resident.keys().next().value;
      this.resident.delete(oldest);
      this.evictions += 1;
    }
  }

  create(spec) {
    const s = spec || {};
    const id = String(s.id || require("crypto").randomUUID());
    if (this.resident.has(id)) return this._touch(id);

    const archived = this.readArchive(id);
    if (archived.header) {
      // Already exists on disk (server restart / re-connect): rebuild the
      // resident copy from the archive instead of starting a second history.
      const session = Object.assign({}, archived.header, {
        turns: archived.turns.slice(-MAX_RESIDENT_TURNS),
        archived: false,
      });
      this.resident.set(id, session);
      this._evictIfNeeded();
      return this._touch(id);
    }

    const createdAt = new Date(this.now()).toISOString();
    const session = {
      id,
      agent_id: s.agentId || "",
      workspace: s.workspace || "",
      client_id: s.clientId || "anonymous",
      editor: s.editor || "unknown",
      metadata: Object.assign({}, s.metadata || {}),
      created_at: createdAt,
      last_seen_at: createdAt,
      expires_at: new Date(this.now() + this.ttlMs).toISOString(),
      turns: [],
      archived: false,
    };
    this._writeLine(id, {
      type: "session",
      id,
      agent_id: session.agent_id,
      workspace: session.workspace,
      client_id: session.client_id,
      editor: session.editor,
      metadata: session.metadata,
      created_at: createdAt,
    });
    this.resident.set(id, session);
    this._evictIfNeeded();
    return this._touch(id);
  }

  /** Resident session, else a read-only reconstruction from the archive. */
  get(id) {
    const key = String(id || "");
    if (!key) return null;
    if (this.resident.has(key)) {
      const session = this._touch(key);
      if (new Date(session.expires_at).getTime() > this.now()) return session;
      this.resident.delete(key);
    }
    const archived = this.readArchive(key);
    if (!archived.header) return null;
    return Object.assign({}, archived.header, {
      turns: archived.turns,
      archived: true,
    });
  }

  /**
   * Append one turn. The archive write happens for every input, resident or
   * not; the RAM copy is bounded and evicted by LRU.
   */
  append(id, turn) {
    const key = String(id || "");
    if (!key) throw new Error("SessionStore.append needs a session id");
    const t = turn || {};
    const record = {
      type: "turn",
      role: String(t.role || "user"),
      content: String(t.content === undefined ? "" : t.content),
      at: t.at || new Date(this.now()).toISOString(),
      seq: Number.isFinite(t.seq) ? t.seq : this.appends + 1,
    };
    this._writeLine(key, record);
    this.appends += 1;

    const session = this.resident.get(key);
    if (!session) return record;
    session.turns.push(record);
    if (session.turns.length > MAX_RESIDENT_TURNS) {
      session.turns = session.turns.slice(-MAX_RESIDENT_TURNS);
    }
    session.last_seen_at = record.at;
    session.expires_at = new Date(this.now() + this.ttlMs).toISOString();
    this._touch(key);
    return record;
  }

  readArchive(id) {
    const records = readJsonLines(this.archivePath(id));
    const header = records.find((r) => r && r.type === "session") || null;
    const turns = records.filter((r) => r && r.type === "turn");
    return { header, turns };
  }

  archive(id, reason) {
    const key = String(id || "");
    if (!key) return "";
    this.resident.delete(key);
    this._writeLine(key, {
      type: "archive",
      reason: String(reason || "manual"),
      at: new Date(this.now()).toISOString(),
    });
    return this.archivePath(key);
  }

  residentIds() {
    return Array.from(this.resident.keys());
  }

  stats() {
    return {
      resident: this.resident.size,
      max_resident: this.maxResident,
      evictions: this.evictions,
      appends: this.appends,
      archive_dir: this.archiveDir,
    };
  }
}

module.exports = { SessionStore, MAX_RESIDENT_TURNS, safeId, readJsonLines };
