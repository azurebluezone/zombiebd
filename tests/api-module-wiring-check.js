#!/usr/bin/env node
"use strict";

/**
 * tests/api-module-wiring-check.js
 *
 * API_MODULE_WIRING_OK — proves the 2026-11-25 module-wiring pass:
 *   1. api.js consumes lib/net.js instead of keeping a third loopback copy.
 *   2. The shared definition still recognises every loopback spelling and
 *      rejects public hosts (real require, not a source copy).
 *   3. api.js is smaller than the 19,763-line baseline and parses.
 *   4. The owning entrypoints' authentic tests still pass:
 *      ENV_LOADER_OK and BRIDGE_DISCOVERY_OK.
 *   5. The audit report records a decision for every tested module that
 *      api.js does not import directly.
 *
 * Run: node tests/api-module-wiring-check.js
 * Exit 0 + API_MODULE_WIRING_OK only when every assertion passes.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log("PASS " + name);
  } catch (error) {
    fail += 1;
    console.log("FAIL " + name + " :: " + error.message);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function run(rel, marker, extraArgs) {
  const args = (extraArgs || []).concat([path.join(ROOT, rel)]);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90000,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  assert.strictEqual(
    result.status,
    0,
    rel + " exited " + result.status + "\n" + output.slice(-1200),
  );
  assert.ok(output.includes(marker), rel + " did not print " + marker);
}

const api = read("api.js");
const apiLines = api.endsWith("\n")
  ? api.split("\n").length - 1
  : api.split("\n").length;

// ── 1. api.js consumes the one loopback definition ─────────────────────
check("api.js requires lib/net.js", () => {
  assert.ok(/require\(\s*["']\.\/lib\/net\.js["']\s*\)/.test(api));
});

check("api.js uses the shared isLoopbackHost definition", () => {
  assert.ok(/isLoopbackHost\s*\(/.test(api), "isLoopbackHost is not called");
  assert.ok(/normalizeHost\s*\(/.test(api), "normalizeHost is not called");
});

check("api.js has no private LOOPBACK_HOSTNAMES set", () => {
  assert.ok(!api.includes("LOOPBACK_HOSTNAMES"), "private set remains");
});

check("api.js has no inline 127/8 regex", () => {
  assert.ok(!api.includes("127(?:\\."), "inline 127/8 regex remains");
});

check("api.js has no inline IPv4-mapped loopback literals", () => {
  assert.ok(
    !api.includes("::ffff:127.0.0.1") &&
      !api.includes("0:0:0:0:0:0:0:1"),
    "inline mapped-loopback literal remains",
  );
});

check("api.js is smaller than the 19,763-line baseline", () => {
  assert.ok(apiLines < 19763, "api.js is " + apiLines + " lines");
});

check("api.js parses", () => {
  run("api.js", "", ["--check"]);
});

// ── 2. The shared definition still behaves ────────────────────────────
const net = require(path.join(ROOT, "lib", "net.js"));

check("shared loopback definition covers every spelling", () => {
  for (const host of [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "127.0.0.1",
    "127.0.0.2",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
  ]) {
    assert.ok(net.isLoopbackHost(host), "rejected " + host);
  }
  for (const host of [
    "10.0.0.1",
    "example.com",
    "127.0.0.1.evil.test",
    "",
  ]) {
    assert.ok(!net.isLoopbackHost(host), "accepted " + host);
  }
});

// ── 3. Owning entrypoints keep their authentic tests green ────────────
check("env loader contract still passes", () => {
  run("tests/env-loader-check.js", "ENV_LOADER_OK");
});

check("bridge discovery contract still passes", () => {
  run("tests/bridge-discovery-check.js", "BRIDGE_DISCOVERY_OK");
});

// ── 4. Every tested-but-not-directly-imported module has a decision ───
const report = read(path.join("docs", "AUDIT-APIJS-2026-11-23.md"));
const decisions = [
  "lib/net.js",
  "lib/bridge-upstreams.js",
  "modules/config.js",
  "modules/data-prune.js",
  "modules/edge-proxy.js",
  "modules/sessions.js",
  "modules/skill-db.js",
  "modules/skill-parser.js",
];

check("audit report records a wiring decision for all eight modules", () => {
  const missing = decisions.filter(
    (name) => !report.includes("`" + name + "`"),
  );
  assert.deepStrictEqual(missing, [], "missing: " + missing.join(", "));
});

console.log(
  "\nRESULT: " +
    (fail === 0 ? "API_MODULE_WIRING_OK" : "API_MODULE_WIRING_FAIL") +
    " pass=" +
    pass +
    " fail=" +
    fail,
);
process.exitCode = fail === 0 ? 0 : 1;
