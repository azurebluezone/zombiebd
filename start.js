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
const crypto = require("crypto");
const { execSync, spawn, spawnSync } = require("child_process");
const systemInfo = require("./lib/system-info.js");
const {
  loadProcessEnv,
  DEFAULTS,
  resolveRuntimePaths,
  userHomeDir,
} = require("./lib/env");
const { classifyDbError, isBusyError } = require("./lib/db-guard");
const edgeProxy = require("./modules/edge-proxy");

const VERSION = "3.2.1"; // keep in sync with api.js /health version

// Config location comes from the one path resolver (configDir).
function configDir() {
  return resolveRuntimePaths(process.env).configDir;
}
function configPath() {
  return path.join(configDir(), "config.json");
}

// The root start.js is the ONLY entry point: it rebuilds this directory and
// then requires api.js from it. ZC_DIST_DIR exists so verification can build
// and boot an isolated tree without touching the live dist/.
const DIST_DIR = path.resolve(__dirname, process.env.ZC_DIST_DIR || "dist");
const DIST_ENTRY = path.join(DIST_DIR, "api.js");

// The launcher owns the runtime root. APP_ROOT keeps data/, logs/, the DB and
// the UDS socket under the checkout even when start.js is invoked from /tmp.
process.env.APP_ROOT = process.env.APP_ROOT || __dirname;

// A copied dist/start.js is an obsolete second entry: it cannot rebuild the
// tree it is currently executing from. Refuse instead of running stale code.
if (path.basename(__dirname) === "dist") {
  console.error(
    "DIST_ENTRY_REFUSED — start.js is the builder+launcher and lives at the repo root.\n" +
    "Run: node " + path.join(__dirname, "..", "start.js") + " --start-all -s",
  );
  process.exit(78);
}

// Project-owned state follows the code, never the shell's cwd. DATA_DIR and
// DB_SQLITE_PATH may be absolute (tests, dist) and then win as usual.
// lib/env.js is the single resolver both start.js and api.js call.
function projectDataDir() {
  return resolveRuntimePaths(process.env).dataDir;
}
function projectDbPath() {
  return resolveRuntimePaths(process.env).dbPath;
}

// Bounded runtime retention lives in modules/data-prune.js. Boot prunes the
// previous run's reports, and every new health report prunes again right
// after it lands, so data/ never keeps more than the retention window even
// when the gateway restarts repeatedly without a full boot cycle.
function pruneRuntimeData(reason) {
  try {
    const { pruneRuntimeArtifacts } = require("./modules/data-prune");
    const pruned = pruneRuntimeArtifacts(projectDataDir());
    console.log(
      "[CLEANUP] runtime artifacts (" + reason + "): removed=" + pruned.deleted.length +
      " kept_health=" + pruned.kept.health.length +
      " kept_corrupt=" + pruned.kept.corrupt.length,
    );
    return pruned;
  } catch (err) {
    console.warn("[CLEANUP] warning (" + reason + "):", err.message);
    return null;
  }
}

// ─── Build (every start) ─────────────────────────────────────
// The build is not a separate manual step. scripts/build.js owns the copy
// rules; this function owns the "always rebuild before boot" contract and
// fails the boot if the build did not produce a manifest.
function buildDist() {
  const script = path.join(__dirname, "scripts", "build.js");
  if (!fs.existsSync(script)) {
    console.error("[BUILD] FATAL missing " + script);
    process.exit(1);
  }
  console.log("[BUILD] rebuilding dist from source ...");
  console.log("[BUILD] source=" + __dirname + " out=" + DIST_DIR);
  const res = spawnSync(process.execPath, [script], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { BUILD_OUT: DIST_DIR }),
    stdio: "inherit",
  });
  if (res.error) {
    console.error("[BUILD] FATAL " + res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error("[BUILD] FATAL status=" + res.status);
    process.exit(res.status || 1);
  }
  const manifestPath = path.join(DIST_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("[BUILD] FATAL manifest missing: " + manifestPath);
    process.exit(1);
  }
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (_) { }
  console.log(
    "[BUILD] BUILD_OK dist=" + DIST_DIR +
    " builtAt=" + (manifest.builtAt || "unknown") +
    " files=" + (Array.isArray(manifest.files) ? manifest.files.length : "?"),
  );
  return manifest;
}

// The build guard cannot see a runtime whose argv is the root start.js, so
// the launcher records its PID inside dist. Removed on exit; a dead PID is
// ignored by scripts/build.js.
function writeRuntimeMarker() {
  const marker = path.join(DIST_DIR, ".runtime.json");
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify({
        pid: process.pid,
        dist: DIST_DIR,
        entry: __filename,
        startedAt: new Date().toISOString(),
      }) + "\n",
      "utf8",
    );
    process.on("exit", () => {
      try { fs.unlinkSync(marker); } catch (_) { }
    });
  } catch (e) {
    console.warn("[RUNTIME] marker warning: " + e.message);
  }
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

// ─── systemd lifecycle ───────────────────────────────────────
// The launcher owns the boot order: stop the unit first so Restart=always
// cannot restart-fight the port cleanup, run the server from this process,
// then re-enable the unit for the next boot and print the live status.
const SYSTEMD_UNIT = process.env.ZC_SYSTEMD_UNIT || "zombiecoder-gateway.service";
const STATUS_INTERVAL_MS = Math.max(
  0,
  Number(process.env.STATUS_INTERVAL_MS || 60000) || 0,
);
const systemdState = { unit: SYSTEMD_UNIT, available: false, skipped: "" };

function systemdEnabledByEnv() {
  return String(process.env.ZC_SYSTEMD || "1") !== "0";
}

function systemctl(args) {
  return spawnSync("systemctl", ["--user"].concat(args), {
    encoding: "utf8",
    timeout: 20000,
  });
}

function systemdAvailable() {
  if (process.platform !== "linux" || !systemdEnabledByEnv()) return false;
  const probe = spawnSync("systemctl", ["--user", "show-environment"], {
    encoding: "utf8",
    timeout: 5000,
  });
  return probe.status === 0;
}

function runningUnderSystemd() {
  if (process.env.INVOCATION_ID || process.env.SYSTEMD_EXEC_PID) return true;
  try {
    return /zombiecoder-gateway\.service/.test(
      fs.readFileSync("/proc/self/cgroup", "utf8"),
    );
  } catch (_) {
    return false;
  }
}

function unitExists() {
  return systemctl(["cat", SYSTEMD_UNIT]).status === 0;
}

function ensureSystemdUnit() {
  if (!systemdAvailable()) return false;
  if (unitExists()) return true;
  const installer = path.join(__dirname, "scripts", "install-service.sh");
  if (!fs.existsSync(installer)) {
    console.warn("[SYSTEMD] unit missing and scripts/install-service.sh not found");
    return false;
  }
  console.log("[SYSTEMD] unit missing — generating it with scripts/install-service.sh ...");
  const res = spawnSync("bash", [installer], {
    cwd: __dirname,
    stdio: "inherit",
    timeout: 30000,
  });
  return res.status === 0 && unitExists();
}

function systemdDisableUnit() {
  systemdState.available = systemdAvailable();
  if (!systemdState.available) {
    systemdState.skipped = "unavailable";
    console.log(
      "[SYSTEMD] unavailable — skipping disable (non-Linux, no user bus, or ZC_SYSTEMD=0)",
    );
    return false;
  }
  if (runningUnderSystemd()) {
    systemdState.skipped = "running-under-unit";
    console.log("[SYSTEMD] launcher runs inside " + SYSTEMD_UNIT + " — skipping disable");
    return false;
  }
  if (!ensureSystemdUnit()) {
    systemdState.skipped = "unit-missing";
    console.warn("[SYSTEMD] " + SYSTEMD_UNIT + " is not installed — skipping disable");
    return false;
  }
  const res = systemctl(["disable", "--now", SYSTEMD_UNIT]);
  if (res.status === 0) {
    console.log(
      "[SYSTEMD] disabled --now " + SYSTEMD_UNIT +
      " (no auto-restart while this launcher owns the port)",
    );
    return true;
  }
  const detail = String(res.stderr || res.stdout || "exit " + res.status).trim();
  console.warn("[SYSTEMD] disable failed: " + detail);
  return false;
}

function systemdEnableUnit() {
  if (!systemdState.available || runningUnderSystemd()) return false;
  if (systemdState.skipped === "unit-missing") return false;
  const res = systemctl(["enable", SYSTEMD_UNIT]);
  if (res.status === 0) {
    console.log("[SYSTEMD] enabled " + SYSTEMD_UNIT + " for the next boot");
    return true;
  }
  const detail = String(res.stderr || res.stdout || "exit " + res.status).trim();
  console.warn("[SYSTEMD] enable failed: " + detail);
  return false;
}

function systemdStatusLine() {
  if (!systemdAvailable()) return "systemd=unavailable";
  const enabled =
    String(systemctl(["is-enabled", SYSTEMD_UNIT]).stdout || "").trim() || "unknown";
  const active =
    String(systemctl(["is-active", SYSTEMD_UNIT]).stdout || "").trim() || "unknown";
  const mainPid =
    String(systemctl(["show", "-p", "MainPID", "--value", SYSTEMD_UNIT]).stdout || "").trim() ||
    "0";
  return (
    "systemd=" + enabled + "/" + active +
    " unit=" + SYSTEMD_UNIT + " mainPid=" + mainPid
  );
}

// ─── Database bootstrap + sync report ────────────────────────
// api.js owns the schema and the repair logic. start.js only decides whether
// creation is allowed (DB_BOOTSTRAP=1 for a missing file) and then reports
// what the server actually wrote. An existing file is never deleted.
function bootstrapDatabase() {
  const dbPath = projectDbPath();
  const existed = fs.existsSync(dbPath);
  if (existed) {
    console.log("[BOOTSTRAP] existing database kept (never overwritten): " + dbPath);
  } else {
    process.env.DB_BOOTSTRAP = "1";
    console.log(
      "[BOOTSTRAP] no database found — creating " + dbPath + " (DB_BOOTSTRAP=1)",
    );
  }
  return { existed, dbPath };
}

function agentFileRows() {
  const dir = path.join(__dirname, "agent");
  const rows = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "index.js");
  } catch (_) {
    return rows;
  }
  for (const file of files) {
    try {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      const id = (src.match(/\bid:\s*"([^"]+)"/) || [])[1];
      const name = (src.match(/\bname:\s*"([^"]+)"/) || [])[1];
      if (id) rows.push({ id, name: name || id, file });
    } catch (_) {
      /* an unreadable agent file is reported by api.js */
    }
  }
  return rows;
}

function dbSummary() {
  const dbPath = projectDbPath();
  if (!fs.existsSync(dbPath)) return { exists: false, dbPath };
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    const count = (table) =>
      tables.includes(table)
        ? db.prepare("SELECT COUNT(*) c FROM " + table).get().c
        : 0;
    const files = agentFileRows();
    let missingAgents = 0;
    let nameMismatch = 0;
    if (tables.includes("agents")) {
      const get = db.prepare("SELECT name FROM agents WHERE id = ?");
      for (const a of files) {
        const row = get.get(a.id);
        if (!row) missingAgents++;
        else if (String(row.name) !== String(a.name)) nameMismatch++;
      }
    }
    return {
      exists: true,
      dbPath,
      tables,
      agents: count("agents"),
      models: count("models"),
      fileAgents: files.length,
      missingAgents,
      nameMismatch,
    };
  } catch (err) {
    return { exists: true, dbPath, error: err.message };
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
}

function reportDatabaseState(phase) {
  const s = dbSummary();
  if (!s.exists) {
    console.warn("[DB] " + phase + ": no database at " + s.dbPath);
    return s;
  }
  if (s.error) {
    console.warn("[DB] " + phase + ": " + s.error);
    return s;
  }
  console.log(
    "[DB] " + phase + ": agents=" + s.agents + "/" + s.fileAgents +
    " models=" + s.models + " missing_agents=" + s.missingAgents +
    " name_mismatch=" + s.nameMismatch + " path=" + s.dbPath,
  );
  return s;
}

// ─── Runtime logs + status ───────────────────────────────────
function todayLogFile() {
  return path.join(
    resolveRuntimePaths(process.env).logDir,
    new Date().toISOString().slice(0, 10) + ".log",
  );
}

function recentLogLines(limit) {
  try {
    const file = todayLogFile();
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => (line.length > 220 ? line.slice(0, 217) + "..." : line));
  } catch (_) {
    return [];
  }
}

async function showRuntimeStatus(port) {
  const health = await httpGetJson(port, "/health", 1500);
  const ok = health.ok && health.json && health.json.healthy === true;
  const db = dbSummary();
  console.log(
    "[STATUS] time=" + new Date().toISOString() +
    " health=" + (ok ? "ok" : "unreachable") +
    (ok
      ? " uptime=" + health.json.uptime + "s agents=" + health.json.agents +
        " models=" + health.json.models
      : "") +
    " db=" + (db.exists
      ? "agents=" + db.agents + " models=" + db.models +
        (db.nameMismatch ? " name_mismatch=" + db.nameMismatch : "")
      : "missing") +
    " port=" + port + " " + systemdStatusLine(),
  );
  for (const line of recentLogLines(5)) console.log("[LOG] " + line);
  return ok;
}

function startLogTail(keepAlive) {
  const file = todayLogFile();
  let offset = 0;
  try {
    offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (_) {}
  console.log("[LOGS] tailing " + file + " (new lines only; Ctrl+C to stop)");
  const timer = setInterval(() => {
    const target = todayLogFile();
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch (_) {
      return;
    }
    if (size < offset) offset = 0; // rotation/truncate
    if (size === offset) return;
    try {
      const fd = fs.openSync(target, "r");
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      offset = size;
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) console.log("[LOG] " + line);
      }
    } catch (_) {}
  }, 1000);
  if (!keepAlive && timer.unref) timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Environment loader (delegates to lib/env.js — the only .env reader)
// ---------------------------------------------------------------------------
function loadEnv() {
  // Anchor to the project, not the shell's cwd. `node /path/to/start.js`
  // from /tmp must still load the project's .env and data directory.
  const result = loadProcessEnv({ root: __dirname });
  if (result.error) {
    console.error("[ENV] FATAL " + result.file + ": " + result.error);
    process.exit(78);
  }
  for (const warning of result.warnings || []) {
    console.warn("[ENV] WARN " + result.file + " " + warning);
  }
  if (!result.loaded) {
    console.warn("[ENV] .env not found: " + result.file);
    return;
  }
  console.log("[ENV] Loaded:", result.file, "(" + result.count + " vars)");
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
    homeDir: userHomeDir(),
    tmpDir: os.tmpdir(),
    cpus: os.cpus().length,
    totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    hostname: os.hostname(),
    username: process.env.USER || process.env.USERNAME || "unknown",
    cwd: process.cwd(),
    dataDir: projectDataDir(),
    configDir: configDir(),
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
    console.log(
      "[DB] " + dbPath + " not found — DB_BOOTSTRAP=" +
      (process.env.DB_BOOTSTRAP || "0") +
      " will create it; an existing file is never overwritten.",
    );
    return { exists: false, dbPath };
  }

  const { DatabaseSync } = require("node:sqlite");
  const deadline = Date.now() + 5000;
  // Blocking sleep without a child process; only used during boot.
  const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  };

  for (;;) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const check = db.prepare("PRAGMA quick_check").get();
      const integrity = check ? String(Object.values(check)[0] || "") : "";
      if (integrity.toLowerCase() !== "ok") {
        const corrupt = new Error("integrity_check=" + (integrity || "empty"));
        corrupt.code = "SQLITE_CORRUPT";
        throw corrupt;
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      const count = (table) =>
        tables.includes(table) ? db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c : 0;
      const modelCount = count("models");
      const agentCount = count("agents");
      db.close();
      db = null;

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
      if (db) {
        try { db.close(); } catch (_) {}
        db = null;
      }
      // SQLITE_BUSY / "database is locked" means another process is holding
      // the file. It is transient concurrency, not corruption: wait for it and
      // never rename the DB on this path (the old code destroyed live data).
      if (isBusyError(err) && Date.now() < deadline) {
        console.warn("[DB] database is locked — retrying without quarantining ...");
        sleepSync(250);
        continue;
      }
      const kind = classifyDbError(err);
      if (kind !== "corrupt") {
        console.warn("[DB] integrity check failed without a corruption signal — keeping the file: " + err.message);
        return { exists: true, checkFailed: true, dbPath };
      }
      // Corruption is not repaired by renaming the live database. Keep the
      // file for inspection and let api.js stop with DB_FATAL corrupt.
      console.error(
        "[DB] corrupt database detected at " + dbPath + " (" + err.message + ") — " +
        "keeping the file; api.js will stop with DB_FATAL corrupt.",
      );
      return { exists: true, corrupt: true, dbPath };
    }
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
      edge: {
        provider: process.env.EDGE_PROVIDER || "auto",
        mainHost: process.env.MAIN_HOST || "",
        httpPort: process.env.CADDY_HTTP_PORT || "80",
        httpsPort: process.env.CADDY_HTTPS_PORT || "443",
        tlsMode: process.env.TLS_MODE || "internal",
        adminPaths: ["/admin", "/api/admin"],
        apply: process.env.EDGE_APPLY === "1",
      },
    };
    
    // Filter and store relevant env vars (exclude secrets)
    const relevantKeys = [
      "PORT", "SERVER_PORT", "UDS", "UDS_OPENAI", "UDS_PORT", "APP_URL", "DOMAIN",
      "NOTE_ENCRYPTION_KEY", "NOTE_TTL", "MAX_NOTE_SIZE",
      "OPENCODE_MODELS", "GROQ_MODELS", "GEMINI_MODELS",
      "ADMIN_USER", "ADMIN_API_KEY",
      "PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER",
      "MAIN_HOST", "CADDY_HTTP_PORT", "CADDY_HTTPS_PORT", "TLS_MODE",
      "EDGE_PROVIDER", "EDGE_APPLY",
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

  // The report just became the newest artifact; prune now so repeated
  // restarts cannot leave keepHealth + 1 files behind.
  pruneRuntimeData("health-report");
  
  return { passed, failed, results };
}

// ---------------------------------------------------------------------------
// OS default directory resolution (no hardcoded C:\ or /home paths)
// ---------------------------------------------------------------------------
function getDefaultConfig() {
  return {
    version: VERSION,
    serverPort: Number(process.env.SERVER_PORT) || Number(process.env.PORT) || Number(DEFAULTS.PORT),
    udsPort: Number(process.env.UDS_PORT) || Number(DEFAULTS.UDS_PORT),
    udsPath:
      require("./transport/uds-gateway").collectUdsPaths(process.env, process.cwd())[0] ||
      path.join(resolveRuntimePaths(process.env).tmpDir, "mcp.sock"),
    workingDir: process.cwd(),
    homeDir: userHomeDir(),
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CONFIG ALL — write config.json to the OS default directory
// ---------------------------------------------------------------------------
function configAll() {
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    const cfg = getDefaultConfig();
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
    console.log("");
    console.log("[CONFIG ALL] config.json created at:");
    console.log("  " + configPath());
    console.log("");
    console.log("  serverPort :", cfg.serverPort);
    console.log("  udsPort    :", cfg.udsPort);
    console.log("  udsPath    :", cfg.udsPath);
    console.log("  workingDir :", cfg.workingDir);
    console.log("  homeDir    :", cfg.homeDir);
    console.log("");
    console.log("This location is the OS-default home directory. The server and the");
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
    Number(DEFAULTS.PORT);
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
    if (!pid || pid === process.pid) return;
    const key = pid + ":" + (force ? "KILL" : "TERM");
    if (killed.has(key)) return;
    killed.add(key);
    try {
      if (process.platform === "win32") {
        execSync("taskkill /F /PID " + pid, { stdio: "ignore" });
      } else {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      }
      console.log(
        "[CLEANUP] Killed old process pid=" + pid + (force ? " (forced)" : ""),
      );
    } catch (err) {
      if (err && err.code === "EPERM") {
        console.error(
          "[CLEANUP] no permission to signal pid=" + pid +
          " on port " + targetPort,
        );
      }
    }
  };

  const describePid = (pid) => {
    try {
      return (
        fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ").trim() ||
        "(empty cmdline)"
      );
    } catch (_) {
      return "(cmdline unavailable)";
    }
  };

  // A service-managed gateway has Restart=always. If this process was started
  // from a terminal, killing the service listener makes systemd restart it at
  // once, and the new instance kills this one. Stop the unit before touching
  // the port so exactly one owner survives — the terminal that asked for it.
  const runsUnderSystemd = runningUnderSystemd();

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

  // 1) Kill the owner of the env PORT. The user contract is explicit: the
  //    port named by PORT/SERVER_PORT must be free before this boot. The
  //    command line is logged first so a killed foreign process is auditable.
  for (const pid of findPidsOnPort()) {
    if (pid === process.pid || pid === process.ppid || pid <= 1) continue;
    console.log(
      "[CLEANUP] port " + targetPort + " owner pid=" + pid +
      " cmd=" + describePid(pid),
    );
    killPid(pid, false);
  }

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
  for (const pid of findPidsOnPort()) {
    if (pid === process.pid || pid === process.ppid || pid <= 1) continue;
    killPid(pid, true);
  }

  // A listener whose pid is hidden (another user, restricted /proc) cannot be
  // killed from here. Report it instead of booting into EADDRINUSE.
  let invisible = [];
  try {
    invisible = String(
      execSync('ss -tln 2>/dev/null | grep ":' + targetPort + ' "', {
        encoding: "utf8",
      }),
    )
      .split("\n")
      .filter(Boolean);
  } catch (_) {}
  if (invisible.length) {
    console.error(
      "[CLEANUP] port " + targetPort +
      " still has a listener without a visible pid:",
    );
    for (const line of invisible) console.error("  " + line.trim());
    process.exit(1);
  }

  console.log("[CLEANUP] Port " + targetPort + " is free. Starting fresh ...");
}

// ─── Local LLM bridge ─────────────────────────────────────────
// The bridge is one hop in front of Ollama. Starting it here means the menu
// option and `--start-all` bring up the same stack; a missing bridge used to
// leave every agent fallback pointing at a dead port.
let bridgeChild = null;
let bridgeShuttingDown = false;

function bridgePort() {
  return parseInt(process.env.BRIDGE_PORT || DEFAULTS.BRIDGE_PORT, 10);
}

// Health and bridge probes must use the address the API actually binds.
// `localhost` can resolve to ::1 while the server listens on 127.0.0.1 only,
// which turns a healthy server into a false "unreachable" report.
function loopbackHost() {
  const bind = String(process.env.BIND_HOST || "").trim();
  if (!bind || bind === "0.0.0.0" || bind === "::" || bind === "[::]") {
    return "127.0.0.1";
  }
  return bind;
}

function tcpOpen(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: host || loopbackHost() });
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
      { host: loopbackHost(), port, path: pathName, timeout: timeoutMs || 1500 },
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
  if (await tcpOpen(port, loopbackHost(), 500)) {
    console.warn(
      "[BRIDGE] port " + port + " is occupied by a process that is not the bridge — skip spawn",
    );
    return { started: false, port, healthy: false, error: "port_occupied" };
  }

  const script = path.join(DIST_DIR, "local-llm-bridge.js");
  if (!fs.existsSync(script)) {
    console.warn("[BRIDGE] script missing: " + script);
    return { started: false, port, healthy: false, error: "script_missing" };
  }

  console.log("[BRIDGE] starting " + script + " on " + loopbackHost() + ":" + port + " ...");
  bridgeChild = spawn(process.execPath, [script], {
    cwd: DIST_DIR,
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
  
  // 1b. Prune bounded runtime artifacts (health reports, quarantined DBs).
  // The policy lives in modules/data-prune.js; boot and report writes share
  // this one helper so no caller keeps its own copy of the rules.
  pruneRuntimeData("boot");

  // 1c. Bounded retention for logs and agent backups. The same policy runs in
  // tests/quality-eval-check.js; active logs and the current database are
  // never candidates, and RETENTION_DRY_RUN=1 reports without deleting.
  try {
    const retention = require("./modules/retention.js");
    const summary = retention.pruneRetention({
      dryRun: process.env.RETENTION_DRY_RUN === "1",
    });
    if (summary.dryRun || summary.deleted > 0) {
      console.log("[RETENTION] " + retention.formatRetentionLine(summary));
    }
  } catch (err) {
    console.warn("[RETENTION] skipped:", err.message);
  }
  
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
  } catch (err) {
    console.warn("[SYSTEM] host details unavailable:", err.message);
  }
  
  // 3. Bootstrap the database before the server boots. A missing file is
  // created with DB_BOOTSTRAP=1; an existing file is never deleted or
  // replaced, and api.js repairs missing agents/models at boot.
  bootstrapDatabase();
  const dbStatus = ensureDatabase();
  reportDatabaseState("before boot");
  
  // 4. Store runtime config from env vars
  storeRuntimeConfig(envInfo);
  
  // ── Final required conditions (user-specified) ──
  // PORT defaults from lib/env.js and APP_URL must point at the public app
  // URL. Enforced even if missing from .env so the server always boots on the
  // expected port / URL.
  process.env.PORT = process.env.PORT || DEFAULTS.PORT;
  // APP_URL: derive from DEPLOY_DOMAIN if not set, don't hardcode
  if (!process.env.APP_URL) {
    const domain = process.env.DEPLOY_DOMAIN || "127.0.0.1";
    const port = process.env.PORT;
    const isLocal =
      domain === "localhost" || domain === "127.0.0.1" || domain === "::1";
    process.env.APP_URL = (isLocal ? "http" : "https") + "://" + domain + (isLocal ? ":" + port : "");
  }
  console.log("[ENV] Final conditions -> PORT=" + process.env.PORT + " APP_URL=" + process.env.APP_URL);
  
  // 4b. Edge proxy — render + validate the Caddy/nginx config from env before
  // the gateway boots. Applying/reloading needs root and is opt-in
  // (EDGE_APPLY=1); a render or validation failure is reported, never fatal.
  let edgeState = null;
  try {
    edgeState = edgeProxy.ensureEdge({ apply: false });
    console.log("[EDGE] " + edgeProxy.formatEdgeLine(edgeState));
  } catch (err) {
    console.warn("[EDGE] render skipped:", err.message);
  }
  
  // 5. Auto-ensure config exists in the OS default directory (idempotent).
  try {
    if (!fs.existsSync(configPath())) {
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(getDefaultConfig(), null, 2), "utf8");
      console.log("[CONFIG] Auto-created:", configPath());
    } else {
      const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      console.log("[CONFIG] Loaded:", configPath());
      // Env vars take priority over config.json (so PORT/SERVER_PORT in .env win)
      if (cfg.serverPort && !process.env.SERVER_PORT && !process.env.PORT) {
        process.env.PORT = String(cfg.serverPort);
      }
    }
  } catch (err) {
    console.warn("[CONFIG] Warning — continuing without config:", err.message);
  }

  // 5a. Port truth after env + config.json resolution. The defaults come from
  // lib/env.js (one source), and local MCP servers are stdio children spawned
  // by api.js — there is no MCP port range to advertise.
  console.log(
    "[SYSTEM] ports api=" + (process.env.PORT || DEFAULTS.PORT) +
    " grpc=" + (process.env.GRPC_PORT || DEFAULTS.GRPC_PORT) +
    " bridge=" + (process.env.BRIDGE_PORT || DEFAULTS.BRIDGE_PORT) +
    " mcp=stdio",
  );

  // 5b. systemd lifecycle — disable the unit BEFORE touching the port so a
  // Restart=always service cannot restart-fight this launcher. It is enabled
  // again once the system is actually running (see step 9).
  systemdDisableUnit();

  // 6. Cleanup old processes
  console.log("[START ALL] Cleaning up old server processes ...");
  cleanupOldProcesses();

  // 6a. Rebuild dist from source on EVERY start. scripts/build.js refuses to
  // replace a live dist, so the cleanup above must stop the old gateway first.
  // scripts/rebuild-restart.sh builds and verifies the exact tree first, then
  // sets ZC_SKIP_BUILD=1 so the boot serves that tree without rebuilding it.
  if (process.env.ZC_SKIP_BUILD === "1") {
    console.log("[BUILD] skipped (ZC_SKIP_BUILD=1) — serving the verified dist");
  } else {
    buildDist();
  }

  // 6b. Local LLM bridge — idempotent. A bridge already on the port is
  // reused, never killed; a foreign listener is reported and left alone.
  if (process.env.BRIDGE_AUTORUN === "0") {
    console.log("[BRIDGE] disabled by BRIDGE_AUTORUN=0");
  } else {
    try {
      await startBridge();
    } catch (err) {
      console.warn("[BRIDGE] startup warning:", err.message);
    }
  }
  
  // 7. Boot the server
  console.log("[START ALL] Booting Mission Barisal v" + VERSION + " ...");
  
  // 8. Local MCP servers are spawned as stdio children by api.js through
  // external-mcp.js. No port launcher runs here.

  // 8. Start server and run health checks
  const port = Number(process.env.PORT);
  const host = loopbackHost();

  // 9. Wait for the listener, run the real health checks, report the DB sync,
  // re-enable the unit and print runtime status + recent logs. The api.js
  // logger keeps streaming live on stdout after require() below.
  (async () => {
    const ready = await waitFor(
      async () => (await httpGetJson(port, "/health", 1500)).ok === true,
      STARTUP_TIMEOUT_MS,
      500,
    );
    if (!ready) {
      console.warn(
        "[HEALTH] server did not answer on :" + port +
        " within " + STARTUP_TIMEOUT_MS + "ms",
      );
    }
    console.log("[HEALTH] Running post-startup integration tests...");
    const results = await runHealthChecks(host, port);
    reportDatabaseState("after sync");

    // The API is healthy: install/reload the edge only when the operator
    // opted in. A failure keeps the old edge config (applyEdge restores it).
    if (results.failed === 0 && edgeState && process.env.EDGE_APPLY === "1") {
      try {
        const applied = edgeProxy.applyEdge(edgeState.config, edgeState);
        console.log("[EDGE] " + edgeProxy.formatApplyLine(applied));
      } catch (err) {
        console.warn("[EDGE] apply failed:", err.message);
      }
    }

    if (results.failed === 0) {
      console.log("\n[START ALL] All systems operational!");
      console.log("[START ALL] Server is ready at http://" + host + ":" + port);
      console.log("[START ALL] API endpoints verified and responding.\n");
    } else {
      console.log("\n[START ALL]  Some health checks failed — server running but may need attention");
      console.log("[START ALL] Server is at http://" + host + ":" + port + " (check health-check-*.json for details)\n");
    }

    // The system is running: enable the unit for the next boot, then show
    // the live state once and on the configured interval.
    systemdEnableUnit();
    await showRuntimeStatus(port);
    if (STATUS_INTERVAL_MS > 0) {
      const timer = setInterval(() => {
        showRuntimeStatus(port).catch(() => {});
      }, STATUS_INTERVAL_MS);
      if (timer.unref) timer.unref();
    }
  })().catch((err) =>
    console.warn("[HEALTH] startup verification failed:", err.message),
  );

  // Start the actual server from the freshly built tree (this blocks).
  writeRuntimeMarker();
  const logDir = resolveRuntimePaths(process.env).logDir;
  console.log(
    "[LOGS] live api output streams below | file=" + todayLogFile() +
    " | structured=" + path.join(logDir, "zc.jsonl"),
  );
  console.log("[RUNTIME] serving from dist: " + DIST_ENTRY);
  require(DIST_ENTRY);
}

// ─── Safe rebuild + restart (systemd-free) ───────────────────
// `--build-only` refuses to replace a live dist on purpose: the running
// process keeps its loaded modules while lazy requires would point at a tree
// that no longer exists. This mode owns the whole safe sequence for a gateway
// launched by this file: stop it, snapshot dist, build, verify manifest+sha,
// restart detached, prove /health, and roll back to the previous tree if any
// step fails.
function liveGatewayFromMarker() {
  try {
    const markerPath = path.join(DIST_DIR, ".runtime.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (path.resolve(String(marker.dist || "")) !== DIST_DIR) return null;
    const pid = Number(marker.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); } catch (_) { return null; }
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    if (stat.split(" ")[2] === "Z") return null;
    const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
    if (!/start\.js|api\.js/.test(cmd)) return null;
    return { pid, marker };
  } catch (_) {
    return null;
  }
}

async function stopLiveGateway(pid) {
  console.log("[REBUILD] stopping live gateway pid=" + pid);
  try { process.kill(pid, "SIGTERM"); } catch (err) {
    if (err.code !== "ESRCH") console.warn("[REBUILD] SIGTERM failed: " + err.message);
  }
  const exited = () => {
    try { process.kill(pid, 0); return false; } catch (_) { return true; }
  };
  let gone = await waitFor(exited, 20000, 250);
  if (!gone) {
    console.warn("[REBUILD] pid " + pid + " ignored SIGTERM; sending SIGKILL");
    try { process.kill(pid, "SIGKILL"); } catch (_) {}
    gone = await waitFor(exited, 5000, 200);
  }
  // A SIGKILL leaves the marker behind; a dead marker is ignored by the build
  // guard, but removing it keeps the next start's state honest.
  try { fs.unlinkSync(path.join(DIST_DIR, ".runtime.json")); } catch (_) {}
  return gone;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyBuiltDist() {
  const manifestPath = path.join(DIST_DIR, "manifest.json");
  if (!fs.existsSync(manifestPath)) return "manifest missing";
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return "manifest unreadable: " + err.message;
  }
  const apiEntry = Array.isArray(manifest.files)
    ? manifest.files.find((entry) => entry && entry.path === "api.js")
    : null;
  if (!apiEntry) return "manifest has no api.js entry";
  const sourceSha = sha256File(path.join(__dirname, "api.js"));
  const builtSha = sha256File(path.join(DIST_DIR, "api.js"));
  if (sourceSha !== builtSha) return "api.js sha mismatch";
  if (apiEntry.sha256 !== builtSha) return "manifest api.js sha mismatch";
  return "";
}

function spawnGateway(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [__filename, "--start-all", "-s"], {
    cwd: __dirname,
    detached: true,
    stdio: ["ignore", out, out],
    env: Object.assign({}, process.env, { ZC_SKIP_BUILD: "1" }),
  });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

async function waitGatewayHealth(port, timeoutMs) {
  return waitFor(async () => {
    const res = await httpGetJson(port, "/health", 1500);
    return res.ok === true && res.json && res.json.healthy === true;
  }, timeoutMs, 500);
}

async function rebuildRestart() {
  loadEnv();
  const port = Number(process.env.PORT) || Number(DEFAULTS.PORT);
  const logPath = path.join(resolveRuntimePaths(process.env).logDir, "rebuild-restart.log");
  const live = liveGatewayFromMarker();
  const oldPid = live ? live.pid : "none";
  if (live) {
    const stopped = await stopLiveGateway(live.pid);
    if (!stopped) {
      console.error("[REBUILD] FAILED could not stop pid=" + live.pid);
      process.exit(1);
    }
    console.log("[REBUILD] stopped pid=" + live.pid);
  } else {
    console.log("[REBUILD] no live marker gateway; building and starting fresh");
  }

  const prev = DIST_DIR + ".prev";
  fs.rmSync(prev, { recursive: true, force: true });
  if (fs.existsSync(DIST_DIR)) {
    fs.renameSync(DIST_DIR, prev);
    console.log("[REBUILD] snapshot=" + prev);
  }

  const restore = () => {
    try { fs.rmSync(DIST_DIR, { recursive: true, force: true }); } catch (_) {}
    if (fs.existsSync(prev)) fs.renameSync(prev, DIST_DIR);
  };

  console.log("[REBUILD] building dist from source ...");
  const build = spawnSync(process.execPath, [path.join(__dirname, "scripts", "build.js")], {
    cwd: __dirname,
    env: Object.assign({}, process.env, { BUILD_OUT: DIST_DIR }),
    stdio: "inherit",
  });
  const buildError = build.status !== 0
    ? "build exit=" + build.status
    : verifyBuiltDist();
  if (buildError) {
    console.error("[REBUILD] FAILED " + buildError + " — restoring previous dist");
    restore();
    const rollbackPid = spawnGateway(logPath);
    const healthy = await waitGatewayHealth(port, 60000);
    console.error(
      "[REBUILD] ROLLBACK " + (healthy ? "HEALTH_OK pid=" + rollbackPid : "HEALTH_FAILED"),
    );
    process.exit(1);
  }

  const newPid = spawnGateway(logPath);
  console.log("[REBUILD] started pid=" + newPid + " log=" + logPath);
  const healthy = await waitGatewayHealth(port, 60000);
  if (!healthy) {
    console.error("[REBUILD] FAILED health timeout — rolling back");
    try { process.kill(newPid, "SIGTERM"); } catch (_) {}
    restore();
    const rollbackPid = spawnGateway(logPath);
    const rollbackHealthy = await waitGatewayHealth(port, 60000);
    console.error(
      "[REBUILD] ROLLBACK " + (rollbackHealthy ? "HEALTH_OK pid=" + rollbackPid : "HEALTH_FAILED"),
    );
    process.exit(1);
  }

  const running = liveGatewayFromMarker();
  const apiSha = sha256File(path.join(__dirname, "api.js"));
  fs.rmSync(prev, { recursive: true, force: true });
  console.log("[REBUILD] HEALTH_OK 200");
  console.log(
    "REBUILD_RESTART_OK old_pid=" + oldPid +
    " new_pid=" + (running ? running.pid : newPid) +
    " api_sha=" + apiSha +
    " dist=" + DIST_DIR,
  );
  process.exit(0);
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
  console.log("  2) START ALL  — kill the env PORT owner, disable systemd,");
  console.log("                  rebuild dist/, bootstrap DB, boot, health-check,");
  console.log("                  enable systemd, then show status + logs");
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
  console.log("  node start.js --build-only     rebuild dist/ from source, then exit");
  console.log("  node start.js --rebuild        stop the live gateway, rebuild, verify, restart, prove /health");
  console.log("  node start.js --start-all -s   rebuild dist/ + boot the server from dist/");
  console.log("  node start.js --status         print live health + systemd + DB status");
  console.log("  node start.js --tail           follow today's runtime log file");
  console.log("  node start.js --health-only    run health checks against existing server");
  process.exit(0);
}

if (args.includes("--config-all") || args.includes("-c")) {
  process.exitCode = configAll();
} else if (args.includes("--build-only")) {
  loadEnv();
  buildDist();
  process.exit(0);
} else if (args.includes("--rebuild")) {
  rebuildRestart().catch((err) => {
    console.error("[REBUILD] FATAL " + (err && err.message ? err.message : String(err)));
    process.exit(1);
  });
} else if (args.includes("--start-all") || args.includes("-s")) {
  startAll();
} else if (args.includes("--status")) {
  loadEnv();
  const port = Number(process.env.PORT) || Number(DEFAULTS.PORT);
  showRuntimeStatus(port)
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error("[STATUS] Failed:", err.message);
      process.exit(1);
    });
} else if (args.includes("--tail")) {
  loadEnv();
  startLogTail(true);
} else if (args.includes("--health-only")) {
  loadEnv();
  const port = Number(process.env.PORT) || Number(DEFAULTS.PORT);
  runHealthChecks(loopbackHost(), port).catch(err => {
    console.error("[HEALTH] Failed:", err.message);
    process.exit(1);
  });
} else {
  showMenu();
}
