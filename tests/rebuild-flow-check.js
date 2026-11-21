#!/usr/bin/env node
"use strict";

/*
 * REBUILD_FLOW_OK — proves the rebuild dead-end is fixed end to end.
 *
 *   1. `--help` advertises `--rebuild`.
 *   2. `--build-only` while the gateway is live still refuses with
 *      BUILD_REFUSED + the `--rebuild` hint, and leaves dist untouched.
 *   3. `--rebuild` stops the marker gateway, snapshots dist, builds, verifies
 *      the manifest and api.js sha, restarts detached and proves /health.
 *   4. The new gateway has a different pid, serves /v1/models, and
 *      dist/api.js is byte-identical to the source api.js.
 *
 * Run: node tests/rebuild-flow-check.js
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const START = path.join(ROOT, "start.js");
const DIST = path.join(ROOT, "dist");
const MARKER = path.join(DIST, ".runtime.json");
const PORT = Number(process.env.PORT) || 5050;

let pass = 0;
let fail = 0;
const rows = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail += 1;
    rows.push(["FAIL", name, detail || ""]);
  }
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER, "utf8"));
  } catch (_) {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function run(args, timeout) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [START, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeout || 120000,
  });
  return {
    status: res.status,
    output: (res.stdout || "") + (res.stderr || ""),
    ms: Date.now() - started,
    error: res.error ? res.error.message : "",
  };
}

function httpJson(pathname, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: PORT, path: pathname, timeout: timeoutMs || 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(body);
          } catch (_) {}
          resolve({ status: res.statusCode, json, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, json: null, body: error.message }));
    req.end();
  });
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson("/health", 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

(async () => {
  // 1. Help advertises the new mode.
  const help = run(["--help"], 30000);
  check("--help exits 0", help.status === 0, "exit=" + help.status);
  check(
    "--help lists --rebuild",
    help.output.includes("--rebuild"),
    help.output.split("\n").find((line) => line.includes("--rebuild")) || "absent",
  );

  // The premise of the refusal proof is a live marker gateway.
  let marker = readMarker();
  if (!marker || !alive(Number(marker.pid)) || !(await waitHealth(5000))) {
    const boot = run(["--rebuild"], 150000);
    check(
      "precondition: gateway live after a fresh --rebuild",
      boot.status === 0 && boot.output.includes("REBUILD_RESTART_OK"),
      "exit=" + boot.status,
    );
    marker = readMarker();
  }
  check(
    "live marker gateway exists",
    !!marker && alive(Number(marker.pid)),
    marker ? "pid=" + marker.pid : "no marker",
  );

  // 2. The guard still protects the live tree.
  const oldPid = Number(marker.pid);
  const beforeSha = sha(path.join(DIST, "api.js"));
  const refused = run(["--build-only"], 60000);
  const refusedOut = refused.output;
  check("--build-only while live exits non-zero", refused.status !== 0, "exit=" + refused.status);
  check(
    "refusal names BUILD_REFUSED",
    refusedOut.includes("BUILD_REFUSED"),
    refusedOut.split("\n").filter(Boolean).slice(-2).join(" | "),
  );
  check(
    "refusal points at --rebuild",
    refusedOut.includes("--rebuild"),
    "hint present",
  );
  check(
    "refusal leaves dist/api.js untouched",
    sha(path.join(DIST, "api.js")) === beforeSha,
    "sha unchanged",
  );
  check(
    "refusal leaves the gateway pid untouched",
    Number(readMarker().pid) === oldPid,
    "pid=" + oldPid,
  );

  // 3. The real one-command rebuild.
  const rebuilt = run(["--rebuild"], 150000);
  check("--rebuild exits 0", rebuilt.status === 0, "exit=" + rebuilt.status);
  check(
    "--rebuild prints REBUILD_RESTART_OK",
    rebuilt.output.includes("REBUILD_RESTART_OK"),
    rebuilt.output.split("\n").filter(Boolean).slice(-1)[0] || "no output",
  );

  const afterMarker = readMarker();
  check(
    "marker pid changed and is alive",
    !!afterMarker && Number(afterMarker.pid) !== oldPid && alive(Number(afterMarker.pid)),
    "old=" + oldPid + " new=" + (afterMarker ? afterMarker.pid : "none"),
  );

  // 4. The new tree is live and correct.
  const healthy = await waitHealth(20000);
  const health = await httpJson("/health", 5000);
  check(
    "/health is 200 and healthy",
    healthy && health.status === 200 && health.json && health.json.healthy === true,
    "status=" + health.status,
  );

  const srcSha = sha(path.join(ROOT, "api.js"));
  const distSha = sha(path.join(DIST, "api.js"));
  check("dist/api.js sha equals source api.js", srcSha === distSha, distSha.slice(0, 12));
  check("dist.prev removed after success", !fs.existsSync(path.join(ROOT, "dist.prev")));

  const models = await httpJson("/v1/models", 8000);
  const list = models.json && (models.json.data || models.json.models);
  check(
    "/v1/models answers 200 with a model list",
    models.status === 200 && Array.isArray(list) && list.length > 0,
    "status=" + models.status + " models=" + (Array.isArray(list) ? list.length : "none"),
  );

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: safe rebuild + restart without systemd");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    console.log((status === "PASS" ? "  PASS " : "  FAIL ") + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (fail === 0) console.log("REBUILD_FLOW_OK");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error("REBUILD_FLOW_ERROR " + error.message);
  process.exit(1);
});
