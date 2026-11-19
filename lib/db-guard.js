/**
 * db-guard.js — distinguish a transient SQLite lock from real corruption.
 *
 * WHY THIS EXISTS
 *   start.js used to rename models.db to models.db.corrupt-<ts> on ANY error
 *   from `PRAGMA quick_check`. A second gateway process holding the DB makes
 *   SQLite answer "database is locked" (SQLITE_BUSY); that is concurrency,
 *   not corruption. Renaming the file on a lock destroys the live database
 *   and every agent/model row in it. Evidence: logs/systemd-err.log lines
 *   1, 4 and 7 (three quarantines, all "database is locked").
 *
 *   The quarantine branch may only run for an actual corruption signal:
 *   SQLITE_CORRUPT / SQLITE_NOTADB, "database disk image is malformed",
 *   "file is not a database", or a failed integrity_check result.
 */
"use strict";

const BUSY_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);
const BUSY_ERRCODES = new Set([5, 6]); // SQLITE_BUSY, SQLITE_LOCKED
const CORRUPT_CODES = new Set(["SQLITE_CORRUPT", "SQLITE_NOTADB"]);
const CORRUPT_ERRCODES = new Set([11, 26]); // SQLITE_CORRUPT, SQLITE_NOTADB

function textOf(err) {
  if (!err) return "";
  return String(err.code || "") + " " + String(err.message || err);
}

function isBusyError(err) {
  if (!err) return false;
  if (BUSY_CODES.has(String(err.code))) return true;
  if (BUSY_ERRCODES.has(Number(err.errcode))) return true;
  return /database is locked|database table is locked|sqlite_busy|sqlite_locked/i.test(
    textOf(err),
  );
}

function isCorruptionError(err) {
  if (!err) return false;
  if (CORRUPT_CODES.has(String(err.code))) return true;
  if (CORRUPT_ERRCODES.has(Number(err.errcode))) return true;
  return /database disk image is malformed|file is not a database|not a database|malformed database|sqlite_corrupt|sqlite_notadb|integrity_check=/i.test(
    textOf(err),
  );
}

/**
 * @returns {"busy"|"corrupt"|"unknown"}
 */
function classifyDbError(err) {
  if (isBusyError(err)) return "busy";
  if (isCorruptionError(err)) return "corrupt";
  return "unknown";
}

module.exports = { classifyDbError, isBusyError, isCorruptionError };
