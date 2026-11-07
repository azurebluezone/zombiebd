#!/usr/bin/env node
"use strict";
/*
 * broker-free-check.js — proves the project no longer ships or starts the PHP
 * broker, and that the API serves its own endpoints when no broker exists.
 *
 * Three independent checks:
 *   1. static  — runtime files contain no broker path, env key, or spawn call
 *   2. spawn   — an isolated api.js instance starts with BROKER_AUTORUN=1 and
 *                never touches the sentinel port, never logs [BROKER]
 *   3. endpoints — /health, /v1/models, /api/agents, /api/sessions, /mcp
 *
 * The isolated instance runs with cwd=temp and temp DATA/LOG/CACHE/LOCK/UDS
 * paths, so the live server and the real .zombiecoder files are untouched.
 */

const fs = require("fs");
const path = require("path");
const net = require("net");
const http = require("http");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP_ROOT = path.join(os.tmpdir(), "opencode");
const TMP = path.join(TMP_ROOT, "broker-free-" + process.pid);

const RUNTIME_PATHS = [
  "api.js",
  "start.js",
  "start-local-mcp.js",
  "external-mcp.js",
  "lib",
  "scripts",
  "deploy",
  "dist",
  ".env",
  ".env.example",
];

// Only runtime references count. Documentation may still explain the removal.
const BROKER_RE =
  /php-broker-server|BROKER_(?:PORT|HOST|AUTORUN|TIMEOUT_MS|UPSTREAM_MODEL)|startBroker|brokerUrl/;

const results = [];
function mark(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

function walk(target, out) {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    out.push(target);
    return;
  }
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    // Test sources quote the forbidden tokens; they are not runtime code.
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "tests") continue;
    walk(path.join(target, entry.name), out);
  }
}

function staticScan() {
  const files = [];
  for (const target of RUNTIME_PATHS) walk(target, files);

  const hits = [];
  for (const rel of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    } catch (_) {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(BROKER_RE);
      if (match) hits.push(rel + ":" + (i + 1) + " " + match[0]);
    }
  }
  mark("static-broker-refs", hits.length === 0, hits.length + " refs" + (hits.length ? " [" + hits.slice(0, 6).join(", ") + "]" : ""));
  return hits.length;
}

function checkFileAbsent() {
  const paths = [
    path.join(ROOT, "external tools", "php-broker-server.js"),
    path.join(ROOT, "dist", "external tools", "php-broker-server.js"),
  ];
  const present = paths.filter((p) => fs.existsSync(p));
  mark("broker-file-absent", present.length === 0, present.length ? present.join(",") : paths.map((p) => p.replace(ROOT + "/", "")).join(","));
}

function checkDistManifest() {
  const manifestPath = path.join(ROOT, "dist", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    mark("dist-manifest", false, "missing dist/manifest.json");
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = (manifest.files || []).filter((f) => /php-broker-server/.test(f.path || ""));
  mark("dist-manifest", entries.length === 0, entries.length ? entries.map((f) => f.path).join(",") : "0 broker entries");
}

function syntaxCheck() {
  const files = ["api.js", "start.js", "lib/env.js", "tests/broker-free-check.js"];
  const failed = [];
  for (const rel of files) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], { stdio: "pipe" });
    } catch (e) {
      failed.push(rel);
    }
  }
  mark("syntax-check", failed.length === 0, failed.length ? failed.join(",") : "4 files");
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
  const s = net.createServer();
  const port = await listen(s, 0, "127.0.0.1");
  await close(s);
  return port;
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: urlPath,
        timeout: 10000,
        headers: Object.assign(
          payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {},
          headers || {},
        ),
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout " + method + " " + urlPath));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("api.js exited early code=" + child.exitCode + "\n" + output.slice(-2000));
    }
    try {
      const res = await request(port, "GET", "/health");
      if (res.status === 200) return JSON.parse(res.body);
    } catch (_) {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("api.js did not answer /health within 25s\n" + output.slice(-2000));
}

function brokerChildren(pid) {
  try {
    const out = execFileSync("ps", ["-o", "pid,args", "--ppid", String(pid)], { encoding: "utf8" });
    return out
      .split("\n")
      .slice(1)
      .filter((line) => /php-broker-server|broker-free/i.test(line));
  } catch (_) {
    return [];
  }
}

async function main() {
  staticScan();
  checkFileAbsent();
  checkDistManifest();
  syntaxCheck();

  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "cache"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "locks"), { recursive: true });

  const srcDb = path.join(ROOT, "data", "models.db");
  if (fs.existsSync(srcDb)) {
    fs.copyFileSync(srcDb, path.join(TMP, "data", "models.db"));
  }

  const sentinelPort = await freePort();
  const apiPort = await freePort();
  const udsPort = await freePort();
  let sentinelHits = 0;
  const sentinel = net.createServer((socket) => {
    sentinelHits++;
    socket.destroy();
  });
  await listen(sentinel, sentinelPort, "127.0.0.1");

  let output = "";
  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: TMP,
    env: Object.assign({}, process.env, {
      PORT: String(apiPort),
      BIND_HOST: "127.0.0.1",
      UDS_PORT: String(udsPort),
      UDS: path.join(TMP, "mcp.sock"),
      UDS_OPENAI: "1",
      GRPC: "0",
      HTTPS_CERT_PATH: "",
      HTTPS_KEY_PATH: "",
      DATA_DIR: path.join(TMP, "data"),
      LOG_DIR: path.join(TMP, "logs"),
      CACHE_DIR: path.join(TMP, "cache"),
      LOCK_DIR: path.join(TMP, "locks"),
      DB_SQLITE_PATH: path.join(TMP, "data", "models.db"),
      // Old code spawned on any value other than "0"; a live value makes the
      // absence of a connection a real proof, not a disabled-by-accident one.
      BROKER_AUTORUN: "1",
      BROKER_PORT: String(sentinelPort),
      BROKER_HOST: "127.0.0.1",
      BROKER_TIMEOUT_MS: "1000",
      brokerUrl: "http://127.0.0.1:" + sentinelPort,
      WATCHDOG_INTERVAL: "600000",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));

  let endpoints = 0;
  try {
    const health = await waitForHealth(apiPort, child, output);
    if (health && health.healthy === true) endpoints++;
    else mark("endpoint-health", false, "healthy!=true");

    const models = await request(apiPort, "GET", "/v1/models");
    const modelsJson = JSON.parse(models.body || "{}");
    if (models.status === 200 && Array.isArray(modelsJson.data) && modelsJson.data.length > 0) endpoints++;
    else mark("endpoint-models", false, "status=" + models.status);

    const agents = await request(apiPort, "GET", "/api/agents");
    if (agents.status === 200) endpoints++;
    else mark("endpoint-agents", false, "status=" + agents.status);

    const sessions = await request(apiPort, "GET", "/api/sessions");
    if (sessions.status === 200) endpoints++;
    else mark("endpoint-sessions", false, "status=" + sessions.status);

    const mcp = await request(apiPort, "POST", "/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });
    if (mcp.status === 200) endpoints++;
    else mark("endpoint-mcp", false, "status=" + mcp.status);

    mark("endpoints", endpoints === 5, endpoints + "/5");

    mark("sentinel-untouched", sentinelHits === 0, "connections=" + sentinelHits);
    mark("no-broker-log", !/\[BROKER\]/i.test(output), /\[BROKER\]/i.test(output) ? "found [BROKER]" : "0 lines");
    const children = brokerChildren(child.pid);
    mark("no-broker-child", children.length === 0, children.length ? children.join(" | ") : "0 children");
  } finally {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }
    await close(sentinel);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("RESULT: BROKER-FREE FAIL (" + failed.map((r) => r.name).join(", ") + ")");
    process.exitCode = 1;
    return;
  }

  console.log(
    "RESULT: BROKER-FREE PASS (static=0 spawn=0 sentinel=0 endpoints=5)",
  );
}

main().catch((err) => {
  console.error("ERROR: " + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
