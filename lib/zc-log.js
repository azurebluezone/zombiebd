"use strict";
/**
 * zc-log.js — unified structured logger for the whole stack
 * ═══════════════════════════════════════════════════════════════════════
 * One module every subsystem shares: universal-adapter (HTTP/HTTPS/stdio
 * transports, main-sync, registry), the API server, and the provider chain.
 *
 * Output:
 *   1. FILE  — logs/zc.jsonl, one JSON object per line:
 *        {"ts":"…","level":"INFO","sub":"adapter","event":"TOOL_CALL",
 *         "ms":12,"tool":"ua_read_file","ok":true, …}
 *      Rotated by size (zc.jsonl → zc.jsonl.1 → .2 → .3).
 *   2. CONSOLE — one short human line:
 *        03:41:07 ✓ [adapter] TOOL_CALL tool=… ms=12
 *      (ZC_LOG_CONSOLE=0 silences it; raw() never prints).
 *
 * PORTABILITY (fresh OS install / moved checkout):
 *   Nothing here is hardcoded. Every path derives from THIS file's location
 *   (__dirname/..) or an env var, so the project can live anywhere:
 *       ZC_ROOT      project root        (default: <this file>/..)
 *       ZC_LOG_DIR   log directory       (default: <root>/logs)
 *       ZC_LOG_CONSOLE  0 to quiet console   (default: 1)
 *       ZC_LOG_DEBUG    1 to emit debug      (default: 0)
 *       ZC_LOG_STACK    1 to include stacks  (default: 0)
 *       ZC_LOG_MAX_BYTES rotation size       (default: 8388608 = 8 MB)
 *
 * Safety: logging NEVER throws into the caller — every write is guarded.
 */

const fs = require("fs");
const path = require("path");

// ─── Path resolution (env overridable, never absolute-hardcoded) ─────────────
const ROOT = process.env.ZC_ROOT || path.resolve(__dirname, "..");
const LOG_DIR = process.env.ZC_LOG_DIR || path.join(ROOT, "logs");
const FILE = path.join(LOG_DIR, "zc.jsonl");

const CONSOLE_ON = (process.env.ZC_LOG_CONSOLE ?? "1") !== "0";
const DEBUG_ON = (process.env.ZC_LOG_DEBUG ?? "0") === "1";
const STACK_ON = (process.env.ZC_LOG_STACK ?? "0") === "1";
const MAX_BYTES = Number(process.env.ZC_LOG_MAX_BYTES || 8 * 1024 * 1024);
const ROTATE_KEEP = 3;

// ─── Rotation ───────────────────────────────────────────────────────────────
function rotateIfLarge() {
  try {
    const st = fs.statSync(FILE);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(FILE, FILE + "." + ROTATE_KEEP); // oldest falls off
    for (let i = ROTATE_KEEP - 1; i >= 1; i--) {
      const from = FILE + "." + i;
      if (fs.existsSync(from)) fs.renameSync(from, FILE + "." + (i + 1));
    }
    fs.renameSync(FILE, FILE + ".1");
  } catch (_) {
    /* rotation is best-effort; never break the caller */
  }
}

/** Serialize an Error (or anything) into a plain, JSON-safe object. */
function errOf(e) {
  if (e == null) return undefined;
  if (e instanceof Error) {
    const o = { error: e.message };
    if (e.code !== undefined) o.code = e.code;
    if (STACK_ON && e.stack) o.stack = String(e.stack).split("\n").slice(0, 6).join(" | ");
    return o;
  }
  if (typeof e === "object") return e;
  return { error: String(e) };
}

const LEVEL_MARK = { INFO: "✓", WARN: "!", ERROR: "✗", DEBUG: "·" };

/**
 * Write one structured record.
 * @param {"INFO"|"WARN"|"ERROR"|"DEBUG"} level
 * @param {string} sub   subsystem: adapter|transport|stdio|main-sync|registry|
 *                       provider|api|circuit|healthcheck|start
 * @param {string} event UPPER_SNAKE event name (matches api.js convention)
 * @param {object} [data] JSON-safe details (ok, ms, error, counts…)
 */
function write(level, sub, event, data) {
  try {
    const rec = {
      ts: new Date().toISOString(),
      level,
      sub,
      event,
      pid: process.pid,
    };
    if (data && typeof data === "object") {
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue;
        rec[k] = v instanceof Error ? errOf(v) : v;
      }
    }
    let line;
    try {
      line = JSON.stringify(rec);
    } catch (_) {
      line = JSON.stringify({ ts: rec.ts, level, sub, event, error: "unserializable data" });
    }

    // 1) file
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      rotateIfLarge();
      fs.appendFileSync(FILE, line + "\n");
    } catch (_) { /* disk full / perms — swallow */ }

    // 2) console
    if (CONSOLE_ON && (level !== "DEBUG" || DEBUG_ON)) {
      const parts = [];
      for (const [k, v] of Object.entries(rec)) {
        if (["ts", "level", "sub", "event", "pid"].includes(k)) continue;
        parts.push(k + "=" + (typeof v === "object" ? JSON.stringify(v) : String(v)));
      }
      const t = rec.ts.slice(11, 19);
      console.log(
        `${t} ${LEVEL_MARK[level] || " "} [${sub}] ${event}` + (parts.length ? " " + parts.join(" ") : ""),
      );
    }
  } catch (_) {
    /* a logger must never take the process down */
  }
}

module.exports = {
  /** Project root this checkout lives in (portable — moves with the code). */
  root: ROOT,
  dir: LOG_DIR,
  file: FILE,

  info: (sub, event, data) => write("INFO", sub, event, data),
  warn: (sub, event, data) => write("WARN", sub, event, data),
  fail: (sub, event, data) => write("ERROR", sub, event, data),
  debug: (sub, event, data) => write("DEBUG", sub, event, data),

  /**
   * File-only record for callers that already print their own console line
   * (api.js mirrors its visual log through this).
   */
  raw(level, sub, event, data) {
    const saved = CONSOLE_ON;
    try {
      // CONSOLE_ON is const; emulate suppression by writing through write()
      // with a temp env override is impossible — so build the record here.
      const rec = { ts: new Date().toISOString(), level, sub, event, pid: process.pid, ...data };
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(FILE, JSON.stringify(rec) + "\n");
    } catch (_) {
      /* swallow */
    }
    void saved;
  },

  /**
   * Time an operation.
   *   const done = zclog.span("provider", "CHAT_CALL", { model });
   *   try { … done({ ok: true, tokens }) } catch (e) { done.fail(e) }
   * The result function may only be called once.
   */
  span(sub, event, data) {
    const t0 = Date.now();
    let used = false;
    const done = (extra) => {
      if (used) return;
      used = true;
      write("INFO", sub, event, { ...(data || {}), ...(extra || {}), ms: Date.now() - t0 });
    };
    done.fail = (err, extra) => {
      if (used) return;
      used = true;
      write("ERROR", sub, event, {
        ...(data || {}),
        ...(extra || {}),
        ms: Date.now() - t0,
        ok: false,
        ...errOf(err),
      });
    };
    return done;
  },
};
