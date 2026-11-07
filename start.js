#!/usr/bin/env node
// =============================================================================
// Mission Barisal v3 — Cross-Platform Start Script
// Entry point with two user-facing options:
//   1) CONFIG ALL  — write config.json to the OS default directory
//                    (Windows: %USERPROFILE%\.zombiecoder\, Linux/macOS: $HOME/.zombiecoder/)
//   2) START ALL   — load .env + config, then boot the main server (api.js)
// No hardcoded paths — every location is resolved at runtime per-OS.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const http = require("http");
const net = require("net");
const { execSync, spawn } = require("child_process");
const systemInfo = require("./lib/system-info.js");
const { readEnvFile } = require("./lib/env");

const VERSION = "3.2.1"; // keep in sync with api.js /health version
const CONFIG_DIR = path.join(os.homedir(), ".zombiecoder");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// Project-owned state follows the code, never the shell's cwd. DATA_DIR and
// DB_SQLITE_PATH may be absolute (tests, dist) and then win as usual.
function projectDataDir() {
  return path.resolve(__dirname, process.env.DATA_DIR || "./data");
}
function projectDbPath() {
  return path.resolve(
    __dirname,
    process.env.DB_SQLITE_PATH || path.join(projectDataDir(), "models.db"),
  );
}

// ─── Health-check / integration test endpoints ───
const HEALTH_ENDPOINTS = [
  { path: "/health", method: "GET", expect: { healthy: true }, name: "Health" },
  { path: "/api/v1/models", method: "GET", expect: (data) => data && (data.data || data.models) && Array.isArray(data.data || data.models), name: "Models v1" },
  { path: "/api/v0/models", method: "GET", expect: (data) => data && (data.data || data.models) && Array.isArray(data.data || data.models), name: "Models v0" },
  { path: "/api/agents", method: "GET", expect: { agents: Array }, name: "Agents" },
  { path: "/identity", method: "GET", expect: (data) => data && (data.system_identity || data.domain), name: "Identity" },
  { path: "/api/domain", method: "GET", expect: (data) => data && (data.detected || data.domain), name: "Domain" },
  { path: "/api/mcp-clients", method: "GET", expect: (data) => data && (data.connected_clients || data.clients || data.tools !== undefined), name: "MCP Clients" },
];

const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_DELAY_MS = 2000;

// ---------------------------------------------------------------------------
// Environment loader (unchanged behavior, kept dependency-free)
// ---------------------------------------------------------------------------
function loadEnv() {
  try {
    // Anchor to the project, not the shell's cwd. `node /path/to/start.js`
    // from /tmp must still load the project's .env and data directory.
    const envPath = path.join(__dirname, ".env");
    const fileVars = readEnvFile(envPath);
    const keys = Object.keys(fileVars);
    if (!keys.length) return;

    let loaded = 0;
    for (const key of keys) {
      // Explicit shell env always wins over the file.
      if (!process.env[key]) {
        process.env[key] = fileVars[key];
        loaded++;
      }
    }
    console.log("[ENV] Loaded:", envPath, "(" + loaded + " vars)");
  } catch (_) { }
}

// ---------------------------------------------------------------------------
// Environment Detection & Runtime Setup
// ---------------------------------------------------------------------------
function detectEnvironment() {
  const platform = process.platform; // 'win32', 'linux', 'darwin'
  const arch = process.arch;
  const nodeVersion = process.version;
  const isWindows = platform === "win32";
  const isLinux = platform === "linux";
  const isMac = platform === "darwin";
  
  const envInfo = {
    platform,
    arch,
    nodeVersion,
    isWindows,
    isLinux,
    isMac,
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
    cpus: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    hostname: os.hostname(),
    username: process.env.USER || process.env.USERNAME || "unknown",
    cwd: process.cwd(),
    dataDir: projectDataDir(),
    configDir: CONFIG_DIR,
    timestamp: new Date().toISOString(),
  };
  
  console.log("\n[ENV-DETECT] Environment detected:");
  console.log(`  Platform: ${platform} (${isWindows ? "Windows" : isLinux ? "Linux" : isMac ? "macOS" : "Unknown"})`);
  console.log(`  Arch: ${arch}, Node: ${nodeVersion}`);
  console.log(`  User: ${envInfo.username} @ ${envInfo.hostname}`);
  console.log(`  CWD: ${envInfo.cwd}`);
  console.log(`  Data Dir: ${envInfo.dataDir}`);
  console.log(`  Config Dir: ${envInfo.configDir}`);
  console.log(`  Memory: ${envInfo.totalMemGB} GB, CPUs: ${envInfo.cpus}`);
  
  return envInfo;
}

function ensureDatabase() {
  console.log("\n[DB] Ensuring database from environment variables...");

  const dataDir = projectDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("[DB] Created data directory:", dataDir);
  }

  const dbPath = projectDbPath();
  if (!fs.existsSync(dbPath)) {
    console.log("[DB] " + dbPath + " not found — api.js will create and seed it");
    return { exists: false, dbPath };
  }

  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const check = db.prepare("PRAGMA quick_check").get();
    const integrity = check ? String(Object.values(check)[0] || "") : "";
    if (integrity.toLowerCase() !== "ok") {
      throw new Error("integrity_check=" + (integrity || "empty"));
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const count = (table) =>
      tables.includes(table) ? db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c : 0;
    const modelCount = count("models");
    const agentCount = count("agents");
    db.close();

    console.log("[DB] " + dbPath + " tables: " + (tables.join(", ") || "(none)"));
    console.log(`[DB] Models: ${modelCount}, Agents: ${agentCount}`);
    if (!tables.includes("models") || !tables.includes("agents")) {
      console.warn("[DB] schema incomplete — api.js will create the missing tables");
    } else if (agentCount === 0) {
      console.warn("[DB] agents table is empty — api.js will repair it from agent/*.js");
    }
    // Fresh clones and deleted rows: api.js owns the repair (INSERT OR IGNORE
    // for agents, upsert for models) so the start script does not duplicate
    // schema knowledge.
    return { exists: true, tables, modelCount, agentCount, dbPath };
  } catch (err) {
    // A corrupt file can never be repaired by seeding. Move it aside once so
    // api.js can create a clean database instead of failing on every boot.
    const quarantine = dbPath + ".corrupt-" + Date.now();
    try {
      fs.renameSync(dbPath, quarantine);
      console.warn("[DB] unreadable database moved to " + quarantine + " (" + err.message + ")");
    } catch (moveErr) {
      console.warn("[DB] unreadable database and could not move it:", moveErr.message);
    }
    return { exists: false, corrupt: true, dbPath };
  }
}

function storeRuntimeConfig(envInfo) {
  try {
    const dataDir = projectDataDir();
    fs.mkdirSync(dataDir, { recursive: true });
    
    // Capture all relevant env vars for debugging/inspection
    const runtimeConfig = {
      savedAt: new Date().toISOString(),
      environment: envInfo,
      envVars: {},
      providers: {},
    };
    
    // Filter and store relevant env vars (exclude secrets)
    const relevantKeys = [
      "PORT", "SERVER_PORT", "UDS", "UDS_OPENAI", "UDS_PORT", "APP_URL", "DOMAIN",
      "NOTE_ENCRYPTION_KEY", "NOTE_TTL", "MAX_NOTE_SIZE",
      "OPENCODE_MODELS", "GROQ_MODELS", "GEMINI_MODELS",
      "ADMIN_USER", "ADMIN_API_KEY",
      "PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER",
    ];
    
    for (const key of relevantKeys) {
      if (process.env[key]) {
        runtimeConfig.envVars[key] = key.includes("KEY") || key.includes("SECRET")
          ? "***REDACTED***"
          : process.env[key];
      }
    }
    
    // Capture custom providers
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^CUSTOM_PROVIDER_(\d+)_NAME$/);
      if (m) {
        const n = m[1];
        const name = process.env[k];
        runtimeConfig.providers[name] = {
          name,
          url: process.env[`CUSTOM_PROVIDER_${n}_URL`] || "",
          type: process.env[`CUSTOM_PROVIDER_${n}_TYPE`] || "openai",
          priority: process.env[`CUSTOM_PROVIDER_${n}_PRIORITY`] || "",
          models: String(process.env[`CUSTOM_PROVIDER_${n}_MODELS`] || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean),
        };
      }
    }
    
    const outPath = path.join(dataDir, "startup-config.json");
    fs.writeFileSync(outPath, JSON.stringify(runtimeConfig, null, 2), "utf8");
    console.log("[STORE] Runtime config saved ->", outPath);
    console.log(`[STORE] Providers captured: ${Object.keys(runtimeConfig.providers).length}`);
    console.log(`[STORE] Env vars captured: ${Object.keys(runtimeConfig.envVars).length}`);
    
    return outPath;
  } catch (err) {
    console.warn("[STORE] Warning — could not save runtime config:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP Test Client (no external deps)
// ---------------------------------------------------------------------------
function httpRequest(host, port, path, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "MissionBarisal-StartScript/1.0",
      },
    };
    
    if (body) {
      const data = JSON.stringify(body);
      options.headers["Content-Length"] = Buffer.byteLength(data);
    }
    
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    });
    
    req.on("error", (err) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Health Check / Integration Test
// ---------------------------------------------------------------------------
async function runHealthChecks(host, port) {
  console.log("\n[HEALTH] Starting integration tests against http://" + host + ":" + port + " ...");
  
  // Wait for server to be ready
  await new Promise(r => setTimeout(r, HEALTH_CHECK_DELAY_MS));
  
  const results = [];
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of HEALTH_ENDPOINTS) {
    try {
      const start = Date.now();
      const response = await httpRequest(host, port, endpoint.path, endpoint.method);
      const elapsed = Date.now() - start;
      
      let ok = false;
      if (response.status === 200) {
        if (typeof endpoint.expect === "function") {
          ok = endpoint.expect(response.data);
        } else if (endpoint.expect && typeof endpoint.expect === "object") {
          ok = Object.keys(endpoint.expect).every(key => {
            const expectedType = endpoint.expect[key];
            const actualValue = response.data[key];
            if (expectedType === Array) return Array.isArray(actualValue);
            if (expectedType === String) return typeof actualValue === "string";
            if (expectedType === Number) return typeof actualValue === "number";
            if (expectedType === Boolean) return typeof actualValue === "boolean";
            if (expectedType === Object) return actualValue !== null && typeof actualValue === "object";
            return actualValue !== undefined;
          });
        } else {
          ok = true;
        }
      }
      
      if (ok) {
        passed++;
        console.log(`  ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ${response.status} (${elapsed}ms)`);
      } else {
        failed++;
        console.log(`  ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ${response.status} (${elapsed}ms) — Unexpected response`);
        console.log(`     Response:`, JSON.stringify(response.data).slice(0, 200));
      }
      
      results.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        method: endpoint.method,
        status: response.status,
        ok,
        elapsed,
        data: response.data,
      });
    } catch (err) {
      failed++;
      console.log(`  ${endpoint.name} (${endpoint.method} ${endpoint.path}) — ERROR: ${err.message}`);
      results.push({
        endpoint: endpoint.name,
        path: endpoint.path,
        method: endpoint.method,
        error: err.message,
        ok: false,
      });
    }
  }
  
  console.log(`\n[HEALTH] Results: ${passed} passed, ${failed} failed`);
  
  // Save health check results beside the project's real data directory.
  const dataDir = projectDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  const resultPath = path.join(dataDir, "health-check-" + Date.now() + ".json");
  fs.writeFileSync(resultPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    host,
    port,
    passed,
    failed,
    results,
  }, null, 2), "utf8");
  console.log("[HEALTH] Results saved to:", resultPath);
  
  return { passed, failed, results };
}

// ---------------------------------------------------------------------------
// OS default directory resolution (no hardcoded C:\ or /home paths)
// ---------------------------------------------------------------------------
function getDefaultConfig() {
  return {
    version: VERSION,
    serverPort: Number(process.env.SERVER_PORT) || Number(process.env.PORT) || 5050,
    udsPort: Number(process.env.UDS_PORT) || 5150,
    udsPath:
      require("./transport/uds-gateway").collectUdsPaths(process.env, process.cwd())[0] ||
      path.join(os.tmpdir(), "zombiecoder", "mcp.sock"),
    workingDir: process.cwd(),
    homeDir: os.homedir(),
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CONFIG ALL — write config.json to the OS default directory
// ---------------------------------------------------------------------------
function configAll() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const cfg = getDefaultConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
    console.log("");
    console.log("[CONFIG ALL] config.json created at:");
    console.log("  " + CONFIG_PATH);
    console.log("");
    console.log("  serverPort :", cfg.serverPort);
    console.log("  udsPort    :", cfg.udsPort);
    console.log("  udsPath    :", cfg.udsPath);
    console.log("  workingDir :", cfg.workingDir);
    console.log("  homeDir    :", cfg.homeDir);
    console.log("");
    console.log("This location is OS-default (os.homedir()). The server and the");
    console.log("extension can both read it from any working directory.");
    return 0;
  } catch (err) {
    console.error("[CONFIG ALL] Failed:", err.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// START ALL — load env + config, then boot the main server
// ---------------------------------------------------------------------------
function cleanupOldProcesses() {
  // Kill any previously-running server processes (api.js / hamba.js)
  // and free the target port BEFORE booting fresh.
  // Cross-platform: Windows uses netstat + taskkill; Linux/macOS uses
  // ss/ps + process.kill. The current process (this start.js) is never killed.
  const targetPort =
    Number(process.env.PORT) ||
    Number(process.env.SERVER_PORT) ||
    5050;
  console.log(
    "[CLEANUP] Scanning for old server processes on port " +
      targetPort +
      " ...",
  );
  const killed = new Set();

  const sleepMs = (ms) => {
    if (process.platform === "win32") {
      const t = Date.now();
      while (Date.now() - t < ms) {}
    } else {
      try {
        execSync("sleep " + (ms / 1000).toFixed(1));
      } catch (_) {}
    }
  };

  const findPidsOnPort = () => {
    const pids = new Set();
    try {
      const out =
        process.platform === "win32"
          ? execSync('netstat -ano | findstr ":' + targetPort + '"', {
              encoding: "utf8",
            })
          : execSync('ss -tlnp 2>/dev/null | grep ":' + targetPort + ' "', {
              encoding: "utf8",
            });
      if (process.platform === "win32") {
        for (const line of String(out).split("\n")) {
          const m = line.match(/LISTENING\s+(\d+)\s*$/);
          if (m) pids.add(parseInt(m[1], 10));
        }
      } else {
        for (const m of String(out).matchAll(/pid=(\d+)/g))
          pids.add(parseInt(m[1], 10));
      }
    } catch (_) {
      /* ss/netstat may not be present — ignore */
    }
    return [...pids];
  };

  const killPid = (pid, force) => {
    if (!pid || pid === process.pid || killed.has(pid)) return;
    killed.add(pid);
    try {
      if (process.platform === "win32") {
        execSync("taskkill /F /PID " + pid, { stdio: "ignore" });
      } else {
        try {
          process.kill(pid, force ? "SIGKILL" : "SIGTERM");
        } catch (_) {}
      }
      console.log(
        "[CLEANUP] Killed old process pid=" + pid + (force ? " (forced)" : ""),
      );
    } catch (_) {}
  };

  // A service-managed gateway has Restart=always. If this process was started
  // from a terminal, killing the service listener makes systemd restart it at
  // once, and the new instance kills this one. Stop the unit before touching
  // the port so exactly one owner survives — the terminal that asked for it.
  const runsUnderSystemd = (() => {
    if (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID) return true;
    try {
      return /zombiecoder-gateway\.service/.test(
        fs.readFileSync("/proc/self/cgroup", "utf8"),
      );
    } catch (_) {
      return false;
    }
  })();

  const unitOf = (pid) => {
    try {
      // /proc files end with a newline; without trim the lookahead below
      // treats the final unit as unterminated and returns the session unit.
      const groups = fs.readFileSync("/proc/" + pid + "/cgroup", "utf8").trim();
      const units = [...groups.matchAll(/\/([\w@.\-]+\.service)(?=\/|$)/g)].map(
        (m) => m[1],
      );
      return units.length ? units[units.length - 1] : "";
    } catch (_) {
      return "";
    }
  };

  // Under dist/ the checkout root is one level up; matching only __dirname
  // would miss a service that still runs the source tree.
  const projectRoot =
    path.basename(__dirname) === "dist" ? path.dirname(__dirname) : __dirname;
  const isThisProjectServer = (pid) => {
    try {
      const cmd = fs
        .readFileSync("/proc/" + pid + "/cmdline", "utf8")
        .replace(/\0/g, " ");
      return cmd.includes(projectRoot) && /(start|api)\.js/.test(cmd);
    } catch (_) {
      return false;
    }
  };

  if (!runsUnderSystemd) {
    for (const pid of findPidsOnPort()) {
      if (!isThisProjectServer(pid)) continue;
      const unit = unitOf(pid);
      if (!unit || /^user@\d+\.service$/.test(unit)) continue;
      console.log(
        "[CLEANUP] Stopping systemd unit " + unit +
        " so this terminal owns port " + targetPort + " ...",
      );
      try {
        execSync("systemctl --user stop " + unit, { stdio: "inherit" });
      } catch (err) {
        console.warn("[CLEANUP] could not stop " + unit + ": " + err.message);
      }
    }
    // Do not kill our way out of a unit that refused to stop: systemd would
    // start it again and the two processes would keep reaping each other.
    const stillManaged = findPidsOnPort().filter(isThisProjectServer);
    if (stillManaged.length) {
      console.error(
        "[CLEANUP] Port " + targetPort + " is still held by a systemd-managed " +
        "gateway. Stop it first, then rerun: systemctl --user stop " +
        (unitOf(stillManaged[0]) || "zombiecoder-gateway.service"),
      );
      process.exit(1);
    }
  }

  // 1) Kill whatever listens on the target port
  for (const pid of findPidsOnPort()) killPid(pid, false);

  // 2) Kill sibling server scripts in this project directory
  if (process.platform !== "win32") {
    try {
      const out = execSync(
        'ps -eo pid,args | grep -E "node .*(api|hamba|note-store)\\.js" | grep -v grep',
        { encoding: "utf8" },
      );
      for (const line of String(out).split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const args = m[2] || "";
        if (pid === process.pid) continue;
        if (args.indexOf("start.js") !== -1) continue; // never kill this script
        // SAFETY: only kill server scripts from THIS project directory,
        // so a test run on an alternate port never kills a server that
        // is running from a different directory (e.g. the live 5050).
        if (args.indexOf(__dirname) === -1) continue;
        if (args.indexOf("api.js") !== -1) {
          killPid(pid, false);
        }
      }
    } catch (_) {}
  }

  // 3) Wait for the port to free (up to ~5s), then force-kill leftovers
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (findPidsOnPort().length === 0) break;
    sleepMs(30);
  }
  for (const pid of findPidsOnPort()) killPid(pid, true);

  console.log("[CLEANUP] Port " + targetPort + " is free. Starting fresh ...");
}

// ─── Local LLM bridge ─────────────────────────────────────────
// The bridge is one hop in front of Ollama. Starting it here means the menu
// option and `--start-all` bring up the same stack; a missing bridge used to
// leave every agent fallback pointing at a dead port.
let bridgeChild = null;
let bridgeShuttingDown = false;

function bridgePort() {
  return parseInt(process.env.BRIDGE_PORT || "11435", 10);
}

function tcpOpen(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || "127.0.0.1" });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    socket.setTimeout(timeoutMs || 400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpGetJson(port, pathName, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathName, timeout: timeoutMs || 1500 },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, status: res.statusCode, body: buf });
            return;
          }
          try {
            resolve({ ok: true, status: res.statusCode, json: JSON.parse(buf), body: buf });
          } catch (_) {
            resolve({ ok: false, status: res.statusCode, body: buf });
          }
        });
      },
    );
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

function waitFor(check, timeoutMs, intervalMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      let value = false;
      try {
        value = await check();
      } catch (_) {
        value = false;
      }
      if (value) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(tick, intervalMs || 300);
    };
    tick();
  });
}

function stopBridge() {
  if (bridgeShuttingDown) return;
  bridgeShuttingDown = true;
  if (!bridgeChild) return;
  try {
    bridgeChild.kill("SIGTERM");
  } catch (_) {}
  bridgeChild = null;
}

async function startBridge() {
  const port = bridgePort();
  const existing = await httpGetJson(port, "/health", 1200);
  if (existing.ok) {
    const model = existing.json && existing.json.model ? existing.json.model : "";
    const upstreamReady = !!(existing.json && existing.json.upstream && existing.json.upstream.ready);
    console.log(
      "[BRIDGE] already running on :" + port +
      (upstreamReady ? " model=" + model : " (no local upstream yet)") + " — skip spawn",
    );
    return { started: false, port, model, healthy: true, upstreamReady };
  }
  if (await tcpOpen(port, "127.0.0.1", 500)) {
    console.warn(
      "[BRIDGE] port " + port + " is occupied by a process that is not the bridge — skip spawn",
    );
    return { started: false, port, healthy: false, error: "port_occupied" };
  }

  const script = path.join(__dirname, "local-llm-bridge.js");
  if (!fs.existsSync(script)) {
    console.warn("[BRIDGE] script missing: " + script);
    return { started: false, port, healthy: false, error: "script_missing" };
  }

  console.log("[BRIDGE] starting " + script + " on 127.0.0.1:" + port + " ...");
  bridgeChild = spawn(process.execPath, [script], {
    cwd: __dirname,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) process.stdout.write("[BRIDGE] " + line + "\n");
    }
  };
  if (bridgeChild.stdout) bridgeChild.stdout.on("data", prefix);
  if (bridgeChild.stderr) bridgeChild.stderr.on("data", prefix);
  bridgeChild.on("exit", (code, signal) => {
    if (!bridgeShuttingDown) {
      console.warn("[BRIDGE] exited code=" + code + " signal=" + (signal || "none"));
    }
    bridgeChild = null;
  });

  // Wait only for the bridge listener, never for an LLM upstream. A machine
  // without Ollama/llama.cpp must still boot; the bridge discovers a server
  // started later and reports upstream.ready=false until then.
  const listening = await waitFor(async () => {
    const r = await httpGetJson(port, "/health", 900);
    return r.ok === true;
  }, 6000, 250);

  if (!listening) {
    console.warn("[BRIDGE] did not answer on :" + port + " — check logs/bridge output");
    return { started: true, port, healthy: false };
  }
  const health = await httpGetJson(port, "/health", 1500);
  const model = health.json && health.json.model ? health.json.model : "";
  const upstreamReady = !!(health.json && health.json.upstream && health.json.upstream.ready);
  if (upstreamReady) {
    console.log("[BRIDGE] listening on :" + port + " model=" + model);
  } else {
    console.log(
      "[BRIDGE] listening on :" + port +
      " — no local model server found; bridge stays idle and keeps probing",
    );
  }
  return { started: true, port, model, healthy: true, upstreamReady };
}

process.on("exit", stopBridge);
process.on("SIGINT", () => {
  stopBridge();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopBridge();
  process.exit(0);
});

function storeModels() {
  // Capture provider/model configuration from environment variables and
  // persist a snapshot so the configured models are stored / inspectable.
  // Mirrors what the server boots with (CUSTOM_PROVIDER_* + built-ins).
  try {
    const providers = {};
    for (const k of Object.keys(process.env)) {
      const m = k.match(/^CUSTOM_PROVIDER_(\d+)_NAME$/);
      if (m) {
        const n = m[1];
        const name = process.env[k];
        providers[name] = {
          name,
          url: process.env["CUSTOM_PROVIDER_" + n + "_URL"] || "",
          type: process.env["CUSTOM_PROVIDER_" + n + "_TYPE"] || "openai",
          priority: process.env["CUSTOM_PROVIDER_" + n + "_PRIORITY"] || "",
          models: String(process.env["CUSTOM_PROVIDER_" + n + "_MODELS"] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
    }
    const snapshot = {
      savedAt: new Date().toISOString(),
      port: process.env.PORT,
      appUrl: process.env.APP_URL,
      providers,
    };
    const outDir = path.join(__dirname, "data");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "startup-config.json");
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    console.log("[STORE] Provider/model snapshot saved -> " + outPath);
  } catch (err) {
    console.warn("[STORE] Warning — could not save snapshot:", err.message);
  }
}

async function startAll() {
  console.log("\n" + "=".repeat(60));
  console.log("  Mission Barisal v" + VERSION + " — START ALL (Full Bootstrap)");
  console.log("=".repeat(60));
  
  // 1. Load .env first
  loadEnv();
  
  // 2. Detect environment
  const envInfo = detectEnvironment();

  // 2b. Host details are printed once, before any child starts. The API
  // exposes the same facts at /api/system for clients that cannot read stdout.
  try {
    const host = systemInfo.collectSystemInfo();
    console.log("[SYSTEM] " + systemInfo.formatSummary(host));
    console.log(
      "[SYSTEM] mem=" + host.memory.free_gb + "/" + host.memory.total_gb +
      " GB free, disk=" + host.disk.free_gb + "/" + host.disk.total_gb +
      " GB free, root=" + host.root,
    );
    console.log(
      "[SYSTEM] ports api=" + (process.env.PORT || "5050") +
      " grpc=" + (process.env.GRPC_PORT || "5052") +
      " bridge=" + (process.env.BRIDGE_PORT || "11435") +
      " mcp=3110-3123",
    );
  } catch (err) {
    console.warn("[SYSTEM] host details unavailable:", err.message);
  }
  
  // 3. Ensure database exists (will be created by api.js if not present)
  const dbStatus = ensureDatabase();
  
  // 4. Store runtime config from env vars
  storeRuntimeConfig(envInfo);
  
  // ── Final required conditions (user-specified) ──
  // PORT defaults to 5050 and APP_URL must point at the public app URL.
  // Enforced even if missing from .env so the server always boots on the
  // expected port / URL.
  process.env.PORT = process.env.PORT || "5050";
  // APP_URL: derive from DEPLOY_DOMAIN if not set, don't hardcode
  if (!process.env.APP_URL) {
    const domain = process.env.DEPLOY_DOMAIN || "localhost";
    const port = process.env.PORT;
    const isLocal = domain === "localhost" || domain === "127.0.0.1";
    process.env.APP_URL = (isLocal ? "http" : "https") + "://" + domain + (isLocal ? ":" + port : "");
  }
  console.log("[ENV] Final conditions -> PORT=" + process.env.PORT + " APP_URL=" + process.env.APP_URL);
  
  // 5. Auto-ensure config exists in the OS default directory (idempotent).
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(getDefaultConfig(), null, 2), "utf8");
      console.log("[CONFIG] Auto-created:", CONFIG_PATH);
    } else {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      console.log("[CONFIG] Loaded:", CONFIG_PATH);
      // Env vars take priority over config.json (so PORT/SERVER_PORT in .env win)
      if (cfg.serverPort && !process.env.SERVER_PORT && !process.env.PORT) {
        process.env.PORT = String(cfg.serverPort);
      }
    }
  } catch (err) {
    console.warn("[CONFIG] Warning — continuing without config:", err.message);
  }
  
  // 6. Cleanup old processes
  console.log("[START ALL] Cleaning up old server processes ...");
  cleanupOldProcesses();

  // 6b. Local LLM bridge — idempotent. A bridge already on the port is
  // reused, never killed; a foreign listener is reported and left alone.
  try {
    await startBridge();
  } catch (err) {
    console.warn("[BRIDGE] startup warning:", err.message);
  }
  
  // 7. Boot the server
  console.log("[START ALL] Booting Mission Barisal v" + VERSION + " ...");
  
  // 8. Start local MCP servers (OCR, Screen Recorder, TTS)
  try {
    const { startLocalServers } = require("./start-local-mcp.js");
    const mcpResults = await startLocalServers();
    const readyCount = mcpResults.filter(r => r.status === "ready").length;
    if (mcpResults.length > 0) {
      console.log("[START ALL] Local MCP servers: " + readyCount + "/" + mcpResults.length + " ready");
    }
  } catch (e) {
    console.warn("[START ALL] Local MCP startup warning:", e.message);
  }
  
  // 8. Start server and run health checks
  const port = Number(process.env.PORT);
  const host = "127.0.0.1";
  
  // We need to start the server and then run health checks
  // The api.js will start the HTTP server
  let serverStarted = false;
  
  // Hook into process to run health checks after a delay
  setTimeout(async () => {
    if (!serverStarted) {
      console.log("[HEALTH] Running post-startup integration tests...");
      const results = await runHealthChecks(host, port);
      
      if (results.failed === 0) {
        console.log("\n[START ALL] All systems operational!");
        console.log("[START ALL] Server is ready at http://" + host + ":" + port);
        console.log("[START ALL] API endpoints verified and responding.\n");
      } else {
        console.log("\n[START ALL]  Some health checks failed — server running but may need attention");
        console.log("[START ALL] Server is at http://" + host + ":" + port + " (check health-check-*.json for details)\n");
      }
      serverStarted = true;
    }
  }, 4000); // Wait for server to fully boot
  
  // Start the actual server (this blocks)
  require("./api.js");
}

// ---------------------------------------------------------------------------
// Interactive prompt (user-facing strings stay in English)
// ---------------------------------------------------------------------------
function showMenu() {
  console.log("");
  console.log("==============================================");
  console.log("  Mission Barisal v" + VERSION + " — Starter");
  console.log("==============================================");
  console.log("");
  console.log("  1) CONFIG ALL — write config to the OS default directory");
  console.log("                  Windows: %USERPROFILE%\\.zombiecoder\\");
  console.log("                  Linux  : $HOME/.zombiecoder/");
  console.log("  2) START ALL  — load .env + config, then boot the server");
  console.log("                  (includes env detection, DB verify, health checks)");
  console.log("  0) Exit");
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Choose an option (1/2/0): ", (answer) => {
    rl.close();
    const a = (answer || "").trim();
    if (a === "1") process.exitCode = configAll();
    else if (a === "2") startAll();
    else {
      console.log("Bye!");
      process.exit(0);
    }
  });
}

// ---------------------------------------------------------------------------
// CLI flag parsing (non-interactive mode)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage:");
  console.log("  node start.js                  interactive menu (CONFIG ALL / START ALL)");
  console.log("  node start.js --config-all -c  run CONFIG ALL (write config.json)");
  console.log("  node start.js --start-all -s   run START ALL (full bootstrap + health checks)");
  console.log("  node start.js --health-only    run health checks against existing server");
  process.exit(0);
}

if (args.includes("--config-all") || args.includes("-c")) {
  process.exitCode = configAll();
} else if (args.includes("--start-all") || args.includes("-s")) {
  startAll();
} else if (args.includes("--health-only")) {
  loadEnv();
  const port = Number(process.env.PORT) || 5050;
  runHealthChecks("127.0.0.1", port).catch(err => {
    console.error("[HEALTH] Failed:", err.message);
    process.exit(1);
  });
} else {
  showMenu();
}
