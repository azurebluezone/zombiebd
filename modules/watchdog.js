"use strict";

// Runtime monitor: file hashes plus a heartbeat that can go stale.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_STALE_MS = 30000;

function hashFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return null;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { hash, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (_) {
    return null;
  }
}

class Watchdog {
  constructor(opts) {
    const o = opts || {};
    this.files = (Array.isArray(o.files) ? o.files : []).map((file) => path.resolve(file));
    this.intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : DEFAULT_INTERVAL_MS;
    this.staleMs = Number.isFinite(o.staleMs) ? o.staleMs : DEFAULT_STALE_MS;
    this.now = typeof o.now === "function" ? o.now : Date.now;
    this.onEvent = typeof o.onEvent === "function" ? o.onEvent : null;
    this.logFile = o.logFile ? path.resolve(o.logFile) : "";
    this.snapshotState = new Map();
    this.events = [];
    this.lastBeatAt = 0;
    this.timer = null;
    this.heartbeatTimer = null;
    if (this.logFile) fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
  }

  _emit(event) {
    const record = Object.assign({ at: new Date(this.now()).toISOString() }, event);
    this.events.push(record);
    if (this.events.length > 200) this.events = this.events.slice(-200);
    if (this.logFile) {
      try {
        fs.appendFileSync(this.logFile, JSON.stringify(record) + "\n", "utf8");
      } catch (_) {
        /* logging must never break the runtime */
      }
    }
    if (this.onEvent) {
      try {
        this.onEvent(record);
      } catch (_) {
        /* a broken listener must not stop monitoring */
      }
    }
    return record;
  }

  /** Take the baseline snapshot without reporting changes. */
  prime() {
    for (const file of this.files) {
      this.snapshotState.set(file, hashFile(file));
    }
    return this.snapshotState.size;
  }

  /** Compare every watched file with the previous snapshot. */
  checkNow() {
    const changes = [];
    for (const file of this.files) {
      const before = this.snapshotState.get(file) || null;
      const after = hashFile(file);
      if (!before && after) {
        changes.push({ path: file, type: "created", hash: after.hash });
      } else if (before && !after) {
        changes.push({ path: file, type: "deleted", hash: before.hash });
      } else if (before && after && before.hash !== after.hash) {
        changes.push({ path: file, type: "changed", hash: after.hash, previous: before.hash });
      }
      this.snapshotState.set(file, after);
    }
    for (const change of changes) {
      this._emit({ kind: "file", change: change.type, path: change.path, hash: change.hash });
    }
    return { changes, at: new Date(this.now()).toISOString() };
  }

  /** Record a heartbeat from a named runtime component. */
  beat(name) {
    const component = String(name || "runtime");
    this.lastBeatAt = this.now();
    return { component, at: new Date(this.lastBeatAt).toISOString(), stale: false };
  }

  status() {
    const age = this.lastBeatAt ? this.now() - this.lastBeatAt : Infinity;
    const stale = age > this.staleMs;
    if (this.lastBeatAt && stale) {
      const last = this.events[this.events.length - 1];
      if (!last || last.kind !== "stale") {
        this._emit({ kind: "stale", ageMs: age, staleMs: this.staleMs });
      }
    }
    return {
      healthy: Boolean(this.lastBeatAt) && !stale,
      stale,
      lastBeatAgeMs: Number.isFinite(age) ? age : null,
      staleMs: this.staleMs,
      tracked: this.files.length,
      events: this.events.length,
    };
  }

  start() {
    if (this.timer) return this;
    this.prime();
    this.timer = setInterval(() => this.checkNow(), this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  startHeartbeat(opts) {
    const o = opts || {};
    const intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : this.intervalMs;
    if (this.heartbeatTimer) return this;
    this.heartbeatTimer = setInterval(() => {
      this.beat(o.name || "runtime");
      if (typeof o.onBeat === "function") {
        try {
          o.onBeat(this.status());
        } catch (_) {
          // A broken listener must not stop the heartbeat.
        }
      }
    }, intervalMs);
    if (typeof this.heartbeatTimer.unref === "function") this.heartbeatTimer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = null;
    this.heartbeatTimer = null;
    return this;
  }
}

module.exports = { Watchdog, DEFAULT_INTERVAL_MS, DEFAULT_STALE_MS, hashFile };
