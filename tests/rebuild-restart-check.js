#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: safe rebuild+restart (runbook N5, gate REBUILD_RESTART_OK)
// =============================================================================
// Method (real commands, no mocks):
//   1) STATIC  — script is executable and wires preflight/manifest/health/R2T
//   2) CHECK   — --check builds to a temp dir and proves source/dist sha equal
//   3) ABORT   — a deliberate syntax error stops before any dist is written
//   4) LIVE    — the real one-command run changes MainPID, /health is 200,
//                dist/api.js sha equals source, and model=r2t carries the
//                x-zc-r2t-engine header (the new build is actually live)
//
// Run: node tests/rebuild-restart-check.js
// Exit 0 + REBUILD_RESTART_OK only when every assertion passes.
// =============================================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "rebuild-restart.sh");
const UNIT = "zombiecoder-gateway";
const PORT = Number(process.env.PORT) || 5050;

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail += 1;
    rows.push(["FAIL", name, detail || ""]);
  }
}

const sha = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: "utf8", timeout: 60000 }, opts));
}

function systemctl(args) {
  return run("systemctl", ["--user"].concat(args), { timeout: 15000 });
}

function httpJson(port, pathname, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: timeoutMs || 10000,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) =>
      resolve({ status: 0, headers: {}, body: "", error: e.message }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

function copyTrackedTree(dest) {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listed.status !== 0) throw new Error("git ls-files failed");
  const files = listed.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const rel of files) {
    const src = path.join(ROOT, rel);
    const dst = path.join(dest, rel);
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(path.join(dest, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dest, "scripts", "rebuild-restart.sh"));
}

(async () => {
  const timer = setTimeout(() => {
    console.error("REBUILD_RESTART_TIMEOUT");
    process.exit(1);
  }, 115000);
  let tmpBad = null;
  try {
    // 1) STATIC
    const scriptText = fs.readFileSync(SCRIPT, "utf8");
    const startText = fs.readFileSync(path.join(ROOT, "start.js"), "utf8");
    assert("script exists", fs.existsSync(SCRIPT));
    assert(
      "script is executable",
      (fs.statSync(SCRIPT).mode & 0o111) !== 0,
      "mode=" + (fs.statSync(SCRIPT).mode & 0o777).toString(8),
    );
    assert("script wires preflight", scriptText.includes("PRECHECK_OK"));
    assert("script wires manifest check", scriptText.includes("MANIFEST_OK"));
    assert("script wires systemctl --user", scriptText.includes("systemctl --user"));
    assert("script uses ZC_SKIP_BUILD=1", scriptText.includes("ZC_SKIP_BUILD=1"));
    assert("script proves the R2T header", scriptText.includes("x-zc-r2t-engine"));
    assert("start.js honors ZC_SKIP_BUILD", startText.includes("ZC_SKIP_BUILD"));

    // 2) CHECK mode on the real source
    const check = run("bash", [SCRIPT, "--check"], { cwd: ROOT, timeout: 60000 });
    const checkOut = (check.stdout || "") + (check.stderr || "");
    assert("--check exits 0", check.status === 0, "status=" + check.status);
    assert("--check prints REBUILD_CHECK_OK", checkOut.includes("REBUILD_CHECK_OK"));
    const match = checkOut.match(/api_sha=([a-f0-9]{64})/);
    assert("--check prints a sha", !!match, match ? match[1].slice(0, 12) : "none");
    if (match) {
      assert(
        "--check sha equals source api.js",
        match[1] === sha(path.join(ROOT, "api.js")),
        match[1].slice(0, 12),
      );
    }

    // 3) ABORT: a syntax error must stop before any build
    tmpBad = fs.mkdtempSync(path.join(os.tmpdir(), "zc-n5-bad-"));
    copyTrackedTree(tmpBad);
    fs.appendFileSync(path.join(tmpBad, "api.js"), "\nthis is not js\n");
    const badScript = path.join(tmpBad, "scripts", "rebuild-restart.sh");
    const bad = run("bash", [badScript, "--check"], { cwd: tmpBad, timeout: 30000 });
    const badOut = (bad.stdout || "") + (bad.stderr || "");
    assert("syntax error aborts non-zero", bad.status !== 0, "status=" + bad.status);
    assert(
      "syntax error names the preflight step",
      badOut.includes("REBUILD_RESTART_FAILED step=preflight"),
      badOut.split("\n").filter(Boolean).slice(-1)[0] || "",
    );
    assert(
      "syntax error writes no dist manifest",
      !fs.existsSync(path.join(tmpBad, "dist", "manifest.json")),
    );

    // 4) LIVE one-command restart
    const oldPid = systemctl(["show", UNIT, "-p", "MainPID", "--value"]).stdout.trim();
    const live = run("bash", [SCRIPT, "--restart"], { cwd: ROOT, timeout: 90000 });
    const liveOut = (live.stdout || "") + (live.stderr || "");
    assert("live restart exits 0", live.status === 0, "status=" + live.status);
    assert(
      "live restart prints REBUILD_RESTART_OK",
      liveOut.includes("REBUILD_RESTART_OK"),
      liveOut.split("\n").filter(Boolean).slice(-1)[0] || "",
    );

    const newPid = systemctl(["show", UNIT, "-p", "MainPID", "--value"]).stdout.trim();
    assert(
      "MainPID changed",
      !!newPid && newPid !== "0" && newPid !== oldPid,
      "old=" + oldPid + " new=" + newPid,
    );

    const health = await httpJson(PORT, "/health", "GET", null, 5000);
    assert(
      "/health is 200 and healthy",
      health.status === 200 && health.json && health.json.healthy === true,
      "status=" + health.status,
    );

    const srcSha = sha(path.join(ROOT, "api.js"));
    const distSha = sha(path.join(ROOT, "dist", "api.js"));
    assert("dist/api.js sha equals source", srcSha === distSha, distSha.slice(0, 12));
    assert("dist.prev cleaned after success", !fs.existsSync(path.join(ROOT, "dist.prev")));

    const r2t = await httpJson(
      PORT,
      "/v1/chat/completions",
      "POST",
      {
        model: "r2t",
        messages: [{ role: "user", content: "[[TOOL:info]][[/TOOL]]" }],
        stream: false,
      },
      20000,
    );
    assert("live r2t call is 200", r2t.status === 200, "status=" + r2t.status);
    assert(
      "live r2t carries x-zc-r2t-engine",
      !!r2t.headers["x-zc-r2t-engine"],
      String(r2t.headers["x-zc-r2t-engine"] || "absent"),
    );
  } catch (e) {
    assert("unexpected error", false, e.message);
  } finally {
    clearTimeout(timer);
    if (tmpBad) {
      try {
        fs.rmSync(tmpBad, { recursive: true, force: true });
      } catch (e) {
        // best effort
      }
    }
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: safe rebuild+restart");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    const tag = status === "PASS" ? "  PASS " : "  FAIL ";
    console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (!fail) console.log("REBUILD_RESTART_OK");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("REBUILD_RESTART_ERROR", e);
  process.exit(1);
});
