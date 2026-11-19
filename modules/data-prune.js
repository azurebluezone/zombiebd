"use strict";

/**
 * modules/data-prune.js — bounded retention for runtime data artifacts.
 *
 * The gateway writes one health report per boot and quarantines a corrupt
 * database as `models.db.corrupt-<ms>`. Both are diagnostic snapshots, not
 * project data, and previously grew without limit inside `data/`.
 *
 * This module is the single implementation of that retention policy. start.js
 * (normal boot), scripts/prune-data.js (installer/CLI) and the acceptance
 * check all call it; no caller keeps its own copy of the rules.
 *
 * Protected files are never touched: only names matching the two artifact
 * patterns are candidates, and only regular files are removed.
 */

const fs = require("fs");
const path = require("path");

const HEALTH_PATTERN = /^health-check-(\d+)\.json$/;
const CORRUPT_PATTERN = /^models\.db\.corrupt-(\d+)$/;

const DEFAULTS = Object.freeze({
  keepHealth: 5,
  keepCorrupt: 1,
});

function count(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function stampFromName(name, pattern) {
  const match = name.match(pattern);
  return match ? Number(match[1]) : 0;
}

function candidates(entries, pattern) {
  return entries
    .filter((entry) => pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, stamp: stampFromName(entry.name, pattern) }))
    .sort((a, b) => b.stamp - a.stamp || b.name.localeCompare(a.name));
}

function removeAll(dir, items, deleted, failed) {
  for (const item of items) {
    try {
      fs.unlinkSync(path.join(dir, item.name));
      deleted.push(item.name);
    } catch (err) {
      failed.push({ file: item.name, error: err.message });
    }
  }
}

/**
 * Delete runtime artifacts beyond the retention window.
 *
 * @param {string} dataDir directory that holds `models.db` and its artifacts
 * @param {{keepHealth?: number, keepCorrupt?: number}} [options]
 * @returns {{dir: string, skipped: boolean, deleted: string[],
 *            kept: {health: string[], corrupt: string[]},
 *            failed: Array<{file: string, error: string}>}}
 */
function pruneRuntimeArtifacts(dataDir, options) {
  const opts = options || {};
  const dir = path.resolve(
    String(dataDir || process.env.DATA_DIR || path.join(__dirname, "..", "data")),
  );
  const result = {
    dir,
    skipped: false,
    deleted: [],
    kept: { health: [], corrupt: [] },
    failed: [],
  };

  if (!fs.existsSync(dir)) {
    result.skipped = true;
    return result;
  }

  const keepHealth = count(opts.keepHealth, DEFAULTS.keepHealth);
  const keepCorrupt = count(opts.keepCorrupt, DEFAULTS.keepCorrupt);

  let entries;
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile());
  } catch (err) {
    result.failed.push({ file: dir, error: err.message });
    return result;
  }

  const health = candidates(entries, HEALTH_PATTERN);
  const corrupt = candidates(entries, CORRUPT_PATTERN);
  result.kept.health = health.slice(0, keepHealth).map((entry) => entry.name);
  result.kept.corrupt = corrupt.slice(0, keepCorrupt).map((entry) => entry.name);

  removeAll(dir, health.slice(keepHealth), result.deleted, result.failed);
  removeAll(dir, corrupt.slice(keepCorrupt), result.deleted, result.failed);
  return result;
}

module.exports = {
  DEFAULTS,
  HEALTH_PATTERN,
  CORRUPT_PATTERN,
  pruneRuntimeArtifacts,
};
