#!/usr/bin/env node
"use strict";

/**
 * scripts/prune-data.js — CLI wrapper around modules/data-prune.js.
 *
 * Used by scripts/install.sh so an install applies the same retention policy
 * as the normal start.js boot. All rules stay in the module; this file only
 * parses arguments and prints the result.
 *
 *   node scripts/prune-data.js
 *   node scripts/prune-data.js --data-dir ./data --keep-health 5 --keep-corrupt 1
 *   node scripts/prune-data.js --json
 */

const path = require("node:path");
const { pruneRuntimeArtifacts, DEFAULTS } = require("../modules/data-prune.js");

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "Usage: node scripts/prune-data.js [options]",
      "  --data-dir <path>    directory to prune (default: DATA_DIR or ./data)",
      `  --keep-health <n>    health reports to keep (default: ${DEFAULTS.keepHealth})`,
      `  --keep-corrupt <n>   corrupt DB snapshots to keep (default: ${DEFAULTS.keepCorrupt})`,
      "  --json               also print the full result as JSON",
    ].join("\n"),
  );
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const dataDir = path.resolve(
  root,
  valueAfter(argv, "--data-dir") || process.env.DATA_DIR || "data",
);
const keepHealth =
  valueAfter(argv, "--keep-health") === undefined
    ? undefined
    : valueAfter(argv, "--keep-health");
const keepCorrupt =
  valueAfter(argv, "--keep-corrupt") === undefined
    ? undefined
    : valueAfter(argv, "--keep-corrupt");

const result = pruneRuntimeArtifacts(dataDir, { keepHealth, keepCorrupt });
const state = result.skipped ? "skipped(missing)" : "ok";
console.log(
  `[PRUNE] ${state} dir=${result.dir} removed=${result.deleted.length} ` +
    `kept_health=${result.kept.health.length} kept_corrupt=${result.kept.corrupt.length} ` +
    `failed=${result.failed.length}`,
);
if (argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
if (result.failed.length > 0) {
  for (const item of result.failed) {
    console.error(`[PRUNE] failed ${item.file}: ${item.error}`);
  }
  process.exit(1);
}
