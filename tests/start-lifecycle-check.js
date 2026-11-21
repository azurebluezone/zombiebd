#!/usr/bin/env node
"use strict";
/*
 * START_LIFECYCLE_OK — proves the start.js boot contract with real processes:
 *   1. the owner of the env PORT is killed before the server boots
 *   2. systemd is disabled --now before boot and enabled after health
 *   3. a missing DB is created with DB_BOOTSTRAP=1; an existing DB is reused
 *      (never overwritten) and its sentinel data survives the second boot
 *   4. every agent/*.js id is seeded/synced in SQLite with the same ASCII name
 *   5. health checks report 0 failed and [STATUS] + [LOG] lines are printed
 *
 * Isolation: ZC_DIST_DIR, DATA_DIR, LOG_DIR, DB, UDS and PORT are temporary.
 * systemctl is a test stub on PATH that records the exact --user arguments;
 * the real systemctl is never touched by this check.
 *
 * Run: node tests/start-lifecycle-check.js
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zc-start-lifecycle-"));
const BIN = path.join(TMP, "bin");
const CALLS = path.join(TMP, "systemctl.calls");
const DATA = path.join(TMP, "data");
const LOGS = path.join(TMP, "logs");
const DB_PATH = path.join(DATA, "models.db");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readLog(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function idx(text, marker) {
  return text.indexOf(marker);
}

async function waitForLog(file, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readLog(file).includes(marker)) return true;
    await sleep(250);
  }
  return false;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function holdPort(port) {
  const script = path.join(TMP, "hold-port.js");
  fs.writeFileSync(
    script,
    'const net=require("node:net");' +
      "const s=net.createServer((c)=>c.end());" +
      's.listen(' + port + ',"127.0.0.1",()=>console.log("HOLDING"));' +
      "setInterval(()=>{},1000);\n",
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("holder did not listen")), 5000);
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve(child);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("holder exited before listening"));
    });
  });
}

function installSystemctlStub() {
  fs.mkdirSync(BIN, { recursive: true });
  const body = [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$*\" >> " + JSON.stringify(CALLS),
    'case "$*" in',
    "  *show-environment*) exit 0 ;;",
    '  *" cat "*) exit 0 ;;',
    "  *is-enabled*) printf 'enabled\\n'; exit 0 ;;",
    "  *is-active*) printf 'inactive\\n'; exit 0 ;;",
    "  *MainPID*) printf '0\\n'; exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n");
  const file = path.join(BIN, "systemctl");
  fs.writeFileSync(file, body, { mode: 0o755 });
}

let runNo = 0;
function startStack(port) {
  runNo++;
  const logFile = path.join(TMP, "start-" + runNo + ".log");
  const out = fs.openSync(logFile, "a");
  const env = Object.assign({}, process.env, {
    PATH: BIN + ":" + process.env.PATH,
    APP_ROOT: ROOT,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    GRPC: "0",
    GRPC_PORT: String(port + 1),
    HTTPS_PORT: String(port + 2),
    BRIDGE_AUTORUN: "0",
    BRIDGE_PORT: String(port + 3),
    UDS: path.join(TMP, "mcp.sock"),
    UDS_PATH: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "0",
    DATA_DIR: DATA,
    LOG_DIR: LOGS,
    CACHE_DIR: path.join(TMP, "cache"),
    LOCK_DIR: path.join(TMP, "locks"),
    MCP_CLIENTS_FILE: path.join(DATA, "mcp-clients.json"),
    DB_SQLITE_PATH: DB_PATH,
    ZC_DIST_DIR: path.join(TMP, "dist"),
    ZC_SYSTEMD_UNIT: "zombiecoder-start-check.service",
    STATUS_INTERVAL_MS: "0",
  });
  delete env.DB_BOOTSTRAP;
  delete env.ZC_SKIP_BUILD;
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "start.js"), "--start-all", "-s"],
    { cwd: ROOT, env, stdio: ["ignore", out, out] },
  );
  return { child, logFile };
}

function waitHealth(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(false);
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          next();
        },
      );
      req.on("error", next);
      req.on("timeout", () => {
        req.destroy();
        next();
      });
      function next() {
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 300);
      }
    };
    tick();
  });
}

async function waitExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (
    Date.now() < deadline &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    await sleep(100);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitExit(child, 8000))) {
    child.kill("SIGKILL");
    await waitExit(child, 2000);
  }
}

function agentFiles() {
  const dir = path.join(ROOT, "agent");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js") && f !== "index.js")
    .map((file) => {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      return {
        file,
        id: (src.match(/\bid:\s*"([^"]+)"/) || [])[1] || "",
        name: (src.match(/\bname:\s*"([^"]+)"/) || [])[1] || "",
      };
    });
}

function dbAgentNames() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return new Map(
      db.prepare("SELECT id, name FROM agents").all().map((r) => [r.id, r.name]),
    );
  } finally {
    db.close();
  }
}

async function main() {
  installSystemctlStub();
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  // ── static: agent names are ASCII English ──────────────────────────────
  const agents = agentFiles();
  check("agent files found", agents.length >= 9, "count=" + agents.length);
  for (const a of agents) {
    check(
      "agent " + a.id + " has an ASCII English name",
      /^[\x20-\x7E]+$/.test(a.name) && !a.name.includes("\\u"),
      a.name,
    );
  }

  const port = await freePort();
  const holder = await holdPort(port);
  check("dummy port owner is listening", holder.exitCode === null, "pid=" + holder.pid);

  // ── run 1: fresh database ──────────────────────────────────────────────
  const run1 = startStack(port);
  const healthy1 = await waitHealth(port, run1.child, 90000);
  check("run 1: /health answers 200", healthy1, "port=" + port);
  const status1 = await waitForLog(run1.logFile, "[STATUS]", 60000);
  const log1 = readLog(run1.logFile);

  check(
    "run 1: port owner was killed before boot",
    idx(log1, "[CLEANUP] Killed old process pid=" + holder.pid) >= 0 &&
      idx(log1, "[CLEANUP] Killed old process pid=" + holder.pid) <
        idx(log1, "[RUNTIME] serving from dist"),
  );
  check("run 1: dummy port owner exited", await waitExit(holder, 5000));
  check(
    "run 1: missing DB was created via DB_BOOTSTRAP",
    log1.includes("[BOOTSTRAP] no database found — creating") &&
      log1.includes("DB_BOOTSTRAP=1") &&
      fs.existsSync(DB_PATH),
  );
  check(
    "run 1: systemd disabled before boot",
    idx(log1, "[SYSTEMD] disabled --now") >= 0 &&
      idx(log1, "[SYSTEMD] disabled --now") < idx(log1, "[RUNTIME] serving from dist"),
  );
  check(
    "run 1: systemd enabled after health",
    idx(log1, "[SYSTEMD] enabled") >= 0 &&
      idx(log1, "[SYSTEMD] enabled") > idx(log1, "[HEALTH] Results"),
  );
  check(
    "run 1: health checks all passed",
    /\[HEALTH\] Results: \d+ passed, 0 failed/.test(log1),
    (log1.match(/\[HEALTH\] Results: [^\n]+/) || [""])[0],
  );
  check(
    "run 1: DB sync reports complete agent rows",
    /\[DB\] after sync: agents=\d+\/\d+ models=\d+ missing_agents=0 name_mismatch=0/.test(log1),
    (log1.match(/\[DB\] after sync: [^\n]+/) || [""])[0],
  );
  check("run 1: runtime [STATUS] printed", status1 && log1.includes("health=ok"));
  check("run 1: runtime [LOG] lines printed", log1.includes("[LOG] "));

  const names = dbAgentNames();
  let missing = 0;
  let mismatch = 0;
  for (const a of agents) {
    if (!names.has(a.id)) missing++;
    else if (names.get(a.id) !== a.name) mismatch++;
  }
  check("run 1: every agent id is in SQLite", missing === 0, "missing=" + missing);
  check("run 1: DB agent names match the English files", mismatch === 0, "mismatch=" + mismatch);

  const db1 = new DatabaseSync(DB_PATH);
  const models = db1.prepare("SELECT COUNT(*) c FROM models").get().c;
  db1.exec("CREATE TABLE IF NOT EXISTS _start_lifecycle_marker (v TEXT NOT NULL)");
  db1.prepare("INSERT INTO _start_lifecycle_marker (v) VALUES (?)").run("keep-me");
  db1.close();
  check("run 1: models table is seeded", models > 0, "models=" + models);

  await stop(run1.child);

  // ── run 2: existing database must survive ──────────────────────────────
  const run2 = startStack(port);
  const healthy2 = await waitHealth(port, run2.child, 90000);
  check("run 2: /health answers 200 on the reused DB", healthy2);
  await waitForLog(run2.logFile, "[STATUS]", 60000);
  const log2 = readLog(run2.logFile);
  check(
    "run 2: existing DB is kept, never overwritten",
    log2.includes("[BOOTSTRAP] existing database kept (never overwritten)"),
  );
  check(
    "run 2: health checks all passed",
    /\[HEALTH\] Results: \d+ passed, 0 failed/.test(log2),
    (log2.match(/\[HEALTH\] Results: [^\n]+/) || [""])[0],
  );

  const db2 = new DatabaseSync(DB_PATH, { readOnly: true });
  const marker = db2
    .prepare("SELECT v FROM _start_lifecycle_marker")
    .all()
    .map((r) => r.v);
  const agentsAfter = db2.prepare("SELECT COUNT(*) c FROM agents").get().c;
  db2.close();
  check("run 2: sentinel data survived the second boot", marker.includes("keep-me"), marker.join(","));
  check("run 2: agent rows still complete", agentsAfter >= agents.length, "agents=" + agentsAfter);

  await stop(run2.child);

  // ── systemd command order (stub records the exact --user args) ─────────
  const calls = readLog(CALLS).split(/\r?\n/).filter(Boolean);
  const disableAt = calls.findIndex((line) => line.includes("disable --now zombiecoder-start-check.service"));
  const enableAt = calls.findIndex((line) => line.includes("enable zombiecoder-start-check.service"));
  check("systemctl disable --now was called", disableAt >= 0);
  check("systemctl enable was called", enableAt >= 0);
  check("disable is ordered before enable", disableAt >= 0 && enableAt > disableAt);

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    for (const run of [run1, run2]) {
      const text = readLog(run.logFile);
      if (text) {
        console.log("\n--- " + path.basename(run.logFile) + " (tail) ---");
        console.log(text.split(/\r?\n/).slice(-40).join("\n"));
      }
    }
    process.exit(1);
  }
  console.log("START_LIFECYCLE_OK");
}

main()
  .catch((error) => {
    console.error("FAIL " + (error && error.stack ? error.stack : String(error)));
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {}
  });
