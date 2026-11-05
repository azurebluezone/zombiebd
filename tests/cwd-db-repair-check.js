#!/usr/bin/env node
"use strict";

/*
 * Launch-directory and DB-repair check.
 *
 * Starts a real api.js process with cwd=/tmp and isolated data/db/socket
 * paths, then proves:
 *   1. .env, data, logs and models.db still come from the project root.
 *   2. The agents table is seeded with all 9 agent/*.js agents.
 *   3. get_working_dir returns the launch directory (/tmp), so agents can
 *      work wherever the user started them.
 *   4. After deleting every agents row, a restart restores all 9 rows and
 *      logs AGENTS_REPAIRED.
 *
 * Nothing here touches the live stack: ports, DB, logs and sockets are
 * isolated under /tmp/opencode.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const LAUNCH_CWD = "/tmp";
const TMP = path.join("/tmp/opencode", "cwd-db-" + process.pid);
const DATA_DIR = path.join(TMP, "data");
const LOG_DIR = path.join(TMP, "logs");
const DB_PATH = path.join(DATA_DIR, "models.db");
const MCP_SOCK = path.join(TMP, "mcp.sock");
const OPENAI_SOCK = path.join(TMP, "openai.sock");

function log(line) {
  console.log(line);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname, method, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: method || "GET",
        timeout: 8000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 45000);
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health");
    if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
    await sleep(300);
  }
  return null;
}

function startInstance(ports) {
  const env = Object.assign({}, process.env, {
    PORT: String(ports.api),
    GRPC_PORT: String(ports.grpc),
    HTTPS_PORT: String(ports.https),
    DATA_DIR,
    LOG_DIR,
    DB_SQLITE_PATH: DB_PATH,
    UDS_PATH: MCP_SOCK,
    OPENAI_UDS_PATH: OPENAI_SOCK,
    INSTANCE_ID: "cwd-db-check-" + Date.now(),
  });
  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: LAUNCH_CWD,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  return { child, output: () => output };
}

async function stopInstance(instance) {
  const child = instance.child;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

function readAgentCount() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare("SELECT COUNT(*) c FROM agents").get().c;
  } finally {
    db.close();
  }
}

// Keep the table non-empty but incomplete: this is the exact state that the
// old `count > 0` guard accepted forever, and the state the repair fixes.
function damageAgents(keep) {
  const db = new DatabaseSync(DB_PATH);
  try {
    return db
      .prepare("DELETE FROM agents WHERE id NOT IN (SELECT id FROM agents ORDER BY id LIMIT ?)")
      .run(keep).changes;
  } finally {
    db.close();
  }
}

function readAgentIds() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return db.prepare("SELECT id FROM agents ORDER BY id").all().map((r) => r.id);
  } finally {
    db.close();
  }
}

function udsToolCall(method, params) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: MCP_SOCK });
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 6000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const cut = buffer.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      try {
        finish({ ok: true, json: JSON.parse(buffer.slice(0, cut)) });
      } catch (_) {
        finish({ ok: false, error: "invalid json" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const ports = { api: await freePort(), grpc: await freePort(), https: await freePort() };
  const failures = [];
  const pass = (name, detail) => log("PASS " + name + (detail ? " " + detail : ""));
  const fail = (name, detail) => {
    failures.push(name);
    log("FAIL " + name + (detail ? " " + detail : ""));
  };

  log("=== cwd + db repair check ===");
  log("cwd=" + LAUNCH_CWD + " root=" + ROOT + " db=" + DB_PATH);

  let first = startInstance(ports);
  let health = await waitHealth(ports.api);
  if (!health) {
    fail("start-from-/tmp", "api did not become healthy");
    log(first.output().slice(-1200));
    await stopInstance(first);
    process.exitCode = 1;
    return;
  }
  pass("start-from-/tmp", "api=" + ports.api);

  const envLine = first.output().includes("[ENV] Loaded: " + path.join(ROOT, ".env"));
  envLine
    ? pass("env-anchored-to-project")
    : fail("env-anchored-to-project", "no [ENV] Loaded project .env line");

  const dbReady = first.output().includes("SQLITE_READY") && first.output().includes(DB_PATH);
  dbReady
    ? pass("db-path-isolated", DB_PATH)
    : fail("db-path-isolated", "SQLITE_READY did not report the isolated path");

  const agentsRes = await httpJson(ports.api, "/api/agents");
  const apiAgents =
    agentsRes.json && (Array.isArray(agentsRes.json.agents) ? agentsRes.json.agents : []);
  apiAgents.length === 9
    ? pass("api-agents", "count=9")
    : fail("api-agents", "status=" + agentsRes.status + " count=" + apiAgents.length);

  let dbAgents = 0;
  try {
    dbAgents = readAgentCount();
  } catch (err) {
    fail("db-agents", err.message);
  }
  dbAgents === 9
    ? pass("db-agents", "count=9")
    : fail("db-agents", "count=" + dbAgents);

  const wd = await udsToolCall("tools/call", { name: "get_working_dir", arguments: {} });
  const wdText =
    wd.ok && wd.json && wd.json.result && wd.json.result.content
      ? wd.json.result.content.map((c) => c.text).join("")
      : "";
  wdText === "/tmp"
    ? pass("agent-working-dir", "get_working_dir=/tmp")
    : fail("agent-working-dir", "got=" + JSON.stringify(wdText || wd.error));

  await stopInstance(first);

  let damaged = 0;
  try {
    damaged = damageAgents(5);
  } catch (err) {
    fail("damage-agents", err.message);
  }
  damaged === 4
    ? pass("damage-agents", "removed=4 kept=5")
    : fail("damage-agents", "removed=" + damaged);
  const beforeRepair = readAgentIds();
  beforeRepair.length === 5
    ? pass("damage-state", "non-empty-incomplete=5")
    : fail("damage-state", "count=" + beforeRepair.length);

  let second = startInstance(ports);
  health = await waitHealth(ports.api);
  if (!health) {
    fail("restart-after-db-damage", "api did not become healthy");
    log(second.output().slice(-1200));
    await stopInstance(second);
    process.exitCode = 1;
    return;
  }
  const repaired = second.output().includes("AGENTS_REPAIRED");
  const repairedAdded = second.output().includes('"added":4');
  repaired && repairedAdded
    ? pass("repair-log", "AGENTS_REPAIRED added=4")
    : fail(
        "repair-log",
        "AGENTS_REPAIRED=" + repaired + " added4=" + repairedAdded,
      );

  let repairedCount = 0;
  try {
    repairedCount = readAgentCount();
  } catch (err) {
    fail("repair-db", err.message);
  }
  repairedCount === 9
    ? pass("repair-db", "count=9")
    : fail("repair-db", "count=" + repairedCount);

  const restoredIds = readAgentIds();
  const missingIds = restoredIds.filter((id) => !beforeRepair.includes(id));
  missingIds.length === 4
    ? pass("repair-ids", "restored=4")
    : fail("repair-ids", "restored=" + missingIds.length + " missing=" + missingIds.join(","));

  const agentsAfter = await httpJson(ports.api, "/api/agents");
  const apiAfter =
    agentsAfter.json && (Array.isArray(agentsAfter.json.agents) ? agentsAfter.json.agents : []);
  apiAfter.length === 9
    ? pass("repair-api", "count=9")
    : fail("repair-api", "status=" + agentsAfter.status + " count=" + apiAfter.length);

  await stopInstance(second);

  if (failures.length) {
    console.log("RESULT: CWD DB FAIL " + failures.join(","));
    process.exitCode = 1;
    return;
  }
  console.log("RESULT: CWD DB PASS cwd=/tmp agents=9 repaired=4 db=" + DB_PATH);
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("CHECK_ERROR " + err.message);
  process.exitCode = 1;
});
