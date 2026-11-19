#!/usr/bin/env node
"use strict";

/*
 * Runtime data retention acceptance check.
 *
 * Proves:
 *   1. modules/data-prune.js keeps the newest N health reports and corrupt DB
 *      snapshots, deletes only the excess, and never touches real data
 *      (models.db, clients.json, mem-*.json, per-session JSON).
 *   2. A second run is idempotent.
 *   3. scripts/prune-data.js is a thin CLI over the same module.
 *   4. start.js calls that module at boot and scripts/install.sh calls the CLI;
 *      neither re-implements the rules, and api.js has no copy at all.
 *   5. After the live cleanup, data/ has no stale artifacts while the live
 *      database and session memory files are still there.
 *
 * Run: node tests/data-cleanup-check.js
 * Exit 0 prints DATA_CLEANUP_OK.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "data-cleanup-check-" + process.pid);
const TMP_CLI = path.join(TMP, "cli-data");
const LIVE_DATA = path.join(ROOT, "data");

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

function seed(dir, name, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes || name);
}

function names(dir) {
  return fs.readdirSync(dir).sort();
}

fs.rmSync(TMP, { recursive: true, force: true });
const dataDir = path.join(TMP, "data");
fs.mkdirSync(dataDir, { recursive: true });

for (const stamp of [1001, 1002, 1003, 1004, 1005, 1006, 1007]) {
  seed(dataDir, "health-check-" + stamp + ".json", "{}");
}
for (const stamp of [2001, 2002, 2003]) {
  seed(dataDir, "models.db.corrupt-" + stamp, "broken");
}
seed(dataDir, "models.db", "live-db");
seed(dataDir, "clients.json", "{}");
seed(dataDir, "mem-session-1.json", "{}");
seed(path.join(dataDir, "session-dir"), "code-guru.json", "[]");

const { pruneRuntimeArtifacts, DEFAULTS } = require(path.join(
  ROOT,
  "modules",
  "data-prune.js",
));

// ── 1. Retention ────────────────────────────────────────────
const first = pruneRuntimeArtifacts(dataDir, { keepHealth: 3, keepCorrupt: 1 });
check(
  "prune removes excess health reports and corrupt snapshots",
  first.deleted.length === 6,
  JSON.stringify(first.deleted),
);
check(
  "newest health reports are kept",
  JSON.stringify(first.kept.health) ===
    JSON.stringify([
      "health-check-1007.json",
      "health-check-1006.json",
      "health-check-1005.json",
    ]),
  JSON.stringify(first.kept.health),
);
check(
  "newest corrupt snapshot is kept",
  JSON.stringify(first.kept.corrupt) === JSON.stringify(["models.db.corrupt-2003"]),
  JSON.stringify(first.kept.corrupt),
);

const after = names(dataDir);
check(
  "exactly the retained artifacts remain",
  after.filter((n) => n.startsWith("health-check-")).length === 3 &&
    after.filter((n) => n.startsWith("models.db.corrupt-")).length === 1,
  after.join(","),
);
for (const protectedName of [
  "models.db",
  "clients.json",
  "mem-session-1.json",
  "session-dir",
]) {
  check(
    "protected entry kept: " + protectedName,
    fs.existsSync(path.join(dataDir, protectedName)),
  );
}

// ── 2. Idempotent ───────────────────────────────────────────
const second = pruneRuntimeArtifacts(dataDir, { keepHealth: 3, keepCorrupt: 1 });
check("second prune deletes nothing", second.deleted.length === 0, JSON.stringify(second.deleted));

// ── 3. Missing directory and CLI ────────────────────────────
const missing = pruneRuntimeArtifacts(path.join(TMP, "never-existed"));
check("missing data dir is skipped without throwing", missing.skipped === true);

for (let i = 1; i <= 5; i++) seed(TMP_CLI, "health-check-" + (3000 + i) + ".json", "{}");
seed(TMP_CLI, "models.db.corrupt-4001", "broken");
seed(TMP_CLI, "models.db", "live-db");
const cli = spawnSync(
  process.execPath,
  [
    path.join(ROOT, "scripts", "prune-data.js"),
    "--data-dir",
    TMP_CLI,
    "--keep-health",
    "2",
    "--keep-corrupt",
    "0",
    "--json",
  ],
  { encoding: "utf8" },
);
check("prune-data.js exits 0", cli.status === 0, "status=" + cli.status + " stderr=" + cli.stderr.trim());
let cliJson = null;
try {
  cliJson = JSON.parse(cli.stdout.slice(cli.stdout.indexOf("{")));
} catch (_) {
  cliJson = null;
}
check(
  "prune-data.js reports the same module result",
  cliJson && cliJson.deleted.length === 4 &&
    cliJson.kept.health.length === 2 &&
    cliJson.kept.corrupt.length === 0,
  cliJson && JSON.stringify({ deleted: cliJson.deleted, kept: cliJson.kept }),
);
check(
  "CLI keeps the live DB",
  fs.existsSync(path.join(TMP_CLI, "models.db")),
);

// ── 4. Single implementation wiring ─────────────────────────
const startSrc = fs.readFileSync(path.join(ROOT, "start.js"), "utf8");
const apiSrc = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const installSrc = fs.readFileSync(path.join(ROOT, "scripts", "install.sh"), "utf8");
const cliSrc = fs.readFileSync(path.join(ROOT, "scripts", "prune-data.js"), "utf8");

check(
  "start.js calls modules/data-prune at boot",
  /require\("\.\/modules\/data-prune"\)/.test(startSrc) &&
    /pruneRuntimeArtifacts\(projectDataDir\(\)\)/.test(startSrc),
);
check(
  "install.sh runs the shared prune CLI",
  installSrc.includes("scripts/prune-data.js") &&
    /prune_runtime\nstart_stack/.test(installSrc),
);
check(
  "CLI delegates to the module (no local rules)",
  cliSrc.includes('require("../modules/data-prune.js")') &&
    !cliSrc.includes("HEALTH_PATTERN") &&
    !cliSrc.includes("unlinkSync"),
);
check(
  "api.js has no duplicate prune logic",
  !apiSrc.includes("pruneRuntimeArtifacts") &&
    !apiSrc.includes("models.db.corrupt-") &&
    !apiSrc.includes("health-check-"),
);
check(
  "module owns both artifact patterns",
  DEFAULTS.keepHealth === 5 &&
    DEFAULTS.keepCorrupt === 1 &&
    /health-check-\(\\d\+\)/.test(fs.readFileSync(path.join(ROOT, "modules", "data-prune.js"), "utf8")),
);

// ── 5. Live data directory ─────────────────────────────────
const live = fs.existsSync(LIVE_DATA) ? fs.readdirSync(LIVE_DATA) : [];
const liveHealth = live.filter((n) => /^health-check-\d+\.json$/.test(n));
const liveCorrupt = live.filter((n) => /^models\.db\.corrupt-\d+$/.test(n));
check(
  "live data/ has at most the health retention limit",
  liveHealth.length <= DEFAULTS.keepHealth,
  "health=" + liveHealth.length,
);
check(
  "live data/ has at most the corrupt retention limit",
  liveCorrupt.length <= DEFAULTS.keepCorrupt,
  "corrupt=" + liveCorrupt.length,
);
check(
  "live models.db is intact",
  fs.existsSync(path.join(LIVE_DATA, "models.db")),
);
check(
  "live clients.json is intact",
  fs.existsSync(path.join(LIVE_DATA, "clients.json")),
);
const liveMem = live.filter((n) => n.startsWith("mem-") && n.endsWith(".json"));
check("live mem-*.json session memory is intact", liveMem.length > 0, "files=" + liveMem.length);
const liveSessionDirs = live.filter((n) => {
  const full = path.join(LIVE_DATA, n);
  try {
    return fs.statSync(full).isDirectory() && fs.readdirSync(full).some((f) => f.endsWith(".json"));
  } catch (_) {
    return false;
  }
});
check(
  "live per-session JSON dirs are intact",
  liveSessionDirs.length > 0,
  "dirs=" + liveSessionDirs.length,
);

console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
if (fail > 0) {
  console.log("DATA_CLEANUP_FAIL");
  process.exit(1);
}
console.log("DATA_CLEANUP_OK");
