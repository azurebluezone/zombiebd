#!/usr/bin/env node
"use strict";

/**
 * tests/bootstrap-check.js
 *
 * Proves the one-line root installer without touching the system:
 *   1. install.sh parses and contains the clone + delegate contract.
 *   2. --help prints the one-line usage.
 *   3. --check is read-only and prints BOOTSTRAP_CHECK_OK.
 *   4. --clone-only clones a real checkout from a local file:// remote and
 *      finds scripts/install.sh inside it.
 *
 * Prints BOOTSTRAP_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "bootstrap-check-" + process.pid);
const INSTALLER = path.join(ROOT, "install.sh");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("PASS " + name);
  } catch (error) {
    failed++;
    console.log("FAIL " + name + " — " + (error && error.message ? error.message : error));
  }
}

function run(args, options) {
  return spawnSync("bash", args, Object.assign({
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  }, options || {}));
}

fs.mkdirSync(TMP, { recursive: true });
try {
  check("install.sh exists, parses and owns the clone/delegate contract", () => {
    const source = fs.readFileSync(INSTALLER, "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env bash"), "missing bash shebang");
    assert.ok(source.includes("BOOTSTRAP_CLONE_OK"), "clone marker missing");
    assert.ok(source.includes("BOOTSTRAP_CHECK_OK"), "check marker missing");
    assert.ok(source.includes("scripts/install.sh"), "installer delegation missing");
    const result = run(["-n", INSTALLER]);
    assert.strictEqual(result.status, 0, result.stderr);
  });

  check("--help prints the one-line usage", () => {
    const result = run([INSTALLER, "--help"]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(/curl -fsSL/.test(result.stdout), result.stdout);
    assert.ok(/TARGET_DIR/.test(result.stdout), result.stdout);
  });

  check("--check is read-only and prints BOOTSTRAP_CHECK_OK", () => {
    const target = path.join(TMP, "check-target");
    const result = run([INSTALLER, "--check"], {
      env: Object.assign({}, process.env, { ZC_TARGET: target }),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("BOOTSTRAP_CHECK_OK"), result.stdout);
    assert.ok(!fs.existsSync(target), "--check created the target directory");
  });

  check("--clone-only clones a real checkout from a local remote", () => {
    const target = path.join(TMP, "clone-target");
    const result = run([INSTALLER, "--clone-only"], {
      env: Object.assign({}, process.env, {
        ZC_TARGET: target,
        ZC_REPO_URL: "file://" + ROOT,
      }),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes("BOOTSTRAP_CLONE_OK"), result.stdout);
    assert.ok(
      fs.existsSync(path.join(target, "scripts", "install.sh")),
      "scripts/install.sh missing in the clone",
    );
    assert.ok(
      fs.existsSync(path.join(target, "package.json")),
      "package.json missing in the clone",
    );
  });
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log("\nRESULT: " + passed + " passed, " + failed + " failed");
if (failed) process.exit(1);
console.log("BOOTSTRAP_OK");
