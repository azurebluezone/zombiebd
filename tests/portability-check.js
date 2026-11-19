#!/usr/bin/env node
"use strict";

/*
 * Code-level portability acceptance check.
 *
 * Proves:
 *   1. No tracked source or test file hardcodes a machine home directory.
 *   2. A fresh copy of the tracked tree (no .env, no dist, no node_modules)
 *      runs tests/path-resolver-check.js successfully.
 *   3. That copy resolves APP_ROOT, DB and UDS inside itself and honors a
 *      different PORT (5599), so two checkouts never share runtime state.
 *   4. scripts/check-env.js passes in the copy with that alternate port.
 *
 * The copy is built from `git ls-files` + the working-tree bytes, exactly
 * what a clone of the committed tree would contain after the fix.
 *
 * Run: node tests/portability-check.js
 * Exit 0 prints PORTABILITY_OK.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TEST_ROOT = process.env.TEST_DIR || os.tmpdir();

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " :: " + detail : ""));
  } else {
    fail += 1;
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

function inside(root, candidate, suffix) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === path.join.apply(path, suffix);
}

// ─── 1. No machine-home literal in tracked code or tests ───────────────
const SCAN_PATHS = [
  "api.js",
  "start.js",
  "local-llm-bridge.js",
  "cdp-pipe.js",
  "lib",
  "modules",
  "scripts",
  "tests",
  "transport",
  "provider",
  "external mcp",
];
// /home/<user> or /Users/<user> only; regex text itself never matches
// because the next character there is '|' or '['.
const HOME_PATTERN = "(/home/|/Users/)[A-Za-z0-9._-]+";
const grep = spawnSync(
  "git",
  ["grep", "-n", "-I", "-E", HOME_PATTERN, "--", ...SCAN_PATHS],
  { cwd: ROOT, encoding: "utf8" },
);
check(
  "no tracked source/test file hardcodes a machine home path",
  grep.status === 1 && !grep.stdout.trim(),
  grep.status === 0
    ? grep.stdout.trim().split("\n").slice(0, 5).join(" | ")
    : grep.status === 1
      ? "0 matches"
      : "git grep failed status=" + grep.status + " " + grep.stderr.trim(),
);

// ─── 2. Copy the tracked working tree to a fresh directory ─────────────
const listed = spawnSync("git", ["ls-files", "-z"], {
  cwd: ROOT,
  encoding: "buffer",
  maxBuffer: 64 * 1024 * 1024,
});
check("git ls-files succeeds", listed.status === 0, "status=" + listed.status);

let copyRoot = "";
try {
  copyRoot = fs.mkdtempSync(path.join(TEST_ROOT, "zbd-portability-"));
  const tracked = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const rel of tracked) {
    const source = path.join(ROOT, rel);
    const target = path.join(copyRoot, rel);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  check(
    "tracked tree copies without .env, dist or node_modules",
    tracked.length > 100 &&
      tracked.includes("api.js") &&
      tracked.includes("tests/path-resolver-check.js") &&
      !fs.existsSync(path.join(copyRoot, ".env")) &&
      !fs.existsSync(path.join(copyRoot, "dist")) &&
      !fs.existsSync(path.join(copyRoot, "node_modules")),
    "files=" + tracked.length,
  );

  const clonedEnv = Object.assign({}, process.env, {
    PORT: "5599",
    APP_ROOT: "",
    DATA_DIR: "",
    LOG_DIR: "",
    CACHE_DIR: "",
    TMP_DIR: "",
    DB_SQLITE_PATH: "",
    UDS: "",
    UDS_OPENAI: "",
  });
  delete clonedEnv.TEST_DIR;

  // ─── 3. The resolver acceptance runs inside the copy ────────────────
  const resolver = spawnSync(
    process.execPath,
    [path.join(copyRoot, "tests", "path-resolver-check.js")],
    { cwd: copyRoot, env: clonedEnv, encoding: "utf8", timeout: 60000 },
  );
  check(
    "path resolver check passes in the copied tree",
    resolver.status === 0 && resolver.stdout.includes("PATH_RESOLVER_OK"),
    "status=" + resolver.status,
  );
  if (resolver.status !== 0) {
    console.error((resolver.stdout || "").split("\n").slice(-8).join("\n"));
    console.error((resolver.stderr || "").slice(0, 1200));
  }

  // ─── 4. The copy gets its own APP_ROOT, DB, UDS and PORT ────────────
  const probe = [
    'const env = require("./lib/env.js").loadEnv({ root: process.cwd() });',
    "console.log(JSON.stringify({",
    "  appRoot: env.paths.appRoot,",
    "  dataDir: env.paths.dataDir,",
    "  logDir: env.paths.logDir,",
    "  dbPath: env.paths.dbPath,",
    "  udsPath: env.derived.udsPath,",
    "  port: env.ports.api,",
    "}));",
  ].join("\n");
  const resolvedProbe = spawnSync(process.execPath, ["-e", probe], {
    cwd: copyRoot,
    env: clonedEnv,
    encoding: "utf8",
    timeout: 30000,
  });
  let resolved = null;
  let probeError = "";
  try {
    const lines = (resolvedProbe.stdout || "").trim().split("\n");
    resolved = JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    probeError = error.message + " stderr=" + (resolvedProbe.stderr || "").slice(0, 400);
  }
  check(
    "copied tree resolves its own APP_ROOT",
    Boolean(resolved) &&
      fs.realpathSync(resolved.appRoot) === fs.realpathSync(copyRoot),
    probeError || (resolved && resolved.appRoot),
  );
  check(
    "copied tree resolves its own data and log directories",
    Boolean(resolved) &&
      inside(copyRoot, resolved.dataDir, ["data"]) &&
      inside(copyRoot, resolved.logDir, ["logs"]),
    resolved ? resolved.dataDir + " " + resolved.logDir : "unresolved",
  );
  check(
    "copied tree resolves its own database",
    Boolean(resolved) &&
      inside(copyRoot, resolved.dbPath, ["data", "models.db"]),
    resolved ? resolved.dbPath : "unresolved",
  );
  check(
    "copied tree resolves its own UDS socket",
    Boolean(resolved) &&
      inside(copyRoot, resolved.udsPath, ["data", "run", "mcp.sock"]),
    resolved ? resolved.udsPath : "unresolved",
  );
  check(
    "copied tree honors the alternate PORT",
    Boolean(resolved) && resolved.port === 5599,
    resolved ? "port=" + resolved.port : "unresolved",
  );

  const primaryDb = path.join(ROOT, "data", "models.db");
  const primaryUds = path.join(ROOT, "data", "run", "mcp.sock");
  check(
    "two checkouts do not share database or socket state",
    Boolean(resolved) &&
      path.resolve(resolved.dbPath) !== path.resolve(primaryDb) &&
      path.resolve(resolved.udsPath) !== path.resolve(primaryUds),
    resolved ? resolved.dbPath : "unresolved",
  );

  // ─── 5. Env validation also passes in the copy ──────────────────────
  const envCheck = spawnSync(
    process.execPath,
    [path.join(copyRoot, "scripts", "check-env.js")],
    { cwd: copyRoot, env: clonedEnv, encoding: "utf8", timeout: 30000 },
  );
  check(
    "env validation passes in the copied tree",
    envCheck.status === 0 && (envCheck.stdout || "").includes("ENV_OK"),
    "status=" + envCheck.status,
  );
} finally {
  if (copyRoot) fs.rmSync(copyRoot, { recursive: true, force: true });
}

// ─── Summary ───────────────────────────────────────────────────────────
console.log("");
console.log("checks: " + (pass + fail) + " pass=" + pass + " fail=" + fail);
if (fail > 0) {
  console.error("PORTABILITY_FAIL");
  for (const item of failures) console.error(" - " + item);
  process.exit(1);
}
console.log("PORTABILITY_OK");
