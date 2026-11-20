"use strict";

/**
 * modules/skill-db.js — read-only access to the local skill SQLite database.
 *
 * The data was imported once from the experiment project into
 * `skills/skills.db`; the experiment path is never read at runtime. Every
 * caller resolves the database relative to this repository, so the CLI and
 * the MCP server work from any editor, folder or working directory.
 *
 * The connection is read-only (`readOnly: true` + `PRAGMA query_only=ON`).
 * Skill bodies are data, never code: nothing here executes them.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "skills", "skills.db");
const REQUIRED_TABLES = ["skills", "skill_terms", "skill_sources"];

const TOKEN_RE = /[A-Za-z][A-Za-z0-9_+.-]{1,40}|[\u0980-\u09FF]{2,20}/g;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "are",
  "was", "were", "not", "use", "uses", "used", "using", "when", "what", "how",
  "why", "who", "all", "any", "can", "will", "would", "should", "could", "must",
  "into", "onto", "out", "its", "has", "have", "had", "but", "our", "their",
  "them", "they", "then", "than", "also", "just", "only", "more", "most", "some",
  "such", "each", "other", "which", "while", "about", "after", "before", "over",
  "under", "between", "via", "per", "etc", "skill", "skills", "agent", "agents",
  "task", "tasks", "work", "working", "step", "steps",
]);

function resolveDbPath(dbPath) {
  if (dbPath) return path.resolve(String(dbPath));
  const env = String(process.env.ZOMBIE_SKILLS_DB || "").trim();
  if (env) return path.resolve(env);
  return DEFAULT_DB;
}

function normalizeText(text) {
  return String(text || "").normalize("NFC");
}

function tokenize(text) {
  const out = [];
  const seen = new Set();
  for (const raw of normalizeText(text).toLowerCase().match(TOKEN_RE) || []) {
    const token = raw.replace(/^[._+-]+|[._+-]+$/g, "");
    if (token.length < 2 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function assertSchema(db, dbPath) {
  const names = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  const missing = REQUIRED_TABLES.filter((name) => !names.has(name));
  if (missing.length) {
    throw new Error("skill database " + dbPath + " is missing tables: " + missing.join(", "));
  }
}

function openStore(dbPath) {
  const resolved = resolveDbPath(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      "skill database not found: " +
        resolved +
        " (run node scripts/import-skills-db.js --source <experiment>/skills.db)",
    );
  }
  const db = new DatabaseSync(resolved, { readOnly: true });
  db.exec("PRAGMA query_only=ON");
  assertSchema(db, resolved);

  function stats() {
    const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM skills").get();
    const active = db.prepare("SELECT COUNT(*) AS n FROM skills WHERE active = 1").get();
    const terms = db.prepare("SELECT COUNT(*) AS n FROM skill_terms").get();
    const sources = db
      .prepare(
        "SELECT source, url, license, skill_count, status, last_synced_at FROM skill_sources ORDER BY source",
      )
      .all();
    return {
      db: resolved,
      db_bytes: fs.statSync(resolved).size,
      total: Number(total.n),
      active: Number(active.n),
      terms: Number(terms.n),
      bytes: Number(total.bytes),
      sources: sources.map((row) => ({ ...row })),
    };
  }

  function list(query, limit) {
    const max = Math.max(1, Math.min(Number(limit) || 50, 200));
    const text = String(query || "").trim();
    if (text) {
      const like = "%" + text + "%";
      return db
        .prepare(
          "SELECT id, slug, name, description, source, license, bytes, updated_at " +
            "FROM skills WHERE active = 1 AND (name LIKE ? OR description LIKE ? OR tags LIKE ? OR slug LIKE ?) " +
            "ORDER BY name LIMIT ?",
        )
        .all(like, like, like, like, max)
        .map((row) => ({ ...row }));
    }
    return db
      .prepare(
        "SELECT id, slug, name, description, source, license, bytes, updated_at " +
          "FROM skills WHERE active = 1 ORDER BY name LIMIT ?",
      )
      .all(max)
      .map((row) => ({ ...row }));
  }

  function get(identifier) {
    const value = String(identifier || "").trim();
    if (!value) return null;
    const row = db
      .prepare("SELECT * FROM skills WHERE (id = ? OR slug = ?) AND active = 1 LIMIT 1")
      .get(value, value);
    return row ? { ...row } : null;
  }

  function route(text, limit, minScore) {
    const tokens = tokenize(text).slice(0, 40);
    if (!tokens.length) return [];
    const marks = tokens.map(() => "?").join(",");
    const rows = db
      .prepare("SELECT term, skill_id, weight FROM skill_terms WHERE term IN (" + marks + ")")
      .all(...tokens);
    if (!rows.length) return [];
    const frequencies = new Map(
      db
        .prepare(
          "SELECT term, COUNT(*) AS n FROM skill_terms WHERE term IN (" + marks + ") GROUP BY term",
        )
        .all(...tokens)
        .map((row) => [String(row.term), Number(row.n)]),
    );
    const scores = new Map();
    const matched = new Map();
    for (const row of rows) {
      const skillId = String(row.skill_id);
      const frequency = Math.max(frequencies.get(String(row.term)) || 1, 1);
      const contribution = Math.max(0.15, Number(row.weight) / Math.pow(frequency, 0.4));
      scores.set(skillId, (scores.get(skillId) || 0) + contribution);
      matched.set(skillId, (matched.get(skillId) || 0) + 1);
    }
    if (!scores.size) return [];
    const shortlist = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max((Number(limit) || 2) * 4, 8))
      .map(([id]) => id);
    const idMarks = shortlist.map(() => "?").join(",");
    const meta = new Map(
      db
        .prepare(
          "SELECT id, slug, name, description, source, kind, body FROM skills " +
            "WHERE id IN (" + idMarks + ") AND active = 1",
        )
        .all(...shortlist)
        .map((row) => [String(row.id), { ...row }]),
    );
    const haystack = String(text || "").toLowerCase();
    const minimum = Number.isFinite(Number(minScore)) ? Number(minScore) : 3.0;
    const matches = [];
    for (const [skillId, base] of scores) {
      const row = meta.get(skillId);
      if (!row) continue;
      let score = base + 0.35 * Math.max((matched.get(skillId) || 1) - 1, 0);
      if (String(row.name || "").toLowerCase().includes(haystack)) score += 10;
      if (String(row.slug || "").replace(/-/g, " ").includes(haystack)) score += 6;
      if (score < minimum) continue;
      matches.push({ ...row, score: Math.round(score * 100) / 100 });
    }
    matches.sort((a, b) => b.score - a.score);
    const top = [];
    const seen = new Set();
    for (const match of matches) {
      if (seen.has(match.slug)) continue;
      seen.add(match.slug);
      top.push(match);
      if (top.length >= (Number(limit) || 2)) break;
    }
    return top;
  }

  function close() {
    try {
      db.close();
    } catch (_) {
      /* already closed */
    }
  }

  return { path: resolved, stats, list, get, route, close };
}

module.exports = {
  ROOT,
  DEFAULT_DB,
  REQUIRED_TABLES,
  resolveDbPath,
  normalizeText,
  tokenize,
  openStore,
};
