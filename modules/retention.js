"use strict";

/**
 * modules/retention.js — bounded retention for logs and agent backups.
 *
 * `logs/` and `.zombiecoder/.state/backups/` are diagnostic history, not
 * project data. They grew to tens of megabytes with no policy. This module is
 * the single implementation of that policy; start.js (boot) and the quality
 * eval both call it, so no caller keeps its own copy of the rules.
 *
 * Safety rules:
 *   - Only regular files whose names match a known pattern are candidates.
 *   - The active log files are never deleted, no matter their size.
 *   - A daily log for today is never deleted by the byte cap.
 *   - `models.db` and every other unknown file are never touched.
 *   - dryRun reports candidates and deletes nothing.
 */

const fs = require("fs");
const path = require("path");

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = Object.freeze({
  logDays: 14,
  logMaxBytes: 50 * 1024 * 1024,
  backupDays: 7,
  backupMaxFiles: 100,
});

// Daily rotating log written by the gateway: 2026-11-20.log
const DAILY_LOG = /^(\d{4})-(\d{2})-(\d{2})\.log$/;
// Explicit rotated files only. The unnumbered active file is in ACTIVE_LOGS.
const ROTATED_LOG = /^(?:zc\.jsonl|systemd-out\.log|systemd-err\.log|gateway\.log)\.(\d+)$/;
// Agent backup names: 2026-11-20T10-08-42-331Z-RUNBOOK.md
const BACKUP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/;

const ACTIVE_LOGS = new Set([
  "zc.jsonl",
  "systemd-out.log",
  "systemd-err.log",
  "gateway.log",
]);

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function startOfUtcDay(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dailyLogName(ms) {
  return new Date(ms).toISOString().slice(0, 10) + ".log";
}

function dailyStamp(name) {
  const match = String(name).match(DAILY_LOG);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function backupStamp(name) {
  const match = String(name).match(BACKUP);
  if (!match) return 0;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
}

function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

function statOf(dir, name) {
  try {
    return fs.statSync(path.join(dir, name));
  } catch (_) {
    return null;
  }
}

function removeFile(dir, name, dryRun, deleted, candidates, failed) {
  if (dryRun) {
    candidates.push(name);
    return;
  }
  try {
    fs.unlinkSync(path.join(dir, name));
    deleted.push(name);
  } catch (err) {
    failed.push({ file: name, error: err.message });
  }
}

/**
 * Prune daily logs and explicit rotated logs.
 *
 * @param {string} logsDir
 * @param {{logDays?: number, logMaxBytes?: number, dryRun?: boolean, now?: number}} [options]
 */
function pruneLogs(logsDir, options) {
  const opts = options || {};
  const dir = path.resolve(String(logsDir || path.join(__dirname, "..", "logs")));
  const dryRun = opts.dryRun === true;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const logDays = positive(opts.logDays, DEFAULTS.logDays);
  const maxBytes = positive(opts.logMaxBytes, DEFAULTS.logMaxBytes);
  const cutoff = now - logDays * DAY_MS;
  const today = startOfUtcDay(now);
  const active = new Set([...ACTIVE_LOGS, dailyLogName(now)]);

  const result = {
    dir,
    dryRun,
    deleted: [],
    candidates: [],
    kept: [],
    bytesBefore: 0,
    bytesAfter: 0,
    failed: [],
  };

  const records = listFiles(dir).map((name) => {
    const stat = statOf(dir, name);
    return {
      name,
      size: stat ? stat.size : 0,
      mtime: stat ? stat.mtimeMs : 0,
      daily: dailyStamp(name),
      rotated: ROTATED_LOG.test(name),
      active: active.has(name),
    };
  });
  result.bytesBefore = records.reduce((sum, record) => sum + record.size, 0);

  // 1) Age policy: old daily logs and old rotated files.
  const byAge = records
    .filter(
      (record) =>
        !record.active &&
        ((record.daily && record.daily < cutoff) ||
          (record.rotated && record.mtime < cutoff)),
    )
    .sort((a, b) => a.daily + a.mtime - (b.daily + b.mtime));

  for (const record of byAge) {
    removeFile(dir, record.name, dryRun, result.deleted, result.candidates, result.failed);
  }

  // 2) Byte policy: oldest rotated files first, then old daily logs. The
  //    active files and today's daily log are excluded from this pass.
  const removed = new Set([...result.deleted, ...result.candidates]);
  let total = records
    .filter((record) => !removed.has(record.name))
    .reduce((sum, record) => sum + record.size, 0);

  const byBytes = records
    .filter(
      (record) =>
        !record.active &&
        !removed.has(record.name) &&
        (record.rotated || (record.daily && record.daily < today)),
    )
    .sort((a, b) => a.daily + a.mtime - (b.daily + b.mtime));

  for (const record of byBytes) {
    if (total <= maxBytes) break;
    removeFile(dir, record.name, dryRun, result.deleted, result.candidates, result.failed);
    total -= record.size;
  }

  result.bytesAfter = Math.max(0, total);
  result.kept = listFiles(dir);
  return result;
}

/**
 * Keep the newest `backupMaxFiles` backups that are also inside `backupDays`.
 * The newest backup is always kept.
 */
function pruneBackups(backupsDir, options) {
  const opts = options || {};
  const dir = path.resolve(
    String(backupsDir || path.join(__dirname, "..", ".zombiecoder", ".state", "backups")),
  );
  const dryRun = opts.dryRun === true;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const backupDays = positive(opts.backupDays, DEFAULTS.backupDays);
  const maxFiles = Math.max(1, positive(opts.backupMaxFiles, DEFAULTS.backupMaxFiles));
  const cutoff = now - backupDays * DAY_MS;

  const result = {
    dir,
    dryRun,
    deleted: [],
    candidates: [],
    kept: [],
    bytesBefore: 0,
    bytesAfter: 0,
    failed: [],
  };

  const records = listFiles(dir)
    .map((name) => {
      const stat = statOf(dir, name);
      return { name, size: stat ? stat.size : 0, stamp: backupStamp(name) };
    })
    .filter((record) => record.stamp > 0)
    .sort((a, b) => b.stamp - a.stamp || b.name.localeCompare(a.name));

  result.bytesBefore = records.reduce((sum, record) => sum + record.size, 0);
  let total = result.bytesBefore;

  records.forEach((record, index) => {
    const tooMany = index >= maxFiles;
    const tooOld = record.stamp < cutoff;
    if (!tooMany && !tooOld) {
      result.kept.push(record.name);
      return;
    }
    removeFile(dir, record.name, dryRun, result.deleted, result.candidates, result.failed);
    total -= record.size;
  });

  result.bytesAfter = Math.max(0, total);
  return result;
}

/**
 * Run both policies. Defaults are relative to the project root, so the boot
 * hook and the eval call the same code with no duplicated paths.
 */
function pruneRetention(options) {
  const opts = options || {};
  const root = opts.root ? path.resolve(String(opts.root)) : path.resolve(__dirname, "..");
  const logs = pruneLogs(opts.logsDir || path.join(root, "logs"), opts);
  const backups = pruneBackups(
    opts.backupsDir || path.join(root, ".zombiecoder", ".state", "backups"),
    opts,
  );
  return {
    dryRun: opts.dryRun === true,
    logs,
    backups,
    deleted: logs.deleted.length + backups.deleted.length,
    candidates: logs.candidates.length + backups.candidates.length,
  };
}

function formatRetentionLine(summary) {
  const s = summary || {};
  const logs = s.logs || { deleted: [], candidates: [], bytesBefore: 0, bytesAfter: 0 };
  const backups = s.backups || { deleted: [], candidates: [] };
  return (
    "RETENTION_PRUNED logs=" +
    logs.deleted.length +
    " backups=" +
    backups.deleted.length +
    " candidates=" +
    (logs.candidates.length + backups.candidates.length) +
    " dry=" +
    (s.dryRun ? "1" : "0") +
    " bytes=" +
    (logs.bytesBefore || 0) +
    "->" +
    (logs.bytesAfter || 0)
  );
}

module.exports = {
  DEFAULTS,
  DAY_MS,
  DAILY_LOG,
  ROTATED_LOG,
  BACKUP,
  ACTIVE_LOGS,
  dailyLogName,
  dailyStamp,
  backupStamp,
  pruneLogs,
  pruneBackups,
  pruneRetention,
  formatRetentionLine,
};
