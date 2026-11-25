#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: release readiness gate (runbook row 19, Phase E)
// =============================================================================
// One command for the release proof: rebuild check, syntax, the deterministic
// regression manifest, docs/package/quality gates, source==dist, and live health.
// Exit 0 + RELEASE_READY_OK only when every step passes.
//
// Usage:
//   node tests/release-ready-check.js          # full release gate
//   node tests/release-ready-check.js --list   # print the manifest
// =============================================================================

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const NODE = process.execPath;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

// Deterministic release regression. Live/cloud-only suites that need an
// external provider or a human editor session are deliberately not part of
// this list; their own gates run separately and are named in the runbook.
const MANIFEST = [
  "tests/agent-tools-check.js",
  "tests/all-transports-check.js",
  "tests/api-module-wiring-check.js",
  "tests/bootstrap-check.js",
  "tests/bootstrap-e2e-check.js",
  "tests/chat-upload-check.js",
  "tests/client-e2e-check.js",
  "tests/config-trace-check.js",
  "tests/cwd-db-repair-check.js",
  "tests/dedupe-check.js",
  "tests/docs-current-check.js",
  "tests/edge-proxy-check.js",
  "tests/env-loader-check.js",
  "tests/final-guard-check.js",
  "tests/fs-scope-decision-check.js",
  "tests/hardening-check.js",
  "tests/live-server-independence-check.js",
  "tests/mcp-api-integration-check.js",
  "tests/mcp-architecture-check.js",
  "tests/mission-privilege-check.js",
  "tests/normalizer-single-path-check.js",
  "tests/package-install-check.js",
  "tests/portability-check.js",
  "tests/provider-health-honesty-check.js",
  "tests/quality-eval-check.js",
  "tests/r2t-default-off-check.js",
  "tests/r2t-trace-check.js",
  "tests/real-usage-dir-check.js",
  "tests/schema-compile-check.js",
  "tests/session-memory-sqlite-check.js",
  "tests/skill-mcp-check.js",
  "tests/start-lifecycle-check.js",
  "tests/surface-policy-check.js",
  "tests/system-identity-check.js",
  "tests/tool-budget-check.js",
  "tests/uds-fallback-check.js",
  "tests/uds-single-path-check.js",
  "tests/vhost-truth-check.js",
  "tests/workspace-layout-check.js",
];

if (process.argv.includes("--list")) {
  for (const rel of MANIFEST) console.log(rel);
  process.exit(0);
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log("PASS " + name + (detail ? " :: " + detail : "")); }
  else { fail++; failures.push(name); console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
}

function run(cmd, args, timeoutMs) {
  const started = Date.now();
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs || 240000,
    env: { ...process.env, ZC_RELEASE_GATE: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: res.status,
    signal: res.signal,
    out: String(res.stdout || ""),
    err: String(res.stderr || ""),
    ms: Date.now() - started,
  };
}

function tail(text, n) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-n).join(" | ").slice(-500);
}

function health() {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: 5050, path: "/health", timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (err) { reject(new Error("invalid health JSON: " + err.message)); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("health timeout")));
    req.on("error", reject);
  });
}

function sha256(rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
}

(async () => {
  console.log("=== release readiness gate === " + MANIFEST.length + " regression gates ===");

  const rebuild = run("bash", ["scripts/rebuild-restart.sh", "--check"], 240000);
  check(
    "rebuild check",
    rebuild.code === 0 && rebuild.out.includes("REBUILD_CHECK_OK"),
    "exit=" + rebuild.code + " " + ((rebuild.out.match(/REBUILD_CHECK_OK[^\n]*/) || [rebuild.err.slice(-200)])[0]),
  );

  const syntax = run(NODE, ["--check", "api.js"], 60000);
  check("api.js syntax", syntax.code === 0, "exit=" + syntax.code + " " + tail(syntax.err, 1));

  const jsFiles = [];
  for (const dir of ["lib", "modules", "normalizer", "transport", "provider"]) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) {
      if (String(entry).endsWith(".js")) jsFiles.push(path.join(dir, String(entry)));
    }
  }
  let syntaxBad = [];
  for (const rel of jsFiles) {
    const one = run(NODE, ["--check", rel], 30000);
    if (one.code !== 0) syntaxBad.push(rel);
  }
  check("module syntax", syntaxBad.length === 0, "files=" + jsFiles.length + " bad=" + syntaxBad.slice(0, 3).join(","));

  for (const rel of MANIFEST) {
    let one = run(NODE, [rel], 300000);
    let retried = false;
    // A few gates boot an isolated server or a headless browser. On a busy
    // workstation a single transient port/CPU hiccup must not mask a real
    // regression, so retry exactly once and record that we did.
    if (one.code !== 0) {
      one = run(NODE, [rel], 300000);
      retried = true;
    }
    const marker = (one.out.match(/^[A-Z][A-Z0-9_]*_OK\b.*$/m) || [])[0] || "";
    check(
      rel.replace(/^tests\//, "").replace(/\.js$/, ""),
      one.code === 0,
      "exit=" + one.code + (retried ? " retry=1" : "") + " " + (marker || tail(one.out + "\n" + one.err, 3)),
    );
  }

  const source = sha256("api.js");
  const dist = fs.existsSync(path.join(ROOT, "dist/api.js")) ? sha256("dist/api.js") : "missing";
  check("source == dist api.js", source === dist, "source=" + source.slice(0, 12) + " dist=" + dist.slice(0, 12));

  try {
    const h = await health();
    check(
      "live health",
      h.status === 200 && h.json && h.json.healthy === true && h.json.version === PKG.version,
      "status=" + h.status + " healthy=" + (h.json && h.json.healthy) + " version=" + (h.json && h.json.version),
    );
    check("live models/agents", Number(h.json && h.json.models) > 0 && Number(h.json && h.json.agents) > 0, "models=" + (h.json && h.json.models) + " agents=" + (h.json && h.json.agents));
  } catch (err) {
    check("live health", false, err.message);
  }

  console.log("---");
  if (fail) {
    console.log("RELEASE_READY_FAIL pass=" + pass + " fail=" + fail);
    console.log("FAILED: " + failures.join(", "));
    process.exit(1);
  }
  console.log("RELEASE_READY_OK pass=" + pass + " fail=0");
})().catch((err) => {
  console.error("RELEASE_READY_ERROR", err && (err.stack || err.message));
  process.exit(2);
});