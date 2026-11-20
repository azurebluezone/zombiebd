#!/usr/bin/env node
"use strict";

/**
 * tests/test-app-root-check.js
 *
 * Runbook N2 — a test-spawned gateway must never write the live project's
 * `.missionbarisal` config. `api.js` anchors that directory at
 * RUNTIME_PATHS.appRoot, so every test that spawns api.js has to pass an
 * APP_ROOT (or an explicit MISSIONBARISAL_DIR) pointing at its own temp dir.
 *
 * The gate:
 *   1. Scans tests/*.js for the api.js spawn form and requires APP_ROOT or
 *      MISSIONBARISAL_DIR in every match; the four known offenders must use
 *      `APP_ROOT: TMP`.
 *   2. Hashes the live .missionbarisal/mcp-config.json.
 *   3. Runs the four previously polluting suites in parallel (bounded time).
 *      Their exit codes may be red for unrelated pre-existing reasons; what
 *      this gate owns is that each one really executed and that the live
 *      config hash is byte-identical afterwards.
 *   4. node --check on the four edited tests and this file.
 *
 * Prints TEST_APP_ROOT_OK only when all checks pass.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const LIVE_CONFIG = path.join(ROOT, ".missionbarisal", "mcp-config.json");
const SUITE_TIMEOUT_MS = 100000;

const TARGETS = [
  "tests/provider-suite-check.js",
  "tests/transport-suite.js",
  "tests/cwd-db-repair-check.js",
  "tests/provider-matrix-check.js",
];

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failed++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

async function expectAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function liveHash() {
  return fs.existsSync(LIVE_CONFIG) ? sha256(LIVE_CONFIG) : null;
}

// The exact spawn shape used by every gateway-spawning test today:
//   spawn(process.execPath, [path.join(ROOT, "api.js")], { ... })
const SPAWN_RE =
  /spawn\(\s*process\.execPath\s*,\s*\[\s*path\.join\(\s*ROOT\s*,\s*"api\.js"\s*\)\s*\]/;

function spawners() {
  return fs
    .readdirSync(path.join(ROOT, "tests"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => "tests/" + name)
    .filter((rel) => SPAWN_RE.test(fs.readFileSync(path.join(ROOT, rel), "utf8")));
}

function runSuite(rel) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SUITE_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        rel,
        code,
        signal,
        timedOut,
        elapsed: Date.now() - started,
        output,
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        rel,
        code: null,
        signal: null,
        timedOut: false,
        elapsed: Date.now() - started,
        output: "spawn error: " + error.message,
      });
    });
  });
}

(async () => {
  const files = spawners();

  await expectAsync("every api.js spawn isolates APP_ROOT", async () => {
    assert.ok(files.length >= 8, "spawn scan found only " + files.length + " files");
    const missing = [];
    for (const rel of files) {
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const hasRoot = /\bAPP_ROOT\s*:/.test(source);
      const hasMissionDir = /\bMISSIONBARISAL_DIR\s*:/.test(source);
      const inheritedRoot = /\bAPP_ROOT\s*:\s*process\.env\.APP_ROOT\b/.test(source);
      if ((!hasRoot && !hasMissionDir) || inheritedRoot) missing.push(rel);
    }
    assert.deepStrictEqual(missing, [], "not isolated: " + missing.join(", "));
  });

  await expectAsync("the four known offenders pin APP_ROOT to their temp root", async () => {
    for (const rel of TARGETS) {
      assert.ok(files.includes(rel), rel + " no longer spawns api.js");
      const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(
        /\bAPP_ROOT\s*:\s*TMP\b/.test(source),
        rel + " does not set APP_ROOT: TMP",
      );
    }
  });

  await expectAsync("edited tests and this gate parse", async () => {
    for (const rel of [...TARGETS, "tests/test-app-root-check.js"]) {
      const result = spawnSync(process.execPath, ["--check", path.join(ROOT, rel)], {
        cwd: ROOT,
        encoding: "utf8",
      });
      assert.strictEqual(
        result.status,
        0,
        rel + ": " + String(result.stderr || "").slice(0, 240),
      );
    }
  });

  const before = liveHash();
  console.log(
    "live mcp-config before: " + (before ? before.slice(0, 16) : "absent"),
  );

  await expectAsync("the four suites run and the live config is untouched", async () => {
    const results = await Promise.all(TARGETS.map(runSuite));
    for (const result of results) {
      assert.ok(
        result.output.trim().length > 0,
        result.rel + " produced no output (did not execute)",
      );
      assert.notStrictEqual(
        result.code,
        null,
        result.rel + " did not exit (spawn failed): " + result.output.slice(-300),
      );
      console.log(
        "  ran " +
          result.rel +
          " exit=" +
          result.code +
          (result.timedOut ? " (timeout " + SUITE_TIMEOUT_MS + "ms)" : "") +
          " in " +
          result.elapsed +
          "ms",
      );
    }
    const after = liveHash();
    console.log(
      "live mcp-config after:  " + (after ? after.slice(0, 16) : "absent"),
    );
    assert.strictEqual(
      after,
      before,
      "the live .missionbarisal/mcp-config.json changed during test runs",
    );
  });
})()
  .catch((error) => {
    console.error(
      "TEST_APP_ROOT_FAILED — " + (error && error.stack ? error.stack : error),
    );
    process.exit(1);
  })
  .finally(() => {
    console.log("\npassed=" + passed + " failed=" + failed);
    if (failed > 0) {
      console.error("TEST_APP_ROOT_FAILED");
      process.exit(1);
    }
    console.log("TEST_APP_ROOT_OK");
  });
