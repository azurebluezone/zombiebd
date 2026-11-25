#!/usr/bin/env node
// =============================================================================
// Mission Barisal v3 — Pure API Server
// Zero dependency · Agent Masking · MCP · Intent Verify
// Owner: Sahon Srabon (ZombieCoder) · Barisal, Bangladesh · At Home
// =============================================================================
// Mission Barisal v3 — api.js Navigation Table of Contents
// =============================================================================
// To jump to any section, search for the section header or line range below.
//
// LINE     | SECTION
// ---------+--------------------------------------------------------------------------
//       8  | Core Modules (require: http, https, crypto, fs, path, net, os)
//      18  | Domain Configuration (detectDomain, getDomainConfig)
//      25  | .env Loader (zero-dependency)
//      50  | Config Constants (PORT, OPENCODE_BASE, LOG_DIR, DATA_DIR, etc.)
//      63  | User-Agent Constant + ALLOWED_DIRS
//      74  | Domain Detection (DETECTED_DOMAIN, DOMAIN_CFG)
//      87  | Pusher Config (optional) + SSE Clients Map + UDS_PATH
//     113  | Cache & Git Config
//     124  | Runtime Config + updateRuntimeConfig()
//     153  | OS-Aware Path Resolution + Auto-Setup (NEW — Win/Lin/Mac)
//     195  |   Auto-Setup: ensureDir()
//     210  |   Auto-Setup: readJSONSafe()
//     219  |   Auto-Setup: writeJSONSafe()
//     233  |   Auto-Setup: create or update all config files
//     339  |   Auto-Setup: print setup report
//     375  | System Identity (domain-aware)
//     555  | Provider Registry + Dynamic Routing
//     698  | Competition Router
//     740  | Fallback: resolve all matching providers in priority order
//     758  | Fallback: find next provider in priority order
//     771  | Ensure directories
//     775  | Auto SSOT System
//    1198  | Syllabus & Memory System
//    1600  | Emoji Strip Utility
//    1612  | Logger
//    1686  | Load Personas
//    1745  | Git Runtime Download — Generic File Downloader
//    1814  | DEFAULT AGENTS (Fallback when PERSONAS.md unavailable)
//    2674  | CLIENT LIST PERSISTENCE
//    2976  | Model + Provider Masking System
//    3311  | Gemini API call (non-streaming)
//    3410  | Gemini streaming
//    3896  | Tool Execution Loop
//    4023  | Input Pattern Recognition Engine
//    4208  | Smart Agent Router
//    4260  | Legacy: Simple Greeting Check
//    5815  | Full Mission Execute
//    6193  | SSOT Auto-Inject
//    6261  | Single Agent Execute
//    7354  | Handle MCP message over Unix Domain Socket
//    7937  | Usage Tracking Helpers
//    8013  | HTTP Routes: GET / — Serve UI Dashboard
//    8028  |   GET /health
//    8063  |   GET /api/rate-limit
//    8068  |   POST /api/rate-limit/reset
//    8082  |   GET /identity
//    8108  |   GET /v1/models
//    8136  |   GET /api/v0/models
//    8191  |   GET /api/v1/models
//    8235  |   GET /api/mcp-clients
//    8259  |   GET /api/clients
//    8408  |   GET /api/domain
//    8429  |   GET /api/pusher-config
//    8440  |   GET /api/agents
//    8462  |   GET /api/admin — Admin Dashboard HTML
//    8850  |   GET /api/admin/stats
//    8914  |   GET /api/locks
//    8946  |   POST /api/normalize
//    8987  |   GET/POST /api/config
//    9022  |   POST /api/set-working-dir
//    9054  |   GET /api/ssot
//    9087  |   GET /api/sessions
//    9143  |   GET /api/sessions/{id}
//    9200  | POST /v1/chat/completions (OpenAI-compatible streaming)
//    9956  | POST /api/mission (Unified Socket Architecture)
//   10029  | POST /api/v1/anti-dote (Unified Socket Architecture)
//   10214  | POST /mcp (JSON-RPC 2.0) + GET /mcp (list tools)
//   10302  | POST /api/workspace + POST /api/syllabus
//   10351  | POST /api/input — Unified HTTP entry point
//   10401  | WebSocket (upgrade + message handling)
//   10669  | MCP Socket Server (UDS on Linux/Mac, TCP fallback on Windows)
//   10845  | TransportAdapter class
//   11092  | injectContext() — 3-layer context loader
//   11523  | Cross-Verification Helpers
//   11654  | Compiler Check Helpers
//   11770  | handleMessage() — 8-step processing pipeline
//   11987  | shutdown() — Graceful shutdown + cleanup
// ---------+--------------------------------------------------------------------------
// Total: ~19100 lines · Zero external dependencies · 36 MCP tools (26 gateway + 10 external) · 4 transports
// Section: OS-Aware Auto-Setup (line 153) creates .missionbarisal/ at runtime
//          with version.json, mcp-config.json, vscode.json, jetbrains.json, editor-config.json
// =============================================================================

// ── Core Modules (zero external dependencies) ────────────────
const http = require("http");
const https = require("https");
const http2 = require("http2");
const { URL, pathToFileURL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const netModule = require("net");
const os = require("os");
const externalMcp = require("./external-mcp.js");
const { expandEnv } = require("./lib/expand-env.js");
const {
  slimSyllabus,
  slimSSOT,
} = require("./tools/context-slimmer.js");
const { makeAliasResolver } = require("./tools/model-alias.js");
const {
  normalizeText,
  stripInvisible,
  scanInvisible,
  sanitizeForModel,
  sanitizeForWrite,
} = require("./lib/text-integrity.js");
const { isLoopbackHost, normalizeHost } = require("./lib/net.js");
const { chooseUsableModel } = require("./lib/model-choice.js");
const { loadAgentFiles, getAgentById, listAgentIds, resolveAgentModel } = require("./agent");
const systemInfo = require("./lib/system-info.js");
const { verifySessionWithDomain } = require("./lib/session-verify.js");
const { classifyDbError } = require("./lib/db-guard.js");
const {
  loadProcessEnv,
  SERVICE_PORTS,
  DEFAULTS,
  resolveRuntimePaths,
  userHomeDir,
  expandHome: expandHomePath,
} = require("./lib/env.js");
const {
  resolveProviderTimeouts,
  resolveBridgeTimeouts,
} = require("./lib/provider-timeout.js");
const goalsModule = require("./modules/goals.js");
const verifyModule = require("./modules/verify.js");
const antiDoteModule = require("./modules/anti-dote.js");
const compilerModule = require("./modules/compiler.js");
const agentsModule = require("./modules/agents.js");
const watchdogModule = require("./modules/watchdog.js");
const antiDoteValidateInput = goalsModule.validateInput;
const antiDoteCheckProof = goalsModule.checkProof;
const antiDoteSetGoalContract = goalsModule.setGoalContract;
const antiDoteExecute = goalsModule.executeContract;
const antiDoteVerifyOutput = verifyModule.verifyContract;
const mcpProtocol = require("./modules/mcp-protocol.js");
const contextModule = require("./modules/context.js");
const { pickEntries } = contextModule;
const { buildSystemPrompt, fitPrompt, estimateTokens } = require("./modules/system-prompt.js");
const providerModels = require("./modules/provider-models.js");
const surfacePolicy = require("./modules/surface-policy.js");
const chatInterpreter = require("./modules/chat-interpreter.js");
const chatUpload = require("./modules/chat-upload.js");
const { createProjectMemory } = require("./modules/project-memory.js");
const {
  getIdentity,
  isReadOnly,
  identityMetadata,
  identityPromptBlock,
  identityHeaders,
} = require("./modules/system-identity.js");

// Local MCP servers are stdio children spawned by external-mcp.js. There is
// no per-server port and no /mcp/<name> port-forwarding table.
// ─── Provider layer (official-doc adapters + normalizer) ─────
// Everything wire-related — headers, payloads, dialects, response
// normalization — lives in ./provider and ./normalizer. api.js only routes.
const providerRegistry = require("./provider");
const customProviders = require("./provider/custom.js");
const providerDefaults = require("./provider/defaults");
const providerTransport = require("./provider/transport");
const providerCapabilities = require("./provider/capabilities");
const providerSecretStore = require("./lib/secret-store");
const adminApi = require("./lib/admin-routes");
const adminSession = require("./lib/admin-session");

// The panel is an optional client. public/admin.html is served when present;
// otherwise lib/admin-panel.js renders the built-in panel. Both are lazy, so
// deleting either file never blocks boot: /admin/zombie answers 503 only when
// both are absent, and every non-admin route keeps working.
function loadAdminPanel() {
  try {
    return require("./lib/admin-panel.js");
  } catch (err) {
    return null;
  }
}

function adminPageFile() {
  const dir = path.resolve(
    process.env.ADMIN_DIR || path.join(__dirname, "public"),
  );
  return path.join(dir, "admin.html");
}

function loadAdminPage(options) {
  try {
    const file = adminPageFile();
    if (fs.statSync(file).isFile()) {
      return { html: fs.readFileSync(file, "utf8"), source: "file" };
    }
  } catch (_) {
    /* no static page: use the module fallback */
  }
  const panel = loadAdminPanel();
  if (!panel) return null;
  return { html: panel.renderAdminPanel(options), source: "module" };
}
const toolRegister = require("./provider/tools");
const toolBudget = require("./lib/tool-budget.js");
const sizeBudget = require("./lib/size-budget.js");
const { isModelScopedProviderError } = require("./lib/provider-failure.js");

// The DB mutation routes get the live helpers through one context object.
// Getters keep the DB handle and agent list current without this module
// owning either of them. No admin UI file is read or required here.
function adminApiContext() {
  return {
    adminAuthorized: adminRouteAuthorized,
    jsonResponse,
    readBody,
    log,
    PROVIDER_CONFIG,
    providerSummary,
    providerPriority,
    saveProviderFromAdmin,
    deleteProviderFromAdmin,
    testProviderFromAdmin,
    syncProvidersFromAdmin,
    refreshFreeModels,
    persistProviderDisabled,
    normalizeProviderPriorities,
    get DISABLED_MODELS() { return DISABLED_MODELS; },
    get db() { return MODELS_DB; },
    refreshAgents,
    get agents() { return AGENTS; },
  };
}
// Unified structured log (logs/zc.jsonl). Path resolves from THIS file's
// location — works no matter where the project is checked out.
const zclog = require("./lib/zc-log");

// ─── Domain Configuration (per-server identity) ──────────────
const {
  detectDomain,
  getDomainConfig,
  DOMAIN_CONFIGS,
} = require("./domain-config");

// Source root = this file's directory. In dist this is dist/, so .env is read
// from the built tree. Runtime paths are anchored at APP_ROOT below.
const SOURCE_ROOT = __dirname;

// ─── .env Loader (lib/env.js — the only loader) ─────────────
const _envLoad = loadProcessEnv({ root: SOURCE_ROOT });
if (_envLoad.error) {
  console.error("[ENV] FATAL", _envLoad.file, _envLoad.error);
  process.exit(78);
}
for (const warning of _envLoad.warnings || []) {
  console.warn("[ENV] WARN", _envLoad.file, warning);
}
if (_envLoad.loaded) {
  console.log("[ENV] Loaded:", _envLoad.file, "(" + _envLoad.count + " vars)");
} else {
  console.warn("[ENV] .env not found:", _envLoad.file || "(disabled)");
}

// ─── Config ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || DEFAULTS.PORT, 10);
const MAX_BODY_SIZE = sizeBudget.limit("MAX_BODY_SIZE");
// Unique per-process fingerprint — lets multi-instance tests prove that
// two `node api.js` runs on one machine really are independent processes.
const INSTANCE_ID = process.env.INSTANCE_ID || crypto.randomUUID();
const OPENCODE_BASE = providerDefaults.resolveBaseUrl(
  "opencode",
  process.env.OPENCODE_BASE,
  { env: process.env },
);
const MAX_DEBATE_ROUNDS = parseInt(process.env.MAX_DEBATE_ROUNDS || "0", 10);
// ─── Runtime paths (lib/env.js — the only resolver) ─────────
// DATA_DIR/LOG_DIR/CACHE_DIR/dbPath resolve once, anchored at APP_ROOT.
const RUNTIME_PATHS = resolveRuntimePaths(process.env);
// Project-owned paths (UDS, generated editor config) use APP_ROOT, never dist/.
const PROJECT_ROOT = RUNTIME_PATHS.appRoot;
const LOG_DIR = RUNTIME_PATHS.logDir;
const DATA_DIR = RUNTIME_PATHS.dataDir;
const PERSONAS_FILE = path.resolve(
  PROJECT_ROOT,
  process.env.PERSONAS_FILE || "./PERSONAS.md",
);
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL || "86400000", 10);
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || DEFAULTS.MAX_HISTORY, 10); // reduced from 20→10: 50k+ token history overwhelms free tier models
const GIT_PERSONAS_URL = process.env.GIT_PERSONAS_URL || "";

// ─── User-Agent Constant ────────────────────────────────────
const USER_AGENT = "MissionBarisal-v3/1.0";
let ALLOWED_DIRS = (
  process.env.ALLOWED_DIRS || LOG_DIR + "," + DATA_DIR + "," + PROJECT_ROOT
)
  .split(",")
  .map((d) => path.resolve(PROJECT_ROOT, d.trim()));

// ─── Domain Detection ────────────────────────────────────────
// Domain detected immediately on server start — env var > port heuristic > localhost
const DETECTED_DOMAIN = detectDomain();
const DOMAIN_CFG = getDomainConfig(DETECTED_DOMAIN);
console.log(
  "[DOMAIN] Detected:",
  DETECTED_DOMAIN,
  "| Type:",
  DOMAIN_CFG.type,
  "| Version:",
  DOMAIN_CFG.version,
);

// ─── Pusher Config (optional) ────────────────────────────────
// SECURITY: Default credentials are PLACEHOLDERS only!
// Set PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET via .env for real use.
// Default values below are non-functional examples — do NOT use in production.
const PUSHER_APP_ID = process.env.PUSHER_APP_ID || "";
const PUSHER_KEY = process.env.PUSHER_KEY || "";
const PUSHER_SECRET = process.env.PUSHER_SECRET || "";
const PUSHER_CLUSTER = process.env.PUSHER_CLUSTER || "ap2";
const PUSHER_ENABLED = !!(PUSHER_APP_ID && PUSHER_KEY && PUSHER_SECRET);
if (!PUSHER_ENABLED && process.env.PUSHER_APP_ID) {
  console.warn(
    "[PUSHER] Pusher misconfigured — check PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET in .env",
  );
}

// SSE (Server-Sent Events) clients for MCP streaming
// JetBrains/IDE clients use SSE for persistent MCP transport
// Map: clientId -> { res, connectedAt }
const sseClients = new Map();

// Unix Domain Socket path for MCP
// Priority: 1) env UDS_PORT, 2) DOMAIN_CFG.udsPort, 3) DEFAULTS.UDS_PORT
const UDS_PORT = parseInt(
  process.env.UDS_PORT ||
  (typeof DOMAIN_CFG !== "undefined" ? DOMAIN_CFG.udsPort : null) ||
  DEFAULTS.UDS_PORT,
  10,
);
const { collectUdsPaths } = require("./transport/uds-gateway");

// One option owns every inbound UDS path. `collectUdsPaths` reads UDS_1..N
// (dynamic, gaps allowed) plus the legacy comma list UDS/UDS_PATH/UDS_PATHS.
// Order is fallback order: the first usable path wins, the next one is the
// immediate fallback when a path is busy or cannot be bound.
const UDS_PATHS = collectUdsPaths(process.env, PROJECT_ROOT);
if (UDS_PATHS.length === 0) {
  UDS_PATHS.push(path.resolve(PROJECT_ROOT, DEFAULTS.UDS));
}
const UDS_PATH = UDS_PATHS[0];
let udsServer = null; // legacy MCP-only UDS server
let udsGateway = null; // unified MCP + OpenAI HTTP over one UDS
let openaiUdsServer = null; // legacy separate OpenAI HTTP over UDS

// Every model served by the gateway is reachable through the single inbound
// UDS, so model lists carry an explicit transport tag. Clients use it to show
// "UDS model" next to an entry; the model id itself never changes.
function udsModelFields() {
  const listening =
    process.platform !== "win32" &&
    ((udsGateway && udsGateway.listening) ||
      (udsServer && udsServer.listening) ||
      (openaiUdsServer && openaiUdsServer.server && openaiUdsServer.server.listening));
  return listening ? { transport: "uds", transportLabel: "UDS model" } : {};
}
// Socket ownership is tracked by inode, not by path. On a restart the old
// process can outlive the new listener for a few milliseconds; an unguarded
// unlink then deletes the *new* socket path and leaves a live-but-unreachable
// listener behind (reproduced after the Caddy install restart).
let udsBoundIno = 0;
let udsBoundPath = "";
let udsFallbackUsed = false;
let openaiUdsPath = "";
let openaiUdsIno = 0;
let httpsServer = null; // optional in-process TLS listener
let grpcServer = null; // HTTP/2 + protobuf transport

// ─── Cache & Git Config ─────────────────────────────────────
// Cross-session user cache for accuracy & performance
const CACHE_DIR = RUNTIME_PATHS.cacheDir;
const CACHE_TTL = parseInt(process.env.CACHE_TTL || "86400000", 10); // 24h default
const CACHE_MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES || "1000", 10);

// Git runtime download URLs — personas, skills, instructions
const GIT_SKILLS_URL = process.env.GIT_SKILLS_URL || "";
const GIT_INSTRUCTIONS_URL = process.env.GIT_INSTRUCTIONS_URL || "";
const SKILLS_DIR = path.resolve(PROJECT_ROOT, process.env.SKILLS_DIR || "./skills");

// ─── Runtime Config (changeable via API without restart) ──────
const RUNTIME_CONFIG = {
  sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
  allowedOrigins: DOMAIN_CFG.corsOrigins,
  logLevel: "INFO",
  antiDoteEnabled: process.env.ANTIDOTE_ENABLED !== "false", // default: true
  updatedAt: new Date().toISOString(),
  domain: DETECTED_DOMAIN,
  serverType: DOMAIN_CFG.type,
  serverVersion: DOMAIN_CFG.version,
};

function updateRuntimeConfig(updates) {
  if (updates.sessionVerifyUrl) {
    RUNTIME_CONFIG.sessionVerifyUrl = updates.sessionVerifyUrl;
  }
  if (updates.logLevel) {
    RUNTIME_CONFIG.logLevel = updates.logLevel;
  }
  if (updates.allowedOrigins && Array.isArray(updates.allowedOrigins)) {
    RUNTIME_CONFIG.allowedOrigins = Array.from(new Set([
      ...(DOMAIN_CFG.corsOrigins || []),
      ...updates.allowedOrigins,
    ]));
  }
  if (typeof updates.antiDoteEnabled === "boolean") {
    RUNTIME_CONFIG.antiDoteEnabled = updates.antiDoteEnabled;
  }
  RUNTIME_CONFIG.updatedAt = new Date().toISOString();
  persistRuntimeConfig(); // survive restart (settings KV)
  return { ...RUNTIME_CONFIG };
}

// Persist/load RUNTIME_CONFIG in the settings table — the config page
// now actually DOES something beyond this boot.
function persistRuntimeConfig() {
  if (!MODELS_DB) return;
  try {
    const { updatedAt, ...rest } = RUNTIME_CONFIG;
    MODELS_DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('runtime_config', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(JSON.stringify(rest), Date.now());
    log("INFO", "RUNTIME_CONFIG_SAVED", { keys: Object.keys(rest) });
  } catch (e) {
    log("WARN", "RUNTIME_CONFIG_SAVE_FAIL", { error: e.message });
  }
}

function loadRuntimeConfig() {
  if (!MODELS_DB) return;
  try {
    const row = MODELS_DB.prepare(
      "SELECT value FROM settings WHERE key = 'runtime_config'"
    ).get();
    if (!row || !row.value) return;
    const saved = JSON.parse(row.value);
    for (const k of ["sessionVerifyUrl", "logLevel", "antiDoteEnabled"]) {
      if (saved[k] !== undefined) RUNTIME_CONFIG[k] = saved[k];
    }
    if (Array.isArray(saved.allowedOrigins)) {
      RUNTIME_CONFIG.allowedOrigins = saved.allowedOrigins;
    }
    // The effective allowlist is derived origins + persisted origins + the
    // origin of the configured session verifier. This keeps a local verifier
    // on :3000 usable even when the SQLite row predates it.
    const merged = new Set([
      ...(DOMAIN_CFG.corsOrigins || []),
      ...(RUNTIME_CONFIG.allowedOrigins || []),
    ]);
    try {
      merged.add(new URL(RUNTIME_CONFIG.sessionVerifyUrl).origin);
    } catch (_) { /* empty or relative verifier URL */ }
    RUNTIME_CONFIG.allowedOrigins = Array.from(merged);
    RUNTIME_CONFIG.updatedAt = new Date().toISOString();
    log("INFO", "RUNTIME_CONFIG_LOADED", { keys: Object.keys(saved) });
  } catch (e) {
    log("WARN", "RUNTIME_CONFIG_LOAD_FAIL", { error: e.message });
  }
}

// ─── OS-Aware Path Resolution + Auto-Setup ─────────────────────
// Cross-platform: detects Windows/Linux/macOS at runtime.
// Variables auto-resolve root directories per OS.
// Directories created automatically on server start.
// If config files exist, they are updated (replaced), not recreated.
const _PLATFORM = os.platform();
const _IS_WINDOWS = _PLATFORM === "win32";
const _IS_LINUX = _PLATFORM === "linux";
const _IS_MACOS = _PLATFORM === "darwin";

function getOSRootDir() {
  if (_IS_WINDOWS) return process.env.SYSTEMDRIVE || "C:";
  return "/";
}
const _OS_ROOT_DIR = getOSRootDir();
const _HOSTNAME = os.hostname();

// .missionbarisal/ folder at project root (runtime config directory)
const _MISSION_BARISAL_DIR = path.join(RUNTIME_PATHS.appRoot, ".missionbarisal");

// ─── Auto-Setup: ensure directory exists ──────────────────────
function ensureDir(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      console.log("[AUTO-SETUP] + Created directory:", dirPath);
      return { created: true, path: dirPath };
    }
    return { created: false, path: dirPath };
  } catch (err) {
    console.error("[AUTO-SETUP] ! Failed to create:", dirPath, err.message);
    return { created: false, path: dirPath, error: err.message };
  }
}

// ─── Auto-Setup: read JSON with fallback ──────────────────────
function readJSONSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) { }
  return fallback;
}

// ─── Auto-Setup: write JSON atomically ────────────────────────
function writeJSONSafe(filePath, data) {
  try {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + ".tmp." + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    console.error("[AUTO-SETUP] ! Failed to write:", filePath, err.message);
    return false;
  }
}

// ─── Auto-Setup: create or update all config files ────────────
function autoSetupConfig() {
  const results = [];
  // 1) Ensure .missionbarisal/ directory
  const d = ensureDir(_MISSION_BARISAL_DIR);
  results.push({
    type: "dir",
    path: _MISSION_BARISAL_DIR,
    action: d.created ? "created" : "already-exists",
  });

  // 2) Default config templates (in-memory, not separate files)
  // Every URL is derived from APP_URL; no port or scheme is written by hand.
  const publicOrigin = (DOMAIN_CFG.appUrl || `http://localhost:${PORT}`).replace(/\/+$/, "");
  const wsOrigin = publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const defaults = {
    "version.json": {
      version: "3.2.1",
      build: "20260925",
      name: "Mission Barisal Gateway",
      description: "Cross-editor MCP agent gateway",
      author: "ZombieCoder",
      compatibleEditors: ["vscode", "jetbrains", "cursor"],
      minEngineVersion: "18.0.0",
      lastUpdated: new Date().toISOString(),
    },
    "mcp-config.json": {
      name: "Mission Barisal Gateway",
      transport: { type: "http", url: publicOrigin + "/mcp" },
      endpoints: {
        http: publicOrigin,
        uds: UDS_PATH,
        ws: wsOrigin,
      },
      tools: [
        "read_file",
        "write_file",
        "set_working_dir",
        "get_working_dir",
        "list_directory",
        "web_search",
        "read_ssot",
        "get_memory",
        "agent_mission",
        "agent_single",
        "terminal",
        "delete_file",
        "rename_file",
        "grep",
        "glob",
      ],
      timeout: 300000,
    },
    "vscode.json": {
      editor: "vscode",
      settings: {
        "mission-barisal.serverUrl": publicOrigin,
        "mission-barisal.udsPath": UDS_PATH,
        "mission-barisal.agentMode": "mission",
      },
    },
    "jetbrains.json": {
      editor: "jetbrains",
      settings: {
        "mission-barisal.serverUrl": publicOrigin,
        "mission-barisal.udsPath": UDS_PATH,
        "mission-barisal.agentMode": "mission",
      },
    },
    "editor-config.json": {
      version: "1.0",
      global: {
        serverUrl: publicOrigin,
        udsPath: UDS_PATH,
        agentMode: "mission",
        autoConnect: true,
      },
      editors: {
        vscode: { transport: ["http", "uds", "ws"] },
        jetbrains: { transport: ["http", "uds"] },
        cursor: { transport: ["http", "ws"] },
      },
    },
  };

  // 3) Create or update each config file
  for (const [filename, defaultData] of Object.entries(defaults)) {
    const filePath = path.join(_MISSION_BARISAL_DIR, filename);
    if (fs.existsSync(filePath)) {
      const existing = readJSONSafe(filePath, {});
      const merged = {
        ...existing,
        ...defaultData,
        lastUpdated: new Date().toISOString(),
      };
      const ok = writeJSONSafe(filePath, merged);
      results.push({
        type: "file",
        name: filename,
        action: ok ? "updated" : "update-failed",
      });
    } else {
      const data = { ...defaultData, lastUpdated: new Date().toISOString() };
      const ok = writeJSONSafe(filePath, data);
      results.push({
        type: "file",
        name: filename,
        action: ok ? "created" : "create-failed",
      });
    }
  }
  return results;
}

// ─── Auto-Setup: print setup report ───────────────────────────
// Format contract (matches the reference block in logs/a1.md):
//   banner + "  OS: ... | Root: ... | Host: ..." + "  [x] type: name (action)"
// v3.2.1 fixes: failures used to get SUCCESS glyphs ([+]/[~] for
// create-failed/update-failed), the glyphs had no legend, and the report
// carried no timestamp or summary. Lines for successful actions are
// byte-identical to the original format.
function printSetupReport(results) {
  const counts = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  console.log("\n=== AUTO-SETUP REPORT ===");
  console.log("  Time: " + new Date().toISOString());
  console.log(
    "  OS:",
    _PLATFORM,
    "| Root:",
    _OS_ROOT_DIR,
    "| Host:",
    _HOSTNAME,
  );
  console.log("  Legend: [+] created  [ ] unchanged  [~] updated  [!] failed");
  for (const r of results) {
    const act = r.action;
    const failed = act.endsWith("-failed");
    const glyph = failed
      ? "!"
      : act.startsWith("create")
        ? "+"
        : act.startsWith("update")
          ? "~"
          : " ";
    if (failed) counts.failed++;
    else if (act.startsWith("create")) counts.created++;
    else if (act.startsWith("update")) counts.updated++;
    else counts.unchanged++;
    console.log(
      "  [" +
      glyph +
      "] " +
      r.type +
      ": " +
      (r.name || r.path || "") +
      " (" +
      act +
      ")",
    );
  }
  console.log(
    "  Summary: " +
    counts.created +
    " created, " +
    counts.updated +
    " updated, " +
    counts.unchanged +
    " unchanged, " +
    counts.failed +
    " failed",
  );
  if (counts.failed > 0) {
    console.log("  SETUP FAILURES — check permissions on the items marked [!] above");
  }
  console.log("=========================\n");
}

// Execute auto-setup immediately on server start
const _setupResults = autoSetupConfig();
printSetupReport(_setupResults);

// ─── Immutable identity core (identity.json) ─────────────────
// The file is read-only; the parsed object is deep-frozen by the module.
// A broken/missing file must not stop the gateway: the fallback below keeps
// the server answering and logs the problem once.
let _IMMUTABLE_IDENTITY = null;
function systemIdentityCore() {
  if (_IMMUTABLE_IDENTITY) return _IMMUTABLE_IDENTITY;
  try {
    _IMMUTABLE_IDENTITY = getIdentity();
    if (!isReadOnly()) {
      log("WARN", "IDENTITY_FILE_WRITABLE", {
        path: "identity.json",
        hint: "chmod 444 identity.json to make the identity core read-only",
      });
    }
  } catch (e) {
    log("WARN", "IDENTITY_LOAD_FAIL", { error: e.message });
    _IMMUTABLE_IDENTITY = {
      name: "Mission Barisal",
      product: "ZombieCoder",
      version: DOMAIN_CFG.version,
      tagline: "Where code and words speak",
      branding: {
        owner: "Sahon Srabon",
        organization: "Developer Zone",
        address: "",
        location: "",
      },
      contact: { email: "", website: "" },
      license: "Proprietary - Local Freedom Protocol",
      identity_anchor: "",
    };
  }
  return _IMMUTABLE_IDENTITY;
}

/** Attach ownership headers to every outgoing HTTP response. */
function setSystemIdentityHeaders(res) {
  try {
    const headers = identityHeaders(systemIdentityCore());
    for (const [name, value] of Object.entries(headers)) {
      if (!res.headersSent) res.setHeader(name, value);
    }
  } catch (_) {
    /* identity headers must never break a response */
  }
}

const intentModule = require("./modules/intent.js");
const INTENT_EXTRACT_PROMPT = intentModule.PROMPTS.extract;
const ALIGNMENT_CHECK_PROMPT = intentModule.PROMPTS.alignment;
const PROOF_CHECK_PROMPT = intentModule.PROMPTS.proof;

// 
//  ANTI-DOTE TYPE SAFETY SYSTEM — Error Types & Classes
// 
// Fundamental Theorem:
//   ∀req ∈ AntidoteRequest: validateSchema(req) ∧ checkProof(req)
//     ⇒ setGoalContract(req) ⇒ execute(req) ⇒ verifyOutput(res)
//
//   P(execute(req) = expected) = 1 × 1 × 1 × 1 × 1 = 1 (certainty)
//
// Error types (6): INVALID_REQUEST, PROOF_FAILED, LIMIT_EXCEEDED,
//                  CONTRACT_FAILED, EXECUTION_FAILED, VERIFICATION_FAILED

// ─── Provider Registry + Dynamic Routing ────────────────────
// ─── Model Entry Helpers ──────────────────────────────────
// Each model entry can be:
//   string: "model-name" — name is both public and API model (no masking)
//   object: { name, apiModel } — name=public, apiModel=name sent to provider (masked)
function getModelName(m) {
  return typeof m === "string" ? m : m.name;
}
function getApiModelName(m) {
  return typeof m === "string" ? m : m.apiModel || m.name;
}

// Resolve public model name to API provider model name (masking reverse)
// providerId parameter added: searches within specific provider only.
function resolveApiModel(publicModelName, providerId) {
  publicModelName = applyModelAlias(publicModelName); // public alias -> canonical
  // 1. Search within specific provider (if providerId given)
  if (providerId && PROVIDER_CONFIG[providerId]) {
    const p = PROVIDER_CONFIG[providerId];
    // Search by name first
    for (const m of p.models) {
      if (getModelName(m) === publicModelName) return getApiModelName(m);
    }
    // The requested name may already be this provider's API model (a masked
    // public name and its apiModel can differ). Send the API model as-is.
    return publicModelName;
  }
  // 2. Fallback: search all providers (old behaviour)
  for (const p of Object.values(PROVIDER_CONFIG)) {
    for (const m of p.models) {
      if (getModelName(m) === publicModelName) return getApiModelName(m);
    }
  }
  return publicModelName;
}

// ─── Provider Registry ────────────────────────────────────
// Each provider supplies its own model list.
// Haq Mawla normalizer converts all provider responses to OpenAI format.
// competitionRouter: model -> provider -> API call -> normalize -> agent

// ─── Env Model Parser ──────────────────────────────────────
// Parses a comma-separated model env var into model entries.
//   "model-a"            → string entry (no masking)
//   "name:apiModel"      → { name, apiModel } masked pair
function parseModelsEnv(str) {
  if (!str || !str.trim()) return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      // "name=>apiModel" is the unambiguous form; "name:apiModel" stays for
      // existing env files where a model id never contains a colon.
      const arrow = entry.indexOf("=>");
      if (arrow > 0) {
        return {
          name: entry.slice(0, arrow).trim(),
          apiModel: entry.slice(arrow + 2).trim(),
        };
      }
      const idx = entry.indexOf(":");
      if (idx > 0) {
        return {
          name: entry.slice(0, idx).trim(),
          apiModel: entry.slice(idx + 1).trim(),
        };
      }
      return entry;
    });
}

// Provider wire quirks that the OpenAI schema does not define arrive as one
// JSON object. Invalid JSON is ignored with a log line instead of crashing.
function jsonObjectEnv(name) {
  const raw = process.env[name];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    log("WARN", "PROVIDER_EXTRA_BODY_INVALID", { env: name, error: e.message });
    return undefined;
  }
  log("WARN", "PROVIDER_EXTRA_BODY_INVALID", { env: name, error: "not a JSON object" });
  return undefined;
}

// Custom providers use "name=>apiModel" for a masked pair. A plain colon is
// not a delimiter here: local model tags contain one (qwen2:0.5b, ...:8b), so
// splitting on ":" would turn a tag into a bogus mask.
function parseCustomModelsEnv(str) {
  if (!str || !str.trim()) return [];
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf("=>");
      if (idx > 0) {
        const name = entry.slice(0, idx).trim();
        const apiModel = entry.slice(idx + 2).trim();
        if (name && apiModel) return { name, apiModel };
      }
      return entry;
    });
}

// ─── Provider Registry ────────────────────────────────────
// Each provider supplies its own model list.
// Haq Mawla normalizer converts all provider responses to OpenAI format.
// competitionRouter: model -> provider -> API call -> normalize -> agent
//
// NO HARDCODED MODELS — every provider loads its model list from env:
//   OPENCODE_MODELS, GROQ_MODELS, GEMINI_MODELS, CUSTOM_PROVIDER_N_MODELS
// Priorities also come from env: OPENCODE_PRIORITY, GROQ_PRIORITY, ...
const PROVIDER_CONFIG = {
  opencode: {
    name: "OpenCode",
    baseUrl: providerDefaults.resolveBaseUrl("opencode", process.env.OPENCODE_BASE, {
      env: process.env,
    }),
    // A placeholder value ("<YOUR_..._KEY>") is not a credential. Treating it
    // as one sent a literal placeholder upstream and produced confusing 401s
    // instead of the provider simply being unavailable. An empty/placeholder
    // key now disables this provider; every other provider keeps working.
    key:
      /^(<.*>|\{\{.*\}\}|YOUR_|CHANGEME|xxx+)$/i.test(
        (process.env.OPENCODE_API_KEY || "").trim()
      )
        ? ""
        : process.env.OPENCODE_API_KEY || "",
    priority: parseInt(process.env.OPENCODE_PRIORITY || "999", 10), // NaN-proof: unset → lowest
    type: process.env.OPENCODE_TYPE || "openai",
    models: parseModelsEnv(process.env.OPENCODE_MODELS || ""),
  },
  // ── Groq (Secondary Fallback) ────────────────────────────
  // Acts as a pipeline provider — routes model names to their Groq equivalents.
  // When OpenCode fails, Groq serves as fallback.
  groq: {
    name: "Groq",
    baseUrl: providerDefaults.resolveBaseUrl("groq", process.env.GROQ_BASE, {
      env: process.env,
    }),
    key: process.env.GROQ_API_KEY || "",
    priority: parseInt(process.env.GROQ_PRIORITY || "999", 10), // NaN-proof: unset → lowest
    type: process.env.GROQ_TYPE || "openai",
    models: parseModelsEnv(process.env.GROQ_MODELS || ""),
  },
  // ── Gemini (Tertiary) ──────────────────────────────────────
  // Requires API key — OpenCode -> Groq -> Gemini fallback chain
  gemini: {
    name: "Gemini",
    baseUrl: providerDefaults.resolveBaseUrl("gemini", process.env.GEMINI_BASE, {
      env: process.env,
    }),
    key: process.env.GEMINI_API_KEY || "",
    priority: parseInt(process.env.GEMINI_PRIORITY || "999", 10), // NaN-proof: unset → lowest
    type: "gemini", // special: Gemini API (NOT OpenAI-compatible)
    models: parseModelsEnv(process.env.GEMINI_MODELS || ""),
  },
  // ── Cloudflare — REMOVED as a provider (2026-10-11, user request).
  //    No CF_* env vars, no provider entry, no DB rows, no docs. The generic
  //    CUSTOM_PROVIDER_N_* env mechanism covers any future OpenAI-compatible GW.
  // ── Ollama (Local + Cloud LLM) ─────────────────────────
  // First-class provider (NOT a custom_N provider). Serves local models
  // pulled via `ollama pull` AND cloud models (when the Ollama server's
  // cloud remote is reachable: OLLAMA_REMOTES / OLLAMA_NO_CLOUD) — both
  // surface through the same /v1/models endpoint, so dynamic discovery
  // yields "cloud if API else local" behaviour automatically.
  ollama: {
    name: "Ollama",
    baseUrl: providerDefaults.resolveBaseUrl("ollama", process.env.OLLAMA_BASE, {
      env: process.env,
      dialect: process.env.OLLAMA_DIALECT || "",
    }),
    // Local Ollama uses OLLAMA_API_KEY only. The cloud credential belongs to
    // the separate ollama_cloud provider; a fallback here silently sent the
    // cloud key to a local server and made the two providers indistinguishable.
    key: process.env.OLLAMA_API_KEY || "",
    priority: parseInt(process.env.OLLAMA_PRIORITY || "999", 10), // NaN-proof: unset → lowest
    type: process.env.OLLAMA_TYPE || "openai",
    // adapterFor() matches the provider id before `type`, so OLLAMA_DIALECT
    // selects the wire format. Set openai for /v1 endpoints; empty keeps the
    // native /api/chat path.
    dialect: process.env.OLLAMA_DIALECT || "",
    // Provider calls can exceed the 60s transport default while still
    // producing a valid answer. Both deadlines come from one resolver.
    ...resolveProviderTimeouts("ollama", process.env),
    // Model list is not hardcoded: the DB or provider sync supplies it. The
    // env override keeps Ollama tags intact ("qwen2:0.5b" is one model id).
    models: parseCustomModelsEnv(process.env.OLLAMA_MODELS || ""),
    // Model discovery is dynamic (the server can start or stop while the
    // gateway runs). This is a capability, not a "local" category.
    dynamicModels: true,
  },
  // ── Ollama Cloud (first-class provider) ────────────────────
  // Same native /api/chat dialect as local Ollama, but at ollama.com with a
  // Bearer key. Kept separate so the key never leaks into the local path and
  // so the model lists (local tags vs cloud catalog) stay independent.
  ollama_cloud: {
    name: "Ollama Cloud",
    baseUrl: providerDefaults.resolveBaseUrl("ollama_cloud", process.env.OLLAMA_CLOUD_BASE, {
      env: process.env,
      dialect: process.env.OLLAMA_CLOUD_DIALECT || "",
    }),
    key: process.env.OLLAMA_CLOUD_API_KEY || "",
    priority: parseInt(process.env.OLLAMA_CLOUD_PRIORITY || "999", 10),
    type: process.env.OLLAMA_CLOUD_TYPE || "openai",
    dialect: process.env.OLLAMA_CLOUD_DIALECT || "",
    // Same resolver as the local Ollama entry, with the cloud env prefix.
    ...resolveProviderTimeouts("ollama_cloud", process.env),
    models: parseCustomModelsEnv(process.env.OLLAMA_CLOUD_MODELS || ""),
    dynamicModels: true,
  },
  // ── Local LLM bridge (first-class provider) ────────────────
  // The bridge is one OpenAI-compatible source. Its own upstream discovery
  // stays inside the bridge; the gateway does not make it a router above the
  // other providers.
  bridge: {
    name: "Local LLM Bridge",
    baseUrl: providerDefaults.resolveBaseUrl("bridge", process.env.BRIDGE_BASE, {
      env: process.env,
    }),
    key: process.env.BRIDGE_API_KEY || "",
    priority: parseInt(process.env.BRIDGE_PRIORITY || "999", 10),
    type: "openai",
    models: parseCustomModelsEnv(process.env.BRIDGE_MODELS || ""),
    enabled: process.env.BRIDGE_ENABLED !== "0",
    dynamicModels: true,
    // The gateway deadline must not fire before the bridge's own upstream
    // timeout; the resolver adds the grace.
    ...resolveProviderTimeouts("bridge", process.env),
  },
};

// Every provider object keeps the env key separately from the effective key.
// The effective key can be replaced by a DB row; `envKey` stays the fallback
// so a DB row without a key never disables an env-configured provider.
for (const p of Object.values(PROVIDER_CONFIG)) {
  p.envKey = p.key || "";
  p.keySource = p.key ? "env" : "none";
  p.source = "env";
  // Every list above came from an env var. Remember it: a partial or transient
  // remote `/models` response must never delete a model the user declared.
  // Custom providers keep `envModels` as a strict allowlist (set below).
  if (
    !Array.isArray(p.envModels) &&
    Array.isArray(p.models) &&
    p.models.length > 0
  ) {
    p.envModels = p.models.slice();
  }
}

// Boot evidence: the bridge deadline is computed from the same value the
// bridge itself uses, so a mismatch is visible before the first request.
const _bridgeTimeout = resolveBridgeTimeouts(process.env);
console.log(
  "[PROVIDER_TIMEOUT] bridge upstream=" +
    _bridgeTimeout.upstream +
    " gateway=" +
    _bridgeTimeout.timeout +
    " stream=" +
    _bridgeTimeout.streamTimeout,
);

// Explicit provider off switch (env). The entry stays in PROVIDER_CONFIG so
// admin code that reads it never hits undefined; every resolve/sync/catalog
// path checks `enabled === false` and skips it. OPENCODE_ENABLED=false keeps
// the Zen free tier closed after its malformed-stream failures.
if (String(process.env.OPENCODE_ENABLED || "").toLowerCase() === "false") {
  PROVIDER_CONFIG.opencode.enabled = false;
  PROVIDER_CONFIG.opencode.envDisabled = true;
}

// ─── Dynamic Custom Provider Loader ─────────────────────────
// provider/custom.js is the one env→config resolver. This function only
// projects that config into PROVIDER_CONFIG; DB rows are applied later by
// loadProvidersFromDb(). N is any positive integer (no list, no cap), and
// every custom_N provider speaks the OpenAI /v1 protocol.
function loadCustomProviders() {
  const numbers = customProviders.listCustomNumbers(process.env);
  let loaded = 0;

  for (const num of numbers) {
    if (!customProviders.enabledFromEnv(num, process.env)) {
      console.log(
        "[CUSTOM_PROVIDER_" + num + "] Disabled (ENABLED=false) — skipped",
      );
      continue;
    }

    const cfg = customProviders.fromEnv(num, process.env);
    if (!cfg) {
      console.warn(
        "[CUSTOM_PROVIDER_" + num + "] Skipped: no URL or SOCKET set",
      );
      continue;
    }

    const native = customProviders.requestedType(num, process.env);
    if (native) {
      log("WARN", "CUSTOM_PROVIDER_TYPE_IGNORED", {
        provider: cfg.id,
        configured: native,
        using: "openai",
        hint:
          "custom_N is OpenAI-compatible only; create a DB provider with the native type instead",
      });
    }

    const models = cfg.modelsStr ? parseCustomModelsEnv(cfg.modelsStr) : ["*"];
    PROVIDER_CONFIG[cfg.id] = {
      name: cfg.name,
      baseUrl: cfg.baseUrl,
      socketPath: cfg.socketPath,
      key: cfg.key,
      envKey: cfg.envKey,
      keySource: cfg.keySource,
      source: "env",
      priority: cfg.priority,
      type: "openai",
      models: models,
      // An explicit CUSTOM_PROVIDER_N_MODELS list is an allowlist, not a
      // seed to be expanded by the live catalog. Kept separately so a stale
      // DB row cannot re-expand the provider on the next boot.
      envModels: cfg.modelsStr ? models.slice() : null,
      custom: true,
      ...(cfg.timeout ? { timeout: cfg.timeout } : {}),
      ...(cfg.streamTimeout ? { streamTimeout: cfg.streamTimeout } : {}),
      ...(cfg.maxPromptChars ? { maxPromptChars: cfg.maxPromptChars } : {}),
      ...(cfg.maxTools !== undefined ? { maxTools: cfg.maxTools } : {}),
      ...(cfg.contextWindow ? { contextWindow: cfg.contextWindow } : {}),
      ...(cfg.media ? { media: true } : {}),
    };
    loaded++;
    console.log(
      "[CUSTOM_PROVIDER] Loaded: " + cfg.name + " (" + cfg.baseUrl + ")",
    );
  }

  if (loaded > 0) {
    console.log("[CUSTOM_PROVIDER] Total loaded: " + loaded);
  }
}
loadCustomProviders();

// 
//   SQLite MODELS DATABASE (zero-dependency via node:sqlite)
// 
// The API Normalizer syncs provider models into a `models` table.
// Lookup order: DB first → env (PROVIDER_CONFIG) → fallback reply.
// The DB is mandatory: missing, busy or corrupt stops boot with DB_FATAL.
let MODELS_DB = null;
// DB path priority: env DB_SQLITE_PATH → DATA_DIR/models.db (fallback).
// A missing file is fatal unless DB_BOOTSTRAP=1 explicitly asks for creation.
// Every project-owned path is resolved once so the boot log and the real
// file handles can never disagree. Relative values are already anchored at
// APP_ROOT by lib/env.js, never at the shell's cwd.
const MODELS_DB_PATH = RUNTIME_PATHS.dbPath;

for (const [name, value] of Object.entries({
  APP_ROOT: RUNTIME_PATHS.appRoot,
  DATA_DIR: RUNTIME_PATHS.dataDir,
  LOG_DIR: RUNTIME_PATHS.logDir,
  CACHE_DIR: RUNTIME_PATHS.cacheDir,
  TMP_DIR: RUNTIME_PATHS.tmpDir,
  DB_SQLITE_PATH: RUNTIME_PATHS.dbPath,
  TTS_OUTPUT_DIR: RUNTIME_PATHS.ttsOutputDir,
  SCREEN_RECORDINGS_DIR: RUNTIME_PATHS.screenDir,
  MCP_OUTPUT_DIR: RUNTIME_PATHS.mcpOutputDir,
})) {
  console.log("PATH_RESOLVED name=" + name + " path=" + value);
}

// Provider API keys are encrypted with a key file that lives beside the DB,
// never inside it. Configure before the first DB row is read or written.
providerSecretStore.configure(
  path.join(path.dirname(MODELS_DB_PATH), ".provider-keys.key"),
);

// A DB problem is a boot failure, not a warning. Exit 78 (EX_CONFIG) so a
// service manager sees a configuration failure instead of serving env-only
// "healthy" answers whose capabilities were never proven.
function dbFatal(reason, detail) {
  const extra = detail && detail.error
    ? " error=" + String(detail.error).replace(/\s+/g, " ")
    : "";
  const line = "DB_FATAL " + reason + " path=" + MODELS_DB_PATH + extra + "\n";
  try { fs.writeSync(2, line); } catch (_) {}
  try {
    log("ERROR", "DB_FATAL", Object.assign({ reason, path: MODELS_DB_PATH }, detail || {}));
  } catch (_) {}
  process.exit(78); // EX_CONFIG
}

function sleepSyncMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {}
}

// Initialize the models database + table.
function initModelsDb(attempt) {
  attempt = attempt || 1;
  try {
    const { DatabaseSync } = require("node:sqlite");
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // No implicit remote snapshot: a fresh DB is created only when the
    // operator explicitly sets DB_BOOTSTRAP=1.
    if (!fs.existsSync(MODELS_DB_PATH)) {
      if (String(process.env.DB_BOOTSTRAP || "0") !== "1") {
        dbFatal("missing", {
          error: "set DB_BOOTSTRAP=1 to create a new models database",
        });
      }
      log("INFO", "DB_BOOTSTRAP_CREATE", { path: MODELS_DB_PATH });
    }
    MODELS_DB = new DatabaseSync(MODELS_DB_PATH);
    // WAL: one writer (this gateway) with concurrent readers (admin pages,
    // checks). NORMAL is the safe WAL pairing and avoids an fsync per txn.
    // busy_timeout bounds each attempt; the outer catch retries a lock.
    const busyTimeout = Math.max(
      0,
      parseInt(process.env.DB_BUSY_TIMEOUT_MS || "5000", 10) || 0,
    );
    MODELS_DB.exec("PRAGMA busy_timeout = " + busyTimeout + ";");
    // A file that opens but fails integrity is still unusable. Check before
    // writing schema so corruption is reported, never silently repaired.
    const check = MODELS_DB.prepare("PRAGMA quick_check").get();
    const integrity = check ? String(Object.values(check)[0] || "") : "";
    if (integrity.toLowerCase() !== "ok") {
      const err = new Error("integrity_check=" + (integrity || "empty"));
      err.code = "SQLITE_CORRUPT";
      throw err;
    }
    MODELS_DB.exec("PRAGMA journal_mode = WAL;");
    MODELS_DB.exec("PRAGMA synchronous = NORMAL;");
    MODELS_DB.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        api_model TEXT NOT NULL,
        provider_name TEXT,
        type TEXT,
        priority INTEGER DEFAULT 99,
        updated_at INTEGER DEFAULT 0,
        UNIQUE(provider, name)
      );
      CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
      CREATE INDEX IF NOT EXISTS idx_models_api ON models(api_model);
      CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);

      -- Provider registry. Env-defined providers get a mirror row
      -- (source='env') on every sync so the DB always carries the live
      -- registry; source='db' means admin-managed overrides (edited key,
      -- base URL, socket path or a custom provider).
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'openai',
        base_url TEXT NOT NULL DEFAULT '',
        api_key TEXT NOT NULL DEFAULT '',
        models TEXT NOT NULL DEFAULT '',
        socket_path TEXT NOT NULL DEFAULT '',
        priority INTEGER DEFAULT 99,
        enabled INTEGER DEFAULT 1,
        requires_key INTEGER DEFAULT NULL,
        source TEXT NOT NULL DEFAULT 'db',
        created_at INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT 0
      );

      -- PHASE A (2026-08-10): agents table — DB-first persona source.
      -- PERSONAS.md + .zombiecoder/agents/*.md remain as fallback/override (100% kept).
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT,
        model TEXT,
        expertise TEXT,
        persona TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 99,
        updated_at INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);

      -- PHASE B (2026-08-10): users + sessions tables (minimal API auth).
      -- api_key is stored as sha256 hex (never plaintext). sessions hold
      -- short-lived bearer tokens issued by /api/auth/verify.
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        enabled INTEGER DEFAULT 1,
        token_limit INTEGER DEFAULT 0,
        valid_days INTEGER DEFAULT 0,
        token_used INTEGER DEFAULT 0,
        expires_at INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        token TEXT NOT NULL,
        created_at INTEGER DEFAULT 0,
        expires_at INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    `);
    // UI-1 migration: add token_limit / valid_days / token_used / expires_at
    // to an existing users table (idempotent — safe on fresh installs too).
    try {
      const cols = MODELS_DB.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
      const addCol = (col, ddl) => {
        if (!cols.includes(col)) {
          MODELS_DB.prepare("ALTER TABLE users ADD COLUMN " + ddl).run();
        }
      };
      addCol("token_limit", "token_limit INTEGER DEFAULT 0");
      addCol("valid_days", "valid_days INTEGER DEFAULT 0");
      addCol("token_used", "token_used INTEGER DEFAULT 0");
      addCol("expires_at", "expires_at INTEGER DEFAULT 0");
    } catch (migErr) {
      log("WARN", "USERS_MIGRATE_FAIL", { error: migErr.message });
    }
    // Registry migrations: models can be toggled from the admin panel.
    //   enabled — admin on/off (sync upserts NEVER touch it, so the flag survives)
    //   pinned  — seeded from remote registry; syncModelsToDb's stale-row DELETE
    //             skips pinned rows (otherwise remote seeds vanish next boot)
    try {
      const mcols = MODELS_DB.prepare("PRAGMA table_info(models)").all().map((c) => c.name);
      if (!mcols.includes("enabled")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN enabled INTEGER DEFAULT 1").run();
      if (!mcols.includes("pinned")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN pinned INTEGER DEFAULT 0").run();
    } catch (migErr) {
      log("WARN", "MODELS_MIGRATE_FAIL", { error: migErr.message });
    }
    // Provider capability columns — supports_tools / supports_media /
    // supports_stream (NULL ⇒ unknown ⇒ ALLOW — never hardcode model names).
    try {
      const pcols = MODELS_DB.prepare("PRAGMA table_info(models)").all().map((c) => c.name);
      if (!pcols.includes("supports_tools")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN supports_tools INTEGER DEFAULT NULL").run();
      if (!pcols.includes("supports_media")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN supports_media INTEGER DEFAULT NULL").run();
      if (!pcols.includes("supports_stream")) MODELS_DB.prepare("ALTER TABLE models ADD COLUMN supports_stream INTEGER DEFAULT NULL").run();
    } catch (migErr) {
      log("WARN", "MODELS_CAP_MIGRATE_FAIL", { error: migErr.message });
    }
    // Provider registry + tool register share the SAME live DB handle —
    // capability lookups are DB-direct, never cached from an env list.
    providerRegistry.setDatabase(MODELS_DB);
    // settings KV — persisted runtime state (provider_disabled etc.)
    MODELS_DB.prepare(
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0)"
    ).run();
    // Gateway telemetry — ONE database holds every table/column this
    // gateway needs: request log, session log, provider/model/agent/tool stats.
    MODELS_DB.exec(`
      CREATE TABLE IF NOT EXISTS request_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        path TEXT,
        session_id TEXT,
        editor TEXT,
        agent TEXT,
        model TEXT,
        provider TEXT,
        upstream_provider TEXT,
        status INTEGER,
        ok INTEGER DEFAULT 1,
        elapsed_ms INTEGER DEFAULT 0,
        swap_count INTEGER DEFAULT 0,
        domain TEXT,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts);
      CREATE INDEX IF NOT EXISTS idx_request_log_session ON request_log(session_id);
      CREATE TABLE IF NOT EXISTS session_log (
        id TEXT PRIMARY KEY,
        editor TEXT,
        agent TEXT,
        model TEXT,
        provider TEXT,
        status TEXT DEFAULT 'active',
        requests INTEGER DEFAULT 0,
        created_at INTEGER,
        last_seen INTEGER,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_log_seen ON session_log(last_seen);
      CREATE TABLE IF NOT EXISTS provider_stats (
        provider TEXT PRIMARY KEY,
        requests INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        last_error TEXT,
        last_error_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS model_stats (
        model TEXT PRIMARY KEY,
        provider TEXT,
        requests INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_stats (
        agent TEXT PRIMARY KEY,
        calls INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        last_model TEXT,
        last_provider TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_stats (
        tool TEXT PRIMARY KEY,
        calls INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0,
        last_used INTEGER,
        enabled INTEGER DEFAULT 1
      );
    `);
    // P1-02 migration: existing DBs get the routing trace column too.
    {
      const rcols = MODELS_DB.prepare("PRAGMA table_info(request_log)").all().map((c) => c.name);
      if (!rcols.includes("upstream_provider")) {
        MODELS_DB.prepare("ALTER TABLE request_log ADD COLUMN upstream_provider TEXT").run();
      }
      // Token accounting: without these columns the admin panel and the
      // audit cannot tell a 3.5k-token "hi" from a real request. Existing
      // rows keep 0; every new row records what the caller measured.
      const tokenColumns = [
        ["prompt_tokens", "prompt_tokens INTEGER DEFAULT 0"],
        ["completion_tokens", "completion_tokens INTEGER DEFAULT 0"],
        ["total_tokens", "total_tokens INTEGER DEFAULT 0"],
      ];
      for (const [name, ddl] of tokenColumns) {
        if (!rcols.includes(name)) {
          MODELS_DB.prepare("ALTER TABLE request_log ADD COLUMN " + ddl).run();
        }
      }
    }
    log("INFO", "SQLITE_READY", { path: MODELS_DB_PATH });
    log("INFO", "DB_OK", {
      path: MODELS_DB_PATH,
      quick_check: "ok",
      busy_timeout_ms: busyTimeout,
    });
    return true;
  } catch (e) {
    if (MODELS_DB) {
      try { MODELS_DB.close(); } catch (_) {}
      MODELS_DB = null;
    }
    const kind = classifyDbError(e);
    const retryMs = Math.max(
      0,
      parseInt(process.env.DB_BUSY_RETRY_MS || "500", 10) || 0,
    );
    if (kind === "busy" && attempt <= 3) {
      log("WARN", "DB_BUSY_RETRY", {
        attempt,
        path: MODELS_DB_PATH,
        wait_ms: retryMs,
        error: e.message,
      });
      sleepSyncMs(retryMs);
      return initModelsDb(attempt + 1);
    }
    dbFatal(
      kind === "corrupt" ? "corrupt" : kind === "busy" ? "busy" : "open",
      { error: e.message },
    );
  }
}

// Upsert ALL PROVIDER_CONFIG models into the DB. Returns count.
function syncModelsToDb() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const now = Date.now();
  try {
    const upsert = MODELS_DB.prepare(`
      INSERT INTO models (provider, name, api_model, provider_name, type, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, name) DO UPDATE SET
        api_model = excluded.api_model,
        provider_name = excluded.provider_name,
        type = excluded.type,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `);
    let count = 0;
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      if (p.enabled === false) continue;
      if (p.models.length === 0) continue;
      for (const m of p.models) {
        upsert.run(
          id,
          getModelName(m),
          getApiModelName(m),
          providerDisplayName(id, p),
          modelKind(p, m),
          Number.isFinite(Number(p.priority)) ? Number(p.priority) : 99,
          now,
        );
        count++;
      }
    }
    // Provider registry mirror: every configured provider gets a row so a
    // restart, the admin panel or an offline audit sees the same registry the
    // process has in memory. Env rows are a mirror (source='env'); DB-managed
    // rows (source='db') keep their own key/base URL and are never overwritten
    // by env. Stale env mirror rows are removed when a provider leaves .env.
    try {
      const getProvider = MODELS_DB.prepare("SELECT source FROM providers WHERE id = ?");
      const insertProvider = MODELS_DB.prepare(`
        INSERT INTO providers
          (id, name, type, base_url, api_key, models, socket_path, priority,
           enabled, requires_key, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'env', ?, ?)
      `);
      const updateEnvProvider = MODELS_DB.prepare(`
        UPDATE providers SET
          name = ?, type = ?, base_url = ?, models = ?, socket_path = ?,
          priority = ?, enabled = ?, requires_key = ?, updated_at = ?
        WHERE id = ? AND source = 'env'
      `);
      const updateDbProvider = MODELS_DB.prepare(
        "UPDATE providers SET models = ?, updated_at = ? WHERE id = ?",
      );
      for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
        const modelList = serializeModelList(p.models);
        const priority = Number.isFinite(Number(p.priority)) ? Number(p.priority) : 99;
        const enabled = p.enabled === false ? 0 : 1;
        const requiresKey = providerRequiresKey(p) ? 1 : 0;
        const row = getProvider.get(id);
        if (!row) {
          insertProvider.run(
            id,
            p.name || id,
            p.type || "openai",
            p.baseUrl || "",
            modelList,
            p.socketPath || "",
            priority,
            enabled,
            requiresKey,
            now,
            now,
          );
        } else if (row.source === "db") {
          updateDbProvider.run(modelList, now, id);
        } else {
          updateEnvProvider.run(
            p.name || id,
            p.type || "openai",
            p.baseUrl || "",
            modelList,
            p.socketPath || "",
            priority,
            enabled,
            requiresKey,
            now,
            id,
          );
        }
      }
      const stale = MODELS_DB.prepare(
        "SELECT id FROM providers WHERE source = 'env'",
      ).all();
      const drop = MODELS_DB.prepare(
        "DELETE FROM providers WHERE id = ? AND source = 'env'",
      );
      for (const row of stale) {
        if (!PROVIDER_CONFIG[row.id]) drop.run(row.id);
      }
    } catch (e) {
      log("WARN", "PROVIDER_DB_SYNC_FAIL", { error: e.message });
    }
    // Remove stale rows (models no longer present after this sync)
    // pinned=1 rows are remote-registry seeds — they survive across syncs
    MODELS_DB.prepare("DELETE FROM models WHERE updated_at < ? AND COALESCE(pinned,0) = 0").run(now);
    log("INFO", "MODELS_DB_SYNCED", { count, path: MODELS_DB_PATH });
    return { ok: true, synced: count };
  } catch (e) {
    log("WARN", "MODELS_DB_SYNC_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// Runtime env-var check → update models → sync into DB.
// Env vars are the SINGLE SOURCE OF TRUTH: this re-reads the model list
// env vars (OPENCODE_MODELS, GROQ_MODELS, GEMINI_MODELS,
// CUSTOM_PROVIDER_N_MODELS) and re-syncs the current env state into the
// SQLite models table. Callable at startup or on demand (e.g. after the
// user edits .env) without a server restart.
function refreshBuiltinProviderEnv() {
  const pairs = [
    ["opencode", "OPENCODE_BASE", "OPENCODE_API_KEY", "OPENCODE_PRIORITY"],
    ["groq", "GROQ_BASE", "GROQ_API_KEY", "GROQ_PRIORITY"],
    ["gemini", "GEMINI_BASE", "GEMINI_API_KEY", "GEMINI_PRIORITY"],
    ["ollama", "OLLAMA_BASE", "OLLAMA_API_KEY", "OLLAMA_PRIORITY"],
    ["ollama_cloud", "OLLAMA_CLOUD_BASE", "OLLAMA_CLOUD_API_KEY", "OLLAMA_CLOUD_PRIORITY"],
  ];
  for (const [id, baseKey, keyKey, priorityKey] of pairs) {
    const p = PROVIDER_CONFIG[id];
    if (!p || p.enabled === false) continue;
    if (process.env[baseKey]) p.baseUrl = process.env[baseKey];
    const envKey = process.env[keyKey] || "";
    p.envKey = envKey;
    if (p.keySource !== "db") {
      p.key = envKey;
      p.keySource = envKey ? "env" : "none";
    }
    const priority = parseInt(process.env[priorityKey] || "", 10);
    if (Number.isFinite(priority)) p.priority = priority;
  }
}

function syncEnvModelsToDb() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const before = {
    opencode: PROVIDER_CONFIG.opencode.models.length,
    groq: PROVIDER_CONFIG.groq.models.length,
    gemini: PROVIDER_CONFIG.gemini.models.length,
  };
  // Re-read env vars (single source of truth) and update PROVIDER_CONFIG.
  refreshBuiltinProviderEnv();
  const applyEnvModels = (id, raw, parser) => {
    const p = PROVIDER_CONFIG[id];
    if (!p) return;
    const list = parser(raw || "");
    const cached = Array.isArray(p.models) ? p.models : [];
    // Env wins and stays first, but a DB-discovered cache is not thrown away
    // just because this boot cannot reach the provider yet.
    p.models =
      p.custom === true ? list : providerModels.mergeDynamicModels(cached, list);
    p.envModels = list.length ? list.slice() : null;
  };
  if (PROVIDER_CONFIG.opencode.enabled !== false) {
    applyEnvModels("opencode", process.env.OPENCODE_MODELS, parseModelsEnv);
  }
  applyEnvModels("groq", process.env.GROQ_MODELS, parseModelsEnv);
  applyEnvModels("gemini", process.env.GEMINI_MODELS, parseModelsEnv);
  applyEnvModels("ollama", process.env.OLLAMA_MODELS, parseCustomModelsEnv);
  applyEnvModels(
    "ollama_cloud",
    process.env.OLLAMA_CLOUD_MODELS,
    parseCustomModelsEnv,
  );
  applyEnvModels("bridge", process.env.BRIDGE_MODELS, parseCustomModelsEnv);
  // Re-scan CUSTOM_PROVIDER_N_* env vars (adds new / updates existing).
  loadCustomProviders();
  // DB rows are applied AFTER the env scan: a provider edited in admin keeps
  // its DB key/base URL across restarts, while an untouched provider still
  // falls back to env.
  loadProvidersFromDb();
  normalizeProviderPriorities("envSync");
  const db = syncModelsToDb();
  refreshFreeModels();
  log("INFO", "ENV_MODELS_SYNCED", {
    before,
    after: {
      opencode: PROVIDER_CONFIG.opencode.models.length,
      groq: PROVIDER_CONFIG.groq.models.length,
      gemini: PROVIDER_CONFIG.gemini.models.length,
    },
    db,
  });
  return { ok: true, providers: Object.keys(PROVIDER_CONFIG), db };
}

// Load models from DB into PROVIDER_CONFIG (DB wins over env).
// Called at startup so a previously-synced DB is the source of truth.
function loadModelsFromDb() {
  if (!MODELS_DB) return false;
  try {
    // id ASC = insertion order → preserves env-defined order first,
    // then live-fetched models appended (so FREE_MODELS[0] stays stable).
    const rows = MODELS_DB.prepare(
      "SELECT provider, name, api_model FROM models ORDER BY id ASC",
    ).all();
    if (!rows.length) return false;
    const byProvider = {};
    for (const r of rows) {
      if (!byProvider[r.provider]) byProvider[r.provider] = [];
      byProvider[r.provider].push(
        r.name === r.api_model
          ? r.name
          : { name: r.name, apiModel: r.api_model },
      );
    }
    for (const [pid, models] of Object.entries(byProvider)) {
      const p = PROVIDER_CONFIG[pid];
      if (!p) continue;
      // An explicit env list stays first. A custom provider's env list is a
      // strict allowlist; a built-in provider may append DB-discovered rows
      // that are not named in env.
      if (Array.isArray(p.envModels) && p.envModels.length > 0) {
        p.models =
          p.custom === true
            ? p.envModels.slice()
            : providerModels.mergeDbModels(p.envModels, models);
      } else {
        p.models = models;
      }
    }
    log("INFO", "MODELS_DB_LOADED", {
      rows: rows.length,
      providers: Object.keys(byProvider).length,
    });
    refreshFreeModels();
    return true;
  } catch (e) {
    log("WARN", "MODELS_DB_LOAD_FAIL", { error: e.message });
    return false;
  }
}

// ─── DB-managed providers, key resolution, display names ────────────
// Display name for a model's provider. A UDS connection identifies itself by
// its socket; the llama engine socket is always shown as "llama UDS" and any
// other socket keeps its own basename so two UDS providers cannot be confused.
function providerDisplayName(id, p) {
  const socketPath = String((p && p.socketPath) || "");
  if (socketPath) {
    const base = path.basename(socketPath).replace(/\.sock$/i, "");
    if (/llama/i.test(base) || /llama/i.test(socketPath)) return "llama UDS";
    return (base || id) + " UDS";
  }
  return (p && p.name) || id;
}

function isLoopbackUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    // Unix sockets are local by construction; every network host goes through
    // the one shared loopback definition (lib/net.js).
    return u.protocol === "unix:" || isLoopbackHost(u.hostname);
  } catch (_) {
    return false;
  }
}

// A provider needs a key unless it is explicitly keyless / UDS / a llama.cpp
// server. Unknown types on a public URL are treated as key-requiring so a
// missing credential produces an honest 404 instead of an upstream 401.
// Hostname is only a fallback for existing installs; a provider can always
// state requiresKey in config or in the DB.
function providerRequiresKey(p) {
  if (!p) return false;
  if (p.requiresKey === true) return true;
  if (p.requiresKey === false) return false;
  if (p.socketPath) return false;
  if (p.type === "llamacpp") return false;
  if (isLoopbackUrl(p.baseUrl)) return false;
  return true;
}

// Key lookup order is DB first, env second, nothing third. The caller must
// turn "nothing" into a direct 404 — never a fabricated provider response.
function providerKey(id, p) {
  if (MODELS_DB) {
    try {
      const row = MODELS_DB.prepare(
        "SELECT api_key FROM providers WHERE id = ?",
      ).get(id);
      if (row && row.api_key) {
        const key = providerSecretStore.decryptSecret(row.api_key);
        if (key) return { key, source: "db" };
      }
    } catch (_) {
      /* table missing on an old DB — env fallback below still works */
    }
  }
  if (p && p.envKey) return { key: p.envKey, source: "env" };
  if (p && p.key) {
    return { key: p.key, source: p.keySource === "db" ? "db" : "env" };
  }
  return { key: "", source: "none" };
}

function providerKeyState(id, p) {
  const resolved = providerKey(id, p);
  if (resolved.key) return { ok: true, ...resolved };
  if (!providerRequiresKey(p)) return { ok: true, key: "", source: "none" };
  return { ok: false, key: "", source: resolved.source };
}

// Merge DB provider rows over the env-built registry. Called on every startup
// and after every env re-sync so a power cut cannot lose a DB provider.
function loadProvidersFromDb() {
  if (!MODELS_DB) return false;
  let rows = [];
  try {
    rows = MODELS_DB.prepare(
      "SELECT * FROM providers ORDER BY priority ASC, id ASC",
    ).all();
  } catch (e) {
    log("WARN", "PROVIDERS_DB_LOAD_FAIL", { error: e.message });
    return false;
  }
  for (const row of rows) {
    // Mirror rows written by syncModelsToDb describe env providers; env stays
    // the source of truth, so applying a mirror as DB config would mark every
    // built-in "custom" and freeze its dynamically discovered model list.
    if (row.source === "env") continue;
    const existing = PROVIDER_CONFIG[row.id] || {};
    const envKey = existing.envKey || "";
    const dbKey = row.api_key
      ? providerSecretStore.decryptSecret(row.api_key)
      : "";
    if (row.api_key && !dbKey) {
      log("WARN", "PROVIDER_KEY_DECRYPT_FAIL", { provider: row.id });
    }
    const parsedModels = row.models ? parseCustomModelsEnv(row.models) : [];
    const key = dbKey || envKey;
    // DB providers have no budget columns. The env prefix keeps the knob
    // per-provider without adding schema or hardcoding a provider id.
    const envPrefix = "PROVIDER_" + String(row.id).toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const maxPromptChars = parseInt(process.env[envPrefix + "_MAX_PROMPT_CHARS"] || "", 10);
    const maxTokens = parseInt(process.env[envPrefix + "_MAX_TOKENS"] || "", 10);
    const maxTools = parseInt(process.env[envPrefix + "_MAX_TOOLS"] || "", 10);
    const contextWindow = parseInt(process.env[envPrefix + "_CONTEXT_WINDOW"] || "", 10);
    const extraBody = jsonObjectEnv(envPrefix + "_EXTRA_BODY");
    let rowType = String(row.type || existing.type || "openai").toLowerCase();
    if (customProviders.isCustomId(row.id) && rowType !== "openai") {
      log("WARN", "CUSTOM_PROVIDER_TYPE_IGNORED", {
        provider: row.id,
        configured: rowType,
        using: "openai",
        source: "db",
      });
      rowType = "openai";
    }
    PROVIDER_CONFIG[row.id] = Object.assign({}, existing, {
      name: row.name || existing.name || row.id,
      baseUrl: row.base_url || existing.baseUrl || "",
      type: rowType,
      key,
      envKey,
      keySource: dbKey ? "db" : envKey ? "env" : "none",
      priority: Number.isFinite(Number(row.priority))
        ? Number(row.priority)
        : Number.isFinite(Number(existing.priority))
          ? Number(existing.priority)
          : 99,
      models: parsedModels.length ? parsedModels : existing.models || [],
      socketPath: row.socket_path || "",
      enabled: row.enabled !== 0,
      requiresKey:
        row.requires_key === null || row.requires_key === undefined
          ? undefined
          : row.requires_key === 1,
      custom: true,
      source: "db",
      ...(Number.isFinite(maxPromptChars) && maxPromptChars > 0 ? { maxPromptChars } : {}),
      ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      ...(Number.isFinite(maxTools) && maxTools >= 0 ? { maxTools } : {}),
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(extraBody ? { extraBody } : {}),
    });
  }
  if (rows.length) {
    log("INFO", "PROVIDERS_DB_LOADED", { count: rows.length });
  }
  return true;
}

// Priority is a routing order, so it must be unique and gap-free: 1..N.
// Input duplicates or gaps are repaired here instead of being displayed.
function normalizeProviderPriorities(reason) {
  const entries = Object.entries(PROVIDER_CONFIG).sort(
    ([aId, a], [bId, b]) =>
      providerPriority(a) - providerPriority(b) || aId.localeCompare(bId),
  );
  const changed = [];
  entries.forEach(([id, p], index) => {
    const next = index + 1;
    if (Number(p.priority) !== next) {
      changed.push({ id, from: p.priority, to: next });
    }
    p.priority = next;
  });
  if (MODELS_DB) {
    try {
      const updModel = MODELS_DB.prepare(
        "UPDATE models SET priority = ? WHERE provider = ?",
      );
      const updProvider = MODELS_DB.prepare(
        "UPDATE providers SET priority = ?, updated_at = ? WHERE id = ?",
      );
      const now = Date.now();
      for (const [id, p] of entries) {
        updModel.run(p.priority, id);
        updProvider.run(p.priority, now, id);
      }
    } catch (e) {
      log("WARN", "PROVIDER_PRIORITY_SAVE_FAIL", { error: e.message });
    }
  }
  if (changed.length) {
    log("INFO", "PROVIDER_PRIORITIES_NORMALIZED", {
      count: entries.length,
      changed: changed.length,
      reason: reason || "sync",
    });
  }
  return entries.map(([id, p]) => ({ id, priority: p.priority }));
}

function serializeModelList(models) {
  return (models || [])
    .map((m) => {
      if (typeof m === "string") return m;
      const name = getModelName(m);
      const apiModel = getApiModelName(m);
      return name === apiModel ? name : name + "=>" + apiModel;
    })
    .join(",");
}

// Chat vs "other" is a model capability, not a wire dialect. The old code
// stored the provider type ("openai"/"gemini") in models.type, which is why
// the page reported 0 chat models.
function modelKind(p, m) {
  const declared =
    typeof m === "object" && m ? String(m.type || "").toLowerCase() : "";
  if (declared === "chat" || declared === "other") return declared;
  const api = String(getApiModelName(m) || "").toLowerCase();
  if (/(embed|rerank|moderation|whisper|tts|vision-encoder)/.test(api)) {
    return "other";
  }
  return "chat";
}

// Per-model admin state: the config list is the source of order, the DB row
// carries the persisted enabled flag. DISABLED_MODELS is the runtime truth the
// router actually uses, so a stale DB row can never claim a model is on.
function providerModelStates(id, p) {
  const rows = new Map();
  if (MODELS_DB) {
    try {
      for (const row of MODELS_DB.prepare(
        "SELECT name, enabled, supports_tools FROM models WHERE provider = ?",
      ).all(id)) {
        rows.set(row.name, row);
      }
    } catch (e) {
      log("WARN", "PROVIDER_MODEL_STATE_FAIL", { provider: id, error: e.message });
    }
  }
  return (p.models || []).map((m) => {
    const name = getModelName(m);
    const row = rows.get(name);
    return {
      name,
      apiModel: getApiModelName(m),
      enabled: !DISABLED_MODELS.has(id + "::" + name),
      supportsTools:
        row && row.supports_tools !== null && row.supports_tools !== undefined
          ? row.supports_tools === 1
          : null,
    };
  });
}

function providerSummary(id, p) {
  const st = getProviderStat(id);
  const reqs = st ? st.requests : 0;
  const errs = st ? st.errors : 0;
  // Status comes from the same snapshot /health.providers uses, so the admin
  // list and the public health block can never disagree. Unknown is never
  // promoted to "up" just because no request has failed yet.
  const snap = providerHealthSnapshot(id);
  const keyState = providerKeyState(id, p);
  return {
    id,
    name: p.name || id,
    displayName: providerDisplayName(id, p),
    type: p.type || "openai",
    baseUrl: p.baseUrl || "",
    socketPath: p.socketPath || "",
    priority: Number.isFinite(Number(p.priority)) ? Number(p.priority) : 99,
    enabled: p.enabled !== false,
    envDisabled: p.envDisabled === true,
    models: (p.models || []).length,
    modelList: (p.models || []).map((m) => {
      if (typeof m === "string") return m;
      const name = getModelName(m);
      const apiModel = getApiModelName(m);
      return name === apiModel ? name : name + "=>" + apiModel;
    }),
    modelStates: providerModelStates(id, p),
    status: snap.status,
    lastProbeAt: snap.lastProbeAt,
    lastSuccessAt: snap.lastSuccessAt,
    lastFailureAt: snap.lastFailureAt,
    source: p.source || "env",
    hasKey: !!keyState.key,
    keySource: keyState.source,
    requiresKey: providerRequiresKey(p),
    capabilities: providerCapabilities.forConfig(p, id),
    requests: reqs,
    errors: errs,
    success_pct: reqs ? Math.round(((reqs - errs) / reqs) * 100) : null,
    last_used:
      st && st.last_used ? new Date(st.last_used).toISOString() : null,
    last_error: st && st.last_error ? st.last_error : null,
    healthy: snap.healthy,
  };
}

// Validate a provider credential with a real runtime request before it is
// persisted. A network failure is a validation failure: saving an unproven
// key would poison every later request.
async function validateProviderCredentials(input) {
  const type = String(input.type || "openai").toLowerCase();
  let base = String(input.baseUrl || "http://localhost").replace(/\/+$/, "");
  let target;
  if (type === "gemini") {
    target = base + "/models";
  } else if (type === "ollama") {
    target = base.replace(/\/v1$/, "") + "/api/tags";
  } else if (type === "llamacpp") {
    target = base.replace(/\/v1$/, "") + "/v1/models";
  } else {
    target = base + "/models";
  }
  const headers = { "User-Agent": USER_AGENT };
  if (input.apiKey) {
    if (type === "gemini") headers["X-goog-api-key"] = input.apiKey;
    else headers.Authorization = "Bearer " + input.apiKey;
  }
  try {
    const res = await providerTransport.request(
      {
        baseUrl: base,
        headers,
        method: "GET",
        timeout: 15000,
        socketPath: input.socketPath || "",
      },
      target,
    );
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return {
        ok: true,
        statusCode: res.statusCode,
        models: parseProviderModelIds({ type }, res.body) || [],
      };
    }
    return {
      ok: false,
      statusCode: res.statusCode,
      error: providerTransport.errorMessage(res.statusCode, res.body),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const PROVIDER_TYPES = new Set([
  "openai",
  "gemini",
  "groq",
  "ollama",
  "llamacpp",
  "opencode",
]);

// The panel never asks the operator to invent an id: a new provider gets the
// next custom_N. The number is derived from the live config plus the DB rows,
// so a deleted-then-recreated provider cannot collide with an env seed.
function nextCustomProviderId() {
  let max = 0;
  const scan = (candidate) => {
    const m = /^custom_(\d+)$/i.exec(String(candidate || ""));
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const id of Object.keys(PROVIDER_CONFIG)) scan(id);
  if (MODELS_DB) {
    try {
      for (const row of MODELS_DB.prepare("SELECT id FROM providers").all()) {
        scan(row.id);
      }
    } catch (e) {
      log("WARN", "PROVIDER_AUTO_ID_SCAN_FAIL", { error: e.message });
    }
  }
  return "custom_" + (max + 1);
}

async function saveProviderFromAdmin(rawBody) {
  const b = rawBody || {};
  const requestedId = String(b.id || "").trim();
  const id = requestedId || nextCustomProviderId();
  if (!/^[a-z0-9][a-z0-9_-]{1,48}$/i.test(id)) {
    return {
      status: 400,
      payload: {
        ok: false,
        error:
          "Provider id must be 2-49 characters: letters, numbers, _ or -",
      },
    };
  }
  if (!MODELS_DB) {
    return { status: 503, payload: { ok: false, error: "sqlite unavailable" } };
  }
  const existing = PROVIDER_CONFIG[id] || null;
  const name = String(b.name !== undefined ? b.name : (existing && existing.name) || id).trim() || id;
  const type = String(b.type !== undefined ? b.type : (existing && existing.type) || "openai").toLowerCase();
  if (!PROVIDER_TYPES.has(type)) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: "Unsupported provider type: " + type,
      },
    };
  }
  // custom_N is the OpenAI-compatible surface, full stop. A native dialect
  // must use a non-custom id, so the env seed and the DB row can never
  // disagree about what a custom provider speaks.
  if (customProviders.isCustomId(id) && type !== "openai") {
    return {
      status: 400,
      payload: {
        ok: false,
        error:
          "custom_N providers are OpenAI-compatible only (type must be openai). " +
          "Use a non-custom id for a native adapter.",
        code: "CUSTOM_PROVIDER_TYPE_REJECTED",
      },
    };
  }
  const baseUrl = String(
    b.baseUrl !== undefined ? b.baseUrl : (existing && existing.baseUrl) || "",
  ).trim();
  const socketPath = String(
    b.socketPath !== undefined
      ? b.socketPath
      : (existing && existing.socketPath) || "",
  ).trim();
  if (!baseUrl && !socketPath) {
    return {
      status: 400,
      payload: { ok: false, error: "baseUrl or socketPath is required" },
    };
  }
  if (socketPath && !baseUrl) {
    // transport.request() needs a URL to parse; the socket carries the host.
    // The stored baseUrl is therefore the inoffensive local placeholder.
    // (assigned below so the normalized value is persisted)
  }
  const normalizedBase = baseUrl || "http://localhost";

  const apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
  if (apiKey) {
    const check = await validateProviderCredentials({
      type,
      baseUrl: normalizedBase,
      apiKey,
      socketPath,
    });
    if (!check.ok) {
      return {
        status: 400,
        payload: {
          ok: false,
          keyValid: false,
          statusCode: check.statusCode || null,
          error:
            "API key validation failed: " +
            (check.error || "HTTP " + check.statusCode),
        },
      };
    }
  }

  let encryptedKey = "";
  if (apiKey) {
    try {
      encryptedKey = providerSecretStore.encryptSecret(apiKey);
    } catch (e) {
      return {
        status: 500,
        payload: {
          ok: false,
          error: "Cannot store API key securely: " + e.message,
        },
      };
    }
  }

  const priorRow = MODELS_DB.prepare(
    "SELECT api_key FROM providers WHERE id = ?",
  ).get(id);
  let storedKey = priorRow && priorRow.api_key ? priorRow.api_key : "";
  if (encryptedKey) storedKey = encryptedKey;
  else if (b.clearKey) storedKey = "";

  const decryptedStored = storedKey
    ? providerSecretStore.decryptSecret(storedKey)
    : "";
  const envKey = existing && existing.envKey ? existing.envKey : "";
  const effectiveKey = decryptedStored || envKey;
  const keySource = decryptedStored ? "db" : envKey ? "env" : "none";

  let models = existing ? existing.models || [] : [];
  if (Array.isArray(b.models)) models = b.models;
  else if (typeof b.models === "string") {
    models = b.models.trim() ? parseCustomModelsEnv(b.models) : models;
  }

  // Priority is a single unique slot, so an explicit value is a placement,
  // not a hint. The provider already holding that slot moves to the slot the
  // incoming provider is vacating (a swap); a brand-new provider pushes the
  // holder to the end. Omitting priority assigns the next free slot through
  // normalizeProviderPriorities below.
  const requestedPriority = Number.isFinite(Number(b.priority))
    ? Number(b.priority)
    : null;
  const previousPriority =
    existing && Number.isFinite(Number(existing.priority))
      ? Number(existing.priority)
      : null;
  let priority =
    requestedPriority !== null
      ? requestedPriority
      : previousPriority !== null
        ? previousPriority
        : 999;
  let prioritySwap = null;
  if (requestedPriority !== null) {
    const holder = Object.entries(PROVIDER_CONFIG).find(
      ([otherId, other]) =>
        otherId !== id && providerPriority(other) === requestedPriority,
    );
    if (holder) {
      const [holderId, holderCfg] = holder;
      let movedTo;
      if (previousPriority !== null && previousPriority !== requestedPriority) {
        movedTo = previousPriority;
      } else {
        let maxPriority = 0;
        for (const [otherId, other] of Object.entries(PROVIDER_CONFIG)) {
          if (otherId === id) continue;
          maxPriority = Math.max(maxPriority, providerPriority(other));
        }
        movedTo = maxPriority + 1;
      }
      holderCfg.priority = movedTo;
      prioritySwap = { id: holderId, from: requestedPriority, to: movedTo };
      if (MODELS_DB) {
        try {
          MODELS_DB.prepare(
            "UPDATE providers SET priority = ?, updated_at = ? WHERE id = ?",
          ).run(movedTo, Date.now(), holderId);
        } catch (e) {
          log("WARN", "PROVIDER_PRIORITY_SWAP_FAIL", {
            provider: holderId,
            error: e.message,
          });
        }
      }
      log("INFO", "PROVIDER_PRIORITY_SWAP", {
        incoming: id,
        requested: requestedPriority,
        moved: holderId,
        movedTo,
      });
    }
  }
  // An env-disabled provider stays off even when an admin save payload asks
  // for enabled:true. Only the env flag can reopen it.
  const envLocked = !!(existing && existing.envDisabled === true);
  const enabled = envLocked
    ? false
    : b.enabled === undefined
      ? existing
        ? existing.enabled !== false
        : true
      : !!b.enabled;
  // Explicit override wins (a loopback gateway can still demand a key).
  // null = "decide from type/URL", which is the default for env providers.
  const requiresKey =
    b.requiresKey === undefined
      ? existing && existing.requiresKey !== undefined
        ? existing.requiresKey
          ? 1
          : 0
        : null
      : b.requiresKey
        ? 1
        : 0;
  const now = Date.now();

  MODELS_DB.prepare(`
    INSERT INTO providers
      (id, name, type, base_url, api_key, models, socket_path, priority,
       enabled, requires_key, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      base_url = excluded.base_url,
      api_key = excluded.api_key,
      models = excluded.models,
      socket_path = excluded.socket_path,
      priority = excluded.priority,
      enabled = excluded.enabled,
      requires_key = excluded.requires_key,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(
    id,
    name,
    type,
    normalizedBase,
    storedKey,
    serializeModelList(models),
    socketPath,
    priority,
    enabled ? 1 : 0,
    requiresKey,
    "db",
    now,
    now,
  );

  PROVIDER_CONFIG[id] = Object.assign({}, existing || {}, {
    name,
    type,
    baseUrl: normalizedBase,
    socketPath,
    key: effectiveKey,
    envKey,
    keySource,
    priority,
    models,
    enabled,
    requiresKey: requiresKey === null ? undefined : requiresKey === 1,
    custom: true,
    source: "db",
  });

  normalizeProviderPriorities("providerSave");
  persistProviderDisabled();
  syncModelsToDb();
  refreshFreeModels();
  log("INFO", "ADMIN_PROVIDER_SAVE", {
    id,
    type,
    socketPath: socketPath || null,
    keySource,
    enabled,
  });
  return {
    status: 200,
    payload: {
      ok: true,
      keyValid: apiKey ? true : undefined,
      prioritySwap,
      provider: providerSummary(id, PROVIDER_CONFIG[id]),
    },
  };
}

// POST /api/admin/providers {action:"test"} — discover /v1/models with the
// entered URL/key before anything is written. A draft (no saved row) is a
// pure probe; an existing DB row can persist the discovered list in one call.
async function testProviderFromAdmin(rawBody) {
  const b = rawBody || {};
  const id = String(b.id || "").trim();
  const existing = id ? PROVIDER_CONFIG[id] || null : null;
  const type = String(
    b.type || (existing && existing.type) || "openai",
  ).toLowerCase();
  if (!PROVIDER_TYPES.has(type)) {
    return {
      status: 400,
      payload: { ok: false, error: "Unsupported provider type: " + type },
    };
  }
  const baseUrl = String(
    b.baseUrl !== undefined && b.baseUrl !== null && b.baseUrl !== ""
      ? b.baseUrl
      : (existing && existing.baseUrl) || "",
  ).trim();
  const socketPath = String(
    b.socketPath !== undefined && b.socketPath !== null && b.socketPath !== ""
      ? b.socketPath
      : (existing && existing.socketPath) || "",
  ).trim();
  if (!baseUrl && !socketPath) {
    return {
      status: 400,
      payload: { ok: false, error: "baseUrl or socketPath is required" },
    };
  }
  let apiKey = typeof b.apiKey === "string" ? b.apiKey.trim() : "";
  if (!apiKey && existing) apiKey = providerKey(id, existing).key;
  const probe = {
    type,
    baseUrl: baseUrl || "http://localhost",
    key: apiKey,
    socketPath,
    enabled: true,
    models: [],
    custom: true,
  };
  const fetched = await fetchProviderModels(id || "admin_test", probe);
  if (!fetched.ok) {
    return {
      status: 502,
      payload: {
        ok: false,
        error: fetched.error || "model discovery failed",
        raw: fetched.raw || undefined,
      },
    };
  }
  const models = (fetched.models || []).filter(Boolean);
  let persisted = false;
  if (b.persist === true && existing && existing.source === "db" && MODELS_DB) {
    const now = Date.now();
    existing.models = models;
    try {
      MODELS_DB.prepare(
        "UPDATE providers SET models = ?, updated_at = ? WHERE id = ?",
      ).run(serializeModelList(models), now, id);
      persisted = true;
    } catch (e) {
      log("WARN", "ADMIN_PROVIDER_TEST_PERSIST_FAIL", {
        provider: id,
        error: e.message,
      });
    }
    syncModelsToDb();
    refreshFreeModels();
  }
  log("INFO", "ADMIN_PROVIDER_TEST", {
    provider: id || null,
    baseUrl: probe.baseUrl,
    found: models.length,
    persisted,
  });
  return {
    status: 200,
    payload: {
      ok: true,
      id: id || null,
      count: models.length,
      models,
      persisted,
    },
  };
}

// POST /api/admin/providers {action:"sync"} — re-read the live /v1/models list
// at runtime and persist it. Without an id this covers every DB-managed
// provider, which is the "a model appeared upstream and we never knew" case.
async function syncProvidersFromAdmin(rawBody) {
  const b = rawBody || {};
  const only = String(b.id || "").trim();
  if (!MODELS_DB) {
    return { status: 503, payload: { ok: false, error: "sqlite unavailable" } };
  }
  if (only && !PROVIDER_CONFIG[only]) {
    return {
      status: 404,
      payload: { ok: false, error: "Unknown provider: " + only },
    };
  }
  const ids = only
    ? [only]
    : Object.entries(PROVIDER_CONFIG)
        .filter(([, p]) => p.source === "db")
        .map(([id]) => id);
  const results = {};
  let changed = 0;
  for (const id of ids) {
    const p = PROVIDER_CONFIG[id];
    if (!p) {
      results[id] = { ok: false, error: "not configured" };
      continue;
    }
    if (p.enabled === false) {
      results[id] = { ok: false, skipped: true, reason: "admin-disabled" };
      continue;
    }
    const fetched = await fetchProviderModels(id, p);
    if (!fetched.ok) {
      results[id] = { ok: false, error: fetched.error || "no models" };
      continue;
    }
    const live = (fetched.models || []).filter(Boolean);
    if (!live.length) {
      results[id] = { ok: false, error: "provider reported no models" };
      continue;
    }
    const before = p.models.map((m) => getApiModelName(m));
    const envModels = Array.isArray(p.envModels) ? p.envModels : [];
    p.models = providerModels.reconcileModels(p.models, live, {
      envModels,
      strict: false,
    });
    const after = p.models.map((m) => getApiModelName(m));
    const added = after.filter((name) => !before.includes(name));
    const removed = before.filter((name) => !after.includes(name));
    const now = Date.now();
    MODELS_DB.prepare(
      "UPDATE providers SET models = ?, updated_at = ? WHERE id = ? AND source = 'db'",
    ).run(serializeModelList(p.models), now, id);
    // Drop stale mirror rows so the models table and the live list agree.
    try {
      if (after.length) {
        const placeholders = after.map(() => "?").join(",");
        MODELS_DB.prepare(
          "DELETE FROM models WHERE provider = ? AND name NOT IN (" + placeholders + ")",
        ).run(id, ...after);
      } else {
        MODELS_DB.prepare("DELETE FROM models WHERE provider = ?").run(id);
      }
    } catch (e) {
      log("WARN", "ADMIN_PROVIDER_SYNC_PRUNE_FAIL", {
        provider: id,
        error: e.message,
      });
    }
    changed += added.length + removed.length;
    results[id] = {
      ok: true,
      fetched: live.length,
      added,
      removed,
      total: p.models.length,
    };
  }
  const db = syncModelsToDb();
  refreshFreeModels();
  log("INFO", "ADMIN_PROVIDER_SYNC", {
    providers: Object.keys(results).length,
    changed,
  });
  return {
    status: 200,
    payload: { ok: true, changed, results, db: db && db.ok !== false },
  };
}

function deleteProviderFromAdmin(rawId) {
  const id = String(rawId || "").trim();
  if (!MODELS_DB) {
    return { status: 503, payload: { ok: false, error: "sqlite unavailable" } };
  }
  const row = MODELS_DB.prepare(
    "SELECT id, source FROM providers WHERE id = ?",
  ).get(id);
  if (!row) {
    return {
      status: 404,
      payload: {
        ok: false,
        error:
          "Provider not managed in DB: " + id + " (env providers are edited in .env)",
      },
    };
  }
  if (row.source !== "db") {
    return {
      status: 400,
      payload: {
        ok: false,
        error:
          "Provider " + id + " is environment-defined; edit .env and restart instead",
      },
    };
  }
  if (["opencode", "groq", "gemini", "ollama"].includes(id)) {
    return {
      status: 400,
      payload: {
        ok: false,
        error: "Built-in provider " + id + " cannot be deleted; disable it instead",
      },
    };
  }
  MODELS_DB.prepare("DELETE FROM providers WHERE id = ?").run(id);
  MODELS_DB.prepare("DELETE FROM models WHERE provider = ?").run(id);
  delete PROVIDER_CONFIG[id];
  // A custom_N provider with env vars still exists in .env: rebuild it from
  // env instead of pretending the provider is gone.
  if (/^custom_\d+$/.test(id)) {
    loadCustomProviders();
    loadProvidersFromDb();
  }
  normalizeProviderPriorities("providerDelete");
  persistProviderDisabled();
  refreshFreeModels();
  log("INFO", "ADMIN_PROVIDER_DELETE", { id });
  return { status: 200, payload: { ok: true, id } };
}
// ─── API Normalizer: fetch live models from each provider ──
// GET {baseUrl}/models and merge the returned model IDs into
// PROVIDER_CONFIG + SQLite. Keyless providers are still tried
// (public endpoints); redirects (3xx) are followed up to 3 hops.
function parseProviderModelIds(p, text) {
  try {
    const parsed = JSON.parse(text);
    let ids = [];
    if (p.type === "gemini") {
      ids = (parsed.models || []).map((m) =>
        String(m.name || "").replace(/^models\//, ""),
      );
    } else if (Array.isArray(parsed.data)) {
      ids = parsed.data
        .map((m) => (typeof m === "string" ? m : m && m.id))
        .filter(Boolean);
    } else if (Array.isArray(parsed.models)) {
      ids = parsed.models
        .map((m) =>
          typeof m === "string" ? m : m && (m.id || m.name || m.model),
        )
        .filter(Boolean);
    }
    return [...new Set(ids)];
  } catch (_) {
    return null;
  }
}

function fetchProviderModels(providerId, p) {
  return new Promise((resolve) => {
    const keyState = providerKey(providerId, p);
    const apiKey = keyState.key;
    if (!p.baseUrl && !p.socketPath) {
      return resolve({ ok: false, error: "no baseUrl" });
    }

    // Native Ollama discovery lives at /api/tags, not /models. Delegate to
    // the adapter so local and cloud use one official endpoint instead of a
    // guessed OpenAI-shaped URL.
    if (
      !p.socketPath &&
      (providerId === "ollama" || providerId === "ollama_cloud") &&
      p.dialect !== "openai"
    ) {
      return resolve(
        providerRegistry.listModels({
          id: providerId,
          baseUrl: p.baseUrl,
          key: apiKey,
          type: p.type,
          dialect: p.dialect || "",
        }),
      );
    }

    const buildUrl = () => {
      const base = (p.baseUrl || "http://localhost").replace(/\/+$/, "");
      if (p.type === "gemini") return new URL(base + "/models");
      if (p.type === "llamacpp") {
        return new URL(base.replace(/\/v1$/, "") + "/v1/models");
      }
      return new URL(base + "/models");
    };
    const buildHeaders = () => {
      const h = { "User-Agent": USER_AGENT };
      if (p.type === "gemini") {
        h["X-goog-api-key"] = apiKey;
      } else if (apiKey) {
        h["Authorization"] = "Bearer " + apiKey;
      }
      return h;
    };

    // A UDS provider is dialled through provider/transport (global fetch
    // cannot open a unix socket).
    if (p.socketPath) {
      providerTransport
        .request(
          {
            socketPath: p.socketPath,
            headers: buildHeaders(),
            method: "GET",
            timeout: 20000,
          },
          buildUrl().toString(),
        )
        .then((res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({
              ok: false,
              error: "HTTP " + res.statusCode,
              raw: String(res.body || "").slice(0, 300),
            });
          }
          const ids = parseProviderModelIds(p, res.body);
          if (ids === null) {
            return resolve({
              ok: false,
              error: "invalid JSON",
              raw: String(res.body || "").slice(0, 300),
            });
          }
          resolve({ ok: true, models: ids, raw: res.body });
        })
        .catch((err) => resolve({ ok: false, error: err.message }));
      return;
    }

    // Follow up to 3 redirects — some gateways redirect /models
    const doFetch = (url, headers, redirectsLeft) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "http:" ? 80 : 443),
        path: url.pathname + url.search,
        method: "GET",
        timeout: 20000,
        headers,
      };
      const proto = url.protocol === "http:" ? http : https;
      const req = proto.request(options, (res) => {
        // Redirect handling (301/302/303/307/308)
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume(); // discard body
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, url);
          } catch (e) {
            return resolve({ ok: false, error: "bad redirect: " + e.message });
          }
          return doFetch(nextUrl, headers, redirectsLeft - 1);
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return resolve({
              ok: false,
              error: "HTTP " + res.statusCode,
              raw: data.slice(0, 300),
            });
          }
          const ids = parseProviderModelIds(p, data);
          if (ids === null) {
            resolve({
              ok: false,
              error: "invalid JSON",
              raw: data.slice(0, 300),
            });
            return;
          }
          resolve({ ok: true, models: ids, raw: data });
        });
      });
      req.on("error", (err) => resolve({ ok: false, error: err.message }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "timeout" });
      });
      req.end();
    };

    doFetch(buildUrl(), buildHeaders(), 3);
  });
}

// Run the full normalizer: fetch all providers → merge into config → sync DB.
// For masked providers (e.g. Groq aliases), env-defined pairs are preserved;
// live API models are appended as plain names (name == apiModel).
async function runNormalizerSync() {
  const results = {};
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    if (p.enabled === false) {
      results[id] = { ok: false, skipped: true, reason: "admin-disabled" };
      continue;
    }
    if (!p.baseUrl && !p.socketPath) {
      results[id] = { ok: false, error: "no baseUrl", skipped: true };
      continue;
    }
    const keyState = providerKey(id, p);
    p.key = keyState.key;
    if (providerRequiresKey(p) && !keyState.key) {
      results[id] = {
        ok: false,
        error: "API key missing",
        key_missing: true,
        skipped: true,
      };
      continue;
    }
    const fetched = await fetchProviderModels(id, p);
    const envModels = Array.isArray(p.envModels) ? p.envModels : [];
    if (fetched.ok && fetched.models.length === 0 && p.dynamicModels) {
      // A reachable dynamic server that reports no models (bridge with no
      // upstream) must not keep stale rows alive: the user asked for "if it
      // is not there, it is not there", not a phantom model. An explicit env
      // list is still a user promise and stays.
      p.models = envModels.length ? envModels.slice() : [];
      results[id] = {
        ok: true,
        fetched: 0,
        added: 0,
        total: p.models.length,
        unavailable: true,
      };
      continue;
    }
    if (fetched.ok && fetched.models.length > 0) {
      // Env-declared rows survive a partial live list. A custom provider's
      // env list is strict; a built-in provider may append new live models.
      const before = new Set(p.models.map((m) => getModelName(m)));
      p.models = providerModels.reconcileModels(p.models, fetched.models, {
        envModels,
        strict: p.custom === true,
      });
      const added = p.models.filter((m) => !before.has(getModelName(m))).length;
      results[id] = {
        ok: true,
        fetched: fetched.models.length,
        added,
        total: p.models.length,
        env_kept: envModels.length,
      };
    } else {
      results[id] = { ok: false, error: fetched.error || "no models" };
    }
  }
  normalizeProviderPriorities("normalizerSync");
  const db = syncModelsToDb();
  refreshFreeModels();
  return { results, db };
}

// Dynamic providers are the volatile ones: a model server can start or stop
// while the gateway is running. Poll only those (never a fixed catalog) and
// rewrite the list + DB only when the live set actually changed, so the model
// list follows reality without a restart and without API cost.
async function refreshDynamicProviders() {
  let changed = false;
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    if (!p.dynamicModels || p.enabled === false) continue;
    const fetched = await fetchProviderModels(id, p);
    if (!fetched.ok) continue;
    const live = fetched.models.filter(Boolean);
    const envModels = Array.isArray(p.envModels) ? p.envModels : [];
    // A dynamic server can return a partial list while it is still loading.
    // Keep the env rows first and append only genuinely new live models.
    const merged =
      p.custom === true && envModels.length > 0
        ? envModels.slice()
        : providerModels.mergeDynamicModels(live, envModels);
    const current = p.models.map((m) => getApiModelName(m));
    if (
      JSON.stringify(merged.map((m) => getApiModelName(m))) ===
      JSON.stringify(current)
    ) {
      continue;
    }
    p.models = merged;
    changed = true;
    log("INFO", "DYNAMIC_MODELS_REFRESHED", {
      provider: id,
      count: merged.length,
      models: merged.slice(0, 12),
    });
  }
  if (changed) {
    syncModelsToDb();
    refreshFreeModels();
  }
  return changed;
}

// Computed: flattened list of all public model names (masked)
// NOTE: `let` + refreshFreeModels() — the list is recomputed after
// loadModelsFromDb() and runNormalizerSync() so counts stay accurate
// (DB-enriched models are reflected everywhere, incl. /health).
let FREE_MODELS = Object.values(PROVIDER_CONFIG)
  .filter((p) => p.enabled !== false && p.models.length > 0)
  .flatMap((p) => p.models.map(getModelName));

// Recompute FREE_MODELS from the current PROVIDER_CONFIG state.
// Called after DB load and after every provider sync so that newly
// discovered models are included in health/status counts.
// The usable-model memo below depends on FREE_MODELS; a sync or a local
// server starting/stopping must be able to change the answer.
const _agentModelCache = new Map();

function refreshFreeModels() {
  FREE_MODELS = Object.values(PROVIDER_CONFIG)
    .filter((p) => p.enabled !== false && p.models.length > 0)
    .flatMap((p) => p.models.map(getModelName));
  _agentModelCache.clear();
}

// ─── Provider-independent model choice ───────────────────────
// A provider can be removed, a key can expire, a model server can be
// stopped. Model names are preferences, not dependencies. The candidates
// below are whatever the live catalog currently serves, ordered by provider
// priority (lower number wins) and then by provider id. Capability and health
// decide the winner; location does not.
function liveModelCandidates() {
  const out = [];
  const seen = new Set();
  const providers = Object.entries(PROVIDER_CONFIG)
    .filter(([, p]) => p.enabled !== false && p.models && p.models.length > 0)
    .sort((a, b) => {
      const pa = providerPriority(a[1]);
      const pb = providerPriority(b[1]);
      if (pa !== pb) return pa - pb;
      return String(a[0]).localeCompare(String(b[0]));
    });
  for (const [, p] of providers) {
    for (const m of p.models) {
      const name = getModelName(m);
      if (!name || seen.has(name)) continue;
      if (!resolveProvider(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

// Utility calls (intent extraction, alignment, proof checks) used to grab
// FREE_MODELS[0], which silently depended on provider insertion order. They
// now pick the best live model, overridable with UTILITY_MODEL.
function pickUtilityModel() {
  const forced = String(process.env.UTILITY_MODEL || "").trim();
  if (forced && resolveProvider(forced)) return forced;
  const candidates = liveModelCandidates();
  return candidates.length ? candidates[0] : "";
}

// Agents are seeded with a model name, but that name must not pin the agent
// to one provider forever. If the configured model has no live provider, the
// agent falls back to the live catalog (AGENT_MODEL first, then priority
// order). Proxy requests never take this path: a client that names a model
// gets that model or an honest error.
function usableAgentModel(agent) {
  if (!agent || typeof agent !== "object") return "";
  const configured = String(agent.model || "").trim();
  const key = agent.id + "|" + configured;
  if (_agentModelCache.has(key)) return _agentModelCache.get(key);
  const usable = chooseUsableModel(
    configured,
    process.env.AGENT_MODEL,
    liveModelCandidates(),
  );
  if (usable && usable !== configured) {
    log("WARN", "AGENT_MODEL_FALLBACK", {
      agent: agent.id,
      from: configured || "(none)",
      to: usable,
    });
  }
  _agentModelCache.set(key, usable);
  return usable;
}


// Computed: all public model -> provider mapping
function getAllModels() {
  const list = [];
  for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
    // An inactive provider contributes nothing to the model page. The rows
    // stay in SQLite so re-enabling it restores the list immediately.
    if (p.enabled === false) continue;
    if (p.models.length === 0) {
      list.push({
        model: "*",
        provider: id,
        providerName: providerDisplayName(id, p),
        providerType: p.type,
        type: "chat",
        enabled: true,
      });
    } else {
      for (const m of p.models) {
        list.push({
          model: getModelName(m),
          apiModel: getApiModelName(m),
          provider: id,
          providerName: providerDisplayName(id, p),
          providerType: p.type,
          type: modelKind(p, m),
          enabled: !DISABLED_MODELS.has(id + "::" + getModelName(m)),
        });
      }
    }
  }
  return list;
}

// Model names come from provider config or the agents table, never from a
// source-code default. An empty/invalid name fails at resolveProvider().
function normalizeRoutingModel(model) {
  return typeof model === "string" ? model.trim() : "";
}

// ─── Competition Router ─────────────────────────────────────
// Resolves which provider to call based on model name
// ─── Admin runtime enable/disable state (persisted in `settings`) ──
// Providers: PROVIDER_CONFIG[id].enabled === false → skipped by resolve/fallback/sync.
// Models:    DISABLED_MODELS has "provider::name"     → skipped by resolve.
let DISABLED_MODELS = new Set();

function loadDisabledState() {
  if (!MODELS_DB) return;
  try {
    const row = MODELS_DB.prepare(
      "SELECT value FROM settings WHERE key = 'provider_disabled'"
    ).get();
    const settingIds = row && row.value ? JSON.parse(row.value) : [];
    let dbIds = [];
    try {
      dbIds = MODELS_DB.prepare(
        "SELECT id FROM providers WHERE enabled = 0",
      ).all().map((r) => r.id);
    } catch (_) {
      /* providers table missing on an old DB */
    }
    const ids = [...new Set([...settingIds, ...dbIds])];
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      p.enabled = !ids.includes(id) && p.envDisabled !== true;
    }
    const rows = MODELS_DB.prepare(
      "SELECT provider, name FROM models WHERE enabled = 0"
    ).all();
    DISABLED_MODELS = new Set(rows.map((r) => r.provider + "::" + r.name));
    log("INFO", "DISABLED_STATE_LOADED", {
      providers_off: ids.length,
      models_off: DISABLED_MODELS.size,
    });
  } catch (e) {
    log("WARN", "DISABLED_STATE_FAIL", { error: e.message });
  }
}

function persistProviderDisabled() {
  if (!MODELS_DB) return [];
  const ids = Object.entries(PROVIDER_CONFIG)
    .filter(([, p]) => p.enabled === false)
    .map(([id]) => id);
  try {
    MODELS_DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('provider_disabled', ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(JSON.stringify(ids), Date.now());
    const upd = MODELS_DB.prepare(
      "UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?",
    );
    const now = Date.now();
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      upd.run(p.enabled === false ? 0 : 1, now, id);
    }
  } catch (e) {
    log("WARN", "PROVIDER_DISABLED_SAVE_FAIL", { error: e.message });
  }
  return ids;
}

function getDisabledModelRows() {
  if (!MODELS_DB) return [];
  try {
    return MODELS_DB.prepare("SELECT provider, name FROM models WHERE enabled = 0").all();
  } catch (e) {
    return [];
  }
}

// P1 display alias (MODEL_ALIASES env, format public:canonical — e.g.
// zombie-mini:llama-local). Applied BEFORE provider resolution so a public
// name always lands on the canonical id (S6): the normalizer sync prunes
// custom-provider entries the upstream does not report, so the alias map is
// the only place a public name may live.
const applyModelAlias = makeAliasResolver(process.env.MODEL_ALIASES || "");

// Opt-in passthrough for unknown models. Default OFF so a typo or a stale
// agent->model row fails loudly instead of being answered by another model.
const ALLOW_WILDCARD_MODEL = process.env.ALLOW_WILDCARD_MODEL || "0";

// Priority 0 is a valid "highest" value; `priority || 999` silently demoted it
// to 999 and let an unrelated provider win a model-name tie.
function providerPriority(p) {
  const n = Number(p && p.priority);
  return Number.isFinite(n) ? n : 999;
}

function resolveProvider(model, exactOnly) {
  // GUARD: Reject template/placeholder model names (e.g. "{{model}}")
  // These come from misconfigured clients and cause massive PROXY_FAIL storms
  if (!model || typeof model !== "string" || /\{\{.*\}\}/.test(model) || model.length < 2) {
    log("WARN", "MODEL_NAME_REJECTED", { model });
    return null;
  }
  model = applyModelAlias(model); // public alias -> canonical id

  const allNames = new Map();
  // Sort by priority (lower number = higher priority) so OpenCode (priority:1) wins over Groq (priority:2)
  const sortedProviders = Object.entries(PROVIDER_CONFIG).sort(
    ([, a], [, b]) => providerPriority(a) - providerPriority(b),
  );
  for (const [id, p] of sortedProviders) {
    if (p.enabled === false) continue; // admin-disabled provider
    // Runtime-down is not the same as admin-disabled. A provider that keeps
    // failing is skipped for the cooldown window so one dead endpoint cannot
    // make every model it happens to list unusable. It stays enabled in the
    // DB and recovers by itself after HEALTH_CONFIG.RECOVERY_COOLDOWN_MS.
    if (!isProviderHealthy(id)) {
      // One line per provider, not one per model. resolveProvider scans the
      // whole catalog, so logging inside the model loop emitted 50+ identical
      // lines for a single unhealthy provider on every request.
      log("INFO", "PROVIDER_SKIP_DOWN", {
        provider: id,
        reason: "unhealthy",
      });
      continue;
    }
    for (const m of p.models) {
      const name = getModelName(m);
      // admin-disabled model — never resolved, still re-enableable in admin
      if (DISABLED_MODELS.has(id + "::" + name)) continue;
      // Don't overwrite — first provider (highest priority) wins
      if (!allNames.has(name)) {
        allNames.set(name, { providerId: id, config: p });
      }
      // Also index by apiModel so both masked and unmasked names work
      const apiName = getApiModelName(m);
      if (apiName !== name && !allNames.has(apiName)) {
        allNames.set(apiName, { providerId: id, config: p });
      }
    }
  }
  // 1. Exact match — public model name or apiModel name
  if (allNames.has(model)) {
    return { ...allNames.get(model), matchType: "exact" };
  }
  if (exactOnly) return null;

  // 2. Agent ids resolve to their DB-backed model before anything else.
  //    Without this an agent whose model row is stale (e.g. "llama-local",
  //    an id no provider actually serves) silently fell through to the
  //    wildcard below and got answered by a DIFFERENT model while still
  //    reporting the agent id.
  try {
    if (MODELS_DB) {
      const row = MODELS_DB
        .prepare("SELECT model FROM agents WHERE id = ? AND enabled = 1")
        .get(model);
      if (row && row.model && row.model !== model) {
        const resolved = applyModelAlias(row.model);
        if (allNames.has(resolved)) {
          return { ...allNames.get(resolved), matchType: "agent_db", requestedModel: model };
        }
      }
    }
  } catch (_) {
    /* DB unavailable — fall through */
  }

  // 3. Wildcard — a provider with an empty models[] list.
  //    This is a legitimate OpenAI-compatible passthrough, BUT it must not
  //    swallow a typo: without the guard below, "zzz-does-not-exist" was
  //    accepted and forwarded upstream, which is indistinguishable from a
  //    working model until the upstream fails. Wildcards are therefore only
  //    honoured when the caller explicitly opted in.
  if (ALLOW_WILDCARD_MODEL === "1") {
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      if (p.enabled === false) continue; // admin-disabled provider
      if (p.models.length === 0) {
        return { providerId: id, config: p, matchType: "wildcard" };
      }
    }
  }

  // 4. No provider serves this model. Returning null makes the caller emit a
  //    truthful "unknown model" error instead of answering from the wrong one.
  log("WARN", "MODEL_NOT_FOUND", {
    model,
    known: allNames.size,
    wildcardDisabled: ALLOW_WILDCARD_MODEL !== "1",
  });
  return null;
}

// ─── Resolve all matching providers in priority order (for fallback) ──
// If primary provider fails, callModel tries the next provider
function resolveAllProviders(model, options) {
  const opts = options || {};
  const sorted = Object.entries(PROVIDER_CONFIG).sort(
    ([, a], [, b]) => providerPriority(a) - providerPriority(b),
  );
  const matches = [];
  for (const [id, p] of sorted) {
    if (p.enabled === false) continue; // admin-disabled provider
    // Runtime-down is separate from admin-disabled: keep the provider in the
    // registry (and re-enableable), but do not hand a request to an endpoint
    // that is inside its failure cooldown. The proxy path uses this function
    // directly, so the skip has to live here as well as in resolveProvider().
    if (!opts.includeUnhealthy && !isProviderHealthy(id, model)) continue;
    for (const m of p.models) {
      if (DISABLED_MODELS.has(id + "::" + getModelName(m))) continue; //
      if (getModelName(m) === model || getApiModelName(m) === model) {
        matches.push({ providerId: id, config: p });
        break;
      }
    }
  }
  return matches;
}

// ─── Find next HEALTHY provider in priority order for fallback ─
// If current provider fails, try the next provider
// Skips providers that are unhealthy (consecutive failures) or rate-limited
function findNextProvider(model, currentProviderId) {
  const allProviders = resolveAllProviders(model);
  const currentIdx = allProviders.findIndex(
    (p) => p.providerId === currentProviderId,
  );
  // Start from the next provider after currentIdx, skipping unhealthy ones
  for (let i = currentIdx + 1; i < allProviders.length; i++) {
    const candidate = allProviders[i];
    // resolveAllProviders() already narrowed the list to providers that
    // advertise this exact model (public name or apiModel). Do NOT re-check
    // with resolveProvider(x, true): that returns the single highest-priority
    // provider, so it rejected a legitimate second provider whenever the same
    // model was served twice (for example gemini-* on both gemini and
    // opencode), and fallback silently did nothing.
    if (
      PROVIDER_CONFIG[candidate.providerId]?.enabled !== false && // admin-off
      providerKeyState(candidate.providerId, candidate.config).ok &&
      isProviderHealthy(candidate.providerId, model)
    ) {
      return candidate;
    }
    log("INFO", "PROVIDER_SKIP_UNHEALTHY", {
      providerId: candidate.providerId,
      model,
      reason: "Provider is marked unhealthy or rate-limited",
    });
  }
  return null;
}

// ─── Ensure directories ───────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Auto SSOT System ────────────────────────────────────────
// Mission Barisal automatically discovers the project it serves,
// creates/updates .zombiecoder/SSOT.md, and agents follow it as truth.

// The server writes `.zombie/SSOT.md`; `.zombiecoder/` belongs to the plugin
// and is read-only. An old `SSOT_DIR=./.zombiecoder` is treated as the plugin
// path, not a server write target.
const SSOT_DIR = path.resolve(
  PROJECT_ROOT,
  process.env.SSOT_DIR && path.basename(process.env.SSOT_DIR) !== ".zombiecoder"
    ? process.env.SSOT_DIR
    : "./.zombie",
);
const SSOT_PATH = path.join(SSOT_DIR, "SSOT.md");

function scanProject(rootDir) {
  const info = {
    name: path.basename(rootDir),
    root: rootDir,
    language: "unknown",
    framework: "",
    type: "unknown",
    hasPackageJson: false,
    hasComposerJson: false,
    hasRequirementsTxt: false,
    hasGemfile: false,
    hasCargoToml: false,
    hasGoMod: false,
    hasMakefile: false,
    hasDockerfile: false,
    hasGit: false,
    entryFile: "",
    sourceDirs: [],
    fileCount: 0,
    jsCount: 0,
    pyCount: 0,
    phpCount: 0,
    tsCount: 0,
  };

  try {
    if (!fs.existsSync(rootDir)) return info;

    // Check common project markers
    const entries = fs.readdirSync(rootDir);
    info.fileCount = entries.length;

    for (const entry of entries) {
      const fullPath = path.join(rootDir, entry);
      const stat = fs.statSync(fullPath);

      if (entry === "package.json") {
        info.hasPackageJson = true;
        info.type = "node";
      } else if (entry === "composer.json") {
        info.hasComposerJson = true;
        info.type = "php";
      } else if (
        entry === "requirements.txt" ||
        entry === "setup.py" ||
        entry === "pyproject.toml"
      ) {
        info.hasRequirementsTxt = true;
        info.type = "python";
      } else if (entry === "Gemfile") {
        info.hasGemfile = true;
        info.type = "ruby";
      } else if (entry === "Cargo.toml") {
        info.hasCargoToml = true;
        info.type = "rust";
      } else if (entry === "go.mod") {
        info.hasGoMod = true;
        info.type = "go";
      } else if (entry === "Makefile") info.hasMakefile = true;
      else if (entry === "Dockerfile") info.hasDockerfile = true;
      else if (entry === ".git") info.hasGit = true;
      else if (entry.endsWith(".js")) info.jsCount++;
      else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) info.tsCount++;
      else if (entry.endsWith(".py")) info.pyCount++;
      else if (entry.endsWith(".php")) info.phpCount++;
      else if (
        stat.isDirectory() &&
        !entry.startsWith(".") &&
        !["node_modules", "vendor", ".git"].includes(entry)
      ) {
        info.sourceDirs.push(entry);
      }
    }

    // Detect language from file extensions if no marker file found
    if (info.type === "unknown") {
      if (info.hasPackageJson || info.jsCount > 0 || info.tsCount > 0)
        info.type = "node";
      else if (info.phpCount > 0) info.type = "php";
      else if (info.pyCount > 0) info.type = "python";
    }

    // Set language based on type + file evidence
    if (info.type === "node") {
      info.language = info.tsCount > info.jsCount ? "typescript" : "javascript";
    } else if (info.type === "php") info.language = "php";
    else if (info.type === "python") info.language = "python";
    else if (info.type === "ruby") info.language = "ruby";
    else if (info.type === "rust") info.language = "rust";
    else if (info.type === "go") info.language = "go";

    // Detect framework from package.json
    if (info.hasPackageJson) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(rootDir, "package.json"), "utf8"),
        );
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.next) info.framework = "next.js";
        else if (deps.react) info.framework = "react";
        else if (deps.vue) info.framework = "vue";
        else if (deps.express) info.framework = "express";
        else if (deps.nuxt) info.framework = "nuxt";
        else if (deps["@angular/core"]) info.framework = "angular";
        info.name = pkg.name || info.name;
        if (deps.typescript || pkg.devDependencies?.typescript) {
          info.language = "typescript";
        }
      } catch (e) { }
    }

    // Detect framework from composer.json
    if (info.hasComposerJson) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(rootDir, "composer.json"), "utf8"),
        );
        const deps = { ...pkg.require, ...pkg["require-dev"] };
        if (deps.laravel) info.framework = "laravel";
        else if (deps.symfony) info.framework = "symfony";
        info.name = pkg.name || info.name;
      } catch (e) { }
    }

    // Find entry files
    const entryCandidates = [
      "api.js",
      "app.js",
      "index.js",
      "server.js",
      "main.js",
      "index.ts",
      "main.ts",
      "main.py",
      "index.php",
      "main.go",
      "app.py",
    ];
    for (const ec of entryCandidates) {
      if (entries.includes(ec)) {
        info.entryFile = ec;
        break;
      }
    }
  } catch (e) {
    log("WARN", "PROJECT_SCAN_FAIL", { error: e.message, dir: rootDir });
  }

  return info;
}

function generateSSOT(rootDir, projectInfo) {
  const header = `# ${projectInfo.name} — Project Context (Auto-generated by Mission Barisal)

> This file is automatically managed by Mission Barisal v3.
> Agents use this as the Single Source of Truth for the project.

## Project Identity
- **Name:** ${projectInfo.name}
- **Root:** ${projectInfo.root}
- **Type:** ${projectInfo.type} (${projectInfo.language})
- **Framework:** ${projectInfo.framework || "none detected"}
- **Entry Point:** ${projectInfo.entryFile || "not detected"}
- **Source Dirs:** ${projectInfo.sourceDirs.join(", ") || "none"}
- **File Count:** ${projectInfo.fileCount}

## Detected Technologies
| Technology | Present | Files |
|-----------|---------|-------|
| JavaScript | ${projectInfo.type === "node" ? "yes" : "no"} | ${projectInfo.jsCount} .js |
| TypeScript | ${projectInfo.language === "typescript" ? "yes" : "no"} | ${projectInfo.tsCount} .ts |
| Python | ${projectInfo.type === "python" ? "yes" : "no"} | ${projectInfo.pyCount} .py |
| PHP | ${projectInfo.type === "php" ? "yes" : "no"} | ${projectInfo.phpCount} .php |
| Node.js | ${projectInfo.hasPackageJson ? "yes" : "no"} | package.json |
| Docker | ${projectInfo.hasDockerfile ? "yes" : "no"} | — |
| Git | ${projectInfo.hasGit ? "yes" : "no"} | — |

## Project Structure
`;

  let structure = "";
  try {
    structure = buildTree(rootDir, 0, 3);
  } catch (e) {
    structure = "  (error reading structure)";
  }

  let footer = `
## Mission Barisal Context
- **Server:** Mission Barisal v3 — Multi-Agent Code Platform
- **Owner:** Sahon Srabon (ZombieCoder) · Barisal, Bangladesh · At Home
- **Agents:** ${typeof AGENTS !== "undefined" && AGENTS.length ? AGENTS.length : 9} specialist agents + mission mode (all ${typeof AGENTS !== "undefined" && AGENTS.length ? AGENTS.length : 9} debate in parallel)
- **MCP Endpoint:** \`/mcp\` on port ${PORT}

| ID | Name | Role | Priority |
|----|------|------|----------|
`;

  // Add agent rows
  let agentRows = "";
  if (typeof AGENTS !== "undefined" && AGENTS.length > 0) {
    for (const a of AGENTS) {
      agentRows += `| \`${a.id}\` | ${a.name} | ${a.role} | ${a.priority} |\n`;
    }
  }
  footer += agentRows;

  footer += `
## Agent Instructions
- Agents MUST reference this SSOT.md when answering project-related questions.
- If the user asks about the project code, agents should check this file first.
- Any code changes recommendations should be based on the detected framework and tech stack above.
- If information is not in SSOT, agents should say "\u098f\u0987 \u09a4\u09a5\u09cd\u09af \u09ac\u09b0\u09cd\u09a4\u09ae\u09be\u09a8\u09c7 SSOT \u098f \u09a8\u09c7\u0987" and suggest adding it.
`;

  return header + structure + footer;
}

function buildTree(dir, depth, maxDepth) {
  if (depth > maxDepth) return "";
  let result = "";
  const indent = "  ".repeat(depth);
  try {
    const entries = fs.readdirSync(dir);
    const filtered = entries.filter(
      (e) => !e.startsWith(".") && e !== "node_modules" && e !== "vendor",
    );
    for (const entry of filtered) {
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        result += indent + "  " + entry + "/\n";
        result += buildTree(fullPath, depth + 1, maxDepth);
      } else {
        result += indent + "  " + entry + "\n";
      }
    }
  } catch (e) { }
  return result;
}

function autoSSOT(projectDir) {
  const dir = projectDir || path.resolve(".");
  log("INFO", "SSOT_SCAN", { dir });

  try {
    const paths = workspaceModule.ensureWorkspacePaths(dir);
    const targetDir = paths.dir;
    const targetPath = paths.ssot;

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
      log("INFO", "SSOT_DIR_CREATED", { dir: targetDir });
    }

    const projectInfo = scanProject(dir);
    const ssotContent = generateSSOT(dir, projectInfo);
    fs.writeFileSync(targetPath, ssotContent, "utf8");

    log("INFO", "SSOT_GENERATED", {
      path: targetPath,
      project: projectInfo.name,
      type: projectInfo.type,
      language: projectInfo.language,
      size: ssotContent.length,
    });

    return ssotContent;
  } catch (e) {
    log("WARN", "SSOT_GENERATE_FAIL", { error: e.message });
    return "";
  }
}

// Cache keyed by projectDir, with mtime validation for invalidation
const _ssotCacheMap = new Map(); // projectDir → { content, mtimeMs }

function readSSOT(projectDir) {
  try {
    const dir = projectDir || mcpWorkingDir || path.resolve(".");
    // The server owns `.zombie/SSOT.md`. The plugin's `.zombiecoder/SSOT.md`
    // is a read-only fallback for a workspace whose server copy is missing.
    const targetPath = workspaceModule.ensureWorkspacePaths(dir).ssot;
    const pluginSsot = path.join(dir, ".zombiecoder", "SSOT.md");
    const candidates = [targetPath, pluginSsot, SSOT_PATH];
    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const stat = fs.statSync(candidate);
      const cached = _ssotCacheMap.get(candidate);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.content) {
        log("INFO", candidate === targetPath ? "SSOT_LOADED" : "SSOT_FALLBACK", {
          path: candidate,
          length: cached.content.length,
          cached: true,
        });
        return cached.content;
      }
      const content = fs.readFileSync(candidate, "utf8").trim();
      if (content.length > 0) {
        _ssotCacheMap.set(candidate, { content, mtimeMs: stat.mtimeMs });
        log("INFO", candidate === targetPath ? "SSOT_LOADED" : "SSOT_FALLBACK", {
          path: candidate,
          length: content.length,
          cached: false,
        });
        return content;
      }
    }
    log("WARN", "SSOT_NOT_FOUND", { checked: candidates });
    return "";
  } catch (e) {
    log("WARN", "SSOT_READ_FAIL", { error: e.message });
    return "";
  }
}

// Re-generate SSOT when working directory changes (called from MCP set_working_dir)
function refreshSSOT(newDir) {
  log("INFO", "SSOT_REFRESH", { dir: newDir });
  return autoSSOT(newDir);
}

// MCP handshake bootstrap: guarantee the server-owned `.zombie/` workspace
// exists and the working dir is set. The plugin-owned `.zombiecoder/` tree is
// read-only input; this function never creates or writes it.
function ensureZombiecoderDir(baseDir) {
  const dir = path.resolve(baseDir || mcpWorkingDir || path.resolve("."));
  try {
    const layout = workspaceModule.ensureWorkspace(dir, {
      seedSSOT: (root) => {
        try {
          return generateSSOT(root, scanProject(root));
        } catch (_) {
          return "";
        }
      },
    });
    if (!mcpWorkingDir) mcpWorkingDir = dir;
    log("INFO", "MCP_HANDSHAKE_DIR", {
      dir: layout.dir,
      working_dir: mcpWorkingDir,
      created: layout.created.length > 0,
      plugin_ssot: Boolean(layout.fromPlugin && layout.fromPlugin.ssot),
      plugin_syllabus: Boolean(layout.fromPlugin && layout.fromPlugin.syllabus),
    });
    return {
      dir: layout.dir,
      working_dir: mcpWorkingDir,
      created: layout.created.length > 0,
    };
  } catch (e) {
    log("WARN", "ZOMBIE_DIR_FAIL", { dir, error: e.message });
    return { dir: "", working_dir: mcpWorkingDir || dir, created: false };
  }
}

/**
 * Syllabus, SSOT and session paths are owned by modules/workspace.js and
 * modules/syllabus.js. These wrappers only pass the live agent roster and the
 * gateway logger; the storage rules live in exactly one module.
 */
const syllabusModule = require("./modules/syllabus.js");
const workspaceModule = require("./modules/workspace.js");
const workspaceAdapter = require("./modules/workspace-adapter.js");

/** Legacy `.zombiecoder/agents/` path — read-only fallback for old state. */
function getAgentsPath(projectDir) {
  const dir = projectDir || mcpWorkingDir || path.resolve(".");
  return path.join(dir, ".zombiecoder", "agents");
}

/** Canonical server syllabus location: `.zombie/syllabus.md`. */
function getSyllabusPath(projectDir) {
  return workspaceModule.ensureWorkspacePaths(projectDir || mcpWorkingDir || path.resolve(".")).syllabus;
}

/**
 * Ensure the canonical syllabus exists and return its path.
 * The full template and the on-disk path are owned by modules/syllabus.js.
 */
function autoSyllabus(projectDir) {
  try {
    const result = syllabusModule.ensureSyllabus(
      projectDir || mcpWorkingDir || path.resolve("."),
      { agents: typeof AGENTS !== "undefined" ? AGENTS : [], log },
    );
    return result.path || null;
  } catch (e) {
    log("WARN", "SYLLABUS_AUTO_FAIL", { error: e.message });
    return null;
  }
}

/** Read the canonical project syllabus (bounded, mtime-cached). */
function readProjectSyllabus(projectDir) {
  try {
    return syllabusModule.readSyllabus(
      projectDir || mcpWorkingDir || path.resolve("."),
    );
  } catch (e) {
    log("WARN", "SYLLABUS_READ_FAIL", { error: e.message });
    return "";
  }
}

// `agentsDir` is kept so existing callers that pass the old path still work;
// the module resolves the canonical file itself.
function bootstrapSyllabus(projectDir) {
  const result = syllabusModule.ensureSyllabus(
    projectDir || mcpWorkingDir || path.resolve("."),
    { agents: typeof AGENTS !== "undefined" ? AGENTS : [], log },
  );
  return result.created;
}

function writeSyllabus(projectDir, topic, entry) {
  return syllabusModule.recordLearning(
    projectDir || mcpWorkingDir || path.resolve("."),
    topic,
    entry,
    { log },
  );
}

/**
 * Persist a learning entry to the project syllabus after an agent
 * completes a substantive task. Dedupes by topic. Never throws.
 * Wired into the agent flow (syllabus 8.6 — agents learn as they work).
 */
function learnToSyllabus(sessionId, agent, userInput, content) {
  try {
    if (!content || content.length < 40) return false; // skip trivial chatter
    const dir = getEffectiveDir(sessionId) || mcpWorkingDir;
    const topic = (userInput || "Agent task")
      .slice(0, 60)
      .replace(/\s+/g, " ")
      .trim();
    if (!topic) return false;
    // Dedupe: skip if topic already exists in the syllabus
    const existing = readProjectSyllabus(dir);
    if (existing && existing.includes("### " + topic)) return false;
    const summary = content.slice(0, 200).replace(/\s+/g, " ").trim();
    const ok = writeSyllabus(dir, topic, {
      source: "Agent: " + agent.id + " (" + agent.name + ")",
      summary: summary + (content.length > 200 ? "…" : ""),
      keyPoints: ["Completed by " + agent.name],
      usedIn: agent.role,
    });
    if (ok) {
      log("INFO", "SYLLABUS_LEARNED", { topic, agent: agent.id });
    }
    return ok;
  } catch (e) {
    log("WARN", "SYLLABUS_LEARN_FAIL", { error: e.message });
    return false;
  }
}
/**
 * Project session memory lives in SQLite (WAL). The legacy ctx_*.json /
 * memory.json files are imported once per project and never written again.
 * Returns null when the DB is unavailable so callers can fall back to JSON.
 */
let PROJECT_MEMORY = null;
function getProjectMemoryStore() {
  if (PROJECT_MEMORY) return PROJECT_MEMORY;
  if (!MODELS_DB) return null;
  try {
    PROJECT_MEMORY = createProjectMemory({
      db: MODELS_DB,
      log: (level, event, data) => log(level || "INFO", event, data || {}),
    });
    return PROJECT_MEMORY;
  } catch (e) {
    log("WARN", "PROJECT_MEMORY_INIT_FAIL", { error: e.message });
    return null;
  }
}

/**
 * Read memory.json for a project directory.
 */
function readMemory(projectDir) {
  const store = getProjectMemoryStore();
  if (store) {
    try {
      return store.readState(projectDir || mcpWorkingDir || path.resolve("."));
    } catch (e) {
      log("WARN", "MEMORY_READ_FAIL", { error: e.message });
    }
  }
  try {
    const agentsDir = getAgentsPath(projectDir);
    const memPath = path.join(agentsDir, "memory.json");
    if (fs.existsSync(memPath)) {
      const raw = fs.readFileSync(memPath, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    log("WARN", "MEMORY_READ_FAIL", { error: e.message });
  }
  // Return default structure
  return {
    current_session: {
      id: null,
      started_at: null,
      message_count: 0,
      summary: null,
    },
    recent_context: [],
    session_index: {
      last_accessed: null,
      total_sessions: 0,
      total_archived: 0,
    },
  };
}

/**
 * Write to memory.json.
 */
function writeMemory(projectDir, data) {
  const store = getProjectMemoryStore();
  if (store) {
    try {
      store.writeState(projectDir || mcpWorkingDir || path.resolve("."), data);
      return true;
    } catch (e) {
      log("WARN", "MEMORY_WRITE_FAIL", { error: e.message });
    }
  }
  try {
    const agentsDir = getAgentsPath(projectDir);
    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, { recursive: true });
    }
    const memPath = path.join(agentsDir, "memory.json");
    // ASYNC WRITE: non-blocking disk I/O (was writeFileSync — blocked event loop)
    fs.promises.writeFile(memPath, JSON.stringify(data, null, 2), "utf8").catch(e => log("WARN", "MEMORY_WRITE_ASYNC_FAIL", { error: e.message }));
    log("INFO", "MEMORY_SAVED", { path: memPath });
    return true;
  } catch (e) {
    log("WARN", "MEMORY_WRITE_FAIL", { error: e.message });
    return false;
  }
}

/**
 * Archive current session to the SQLite project_memory table.
 * Falls back to the legacy sessions/ctx_*.json file when the DB is down.
 */
function archiveSession(projectDir, sessionId, messages, summary) {
  const store = getProjectMemoryStore();
  if (store) {
    try {
      const dir = projectDir || mcpWorkingDir || path.resolve(".");
      const archiveId = store.archive(dir, sessionId, messages, summary, {
        metadata: { system_identity: identityMetadata(systemIdentityCore()) },
      });
      log("INFO", "SESSION_ARCHIVED", {
        session: archiveId,
        path: "sqlite:project_memory",
        project: path.resolve(dir),
        messages: (messages || []).length,
      });
      return archiveId;
    } catch (e) {
      log("WARN", "SESSION_ARCHIVE_DB_FAIL", { error: e.message });
    }
  }
  try {
    const agentsDir = getAgentsPath(projectDir);
    const sessionsDir = path.join(agentsDir, "sessions");
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeStr = now.toTimeString().slice(0, 2).replace(/:/g, "");

    // Find next sequence number
    let seq = 1;
    const existing = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.startsWith("ctx_") && f.endsWith(".json"));
    if (existing.length > 0) {
      const nums = existing
        .map((f) =>
          parseInt(f.replace("ctx_", "").replace(".json", "").split("_").pop()),
        )
        .filter((n) => !isNaN(n));
      if (nums.length > 0) seq = Math.max(...nums) + 1;
    }

    const filename = `ctx_${dateStr}_${String(seq).padStart(3, "0")}.json`;
    const filePath = path.join(sessionsDir, filename);

    // Extract key points and decisions from messages
    const keyPoints = [];
    const decisions = [];
    const filesChanged = [];

    // Build the session archive
    const archive = {
      session_id: filename.replace(".json", ""),
      created_at: now.toISOString(),
      message_count: (messages || []).length,
      summary: summary || "No summary provided",
      key_points: keyPoints.slice(0, 10),
      decisions: decisions.slice(0, 10),
      files_changed: filesChanged.slice(0, 20),
      tags: [],
      prev_session: null,
      next_session: null,
    };

    // ASYNC WRITE: non-blocking session archive
    fs.promises.writeFile(filePath, JSON.stringify(archive, null, 2), "utf8").catch(e => log("WARN", "SESSION_WRITE_ASYNC_FAIL", { error: e.message }));

    // Update _index.json
    _updateSessionIndex(agentsDir, archive);

    // Update memory.json session index AND recent_context
    const mem = readMemory(projectDir);
    mem.session_index.last_accessed = now.toISOString();
    mem.session_index.total_sessions += 1;
    mem.session_index.total_archived += 1;

    // ── UPDATE RECENT_CONTEXT: Keep last 5 session summaries ──
    if (!mem.recent_context) mem.recent_context = [];
    mem.recent_context.push({
      session_id: archive.session_id,
      summary: summary || "No summary",
      timestamp: now.toISOString(),
      agent_count: 0,
      tags: archive.tags || [],
    });
    const MAX_RECENT_CONTEXT = 20;
    if (mem.recent_context.length > MAX_RECENT_CONTEXT) {
      mem.recent_context = mem.recent_context.slice(-MAX_RECENT_CONTEXT);
    }

    // DE-DUPED: memory already saved in main flow — skip 2nd write
    // writeMemory(projectDir, mem);

    log("INFO", "SESSION_ARCHIVED", {
      session: archive.session_id,
      path: filePath,
      messages: archive.message_count,
      recent_context_count: mem.recent_context.length,
    });

    return archive.session_id;
  } catch (e) {
    log("WARN", "SESSION_ARCHIVE_FAIL", { error: e.message });
    return null;
  }
}

/**
 * Internal: update _index.json with keywords from the archived session.
 */
function _updateSessionIndex(agentsDir, archive) {
  try {
    const indexPath = path.join(agentsDir, "sessions", "_index.json");
    let index = {
      version: 1,
      last_updated: new Date().toISOString(),
      index: {},
    };

    if (fs.existsSync(indexPath)) {
      try {
        index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch (e) {
        /* use default */
      }
    }

    // Add keywords from tags, key_points, and summary
    const keywords = new Set();
    for (const tag of archive.tags || []) keywords.add(tag.toLowerCase());
    for (const kp of archive.key_points || []) {
      for (const word of kp.split(/\s+/)) {
        if (word.length > 3)
          keywords.add(word.toLowerCase().replace(/[^a-z0-9]/g, ""));
      }
    }

    for (const kw of keywords) {
      if (!index.index[kw]) index.index[kw] = [];
      if (!index.index[kw].includes(archive.session_id)) {
        index.index[kw].push(archive.session_id);
      }
    }

    index.last_updated = new Date().toISOString();
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");
  } catch (e) {
    log("WARN", "INDEX_UPDATE_FAIL", { error: e.message });
  }
}
/**
 * Search session archives by keyword.
 */
function searchSessions(projectDir, keyword) {
  const store = getProjectMemoryStore();
  if (store) {
    try {
      return store.search(
        projectDir || mcpWorkingDir || path.resolve("."),
        keyword,
      );
    } catch (e) {
      log("WARN", "SESSION_SEARCH_FAIL", { error: e.message });
    }
  }
  try {
    const agentsDir = getAgentsPath(projectDir);
    const indexPath = path.join(agentsDir, "sessions", "_index.json");
    if (!fs.existsSync(indexPath)) return [];

    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const kw = keyword.toLowerCase();
    const results = [];

    // Direct match in index
    for (const [key, sessions] of Object.entries(index.index || {})) {
      if (key.includes(kw) || kw.includes(key)) {
        results.push(...sessions);
      }
    }

    return [...new Set(results)];
  } catch (e) {
    log("WARN", "SESSION_SEARCH_FAIL", { error: e.message });
    return [];
  }
}

// ─── Emoji Strip Utility ─────────────────────────────────────
function stripEmoji(str) {
  if (!str) return "";
  // Matches most emoji (including skin tones, flags, zwj sequences)
  return str
    .replace(
      /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2702}-\u{27B0}\u{24C2}-\u{1F251}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{200D}\u{FE0F}\u{2300}-\u{23FF}\u{2934}\u{2935}\u{25AA}\u{25AB}\u{25FB}\u{25FC}\u{25FD}\u{25FE}\u{2B05}\u{2B06}\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/gu,
      "",
    )
    .trim();
}

// ─── Logger ──────────────────────────────────────────────────
// ─── Color constants for visual terminal logging ────────────
const C_RED = "\x1b[31m",
  C_GREEN = "\x1b[32m",
  C_YELLOW = "\x1b[33m";
const C_CYAN = "\x1b[36m",
  C_MAGENTA = "\x1b[35m",
  C_BLUE = "\x1b[34m";
const C_BOLD = "\x1b[1m",
  C_DIM = "\x1b[2m",
  C_RESET = "\x1b[0m";
const ICONS = {
  INFO: "",
  WARN: "",
  ERROR: "",
  DEBUG: "",
  REQUEST: "",
  RESPONSE: "",
  EVENT: "",
  DATA: "",
  START: "▶",
  END: "",
  PASS: "",
  FAIL: "",
};

function log(level, category, data, consoleOnly) {
  const ts = new Date().toISOString();
  const ts_short = ts.slice(11, 19); // HH:MM:SS only
  const icon = ICONS[level] || ICONS.INFO;
  let color = C_RESET;
  if (level === "ERROR") color = C_RED;
  else if (level === "WARN") color = C_YELLOW;
  else if (level === "INFO") color = C_GREEN;
  else if (level === "DEBUG") color = C_DIM;

  let dataStr = typeof data === "string" ? data : JSON.stringify(data);
  // Truncate long data for terminal display
  if (dataStr.length > 200) dataStr = dataStr.slice(0, 197) + "...";

  const entry = `[${ts}] [${level}] [${category}] ${typeof data === "string" ? data : JSON.stringify(data)}`;
  const visual = `${C_DIM}${ts_short}${C_RESET} ${icon} ${color}${C_BOLD}[${category}]${C_RESET} ${dataStr}`;
  console.log(visual);
  if (consoleOnly) return;
  const logFile = path.join(LOG_DIR, `${ts.slice(0, 10)}.log`);
  try {
    fs.appendFileSync(logFile, entry + "\n");
  } catch (e) { }
  // Mirror into the unified structured log so one file (logs/zc.jsonl) holds
  // api + provider + adapter + transport events side by side.
  zclog.raw(level === "ERROR" ? "ERROR" : level === "WARN" ? "WARN" : level === "DEBUG" ? "DEBUG" : "INFO",
    "api", category,
    typeof data === "string" ? { msg: data } : data);
}

/**
 * Visual Event Flow — real-time terminal visualization of request flow
 * Shows: REQUEST → AGENT → PROVIDER → RESPONSE with timing
 */
// ─── Request identity ─────────────────────────────────────────
// The visual log used to call the HTTP User-Agent an "agent" and print
// origin:"direct" whenever no Origin header existed. That told the operator
// nothing about who called the MCP endpoint. Identity is now resolved from
// explicit headers first, then from the MCP initialize handshake cached on the
// keep-alive socket, and only then falls back to the network origin.
const MCP_SOCKET_IDENTITY = new WeakMap();

function isLoopbackAddress(value) {
  const addr = normalizeHost(value).replace(/^::ffff:/, "");
  return addr === "localhost" || isLoopbackHost(addr);
}

// Bind/probe address for optional listeners. A wildcard bind is not a
// connectable address, so callers get loopback instead of 0.0.0.0 / ::.
function serviceBindHost(value) {
  const host = String(value || "").trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "127.0.0.1";
  }
  return host;
}

function socketAddress(req) {
  const s = req && (req.socket || req.connection);
  if (s) {
    try {
      const addr = s.address();
      if (typeof addr === "string") return "unix";
    } catch (_) {
      /* address() can throw after the socket is destroyed */
    }
    if (s.remoteAddress) return s.remoteAddress;
  }
  // A forwarded request may outlive the client socket. Keep the caller
  // attributable instead of falling back to "unknown".
  const h = (req && req.headers) || {};
  const forwarded = String(h["x-forwarded-for"] || h["x-real-ip"] || "")
    .split(",")[0]
    .trim();
  return forwarded || "";
}

function requestOrigin(req) {
  const h = (req && req.headers) || {};
  if (h.origin) return String(h.origin).slice(0, 160);
  if (h.referer) {
    try {
      return new URL(h.referer).origin;
    } catch (_) {
      /* malformed Referer: fall through to network origin */
    }
  }
  if (h["x-forwarded-proto"] || h["x-forwarded-host"]) {
    const proto = String(h["x-forwarded-proto"] || "http").split(",")[0].trim();
    const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
    if (host) return proto + "://" + host;
  }
  const from = socketAddress(req);
  if (from === "unix") return "unix";
  if (isLoopbackAddress(from)) return "local";
  return from ? "tcp://" + from : "unknown";
}

function rememberMcpIdentity(req, patch) {
  const socket = req && req.socket;
  if (!socket || !patch) return;
  const current = MCP_SOCKET_IDENTITY.get(socket) || {};
  const next = Object.assign({}, current);
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      next[key] = String(value).trim().slice(0, 160);
    }
  }
  MCP_SOCKET_IDENTITY.set(socket, next);
}

function mcpSocketIdentity(req) {
  const socket = req && req.socket;
  return (socket && MCP_SOCKET_IDENTITY.get(socket)) || {};
}

function requestActor(req) {
  const h = (req && req.headers) || {};
  const cached = mcpSocketIdentity(req);
  const agent =
    h["x-agent-id"] ||
    h["x-mcp-agent"] ||
    cached.agent ||
    h["x-mcp-client-name"] ||
    h["x-client-name"] ||
    "";
  const client =
    h["x-mcp-client-name"] ||
    h["x-client-name"] ||
    cached.client ||
    "";
  return {
    from: socketAddress(req) || "unknown",
    origin: requestOrigin(req),
    client: String(client || "").slice(0, 160),
    agent: String(agent || "").slice(0, 160),
    user_agent: String(h["user-agent"] || "").slice(0, 160),
  };
}

// Resolve a stable session owner. Explicit body/header identity wins; a
// bearer token is hashed; the network address is the last honest fallback.
// The source is logged so an operator can tell "anonymous" from "ip" at once.
function resolveClientIdentity(req, parsed) {
  const h = (req && req.headers) || {};
  const body = parsed && (parsed.client_id || parsed.client);
  const cached = mcpSocketIdentity(req).client;
  const header =
    h["x-client-id"] ||
    h["x-user-id"] ||
    h["x-mcp-client-name"] ||
    h["x-client-name"] ||
    cached ||
    "";
  if (body && String(body).trim()) {
    return { id: String(body).trim().slice(0, 160), source: "body" };
  }
  if (header && String(header).trim()) {
    return { id: String(header).trim().slice(0, 160), source: "header" };
  }
  const auth = String(h.authorization || "").trim();
  if (auth) {
    const digest = crypto.createHash("sha256").update(auth).digest("hex").slice(0, 12);
    return { id: "token:" + digest, source: "authorization" };
  }
  const ip = socketAddress(req);
  if (ip && ip !== "unknown") {
    return { id: "ip:" + ip, source: "ip" };
  }
  return { id: "anonymous", source: "fallback" };
}

function actorHeader(actor) {
  try {
    return Buffer.from(JSON.stringify(actor), "utf8").toString("base64url");
  } catch (_) {
    return "";
  }
}

function visualEventFlow(phase, label, detail) {
  const ts = new Date().toISOString().slice(11, 19);
  const phaseIcons = {
    request: "",
    response: "",
    agent: "",
    provider: "",
    anti_dote: "",
    mission: "",
    verify: "",
    error: "",
    data: "",
    system: "",
  };
  const phaseColors = {
    request: C_CYAN,
    response: C_GREEN,
    agent: C_BLUE,
    provider: C_YELLOW,
    anti_dote: C_MAGENTA,
    mission: C_CYAN,
    verify: C_GREEN,
    error: C_RED,
    data: C_DIM,
    system: C_BOLD,
  };
  const icon = phaseIcons[phase] || "•";
  const color = phaseColors[phase] || C_RESET;
  const detailStr = detail
    ? typeof detail === "string"
      ? detail.slice(0, 150)
      : JSON.stringify(detail).slice(0, 150)
    : "";
  console.log(
    `  ${C_DIM}${ts}${C_RESET} ${icon} ${color}${C_BOLD}${label}${C_RESET} ${detailStr}`,
  );
}

// 
//  PERSONAS PARSER
// 
// ─── YAML Frontmatter Agent Parser ────────────────────────────
// Parses custom agent files (.zombiecoder/agents/*.md) that use
// YAML frontmatter instead of the "## agent:" markdown format:
//   ---
//   name: agent-id
//   description: "..."
//   mode: all
//   model: some-model
//   permission: ...
//   ---
//   <persona body>
// Custom files OVERRIDE same-id agents from PERSONAS.md.
function parseYamlAgentFile(content) {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length).trim();

  // Parse simple YAML "key: value" pairs (skip nested/array lines)
  const fields = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (m) {
      fields[m[1]] = m[2]
        .trim()
        .replace(/^"|"$/g, "")
        .replace(/^'|'$/g, "");
    }
  }

  const id = fields.name || "";
  if (!id) return null;

  // Keep the declared model. When none is declared, read the first enabled
  // model from the catalog; no model literal is baked into this file.
  const model = fields.model || defaultAgentModel();

  let persona = body || fields.description || "";
  persona = persona.replace(/\s{2,}/g, " ").trim();

  if (!persona) return null;

  return {
    id,
    name: fields.name || id,
    model,
    role: fields.role || fields.mode || "general",
    expertise: fields.expertise || fields.description || "",
    priority: parseInt(fields.priority || "99", 10),
    persona,
  };
}

// ─── Load Personas ────────────────────────────────────────────
// Sources (merged, custom overrides default):
//   1. PERSONAS.md              — "## agent:" markdown format (default agents)
//   2. .zombiecoder/agents/*.md — YAML frontmatter format (custom agents)
// Read the first enabled model from the catalog instead of baking a literal
// name into the source. Returns an empty string when no catalog is available;
// callers must treat that as "no model", never substitute one.
function defaultAgentModel() {
  try {
    if (MODELS_DB) {
      // NOTE 1: the models table has no `model` column — the provider-facing
      //         name lives in `api_model` (`name` is the display label).
      // NOTE 2: SQLite does NOT accept parenthesised ORDER BY terms
      //         ("ORDER BY (a ASC, b ASC)" is MySQL syntax) — it throws
      //         "near ASC: syntax error". Keep the list flat.
      const row = MODELS_DB
        .prepare(
          "SELECT api_model FROM models WHERE enabled = 1 ORDER BY priority ASC, id ASC LIMIT 1"
        )
        .get();
      if (row && row.api_model) return row.api_model;
    }
  } catch (_) {
    /* no catalog available */
  }
  return "";
}

async function loadPersonas() {
  const valid = agentsModule.loadAgents({
    db: MODELS_DB,
    fileAgents: loadAgentFiles,
    customDir: getAgentsPath(),
    parseCustom: parseYamlAgentFile,
    resolveModel: resolveAgentModel,
    log,
  });
  if (valid.length > 0) {
    log("INFO", "PERSONAS_LOADED", { source: "local+custom", count: valid.length });
    return valid;
  }
  log("WARN", "PERSONAS_NOT_FOUND", { file: PERSONAS_FILE });

  // GIT_PERSONAS_URL defaults to "" when env var is not set.
  // https.get("") throws "TypeError: Invalid URL" at new URL("").
  if (!GIT_PERSONAS_URL || !GIT_PERSONAS_URL.startsWith("http")) {
    log("WARN", "PERSONAS_SKIP_DOWNLOAD", {
      reason: "GIT_PERSONAS_URL empty or invalid",
      url: GIT_PERSONAS_URL,
    });
    return [];
  }

  log("INFO", "PERSONAS_DOWNLOAD", { url: GIT_PERSONAS_URL });
  try {
    return new Promise((resolve) => {
      https
        .get(GIT_PERSONAS_URL, { timeout: 10000 }, (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              fs.writeFileSync(PERSONAS_FILE, data);
              const agents = parsePersonas(data);
              if (agents.length > 0) {
                log("INFO", "PERSONAS_DOWNLOADED", { count: agents.length });
                resolve(agents);
              } else {
                resolve([]);
              }
            } catch (e) {
              resolve([]);
            }
          });
        })
        .on("error", () => resolve([]));
    });
  } catch (e) {
    return [];
  }
}

// ─── Git Runtime Download — Generic File Downloader ────────
// "Agent personas, skills, instructions fetched from git at runtime"
// Zero dependency, pure https.

// ─── Agents DB Seed + Refresh (PHASE A) ────────────────────
// Seed: on first run, populate the agents table from agent/*.js — the single
// source of truth, where each agent carries its own persona inline. PERSONAS.md
// is no longer read, so a missing markdown file can never leave the table empty.
// Refresh: re-run loadPersonas() into the AGENTS global (used by admin CRUD).
function seedAgentsFromPersonas() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  try {
    const existing = MODELS_DB.prepare("SELECT COUNT(*) c FROM agents").get();
    if (existing && existing.c > 0) {
      return { ok: true, seeded: 0, note: "agents table already seeded" };
    }
    const agents = loadAgentFiles();
    if (agents.length === 0) {
      return { ok: true, seeded: 0, note: "no agents parsed from agent/*.js" };
    }
    const ins = MODELS_DB.prepare(`
      INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    let seeded = 0;
    const now = Date.now();
    for (const a of agents) {
      try {
        // Store a real model or an empty string, never the "MODELS_DB"
        // sentinel. The persona comes from the agent file and is required.
        const model = resolveAgentModel(a, null) || "";
        ins.run(a.id, a.name || a.id, a.role || "general", model, a.expertise || "", a.persona, a.priority || 99, now);
        seeded++;
      } catch (e) {
        log("WARN", "AGENT_SEED_SKIP", { id: a.id, error: e.message });
      }
    }
    log("INFO", "AGENTS_SEEDED", { from: "agent/*.js", count: seeded });
    return { ok: true, seeded };
  } catch (e) {
    log("WARN", "AGENTS_SEED_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── Runtime registry guarantee (heart-core agents/models → DB) ──
// Order (user contract): (1) create DB+schema at runtime — initModelsDb() does
// CREATE TABLE IF NOT EXISTS; (2) seed from local sources (PERSONAS.md /
// agent/*.js); (3) if STILL empty → download registry.seed.json from the
// remote repo. Models follow the same ladder via ensureModelsRegistry().
const REGISTRY_REMOTE_URL =
  process.env.REGISTRY_REMOTE_URL || "";

async function seedRegistryFromRemote(reason) {
  if (!REGISTRY_REMOTE_URL.startsWith("http")) {
    log("WARN", "REGISTRY_REMOTE_SKIP", { reason, url: REGISTRY_REMOTE_URL });
    return { ok: false, error: "remote url invalid" };
  }
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  log("INFO", "REGISTRY_REMOTE_FETCH", { url: REGISTRY_REMOTE_URL, reason });
  try {
    const data = await new Promise((resolve, reject) => {
      https
        .get(REGISTRY_REMOTE_URL, { timeout: 10000 }, (res) => {
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => resolve(d));
        })
        .on("error", reject);
    });
    const reg = JSON.parse(data);
    const now = Date.now();
    let na = 0;
    if (Array.isArray(reg.agents)) {
      const ins = MODELS_DB.prepare(
        `INSERT OR IGNORE INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      );
      for (const a of reg.agents) {
        if (!a || !a.id) continue;
        if (!String(a.persona || "").trim()) {
          log("WARN", "REGISTRY_AGENT_SKIP_NO_PERSONA", { id: a.id });
          continue;
        }
        try {
          ins.run(
            a.id,
            a.name || a.id,
            a.role || "general",
            a.model || "",
            a.expertise || "",
            a.persona,
            a.priority || 99,
            now,
          );
          na++;
        } catch (_) { /* duplicate id — fine */ }
      }
    }
    let nm = 0;
    if (Array.isArray(reg.models)) {
      const ins = MODELS_DB.prepare(
        `INSERT OR IGNORE INTO models (provider, name, api_model, provider_name, type, priority, updated_at, enabled, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
      );
      for (const m of reg.models) {
        if (!m || !m.provider || !m.name) continue;
        try {
          ins.run(
            m.provider,
            m.name,
            m.api_model || m.name,
            m.provider_name || m.provider,
            m.type || "openai",
            m.priority || 99,
            now,
          );
          nm++;
        } catch (_) { /* duplicate (provider,name) — fine */ }
      }
    }
    log("INFO", "REGISTRY_REMOTE_SEEDED", { agents: na, models: nm, url: REGISTRY_REMOTE_URL });
    return { ok: true, agents: na, models: nm };
  } catch (e) {
    log("WARN", "REGISTRY_REMOTE_FAIL", { error: e.message, url: REGISTRY_REMOTE_URL });
    return { ok: false, error: e.message };
  }
}

async function ensureAgentsRegistry() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  // Repair, not just first-run seed. A non-empty but incomplete table (stale
  // DB from an older build, a failed earlier seed, a deleted row) used to be
  // accepted forever because the check was only `count > 0`. INSERT OR IGNORE
  // restores only missing ids, so admin-edited rows are never overwritten.
  let repaired = 0;
  let namesSynced = 0;
  let modelsFixed = 0;
  try {
    const fileAgents = loadAgentFiles();
    const ins = MODELS_DB.prepare(
      `INSERT OR IGNORE INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    );
    // Display names are file-owned: when agent/*.js says "Bug Hunter - Jewel"
    // the DB row must say the same. Name-only sync — persona edits and
    // admin-chosen models are never overwritten.
    const syncName = MODELS_DB.prepare(
      `UPDATE agents SET name = ?, updated_at = ?
       WHERE id = ? AND (name IS NULL OR name <> ?)`
    );
    // Older seeds wrote the sentinel "MODELS_DB" as a literal model. Those
    // rows are not usable at routing time, so replace the sentinel with the
    // file's concrete fallback while leaving every admin-chosen model alone.
    const fix = MODELS_DB.prepare(
      `UPDATE agents SET model = ?, updated_at = ?
       WHERE id = ? AND (model IS NULL OR model = '' OR model = 'MODELS_DB')`
    );
    const now = Date.now();
    for (const a of fileAgents) {
      if (!a || !a.id) continue;
      if (!String(a.persona || "").trim()) {
        log("WARN", "AGENT_SKIP_NO_PERSONA", { id: a.id });
        continue;
      }
      const model = resolveAgentModel(a, null) || "";
      try {
        const r = ins.run(a.id, a.name || a.id, a.role || "general", model, a.expertise || "", a.persona, a.priority || 99, now);
        repaired += r.changes || 0;
        const synced = syncName.run(a.name || a.id, now, a.id, a.name || a.id);
        namesSynced += synced.changes || 0;
        // "added" counts restored agent rows only. A model update is not an
        // added agent; empty models are skipped so updated_at is not churned.
        if (model) {
          const fixed = fix.run(model, now, a.id);
          modelsFixed += fixed.changes || 0;
        }
      } catch (_) { /* dup */ }
    }
    const c = MODELS_DB.prepare("SELECT COUNT(*) c FROM agents").get();
    if (c && c.c > 0) {
      if (repaired > 0 || namesSynced > 0) {
        log("INFO", "AGENTS_REPAIRED", { from: "agent/*.js", added: repaired, namesSynced, modelsFixed, total: c.c });
      }
      return { ok: true, source: "db", count: c.c, repaired, namesSynced, modelsFixed };
    }
  } catch (e) {
    log("WARN", "AGENTS_FILE_SEED_FAIL", { error: e.message });
  }
  // 3. remote registry download
  return await seedRegistryFromRemote("agents-empty");
}

async function ensureModelsRegistry() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  try {
    const c = MODELS_DB.prepare("SELECT COUNT(*) c FROM models").get();
    if (c && c.c > 0) return { ok: true, source: "db", count: c.c };
  } catch (e) { /* fall through */ }
  return await seedRegistryFromRemote("models-empty");
}

// ─── Phase B: API Auth (users + sessions in SQLite) ────────
// Users: id, name, api_key (sha256 at rest), enabled.
// Sessions: bearer tokens issued on /api/auth/verify, checked by authFromRequest().
// SESSION_TTL_MS is already declared at the top (line ~147); reused here.

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str)).digest("hex");
}

function seedAdminUser() {
  if (!MODELS_DB) return { ok: false, error: "sqlite unavailable" };
  const name = process.env.ADMIN_USER || "admin";
  const apiKey = process.env.ADMIN_API_KEY || "";
  if (!apiKey) return { ok: true, note: "ADMIN_API_KEY not set — no seed" };
  try {
    const hash = sha256Hex(apiKey);
    MODELS_DB.prepare(
      `INSERT INTO users (name, api_key, enabled, token_limit, valid_days, token_used, expires_at, created_at)
       VALUES (?, ?, 1, 0, 0, 0, 0, ?)
       ON CONFLICT(api_key) DO UPDATE SET name = excluded.name, enabled = 1`,
    ).run(name, hash, Date.now());
    log("INFO", "ADMIN_USER_SEEDED", { name });
    return { ok: true };
  } catch (e) {
    log("WARN", "ADMIN_USER_SEED_FAIL", { error: e.message });
    return { ok: false, error: e.message };
  }
}

// ─── UI-1: user limit helpers ───────────────────────────────
// token_limit: 0 = unlimited, else max token units (requests/tokens).
// valid_days:  0 = unlimited, else days from created_at (or expires_at if set).
// Returns {ok:true, user} if within limits, else {ok:false, reason, code}.
function checkUserLimits(user) {
  if (!user) return { ok: false, reason: "user not found", code: 404 };
  if (user.enabled !== undefined && user.enabled !== 1) {
    return { ok: false, reason: "user disabled", code: 403 };
  }
  // Expiry from valid_days (computed at creation) OR explicit expires_at.
  const created = user.created_at || Date.now();
  const baseExpiry = user.expires_at && user.expires_at > 0 ? user.expires_at : 0;
  const dayExpiry = user.valid_days && user.valid_days > 0 ? created + user.valid_days * 86400000 : 0;
  const effectiveExpiry = baseExpiry > 0 ? baseExpiry : dayExpiry;
  if (effectiveExpiry > 0 && Date.now() > effectiveExpiry) {
    return { ok: false, reason: "user key expired", code: 403, expires_at: effectiveExpiry };
  }
  const used = user.token_used || 0;
  const limit = user.token_limit || 0;
  if (limit > 0 && used >= limit) {
    return { ok: false, reason: "token limit reached", code: 429, used, limit };
  }
  return { ok: true, user, used, limit, expires_at: effectiveExpiry };
}

// Increment a user's token_used counter by one unit.
function bumpUserUsage(userId) {
  if (!MODELS_DB || !userId) return;
  try {
    MODELS_DB.prepare("UPDATE users SET token_used = token_used + 1 WHERE id = ?").run(userId);
  } catch (e) {
    log("WARN", "USER_USAGE_BUMP_FAIL", { error: e.message });
  }
}

// authFromRequest: returns {ok:true,user} | {ok:false,reason} | {ok:null} (no auth sent)
function authFromRequest(req) {
  if (!MODELS_DB) return { ok: null };
  const bearer = req.headers["authorization"] || "";
  const apiKey = req.headers["x-api-key"] || "";
  // UI-1: load the full user row (id, name, enabled, limits) so
  // checkUserLimits() can enforce token quota / expiry correctly.
  const USER_FIELDS =
    "id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at";
  // OpenAI-compatible clients send `Authorization: Bearer <api_key>`. The
  // same users.api_key hash that backs `x-api-key` must work there too.
  // Session tokens are checked first, so existing clients keep their path.
  const userFromApiKey = function (rawKey) {
    const key = String(rawKey || "").trim();
    if (!key) return null;
    return MODELS_DB.prepare(
      `SELECT ${USER_FIELDS} FROM users WHERE api_key = ?`,
    ).get(sha256Hex(key)) || null;
  };
  if (bearer.startsWith("Bearer ")) {
    const token = bearer.slice(7).trim();
    const sess = MODELS_DB.prepare(
      `SELECT s.user_id, s.expires_at AS sess_expires_at, u.id, u.name, u.enabled,
              u.token_limit, u.valid_days, u.token_used, u.expires_at, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    ).get(token);
    if (!sess) {
      const user = userFromApiKey(token);
      if (!user) return { ok: false, reason: "invalid session token" };
      if (user.enabled !== 1) return { ok: false, reason: "user disabled" };
      return { ok: true, user: user };
    }
    if (sess.enabled !== 1) return { ok: false, reason: "user disabled" };
    if (sess.sess_expires_at < Date.now()) {
      MODELS_DB.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      return { ok: false, reason: "session expired" };
    }
    return {
      ok: true,
      user: {
        id: sess.user_id,
        name: sess.name,
        enabled: sess.enabled,
        token_limit: sess.token_limit,
        valid_days: sess.valid_days,
        token_used: sess.token_used,
        expires_at: sess.expires_at,
        created_at: sess.created_at,
      },
    };
  }
  if (apiKey) {
    const user = userFromApiKey(apiKey);
    if (!user) return { ok: false, reason: "invalid api key" };
    if (user.enabled !== 1) return { ok: false, reason: "user disabled" };
    return {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        enabled: user.enabled,
        token_limit: user.token_limit,
        valid_days: user.valid_days,
        token_used: user.token_used,
        expires_at: user.expires_at,
        created_at: user.created_at,
      },
    };
  }
  return { ok: null };
}

// 
//  MCP PRIVILEGED-TOOL GATE  (SECURITY 2026-10-08)
// 
// EVIDENCE — before this gate POST /mcp ran arbitrary shell with NO auth at all:
//   curl -s -X POST http://localhost:3000/mcp \
//     -d '{"method":"tools/call","params":{"name":"exec",
//          "arguments":{"command":"id; hostname"}}}'
//   -> uid=999(xubuntu) ... groups=...,sudo  [exit] 0
//   curl ... {"name":"env_get","arguments":{"key":"OPENCODE_API_KEY",
//          "reveal_secrets":true}}
//   -> OPENCODE_API_KEY=oc_sk_...            (full key, no credential needed)
// The server ALSO listened on 0.0.0.0 (APP_URL), so the LAN could reach it.
//
// Two independent controls now:
//   1. Origin gate — kills browser/CSRF/DNS-rebinding callers. Native MCP
//      clients (VS Code, curl, UDS) send no Origin header → still work.
//   2. Token gate  — privileged tools need MCP_ADMIN_TOKEN/ADMIN_API_KEY
//      (Bearer or x-api-key) OR a valid session/user key via authFromRequest.
const PRIVILEGED_MCP_TOOLS = new Set(surfacePolicy.PRIVILEGED_TOOLS);

function isPrivilegedMcpTool(name) {
  return surfacePolicy.isPrivilegedTool(name);
}

// Constant-time-ish admin token compare (hash both sides first).
function mcpAdminTokenOk(provided) {
  if (!provided) return false;
  const want = process.env.MCP_ADMIN_TOKEN || process.env.ADMIN_API_KEY || "";
  if (!want) return false; // no token configured → deny, never fail-open
  try {
    const a = sha256Hex(String(provided));
    const b = sha256Hex(want);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  } catch (_) {
    return false;
  }
}

// SECURITY (2026-10-08) — MODULE-SCOPE admin guard.
// Was a block-local `function adminAuthorized` declared inside the HTTP handler
// with this body:
//     if (!process.env.ADMIN_TOKEN) return true;   ← FAIL-OPEN
//     return req.headers["x-admin-token"] === process.env.ADMIN_TOKEN;
// ADMIN_TOKEN was never set in .env, so it always returned true and every
// /api/admin/* write (providers, models, agents, tools, users) accepted
// anonymous requests. Reproduced live before the fix:
//     curl -X POST http://localhost:3000/api/admin/tools \
//       -d '{"tool":"terminal","enabled":false}'
//     -> {"ok":true,"tool":"terminal","enabled":false}   (no credential)
// Declaring it block-locally also meant routes defined earlier in the same
// handler (e.g. /api/rate-limit/reset) could not reach a guard at all.
// Now: FAIL-CLOSED. Missing token → deny. Explicit opt-out only via
// ADMIN_ALLOW_UNAUTHENTICATED=true (dev machines that really want it).
function adminAuthorized(req) {
  const want = process.env.ADMIN_TOKEN;
  if (!want) {
    const openByChoice = process.env.ADMIN_ALLOW_UNAUTHENTICATED === "true";
    if (!openByChoice) {
      log("WARN", "ADMIN_AUTH_FAILCLOSED", {
        reason:
          "ADMIN_TOKEN unset — denying. Set ADMIN_ALLOW_UNAUTHENTICATED=true to opt out.",
      });
    }
    return openByChoice;
  }
  const h = (req && req.headers) || {};
  const got = h["x-admin-token"] || h["x-api-key"] || "";
  if (got && got === want) return true;
  // Accept the MCP admin token too, so one credential works everywhere.
  return mcpAdminTokenOk(
    String(h["authorization"] || "").startsWith("Bearer ")
      ? String(h["authorization"]).slice(7).trim()
      : got,
  );
}

// Admin API methods need the credential AND a live panel session. The
// session is minted only by GET /admin/zombie, so a bare token or curl call
// cannot drive the admin routes.
function adminRouteAuthorized(req) {
  return adminAuthorized(req) && adminSession.verify(req);
}

// {ok:true, via} | {ok:false, reason}
function mcpAuthFromHeaders(req) {
  const h = (req && req.headers) || {};
  const bearer = String(h["authorization"] || "");
  const apiKey = String(h["x-api-key"] || "");
  const provided = bearer.startsWith("Bearer ")
    ? bearer.slice(7).trim()
    : apiKey;
  if (mcpAdminTokenOk(provided)) return { ok: true, via: "admin-token" };
  const u = authFromRequest(req);
  if (u && u.ok === true) {
    return { ok: true, via: "user:" + ((u.user && u.user.name) || "?") };
  }
  if (u && u.ok === false) return { ok: false, reason: u.reason };
  return { ok: false, reason: "missing or invalid credentials" };
}

// Cross-origin / CSRF gate. A hostile web page can POST to
// http://localhost:3000/mcp from the victim's browser — that was the
// realistic path to RCE even after loopback binding. No-Origin = native
// client = allowed; every Origin must match an exact origin derived from
// APP_URL, MAIN_HOST and deploy/tools.json. There is no wildcard and no
// unconditional loopback bypass.
function isOriginAllowed(origin, req) {
  const value = String(origin || "").trim();
  if (!value) return true;

  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const candidates = new Set();
  for (const source of [DOMAIN_CFG.corsOrigins || [], RUNTIME_CONFIG.allowedOrigins || []]) {
    for (const item of source) {
      if (!item) continue;
      try {
        candidates.add(new URL(String(item).trim()).origin);
      } catch (_) {
        /* malformed entry: ignore */
      }
    }
  }
  if (DOMAIN_CFG.appUrl) {
    try {
      candidates.add(new URL(DOMAIN_CFG.appUrl).origin);
    } catch (_) {
      /* invalid APP_URL is reported by lib/env.js */
    }
  }

  if (candidates.has(parsed.origin)) return true;

  // Self-origin: the admin UI is served by this same process on
  // http://127.0.0.1:<port>, so its Origin can never appear in APP_URL
  // (which is the public https name). Without this, write_file/delete_file
  // from the admin UI were logged as MCP_GATE_DENIED.
  //
  // Narrow on purpose: BOTH the Origin and the Host header must be a loopback
  // literal. A DNS-rebinding page sends Host: <attacker-domain> with
  // Origin: http://<attacker-domain>, so a plain host comparison would have
  // opened exactly the hole this file's gate exists to close. Loopback
  // literals cannot be rebound. The loopback rule itself lives in
  // lib/net.js; this block must not keep a private copy.
  const originHostname = String(parsed.hostname || "").toLowerCase();
  const requestHost = String(
    (req && req.headers && req.headers.host) || "",
  ).trim();
  if (isLoopbackHost(originHostname) && requestHost) {
    try {
      const reqUrl = new URL("http://" + requestHost);
      if (
        isLoopbackHost(reqUrl.hostname) &&
        reqUrl.host === parsed.host
      ) {
        return true;
      }
    } catch (_) {
      /* malformed Host: fall through to reject */
    }
  }

  return false;
}

function mcpOriginAllowed(req) {
  const h = (req && req.headers) || {};
  const origin = String(h["origin"] || "");
  if (!origin) return true;
  return isOriginAllowed(origin, req);
}

// Origin-only guard for endpoints that legitimate NATIVE clients (VS Code
// extension, zombieBridge, curl) must keep calling without a token, but that a
// hostile web page must never reach via the victim's browser. Native clients
// send no Origin header → pass. Browser cross-origin → 403.
// Returns true when the request may proceed.
function mcpOriginGate(req, res, label) {
  if (mcpOriginAllowed(req)) return true;
  log("WARN", "ORIGIN_GATE_DENIED", {
    endpoint: label,
    origin: String((req.headers && req.headers.origin) || "unknown").slice(0, 120),
    remote: req.socket && req.socket.remoteAddress,
  });
  jsonResponse(res, 403, { error: "Forbidden: cross-origin request" });
  return false;
}

// Central gate for every tools/call entry point.
// Returns null when allowed, else a JSON-RPC error object.
// `trusted` = in-process call (handleMessage → handleMCP with res===null).
function mcpGate(req, toolName, trusted) {
  if (trusted) return null;
  if (!mcpOriginAllowed(req)) {
    return {
      code: -32001,
      message: "Forbidden: cross-origin MCP call rejected",
    };
  }
  if (isPrivilegedMcpTool(toolName)) {
    const a = mcpAuthFromHeaders(req);
    if (!a.ok) {
      return {
        code: -32001,
        message:
          "Unauthorized: privileged tool '" +
          toolName +
          "' requires Authorization: Bearer <MCP_ADMIN_TOKEN> or x-api-key",
      };
    }
  }
  return null;
}

// ─── Shared tools sanitizer (ALL input endpoints) ──
// Validates that a client-supplied tools value is a real array. Budgeting is
// NOT done here: lib/tool-budget.js owns the count/byte/prefill limits and
// callModel/callModelStream apply them once the provider is resolved.
// Used by: /v1/chat/completions, /api/mission, /api/v1/anti-dote,
// /api/input, WS chat, MCP agent_mission/agent_single.
// Budget guards. Tool results and history are the two places a prompt grows
// without bound; both are capped before every model call.
const MAX_TOOL_RESULT_CHARS = parseInt(process.env.MAX_TOOL_RESULT_CHARS || "3000", 10);
const MAX_HISTORY_CHARS = parseInt(process.env.MAX_HISTORY_CHARS || DEFAULTS.MAX_HISTORY_CHARS, 10);
const PROMPT_MAX_TOKENS = parseInt(process.env.PROMPT_MAX_TOKENS || "0", 10);

function promptBudgetFor(model) {
  let cfg = {};
  try {
    const resolved = resolveProvider(model, true);
    cfg = (resolved && resolved.config) || {};
  } catch (_) {}
  const contextWindow = Number(cfg.contextWindow) || 0;
  const reserve = Number(cfg.maxTokens) || 1024;
  if (contextWindow > 0) return Math.max(512, contextWindow - reserve);
  return Number.isFinite(PROMPT_MAX_TOKENS) && PROMPT_MAX_TOKENS > 0 ? PROMPT_MAX_TOKENS : 0;
}

function invisibleCharCount(text) {
  const counts = scanInvisible(String(text || ""));
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function trimHistoryByChars(entries, maxChars) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 6000;
  const out = [];
  let total = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (!entry || (entry.role !== "user" && entry.role !== "assistant")) continue;
    const raw = String(entry.content || "");
    const clipped = raw.length > 2000 ? raw.slice(0, 2000) + " ..." : raw;
    if (out.length > 0 && total + clipped.length > limit) break;
    out.unshift({ role: entry.role, content: clipped });
    total += clipped.length;
  }
  return out;
}

// Convert one MCP_TOOLS entry → OpenAI function-tool shape.
function toolSchema(name) {
  const def = MCP_TOOLS[name];
  if (!def) return null;
  return {
    type: "function",
    function: {
      name,
      description: def.description,
      parameters: {
        type: "object",
        properties: def.params || {},
        required: def.required || [],
      },
    },
  };
}

// Convert MCP_TOOLS catalog → OpenAI function-tools format so any page
// can request the full server tool set with body { tools: "mcp" }.
function mcpToolsToOpenAI() {
  return Object.keys(MCP_TOOLS)
    .map((name) => toolSchema(name))
    .filter(Boolean);
}

// Lazy tool discovery. The model gets tool_search (plus configured pins)
// instead of the whole catalog; it asks for a schema only when it needs one.
function searchToolCatalog(query, limit, includeSchema) {
  const cleanQuery = sanitizeForModel(String(query || "")).text
    .trim()
    .toLowerCase();
  const terms = cleanQuery.match(/[a-z0-9_]{2,}/g) || [];
  const max = Math.max(
    1,
    Math.min(Number(limit) || (cleanQuery ? 12 : 100), 200),
  );
  const entries = Object.keys(MCP_TOOLS).map((name) => {
    const description = String(MCP_TOOLS[name].description || "");
    const haystack = (name + " " + description).toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) continue;
      score += name.toLowerCase().includes(term) ? 2 : 1;
    }
    return { name, description, score };
  });
  const matched = cleanQuery
    ? entries.filter((entry) => entry.score > 0)
    : entries.slice();
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });
  const selected = matched.slice(0, max);
  return {
    query: cleanQuery,
    total: entries.length,
    matched: matched.length,
    returned: selected.length,
    tools:
      includeSchema === false
        ? selected.map((entry) => ({
            name: entry.name,
            description: entry.description,
          }))
        : selected.map((entry) => toolSchema(entry.name)),
  };
}

function lazyToolCatalog() {
  const catalog = [toolSchema("tool_search")].filter(Boolean);
  const pinned = toolBudget.config().pinned || [];
  for (const name of pinned) {
    if (name === "tool_search" || !MCP_TOOLS[name]) continue;
    catalog.push(toolSchema(name));
  }
  return catalog;
}

// A tool_search result carries full schemas. Add them to the live tool array
// for the next model round so the model can call the discovered tool.
function expandToolsFromSearch(tools, toolName, text) {
  if (toolName !== "tool_search") return tools;
  try {
    const parsed = JSON.parse(String(text || ""));
    const found = Array.isArray(parsed.tools) ? parsed.tools : [];
    const list = Array.isArray(tools) ? tools.slice() : [];
    const have = new Set(
      list.map(
        (tool) =>
          (tool && tool.function && tool.function.name) ||
          (tool && tool.name) ||
          "",
      ),
    );
    const added = [];
    for (const item of found) {
      const name = item && item.function && item.function.name;
      if (!name || have.has(name) || !MCP_TOOLS[name]) continue;
      const schema = toolSchema(name);
      if (!schema) continue;
      list.push(schema);
      have.add(name);
      added.push(name);
    }
    if (added.length) {
      log("INFO", "TOOL_DISCOVERED", { added: added.length, names: added });
    }
    return list;
  } catch (_) {
    return tools;
  }
}

function sanitizeToolValue(value, add) {
  if (typeof value === "string") {
    const result = sanitizeForModel(value);
    add(result.total);
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeToolValue(item, add));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const cleanKey = sanitizeForModel(key);
      add(cleanKey.total);
      out[cleanKey.text] = sanitizeToolValue(item, add);
    }
    return out;
  }
  return value;
}

function sanitizeTools(tools, model) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  let removed = 0;
  const clean = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(tool));
    } catch (_) {
      continue;
    }
    const fn =
      clone.function && typeof clone.function === "object"
        ? clone.function
        : clone;
    const name = sanitizeForModel(String(fn.name || ""));
    removed += name.total;
    fn.name = name.text.trim();
    if (!fn.name) continue;
    if (typeof fn.description === "string") {
      const description = sanitizeForModel(fn.description);
      removed += description.total;
      fn.description = description.text;
    }
    if (fn.parameters && typeof fn.parameters === "object") {
      fn.parameters = sanitizeToolValue(fn.parameters, (n) => {
        removed += n;
      });
    }
    clean.push(clone);
  }
  if (removed > 0) {
    log("INFO", "TOOL_SANITIZED", {
      removed,
      sent: clean.length,
      model: model || "",
    });
  }
  return clean.length ? clean : undefined;
}

// Model-bound message sanitizer. Applies the same strict character rules to
// every string content before it can reach a provider.
function sanitizeMessages(messages, source) {
  let removed = 0;
  const clean = (Array.isArray(messages) ? messages : []).map((message) => {
    if (!message || typeof message !== "object") return message;
    if (typeof message.content !== "string") return message;
    const result = sanitizeForModel(message.content);
    if (!result.total) return message;
    removed += result.total;
    return { ...message, content: result.text };
  });
  if (removed > 0) {
    log("INFO", "INPUT_SANITIZED", {
      source: source || "messages",
      removed,
      messages: clean.length,
    });
  }
  return clean;
}

// Intent text for tool ranking: the last user message, bounded. The resolver
// only uses ASCII words it can match against English tool names/descriptions.
function toolBudgetIntent(messages) {
  const lastUser = Array.isArray(messages)
    ? messages.filter((m) => m && m.role === "user").pop()
    : null;
  return lastUser ? String(lastUser.content || "").slice(0, 400) : "";
}

function logToolBudget(providerId, model, budget, extra) {
  log("INFO", "TOOL_BUDGET", {
    provider: providerId,
    model,
    limit: budget.limit,
    sent: budget.tools.length,
    dropped: budget.dropped,
    pinned: budget.pinned,
    bytes: budget.bytes,
    est_tokens: budget.estTokens,
    est_prefill_ms: budget.estPrefillMs,
    timeout_ms: budget.timeoutMs,
    strategy: budget.strategy,
    ...(extra || {}),
  });
}

async function refreshAgents() {
  AGENTS = await loadPersonas();
  STATS.totalAgents = AGENTS.length;
  return AGENTS;
}

// ─── Git Runtime Download — Generic File Downloader ────────

function downloadFromGit(url) {
  return new Promise((resolve) => {
    if (!url || !url.startsWith("http")) {
      resolve(null);
      return;
    }
    https
      .get(url, { timeout: 15000 }, (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data || null));
      })
      .on("error", () => resolve(null));
  });
}

async function loadSkills() {
  if (!GIT_SKILLS_URL) {
    log("INFO", "SKILLS_SKIP", { reason: "GIT_SKILLS_URL not set" });
    return;
  }
  log("INFO", "SKILLS_DOWNLOAD", { url: GIT_SKILLS_URL });
  try {
    const data = await downloadFromGit(GIT_SKILLS_URL);
    if (data) {
      if (!fs.existsSync(SKILLS_DIR))
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
      const skillFiles = data.split(/^### /m).filter(Boolean);
      let count = 0;
      for (const block of skillFiles) {
        const firstLine = block.split("\n")[0] || "unknown";
        const safeName = firstLine.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
        const filePath = path.join(SKILLS_DIR, safeName + ".md");
        fs.writeFileSync(filePath, "### " + block.trim());
        count++;
      }
      log("INFO", "SKILLS_DOWNLOADED", { count, dir: SKILLS_DIR });
    }
  } catch (e) {
    log("WARN", "SKILLS_FAIL", { error: e.message });
  }
}

async function loadInstructions() {
  if (!GIT_INSTRUCTIONS_URL) {
    log("INFO", "INSTRUCTIONS_SKIP", {
      reason: "GIT_INSTRUCTIONS_URL not set",
    });
    return;
  }
  log("INFO", "INSTRUCTIONS_DOWNLOAD", { url: GIT_INSTRUCTIONS_URL });
  try {
    const data = await downloadFromGit(GIT_INSTRUCTIONS_URL);
    if (data) {
      const destPath = path.join(SKILLS_DIR, "_instructions.md");
      if (!fs.existsSync(SKILLS_DIR))
        fs.mkdirSync(SKILLS_DIR, { recursive: true });
      fs.writeFileSync(destPath, data);
      log("INFO", "INSTRUCTIONS_DOWNLOADED", { path: destPath });
    }
  } catch (e) {
    log("WARN", "INSTRUCTIONS_FAIL", { error: e.message });
  }
}

function webSearch(query) {
  return new Promise((resolve) => {
    const url =
      "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      timeout: 15000,
      headers: { "User-Agent": "MissionBarisal-v3/1.0" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        const results = [];
        const rows = data.split("<tr>");
        for (const row of rows) {
          const linkMatch = row.match(
            /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i,
          );
          const textMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
          if (linkMatch && textMatch) {
            results.push({
              link: linkMatch[1].replace(/&amp;/g, "&"),
              title: linkMatch[2].replace(/<[^>]*>/g, "").trim(),
              snippet: textMatch[1].replace(/<[^>]*>/g, "").trim(),
            });
          }
        }
        if (results.length > 0) {
          resolve({ success: true, results: results.slice(0, 5), query });
        } else {
          const bodyText = data
            .replace(/<[^>]*>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          resolve({
            success: true,
            results: [
              {
                title: "Search Result",
                snippet: bodyText.slice(0, 1000),
                link: "",
              },
            ],
            query,
          });
        }
      });
    });
    req.on("error", (err) =>
      resolve({ success: false, error: err.message, query }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "timeout", query });
    });
    req.end();
  });
}

async function autoWebSearch(agent, response, userInput) {
  const content = response.content || "";
  const searchMatch = content.match(/web_search\s*:\s*(.+?)(?:\n|$)/i);
  if (!searchMatch) return response;

  const query = searchMatch[1].trim();
  const skipPatterns = [
    /\u09a4\u09cb\u09ae\u09be\u09b0 \u09aa\u09cd\u09b0\u09b6\u09cd\u09a8/i,
    /\u0986\u09aa\u09a8\u09be\u09b0 \u09aa\u09cd\u09b0\u09b6\u09cd\u09a8/i,
    /\u09b2\u09bf\u0996\u09c7 \u09a6\u09be\u0993/i,
    /enter.*query/i,
    /your.*question/i,
    /\u0989\u09a6\u09be\u09b9\u09b0\u09a3/i,
  ];
  if (query.length > 100 || skipPatterns.some((p) => p.test(query))) {
    log("INFO", "WEB_SEARCH_SKIP", {
      agent: agent.id,
      reason: "instruction-like query",
    });
    return response;
  }

  log("INFO", "WEB_SEARCH_AUTO", { agent: agent.id, query });
  const searchResult = await webSearch(query);
  let searchText = "";
  if (searchResult.success && searchResult.results.length > 0) {
    searchText =
      "WEB SEARCH RESULTS (" +
      query +
      "):\n" +
      searchResult.results
        .map(
          (r, i) =>
            i + 1 + ". " + (r.title || "Link") + "\n   " + (r.snippet || ""),
        )
        .join("\n");
  } else {
    searchText = "No search results found.";
  }

  const refined = await callModel(usableAgentModel(agent), [
    {
      role: "system",
      content:
        agent.persona +
        "\n\nYou did a web search. Update your response using the search results. Provide evidence.",
    },
    {
      role: "user",
      content:
        "Input:\n" +
        userInput +
        "\n\nYour previous answer:\n" +
        content +
        "\n\nSearch results:\n" +
        searchText +
        "\n\nNow update your answer based on search results.",
    },
  ]);

  return {
    ...response,
    content: refined.success
      ? searchText + "\n\n" + refined.content
      : content + "\n\nSearch processing failed.",
    webSearchUsed: true,
    searchQuery: query,
  };
}

// 
//  PUSHER EVENTS
// 
function triggerPusherEvent(channel, eventName, data) {
  return new Promise((resolve) => {
    if (!PUSHER_ENABLED) {
      resolve({ success: false, reason: "Pusher not configured" });
      return;
    }
    const body = JSON.stringify({
      data: JSON.stringify(data),
      name: eventName,
      channel,
    });
    const bodyMd5 = crypto.createHash("md5").update(body).digest("hex");
    const timestamp = Math.floor(Date.now() / 1000);
    const authString =
      "POST\n/apps/" +
      PUSHER_APP_ID +
      "/events\nauth_key=" +
      PUSHER_KEY +
      "&auth_timestamp=" +
      timestamp +
      "&auth_version=1.0&body_md5=" +
      bodyMd5;
    const signature = crypto
      .createHmac("sha256", PUSHER_SECRET)
      .update(authString)
      .digest("hex");
    const url =
      "https://api-" +
      PUSHER_CLUSTER +
      ".pusher.com/apps/" +
      PUSHER_APP_ID +
      "/events?body_md5=" +
      bodyMd5 +
      "&auth_version=1.0&auth_key=" +
      PUSHER_KEY +
      "&auth_timestamp=" +
      timestamp +
      "&auth_signature=" +
      signature;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      timeout: 10000,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () =>
        resolve({
          success: res.statusCode === 202 || res.statusCode === 200,
          status: res.statusCode,
          data: d,
        }),
      );
    });
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

async function pushLog(type, message) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-log", {
      type,
      message,
      time: new Date().toISOString(),
    });
}
async function pushAgentStatus(agentId, status) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "agent-status", {
      agent: agentId,
      status,
      time: new Date().toISOString(),
    });
}
async function pushOutput(output) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-output", {
      output,
      time: new Date().toISOString(),
    });
}
async function pushDone(stats) {
  if (PUSHER_ENABLED)
    await triggerPusherEvent("mission-barisal", "mission-done", {
      stats,
      time: new Date().toISOString(),
    });
}

// 
//  LOCK LOG SYSTEM — JSON Debug Memory (Zero Dependency)
// 
// Each lock operation (success/failure/timeout) is stored as JSON file.
// Organized by date — acts as debug memory for later analysis.
//
// Lock Entry Schema:
// {
//   lock_id: "uuid",
//   timestamp: "ISO date",
//   agent: "agent-id",
//   operation: "api_call|tool_exec|session|mission",
//   status: "success|failure|timeout|pending",
//   duration_ms: 1234,
//   details: { ... any additional context ... },
//   session_id: "optional",
//   provider: "optional",
//   model: "optional",
//   error: "optional error message",
// }
// 

const LOCK_DIR = path.resolve(
  PROJECT_ROOT,
  process.env.LOCK_DIR || path.join(DATA_DIR, "locks"),
);

function ensureLockDir() {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }
}

// Creates a lock log entry and saves to disk with detailed tracking
function writeLockLog(entry) {
  try {
    ensureLockDir();
    const now = new Date().toISOString();
    const lockEntry = {
      lock_id: entry.lock_id || crypto.randomUUID(),
      timestamp: now,
      date: now.slice(0, 10),
      time: now.slice(11, 19),
      agent: entry.agent || "system",
      operation: entry.operation || "unknown",
      status: entry.status || "pending",
      duration_ms: entry.duration_ms || 0,
      details: entry.details || {},
      session_id: entry.session_id || "",
      provider: entry.provider || "",
      model: entry.model || "",
      error: entry.error || "",
      request_id: entry.request_id || "",
      input_preview: entry.input_preview || "",
    };
    // Date-based file: locks/2026-07-11.json (append to daily file)
    const dateStr = lockEntry.date;
    const lockFile = path.join(LOCK_DIR, dateStr + ".json");
    let locks = [];
    if (fs.existsSync(lockFile)) {
      try {
        locks = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch (e) {
        locks = [];
      }
    }
    locks.push(lockEntry);
    // Keep last 2000 entries per day
    if (locks.length > 2000) locks = locks.slice(-2000);
    fs.writeFileSync(lockFile, JSON.stringify(locks, null, 2));

    // Auto-rotate: delete lock files older than 30 days
    try {
      const allFiles = fs
        .readdirSync(LOCK_DIR)
        .filter((f) => f.endsWith(".json"));
      const thirtyDaysAgo = Date.now() - 30 * 86400000;
      for (const f of allFiles) {
        const datePart = f.replace(".json", "");
        const fileTime = new Date(datePart).getTime();
        if (!isNaN(fileTime) && fileTime < thirtyDaysAgo) {
          fs.unlinkSync(path.join(LOCK_DIR, f));
        }
      }
    } catch (_) { }

    return lockEntry;
  } catch (e) {
    console.error("[LOCK_LOG_FAIL]", e.message);
    return null;
  }
}

// Read lock logs for a specific date (format: YYYY-MM-DD) or all dates
function readLockLogs(dateStr) {
  try {
    ensureLockDir();
    if (dateStr) {
      const lockFile = path.join(LOCK_DIR, dateStr + ".json");
      if (fs.existsSync(lockFile)) {
        return JSON.parse(fs.readFileSync(lockFile, "utf8"));
      }
      return [];
    }
    // Read all lock files
    const files = fs
      .readdirSync(LOCK_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const allLocks = [];
    for (const f of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(LOCK_DIR, f), "utf8"),
        );
        allLocks.push(...data);
      } catch (e) { }
    }
    return allLocks;
  } catch (e) {
    return [];
  }
}
// Lock log stats: per-agent health, trend analysis, failure patterns
function getLockStats() {
  const all = readLockLogs();
  const stats = {
    total: all.length,
    by_status: {},
    by_agent: {},
    by_operation: {},
    latest: all.slice(-10).reverse(),
    // Enhanced fields
    summary: {},
    agent_health: {},
    trends: {
      today: { total: 0, success: 0, failure: 0, timeout: 0 },
      yesterday: { total: 0, success: 0, failure: 0, timeout: 0 },
    },
  };

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  for (const l of all) {
    // Status count
    stats.by_status[l.status] = (stats.by_status[l.status] || 0) + 1;

    // Per-agent stats with health
    if (!stats.by_agent[l.agent]) {
      stats.by_agent[l.agent] = {
        total: 0,
        success: 0,
        failure: 0,
        timeout: 0,
        errors: [],
        lastError: null,
        avgDuration: 0,
      };
    }
    const a = stats.by_agent[l.agent];
    a.total++;
    if (l.status === "success") a.success++;
    if (l.status === "failure") {
      a.failure++;
      if (l.error) a.errors.push(l.error.slice(0, 100));
      a.lastError = l.timestamp;
    }
    if (l.status === "timeout") a.timeout++;
    if (l.duration_ms > 0) {
      a.avgDuration =
        a.avgDuration > 0
          ? Math.round(
            (a.avgDuration * (a.total - 1) + l.duration_ms) / a.total,
          )
          : l.duration_ms;
    }

    // Operation count
    stats.by_operation[l.operation] =
      (stats.by_operation[l.operation] || 0) + 1;

    // Trend analysis: today vs yesterday
    const date = l.date || l.timestamp.slice(0, 10);
    if (date === today) {
      stats.trends.today.total++;
      if (l.status === "success") stats.trends.today.success++;
      if (l.status === "failure") stats.trends.today.failure++;
      if (l.status === "timeout") stats.trends.today.timeout++;
    }
    if (date === yesterday) {
      stats.trends.yesterday.total++;
      if (l.status === "success") stats.trends.yesterday.success++;
      if (l.status === "failure") stats.trends.yesterday.failure++;
      if (l.status === "timeout") stats.trends.yesterday.timeout++;
    }
  }

  // Build health summary per agent
  for (const [agentId, agentData] of Object.entries(stats.by_agent)) {
    const successRate =
      agentData.total > 0
        ? Math.round((agentData.success / agentData.total) * 100)
        : 0;
    const errorRate =
      agentData.total > 0
        ? Math.round(
          ((agentData.failure + agentData.timeout) / agentData.total) * 100,
        )
        : 0;
    stats.agent_health[agentId] = {
      success_rate: successRate + "%",
      error_rate: errorRate + "%",
      avg_duration_ms: agentData.avgDuration,
      recent_errors: agentData.errors.slice(-5),
      status:
        successRate >= 95
          ? "healthy"
          : successRate >= 80
            ? "degraded"
            : "unhealthy",
    };
  }

  // Build overall summary
  const tot = all.length;
  const successCount = stats.by_status.success || 0;
  const failCount = stats.by_status.failure || 0;
  const timeoutCount = stats.by_status.timeout || 0;
  stats.summary = {
    total_entries: tot,
    overall_success_rate:
      tot > 0 ? Math.round((successCount / tot) * 100) + "%" : "0%",
    total_failures: failCount,
    total_timeouts: timeoutCount,
    agents_tracked: Object.keys(stats.by_agent).length,
    today_vs_yesterday: {
      today_total: stats.trends.today.total,
      yesterday_total: stats.trends.yesterday.total,
      change:
        stats.trends.yesterday.total > 0
          ? Math.round(
            ((stats.trends.today.total - stats.trends.yesterday.total) /
              stats.trends.yesterday.total) *
            100,
          ) + "%"
          : "N/A",
    },
  };

  return stats;
}

// 
//  SESSION & MEMORY SYSTEM (Optimized)
// 
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const CLIENTS_FILE = path.join(DATA_DIR, "clients.json");
const activeSessions = new Map(); // in-memory cache (id → session)
const clientSessions = new Map(); // client_id → session_id (for same-client reuse)
const sessionDirs = new Map(); // sessionId → workingDir (per-session workspace)
const memoryBuffer = new Map(); // filePath → entry[] (batch write buffer)
const sessionBuffer = new Map(); // sessionId → data (batch update buffer)

function readSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || [];
  } catch (e) {
    return [];
  }
}

function writeSessions(sessions) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // Synchronous + atomic. The old fs.promises.writeFile let two
    // createSession calls race: B read sessions.json before A's async write
    // landed and then overwrote the file with only B. Session writes are rare
    // (create, expire, flush) and the file is small, so sync is the safe trade.
    const tmp = SESSIONS_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
    fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) {
    log("ERROR", "WRITE_SESSIONS_FAILED", { error: e.message });
  }
}

function cleanExpired() {
  const sessions = readSessions();
  const now = Date.now();
  const expired = sessions.filter(
    (s) => new Date(s.expires_at).getTime() <= now,
  );
  const active = sessions.filter((s) => new Date(s.expires_at).getTime() > now);

  if (expired.length > 0) {
    // Archive expired sessions before removing them
    for (const s of expired) {
      // Clean up clientSessions mapping
      for (const [key, sid] of clientSessions) {
        if (sid === s.id) {
          clientSessions.delete(key);
          break;
        }
      }
      try {
        archiveSession(
          mcpWorkingDir,
          s.id,
          [],
          `Session expired after ${s.messages || 0} messages [${s.model || "unknown"}@${s.provider || "unknown"}]`,
        );
      } catch (_) {
        /* single archive fail should not block cleanup */
      }
    }
    writeSessions(active);
  }
  // Sync in-memory cache
  for (const s of active) activeSessions.set(s.id, s);

  try {
    const dataDir = DATA_DIR;
    if (fs.existsSync(dataDir)) {
      const entries = fs.readdirSync(dataDir);
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (uuidPattern.test(entry)) {
          const entryPath = path.join(dataDir, entry);
          try {
            const stat = fs.statSync(entryPath);
            if (
              stat.isDirectory() &&
              Date.now() - stat.mtimeMs > SEVEN_DAYS_MS
            ) {
              fs.rmSync(entryPath, { recursive: true, force: true });
              log("INFO", "DATA_CLEANED", { path: entryPath });
            }
          } catch (_) {
            /* individual folder cleanup failure should not block */
          }
        }
      }
    }
  } catch (_) {
    /* data cleanup is best-effort */
  }

  return active;
}

function createSession(clientId, editor, ip, customId, extraMeta) {
  // ── Session Reuse: if same client has an active session, return it ──
  if (!customId) {
    const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
    const existingId = clientSessions.get(clientKey);
    if (existingId) {
      const existing = getSession(existingId);
      if (existing) {
        // Touch: extend expiry on reuse
        existing.expires_at = new Date(
          Date.now() + SESSION_TTL_MS,
        ).toISOString();
        if (editor && editor !== "unknown") existing.editor = editor;
        // Merge any new metadata
        if (extraMeta) {
          existing.metadata = { ...(existing.metadata || {}), ...extraMeta };
        }
        if (existing.metadata && !existing.metadata.system_identity) {
          existing.metadata.system_identity = identityMetadata(systemIdentityCore());
        }
        activeSessions.set(existing.id, existing);
        log("INFO", "SESSION_REUSE", {
          id: existing.id.slice(0, 8),
          client_id: clientKey,
          client_id_source: (extraMeta && extraMeta.client_id_source) || "unknown",
          messages: existing.messages,
        });
        return existing;
      }
      // Stale entry — remove and fall through to create
      clientSessions.delete(clientKey);
    }
  }

  const sessions = cleanExpired();
  const id = customId || crypto.randomUUID();
  const now = Date.now();
  const session = {
    id,
    conversation_id: id, // each session has its own conversation_id
    client_id: clientId || "anonymous",
    editor: editor || "unknown",
    ip: ip || "",
    model: "",
    provider: "",
    messages: 0,
    status: "active",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    // ── Extended metadata from headers ──
    metadata: {
      agent_id: extraMeta?.agent_id || "",
      user_agent: extraMeta?.user_agent || "",
      device_info: extraMeta?.device_info || "",
      editor_version: extraMeta?.editor_version || "",
      os_platform: extraMeta?.os_platform || "",
      client_version: extraMeta?.client_version || "",
      session_source: extraMeta?.session_source || "mcp",
      // The user's chosen workspace. Persisted so a restart can rebuild the
      // in-memory sessionDirs map instead of silently falling back to the
      // server checkout.
      working_dir: extraMeta?.working_dir || "",
      // Every session carries the immutable system identity, so an archived
      // session can never lose track of which system produced it.
      system_identity: identityMetadata(systemIdentityCore()),
    },
  };
  sessions.push(session);
  activeSessions.set(id, session);
  writeSessions(sessions);
  // Register client → session mapping for reuse
  if (!customId) {
    const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
    clientSessions.set(clientKey, id);
  }
  log("INFO", "SESSION_CREATE", {
    id: id.slice(0, 8),
    editor,
    client_id_source: (extraMeta && extraMeta.client_id_source) || "unknown",
  });
  // Lock log: session created
  writeLockLog({
    lock_id: "sess-" + id.slice(0, 12),
    agent: "system",
    operation: "session_create",
    status: "success",
    duration_ms: Date.now() - now,
    details: { client_id: clientId, editor },
    session_id: id,
  });
  return session;
}

/**
 * Create or reuse a session and bind its working directory.
 *
 * `sessionDirs` is the in-memory source for the agent tool loop; the same value
 * is persisted in `session.metadata.working_dir` so `/api/sessions` and a
 * restart can see it. This is the one place that turns "the user picked a
 * folder" into "a real session owns that folder".
 */
function ensureSessionForDir(opts) {
  const o = opts || {};
  const dir = o.workingDir ? path.resolve(String(o.workingDir)) : "";
  const wanted = o.sessionId ? String(o.sessionId).trim() : "";
  let session = wanted ? getSession(wanted) : null;

  if (session) {
    if (dir) {
      session.metadata = { ...(session.metadata || {}), working_dir: dir };
      session.expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      activeSessions.set(session.id, session);
      sessionDirs.set(session.id, dir);
      updateSession(session.id, {
        metadata: session.metadata,
        expires_at: session.expires_at,
      });
      flushAllSessions();
    }
    return session;
  }

  session = createSession(
    o.clientId || "mcp",
    o.editor || "mcp",
    o.ip || "",
    wanted || crypto.randomUUID(),
    {
      session_source: o.source || "mcp",
      working_dir: dir,
      agent_id: o.agentId || "",
    },
  );
  if (dir) sessionDirs.set(session.id, dir);
  return session;
}

function getSession(id) {
  // Check in-memory first
  if (activeSessions.has(id)) {
    const s = activeSessions.get(id);
    if (new Date(s.expires_at).getTime() > Date.now() && s.status === "active")
      return s;
    activeSessions.delete(id);
  }
  const sessions = cleanExpired();
  const session = sessions.find((s) => s.id === id && s.status === "active");
  if (session) activeSessions.set(id, session);
  return session || null;
}

function updateSession(id, data) {
  // Buffer session updates to prevent read-modify-write race conditions
  // Same pattern as memoryBuffer — batch flush for thread safety
  const existing = sessionBuffer.get(id) || {};
  const merged = { ...existing, ...data };
  sessionBuffer.set(id, merged);
}

function flushAllSessions() {
  for (const [id, data] of sessionBuffer) {
    if (Object.keys(data).length === 0) continue;
    try {
      const sessions = readSessions();
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) continue;
      Object.assign(sessions[idx], data);
      activeSessions.set(id, sessions[idx]);
      writeSessions(sessions);
    } catch (e) {
      log("ERROR", "FLUSH_SESSION_FAILED", { id, error: e.message });
    }
  }
  sessionBuffer.clear();
}

// ─── CLIENT LIST PERSISTENCE ─────────────────────────────
// v3.2.1 — buffered: in-memory cache + ~1s debounced flush + MAX cap.
// (Replaces the old sync read+write-per-heartbeat that blocked the
// event loop on every MCP ping / initialize.)
const CLIENTS_FLUSH_MS = parseInt(process.env.CLIENTS_FLUSH_MS || "1000", 10);
const MAX_SAVED_CLIENTS = parseInt(process.env.MAX_SAVED_CLIENTS || "500", 10);
let clientsCache = null; // null = not loaded from disk yet
let clientsDirty = false;
let clientsFlushTimer = null;

function readClients() {
  if (clientsCache !== null) return clientsCache;
  clientsCache = [];
  if (fs.existsSync(CLIENTS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
      if (Array.isArray(parsed)) clientsCache = parsed;
    } catch (e) {
      log("WARN", "READ_CLIENTS_FAILED", { error: e.message });
    }
  }
  return clientsCache;
}

function flushClientsSync() {
  if (clientsFlushTimer) {
    clearTimeout(clientsFlushTimer);
    clientsFlushTimer = null;
  }
  if (!clientsDirty || clientsCache === null) {
    clientsDirty = false;
    return;
  }
  try {
    fs.writeFileSync(CLIENTS_FILE, JSON.stringify(clientsCache, null, 2));
    clientsDirty = false;
  } catch (e) {
    log("ERROR", "WRITE_CLIENTS_FAILED", { error: e.message });
  }
}

function scheduleClientsFlush() {
  clientsDirty = true;
  if (clientsFlushTimer) return;
  clientsFlushTimer = setTimeout(() => {
    clientsFlushTimer = null;
    flushClientsSync();
  }, CLIENTS_FLUSH_MS);
  // Never let the debounce timer hold the process open
  if (typeof clientsFlushTimer.unref === "function") clientsFlushTimer.unref();
}

function writeClients(clients) {
  clientsCache = Array.isArray(clients) ? clients : [];
  // Cap: keep only the freshest MAX_SAVED_CLIENTS entries
  if (clientsCache.length > MAX_SAVED_CLIENTS) {
    clientsCache.sort(
      (a, b) => new Date(b.last_seen || 0) - new Date(a.last_seen || 0),
    );
    clientsCache.length = MAX_SAVED_CLIENTS;
    log("INFO", "CLIENTS_CAPPED", { max: MAX_SAVED_CLIENTS });
  }
  // Also sync in-memory mcpClients Map
  mcpClients.clear();
  for (const c of clientsCache) {
    mcpClients.set(c.name, c);
  }
  scheduleClientsFlush();
}

function saveClient(clientData) {
  const clients = readClients();
  const idx = clients.findIndex((c) => c.name === clientData.name);
  if (idx >= 0) {
    clients[idx] = { ...clients[idx], ...clientData };
  } else {
    clients.push(clientData);
  }
  writeClients(clients);
}

function updateClientHeartbeat(clientName) {
  if (clientName && clientName !== "unknown") {
    const clients = readClients();
    const idx = clients.findIndex((c) => c.name === clientName);
    if (idx >= 0) {
      clients[idx].last_seen = new Date().toISOString();
      clients[idx].status = "active";
      writeClients(clients);
    }
  }
}

// Per-agent per-session memory (buffered — batch flush reduces disk I/O)
function saveAgentMemory(sessionId, agentId, role, content) {
  const dir = path.join(DATA_DIR, sessionId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, agentId + ".json");
  // Apply cleanup: strip XML tags from user, deduplicate assistant
  const cleanContent = role === "user"
    ? stripUserRequestTags(content)
    : role === "assistant"
      ? deduplicateText(content)
      : content;
  const entry = {
    role,
    content: String(cleanContent).slice(0, 4000),
    timestamp: new Date().toISOString(),
  };
  if (!memoryBuffer.has(file)) memoryBuffer.set(file, []);
  memoryBuffer.get(file).push(entry);
}

function getAgentMemory(sessionId, agentId) {
  const file = path.join(DATA_DIR, sessionId, agentId + ".json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { }
  }
  return [];
}

// ─── TEXT CLEANUP HELPERS (Bug Hunter - Jewel fix) ───
// Strip <userRequest>...</userRequest> XML tags from user input
// These tags are injected by VS Code Copilot Chat extension
function stripUserRequestTags(text) {
  if (!text) return text;
  return String(text)
    .replace(/<\/?userRequest>/g, "")
    .trim();
}

// Deduplicate repeated text chunks (model often repeats its thinking)
function deduplicateText(text) {
  if (!text) return text;
  let result = String(text);
  // Remove exact duplicate sentences (e.g., "X.X" where X repeats)
  // Split by sentence-ending punctuation, deduplicate, rejoin
  const sentences = result.split(/(?<=[.!?।])\s+/);
  const seen = new Set();
  const unique = [];
  for (const s of sentences) {
    const normalized = s.trim().toLowerCase();
    if (!seen.has(normalized) && normalized.length > 5) {
      seen.add(normalized);
      unique.push(s);
    } else if (normalized.length <= 5) {
      unique.push(s); // keep short fragments (Bengali particles etc.)
    }
  }
  result = unique.join(" ");
  // Also remove duplicated lines (exact line match)
  const lines = result.split("\n");
  const seenLines = new Set();
  const uniqueLines = [];
  for (const line of lines) {
    const norm = line.trim();
    if (!seenLines.has(norm) || norm.length < 3) {
      seenLines.add(norm);
      uniqueLines.push(line);
    }
  }
  return uniqueLines.join("\n").trim();
}

// Global session memory (buffered — batch flush for efficiency)
function saveMemory(sessionId, role, content) {
  const file = path.join(DATA_DIR, "mem-" + sessionId + ".json");
  // Apply cleanup: strip XML tags from user, deduplicate assistant
  const cleanContent = role === "user"
    ? stripUserRequestTags(content)
    : role === "assistant"
      ? deduplicateText(content)
      : content;
  const entry = {
    role,
    content: String(cleanContent).slice(0, 4000),
    timestamp: new Date().toISOString(),
  };
  if (!memoryBuffer.has(file)) memoryBuffer.set(file, []);
  memoryBuffer.get(file).push(entry);
}

function getMemory(sessionId) {
  const file = path.join(DATA_DIR, "mem-" + sessionId + ".json");
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) { }
  }
  return [];
}

// Flush all buffered memory writes to disk (single read-modify-write per file)
function flushAllMemory() {
  for (const [file, entries] of memoryBuffer) {
    if (entries.length === 0) continue;
    try {
      let mem = [];
      if (fs.existsSync(file)) {
        try {
          mem = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) { }
      }
      mem.push(...entries);
      if (mem.length > 50) mem = mem.slice(-50);
      fs.writeFileSync(file, JSON.stringify(mem, null, 2));
    } catch (e) {
      log("ERROR", "FLUSH_MEMORY_FAILED", { file, error: e.message });
    }
  }
  memoryBuffer.clear();
  // Also flush buffered session updates to prevent race conditions
  flushAllSessions();
}

// 
// USER MEMORY CACHE — Cross-Session Intelligence — Cross-Session Intelligence
//  Zero dependency · JSON-based · TTL-aware
//   Caches user patterns and preferences for accuracy and speed
//   "Memory from user interactions for closer and more accurate responses"
// 

function initCache() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    log("INFO", "CACHE_DIR_CREATED", { dir: CACHE_DIR });
  }
}
// 
// HAQ MAWLA — Universal Response Normalizer
//  Zero dependency · OpenAI, Anthropic, Gemini, Ollama unified
//  Origin: exam/Haq Mawla/server.js
// 
// Converts any provider response to unified OpenAI-compatible format.
// Notably extracts content from reasoning_content (Mimo, North Mini, Nemotron)
// 

// ─── Model + Provider Masking System ─────────────────────────
// Agent only knows zombie name — original model/provider names are hidden
// PROVIDER_CONFIG uses { name: "model-pro", apiModel: "nemotron-3-ultra-free" }
// name = zombie name (visible to agent), apiModel = original (used only for API calls)

// Provider name masking — hides original provider name, shows "ZombieCoder"
const PROVIDER_MASK_MAP = {
  OpenCode: "ZombieCoder",
  Groq: "ZombieCoder",
  Gemini: "ZombieCoder",
  "OpenCode (ZEN)": "ZombieCoder",
  "CF_PROVIDER": "ZombieCoder",
  "OLLAMA": "ZombieCoder",
  CUSTOM: "ZombieCoder",
  Unknown: "ZombieCoder",
};
// Model name masking — resolves zombie name from original model name
function maskModelName(realModelName) {
  for (const p of Object.values(PROVIDER_CONFIG)) {
    for (const m of p.models) {
      if (getApiModelName(m) === realModelName) return getModelName(m);
    }
  }
  return realModelName;
}

/**
 * HAQ MAWLA NORMALIZER — response format normalizer
 * ============================================================
 * Recognizes the response formats of the configured providers and converts
 * them to the OpenAI-compatible shape. Unknown formats are rejected on
 * purpose; only known dialects pass through.
 *
 * Supported dialects:
 *   1. OpenAI Standard -> choices[0].message.content
 *   2. Google Gemini   -> candidates[0].content.parts[].text
 *
 * Encoding: content is always coerced to a UTF-8 string so Bengali text
 * cannot be split mid-character.
 * ============================================================
 */
// ─── Universal Tool-Call Adapter — "external tools/tool.js" ─────────────
// SIX official dialects → ONE OpenAI tool_calls shape:
//   Groq/OpenAI chat [1] · Ollama [4] · Gemini [3] · OpenAI/Groq
//   Responses [2][5] · llama.cpp text-fallback [6] · Anthropic [7] ·
//   Bedrock [8]  (doc links inside tool.js)
// Load failure → no-op adapter: chat keeps working, tool parsing degrades.
let TOOLADAPTER;
try {
  TOOLADAPTER = require("./external tools/tool.js");
} catch (e) {
  TOOLADAPTER = {
    parseToolCalls: () => [],
    normalizeChatToolCalls: (t) => t,
    toProviderTools: (t) => t,
    toProviderMessages: (m) => m,
    extractTextToolCalls: () => [],
    extractText: () => "",
    detectApi: () => "unknown",
  };
  console.warn("[TOOL_ADAPTER_LOAD_FAIL] " + e.message);
}

function normalizeResponse(raw, modelHint) {
  // Empty/null input -> error response
  if (!raw) {
    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: maskModelName(modelHint || "unknown"),
      provider: "ZombieCoder",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "error",
        },
      ],
      usage: {},
      normalized: true,
      error: true,
    };
  }

  // UTF-8 encoding fix: handle raw if wrapped in Buffer or Object
  // Ensure string conversion to prevent Bengali/emoji character breakage
  if (raw.type === "Buffer") {
    raw = Buffer.from(raw.data || raw).toString("utf8");
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (e) { }
    }
  }

  const id = raw.id || `chatcmpl-${Date.now()}`;
  const created = raw.created || Math.floor(Date.now() / 1000);
  const model = raw.model || modelHint || "unknown";
  const choice = raw.choices && raw.choices[0] ? raw.choices[0] : null;

  if (!choice) {
    // ─── UNIVERSAL TOOL-CALL ADAPTER PASS ──────────────────
    // Responses output[], Gemini functionCall parts, Anthropic tool_use,
    // Bedrock toolUse, Ollama native, Gemini-interactions steps, and
    // llama.cpp text-embedded calls — ALL → OpenAI tool_calls, HERE,
    // before any dialect branch. executeMcpTool loop (callModelWithTools)
    // then works for every provider unchanged.
    const autoToolCalls = TOOLADAPTER.parseToolCalls(raw);
    if (autoToolCalls.length) {
      return {
        id,
        object: "chat.completion",
        created,
        model: maskModelName(model),
        provider: "ZombieCoder",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: TOOLADAPTER.extractText(raw) || "",
              tool_calls: autoToolCalls,
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalFormat: TOOLADAPTER.detectApi(raw),
        toolCallsFrom: "universal-adapter",
      };
    }

    // ─── Google Gemini format ─────────────────────────────
    // Google Gemini format — only our provider formats, no external ones
    if (raw.candidates && raw.candidates[0]) {
      const c = raw.candidates[0];
      let content = "";
      if (c.content && c.content.parts) {
        content = c.content.parts
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .join("");
      }
      const role = (c.content && c.content.role) || "assistant";
      const finish = (c.finishReason && c.finishReason.toLowerCase()) || "stop";

      return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role, content }, finish_reason: finish },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "gemini",
        provider: "ZombieCoder",
      };
    }

    // ─── Anthropic format (Claude Messages API) ───────────
    if (raw.content && Array.isArray(raw.content) && raw.stop_reason) {
      const content = raw.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      const stop =
        typeof raw.stop_reason === "string"
          ? raw.stop_reason.toLowerCase()
          : "end_turn";
      return {
        id: raw.id || id,
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: {
              role: (raw.role || "assistant"),
              content,
              // Preserve anthropic tool_use blocks so agent loops can act
              tool_calls:
                (raw.content || []).filter((b) => b && b.type === "tool_use")
                  .length > 0
                  ? (raw.content || []).filter((b) => b && b.type === "tool_use")
                  : undefined,
            },
            finish_reason: stop === "end_turn" ? "stop" : stop,
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "anthropic",
        provider: "ZombieCoder",
      };
    }

    // ─── AWS Bedrock Converse format ──────────────────────
    if (raw.output && raw.output.message && raw.output.message.content) {
      const blocks = raw.output.message.content;
      const content = Array.isArray(blocks)
        ? blocks
            .filter((b) => b && (b.text !== undefined || typeof b === "string"))
            .map((b) => (typeof b === "string" ? b : b.text || ""))
            .join("")
        : "";
      const stop =
        typeof raw.stopReason === "string" ? raw.stopReason.toLowerCase() : "end_turn";
      return {
        id: raw.id || id,
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: stop === "end_turn" ? "stop" : stop,
          },
        ],
        usage: raw.usage || {},
        normalized: true,
        originalProvider: "aws-bedrock-converse",
        provider: "ZombieCoder",
      };
    }

    // ─── llama.cpp server format ─────────────────────────-
    // Plain string payload { content: "...", stop: true/false, n_predict }
    if (
      typeof raw.content === "string" &&
      raw.content.length > 0 &&
      (raw.stop !== undefined || raw.n_predict !== undefined)
    ) {
      return {
        id: id + "-llama",
        object: "chat.completion",
        created,
        model: raw.model || model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: raw.content },
            finish_reason: raw.stop === true ? "stop" : "length",
          },
        ],
        usage: raw.timings
          ? {
              prompt_tokens: raw.timings.prompt_n || 0,
              completion_tokens: raw.timings.predicted_n || 0,
              total_tokens:
                (raw.timings.prompt_n || 0) + (raw.timings.predicted_n || 0),
            }
          : {},
        normalized: true,
        originalProvider: "llama.cpp-server",
        provider: "ZombieCoder",
      };
    }

    // External/unknown format — won't recognize, returns error
    log("WARN", "HAQ_MAWLA_UNKNOWN_FORMAT", {
      model: model.slice(0, 30),
      keys: Object.keys(raw).slice(0, 8),
      type: typeof raw,
      hint: modelHint || "none",
    });

    return {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content:
              typeof raw === "string" ? raw : JSON.stringify(raw).slice(0, 500),
          },
          finish_reason: "stop",
        },
      ],
      usage: raw.usage || {},
      normalized: true,
      originalFormat: "unknown_external",
      provider: "ZombieCoder",
    };
  }

  // ─── OpenAI Standard Format (OpenCode, Groq) ────────────
  // Standard OpenAI format (from our OpenCode and Groq providers)
  const message = choice.message || {};
  let content = message.content || "";
  const reasoning = message.reasoning_content || message.reasoning || null;
  const role = message.role || "assistant";
  const finish = choice.finish_reason || "stop";
  // CRITICAL: Preserve tool_calls — was being stripped, which killed
  // the callModelWithTools execution loop!
  // + ADAPTER: ids guaranteed, object arguments (Ollama quirk [4]) →
  //   JSON strings (OpenAI canonical [1][5]) so JSON.parse never breaks.
  const toolCalls = TOOLADAPTER.normalizeChatToolCalls(message.tool_calls);

  // Use FULL reasoning as content when content is empty — no truncation
  // Phase 3 (consensus output) handles filtering of meta/reasoning artifacts
  let contentWasEmpty = false;
  if (!content && reasoning) {
    content =
      typeof reasoning === "string" ? reasoning : JSON.stringify(reasoning);
    contentWasEmpty = true;
  }

  // Null/undefined → empty string
  if (content === null || content === undefined) content = "";
  content = String(content);

  return {
    id,
    object: "chat.completion",
    created,
    model: maskModelName(model),
    provider: "ZombieCoder",
    choices: [
      {
        index: 0,
        message: {
          role,
          content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: raw.usage || {},
    normalized: true,
    meta: {
      contentWasEmpty,
      hasReasoning: !!reasoning,
      provider: "ZombieCoder",
      latency: raw._latency || 0,
      requestedModel: maskModelName(modelHint || null),
      rawFinish: finish,
    },
  };
}

// 
//  MODEL CALL (via Competition Router)
// 
// ─── #5 swap_notice — ethical model/provider swap visibility ──
// Every silent fallback (provider-hop or model-hop) is recorded on a
// per-request trail. Keyed by the SAME messages array that recursion
// reuses, so concurrent requests never cross-contaminate. The trail is
// surfaced in chat.completion responses as `swap_notice` (ethics §4:
// never pretend the fallback didn't happen).
const SWAP_TRAIL = new WeakMap();
function noteSwap(messages, from, to, kind) {
  if (!messages || typeof messages !== "object") return;
  try {
    const trail = SWAP_TRAIL.get(messages) || [];
    trail.push({
      from: String(from || "?"),
      to: String(to || "?"),
      kind, // "provider" | "model"
      at: new Date().toISOString(),
    });
    SWAP_TRAIL.set(messages, trail);
  } catch (_) { /* trail is best-effort */ }
}
function getSwapNotice(messages) {
  try {
    const trail = SWAP_TRAIL.get(messages);
    if (trail && trail.length > 0) {
      return { swapped: true, swaps: trail };
    }
  } catch (_) {}
  return null;
}

function callModelStream(
  model,
  messages,
  temperature,
  onChunk,
  tools,
  tool_choice,
  _retryCount,
  providerOverride,
) {
  return new Promise((resolve) => {
    model = normalizeRoutingModel(model);
    if (!model) {
      resolve({
        success: false,
        error: "No model available: no configured provider is serving a model yet.",
        errorCode: "no_model",
        model: "",
      });
      return;
    }
    // ─── Competition Router ────────────────────────────────
    // Use providerOverride if provided (fallback chain), otherwise
    // resolve through competition router (priority order).
    let providerId, config;
    if (providerOverride) {
      // Normalize: findNextProvider returns {providerId, config},
      // proxyChatCompletion flow passes {id, config}.
      providerId = providerOverride.providerId || providerOverride.id;
      config = providerOverride.config;
    } else {
      const resolved = resolveProvider(model);
      if (!resolved) {
        log("WARN", "STREAM_NO_PROVIDER", { model });
        resolve({
          ok: false,
          error: `Unknown model "${model}" — no configured provider serves it.`,
          errorCode: "model_not_found",
          model,
        });
        return;
      }
      ({ providerId, config } = resolved);
    }
    if (!config || !config.baseUrl) {
      log("WARN", "STREAM_NO_BASEURL", { model, providerId });
      resolve({
        ok: false,
        error: `Provider "${providerId}" is not configured (no base URL / API key).`,
        errorCode: "provider_not_configured",
        model,
      });
      return;
    }
    // ─── Capability gate — DB-driven (NO hardcoded model names) ──
    const resolvedApiModel = resolveApiModel(model, providerId);
    if (tools) {
      const budget = toolBudget.resolveToolBudget({
        providerId,
        tools,
        providerMax: toolBudget.providerMaxOf(config),
        timeoutMs: config.streamTimeout || resolveProviderTimeouts("", process.env).streamTimeout,
        intent: toolBudgetIntent(messages),
      });
      tools = toolRegister.prepare(providerId, resolvedApiModel, budget.tools, config);
      if (!providerOverride && !_retryCount) {
        logToolBudget(providerId, resolvedApiModel, budget, { stream: true });
      }
    }

    // ─── Provider call via the adapter layer ────────────────────
    // Headers, payloads and wire dialect per official docs live in provider/*;
    // chunks arrive normalized as OpenAI chat.completion.chunk. This function
    // owns only ROUTING POLICY: rate limits, fallback chain, empty-stream
    // retry — server concerns, never provider concerns.
    let fullContent = "";
    let reasoningFull = "";
    const accToolCalls = [];

    providerRegistry
      .chatStream(
        {
          config: Object.assign({}, config, { id: providerId }),
          providerId: providerId,
          model: model,
          apiModel: resolvedApiModel,
          messages: messages,
          temperature: temperature,
          tools: tools,
          tool_choice: tool_choice,
          max_tokens: config.maxTokens,
        },
        function (chunk) {
          const delta =
            (chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta) ||
            {};
          const deltaContent = delta.content || "";
          const reasoning = delta.reasoning_content || delta.reasoning || "";
          // Reasoning is a separate channel. Never copy it into content:
          // OpenAI-compatible clients (OpenCode included) render both fields,
          // so copying duplicates the chain of thought as the visible answer.
          if (reasoning) {
            reasoningFull +=
              typeof reasoning === "string" ? reasoning : JSON.stringify(reasoning);
          }
          if (deltaContent) fullContent += deltaContent;
          if (Array.isArray(delta.tool_calls)) {
            for (const tcf of delta.tool_calls) {
              const idx =
                typeof tcf.index === "number" ? tcf.index : accToolCalls.length;
              if (!accToolCalls[idx]) {
                accToolCalls[idx] = {
                  id: "",
                  type: "function",
                  function: { name: "", arguments: "" },
                };
              }
              if (tcf.id) accToolCalls[idx].id = tcf.id;
              if (tcf.function) {
                if (tcf.function.name) accToolCalls[idx].function.name = tcf.function.name;
                if (tcf.function.arguments)
                  accToolCalls[idx].function.arguments += tcf.function.arguments;
              }
            }
          }
          if (onChunk && (deltaContent || reasoning || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) {
            // Forward the provider delta unchanged. content stays answer-only;
            // reasoning_content/reasoning stays on its own channel.
            onChunk(delta, chunk);
          }
        },
      )
      .then(function (r) {
        const toolCalls = accToolCalls.filter(Boolean);
        // A reasoning-only model is a real answer, not an empty stream.
        const hasPayload = !!(fullContent || reasoningFull || toolCalls.length);
        const retry = _retryCount || 0;

        // Provider-hop first (<3 hops), then model-hop — same chain as before.
        const fallbackStream = function (errMsg) {
          // A malformed *request* can never succeed on retry — fail fast
          // instead of hot-looping the fallback chain. A malformed provider
          // *response* is the provider's problem, so the chain continues.
          if (/^boundary_reject request:/.test(errMsg || "")) return false;
          if (!providerOverride && retry < 3) {
            const nextProvider = findNextProvider(model, providerId);
            if (nextProvider) {
              log("WARN", "PROVIDER_FALLBACK", {
                from: providerId,
                to: nextProvider.providerId,
                error: errMsg,
              });
              noteSwap(messages, providerId, nextProvider.providerId, "provider");
              resolve(
                callModelStream(model, messages, temperature, onChunk, tools,
                  tool_choice, retry + 1, nextProvider),
              );
              return true;
            }
          }
          return false;
        };

        if (!r.ok) {
          const errMsg = r.error || "stream failed";
          if (r.rate_limited || r.statusCode === 429) {
            setRateLimited(providerId, model, errMsg);
            const nextProvider =
              !providerOverride && retry < 3
                ? findNextProvider(model, providerId)
                : null;
            if (nextProvider) {
              log("WARN", "PROVIDER_FALLBACK_RATE_LIMIT", {
                from: providerId,
                to: nextProvider.providerId,
                error: errMsg,
                cooldown: getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
              });
              noteSwap(messages, providerId, nextProvider.providerId, "provider");
              resolve(
                callModelStream(model, messages, temperature, onChunk, tools,
                  tool_choice, retry + 1, nextProvider),
              );
              return;
            }
            resolve({
              success: false,
              error: "" + getRateLimitStatus().message,
              rate_limited: true,
              model,
              provider: providerId,
            });
            return;
          }
          log(
            "WARN",
            r.stream_error ? "STREAM_ERROR_FALLBACK" : "PROVIDER_FALLBACK",
            { provider: providerId, error: errMsg },
          );
          if (fallbackStream(errMsg)) return;
          resolve({ success: false, error: errMsg, model, provider: providerId });
          return;
        }

        if (!hasPayload) {
          if (fallbackStream("empty stream response")) return;
          log("ERROR", "STREAM_EMPTY_FAILED", { model, provider: providerId });
          resolve({
            success: false,
            error: "empty stream response",
            empty: true,
            model,
            provider: providerId,
          });
          return;
        }

        resolve({
          success: true,
          // Aggregated callers still need text when the model only emitted
          // reasoning; the wire stream itself never duplicates the channel.
          content: fullContent || reasoningFull,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(reasoningFull ? { reasoning_content: reasoningFull } : {}),
          model,
          provider: providerId,
          upstream_provider: r.upstream || null,
        });
      })
      .catch(function (err) {
        const retry = _retryCount || 0;
        const nextProvider =
          !providerOverride && retry < 3
            ? findNextProvider(model, providerId)
            : null;
        if (nextProvider) {
          log("WARN", "PROVIDER_FALLBACK", {
            from: providerId,
            to: nextProvider.providerId,
            error: err.message,
          });
          noteSwap(messages, providerId, nextProvider.providerId, "provider");
          resolve(
            callModelStream(model, messages, temperature, onChunk, tools,
              tool_choice, retry + 1, nextProvider),
          );
          return;
        }
        resolve({
          success: false,
          error: err.message,
          model,
          provider: providerId,
        });
      });
  });
}

function callModel(
  model,
  messages,
  temperature,
  tools,
  tool_choice,
  _retryCount,
  providerOverride,
) {
  return new Promise((resolve) => {
    model = normalizeRoutingModel(model);
    if (!model) {
      resolve({
        success: false,
        content: "",
        error: "No model available: no configured provider is serving a model yet.",
        errorCode: "no_model",
        model: "",
      });
      return;
    }
    // ─── Competition Router ────────────────────────────────
    // Use providerOverride if provided, otherwise resolve through competition router
    let providerId, config;
    if (providerOverride) {
      // Normalize: findNextProvider returns {providerId, config},
      // proxyChatCompletion flow passes {id, config}.
      providerId = providerOverride.providerId || providerOverride.id;
      config = providerOverride.config;
    } else {
      const resolved = resolveProvider(model);
      if (!resolved) {
        // No configured provider serves this model. Say so instead of
        // silently answering from an unrelated one.
        log("WARN", "CALL_MODEL_NO_PROVIDER", { model });
        resolve({
          success: false,
          content: "",
          error:
            `Unknown model "${model}". No configured provider serves it. ` +
            `Check the model name, the provider's model list, or the agent's ` +
            `model mapping in Admin -> Agent Manager.`,
          errorCode: "model_not_found",
          model,
        });
        return;
      }
      ({ providerId, config } = resolved);
    }
    if (!config || !config.baseUrl) {
      log("WARN", "CALL_MODEL_NO_BASEURL", { model, providerId });
      resolve({
        success: false,
        content: "",
        error:
          `Provider "${providerId}" has no base URL configured — it may be ` +
          `disabled or missing an API key.`,
        errorCode: "provider_not_configured",
        model,
        provider: providerId,
      });
      return;
    }
    // DB -> env -> nothing. Nothing means a truthful failure here; the HTTP
    // routes turn provider_key_missing into a direct 404.
    const modelKeyState = providerKeyState(providerId, config);
    if (!modelKeyState.ok) {
      log("WARN", "CALL_MODEL_KEY_MISSING", { model, provider: providerId });
      resolve({
        success: false,
        content: "",
        error:
          `Provider "${providerId}" has no API key. Add it in Admin -> ` +
          `Providers (stored in DB) or set the provider key in .env.`,
        errorCode: "provider_key_missing",
        model,
        provider: providerId,
      });
      return;
    }
    config = Object.assign({}, config, { key: modelKeyState.key });
    const baseUrl = config.baseUrl;
    const apiKey = config.key;

    // RATE LIMIT PRE-CHECK: check if provider has hit rate limit
    // If limit is active, route directly to fallback provider
    if (isRateLimited(providerId, model) && !providerOverride) {
      const nextProvider = findNextProvider(model, providerId);
      if (nextProvider) {
        log("INFO", "RATE_LIMIT_BYPASS", {
          from: providerId,
          to: nextProvider.providerId,
          model,
          cooldown: getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
        });
        resolve(
          callModel(
            model,
            messages,
            temperature,
            tools,
            tool_choice,
            _retryCount,
            nextProvider,
          ),
        );
        return;
      }
      // All fallbacks exhausted -> clear message
      resolve({
        success: false,
        error: getRateLimitStatus().message,
        rate_limited: true,
        model,
        provider: providerId,
      });
      return;
    }

    // ─── Capability gate — DB-driven (NO hardcoded model names) ──
    const resolvedApiModel = resolveApiModel(model, providerId);
    if (tools) {
      const budget = toolBudget.resolveToolBudget({
        providerId,
        tools,
        providerMax: toolBudget.providerMaxOf(config),
        timeoutMs: config.timeout || resolveProviderTimeouts("", process.env).timeout,
        intent: toolBudgetIntent(messages),
      });
      tools = toolRegister.prepare(providerId, resolvedApiModel, budget.tools, config);
      if (!providerOverride && !_retryCount) {
        logToolBudget(providerId, resolvedApiModel, budget);
      }
    }

    // ─── Provider call via the adapter layer ────────────────────
    // Headers, payloads and wire dialect per official docs live in provider/*;
    // the response arrives normalized as OpenAI chat.completion (normalizer/).
    // This function owns only ROUTING POLICY: rate limits, fallback chain,
    // empty-response retry — server concerns, never provider concerns.
    providerRegistry
      .chat({
        config: Object.assign({}, config, { id: providerId }),
        providerId: providerId,
        model: model,
        apiModel: resolvedApiModel,
        messages: messages,
        temperature: temperature,
        tools: tools,
        tool_choice: tool_choice,
        max_tokens: config.maxTokens,
      })
      .then(function (r) {
        const retry = _retryCount || 0;

        if (r.rate_limited || r.statusCode === 429) {
          const errMsg = r.error || "rate limited";
          setRateLimited(providerId, model, errMsg);
          const nextProvider = providerOverride
            ? null
            : findNextProvider(model, providerId);
          if (nextProvider) {
            log("WARN", "PROVIDER_FALLBACK_RATE_LIMIT", {
              from: providerId,
              to: nextProvider.providerId,
              error: errMsg,
              cooldown: getRateLimitState(DETECTED_DOMAIN).cooldownMs + "ms",
            });
            noteSwap(messages, providerId, nextProvider.providerId, "provider");
            resolve(
              callModel(model, messages, temperature, tools, tool_choice,
                retry, nextProvider),
            );
            return;
          }
          resolve({
            success: false,
            error: "" + getRateLimitStatus().message,
            rate_limited: true,
            model,
            provider: providerId,
          });
          return;
        }

        if (!r.ok) {
          const errMsg =
            r.error ||
            "provider error" + (r.statusCode ? " (HTTP " + r.statusCode + ")" : "");
          // Deterministic request-format rejection — never retriable.
          // Fail fast (do NOT mark the provider failed for a client-side
          // format error, and do NOT run the fallback chain). A rejected
          // *response* means this provider answered with the wrong shape:
          // that must fall through to the next provider, not kill the turn.
          if (/^boundary_reject request:/.test(errMsg)) {
            resolve({
              success: false,
              error: errMsg,
              raw: r.raw,
              boundary: r.boundary,
              model,
              provider: providerId,
            });
            return;
          }
          const failureReason =
            (r.statusCode ? "http_" + r.statusCode + ": " : "network_error: ") + errMsg;
          if (isModelScopedProviderError(r.statusCode, errMsg)) {
            // The provider is alive; it just does not serve THIS model (e.g. a
            // retired Gemini id). Do not trip the provider-wide breaker and
            // strand every other model the provider still serves.
            log("WARN", "PROVIDER_MODEL_SCOPED_FAILURE", {
              provider: providerId,
              model,
              status: r.statusCode || null,
              error: String(errMsg).slice(0, 200),
            });
          } else {
            markProviderFailure(providerId, failureReason);
          }
          const nextProvider = findNextProvider(model, providerId);
          if (nextProvider) {
            log("WARN", "PROVIDER_FALLBACK", {
              from: providerId,
              to: nextProvider.providerId,
              error: errMsg,
              status: r.statusCode,
            });
            noteSwap(messages, providerId, nextProvider.providerId, "provider");
            resolve(
              callModel(model, messages, temperature, tools, tool_choice,
                retry, nextProvider),
            );
            return;
          }
          resolve({
            success: false,
            error: errMsg,
            raw: r.raw,
            model,
            provider: providerId,
          });
          return;
        }

        const normalized = r.normalized || null;
        const message =
          (normalized &&
            normalized.choices &&
            normalized.choices[0] &&
            normalized.choices[0].message) ||
          {};
        const content = r.content || message.content || "";
        const toolCalls = r.tool_calls || message.tool_calls || null;
        const reasoningContent =
          r.reasoning_content || message.reasoning_content || null;
        // Reasoning-only models (DeepSeek R1, gpt-oss, ...) are a real
        // response. Keep the reasoning channel intact and only fall back to
        // it as the aggregate answer when the provider sent no content.
        const reasoningText = typeof reasoningContent === "string"
          ? reasoningContent
          : (reasoningContent ? JSON.stringify(reasoningContent) : "");

        // Empty content → retry WITHOUT tools (too many tools is cause #1)
        if (!content && !reasoningText && !toolCalls && tools && retry < 1) {
          log("WARN", "EMPTY_CONTENT_RETRY", {
            model,
            retry: retry + 1,
            hadTools: true,
          });
          resolve(
            callModel(model, messages, temperature, undefined, undefined, retry + 1),
          );
          return;
        }

        // A 200 whose body no normalizer dialect can convert is a provider
        // failure, not a successful empty reply. Mark it, fail over, and when
        // no provider is left, say exactly what came back.
        const shapeError = !!(
          normalized && normalized.error === "unrecognised_response_shape"
        );
        if (shapeError || (!content && !reasoningText && !toolCalls)) {
          const reason = shapeError ? "unrecognised_response_shape" : "empty_response";
          const detail = (normalized && normalized.error_message) || "";
          markProviderFailure(providerId, reason + (detail ? ": " + detail : ""));
          const nextProvider = retry < 3 ? findNextProvider(model, providerId) : null;
          if (nextProvider) {
            log("WARN", "PROVIDER_FALLBACK_RESPONSE", {
              from: providerId,
              to: nextProvider.providerId,
              reason,
              error: detail || undefined,
            });
            resolve(
              callModel(model, messages, temperature, tools, tool_choice,
                retry + 1, nextProvider),
            );
            return;
          }
          resolve({
            success: false,
            error:
              providerId + " returned HTTP " + (r.statusCode || 200) +
              (shapeError
                ? " with a response shape no normalizer dialect recognised"
                : " with an empty response") +
              (detail ? " (" + detail + ")" : ""),
            errorCode: reason,
            raw: r.raw,
            model,
            provider: providerId,
          });
          return;
        }

        if (content || reasoningText || toolCalls) markProviderSuccess(providerId);
        resolve({
          success: !!(content || reasoningText || toolCalls),
          content: content || reasoningText,
          tool_calls: toolCalls,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          raw: r.raw,
          normalized: normalized,
          model,
          provider: providerId,
          // P1-02: origin behind the transport (bridge → ollama), when the
          // provider reports one. Never guessed here.
          upstream_provider: r.upstream || null,
        });
      })
      .catch(function (err) {
        const retry = _retryCount || 0;
        markProviderFailure(providerId, "network_error: " + err.message);
        const nextProvider = findNextProvider(model, providerId);
        if (nextProvider) {
          log("WARN", "PROVIDER_FALLBACK", {
            from: providerId,
            to: nextProvider.providerId,
            error: err.message,
          });
          noteSwap(messages, providerId, nextProvider.providerId, "provider");
          resolve(
            callModel(model, messages, temperature, tools, tool_choice,
              retry, nextProvider),
          );
          return;
        }
        resolve({
          success: false,
          error: err.message,
          model,
          provider: providerId,
        });
      });
  });
}

// ─── Tool Execution Loop ──────────────────────────────────────
// Wraps callModel with automatic tool execution and result feeding.
// When the model returns tool_calls, this function executes them via
// executeMcpTool and feeds results back to the model iteratively.
async function callModelWithTools(
  model,
  messages,
  temperature,
  tools,
  tool_choice,
  providerOverride,
  toolContext,
) {
  const MAX_ROUNDS = 5;
  const budget = promptBudgetFor(model);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // Don't force tool_choice to "required" — OpenCode free models
    // (nemotron-3-ultra-free, mimo-v2.5-free, big-pickle) return 400 error
    // when tool_choice is "required". Let model decide ("auto" behavior).
    // User can still explicitly pass tool_choice if needed.
    const tc = tool_choice || undefined;
    const fitted = fitPrompt({
      messages,
      tools,
      maxTokens: budget,
      maxToolChars: MAX_TOOL_RESULT_CHARS,
    });
    messages = fitted.messages;
    tools = fitted.tools;
    if (fitted.trimmed) {
      log("INFO", "PROMPT_TRIMMED", {
        model,
        round,
        tokens: fitted.tokens,
        budget,
        messages: messages.length,
        tools: tools.length,
      });
    }
    log("INFO", "PROMPT_BUDGET", {
      model,
      round,
      tokens: fitted.tokens,
      budget,
      messages: messages.length,
      tools: tools.length,
      invisible: invisibleCharCount(
        JSON.stringify(messages) + JSON.stringify(tools),
      ),
    });
    const response = await callModel(
      model,
      messages,
      temperature,
      tools,
      tc,
      null,
      providerOverride,
    );
    if (!response.success) return response;
    let tcs = response.tool_calls;
    if ((!tcs || tcs.length === 0) && tools && tools.length && response.content) {
      // TOOL SANITIZER (last resort): custom providers / small local models
      // sometimes answer in plain text marker format instead of native
      // tool_calls. Extract real calls from the markers — extraction only,
      // never invention (allowlist = names actually sent in this request).
      try {
        const { extractToolCalls } = require("./tools/tool-sanitizer.js");
        const allow = tools
          .map((t) => (t && t.function && t.function.name) || (t && t.name))
          .filter(Boolean);
        const san = extractToolCalls(response.content, allow);
        if (san.tool_calls.length) {
          log("WARN", "SANITIZED_TOOL_CALLS", {
            model,
            dialect: san.dialect,
            count: san.tool_calls.length,
          });
          response.content = san.cleaned;
          response.tool_calls = san.tool_calls;
          response.sanitized = true;
          tcs = san.tool_calls;
        }
      } catch (sanErr) {
        log("WARN", "SANITIZER_ERROR", { error: sanErr.message });
      }
    }
    if (!tcs || tcs.length === 0) {
      log("INFO", "TOOL_LOOP_NO_TOOL_CALLS", {
        round,
        content_length: (response.content || "").length,
      });
      return response; // No more tools → done
    }

    // Append assistant tool_calls message
    // CRITICAL: preserve reasoning_content — DeepSeek thinking mode requires
    // it to be passed back in the next request or it rejects with
    // "The reasoning_content in the thinking mode must be passed back"
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: tcs,
      ...(response.reasoning_content
        ? { reasoning_content: response.reasoning_content }
        : {}),
    });
    // Execute each tool
    const discovered = [];
    for (const tc of tcs) {
      let result;
      try {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        result = await executeMcpTool(tc.function.name, args, toolContext);
      } catch (err) {
        result = {
          content: [{ type: "text", text: "Tool error: " + err.message }],
        };
      }
      const text = result.content?.[0]?.text || JSON.stringify(result);
      const capped = sizeBudget.capText(text, "TOOL_RESULT_MAX_BYTES");
      if (capped.truncated) {
        log("WARN", "BUDGET_EXCEEDED", {
          key: "TOOL_RESULT_MAX_BYTES",
          limit: capped.limit,
          actual: capped.bytes,
          tool: tc.function.name,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: capped.text,
      });
      if (tc.function.name === "tool_search") discovered.push(capped.text);
    }
    for (const text of discovered) {
      tools = expandToolsFromSearch(tools, "tool_search", text);
    }
  }
  // After max rounds, force a text-only response (no tools) instead of error
  log("WARN", "MAX_TOOL_ROUNDS_EXCEEDED", { max: MAX_ROUNDS, model });
  messages.push({
    role: "user",
    content:
      "IMPORTANT: You have used all available tool calls. Now provide your FINAL ANSWER based on the information you already have. Do NOT call any more tools. Just write your response directly.",
  });
  const forceResponse = await callModel(
    model,
    messages,
    temperature,
    undefined,
    undefined,
    null,
    providerOverride,
  );
  if (forceResponse.success && forceResponse.content) {
    return {
      success: true,
      content: forceResponse.content,
      tool_calls: null,
      model,
      provider: forceResponse.provider || null,
    };
  }
  return {
    success: false,
    error: "Max tool call rounds (" + MAX_ROUNDS + ") exceeded",
    content: "",
    model,
    provider: (forceResponse && forceResponse.provider) || null,
  };
}

// Streaming twin of callModelWithTools: streams answer text, executes every
// tool call server-side, and keeps looping until the model answers without
// asking for another tool. Tool-call deltas never reach the client because
// this server owns execution.
async function callModelStreamWithTools(
  model,
  messages,
  temperature,
  onChunk,
  tools,
  tool_choice,
  toolContext,
) {
  const MAX_ROUNDS = 5;
  const budget = promptBudgetFor(model);
  let content = "";
  let lastProvider = "";

  const forward = (delta, chunk) => {
    const d = Object.assign({}, delta);
    // Tool calls are internal on this path.
    delete d.tool_calls;
    delete d.function_call;
    if (typeof d.content === "string") {
      d.content = stripInvisible(d.content);
      content += d.content;
    }
    if (!d.content && !d.reasoning_content && !d.reasoning) return;
    if (onChunk) {
      const upstream = chunk && chunk.choices && chunk.choices[0];
      onChunk(d, {
        ...chunk,
        choices: [{ ...(upstream || { index: 0 }), finish_reason: null }],
      });
    }
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const fitted = fitPrompt({
      messages,
      tools,
      maxTokens: budget,
      maxToolChars: MAX_TOOL_RESULT_CHARS,
    });
    messages = fitted.messages;
    tools = fitted.tools;
    if (fitted.trimmed) {
      log("INFO", "PROMPT_TRIMMED", {
        model,
        round,
        tokens: fitted.tokens,
        budget,
        messages: messages.length,
        tools: tools.length,
        stream: true,
      });
    }
    log("INFO", "PROMPT_BUDGET", {
      model,
      round,
      tokens: fitted.tokens,
      budget,
      messages: messages.length,
      tools: tools.length,
      stream: true,
      invisible: invisibleCharCount(
        JSON.stringify(messages) + JSON.stringify(tools),
      ),
    });
    const result = await callModelStream(
      model,
      messages,
      temperature,
      forward,
      tools,
      tool_choice,
    );
    if (!result || !result.success) {
      return Object.assign({ content }, result || { success: false, error: "stream failed" });
    }
    lastProvider = result.provider || lastProvider;
    const tcs = Array.isArray(result.tool_calls) ? result.tool_calls : [];
    if (!tcs.length) {
      return {
        success: true,
        content: content || result.content || "",
        tool_calls: null,
        rounds: round + 1,
        model,
        provider: lastProvider,
      };
    }
    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: tcs,
      ...(result.reasoning_content ? { reasoning_content: result.reasoning_content } : {}),
    });
    const discovered = [];
    for (const tc of tcs) {
      let text = "";
      try {
        const args =
          typeof tc.function.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        const toolResult = await executeMcpTool(tc.function.name, args, toolContext);
        text = toolResult.content?.[0]?.text || JSON.stringify(toolResult);
      } catch (err) {
        text = "Tool error: " + err.message;
      }
      const capped = sizeBudget.capText(text, "TOOL_RESULT_MAX_BYTES");
      if (capped.truncated) {
        log("WARN", "BUDGET_EXCEEDED", {
          key: "TOOL_RESULT_MAX_BYTES",
          limit: capped.limit,
          actual: capped.bytes,
          tool: tc.function.name,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: capped.text,
      });
      if (tc.function.name === "tool_search") discovered.push(capped.text);
    }
    for (const text of discovered) {
      tools = expandToolsFromSearch(tools, "tool_search", text);
    }
    log("INFO", "STREAM_TOOL_ROUND", {
      model,
      round: round + 1,
      calls: tcs.length,
      names: tcs.map((t) => t.function && t.function.name).filter(Boolean),
    });
  }

  // Tool budget exhausted: ask for the final answer with no tools.
  messages.push({
    role: "user",
    content:
      "You have used all available tool calls. Provide the FINAL ANSWER now using the results above. Do not call any more tools.",
  });
  const finalFit = fitPrompt({
    messages,
    tools: [],
    maxTokens: budget,
    maxToolChars: MAX_TOOL_RESULT_CHARS,
  });
  const final = await callModelStream(
    model,
    finalFit.messages,
    temperature,
    forward,
    undefined,
    undefined,
  );
  return {
    success: !!(final && final.success),
    content: content || (final && final.content) || "",
    tool_calls: null,
    rounds: MAX_ROUNDS + 1,
    model,
    provider: (final && final.provider) || lastProvider,
    upstream_provider: (final && final.upstream_provider) || null,
    error: final && final.error,
  };
}

// 
//  PROXY MODE — Direct model call via Competition Router
// 
// When client calls with masked model name (e.g. "model-pro", "llama-70b", "gemini-flash")
// competition router → resolveProvider → resolveApiModel (unmask) → provider API → normalize

function finishProxyStream(res, opts) {
  const o = opts || {};
  const chunk = (delta, finish) =>
    "data: " +
    JSON.stringify({
      id: o.id,
      object: "chat.completion.chunk",
      created: o.created,
      model: o.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n";
  if (!o.started) {
    o.id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
    o.created = Math.floor(Date.now() / 1000);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": getCorsOrigin(o.origin),
    });
    res.write(chunk({ role: "assistant" }, null));
  }
  const calls = Array.isArray(o.calls) ? o.calls : [];
  const delta = calls.length && !o.callsStreamed ? { tool_calls: calls } : {};
  res.write(chunk(delta, calls.length ? "tool_calls" : "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

async function proxyChatCompletion(
  model,
  messages,
  stream,
  temperature,
  tools,
  providerOverride,
  onChunk,
  toolChoice,
) {
  if (stream) {
    // Signature: (model, messages, temperature, onChunk, tools,
    //             tool_choice, _retryCount, providerOverride)
    return callModelStream(
      model,
      messages,
      temperature,
      onChunk || null,
      tools,
      toolChoice,
      undefined,
      providerOverride,
    );
  }
  return callModel(
    model,
    messages,
    temperature,
    tools,
    toolChoice,
    null,
    providerOverride,
  );
}

// 
//  EXECUTION ENGINE
// 

// ─── Input Pattern Recognition Engine ──────────────────────
// Intelligent classification of user input type
// Prevents wasting agents on simple greetings
function classifyInput(input) {
  const cleaned = (input || "").trim().toLowerCase();
  const result = {
    type: "task", // greeting | simple_qa | project_task | code_change | debug_request | general
    complexity: "simple", // simple | moderate | complex
    requires_code: false,
    requires_testing: false,
    requires_project_scan: false,
    requires_web_search: false,
    recommended_agents: [],
    reason: "",
  };

  // ─── GREETING DETECTION ───
  const greetingPatterns = [
    /^(hi|hello|hey|\u09b9\u09be\u0987|\u09b9\u09cd\u09af\u09be\u09b2\u09cb|\u0993\u09b9\u09c7|salam|\u09b8\u09be\u09b2\u09be\u09ae)(\s|$|[.!?,])/i,
    /^(good\s*(morn(ing)?|afternoon|evening|night))/i,
    /^(kmon\s*aco|ki\s*obostha|\u0995\u09c7\u09ae\u09a8\s*\u0986\u099b[\u09cb]?|\u0995\u09bf\s*\u0985\u09ac\u09b8\u09cd\u09a5\u09be)/i,
    /^(\u0995\u09c7\s*\u09a4\u09c1\u09ae\u09bf|name\s*$|what\s*is\s*your\s*name|\u09a4\u09cb\u09ae\u09be\u09b0\s*\u09a8\u09be\u09ae\s*\u0995\u09bf)/i,
    /^(\u09a7\u09a8\u09cd\u09af\u09ac\u09be\u09a6|thanks|thank you|dhonnobad)(\s|$|[.!?,])/i,
  ];

  for (const p of greetingPatterns) {
    if (p.test(cleaned)) {
      result.type = "greeting";
      result.complexity = "simple";
      result.recommended_agents = ["code-guru"]; // Only 1 agent needed
      result.reason = "greeting_detected";
      return result;
    }
  }

  // ─── SIMPLE Q&A DETECTION ───
  const simpleQaPatterns = [
    /^\d+\s*[+\-*\/]\s*\d+/,
    /^(yes|no|ok|\u09a0\u09bf\u0995\s*\u0986\u099b\u09c7|\u09b9\u09cd\u09af\u09be\u0981|\u09a8\u09be)\s*$/i,
    /^(what\s*(is|are)\s+\w+\s*\w*\.?\s*\?*$)/i,
    /^(\u0995\u09c7\s+|\u0995\u09bf\s+|\u0995\u09cb\u09a5\u09be\u09af\u09bc\s+|\u0995\u0996\u09a8\s+|\u0995\u09c7\u09a8\s+)/i,
    /^(how\s+(many|much|far|long|old)\s+\w+\s*\?*$)/i,
    /^(\u09ac\u09be\u0982\u09b2\u09be\u09a6\u09c7\u09b6\u09c7\u09b0\s+(\u09b0\u09be\u099c\u09a7\u09be\u09a8\u09c0|\u09ae\u09c1\u09a6\u09cd\u09b0\u09be|\u09a7\u09b0\u09cd\u09ae|\u09ad\u09be\u09b7\u09be))/i,
    /capital\s+of\s+\w+/i,
  ];

  for (const p of simpleQaPatterns) {
    if (p.test(cleaned)) {
      result.type = "simple_qa";
      result.complexity = "simple";
      result.recommended_agents = ["code-guru", "qa-tyrant"]; // 2 agents enough
      result.reason = "simple_qa_detected";
      return result;
    }
  }

  // ─── WEB SEARCH NEED DETECTION ───
  // Detect queries that need real-time data (news, current events, factual lookups)
  const webSearchPatterns = [
    // Current events / news
    /latest|recent|today|this week|this month|this year|\u09b8\u09b0\u09cd\u09ac\u09b6\u09c7\u09b7|\u09b8\u09be\u09ae\u09cd\u09aa\u09cd\u09b0\u09a4\u09bf\u0995|\u0986\u099c|\u098f\u0987 \u09b8\u09aa\u09cd\u09a4\u09be\u09b9|\u098f\u0987 \u09ae\u09be\u09b8|\u098f\u0987 \u09ac\u099b\u09b0/i,
    /news|\u0996\u09ac\u09b0|\u09b8\u0982\u09ac\u09be\u09a6|heading|headlines/i,
    /what('s| is) (happening|going on|new)/i,
    // Factual lookups that may change
    /price|\u09a6\u09be\u09ae|cost|\u0996\u09b0\u099a|rate|exchange rate|\u09ac\u09bf\u09a8\u09bf\u09ae\u09af\u09bc \u09b9\u09be\u09b0/i,
    /population|\u099c\u09a8\u09b8\u0982\u0996\u09cd\u09af\u09be|GDP|economy|\u0985\u09b0\u09cd\u09a5\u09a8\u09c0\u09a4\u09bf/i,
    /weather|\u0986\u09ac\u09b9\u09be\u0993\u09af\u09bc\u09be|temperature|\u09a4\u09be\u09aa\u09ae\u09be\u09a4\u09cd\u09b0\u09be/i,
    // Technology updates
    /release|\u0986\u09aa\u09a1\u09c7\u099f|update.*version|new.*feature|changelog/i,
    /which\s+(company|platform|service)\s+( owns | runs | made)/i,
    // Questions about specific entities that may change
    /who\s+(is|was|are|were)\s+the\s+(current|new|president|ceo|pm|minister)/i,
    /\u0995\u09c7\s+(\u09b9\u09b2[\u09cb]?|\u0986\u099b\u09c7\u09a8?|\u099b\u09bf\u09b2\u09c7\u09a8?)\s+(\u09b0\u09be\u09b7\u09cd\u099f\u09cd\u09b0\u09aa\u09a4\u09bf|\u09aa\u09cd\u09b0\u09a7\u09be\u09a8\u09ae\u09a8\u09cd\u09a4\u09cd\u09b0\u09c0|\u09ae\u09a8\u09cd\u09a4\u09cd\u09b0\u09c0)/i,
    // Comparison that needs current data
    /best|top|\u09b8\u09c7\u09b0\u09be|\u09b6\u09c0\u09b0\u09cd\u09b7|compared?\s+to|\u09a4\u09c1\u09b2\u09a8\u09be/i,
  ];

  for (const p of webSearchPatterns) {
    if (p.test(cleaned)) {
      result.requires_web_search = true;
      break;
    }
  }

  // ─── PROJECT TASK DETECTION ───
  const projectPatterns = [
    /project|\u09aa\u09cd\u09b0\u099c\u09c7\u0995\u09cd\u099f|\u09aa\u09cd\u09b0\u0995\u09b2\u09cd\u09aa|\u0995\u09cb\u09a1|code|\u09ab\u09be\u0987\u09b2|file|directory|\u09a1\u09bf\u09b0\u09c7\u0995\u09cd\u099f\u09b0\u09bf/i,
    /analyze|analyse|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3|analysis/i,
    /technology|language|framework|tech\s+stack/i,
    /structure|architecture|\u0986\u09b0\u09cd\u0995\u09bf\u099f\u09c7\u0995\u099a\u09be\u09b0/i,
    /feature|feature|\u09ac\u09c8\u09b6\u09bf\u09b7\u09cd\u099f\u09cd\u09af/i,
  ];

  let projectScore = 0;
  for (const p of projectPatterns) {
    if (p.test(cleaned)) projectScore++;
  }

  if (
    projectScore >= 2 ||
    /^(analyze|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3|explain.*project|project.*(about|what))/.test(cleaned)
  ) {
    result.type = "project_task";
    result.complexity = "moderate";
    result.requires_code = true;
    result.requires_project_scan = true;
    result.recommended_agents = ["code-guru", "doc-king", "qa-tyrant"];
    result.reason = "project_task_detected";
    return result;
  }

  // ─── CODE CHANGE / DEBUG DETECTION ───
  const codeChangePatterns = [
    /fix|\u09a0\u09bf\u0995|solve|\u09b8\u09ae\u09be\u09a7\u09be\u09a8|bug|\u09ac\u09be\u0997|error|\u098f\u09b0\u09b0|\u09ad\u09c1\u09b2/i,
    /change|\u09aa\u09b0\u09bf\u09ac\u09b0\u09cd\u09a4\u09a8|add|\u09af\u09cb\u0997|remove|\u09ae\u09c1\u099b\u09c7|update|\u0986\u09aa\u09a1\u09c7\u099f/i,
    /implement|\u0987\u09ae\u09aa\u09cd\u09b2\u09bf\u09ae\u09c7\u09a8\u09cd\u099f|create|\u09a4\u09c8\u09b0\u09bf|build|\u09ac\u09be\u09a8\u09be\u0993/i,
    /function|\u09ab\u09be\u0982\u09b6\u09a8|method|\u09ae\u09c7\u09a5\u09a1|class|\u0995\u09cd\u09b2\u09be\u09b8|component/i,
    /api|endpoint|route|router/i,
    /database|db|\u09a1\u09be\u099f\u09be\u09ac\u09c7\u09b8|\u09a1\u09bf\u09ac\u09bf/i,
    /crash|crashes|hangs|freeze|\u09b2\u09cd\u09af\u09be\u0997/i,
    /performance|\u09aa\u09be\u09b0\u09ab\u09b0\u09ae\u09cd\u09af\u09be\u09a8\u09cd\u09b8|speed|\u0997\u09a4\u09bf|slow|\u09a7\u09c0\u09b0/i,
    /security|\u09a8\u09bf\u09b0\u09be\u09aa\u09a4\u09cd\u09a4\u09be|secure|\u09b8\u09c1\u09b0\u0995\u09cd\u09b7\u09bf\u09a4|vulnerability/i,
    /test|\u099f\u09c7\u09b8\u09cd\u099f|unit|integration|\u09aa\u09b0\u09c0\u0995\u09cd\u09b7\u09be/i,
  ];

  let codeScore = 0;
  for (const p of codeChangePatterns) {
    if (p.test(cleaned)) codeScore++;
  }

  if (
    codeScore >= 2 ||
    cleaned.includes("write code") ||
    cleaned.includes("code \u09b2\u09bf\u0996")
  ) {
    result.type = "code_change";
    result.complexity = codeScore >= 4 ? "complex" : "moderate";
    result.requires_code = true;
    result.requires_testing = true;
    result.requires_project_scan = true;
    result.recommended_agents = selectRelevantAgents(cleaned);
    // Ensure qa-tyrant is included for code changes (testing required)
    if (!result.recommended_agents.includes("qa-tyrant")) {
      result.recommended_agents.push("qa-tyrant");
    }
    result.reason = "code_change_detected";
    return result;
  }

  // ─── DEBUG DETECTION ───
  if (
    cleaned.includes("bug") ||
    cleaned.includes("error") ||
    cleaned.includes("\u09ad\u09c1\u09b2") ||
    cleaned.includes("\u0995\u09be\u099c \u0995\u09b0\u099b\u09c7 \u09a8\u09be") ||
    cleaned.includes("not working") ||
    cleaned.includes("crash") ||
    cleaned.includes("broken")
  ) {
    result.type = "debug_request";
    result.complexity = "moderate";
    result.requires_code = true;
    result.requires_testing = true;
    result.requires_project_scan = true;
    result.recommended_agents = ["bug-hunter", "code-guru", "qa-tyrant"];
    result.reason = "debug_request_detected";
    return result;
  }

  // ─── DEFAULT: MODERATE TASK ───
  if (cleaned.length > 50) {
    result.type = "task";
    result.complexity = "complex";
    result.recommended_agents = AGENTS.map((a) => a.id); // All agents
    result.reason = "complex_task_default";
  } else {
    result.type = "simple_qa";
    result.complexity = "simple";
    result.recommended_agents = ["code-guru", "qa-tyrant"];
    result.reason = "short_input_default";
  }

  return result;
}

// ─── Smart Agent Router ─────────────────────────────────────
// Selects relevant agents based on the detected task type
function selectRelevantAgents(input) {
  const cleaned = input.toLowerCase();
  const selected = new Set();

  // Always include architecture
  selected.add("code-guru");

  // Bug/Error patterns → bug-hunter
  if (/\b(bug|error|fix|crash|broken|fail|issue|\u09ad\u09c1\u09b2|\u09a4\u09cd\u09b0\u09c1\u099f\u09bf)\b/i.test(cleaned))
    selected.add("bug-hunter");

  // Security patterns → security-hero
  if (
    /\b(security|secure|auth|vulnerability|hack|password|encrypt|\u09a8\u09bf\u09b0\u09be\u09aa\u09a4\u09cd\u09a4\u09be|\u09b8\u09c1\u09b0\u0995\u09cd\u09b7\u09be)\b/i.test(
      cleaned,
    )
  )
    selected.add("security-hero");

  // Performance patterns → perf-wizard
  if (
    /\b(performance|speed|slow|fast|optimize|memory|load|\u09aa\u09be\u09b0\u09ab\u09b0\u09ae\u09cd\u09af\u09be\u09a8\u09cd\u09b8|\u0997\u09a4\u09bf)\b/i.test(
      cleaned,
    )
  )
    selected.add("perf-wizard");

  // Documentation patterns → doc-king
  if (
    /\b(doc|readme|documentation|api\s*ref|guide|manual|\u09a1\u0995|\u09a1\u0995\u09c1\u09ae\u09c7\u09a8\u09cd\u099f\u09c7\u09b6\u09a8)\b/i.test(
      cleaned,
    )
  )
    selected.add("doc-king");

  // Quality/Test patterns → qa-tyrant
  if (
    /\b(test|qa|quality|verify|check|assure|\u099f\u09c7\u09b8\u09cd\u099f|\u09aa\u09b0\u09c0\u0995\u09cd\u09b7\u09be|\u0997\u09c1\u09a3\u0997\u09a4)\b/i.test(
      cleaned,
    )
  )
    selected.add("qa-tyrant");

  // If only code-guru selected (no specific pattern), add qa-tyrant for balance
  if (selected.size === 1) selected.add("qa-tyrant");

  // Convert to array, keep priority order
  return AGENTS.filter((a) => selected.has(a.id)).map((a) => a.id);
}
// Phase 1: Parallel Agent Responses with staggered thinking display
async function phase1_initialResponse(
  agents,
  userInput,
  context,
  sessionId,
  onProgress,
  classification,
  tools, // All agents share the same tools
) {
  // Default classification if not provided (backward compatibility)
  if (!classification) {
    classification = {
      requires_code: false,
      requires_testing: false,
      requires_project_scan: false,
    };
  }
  log("INFO", "PHASE1_START", {
    agents: agents.length,
    session: sessionId ? sessionId.slice(0, 8) : "none",
  });
  await pushLog(
    "phase",
    "\u09ae\u09bf\u09b6\u09a8 \u09b6\u09c1\u09b0\u09c1 \u0995\u09b0\u09be \u09af\u09be\u0995 — " + agents.length + " \u099c\u09a8 \u098f\u099c\u09c7\u09a8\u09cd\u099f \u0995\u09be\u099c \u0995\u09b0\u099b\u09c7",
  );

  // Tracking state
  const completed = new Set();
  const resultsMap = new Map();
  const startTimes = {};

  // Start all agents with staggered delay to prevent API rate limits (429 errors)
  // Each agent waits index*250ms before starting — Agent 0=0ms, Agent 1=250ms, Agent 2=500ms, ...
  const agentPromises = agents.map(async (agent, index) => {
    if (index > 0) await new Promise((res) => setTimeout(res, index * 250));
    const startTime = Date.now();
    startTimes[agent.id] = startTime;
    await pushAgentStatus(agent.id, "working");
    if (onProgress) onProgress("agent-working", agent.id, "");
    log("INFO", "AGENT_WORKING", {
      agent: agent.id,
      name: agent.name,
      session: sessionId ? sessionId.slice(0, 8) : "none",
    });

    const sysMsg = {
      role: "system",
      content: buildAgentSystemPrompt(agent, {
        mode: "mission",
        sessionId,
        userInput,
        involvesCode:
          classification.requires_code || classification.requires_testing,
        mission: true,
        toolsCount: Array.isArray(tools) ? tools.length : 0,
      }),
    };
    const usrMsg = {
      role: "user",
      content: userInput + (context ? "\n\nContext:\n" + context : ""),
    };

    let response = await callModelWithTools(
      usableAgentModel(agent),
      [sysMsg, usrMsg],
      undefined,
      tools,
      undefined,
      undefined,
      {
        workingDir: getEffectiveDir(sessionId),
        contained: Boolean(sessionId && sessionDirs.has(sessionId)),
      },
    );
    response = await autoWebSearch(agent, response, userInput, context);

    completed.add(agent.id);
    const snippet = stripEmoji(
      (response.content || "").replace(/\n+/g, " ").slice(0, 100),
    ).trim();
    if (onProgress) onProgress("agent-done", agent.id, snippet || "done");

    log("INFO", "AGENT_RESPONSE", {
      agent: agent.id,
      name: agent.name,
      role: agent.role,
      success: response.success,
      error: response.error || null,
      contentLength: (response.content || "").length,
      webSearch: response.webSearchUsed || false,
      elapsed: Date.now() - startTime,
    });

    if (sessionId) {
      saveAgentMemory(sessionId, agent.id, "user", userInput);
      saveAgentMemory(sessionId, agent.id, "assistant", response.content || "");
    }

    return { agent, response };
  });

  // 5-second thinking rotation — shows which agents are still working
  let rotateIdx = 0;
  const rotationInterval = setInterval(() => {
    const stillWorking = agents.filter((a) => !completed.has(a.id));
    if (stillWorking.length > 0) {
      const agent = stillWorking[rotateIdx % stillWorking.length];
      rotateIdx++;
      if (onProgress) onProgress("thinking", agent.id, "");
    }
  }, 5000);

  const settled = await Promise.allSettled(agentPromises);
  clearInterval(rotationInterval);

  // Collect results
  const results = [];
  for (let i = 0; i < agents.length; i++) {
    const settledResult = settled[i];
    if (settledResult.status === "fulfilled") {
      results.push(settledResult.value);
    } else {
      log("WARN", "AGENT_FAILED", {
        agent: agents[i].id,
        error: settledResult.reason?.message,
      });
      results.push({
        agent: agents[i],
        response: { success: false, content: "" },
      });
    }
  }

  return results;
}

// Phase 2: Parallel Intent Extraction + Cross-Verification + Debate
// User vision: Agents start working as soon as input received, each according to their role
// -> Other agents can debate during cross-checking of output
// -> Final cross-checked response is produced as output
async function phase2_intentCrossVerify(
  results,
  userInput,
  simpleMode,
  onProgress,
  tools,
) {
  log("INFO", "PHASE2_START", { simpleMode });

  if (simpleMode) {
    if (onProgress)
      onProgress(
        "phase-skip",
        "verification",
        "Simple question — verification skipped",
      );
    const alignmentResults = results.map((r) => ({
      ...r,
      alignment: { aligned: true, score: 100, issues: [] },
      proof: {
        has_proof: true,
        proof_score: 100,
        verdict: "PASS",
        missing_evidence: [],
      },
      debates: [],
    }));
    return {
      verified: true,
      results: alignmentResults,
      challenges: [],
      debates: [],
      rounds: 1,
    };
  }

  // Step 1: Extract intent (lightweight, sets context for checks)
  let intent = {
    primary_intent: userInput,
    context: "",
    requires_web_search: false,
    language: "bn",
    complexity: "moderate",
  };
  try {
    const intentResult = await callModel(pickUtilityModel(), [
      { role: "system", content: INTENT_EXTRACT_PROMPT },
      { role: "user", content: userInput },
    ]);
    if (intentResult.success) intent = JSON.parse(intentResult.content);
  } catch (e) {
    log("WARN", "INTENT_EXTRACT_FAIL", { error: e.message });
  }
  log("INFO", "INTENT_EXTRACTED", { intent });

  if (onProgress) onProgress("phase2", "intent", "Extracting user intent...");

  // Step 2: PARALLEL Alignment checks (Promise.all — all agents simultaneously)
  if (onProgress)
    onProgress("phase2", "alignment", "Checking agent alignment...");
  const alignmentResults = await Promise.all(
    results.map(async (currentResult) => {
      if (!currentResult.response.success)
        return {
          ...currentResult,
          alignment: {
            aligned: false,
            score: 0,
            issues: ["Agent failed to respond"],
          },
        };

      if (onProgress)
        onProgress(
          "phase2",
          currentResult.agent.id,
          "Verifying " + stripEmoji(currentResult.agent.name) + "...",
        );

      const check = await callModel(pickUtilityModel(), [
        { role: "system", content: ALIGNMENT_CHECK_PROMPT },
        {
          role: "user",
          content:
            "Original Intent: " +
            intent.primary_intent +
            "\n\nAgent: " +
            currentResult.agent.name +
            " (" +
            currentResult.agent.role +
            ")" +
            "\n\nResponse:\n" +
            (currentResult.response.content || "").slice(0, 3000) +
            "\n\nCheck alignment and return JSON.",
        },
      ]);

      let alignment = { aligned: false, score: 0, issues: ["Parse failed"] };
      if (check.success) {
        try {
          alignment = JSON.parse(check.content);
        } catch (e) {
          alignment = {
            aligned: false,
            score: 0,
            issues: ["JSON parse failed"],
          };
        }
      }
      log("INFO", "ALIGNMENT_CHECK", {
        agent: currentResult.agent.id,
        score: alignment.score,
        aligned: alignment.aligned,
      });
      return { ...currentResult, alignment };
    }),
  );

  // Step 3: PARALLEL Proof checks — verify each response has actual evidence
  if (onProgress)
    onProgress("phase2", "proof", "Checking evidence in responses...");
  const proofResults = await Promise.all(
    alignmentResults.map(async (currentResult) => {
      if (!currentResult.response.success)
        return {
          ...currentResult,
          proof: {
            has_proof: false,
            proof_score: 0,
            missing_evidence: ["No response"],
            verdict: "FAIL",
          },
        };

      if (onProgress)
        onProgress(
          "phase2",
          "proof-" + currentResult.agent.id,
          "Checking evidence: " + stripEmoji(currentResult.agent.name) + "...",
        );

      const proofCheck = await callModel(pickUtilityModel(), [
        { role: "system", content: PROOF_CHECK_PROMPT },
        {
          role: "user",
          content:
            "Response to verify:\n" +
            (currentResult.response.content || "").slice(0, 3000) +
            "\n\nCheck if this response contains verifiable proof/evidence and return JSON.",
        },
      ]);

      let proof = {
        has_proof: false,
        proof_score: 0,
        missing_evidence: ["Proof check parse failed"],
        verdict: "FAIL",
      };
      if (proofCheck.success) {
        try {
          proof = JSON.parse(proofCheck.content);
        } catch (e) {
          proof = {
            has_proof: false,
            proof_score: 0,
            missing_evidence: ["JSON parse failed"],
            verdict: "FAIL",
          };
        }
      }
      log("INFO", "PROOF_CHECK", {
        agent: currentResult.agent.id,
        score: proof.proof_score,
        verdict: proof.verdict,
      });
      return { ...currentResult, proof };
    }),
  );

  // Step 4: PARALLEL CROSS-CHECK DEBATE
  // Each agent reviews ALL other agents' responses (not their own)
  // Runs fully parallel via Promise.all
  if (onProgress)
    onProgress(
      "phase2",
      "debate",
      "Cross-check debate: agents reviewing each other...",
    );

  const debatedResults = await Promise.all(
    proofResults.map(async (currentResult) => {
      if (!currentResult.response.success) {
        return { ...currentResult, debates: [] };
      }

      // Collect other agents' responses for review
      const otherResponses = proofResults
        .filter(
          (r) => r.agent.id !== currentResult.agent.id && r.response.success,
        )
        .map((r) => ({
          agent: r.agent.id,
          name: r.agent.name,
          role: r.agent.role,
          content: (r.response.content || "").slice(0, 1500),
        }));

      if (otherResponses.length === 0) {
        return { ...currentResult, debates: [] };
      }

      try {
        const debateResult = await callModel(usableAgentModel(currentResult.agent), [
          {
            role: "system",
            content:
              currentResult.agent.persona +
              "\n\nYou are in a CROSS-CHECK DEBATE phase. Review the OTHER agents' responses below." +
              "\nProvide your expert critique from your unique perspective as " +
              currentResult.agent.role +
              ".\n\nReturn a JSON object:\n" +
              JSON.stringify({
                agreement: "agree|partial|disagree",
                reasoning: "Brief explanation from your perspective",
                corrections: ["List specific issues or corrections needed"],
                suggestions: ["Improvements or additional considerations"],
              }),
          },
          {
            role: "user",
            content:
              "User query: " +
              userInput +
              "\n\nYour response was:\n" +
              (currentResult.response.content || "").slice(0, 1000) +
              "\n\nOther agents' responses to review:\n" +
              otherResponses
                .map(
                  (r) =>
                    "\n--- " + r.name + " (" + r.role + ") ---\n" + r.content,
                )
                .join("\n") +
              "\n\nReview these other agents. Do you agree with them? Disagree? What did they miss? Return JSON.",
          },
        ]);

        let debates = [];
        if (debateResult.success) {
          try {
            debates = [JSON.parse(debateResult.content)];
          } catch (e) {
            debates = [
              {
                agreement: "partial",
                reasoning: "Debate parse failed",
                corrections: [],
                suggestions: [],
              },
            ];
          }
        }
        log("INFO", "DEBATE_RESULT", {
          agent: currentResult.agent.id,
          agreement: debates[0]?.agreement || "unknown",
        });
        return { ...currentResult, debates };
      } catch (e) {
        return { ...currentResult, debates: [] };
      }
    }),
  );

  // Step 4b: PARALLEL challenge — weak agents get a chance to respond to critique
  if (onProgress)
    onProgress("phase2", "challenge", "Resolving challenges in parallel...");

  const finalResults = await Promise.all(
    debatedResults.map(async (currentResult) => {
      const hasDebateIssues = currentResult.debates.some(
        (d) => d.agreement === "disagree",
      );
      const needsChallenge =
        (hasDebateIssues ||
          !currentResult.alignment.aligned ||
          currentResult.proof.verdict === "FAIL") &&
        currentResult.response.success;

      if (!needsChallenge) return currentResult;

      const issues = [];
      if (hasDebateIssues) {
        const disagreeDebates = currentResult.debates.filter(
          (d) => d.agreement === "disagree",
        );
        for (const d of disagreeDebates) {
          if (d.corrections) issues.push(...d.corrections);
        }
      }
      if (!currentResult.alignment.aligned)
        issues.push(...(currentResult.alignment.issues || []));
      if (currentResult.proof.verdict === "FAIL")
        issues.push(
          "PROOF FAILED: " +
          (currentResult.proof.missing_evidence || []).join("; "),
        );

      log("INFO", "CHALLENGE_START", {
        agent: currentResult.agent.id,
        issues: issues.length,
      });

      const challengePrompt =
        currentResult.agent.persona +
        "\n\nYour response received CHALLENGES from other agents." +
        "\n\nIssues raised:\n- " +
        issues.join("\n- ") +
        "\n\nYou MUST address each issue with SPECIFIC EVIDENCE." +
        "\nIf you cannot provide proof, say '\u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u09aa\u09cd\u09b0\u09ae\u09be\u09a3 \u09a8\u09c7\u0987'." +
        "\nCorrect yourself NOW with proper evidence, file references, or code line numbers.";

      try {
        const defense = await callModel(
          usableAgentModel(currentResult.agent),
          [
            {
              role: "system",
              content: challengePrompt,
            },
            {
              role: "user",
              content:
                "User input: " +
                userInput +
                "\n\nYour previous response:\n" +
                (currentResult.response.content || "").slice(0, 2000) +
                "\n\nProvide a corrected response addressing all challenges.",
            },
          ],
          undefined,
          tools,
        );

        if (defense.success) {
          currentResult.response.content = defense.content;
          // Brief re-check after defense
          const reProof = await callModel(pickUtilityModel(), [
            { role: "system", content: PROOF_CHECK_PROMPT },
            {
              role: "user",
              content:
                "Response to re-verify:\n" +
                (defense.content || "").slice(0, 3000) +
                "\n\nReturn JSON.",
            },
          ]);
          let reProofResult = { has_proof: false, verdict: "FAIL" };
          if (reProof.success) {
            try {
              reProofResult = JSON.parse(reProof.content);
            } catch (e) { }
          }
          currentResult.proof = reProofResult;
        }
      } catch (e) {
        log("WARN", "CHALLENGE_FAIL", {
          agent: currentResult.agent.id,
          error: e.message,
        });
      }

      return currentResult;
    }),
  );

  // Step 5: Final verification
  const allVerified = finalResults.every(
    (r) =>
      (!r.response.success || r.alignment.score > 50) &&
      (r.proof.verdict !== "FAIL" || !r.response.success),
  );
  log("INFO", "PHASE2_COMPLETE", {
    verified: allVerified,
    debates: finalResults.reduce((a, r) => a + (r.debates?.length || 0), 0),
    withProof: finalResults.filter(
      (r) => r.proof.verdict !== "FAIL" || !r.response.success,
    ).length,
    total: finalResults.length,
  });

  return {
    verified: allVerified,
    results: finalResults,
    challenges: finalResults.filter((r) => r.debates?.length > 0).length,
    debates: finalResults.flatMap((r) => r.debates || []),
    rounds: 1,
  };
}

// Phase 3: Combined Output
async function phase3_combinedOutput(
  agents,
  results,
  userInput,
  verification,
  onProgress,
  tools,
) {
  log("INFO", "PHASE3_START", {});

  if (onProgress)
    onProgress("phase3", "qa", "Combining all agent responses...");
  const qaAgent =
    agents.find((a) => a.role === "quality") || agents[agents.length - 1];
  const valid = results.filter((r) => r.response.success);
  if (valid.length === 0)
    return { success: false, combined: "No agents could respond." };

  // CROSS-VERIFICATION: QA-Tyrant does aggressive cross-checking
  // BEFORE producing the final output. Each agent's claims are verified.
  const crossCheckIssues = [];
  for (const r of valid) {
    const content = (r.response.content || "").toLowerCase();

    // 1. Check for unsupported claims — "it will work" without proof
    const unsupportedPatterns = [
      /it will work/i,
      /this should fix/i,
      /ette kaj korbe/,
      /it should work/i,
      /trust me/i,
      /bishshas kor/i,
      /definitely works/i,
      /nischitbhabe kaj korbe/i,
      // ── REAL BENGALI patterns ──
      /\u09a8\u09bf\u09b6\u09cd\u099a\u09bf\u09a4\u09ad\u09be\u09ac\u09c7 \u0995\u09be\u099c \u0995\u09b0\u09ac\u09c7/i,
      /\u098f\u099f\u09be \u0995\u09be\u099c \u0995\u09b0\u09ac\u09c7\u0987/i,
      /\u0995\u09be\u099c \u0995\u09b0\u09ac\u09c7 \u09ac\u09b2\u09c7 \u09ae\u09a8\u09c7 \u09b9\u099a\u09cd\u099b\u09c7/i,
      /\u0986\u09ae\u09bf \u09a8\u09bf\u09b6\u09cd\u099a\u09bf\u09a4/i,
      /\u09b8\u09ae\u09cd\u09ad\u09ac\u09a4 \u0995\u09be\u099c \u0995\u09b0\u09ac\u09c7/i,
      /\u098f\u0987\u09ad\u09be\u09ac\u09c7\u0987 \u09b9\u09ac\u09c7/i,
      /\u09a0\u09bf\u0995 \u0986\u099b\u09c7 \u098f\u0987\u09ad\u09be\u09ac\u09c7 \u0995\u09b0\u09cb/i,
      /\u09ac\u09bf\u09b6\u09cd\u09ac\u09be\u09b8 \u0995\u09b0/i,
      /\u09a8\u09bf\u09b6\u09cd\u099a\u09af\u09bc\u0987 \u0995\u09be\u099c \u0995\u09b0\u09ac\u09c7/i,
      /\u0995\u09cb\u09a8\u09cb \u09b8\u09ae\u09b8\u09cd\u09af\u09be \u09a8\u09be\u0987/i,
      /\u098f\u099f\u09be \u09b8\u09a0\u09bf\u0995/i,
    ];
    for (const pat of unsupportedPatterns) {
      if (pat.test(content)) {
        const snippet = content.match(pat)?.[0] || "unsupported claim";
        crossCheckIssues.push(
          `[${r.agent.name}] Unsupported claim detected: "${snippet}" - no test evidence provided!`,
        );
      }
    }

    // 2. Check for code claims without file references
    if (
      /\b(code|fix|implement|create|write|function|class|method|\u0995\u09cb\u09a1|\u09ab\u09bf\u0995\u09cd\u09b8|\u0987\u09ae\u09aa\u09cd\u09b2\u09bf\u09ae\u09c7\u09a8\u09cd\u099f)\b/i.test(
        content,
      )
    ) {
      const hasFileRef = /`[^`]+\.(js|py|ts|jsx|tsx|css|html|json|md)`/.test(
        content,
      );
      const hasPathRef = /(server\/|src\/|app\/|lib\/|components\/)/.test(
        content,
      );
      const hasLineRef = /\bline\s+\d+/i.test(content);
      if (!hasFileRef && !hasPathRef && !hasLineRef) {
        crossCheckIssues.push(
          `[${r.agent.name}] Code claim without file reference - cannot verify!`,
        );
      }
    }

    // 3. Check for missing test evidence in code-related claims
    if (
      /\b(fixed|solved|solved|completed|done|works|implemented)\b/i.test(
        content,
      )
    ) {
      const hasTestEvidence =
        /\b(test|tested|verified|confirmed|ran|executed|output|result)\b/i.test(
          content,
        );
      const hasUntested = /\b(UNTESTED|not tested|manual verification)\b/i.test(
        content,
      );
      if (!hasTestEvidence && !hasUntested) {
        crossCheckIssues.push(
          `[${r.agent.name}] Claims completion but NO test evidence provided - add UNTESTED disclaimer or test proof!`,
        );
      }
    }

    // 4. Check for hallucinated model/provider claims
    const modelProviderClaims = content.match(
      /\b(running on|powered by|using|via)\s+(gpt|claude|gemini|deepseek|llama|mistral)\b/gi,
    );
    if (modelProviderClaims) {
      crossCheckIssues.push(
        `[${r.agent.name}] Model identity leak detected: "${modelProviderClaims[0]}" - identities should be masked!`,
      );
    }
  }

  const reports = valid
    .map(
      (r) =>
        "=== " +
        r.agent.name +
        " ===\nRole: " +
        r.agent.role +
        "\nModel: " +
        r.agent.model +
        "\n\n" +
        (r.response.content || "").slice(0, 2000),
    )
    .join("\n\n");

  const challengeLog =
    verification.challenges > 0 ||
      (verification.debates && verification.debates.length > 0)
      ? "\\n\\nCross-Check Debate Log:\\n" +
      (verification.debates || [])
        .map(
          (d) =>
            "-> Agent critique: " +
            (d.agreement === "agree"
              ? "Agreed"
              : d.agreement === "partial"
                ? "Partial agreement"
                : "Disagreed") +
            (d.reasoning ? "\\n  Reason: " + d.reasoning : "") +
            (d.corrections && d.corrections.length > 0
              ? "\\n  Issues: " + d.corrections.join(", ")
              : ""),
        )
        .join("\\n")
      : "\\nNo debates needed.";

  // QA-TYRANT CROSS-CHECK LOG: Inject issues for QA agent
  const crossCheckLog =
    crossCheckIssues.length > 0
      ? "\\n\\nQA CROSS-CHECK ISSUES (REQUIRED ACTION):\\n" +
      crossCheckIssues.map((i) => "  [ISSUE] " + i).join("\\n") +
      "\\n\\nCRITICAL: You MUST address EVERY issue above in your final output. " +
      "If an agent made unsupported claims, mark them. If code lacks file references, note it. " +
      "Do NOT let unsupported claims pass through. Be the strict Quality Tyrant! " +
      "If you find any issues, REJECT the response and demand corrections. " +
      "The agents must provide SPECIFIC evidence: file paths, line numbers, test results, or '\u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b \u09aa\u09cd\u09b0\u09ae\u09be\u09a3 \u09a8\u09c7\u0987' if unsure."
      : "";

  // Check if this involves code (to enforce test-before-answer in QA)
  const involvesCode =
    /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
      userInput,
    );

  let qaExtraRules = "";
  if (involvesCode) {
    qaExtraRules =
      "\n\nCODE SAFETY ENFORCEMENT (strict):" +
      "\n1. If any agent claims a code 'fix' or 'solution' — verify they provided SPECIFIC file paths and line numbers." +
      "\n2. If any agent claims something 'works' — check if they provided test evidence. If not, mark as 'UNTESTED'." +
      "\n3. NEVER let an agent's unsupported claim pass through. If evidence is missing, note: 'No test evidence provided.'" +
      "\n4. If the user asked for code changes, explicitly state which files are safe to modify and which should remain unchanged." +
      "\n5. If agents disagree, highlight the disagreement — don't hide it.";
  }

  const finalResult = await callModel(
    qaAgent.model,
    [
      {
        role: "system",
        content:
          qaAgent.persona +
          "\n\nCRITICAL RULE: You MUST produce the FINAL ANSWER directly. Do NOT write your thinking process. Do NOT explain how you will combine. Just GIVE THE ANSWER." +
          "\n\nYou are the QA coordinator. The agents below have already analyzed the user's question. Your job is to:" +
          "\n1. Read ALL agent reports carefully." +
          "\n2. INDEPENDENTLY VERIFY each agent's claims — do NOT just pick the best answer." +
          "\n3. For EACH agent, check: Did they provide file paths? Line numbers? Test evidence? Or just opinions?" +
          "\n4. Mark UNVERIFIED claims: If an agent says 'this works' without test proof, label it 'UNVERIFIED'." +
          "\n5. If agents disagree, highlight both sides and let the user decide." +
          "\n6. Write the FINAL ANSWER in the SAME LANGUAGE as the user's question." +
          "\n7. Start your response DIRECTLY with the answer — no preamble, no 'I will now combine'." +
          "\n\nVERIFICATION REQUIREMENTS:" +
          "\n- Code claims: MUST have file path + line number + test evidence" +
          "\n- Architecture claims: MUST reference specific components" +
          "\n- Security claims: MUST cite OWASP/CVE or specific vulnerability details" +
          "\n- Any claim without evidence  mark as [UNVERIFIED]" +
          "\n\nFORBIDDEN phrases (do NOT start with these):" +
          "\n- 'I will combine' / 'Let me merge' / '\u0986\u09ae\u09bf \u098f\u0996\u09a8 \u098f\u0995\u09a4\u09cd\u09b0\u09bf\u09a4 \u0995\u09b0\u09ac'" +
          "\n- 'Based on the analysis' / 'After reviewing'" +
          "\n- 'The combined response' / 'Here is the merged output'" +
          "\n\nREQUIRED: Start with the ACTUAL ANSWER to the user's question." +
          (tools && tools.length > 0
            ? "\n\nYou have tools available. Use them if needed to verify claims."
            : "") +
          qaExtraRules,
      },
      {
        role: "user",
        content:
          "User input:\n" +
          userInput +
          "\n\nAll agents:\n" +
          reports +
          challengeLog +
          crossCheckLog +
          "\n\nWrite the FINAL ANSWER to the user's question. Start with the answer directly." +
          "\n\nREMEMBER: INDEPENDENTLY VERIFY each agent's claims. Do NOT just pick the best answer." +
          "\nCheck: Do they have file references? Test evidence? Or just opinions?" +
          (involvesCode
            ? "\n\nIMPORTANT: This involves code. Before finalizing, verify: Are the claims tested? Are the file references real? If unsure, state it clearly."
            : ""),
      },
    ],
    undefined,
    tools,
  );

  log("INFO", "PHASE3_COMPLETE", {
    combinedLength: (finalResult.content || "").length,
  });

  // ─── Strip meta-thinking from final output ───
  // Free models sometimes still output their reasoning process
  let finalContent = finalResult.success
    ? finalResult.content
    : "Combined output generation failed.";
  if (finalContent) {
    const metaPatterns = [
      // English thinking patterns
      /^(I need to|I will now|Let me|I should|I have to|I must|I can see|I notice|I think|I believe).{0,200}\n/gim,
      /^(Combining| merging|Merging|Analyzing|Checking|Verifying|Reviewing|Comparing|Evaluating).{0,200}\n/gim,
      /^(Based on the analysis|After reviewing|Looking at|Examining|The user asked|The user wants).{0,200}\n/gim,
      /^(Actually|However|Wait|Hmm|So basically|In other words|Let me explain).{0,200}\n/gim,
      // Bengali thinking patterns
      /^(\u0986\u09ae\u09bf \u098f\u0996\u09a8|\u098f\u0996\u09a8 \u0986\u09ae\u09bf|\u0986\u09ae\u09be\u0995\u09c7 \u098f\u0996\u09a8|\u09a6\u09c7\u0996\u09bf \u09a4\u09cb|\u09ac\u09b2\u09a4\u09c7 \u09b9\u09ac\u09c7|\u099a\u09c7\u0995 \u0995\u09b0\u09bf|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3|\u09aa\u09b0\u09c0\u0995\u09cd\u09b7\u09be \u0995\u09b0\u09bf).{0,200}\n/gim,
      /^(\u098f\u0995\u09a4\u09cd\u09b0\u09bf\u09a4|\u09ae\u09be\u09b0\u09cd\u099c|\u09b8\u0982\u09af\u09c1\u0995\u09cd\u09a4|\u09b8\u09ae\u09a8\u09cd\u09ac\u09af\u09bc).{0,200}\n/gim,
      // Agent report references (model describing what agents said)
      /^((?:Code Guru|Bug Hunter|Security|Performance|Doc King|QA Tyrant|\u09ae\u09a8\u09c1|\u099c\u09c1\u09af\u09bc\u09c7\u09b2|\u09ac\u09c3\u09b7\u09cd\u099f\u09bf|\u09b0\u09be\u09b6\u09c7\u09a6|\u09b9\u09be\u09b2\u09bf\u09ae|\u09ae\u099c\u09a8\u09c1).{0,50}(started|gave|says|mentioned|noted|pointed out)).{0,200}\n/gim,
      // "Write the FINAL ANSWER" echo
      /^(Write the FINAL|FINAL ANSWER|The final answer).{0,200}\n/gim,
    ];
    for (const p of metaPatterns) {
      finalContent = finalContent.replace(p, "");
    }
    // Also strip inline thinking — "The user asked... which is Bengali for..."
    finalContent = finalContent.replace(
      /The user asked "[^"]*" which is Bengali for "[^"]*"\n\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /I need to check the (?:agents'|agent) reports\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /Let me (?:search|check|verify|look|read|see)[^.]*\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.replace(
      /Since the user is asking in Bengali, I should answer in Bengali\.?\s*\n?/g,
      "",
    );
    finalContent = finalContent.trim();
  }

  // ─── Apply identity masking + strip \uFFFD and invisible chars ───
  if (finalContent) {
    finalContent = maskModelIdentity(finalContent);
  }

  if (onProgress)
    onProgress(
      "phase3-done",
      "qa",
      "Mission complete — generating final output",
    );

  return {
    success: true,
    combined: finalContent || "Combined output generation failed.",
    agents: valid.map((r) => ({
      name: r.agent.name,
      role: r.agent.role,
      model: maskModelName(r.agent.model),
    })),
    verification: {
      verified: verification.verified,
      rounds: verification.rounds,
      challenges: verification.challenges,
      debates: (verification.debates || []).length,
    },
    stats: {
      totalAgents: agents.length,
      responded: valid.length,
      failed: results.filter((r) => !r.response.success).length,
    },
  };
}

const antiDoteMonitor = antiDoteModule.antiDoteMonitor;

// ─── Full Mission Execute ─────────────────────────────────────
async function executeMission(
  userInput,
  context,
  sessionId,
  onProgress,
  tools,
) {
  const startTime = Date.now();

  const inputSan = sanitizeForModel(String(userInput || ""));
  if (inputSan.total > 0) {
    log("INFO", "INPUT_SANITIZED", {
      source: "mission",
      removed: inputSan.total,
      chars: String(userInput || "").length,
      clean: inputSan.text.length,
    });
  }
  userInput = inputSan.text;

  // Safety: ensure AGENTS is not empty
  if (!AGENTS || AGENTS.length === 0) {
    log("WARN", "MISSION_NO_AGENTS", {});
    return {
      success: false,
      combined: "\u0995\u09cb\u09a8\u09cb \u098f\u099c\u09c7\u09a8\u09cd\u099f \u09b2\u09cb\u09a1 \u09b9\u09af\u09bc\u09a8\u09bf। agent/*.js \u09ab\u09be\u0987\u09b2 \u099a\u09c7\u0995 \u0995\u09b0\u09c1\u09a8।",
      agents: [],
      verification: { verified: false, rounds: 0, challenges: 0 },
      stats: { totalAgents: 0, responded: 0, failed: 1 },
      timing: { elapsed: Date.now() - startTime },
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      error: "No agents loaded — check agent/*.js",
    };
  }

  // ─── Step 0: Classify input → select relevant agents ──────
  const classification = classifyInput(userInput);
  const simpleMode =
    classification.type === "greeting" || classification.type === "simple_qa";

  // Tool delivery:
  //   simple greeting/QA → no tools at all;
  //   lazy mode (default) → tool_search + configured pins;
  //   MCP_TOOL_LAZY=0 → the full catalog.
  if (!tools || tools.length === 0) {
    if (simpleMode) {
      tools = [];
      log("INFO", "TOOL_LAZY_SKIPPED", {
        reason: "simple",
        classification: classification.type,
      });
    } else if (String(process.env.MCP_TOOL_LAZY || "1") !== "0") {
      tools = lazyToolCatalog();
      log("INFO", "TOOL_LAZY", {
        sent: tools.length,
        catalog: Object.keys(MCP_TOOLS).length,
        classification: classification.type,
      });
    } else {
      tools = mcpToolsToOpenAI();
    }
  }

  // Smart agent selection: not all agents for every task
  let missionAgents = AGENTS;
  if (
    classification.recommended_agents &&
    classification.recommended_agents.length > 0
  ) {
    missionAgents = AGENTS.filter((a) =>
      classification.recommended_agents.includes(a.id),
    );
    // Always keep at least 2 agents
    if (missionAgents.length < 2) missionAgents = AGENTS.slice(0, 2);
  }

  log("INFO", "MISSION_START", {
    session: sessionId ? sessionId.slice(0, 8) : "none",
    input: userInput.slice(0, 100),
    simpleMode,
    classification: classification.type,
    agents_selected: missionAgents.length,
    agents_total: AGENTS.length,
    reason: classification.reason,
  });

  // The mission prompt carries bounded context only. The full SSOT and
  // syllabus stay on disk; each agent's system prompt already carries an
  // input-relevant excerpt under a hard character budget.
  const ssotContent = readSSOT();
  let enrichedContext = context ? String(context).slice(0, 1800) : "";

  // Session history is NOT injected here. Old sessions live in SQLite and the
  // agents query them on demand through memory_recent / memory_search. A
  // missing, deleted or corrupt archive therefore cannot break a response.

  // ─── Auto Web Search: inject results before model call ────
  // Free models never write "web_search:" — so we detect need and search proactively
  if (classification.requires_web_search) {
    try {
      log("INFO", "AUTO_WEB_SEARCH", { query: userInput });
      if (onProgress)
        onProgress("web-search", "auto", "Searching for real-time data...");
      const searchResult = await webSearch(userInput);
      if (searchResult.success && searchResult.results.length > 0) {
        const searchText =
          "\n\n--- WEB SEARCH RESULTS (auto-injected) ---\n" +
          searchResult.results
            .map(
              (r, i) =>
                i +
                1 +
                ". " +
                (r.title || "Link") +
                "\n   " +
                (r.snippet || ""),
            )
            .join("\n") +
          "\n--- END SEARCH RESULTS ---\n";
        enrichedContext += searchText.slice(0, 2500);
        log("INFO", "AUTO_WEB_SEARCH_INJECTED", {
          results: searchResult.results.length,
        });
      }
    } catch (e) {
      log("WARN", "AUTO_WEB_SEARCH_FAIL", { error: e.message });
    }
  }

  // ─── Quick response for greetings (no need for all agents) ──
  if (classification.type === "greeting") {
    // Use the requested agent if available, otherwise code-guru
    const requestedAgentId =
      (typeof parsed !== "undefined" && parsed ? parsed.agent_id : null) ||
      (typeof sessionMeta !== "undefined" && sessionMeta
        ? sessionMeta.agent_id
        : null);
    const greetingAgent =
      (requestedAgentId && AGENTS.find((a) => a.id === requestedAgentId)) ||
      AGENTS.find((a) => a.id === agentsModule.defaultAgentId(AGENTS)) ||
      AGENTS[0];
    if (!greetingAgent) {
      return {
        success: false,
        combined: "\u0995\u09cb\u09a8\u09cb \u098f\u099c\u09c7\u09a8\u09cd\u099f \u09aa\u09be\u0993\u09af\u09bc\u09be \u09af\u09be\u09af\u09bc\u09a8\u09bf। agent/*.js \u099a\u09c7\u0995 \u0995\u09b0\u09c1\u09a8।",
        agents: [],
        verification: { verified: false, rounds: 0, challenges: 0 },
        stats: { totalAgents: 0, responded: 0, failed: 1 },
        timing: { elapsed: Date.now() - startTime },
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        error: "No agents loaded",
      };
    }
    const quickResponse = await callModel(greetingAgent.model, [
      {
        role: "system",
        content:
          buildAgentSystemPrompt(greetingAgent, { mode: "greeting" }) +
          "\n\nRespond very briefly and naturally in Bengali. No proof needed for greetings. Just be friendly and ask how to help.",
      },
      { role: "user", content: userInput },
    ]);

    const greetingContent = quickResponse.success
      ? maskModelIdentity(quickResponse.content)
      : "\u09b9\u09cd\u09af\u09be\u09b2\u09cb! \u0986\u09ae\u09bf " + greetingAgent.name + "। \u0995\u09c0\u09ad\u09be\u09ac\u09c7 \u09b8\u09be\u09b9\u09be\u09af\u09cd\u09af \u0995\u09b0\u09a4\u09c7 \u09aa\u09be\u09b0\u09bf?";

    const greetingOutput = {
      success: true,
      combined: greetingContent,
      agents: [
        {
          name: greetingAgent.name,
          role: greetingAgent.role,
          model: maskModelName(greetingAgent.model),
        },
      ],
      verification: { verified: true, rounds: 0, challenges: 0 },
      stats: { totalAgents: 1, responded: 1, failed: 0 },
      timing: { elapsed: Date.now() - startTime },
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      _greeting_mode: true,
    };

    log("INFO", "MISSION_COMPLETE", {
      elapsed: Date.now() - startTime,
      agents: 1,
      responded: 1,
      failed: 0,
      verified: true,
      mode: "greeting_skip",
    });

    return greetingOutput;
  }

  // ─── Quick mode for simple Q&A (one agent directly, skip pipeline) ──
  if (classification.type === "simple_qa" && simpleMode) {
    const qaAgentId = classification.recommended_agents?.[0] || agentsModule.defaultAgentId(AGENTS);
    const qaAgent = AGENTS.find((a) => a.id === qaAgentId) || AGENTS[0];
    if (qaAgent) {
      await pushLog("phase", "\u09b8\u09b0\u09be\u09b8\u09b0\u09bf \u0989\u09a4\u09cd\u09a4\u09b0 \u09a4\u09c8\u09b0\u09bf \u0995\u09b0\u099b\u09bf...");
      const quickResponse = await callModel(qaAgent.model, [
        {
          role: "system",
          content: buildAgentSystemPrompt(qaAgent, { mode: "simple_qa" }),
        },
        { role: "user", content: userInput },
      ]);

      const qaContent = quickResponse.success
        ? maskModelIdentity(quickResponse.content)
        : "\u0989\u09a4\u09cd\u09a4\u09b0 \u09a4\u09c8\u09b0\u09bf \u0995\u09b0\u09a4\u09c7 \u09b8\u09ae\u09b8\u09cd\u09af\u09be \u09b9\u09af\u09bc\u09c7\u099b\u09c7। \u0986\u09ac\u09be\u09b0 \u099a\u09c7\u09b7\u09cd\u099f\u09be \u0995\u09b0\u09c1\u09a8।";

      const qaOutput = {
        success: true,
        combined: qaContent,
        agents: [
          {
            name: qaAgent.name,
            role: qaAgent.role,
            model: maskModelName(qaAgent.model),
          },
        ],
        verification: { verified: true, rounds: 0, challenges: 0 },
        stats: { totalAgents: 1, responded: 1, failed: 0 },
        timing: { elapsed: Date.now() - startTime },
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        _simple_qa_mode: true,
      };

      log("INFO", "MISSION_COMPLETE", {
        elapsed: Date.now() - startTime,
        agents: 1,
        responded: 1,
        failed: 0,
        verified: true,
        mode: "simple_qa_skip",
      });

      await pushLog("phase", "\u0989\u09a4\u09cd\u09a4\u09b0 \u09aa\u09cd\u09b0\u09b8\u09cd\u09a4\u09c1\u09a4!");
      return qaOutput;
    }
  }

  // Fallback: if simpleMode but not simple_qa (or agent not found)
  if (simpleMode && missionAgents.length > 3) {
    missionAgents = missionAgents.slice(0, 3);
  }

  if (onProgress)
    onProgress(
      "mission-start",
      "mission",
      ssotContent
        ? "SSOT loaded — " +
        missionAgents.length +
        "/" +
        AGENTS.length +
        " agents selected (" +
        classification.type +
        ")"
        : "Starting mission with " +
        missionAgents.length +
        " agents" +
        (classification.type !== "task"
          ? " (mode: " + classification.type + ")"
          : ""),
    );

  if (AGENTS.length === 0)
    return { success: false, combined: "No agents available." };

  const phase1Results = await phase1_initialResponse(
    missionAgents,
    userInput,
    enrichedContext,
    sessionId,
    onProgress,
    classification,
    tools,
  );
  const verification = await phase2_intentCrossVerify(
    phase1Results,
    userInput,
    simpleMode,
    onProgress,
    tools,
  );
  const output = await phase3_combinedOutput(
    missionAgents,
    phase1Results,
    userInput,
    verification,
    onProgress,
    tools,
  );

  if (sessionId) {
    saveMemory(sessionId, "user", userInput);
    saveMemory(sessionId, "assistant", output.combined || "");
    updateSession(sessionId, {
      messages: (getSession(sessionId)?.messages || 0) + 1,
    });
  }
  flushAllMemory();
  try {
    archiveSession(
      mcpWorkingDir,
      sessionId,
      [
        { role: "user", content: stripUserRequestTags(userInput) },
        { role: "assistant", content: deduplicateText(output.combined || "") },
      ],
      `Mission (${missionAgents.length} agents): ${(output.combined || "").slice(0, 100)}`,
    );
  } catch (_) { }

  // SSOT Auto-Refresh: refresh project context after mission completes
  // So subsequent agents get the latest file structure and content
  try {
    const projectDir = mcpWorkingDir || sessionId;
    if (projectDir && fs.existsSync(projectDir)) {
      autoSSOT(projectDir);
      log("INFO", "SSOT_REFRESHED", { dir: projectDir });
    }
  } catch (_) {
    /* SSOT refresh failure should not block response */
  }

  const elapsed = Date.now() - startTime;
  log("INFO", "MISSION_COMPLETE", {
    elapsed,
    agents_total: AGENTS.length,
    agents_dispatched: missionAgents.length,
    responded: output.stats?.responded || 0,
    failed: output.stats?.failed || 0,
    verified: output.verification?.verified || false,
  });

  // ── GOAL VERIFICATION: Block invalid output before sending to user ──
  const goalCheck = verifyGoalOutput(output.combined || "", userInput);
  if (!goalCheck.passed) {
    log("WARN", "GOAL_VERIFICATION_FAILED", {
      reason: goalCheck.reason,
      session: sessionId?.slice(0, 8),
    });
    // Replace combined output with honest limitation message
    output.combined = goalCheck.message;
    output.verification = {
      ...output.verification,
      goalVerified: false,
      goalReason: goalCheck.reason,
    };
  } else {
    output.verification = {
      ...output.verification,
      goalVerified: true,
      goalReason: goalCheck.reason,
    };
  }

  // ── AGENT-TO-AGENT CALL: Process any pending calls in output ──
  const agentCalls = parseAgentCalls(output.combined || "");
  if (agentCalls.length > 0) {
    log("INFO", "AGENT_CALLS_DETECTED", { count: agentCalls.length });
    for (const call of agentCalls) {
      try {
        const callResult = await executeAgentCall(
          { name: "QA Coordinator" },
          call.targetAgent,
          call.task,
          sessionId,
          tools,
        );
        if (callResult.success) {
          // Replace the call marker with the actual result
          output.combined = output.combined.replace(
            call.fullMatch,
            "\n\n[\u09a4\u09a5\u09cd\u09af \u09aa\u09cd\u09b0\u09be\u09aa\u09cd\u09a4: " +
            callResult.agent +
            "]\n" +
            callResult.content,
          );
        } else {
          output.combined = output.combined.replace(
            call.fullMatch,
            "\n\n[\u098f\u099c\u09c7\u09a8\u09cd\u099f \u0995\u09b2 \u09ac\u09cd\u09af\u09b0\u09cd\u09a5: " + call.targetAgent + "]",
          );
        }
      } catch (e) {
        log("WARN", "AGENT_CALL_FAIL", {
          target: call.targetAgent,
          error: e.message,
        });
      }
    }
  }

  await pushOutput(output.combined);
  await pushDone(output.stats);

  return {
    ...output,
    timing: { elapsed },
    timestamp: new Date().toISOString(),
    session_id: sessionId,
  };
}
// ─── System prompt builder ────────────────────────────────────
// One place builds every agent system prompt. It contains only the selected
// agent's persona, short rules, and bounded project excerpts. Tool schemas
// already travel in the request's `tools` argument, so no tool prose is added.
// Every build logs its section sizes; hidden context is not allowed.
function buildAgentSystemPrompt(agent, opts) {
  const o = opts || {};
  if (!agent || !agent.id) {
    throw new Error("Agent id is required to build a system prompt");
  }
  const persona = stripInvisible(String(agent.persona || "").trim());
  if (!persona) {
    throw new Error("Agent " + agent.id + " has no persona");
  }

  const contextParts = [];
  const sections = { persona: persona.length, ssot: 0, syllabus: 0, project: 0 };

  if (o.includeProjectContext !== false) {
    if (o.projectContext && String(o.projectContext).trim()) {
      const project = stripInvisible(String(o.projectContext).trim()).slice(0, 1800);
      contextParts.push("PROJECT CONTEXT (client-supplied, bounded):\n" + project);
      sections.project = project.length;
    } else {
      // The prompt engine owns the bounded SSOT/syllabus selection, the
      // fingerprint and the workspace id. The old two-excerpt path is kept
      // below for callers that explicitly need one section.
      const dir = getEffectiveDir(o.sessionId) || mcpWorkingDir || path.resolve(".");
      const promptContext = contextModule.buildPromptContext({
        dir,
        input: o.userInput || "",
        sessionId: o.sessionId,
        turns: Array.isArray(o.turns) ? o.turns : undefined,
        goal: o.goal || undefined,
      });
      if (promptContext.text) {
        contextParts.push(promptContext.text);
        sections.ssot = promptContext.sections.ssot;
        sections.syllabus = promptContext.sections.syllabus;
        sections.workspace_id = promptContext.workspaceId;
        sections.fingerprint = promptContext.fingerprint;
      }
    }
  }

  const content = buildSystemPrompt({
    agent,
    session: {
      persona,
      system_identity: identityPromptBlock(systemIdentityCore()),
      os: systemInfo.collectSystemInfo(),
      metadata: {
        session_id: o.sessionId,
        client: o.client,
        editor: o.editor,
        source: o.source || "api",
        workspace: mcpWorkingDir,
      },
      workspace: mcpWorkingDir,
    },
    context: contextParts.join("\n\n"),
    involvesCode: Boolean(o.involvesCode),
    mission: Boolean(o.mission),
    toolsCount: Number.isInteger(o.toolsCount) ? o.toolsCount : 0,
    maxChars: Number.isFinite(o.maxChars) ? o.maxChars : 6000,
    compact: o.compact !== false,
  });

  log("INFO", "SYSTEM_PROMPT_BUILT", {
    agent: agent.id,
    mode: o.mode || "chat",
    chars: content.length,
    persona: sections.persona,
    ssot: sections.ssot,
    syllabus: sections.syllabus,
    project: sections.project,
  });
  return content;
}

// Local CPU models get a hard character budget. Persona and rules stay;
// project context is dropped and the full files remain on disk.
function buildCompactSystemPrompt(agent, budgetChars) {
  if (!agent || !agent.id) {
    throw new Error("Agent id is required to build a system prompt");
  }
  const persona = stripInvisible(String(agent.persona || "").trim());
  if (!persona) {
    throw new Error("Agent " + agent.id + " has no persona");
  }
  const budget = Number.isFinite(budgetChars) ? Math.max(200, budgetChars) : 1200;
  const content = buildSystemPrompt({
    agent,
    session: {
      persona,
      // Compact prompts used to pass an empty session, so the model saw
      // "memory: 0/0 GB free" and "workspace: (unset)". Real facts cost
      // little: identity + live OS snapshot + workspace.
      system_identity: identityPromptBlock(systemIdentityCore()),
      os: systemInfo.collectSystemInfo(),
      metadata: { source: "compact" },
      workspace: mcpWorkingDir,
    },
    maxChars: budget,
    compact: true,
  });
  log("INFO", "SYSTEM_PROMPT_BUILT", {
    agent: agent.id,
    mode: "compact",
    chars: content.length,
    persona: Math.min(persona.length, budget),
    ssot: 0,
    syllabus: 0,
    project: 0,
  });
  return content;
}

async function executeSingleAgent(
  agentId,
  messages,
  stream,
  sessionId,
  tools,
  projectContext,
) {
  const startTime = Date.now();
  // The agent's file tools must resolve against its own session workspace,
  // not the process-global mcpWorkingDir. `contained` turns on write/delete
  // containment for a session that has a bound directory.
  const toolContext = {
    workingDir: getEffectiveDir(sessionId),
    contained: Boolean(sessionId && sessionDirs.has(sessionId)),
  };
  const agent = AGENTS.find((a) => a.id === agentId);
  if (!agent) return { success: false, error: "Agent not found: " + agentId };

  // Agent model is a preference. If its provider is gone, use the live
  // catalog instead of failing the request on a name nothing answers.
  const agentModel = usableAgentModel(agent);

  log("INFO", "SINGLE_AGENT_START", {
    agent: agent.id,
    name: agent.name,
    session: sessionId ? sessionId.slice(0, 8) : "none",
  });

  const userMsg = messages.filter((m) => m.role === "user").pop();
  let userInput = userMsg ? userMsg.content : "";
  if (Array.isArray(userInput)) {
    userInput = userInput
      .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
      .filter(Boolean)
      .join("\n");
  } else if (userInput && typeof userInput === "object") {
    userInput = userInput.text || userInput.value || JSON.stringify(userInput);
  }
  userInput = String(userInput || "");
  const inputSan = sanitizeForModel(userInput);
  if (inputSan.total > 0) {
    log("INFO", "INPUT_SANITIZED", {
      source: "single",
      removed: inputSan.total,
      chars: userInput.length,
      clean: inputSan.text.length,
    });
  }
  userInput = inputSan.text;

  // Detect if user input involves code (to add code safety rules)
  const involvesCode =
    /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
      userInput,
    );

  // A provider may cap the prompt (local CPU models). 0 means "no cap".
  const routing = resolveProvider(agentModel);
  const promptBudget =
    (routing && routing.config && Number(routing.config.maxPromptChars)) || 0;

  // The server owns the system prompt. Client-supplied system messages are
  // extra persona/context the server cannot audit, so they are dropped rather
  // than merged into the selected agent's prompt.
  messages = sanitizeMessages(messages, "single");
  const clientSystemMessages = messages.filter((m) => m.role === "system");
  if (clientSystemMessages.length > 0) {
    log("INFO", "CLIENT_SYSTEM_MESSAGE_DROPPED", {
      agent: agent.id,
      count: clientSystemMessages.length,
      chars: clientSystemMessages.reduce(
        (sum, m) => sum + String(m.content || "").length,
        0,
      ),
    });
  }
  const conversation = messages.filter((m) => m.role !== "system");

  const sysMsg = promptBudget
    ? {
        role: "system",
        content: buildCompactSystemPrompt(agent, promptBudget),
      }
    : {
        role: "system",
        content: buildAgentSystemPrompt(agent, {
          mode: "chat",
          sessionId,
          userInput,
          projectContext,
          involvesCode,
          toolsCount: (tools || []).length,
        }),
      };

  let augmentedMessages = [sysMsg, ...conversation];

  if (promptBudget) {
    log("INFO", "PROMPT_BUDGET_APPLIED", {
      agent: agent.id,
      provider: routing && routing.providerId,
      budget: promptBudget,
      systemChars: String(sysMsg.content || "").length,
      tools: (tools || []).length,
    });
  }

  // ─── Auto Web Search: detect need and inject results ────
  // Free models never write "web_search:" — so we detect need proactively
  const classification = classifyInput(userInput);
  if (classification.requires_web_search) {
    try {
      log("INFO", "AUTO_WEB_SEARCH_SINGLE", { query: userInput });
      const searchResult = await webSearch(userInput);
      if (searchResult.success && searchResult.results.length > 0) {
        const searchText =
          "\n\n--- WEB SEARCH RESULTS (auto-injected) ---\n" +
          searchResult.results
            .map(
              (r, i) =>
                i +
                1 +
                ". " +
                (r.title || "Link") +
                "\n   " +
                (r.snippet || ""),
            )
            .join("\n") +
          "\n--- END SEARCH RESULTS ---\n";
        // Inject into last user message
        const lastUserIdx = augmentedMessages.findLastIndex(
          (m) => m.role === "user",
        );
        if (lastUserIdx >= 0) {
          augmentedMessages[lastUserIdx] = {
            ...augmentedMessages[lastUserIdx],
            content: augmentedMessages[lastUserIdx].content + searchText,
          };
        }
      }
    } catch (e) {
      log("WARN", "AUTO_WEB_SEARCH_SINGLE_FAIL", { error: e.message });
    }
  }

  // Load memory if session exists (skipped under a prompt budget: history is
  // the first thing that must go when the model cannot afford the tokens).
  if (sessionId && !promptBudget) {
    const mem = getAgentMemory(sessionId, agentId);
    if (mem.length > 0) {
      const history = trimHistoryByChars(
        mem.filter((m) => m.role === "user" || m.role === "assistant"),
        MAX_HISTORY_CHARS,
      );
      const historyMessages = history.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      augmentedMessages.splice(1, 0, ...historyMessages);
      log("INFO", "AGENT_MEMORY_LOADED", {
        agent: agent.id,
        count: historyMessages.length,
      });
    }
  }

  // P1-10: one session budget for every provider call. Oldest history goes
  // first; the system prompt and the newest turn always stay.
  const singleBudget = sizeBudget.trimMessages(
    augmentedMessages,
    "SESSION_MAX_BYTES",
  );
  if (singleBudget.dropped > 0) {
    log("WARN", "BUDGET_EXCEEDED", {
      key: "SESSION_MAX_BYTES",
      limit: singleBudget.limit,
      actual: singleBudget.bytes,
      dropped: singleBudget.dropped,
    });
  }
  augmentedMessages = singleBudget.messages;

  // Auto-inject MCP tools when no tools provided.
  // lib/tool-budget.js applies the single count/byte/prefill budget in
  // callModel; a budgeted provider simply sends fewer schemas, never zero.
  if ((!tools || tools.length === 0) && !promptBudget) {
    const mcpToolList = Object.entries(MCP_TOOLS).map(([name, def]) => ({
      type: "function",
      function: {
        name,
        description: def.description,
        parameters: {
          type: "object",
          properties: def.params || {},
          required: def.required || [],
        },
      },
    }));
    if (mcpToolList.length > 0) tools = mcpToolList;
  }

  if (stream) {
    const result = await callModelWithTools(
      agentModel,
      augmentedMessages,
      undefined,
      tools,
      undefined,
      undefined,
      toolContext,
    );
    const safeResult = result || {};
    const masked = maskModelIdentity(safeResult.content || "No response");
    if (sessionId) {
      const userMsg = messages.filter((m) => m.role === "user").pop();
      if (userMsg) saveAgentMemory(sessionId, agentId, "user", userMsg.content);
      if (masked) saveAgentMemory(sessionId, agentId, "assistant", masked);
      saveMemory(sessionId, "user", userMsg?.content || "");
      saveMemory(sessionId, "assistant", masked);
      updateSession(sessionId, {
        model: agentId,
        provider: agentModel,
        messages: (getSession(sessionId)?.messages || 0) + 1,
      });
      flushAllMemory();
      try {
        const usrMsg = messages.filter((m) => m.role === "user").pop();
        archiveSession(
          mcpWorkingDir,
          sessionId,
          [
            { role: "user", content: stripUserRequestTags(usrMsg?.content || "") },
            { role: "assistant", content: deduplicateText(masked || "") },
          ],
          `Agent ${agentId} (stream): ${(masked || "").slice(0, 100)}`,
        );
      } catch (_) { }
    }
    // ── SYLLABUS LEARNING: persist what was learned (stream) ──
    try {
      learnToSyllabus(sessionId, agent, userMsg?.content || "", masked || "");
    } catch (_) { }
    return {
      success: true,
      content: masked,
      maskedModel: agent.id,
      agent: { id: agent.id, name: agent.name, role: agent.role },
      // Attribution comes from the call that answered, not a fresh resolve.
      provider: safeResult.provider || null,
      upstream_provider: safeResult.upstream_provider || null,
      model: agentModel,
    };
  }

  // Non-streaming
  let response = await callModelWithTools(
    agentModel,
    augmentedMessages,
    undefined,
    tools,
    undefined,
    undefined,
    toolContext,
  );

  // Show error message when all providers fail
  if (!response || !response.success) {
    const provInfo = response?.provider || "resolve(" + agentModel + ")";
    log("WARN", "SINGLE_AGENT_FAIL", {
      agent: agent.id,
      model: agentModel,
      provider: provInfo,
      error: response?.error || "unknown",
    });
    return {
      success: false,
      content:
        "\u09ad\u09be\u0987\u09af\u09bc\u09be! \u09b8\u09ac provider \u09ac\u09cd\u09af\u09b0\u09cd\u09a5 \u09b9\u09af\u09bc\u09c7\u099b\u09c7। [model: " +
        agentModel +
        ", provider: " +
        provInfo +
        "] " +
        (response?.error || "unknown"),
      error: response?.error || "unknown",
      provider: (response && response.provider) || null,
      model: agentModel,
      maskedModel: agent.id,
      agent: { id: agent.id, name: agent.name, role: agent.role },
    };
  }

  // Auto web search if requested
  response = await autoWebSearch(agent, response, userInput);

  // Save per-agent memory
  if (sessionId) {
    saveAgentMemory(sessionId, agentId, "user", userInput);
    saveAgentMemory(sessionId, agentId, "assistant", response.content || "");
    saveMemory(sessionId, "user", userInput);
    saveMemory(sessionId, "assistant", response.content || "");
    updateSession(sessionId, {
      model: agentId,
      provider: agentModel,
      messages: (getSession(sessionId)?.messages || 0) + 1,
    });
    flushAllMemory();
    try {
      archiveSession(
        mcpWorkingDir,
        sessionId,
        [
          { role: "user", content: stripUserRequestTags(userInput) },
          { role: "assistant", content: deduplicateText(response.content || "") },
        ],
        `Agent ${agentId}: ${(response.content || "").slice(0, 100)}`,
      );
    } catch (_) { }
  }

  log("INFO", "SINGLE_AGENT_COMPLETE", {
    agent: agent.id,
    contentLength: (response.content || "").length,
    webSearch: response.webSearchUsed || false,
    elapsed: Date.now() - startTime,
  });

  // ── SYLLABUS LEARNING: persist what was learned (non-stream) ──
  try {
    learnToSyllabus(sessionId, agent, userInput, response.content || "");
  } catch (_) { }

  // ── GOAL VERIFICATION for single agent ──
  const singleGoalCheck = verifyGoalOutput(response.content || "", userInput);
  if (!singleGoalCheck.passed) {
    log("WARN", "SINGLE_AGENT_GOAL_FAILED", {
      agent: agent.id,
      reason: singleGoalCheck.reason,
    });
    response.content = singleGoalCheck.message;
  }

  // ── AGENT-TO-AGENT CALL for single agent ──
  const singleAgentCalls = parseAgentCalls(response.content || "");
  if (singleAgentCalls.length > 0) {
    for (const call of singleAgentCalls) {
      try {
        const callResult = await executeAgentCall(
          agent,
          call.targetAgent,
          call.task,
          sessionId,
          tools,
        );
        if (callResult.success) {
          response.content = response.content.replace(
            call.fullMatch,
            "\n\n[\u09a4\u09a5\u09cd\u09af \u09aa\u09cd\u09b0\u09be\u09aa\u09cd\u09a4: " +
            callResult.agent +
            "]\n" +
            callResult.content,
          );
        } else {
          response.content = response.content.replace(
            call.fullMatch,
            "\n\n[\u098f\u099c\u09c7\u09a8\u09cd\u099f \u0995\u09b2 \u09ac\u09cd\u09af\u09b0\u09cd\u09a5: " + call.targetAgent + "]",
          );
        }
      } catch (e) {
        log("WARN", "SINGLE_AGENT_CALL_FAIL", {
          target: call.targetAgent,
          error: e.message,
        });
      }
    }
  }

  // Build OpenAI-compatible response with masking
  const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
  return {
    success: true,
    content: response.content,
    tool_calls: response.tool_calls || null,
    maskedModel: agent.id, // Mask: show agent id, not real model
    agent: { id: agent.id, name: agent.name, role: agent.role },
    // The provider that actually answered (callModel/callModelWithTools
    // returns it). Telemetry records this, never a fresh resolve.
    provider: response.provider || null,
    upstream_provider: response.upstream_provider || null,
    model: agentModel,
    goalVerified: singleGoalCheck.passed,
    goalReason: singleGoalCheck.reason,
    // #5 swap_notice: trail recorded on THIS request's augmentedMessages
    swap_notice: getSwapNotice(augmentedMessages),
  };
}

// 
//  MCP JSON-RPC 2.0 HANDLER
// 
let nextMcpId = 1;
// MCP working directory tracking
// The runtime may execute from dist/ (the gateway wrapper cd's there and
// symlinks runtime state). `path.resolve(".")` would then point at dist/,
// which is not a project. Resolve the checkout that owns this build once.
const RUNTIME_DIR = path.resolve(__dirname);
const CHECKOUT_ROOT = path.resolve(
  process.env.ZOMBIECODER_PROJECT_ROOT ||
    (path.basename(RUNTIME_DIR) === "dist" ? path.dirname(RUNTIME_DIR) : RUNTIME_DIR),
);
let mcpWorkingDir = CHECKOUT_ROOT;

// Per-session working directory: if session has a custom dir, use it.
// The metadata fallback rebuilds sessionDirs after a restart without a
// separate migration pass.
function getEffectiveDir(sessionId) {
  if (sessionId && sessionDirs.has(sessionId)) {
    return sessionDirs.get(sessionId);
  }
  if (sessionId) {
    const session = getSession(sessionId);
    const stored = session && session.metadata && session.metadata.working_dir;
    if (stored) {
      const dir = path.resolve(String(stored));
      sessionDirs.set(sessionId, dir);
      return dir;
    }
  }
  return mcpWorkingDir;
}

// Auto-detect project root: check OS env vars first (editor/server can set
// these), then parent dirs for .zombiecoder/ marker.
const WORKSPACE_ENV_VARS = [
  "PROJECT_DIR",
  "MISSION_WORKSPACE_ROOT",
  "ZOMBIECODER_WORKSPACE",
  "WORKSPACE_ROOT",
  "MISSION_BARISAL_WORKING_DIR",
  "ZOMBIECODER_WORKING_DIR",
  "MB_WORKING_DIR",
  "ZC_WORKING_DIR",
];
let workspaceEnvSource = null;
for (const envKey of WORKSPACE_ENV_VARS) {
  if (process.env[envKey]) {
    const envDir = path.resolve(process.env[envKey]);
    if (fs.existsSync(envDir)) {
      mcpWorkingDir = envDir;
      workspaceEnvSource = envKey;
      log("INFO", "MCP_DIR_ENV", { dir: envDir, source: envKey });
      break;
    }
  }
}
if (!workspaceEnvSource) {
  // Walk up from the checkout, not process.cwd(): under the production
  // wrapper the cwd is dist/, which holds a .zombiecoder symlink to the
  // checkout and would otherwise win the scan.
  let probe = CHECKOUT_ROOT;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(probe, ".zombiecoder"))) {
      mcpWorkingDir = probe;
      log("INFO", "MCP_DIR_DETECTED", { dir: probe, source: "parent-scan" });
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
}

const MCP_TOOLS = {
  read_file: {
    description: "Read a file from the filesystem",
    params: {
      path: {
        type: "string",
        description: "File path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  write_file: {
    description: "Write content to a file (creates directories)",
    params: {
      path: {
        type: "string",
        description: "File path (relative to MCP working dir or absolute)",
      },
      content: { type: "string", description: "Content" },
    },
    required: ["path", "content"],
  },
  set_working_dir: {
    description: "Set MCP working directory for relative file paths",
    params: {
      directory: {
        type: "string",
        description: "Absolute path to working directory",
      },
    },
    required: ["directory"],
  },
  get_working_dir: {
    description: "Get current MCP working directory",
    params: {},
    required: [],
  },
  tool_search: {
    description:
      "Search the live tool catalog by keyword. Returns matching tool names, descriptions and full JSON schemas. Call this first when you need a capability; call with an empty query to list every tool name. This keeps the per-request tool payload small.",
    params: {
      query: {
        type: "string",
        description:
          "Keyword(s) matched against tool names and descriptions; empty lists all tools",
      },
      limit: {
        type: "integer",
        description:
          "Max matches (1-50, default 12; empty query defaults to 100)",
      },
      include_schema: {
        type: "boolean",
        description: "Include the full JSON schema for each match (default true)",
      },
    },
    required: [],
  },
  web_search: {
    description: "Search the web for real-time information",
    params: { query: { type: "string", description: "Search query" } },
    required: ["query"],
  },
  agent_mission: {
    description: "Execute a mission with all agents in parallel",
    params: {
      input: { type: "string", description: "User input" },
      session_id: { type: "string", description: "Optional session ID" },
    },
    required: ["input"],
  },
  agent_single: {
    description: "Execute with a single agent",
    params: {
      input: { type: "string", description: "User input" },
      agent_id: { type: "string", description: "Agent ID" },
      session_id: { type: "string", description: "Optional session ID" },
    },
    required: ["input", "agent_id"],
  },
  get_memory: {
    description: "Retrieve session memory",
    params: {
      session_id: { type: "string", description: "Session ID" },
      agent_id: { type: "string", description: "Optional: per-agent memory" },
    },
    required: ["session_id"],
  },
  memory_recent: {
    description:
      "List the newest archived project sessions from SQLite (id, date, summary, key points, tags). Session history is not injected automatically; call this only when the user asks about earlier sessions.",
    params: {
      limit: { type: "integer", description: "How many archives to return (1-20, default 5)" },
    },
    required: [],
  },
  memory_search: {
    description:
      "Search archived project sessions in SQLite by keyword (summary, key points, decisions, tags). Use when the user refers to earlier work; returns matching archives newest first.",
    params: {
      query: { type: "string", description: "Keyword to search" },
      limit: { type: "integer", description: "Max results (1-20, default 10)" },
    },
    required: ["query"],
  },
  read_ssot: {
    description:
      "Read the current SSOT.md (Single Source of Truth) file — contains auto-detected project info",
    params: {},
    required: [],
  },
  append_syllabus: {
    description:
      "Append a knowledge entry to the project syllabus.md — the shared learning log ALL agents read (append-only; never overwrites). Use when you learn something new worth keeping.",
    params: {
      topic: { type: "string", description: "Entry title / topic" },
      summary: {
        type: "string",
        description: "What was learned (markdown allowed)",
      },
      source: {
        type: "string",
        description: "Origin of the knowledge (Web Search / docs / code / ...)",
      },
      keyPoints: {
        type: "array",
        items: { type: "string" },
        description: "Key takeaways (string is split on newlines/commas too)",
      },
      project_dir: {
        type: "string",
        description: "Project dir (defaults to current MCP working dir)",
      },
    },
    required: ["topic", "summary"],
  },
  list_directory: {
    description: "List contents of a directory",
    params: {
      path: {
        type: "string",
        description: "Directory path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  open_browser: {
    description:
      "Open a file or URL in the default browser (uses xdg-open/open/start)",
    params: {
      target: {
        type: "string",
        description:
          "File path or URL to open in the browser (e.g., /abs/path/file.html or http://localhost:3000)",
      },
    },
    required: ["target"],
  },
  browse_cdp: {
    description:
      "Headless-browse a URL via Chrome DevTools Protocol over a PIPE (zero HTTP control channel — no port, no websocket). Opens a page with headless Chrome and returns text, HTML, title, a screenshot (saved to a temp file), computed styles, element queries, the page outline, links or console output. Use for reading AND visually inspecting local or remote pages.",
    params: {
      url: {
        type: "string",
        description: "Absolute URL to open: http://, https://, file:// or about:",
      },
      action: {
        type: "string",
        description:
          "What to return: text (default) | html | title | url | info | screenshot (viewport png) | screenshot_full (full-page png, saved to file) | eval | wait | query | styles | outline | links | console",
      },
      expression: {
        type: "string",
        description: "JavaScript expression for action=eval (runs in the page)",
      },
      selector: {
        type: "string",
        description: "CSS selector for action=query, styles or wait",
      },
      wait_ms: {
        type: "number",
        description: "Milliseconds to wait after load before reading (for animations/JS)",
      },
      limit: {
        type: "number",
        description: "Max items returned for query/links/console (default 25)",
      },
      keep_open: {
        type: "boolean",
        description: "Keep one tab open across calls for multi-step inspection",
      },
      viewport: {
        type: "object",
        description: "Viewport override {width,height,deviceScaleFactor}",
        properties: {
          width: { type: "number" },
          height: { type: "number" },
          deviceScaleFactor: { type: "number" },
        },
      },
      timeout_ms: {
        type: "number",
        description: "Load timeout in milliseconds (default 20000)",
      },
    },
    required: ["url"],
  },
  call_agent: {
    description:
      "Call another agent for a specific sub-task. Use when the task needs specialized knowledge from another agent (e.g., security review, bug hunting, performance tuning).",
    params: {
      agent_id: {
        type: "string",
        description:
          "Target agent ID: code-guru (architecture), bug-hunter (debugging), security-hero (security), perf-wizard (performance), doc-king (documentation), qa-tyrant (quality)",
      },
      task: {
        type: "string",
        description: "The specific sub-task to delegate to this agent",
      },
      context: {
        type: "string",
        description:
          "Optional context or background information for the sub-task",
      },
    },
    required: ["agent_id", "task"],
  },
  // NEW (2026-08-07, Code Guru - Monu): essential dev tools added per
  // user requirement — terminal, delete_file, rename, grep, glob.
  // These were missing from MCP_TOOLS; only read/write/list existed before.
  terminal: {
    description:
      "Run a shell command in the server terminal (cwd = MCP working dir). Returns stdout/stderr/exit code. Windows: PowerShell 5.1; Linux/macOS: bash.",
    params: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: {
        type: "string",
        description: "Optional working directory (default: MCP working dir)",
      },
    },
    required: ["command"],
  },
  delete_file: {
    description: "Delete a file or directory (recursive for directories)",
    params: {
      path: {
        type: "string",
        description:
          "File/directory path (relative to MCP working dir or absolute)",
      },
    },
    required: ["path"],
  },
  rename_file: {
    description: "Rename or move a file/directory",
    params: {
      from: {
        type: "string",
        description: "Source path (relative to MCP working dir or absolute)",
      },
      to: {
        type: "string",
        description: "Destination path (relative to MCP working dir or absolute)",
      },
    },
    required: ["from", "to"],
  },
  grep: {
    description:
      "Search file contents with a regex or plain text pattern inside the MCP working dir (bounded depth). Returns matching file paths + line snippets.",
    params: {
      query: { type: "string", description: "Pattern to search (regex allowed)" },
      include: {
        type: "string",
        description:
          "Optional glob filter, e.g. '**/*.js' or 'src/**' (default: all files)",
      },
      maxResults: {
        type: "number",
        description: "Optional cap on matches (default 50)",
      },
    },
    required: ["query"],
  },
  glob: {
    description:
      "Find files by glob pattern inside the MCP working dir (e.g. '**/*.{js,ts}')",
    params: {
      pattern: { type: "string", description: "Glob pattern (relative to working dir)" },
    },
    required: ["pattern"],
  },
  // [MB-TOOLS-2026] db_query, db_list_tables, exec, http_request, env_get, system_info
  db_query: {
    description:
      "Run a SQL query against a configured database (MySQL/SQLite/PostgreSQL). Config comes from env vars ONLY (DB_TYPE, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, DB_SQLITE_PATH, DB_TIMEOUT, PHP_BIN). MySQL/PostgreSQL use a PHP PDO bridge (db-bridge.php); SQLite uses Node built-in node:sqlite. Cross-platform (Windows/Linux/macOS).",
    params: {
      query: { type: "string", description: "SQL query to execute (SELECT/INSERT/UPDATE/DELETE/DDL)" },
      database: { type: "string", description: "Optional DB name override (default: DB_NAME env)" },
    },
    required: ["query"],
  },
  db_list_tables: {
    description:
      "List tables in the configured database (MySQL/SQLite/PostgreSQL). Config from env vars ONLY (DB_*). Cross-platform.",
    params: {
      database: { type: "string", description: "Optional DB name override (default: DB_NAME env)" },
    },
    required: [],
  },
  exec: {
    description:
      "Run a shell command cross-platform in any folder. Windows uses PowerShell, Linux/macOS uses bash (override via EXEC_SHELL_WIN / EXEC_SHELL_LINUX env). Config from env vars ONLY (EXEC_SHELL_WIN, EXEC_SHELL_LINUX, EXEC_TIMEOUT, EXEC_MAX_BUFFER).",
    params: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Optional working directory (absolute or relative to MCP working dir)" },
      timeout: { type: "number", description: "Optional timeout in ms (default from env EXEC_TIMEOUT, 30000)" },
      env: { type: "object", description: "Optional extra environment variables to pass" },
    },
    required: ["command"],
  },
  http_request: {
    description:
      "Make an HTTP request (GET/POST/PUT/PATCH/DELETE) using Node built-in http/https. No external deps. Config: HTTP_TIMEOUT env (ms). Cross-platform.",
    params: {
      url: { type: "string", description: "Full URL (http:// or https://)" },
      method: { type: "string", description: "HTTP method (default GET)" },
      headers: { type: "object", description: "Optional request headers" },
      body: { type: "string", description: "Optional request body (raw string)" },
      timeout: { type: "number", description: "Optional timeout in ms (default from env HTTP_TIMEOUT, 30000)" },
    },
    required: ["url"],
  },
  env_get: {
    description:
      "Read an environment variable by name. Config is env-driven (never hardcoded). Values of KEY/SECRET/PASSWORD/TOKEN/AUTH variables are hidden unless reveal_secrets=true.",
    params: {
      key: { type: "string", description: "Environment variable name (e.g. DB_NAME, PORT, EXEC_TIMEOUT)" },
      reveal_secrets: { type: "boolean", description: "Set true to reveal values of secret-looking variables" },
    },
    required: ["key"],
  },
  system_info: {
    description:
      "Get cross-platform system info: platform, arch, OS, hostname, Node version, cwd, uptime, memory, non-secret env var names, and the configured DB config (values masked).",
    params: {},
    required: [],
  },
};


// EXTERNAL TOOL CONNECTOR (ENV-DRIVEN) — NEW (2026-08-07)
// Registers external tools from env vars into MCP_TOOLS at startup.
// Env vars: EXTERNAL_TOOL_1_NAME, EXTERNAL_TOOL_1_URL, EXTERNAL_TOOL_1_KEY,
//           EXTERNAL_TOOL_1_METHOD, EXTERNAL_TOOL_1_DESCRIPTION, EXTERNAL_TOOL_1_PARAMS
const EXTERNAL_TOOLS = new Map(); // name -> { url, key, method }
function loadExternalTools() {
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const m = key.match(/^EXTERNAL_TOOL_(\d+)_NAME$/);
    if (!m) continue;
    const n = m[1];
    const name = process.env[key].trim();
    const url = (process.env["EXTERNAL_TOOL_" + n + "_URL"] || "").trim();
    if (!name || !url || seen.has(name)) continue;
    if (!/^https?:\/\//i.test(url)) {
      console.warn("[EXTERNAL_TOOL] Skipped " + name + ": URL must be http(s)");
      continue;
    }
    seen.add(name);
    const authKey = process.env["EXTERNAL_TOOL_" + n + "_KEY"] || "";
    const method = (process.env["EXTERNAL_TOOL_" + n + "_METHOD"] || "POST").toUpperCase();
    const desc = process.env["EXTERNAL_TOOL_" + n + "_DESCRIPTION"] || "External tool: " + name;
    let params = {};
    try {
      const raw = process.env["EXTERNAL_TOOL_" + n + "_PARAMS"];
      if (raw) params = JSON.parse(raw);
    } catch (e) {
      console.warn("[EXTERNAL_TOOL] " + name + ": invalid PARAMS JSON, using {}");
    }
    EXTERNAL_TOOLS.set(name, { url, key: authKey, method, desc, params });
    MCP_TOOLS[name] = {
      description: desc,
      params: Object.keys(params).length
        ? params
        : { args: { type: "object", description: "Tool arguments" } },
      required: ["args"],
    };
    console.log("[EXTERNAL_TOOL] Loaded: " + name + " -> " + url);
  }
  if (seen.size > 0) console.log("[EXTERNAL_TOOL] Total loaded: " + seen.size);
}
loadExternalTools();

// 
// PHASE D: OUTBOUND MCP CLIENT (2026-08-10, Code Guru - Monu)
// This server becomes an MCP *client*: it connects to REMOTE MCP
// servers (JSON-RPC 2.0 over HTTP POST), discovers their tools, and
// can call them. Remote tools are merged into MCP_TOOLS with the
// prefix `remote__<server>__<tool>` so local tools are not shadowed.
// Config via env: REMOTE_MCP_SERVERS = "url1,url2" OR JSON array:
//   [{"url":"https://b.zombiecoder.my.id/mcp","name":"zombie"}]
// 

// Generic tool: lets agents call ANY remote MCP server tool by name.
MCP_TOOLS.remote_mcp_call = {
  description:
    "Call a tool on a remote MCP server (outbound MCP client). Use this to invoke tools exposed by connected remote MCP servers.",
  params: {
    server: {
      type: "string",
      description: "Remote MCP server name (see /api/mcp-remote)",
    },
    tool: { type: "string", description: "Remote tool name to call" },
    args: { type: "object", description: "Arguments for the remote tool" },
  },
  required: ["server", "tool"],
};

const mcpRemoteClients = new Map(); // name -> { url, name, tools:[], status, lastSync, error }

const REMOTE_MCP_SETTING_KEY = "remote_mcp_servers";

function deriveRemoteName(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]/gi, "-");
  } catch (_) {
    return "remote-mcp";
  }
}

function loadPersistedRemoteMcpServers() {
  if (!MODELS_DB) return [];
  try {
    const row = MODELS_DB.prepare(
      "SELECT value FROM settings WHERE key = ?",
    ).get(REMOTE_MCP_SETTING_KEY);
    if (!row || !row.value) return [];
    const rows = JSON.parse(row.value);
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((s) => s && typeof s.url === "string" && s.url.trim())
      .map((s) => ({
        name: String(s.name || "").trim() || deriveRemoteName(s.url),
        url: String(s.url).trim(),
        token: providerSecretStore.decryptSecret(s.token || ""),
      }));
  } catch (e) {
    log("WARN", "REMOTE_MCP_CONFIG_LOAD_FAIL", { error: e.message });
    return [];
  }
}

function persistRemoteMcpServers() {
  if (!MODELS_DB) return;
  try {
    const rows = Array.from(mcpRemoteClients.values())
      .filter((s) => s && s.url)
      .map((s) => ({
        name: s.name,
        url: s.url,
        token: providerSecretStore.encryptSecret(s.token || ""),
      }));
    MODELS_DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(REMOTE_MCP_SETTING_KEY, JSON.stringify(rows), Date.now());
  } catch (e) {
    log("WARN", "REMOTE_MCP_CONFIG_SAVE_FAIL", { error: e.message });
  }
}

function parseRemoteMcpServers() {
  const raw = process.env.REMOTE_MCP_SERVERS || "";
  const envServers = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      for (const s of arr) {
        if (s && s.url) envServers.push(s);
      }
    } catch (e) {
      log("WARN", "REMOTE_MCP_PARSE_FAIL", { error: e.message });
    }
  } else if (trimmed) {
    for (const url of trimmed.split(",")) {
      if (url.trim()) envServers.push({ url: url.trim() });
    }
  }

  // DB entries are the admin/curl-added HTTP MCPs; env entries stay additive.
  const merged = new Map();
  for (const server of [...loadPersistedRemoteMcpServers(), ...envServers]) {
    const name = String(server.name || "").trim() || deriveRemoteName(server.url);
    merged.set(name, { ...server, name });
  }
  return [...merged.values()];
}

function mcpRemoteRequest(url, method, params, timeoutMs = 15000, token = "") {
  return new Promise((resolve) => {
    let lib;
    try {
      lib = url.startsWith("https://") ? https : http;
    } catch (e) {
      resolve({ error: "invalid url: " + url });
      return;
    }
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params || {},
    });
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ error: "invalid url: " + url });
      return;
    }
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": "MissionBarisal-OutboundMCP/3.2.1",
    };
    if (token) headers.Authorization = "Bearer " + token;
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname || "/",
        method: "POST",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve({ error: "non-json response: " + data.slice(0, 200) });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout after " + timeoutMs + "ms" });
    });
    req.on("error", (e) => resolve({ error: e.message }));
    req.write(payload);
    req.end();
  });
}

async function discoverRemoteMCP(server) {
  const { url, name, token } = server;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* keep raw url as name fallback */
  }
  const entry = {
    url,
    name: name || host,
    token: token || "",
    tools: [],
    status: "connecting",
    lastSync: 0,
    error: "",
    addedAt: Date.now(),
  };
  mcpRemoteClients.set(entry.name, entry);
  try {
    const init = await mcpRemoteRequest(
      url,
      "initialize",
      {
        protocolVersion: mcpProtocol.PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "mission-barisal-gateway", version: "3.2.1" },
      },
      15000,
      entry.token,
    );
    if (init.error) {
      entry.status = "error";
      entry.error = init.error;
      return entry;
    }
    const list = await mcpRemoteRequest(url, "tools/list", {}, 15000, entry.token);
    if (list.error) {
      entry.status = "error";
      entry.error = list.error;
      return entry;
    }
    entry.tools = (list.result && list.result.tools) || [];
    entry.status = "connected";
    entry.lastSync = Date.now();
    log("INFO", "REMOTE_MCP_CONNECTED", {
      server: entry.name,
      tools: entry.tools.length,
    });
  } catch (e) {
    entry.status = "error";
    entry.error = e.message;
    log("WARN", "REMOTE_MCP_DISCOVER_FAIL", {
      server: entry.name,
      error: e.message,
    });
  }
  return entry;
}

async function syncAllRemoteMCPs() {
  const servers = parseRemoteMcpServers();
  if (servers.length === 0) return { ok: true, synced: 0 };
  let synced = 0;
  for (const s of servers) {
    await discoverRemoteMCP(s);
    synced++;
  }
  log("INFO", "REMOTE_MCP_SYNC_DONE", { servers: synced });
  return { ok: true, synced };
}

// Merge remote tools into MCP_TOOLS with remote__<server>__<tool> prefix.
function mergeRemoteMcpTools() {
  let added = 0;
  for (const [name, client] of mcpRemoteClients) {
    if (client.status !== "connected") continue;
    for (const t of client.tools) {
      const fullName = "remote__" + name + "__" + t.name;
      if (MCP_TOOLS[fullName]) continue; // already merged
      MCP_TOOLS[fullName] = {
        description:
          "[remote:" + name + "] " + (t.description || t.name),
        params:
          (t.inputSchema && t.inputSchema.properties) || {
            args: { type: "object" },
          },
        required: (t.inputSchema && t.inputSchema.required) || [],
      };
      added++;
    }
  }
  if (added > 0) log("INFO", "REMOTE_MCP_TOOLS_MERGED", { added });
  return added;
}

async function executeRemoteMcpTool(server, tool, args) {
  const client = mcpRemoteClients.get(server);
  if (!client) {
    return {
      content: [
        {
          type: "text",
          text:
            "Unknown remote MCP server: " +
            server +
            " (see /api/mcp-remote)",
        },
      ],
    };
  }
  if (client.status !== "connected") {
    return {
      content: [
        {
          type: "text",
          text:
            "Remote MCP server '" +
            server +
            "' not connected: " +
            client.error,
        },
      ],
    };
  }
  const res = await mcpRemoteRequest(
    client.url,
    "tools/call",
    {
      name: tool,
      arguments: args || {},
    },
    15000,
    client.token,
  );
  if (res.error) {
    return {
      content: [{ type: "text", text: "Remote tool error: " + res.error }],
    };
  }
  const result = res.result || {};
  const text = (result.content || [])
    .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  return {
    content: [{ type: "text", text: text || JSON.stringify(result) }],
  };
}

// Clients often send ~/project even though path.isAbsolute("~/x") is false.
// Expand it before resolving so the agent reaches the same file a shell would.
// The expansion rule lives in lib/env.js (one resolver).
const expandHome = expandHomePath;

function isPathSafe(targetPath, workingDir) {
  // AGENT_FS_SCOPE — env toggle for the agent's filesystem sandbox.
  //   "unrestricted" (DEFAULT): agents may touch ANY file/folder on this OS
  //     — user's explicit request (root-level access for the agent persona).
  //   "restricted": legacy sandbox (workspace + ALLOWED_DIRS + $HOME only).
  const scope = (process.env.AGENT_FS_SCOPE || "unrestricted").toLowerCase();
  if (scope === "unrestricted" || scope === "root" || scope === "any") {
    return true;
  }
  const resolved = path.resolve(targetPath);
  // Allow access within the active workspace. A session-bound agent passes its
  // own dir; a direct MCP call keeps the global mcpWorkingDir.
  const activeDir = workingDir ? path.resolve(workingDir) : mcpWorkingDir;
  if (activeDir && (resolved.startsWith(activeDir + path.sep) || resolved === activeDir)) {
    return true;
  }
  // Also check the static ALLOWED_DIRS (server CWD + log/data dirs).
  for (const allowed of ALLOWED_DIRS) {
    // Root directory ("/" on POSIX, "C:\" on Windows): everything is under it.
    if (allowed === path.sep || allowed === path.parse(allowed).root) {
      return true;
    }
    if (resolved.startsWith(allowed + path.sep) || resolved === allowed) {
      return true;
    }
  }
  // Allow access to any path under the user's home directory.
  // This enables the agent to read/write project files across all workspaces.
  const homeDir = path.resolve(userHomeDir());
  if (resolved.startsWith(homeDir + path.sep) || resolved === homeDir) {
    return true;
  }
  return false;
}

async function executeMcpTool(tool, args, ctx) {
  const id = nextMcpId++;
  // Per-session workspace: the agent tool loop passes the session's dir. A
  // direct MCP/UDS/WS tool call can pass `session_id` in its args instead, so
  // the same containment applies without a second code path.
  const ctxSessionId =
    (ctx && ctx.sessionId ? String(ctx.sessionId) : "") ||
    (args && (args.session_id || args.sessionId)
      ? String(args.session_id || args.sessionId)
      : "");
  const workDir =
    ctx && ctx.workingDir
      ? path.resolve(String(ctx.workingDir))
      : getEffectiveDir(ctxSessionId);
  const contained = Boolean(
    (ctx && ctx.contained && ctx.workingDir) ||
      (ctxSessionId && sessionDirs.has(ctxSessionId)),
  );
  const outsideSession = (target) => {
    if (!contained) return false;
    const base = path.resolve(workDir);
    const resolved = path.resolve(target);
    return resolved !== base && !resolved.startsWith(base + path.sep);
  };
  log("INFO", "MCP_CALL", { tool, args, id });

  // Admin on/off — single choke point for HTTP + UDS + SSE callers.
  if (!toolEnabled(tool)) {
    log("WARN", "MCP_TOOL_DISABLED", { tool, id });
    return {
      content: [
        {
          type: "text",
          text: `TOOL_DISABLED: '${tool}' is turned off in the admin panel (MCP & Tools page).`,
        },
      ],
    };
  }

  // PHASE D: outbound MCP delegation — remote__<server>__<tool> prefix
  if (tool === "remote_mcp_call") {
    return await executeRemoteMcpTool(args.server, args.tool, args.args || {});
  }
  if (tool.startsWith("remote__")) {
    const parts = tool.split("__");
    if (parts.length >= 3) {
      const server = parts[1];
      const remoteTool = parts.slice(2).join("__");
      return await executeRemoteMcpTool(server, remoteTool, args);
    }
  }

  // PHASE D2: external MCP delegation — <server>__<tool> prefix
  // Tools come from external mcp/servers.json OR EXTERNAL_MCP_URLS.
  if (tool.includes("__")) {
    const parsed = externalMcp.parseToolName(tool);
    if (parsed) {
      const extResult = await externalMcp.call(parsed.server, parsed.tool, args);
      if (extResult) return extResult;
    }
  }

  switch (tool) {
    case "tool_search": {
      const result = searchToolCatalog(
        args.query,
        args.limit,
        args.include_schema,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
    case "read_file": {
      const readPath = expandHome(args.path || ".");
      const p = path.isAbsolute(readPath)
        ? path.resolve(readPath)
        : path.resolve(workDir, readPath);
      if (outsideSession(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      if (!isPathSafe(p, workDir)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                workDir,
            },
          ],
        };
      }
      if (!fs.existsSync(p))
        return { content: [{ type: "text", text: "File not found: " + p }] };
      const stat = fs.statSync(p);
      if (!stat.isFile())
        return { content: [{ type: "text", text: "Not a file: " + p }] };
      const content = fs.readFileSync(p, "utf8");
      return { content: [{ type: "text", text: content.slice(0, 100000) }] };
    }
    case "write_file": {
      const writePath = expandHome(args.path || "");
      const p = path.isAbsolute(writePath)
        ? path.resolve(writePath)
        : path.resolve(workDir, writePath);
      if (outsideSession(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      if (!isPathSafe(p, workDir)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                workDir,
            },
          ],
        };
      }
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const writeSan = sanitizeForWrite(String(args.content || ""));
      if (writeSan.total > 0) {
        log("INFO", "WRITE_SANITIZED", {
          path: p,
          removed: writeSan.total,
          chars: String(args.content || "").length,
          clean: writeSan.text.length,
        });
      }
      fs.writeFileSync(p, writeSan.text);
      return {
        content: [
          {
            type: "text",
            text:
              "Written " +
              writeSan.text.length +
              " bytes to " +
              p +
              (writeSan.total
                ? " (" + writeSan.total + " invisible/control char(s) removed)"
                : ""),
          },
        ],
      };
    }
    case "terminal": {
      const cmd = args.command || "";
      if (!cmd.trim()) {
        return { content: [{ type: "text", text: "Empty command" }] };
      }
      const cwd =
        args.cwd && typeof args.cwd === "string"
          ? path.resolve(workDir || ".", expandHome(args.cwd))
          : workDir || ".";
      if (outsideSession(cwd)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      const { exec } = require("child_process");
      const shell = _PLATFORM === "win32" ? "powershell.exe" : "/bin/bash";
      const shellArgs = _PLATFORM === "win32" ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
      return await new Promise((resolve) => {
        const child = exec(
          cmd,
          { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024, shell },
          (error, stdout, stderr) => {
            const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
            const text =
              "$ " + cmd + "\n(cwd: " + cwd + ")\n\n" +
              (stdout ? "[stdout]\n" + stdout.slice(0, 50000) + "\n" : "") +
              (stderr ? "[stderr]\n" + stderr.slice(0, 50000) + "\n" : "") +
              "[exit] " + exitCode;
            resolve({ content: [{ type: "text", text }] });
          }
        );
      });
    }
    case "delete_file": {
      const deletePath = expandHome(args.path || "");
      const p = path.isAbsolute(deletePath)
        ? path.resolve(deletePath)
        : path.resolve(workDir, deletePath);
      if (outsideSession(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      if (!isPathSafe(p, workDir)) {
        return { content: [{ type: "text", text: "Access denied: path outside allowed directories: " + p }] };
      }
      if (!fs.existsSync(p)) {
        return { content: [{ type: "text", text: "Path not found: " + p }] };
      }
      const stat = fs.statSync(p);
      fs.rmSync(p, { recursive: true, force: true });
      return {
        content: [
          {
            type: "text",
            text: "Deleted " + (stat.isDirectory() ? "directory" : "file") + ": " + p,
          },
        ],
      };
    }
    case "rename_file": {
      const fromRaw = expandHome(args.from || "");
      const toRaw = expandHome(args.to || "");
      const fromP = path.isAbsolute(fromRaw)
        ? path.resolve(fromRaw)
        : path.resolve(workDir, fromRaw);
      const toP = path.isAbsolute(toRaw)
        ? path.resolve(toRaw)
        : path.resolve(workDir, toRaw);
      if (outsideSession(fromP) || outsideSession(toP)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      if (!isPathSafe(fromP, workDir) || !isPathSafe(toP, workDir)) {
        return { content: [{ type: "text", text: "Access denied: path outside allowed directories" }] };
      }
      if (!fs.existsSync(fromP)) {
        return { content: [{ type: "text", text: "Source not found: " + fromP }] };
      }
      const dir = path.dirname(toP);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(fromP, toP);
      return { content: [{ type: "text", text: "Renamed/moved: " + fromP + " -> " + toP }] };
    }
    case "grep": {
      const query = args.query || "";
      if (!query) return { content: [{ type: "text", text: "Empty query" }] };
      const base = workDir || ".";
      const maxResults = Math.min(parseInt(args.maxResults, 10) || 50, 200);
      let re;
      try {
        re = new RegExp(query, "i");
      } catch (e) {
        return { content: [{ type: "text", text: "Invalid regex: " + e.message }] };
      }
      const hits = [];
      const walk = (dir, depth) => {
        if (depth > 8 || hits.length >= maxResults) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile()) {
            try {
              const content = fs.readFileSync(full, "utf8");
              for (const line of content.split("\n")) {
                if (re.test(line)) {
                  hits.push(path.relative(base, full) + ":" + line.slice(0, 200));
                  if (hits.length >= maxResults) break;
                }
              }
            } catch { }
          }
        }
      };
      walk(base, 0);
      return {
        content: [
          {
            type: "text",
            text: hits.length
              ? hits.join("\n")
              : "No matches for: " + query,
          },
        ],
      };
    }
    case "glob": {
      const pattern = args.pattern || "";
      const base = workDir || ".";
      const fullPattern = path.isAbsolute(pattern)
        ? pattern
        : path.join(base, pattern);
      const matches = [];
      const walk = (dir, depth) => {
        if (depth > 8) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(base, full);
          if (matchGlob(rel, pattern)) matches.push(rel);
          if (e.isDirectory()) walk(full, depth + 1);
        }
      };
      walk(base, 0);
      return {
        content: [
          {
            type: "text",
            text: matches.length ? matches.slice(0, 200).join("\n") : "No files match: " + pattern,
          },
        ],
      };
    }
    case "set_working_dir": {
      let rawDir = (args.directory || args.dir || args.path || ".").trim();
      // Handle ${workspaceFolder} sent literally (cursor/vscode variable not expanded)
      if (
        rawDir.includes("${workspaceFolder}") ||
        rawDir === "${workspaceFolder}" ||
        rawDir.includes("${workspaceRoot}")
      ) {
        rawDir = ".";
        log("WARN", "SET_WORKING_DIR_UNEXPANDED", {
          message:
            "Client sent ${workspaceFolder} unexpanded. Cursor MCP config needs to support variable expansion. Defaulting to server dir.",
        });
      }
      rawDir = expandHome(rawDir);
      const newDir = path.resolve(mcpWorkingDir || ".", rawDir);
      if (!fs.existsSync(newDir)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Directory not found: " +
                newDir +
                ". Please check the path and try again.",
            },
          ],
        };
      }
      mcpWorkingDir = newDir;
      // Only update mcpWorkingDir — ALLOWED_DIRS remains static.
      const dirStr = path.resolve(newDir);
      if (
        !ALLOWED_DIRS.some(
          (d) => d === dirStr || dirStr.startsWith(d + path.sep),
        )
      ) {
        log("WARN", "ALLOWED_DIR_BLOCKED", {
          dir: dirStr,
          message:
            "Dynamic ALLOWED_DIRS modification blocked for security. Use env ALLOWED_DIRS instead.",
        });
      }
      // Check if the server-owned .zombie/SSOT.md exists, if not — auto-generate
      const ssotPath = workspaceModule.ensureWorkspacePaths(newDir).ssot;
      const exists = fs.existsSync(ssotPath);
      refreshSSOT(newDir);
      // A working directory without a session is just a global switch. Bind a
      // real session so /api/sessions, the agent tool loop and a restart all
      // agree on which workspace this task owns.
      const session = ensureSessionForDir({
        sessionId: args.session_id || args.sessionId || "",
        workingDir: newDir,
        clientId: args.client_id || "mcp",
        editor: args.editor || "mcp",
        source: "mcp",
      });
      const reloaded = readSSOT(newDir);
      return {
        content: [
          {
            type: "text",
            text:
              "Working directory set to: " +
              mcpWorkingDir +
              "\nSession: " +
              session.id +
              "\n" +
              (exists
                ? "SSOT updated at: " + ssotPath
                : "SSOT auto-generated at: " + ssotPath) +
              "\n" +
              "Project: " +
              path.basename(newDir) +
              " | " +
              (reloaded ? reloaded.length + " bytes" : "unknown"),
          },
        ],
        session_id: session.id,
        working_dir: mcpWorkingDir,
      };
    }
    case "get_working_dir": {
      const sessionId = args.session_id || args.sessionId || "";
      return {
        content: [{ type: "text", text: getEffectiveDir(sessionId) }],
        session_id: sessionId || null,
        working_dir: getEffectiveDir(sessionId),
      };
    }
    case "web_search": {
      const result = await webSearch(args.query);
      if (result.success && result.results.length > 0) {
        return {
          content: [
            { type: "text", text: JSON.stringify(result.results, null, 2) },
          ],
        };
      }
      return { content: [{ type: "text", text: "No results found." }] };
    }
    case "agent_mission": {
      // Persist the session before the model runs: a random UUID that only
      // lives in this function is not a session the user can see or resume.
      const session = ensureSessionForDir({
        sessionId: args.session_id,
        workingDir: getEffectiveDir(args.session_id),
        clientId: "mcp",
        editor: "mcp",
        source: "mcp",
      });
      const sessId = session.id;
      console.log(
        "\x1b[36m\x1b[1m  [MCP] agent_mission called — wrapping with anti-dote\x1b[0m",
      );
      const result = await antiDoteMonitor(
        executeMission,
        args.input,
        null,
        sessId,
        undefined,
        sanitizeTools(args.tools, args.model),
      );
      return {
        content: [
          { type: "text", text: result.combined || "Mission completed." },
        ],
        session_id: sessId,
        working_dir: getEffectiveDir(sessId),
      };
    }
    case "agent_single": {
      const session = ensureSessionForDir({
        sessionId: args.session_id,
        workingDir: getEffectiveDir(args.session_id),
        clientId: "mcp",
        editor: "mcp",
        source: "mcp",
        agentId: args.agent_id || "",
      });
      const sessId = session.id;
      console.log(
        "\x1b[36m\x1b[1m  [MCP] agent_single called — wrapping with anti-dote\x1b[0m",
      );
      // executeSingleAgent(agentId, messages, ...) — first param is agentId,
      // NOT user input, so wrap in a closure before handing to anti-dote.
      const agentFn = async (userInput) => {
        return await executeSingleAgent(
          args.agent_id,
          [{ role: "user", content: userInput }],
          false,
          sessId,
          undefined,
          "",
        );
      };
      const result = await antiDoteMonitor(agentFn, args.input);
      return {
        content: [
          { type: "text", text: result.content || "Response generated." },
        ],
        session_id: sessId,
        working_dir: getEffectiveDir(sessId),
      };
    }
    case "get_memory": {
      const mem = args.agent_id
        ? getAgentMemory(args.session_id, args.agent_id)
        : getMemory(args.session_id);
      return {
        content: [{ type: "text", text: JSON.stringify(mem, null, 2) }],
      };
    }
    case "memory_recent": {
      const store = getProjectMemoryStore();
      if (!store) {
        return {
          content: [{ type: "text", text: "memory store unavailable (SQLite down)" }],
        };
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
      const items = store
        .recent(mcpWorkingDir || process.cwd(), limit)
        .map((a) => ({
          session_id: a.session_id,
          created_at: a.created_at,
          summary: a.summary,
          key_points: a.key_points,
          decisions: a.decisions,
          tags: a.tags,
        }));
      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
      };
    }
    case "memory_search": {
      const query = String(args.query || "").trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "memory_search: query is required" }],
        };
      }
      const store = getProjectMemoryStore();
      if (!store) {
        return {
          content: [{ type: "text", text: "memory store unavailable (SQLite down)" }],
        };
      }
      const limit = Math.max(1, Math.min(20, Number(args.limit) || 10));
      const items = store
        .find(mcpWorkingDir || process.cwd(), query, limit)
        .map((a) => ({
          session_id: a.session_id,
          created_at: a.created_at,
          summary: a.summary,
          key_points: a.key_points,
          decisions: a.decisions,
          tags: a.tags,
        }));
      return {
        content: [{ type: "text", text: JSON.stringify(items, null, 2) }],
      };
    }
    case "read_ssot": {
      const ssotContent = readSSOT();
      if (ssotContent) {
        return { content: [{ type: "text", text: ssotContent }] };
      }
      return {
        content: [
          {
            type: "text",
            text: "SSOT not found. Run set_working_dir first to auto-generate project context.",
          },
        ],
      };
    }
    case "append_syllabus": {
      const topic = String(args.topic || "").trim();
      const summary = String(args.summary || args.content || "").trim();
      if (!topic || !summary) {
        return {
          content: [
            {
              type: "text",
              text: "append_syllabus: both topic and summary are required",
            },
          ],
        };
      }
      let kp = args.keyPoints || args.key_points || [];
      if (typeof kp === "string") {
        kp = kp.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      }
      const ok = writeSyllabus(
        args.project_dir || args.projectDir || mcpWorkingDir,
        topic,
        {
          source: args.source || "Agent Session",
          summary,
          keyPoints: kp,
        },
      );
      return {
        content: [
          {
            type: "text",
            text: ok
              ? "Syllabus entry appended: " + topic
              : "append_syllabus failed — see SYLLABUS_WRITE_FAIL in log",
          },
        ],
      };
    }
    case "list_directory": {
      const listPath = args.path || ".";
      const p = path.isAbsolute(listPath)
        ? path.resolve(listPath)
        : path.resolve(workDir, listPath);
      if (outsideSession(p)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      if (!isPathSafe(p, workDir)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside allowed directories. Working dir: " +
                workDir,
            },
          ],
        };
      }
      if (!fs.existsSync(p))
        return {
          content: [{ type: "text", text: "Directory not found: " + p }],
        };
      const items = fs.readdirSync(p);
      const listing = items.map((name) => {
        const full = path.join(p, name);
        let type = "file";
        try {
          type = fs.statSync(full).isDirectory() ? "dir" : "file";
        } catch (e) { }
        return type === "dir" ? name + "/" : name;
      });
      return {
        content: [
          {
            type: "text",
            text: "Contents of " + p + ":\n" + listing.join("\n"),
          },
        ],
      };
    }
    case "open_browser": {
      let target = args.target || args.path || "";
      if (
        target &&
        !target.startsWith("http://") &&
        !target.startsWith("https://") &&
        !target.startsWith("file://")
      ) {
        // Treat as file path — resolve it
        const filePath = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(mcpWorkingDir, target);
        if (fs.existsSync(filePath)) {
          target = "file://" + filePath;
        }
      }
      // cp.exec() passes command through shell — JSON.stringify alone cannot prevent
      // backtick and $() substitution. cp.execFile bypasses shell entirely.
      if (
        target &&
        !target.startsWith("http://") &&
        !target.startsWith("https://") &&
        !target.startsWith("file://")
      ) {
        return {
          content: [
            { type: "text", text: "Invalid URL or file path: " + target },
          ],
        };
      }
      return new Promise((resolve) => {
        const cp = require("child_process");
        const platform = process.platform;
        let fileCmd, args;
        if (platform === "darwin") {
          fileCmd = "open";
          args = [target];
        } else if (platform === "win32") {
          fileCmd = "cmd";
          args = ["/c", "start", "", target];
        } else {
          fileCmd = "xdg-open";
          args = [target];
        }
        cp.execFile(fileCmd, args, { timeout: 10000 }, (err) => {
          if (err)
            resolve({
              content: [
                { type: "text", text: "Failed to open: " + err.message },
              ],
            });
          else
            resolve({
              content: [{ type: "text", text: "Opened in browser: " + target }],
            });
        });
      });
    }
    case "browse_cdp": {
      // #7: headless Chrome over --remote-debugging-pipe (fd 3/4, \0-framed
      // JSON). Zero HTTP/TCP/WebSocket in the CONTROL channel — module does
      // not open a single socket itself.
      // v2: forwards the extra inspection options (expression/selector/…) and
      // returns the whole structured result. Screenshots are written to a PNG
      // file (path returned) so OCR can read them; the legacy `screenshot`
      // action still inlines base64 for backward compatibility.
      const cdpUrl = args.url || "";
      const cdpAction = args.action || "text";
      try {
        const { browseCdp } = require("./cdp-pipe.js");
        const r = await browseCdp({
          url: cdpUrl,
          action: cdpAction,
          expression: args.expression,
          selector: args.selector,
          wait_ms: args.wait_ms,
          limit: args.limit,
          keep_open: args.keep_open,
          viewport: args.viewport,
          timeout_ms: args.timeout_ms,
        });
        const out = {
          ...r,
          transport: "cdp-pipe (fd3/4, no HTTP control channel)",
        };
        if (out.text && out.text.length > 40000) out.text = out.text.slice(0, 40000) + "\n…[truncated]";
        if (out.html && out.html.length > 40000) out.html = out.html.slice(0, 40000) + "\n…[truncated]";
        // legacy: keep base64 for the plain "screenshot" action only.
        if (cdpAction === "screenshot" && r.screenshot_path) {
          try { out.png_base64 = fs.readFileSync(r.screenshot_path).toString("base64"); } catch (_) {}
        }
        return { content: [{ type: "text", text: JSON.stringify(out) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: false, error: e.message, url: cdpUrl }) },
          ],
        };
      }
    }
    case "call_agent": {
      const targetAgentId = args.agent_id || "";
      const task = args.task || "";
      const context = args.context || "";
      const sessId = args.session_id || crypto.randomUUID();

      const callAgent = AGENTS.find((a) => a.id === targetAgentId);
      if (!callAgent) {
        return {
          content: [
            {
              type: "text",
              text: "Agent not found: " + targetAgentId,
            },
          ],
        };
      }

      const fullTask = context
        ? task + "\n\n### Task Context\n" + context
        : task;
      const result = await executeSingleAgent(
        targetAgentId,
        [{ role: "user", content: fullTask }],
        false,
        sessId,
        undefined,
        "",
      );

      return {
        content: [
          {
            type: "text",
            text:
              result.content ||
              "[Agent " + targetAgentId + " responded but no content]",
          },
        ],
      };
    }

    // [MB-HANDLERS-2026] real-world tool handlers
    case "db_query": {
      const q = (args && args.query) ? String(args.query) : "";
      if (!q.trim()) return { content: [{ type: "text", text: "Empty query" }] };
      try {
        const result = await runDbQuery(q, args.database);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "db_query error: " + e.message }] };
      }
    }
    case "db_list_tables": {
      try {
        const tables = await listDbTables(args && args.database);
        return { content: [{ type: "text", text: JSON.stringify(tables, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text", text: "db_list_tables error: " + e.message }] };
      }
    }
    case "exec": {
      const cmd = (args && args.command) ? String(args.command) : "";
      if (!cmd.trim()) return { content: [{ type: "text", text: "Empty command" }] };
      const cwd = (args && args.cwd)
        ? (path.isAbsolute(args.cwd) ? path.resolve(args.cwd) : path.resolve(workDir || ".", args.cwd))
        : (workDir || ".");
      if (outsideSession(cwd)) {
        return {
          content: [
            {
              type: "text",
              text:
                "Access denied: path is outside the session working directory (" +
                workDir +
                ")",
            },
          ],
        };
      }
      const timeout = parseInt((args && args.timeout), 10) || parseInt(process.env.EXEC_TIMEOUT || "30000", 10);
      const maxBuffer = parseInt(process.env.EXEC_MAX_BUFFER || String(8 * 1024 * 1024), 10);
      const shell = _IS_WINDOWS
        ? (process.env.EXEC_SHELL_WIN || "powershell.exe")
        : (process.env.EXEC_SHELL_LINUX || "/bin/bash");
      return await new Promise((resolve) => {
        const ch = require("child_process").exec(cmd, {
          cwd: cwd,
          timeout: timeout,
          maxBuffer: maxBuffer,
          shell: shell,
          env: Object.assign({}, process.env, (args && args.env) || {}),
        }, (error, stdout, stderr) => {
          const exitCode = (error && typeof error.code === "number") ? error.code : (error ? 1 : 0);
          const text = "$ " + cmd + "\n(cwd: " + cwd + " | shell: " + shell + ")\n\n"
            + (stdout ? "[stdout]\n" + String(stdout).slice(0, 100000) + "\n" : "")
            + (stderr ? "[stderr]\n" + String(stderr).slice(0, 100000) + "\n" : "")
            + "[exit] " + exitCode;
          resolve({ content: [{ type: "text", text: text }] });
        });
        ch.on("error", (err) => {
          resolve({ content: [{ type: "text", text: "exec error: " + err.message }] });
        });
      });
    }
    case "http_request": {
      const url = (args && args.url) ? String(args.url) : "";
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: "text", text: "Invalid URL (must be http/https): " + url }] };
      }
      const method = String((args && args.method) || "GET").toUpperCase();
      const headers = (args && args.headers) || {};
      const body = (args && args.body != null) ? String(args.body) : null;
      const timeout = parseInt((args && args.timeout), 10) || parseInt(process.env.HTTP_TIMEOUT || "30000", 10);
      return await new Promise((resolve) => {
        const lib = url.startsWith("https://") ? require("https") : require("http");
        const u = new URL(url);
        const opts = { method: method, headers: headers, timeout: timeout };
        const req = lib.request(u, opts, (res) => {
          let data = "";
          res.on("data", (c) => { data += c; });
          res.on("end", () => {
            const text = "HTTP " + res.statusCode + " " + (res.statusMessage || "") + "\n\n" + data.slice(0, 100000);
            resolve({ content: [{ type: "text", text: text }] });
          });
        });
        req.on("error", (err) => { resolve({ content: [{ type: "text", text: "http_request error: " + err.message }] }); });
        req.on("timeout", () => {
          req.destroy();
          resolve({ content: [{ type: "text", text: "http_request timed out after " + timeout + "ms" }] });
        });
        if (body) req.write(body);
        req.end();
      });
    }
    case "env_get": {
      const key = (args && args.key) ? String(args.key) : "";
      if (!key) return { content: [{ type: "text", text: "Empty key" }] };
      const val = process.env[key];
      if (val === undefined) return { content: [{ type: "text", text: "ENV '" + key + "' not set" }] };
      const isSecret = /KEY|SECRET|PASSWORD|TOKEN|AUTH/i.test(key);
      if (isSecret && !(args && args.reveal_secrets)) {
        return { content: [{ type: "text", text: key + " is set (value hidden). Use reveal_secrets=true to show it." }] };
      }
      return { content: [{ type: "text", text: key + "=" + val }] };
    }
    case "system_info": {
      const osMod = require("os");
      const info = {
        platform: process.platform,
        arch: process.arch,
        os: _IS_WINDOWS ? "Windows" : (_IS_LINUX ? "Linux" : (_IS_MACOS ? "macOS" : process.platform)),
        hostname: osMod.hostname(),
        node: process.version,
        cwd: process.cwd(),
        mcpWorkingDir: mcpWorkingDir,
        uptime_sec: Math.round(process.uptime()),
        memory_mb: Math.round(osMod.totalmem() / 1048576),
        envKeys: Object.keys(process.env).sort().filter((k) => !/KEY|SECRET|PASSWORD|TOKEN|AUTH/i.test(k)),
        dbConfig: {
          type: process.env.DB_TYPE || "not-configured",
          host: process.env.DB_HOST || "",
          port: process.env.DB_PORT || "",
          user: process.env.DB_USER || "",
          name: process.env.DB_NAME || "",
          sqlitePath: process.env.DB_SQLITE_PATH || "",
          timeout: process.env.DB_TIMEOUT || "",
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
    }

    default: {
      // EXTERNAL TOOL CONNECTOR proxy — forward to registered external URL
      const ext = EXTERNAL_TOOLS.get(tool);
      if (ext) {
        log("INFO", "EXTERNAL_TOOL_CALL", { tool, url: ext.url });
        return await new Promise((resolve) => {
          const body = JSON.stringify({ tool, arguments: args || {} });
          const headers = { "Content-Type": "application/json" };
          if (ext.key) headers["Authorization"] = "Bearer " + ext.key;
          const req = http.request(
            ext.url,
            { method: ext.method || "POST", headers, timeout: 30000 },
            (res) => {
              let data = "";
              res.on("data", (c) => (data += c));
              res.on("end", () => {
                try {
          const parsed = JSON.parse(data);
                  resolve({
                    content: parsed.content || [
                      { type: "text", text: JSON.stringify(parsed).slice(0, 50000) },
                    ],
                  });
                } catch (e) {
                  resolve({ content: [{ type: "text", text: data.slice(0, 50000) }] });
                }
              });
            }
          );
          req.on("error", (err) => {
            resolve({ content: [{ type: "text", text: "External tool " + tool + " error: " + err.message }] });
          });
          req.on("timeout", () => {
            req.destroy();
            resolve({ content: [{ type: "text", text: "External tool " + tool + " timed out after 30s" }] });
          });
          req.write(body);
          req.end();
        });
      }
      throw { code: -32601, message: "Tool not found: " + tool };
    }
  }
}


// =============================================================================
// [MB-HELPERS-2026] Real-world tool helpers: dbEnv, findPhp, execFileSyncSafe,
// runDbQuery, listDbTables. Config from env vars ONLY. Cross-platform.
// =============================================================================
function dbEnv() {
  return {
    type: (process.env.DB_TYPE || "sqlite").toLowerCase(),
    host: process.env.DB_HOST || "localhost",
    port: process.env.DB_PORT || "",
    user: process.env.DB_USER || "",
    password: process.env.DB_PASSWORD || "",
    name: process.env.DB_NAME || "",
    sqlitePath: process.env.DB_SQLITE_PATH || "",
    timeout: parseInt(process.env.DB_TIMEOUT || "15000", 10),
  };
}

function findPhp() {
  const candidates = [];
  if (process.env.PHP_BIN) candidates.push(process.env.PHP_BIN);
  candidates.push("php");
  if (_IS_WINDOWS) {
    candidates.push(
      "C:\\xampp\\php\\php.exe",
      "C:\\laragon\\bin\\php\\php.exe",
      "C:\\wamp64\\bin\\php\\php.exe",
      "C:\\php\\php.exe"
    );
  }
  for (const c of candidates) {
    try {
      const r = require("child_process").spawnSync(c, ["-v"], { timeout: 5000, stdio: "pipe" });
      if (r.status === 0) return c;
    } catch (_) { }
  }
  return null;
}

function execFileSyncSafe(cmd, args, opts) {
  try {
    const r = require("child_process").spawnSync(
      cmd,
      args,
      Object.assign({ timeout: 30000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", stdio: "pipe" }, opts || {})
    );
    if (r.status === 0) return { ok: true, out: String(r.stdout || "").trim() };
    return { ok: false, err: String(r.stderr || "").trim() || String(r.stdout || "").trim() || ("exit " + r.status) };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function mysqlOrPg(cfg, dbOverride, mode, query) {
  const php = findPhp();
  if (!php) {
    throw new Error(
      "No PHP binary found for " + cfg.type + " queries. Set PHP_BIN env (e.g. C:\\xampp\\php\\php.exe) or install PHP with PDO."
    );
  }
  if (!fs.existsSync(BRIDGE)) {
    throw new Error("db-bridge.php not found at: " + BRIDGE);
  }
  const driver = (cfg.type === "pgsql" || cfg.type === "postgres") ? "pgsql" : "mysql";
  const dbname = dbOverride || cfg.name || "";
  const r = require("child_process").spawnSync(
    php,
    [BRIDGE, driver, dbname, mode],
    { input: query || "", encoding: "utf8", timeout: cfg.timeout, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }
  );
  if (r.status !== 0) {
    throw new Error("PHP bridge failed: " + String(r.stderr || r.stdout || "exit " + r.status).trim());
  }
  const out = String(r.stdout || "").trim();
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error("PHP bridge returned non-JSON: " + out.slice(0, 500));
  }
}

async function runDbQuery(query, dbOverride) {
  const cfg = dbEnv();
  const q = String(query || "").trim();
  if (!q) throw new Error("Empty query");

  // SQLite -> Node built-in node:sqlite (zero-dep, cross-platform)
  if (cfg.type === "sqlite" || cfg.type === "sqlite3") {
    const dbPath = dbOverride || cfg.sqlitePath;
    if (!dbPath) throw new Error("DB_SQLITE_PATH env not set (or pass database=<path>)");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: false });
    try {
      const isSelect = /^\s*(select|pragma|show|explain|with)\b/i.test(q);
      if (isSelect) {
        const stmt = db.prepare(q);
        const rows = stmt.all();
        return { ok: true, db: cfg.type, path: dbPath, rowCount: rows.length, rows: rows };
      }
      const changes = db.exec(q);
      return { ok: true, db: cfg.type, path: dbPath, changes: changes };
    } finally {
      db.close();
    }
  }

  // MySQL / PostgreSQL -> PHP PDO bridge
  if (cfg.type === "mysql" || cfg.type === "pgsql" || cfg.type === "postgres") {
    return mysqlOrPg(cfg, dbOverride, "query", q);
  }

  throw new Error("Unsupported DB_TYPE '" + cfg.type + "'. Use mysql, sqlite or pgsql. Config via env vars.");
}

async function listDbTables(dbOverride) {
  const cfg = dbEnv();
  if (cfg.type === "sqlite" || cfg.type === "sqlite3") {
    const dbPath = dbOverride || cfg.sqlitePath;
    if (!dbPath) throw new Error("DB_SQLITE_PATH env not set");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return { ok: true, db: cfg.type, tables: rows.map((r) => r.name) };
    } finally {
      db.close();
    }
  }
  if (cfg.type === "mysql" || cfg.type === "pgsql" || cfg.type === "postgres") {
    return mysqlOrPg(cfg, dbOverride, "tables", "");
  }
  throw new Error("Unsupported DB_TYPE '" + cfg.type + "'. Use mysql, sqlite or pgsql. Config via env vars.");
}


// Simple glob matcher (* and ** and {a,b} support) used by the glob tool
function matchGlob(relPath, pattern) {
  if (!pattern) return false;
  const p = pattern.replace(/\\/g, "/");
  const r = relPath.replace(/\\/g, "/");
  const rx = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__GLOBSTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__GLOBSTAR__/g, ".*")
    .replace(/\{([^}]+)\}/g, "($1)");
  try {
    return new RegExp("^" + rx + "$").test(r);
  } catch {
    return r.includes(pattern);
  }
}

function handleMCP(req, res) {
  const startTime = Date.now();
  const clientNameFromHeader = req.headers["x-mcp-client-name"] || "";
  const workspaceIdFromHeader = req.headers["x-zc-workspace-id"] || "";
  let clientDirFromHeader = req.headers["x-mcp-client-dir"] || "";
  // Handle unexpanded ${workspaceFolder} — can't auto-detect, skip
  if (
    clientDirFromHeader.includes("${workspaceFolder}") ||
    clientDirFromHeader.includes("${workspaceRoot}")
  ) {
    log("WARN", "MCP_HEADER_UNEXPANDED", {
      header: "X-MCP-Client-Dir",
      value: clientDirFromHeader,
      message:
        "Cursor/VSCode variable not expanded. Ensure your MCP client supports variable expansion in headers.",
    });
    clientDirFromHeader = "";
  }

  readBody(req).then((body) => {
    let message;
    try {
      message = JSON.parse(body);
    } catch (e) {
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 400,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    const { id, method, params } = message;

    const headerCheck = mcpProtocol.validateMcpHeaders(req.headers);
    if (!headerCheck.ok) {
      log("WARN", "MCP_HEADER_REJECTED", {
        client: clientNameFromHeader || "unknown",
        errors: headerCheck.errors.map((error) => error.code),
        // The code alone cannot be acted on: 15 rejections sat in the log with
        // no value to compare against. Field + value make it diagnosable.
        detail: headerCheck.errors.map(
          (error) => error.field + "=" + String(error.value || "").slice(0, 80),
        ),
      });
      jsonResponse(res, 400, {
        jsonrpc: "2.0",
        id: id === undefined ? null : id,
        error: {
          code: -32600,
          message:
            "Invalid MCP headers: " +
            headerCheck.errors
              .map((error) => error.field + " " + error.message)
              .join("; "),
          data: headerCheck.errors,
        },
      });
      return;
    }

    const forwardNotice = mcpProtocol.noteForwardProtocol(
      headerCheck,
      clientNameFromHeader,
    );
    if (forwardNotice) log("INFO", "MCP_PROTOCOL_FORWARD", forwardNotice);

    if (method === "initialize") {
      const clientName =
        params?.clientInfo?.name || clientNameFromHeader || "unknown";
      const clientVersion = params?.clientInfo?.version || "unknown";
      const negotiated = mcpProtocol.negotiateProtocolVersion(params?.protocolVersion);
      const editor = mcpProtocol.detectEditor(params?.clientInfo, req.headers);
      mcpActiveConnections++;
      rememberMcpIdentity(req, {
        client: clientName !== "unknown" ? clientName : clientNameFromHeader,
        agent: params?.agent_id || params?.clientInfo?.agent,
      });
      log("INFO", "MCP_INIT", {
        client: clientName,
        version: clientVersion,
        protocol: negotiated.requested || "unknown",
        negotiated: negotiated.version,
        fallback: negotiated.fallback,
        editor: editor ? editor.id : "",
        id: id?.toString().slice(0, 8),
        ...requestActor(req),
      });
      // Always track clients — anonymous gets generated name
      const effectiveName =
        clientName !== "unknown"
          ? clientName
          : "anonymous-" +
          (id?.toString().slice(0, 6) ||
            Math.random().toString(36).slice(2, 8));
      const now = new Date().toISOString();

      // ── MCP Client Roots Detection ────────────────────────────
      // Detect client project directory via params.roots or X-MCP-Client-Dir header
      // Priority: 1) params.roots  2) X-MCP-Client-Dir header
      function parseFileUri(uri) {
        if (!uri || typeof uri !== "string") return "";
        const m = uri.match(/^file:\/\/([^/].*)$/);
        if (m) return decodeURIComponent(m[1]);
        try {
          return decodeURIComponent(uri.replace(/^file:\/\//, ""));
        } catch {
          return "";
        }
      }

      let detectedDir = "";
      const rawRoots = params?.roots;
      const boot = mcpProtocol.bootstrapWorkspace({
        roots: rawRoots,
        workspaceId: workspaceIdFromHeader,
        headerDir: clientDirFromHeader,
        env: process.env,
        // A bare cwd must be the stable project root, never the mutable
        // working directory a previous request selected.
        cwd: CHECKOUT_ROOT,
        seedSSOT: (dir) => {
          try {
            return generateSSOT(dir, scanProject(dir));
          } catch (_) {
            return "";
          }
        },
      });
      if (boot.source !== "cwd") {
        detectedDir = boot.dir;
        mcpWorkingDir = detectedDir;
        log("INFO", "MCP_WORKSPACE_DETECTED", {
          client: clientName,
          dir: detectedDir,
          source: boot.source,
          created: boot.created.length,
        });
      } else {
        log("INFO", "MCP_WORKSPACE_FALLBACK", {
          client: clientName,
          dir: boot.dir,
          source: boot.source,
        });
      }

      // A compact 12-hex id is the transport-safe workspace handle: UDS/gRPC
      // headers carry this instead of the full directory path.
      if (detectedDir) {
        const workspaceId = workspaceAdapter.registerWorkspace(detectedDir);
        res.setHeader("x-zc-workspace-id", workspaceId);
        log("INFO", "WORKSPACE_ID", { id: workspaceId, dir: detectedDir });
      }

      // Seed a real scan only when the SSOT did not exist before this connect;
      // an existing SSOT (plugin-written) is the source of truth.
      let ssotResult = null;
      if (detectedDir) {
        ssotResult = boot.created.includes(boot.paths.ssot)
          ? refreshSSOT(detectedDir)
          : readSSOT(detectedDir) || null;
        log("INFO", "MCP_AUTO_SSOT", {
          client: clientName,
          dir: detectedDir,
          ssot: ssotResult ? ssotResult.length + " bytes" : "failed",
          created: boot.created.includes(boot.paths.ssot),
          message: "SSOT ready in " + detectedDir,
        });
      }

      // Handshake: guarantee .zombiecoder/ exists + working dir set
      ensureZombiecoderDir(detectedDir || boot.dir);

      const sessionId = mcpProtocol.sessionIdFor({
        editor,
        workspaceDir: boot.dir,
      });
      const clientData = {
        name: effectiveName,
        version: clientVersion,
        protocolVersion: negotiated.version,
        requestedProtocolVersion: negotiated.requested,
        protocolFallback: negotiated.fallback,
        editor: editor ? editor.id : "",
        connected_at: now,
        last_seen: now,
        status: "active",
        working_dir: mcpWorkingDir || "",
        detected_dir: detectedDir || "",
        session_id: sessionId,
        request_id: id?.toString().slice(0, 8) || "",
        tools_used: 0,
        anonymous: clientName === "unknown",
      };
      mcpClients.set(effectiveName, clientData);
      saveClient(clientData);

      const hasRoots = boot.source === "mcp-roots" || boot.source === "header";
      const hasWorkspace = boot.source !== "cwd";
      log("INFO", "MCP_CLIENT_CONNECTED", {
        name: effectiveName,
        anonymous: clientName === "unknown",
        has_roots: hasRoots,
        has_workspace: hasWorkspace,
        source: boot.source,
        message: hasWorkspace
          ? "Client '" +
            effectiveName +
            "' connected. Workspace ready at " +
            detectedDir +
            " (source: " +
            boot.source +
            ")."
          : "Client '" +
            effectiveName +
            "' connected (no workspace). Use set_working_dir to set project dir.",
      });

      // Build SSOT info for response
      let ssotInfo = "";
      if (detectedDir) {
        const clientSSOT = readSSOT(detectedDir);
        if (clientSSOT) {
          ssotInfo =
            "CLIENT SSOT: " +
            detectedDir +
            "/.zombie/SSOT.md (" +
            clientSSOT.length +
            " bytes) for project: " +
            path.basename(detectedDir);
        } else {
          ssotInfo =
            "Roots detected but SSOT generation pending for: " + detectedDir;
        }
      } else {
        const serverSSOT = readSSOT(path.resolve("."));
        const serverInfo = serverSSOT
          ? " (" + serverSSOT.length + " bytes)"
          : " (not found)";
        ssotInfo =
          "No client roots detected. Server SSOT at " +
          path.resolve(".", ".zombie", "SSOT.md") +
          serverInfo +
          ". Send roots in initialize or header X-MCP-Client-Dir to auto-generate client SSOT.";
      }

      const initResult = mcpProtocol.buildInitializeResult({
        requestedVersion: params?.protocolVersion,
        clientInfo: params?.clientInfo,
        headers: req.headers,
        workspace: { dir: detectedDir || boot.dir },
        rootsDetected: hasRoots,
        serverVersion: DOMAIN_CFG.version,
        domain: DETECTED_DOMAIN,
        serverType: DOMAIN_CFG.type,
        transport: "http",
        serverInfo: {
          ssot: ssotInfo,
          instructions:
            "Send roots via MCP initialize params or X-MCP-Client-Dir header for auto SSOT generation.",
        },
      });
      res.setHeader("MCP-Protocol-Version", initResult.protocolVersion);
      res.setHeader("Mcp-Session-Id", sessionId);
      jsonResponse(res, 200, {
        jsonrpc: "2.0",
        id,
        result: initResult,
      });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    if (method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }

    // Handle workspace change notifications — auto-update SSOT
    if (method === "workspace/didChangeWorkspaceFolders") {
      const folders = params?.folders || [];
      let newRootDir = "";
      for (const f of folders) {
        const uri = f?.uri || "";
        const fp = parseFileUri(uri);
        if (fp && fs.existsSync(fp)) {
          newRootDir = path.resolve(fp);
          break;
        }
      }
      if (newRootDir && newRootDir !== mcpWorkingDir) {
        mcpWorkingDir = newRootDir;
        refreshSSOT(newRootDir);
        log("INFO", "MCP_WORKSPACE_CHANGED", {
          dir: newRootDir,
          ssot: "auto-regenerated",
        });
      }
      res.writeHead(202);
      res.end();
      return;
    }

    // Handle roots/list_changed — client updated its roots
    if (
      method === "roots/list_changed" ||
      method === "notifications/roots/list_changed"
    ) {
      // Client will likely send a new initialize or the roots can be re-fetched
      // For now, just ack — if client re-initializes, we'll catch roots then
      log("INFO", "MCP_ROOTS_CHANGED", {
        client: clientNameFromHeader || "unknown",
        message: "Roots changed notification received",
      });
      res.writeHead(202);
      res.end();
      return;
    }

    if (method === "tools/list") {
      const tools = Object.entries(MCP_TOOLS)
        .filter(([name]) => toolEnabled(name)) // respect admin on/off
        .map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: {
            type: "object",
            properties: def.params,
            required: def.required,
          },
        }));
      log("INFO", "MCP_TOOLS_LIST", { count: tools.length, ...requestActor(req) });
      jsonResponse(res, 200, { jsonrpc: "2.0", id, result: { tools } });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params || {};
      rememberMcpIdentity(req, {
        agent: params?.agent_id || (args && (args.agent_id || args.agent)) || "",
      });
      // SECURITY GATE — privileged tools need auth (see mcpGate above).
      // res===null means the in-process call from handleMessage (trusted).
      const gateErr = mcpGate(req, name, res === null);
      if (gateErr) {
        log("WARN", "MCP_GATE_DENIED", {
          tool: name,
          origin: (req.headers && req.headers.origin) || "none",
          remote: req.socket && req.socket.remoteAddress,
          code: gateErr.code,
        });
        jsonResponse(res, 401, { jsonrpc: "2.0", id, error: gateErr });
        log("INFO", "REQUEST", {
          method: "POST",
          url: "/mcp",
          status: 401,
          elapsed: Date.now() - startTime,
          error: gateErr.message,
        });
        return;
      }
      log("INFO", "MCP_TOOLS_CALL", { tool: name, ...requestActor(req) });
      trackToolUsage(name);
      executeMcpTool(name, args || {})
        .then((result) => {
          jsonResponse(res, 200, { jsonrpc: "2.0", id, result });
          log("INFO", "REQUEST", {
            method: "POST",
            url: "/mcp",
            status: 200,
            elapsed: Date.now() - startTime,
          });
        })
        .catch((error) => {
          trackToolUsage(name, true);
          jsonResponse(res, 200, {
            jsonrpc: "2.0",
            id,
            error: { code: error.code || -32000, message: error.message },
          });
          log("INFO", "REQUEST", {
            method: "POST",
            url: "/mcp",
            status: 200,
            elapsed: Date.now() - startTime,
          });
        });
      return;
    }

    if (method === "ping") {
      // Heartbeat — update client last_seen if client info available
      const pingClient = params?.clientName || clientNameFromHeader || "";
      if (pingClient && pingClient !== "unknown") {
        updateClientHeartbeat(pingClient);
        log("INFO", "HEARTBEAT", {
          client: pingClient,
          at: new Date().toISOString(),
        });
      }
      jsonResponse(res, 200, { jsonrpc: "2.0", id, result: {} });
      log("INFO", "REQUEST", {
        method: "POST",
        url: "/mcp",
        status: 200,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    jsonResponse(res, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + method },
    });
    log("INFO", "REQUEST", {
      method: "POST",
      url: "/mcp",
      status: 200,
      elapsed: Date.now() - startTime,
    });
  });
}

// ─── Handle MCP message over Unix Domain Socket ──────────────
// Reuses the same MCP_TOOLS as handleMCP, but writes to a socket
// instead of HTTP response. Used by UDS server for JetBrains MCP.
function handleUdsMcpMessage(socket, message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    // Handshake: guarantee .zombiecoder/ exists + working dir set
    const boot = mcpProtocol.bootstrapWorkspace({
      roots: params?.roots,
      env: process.env,
      cwd: CHECKOUT_ROOT,
      seedSSOT: (dir) => {
        try {
          return generateSSOT(dir, scanProject(dir));
        } catch (_) {
          return "";
        }
      },
    });
    if (boot.source !== "cwd") mcpWorkingDir = boot.dir;
    if (boot.created.includes(boot.paths.ssot)) refreshSSOT(boot.dir);
    const udsDir = ensureZombiecoderDir(boot.dir);
    const editor = mcpProtocol.detectEditor(params?.clientInfo);
    const sessionId = mcpProtocol.sessionIdFor({ editor, workspaceDir: boot.dir });
    const initResult = mcpProtocol.buildInitializeResult({
      requestedVersion: params?.protocolVersion,
      clientInfo: params?.clientInfo,
      workspace: { dir: boot.dir },
      rootsDetected: boot.source !== "cwd",
      serverVersion: DOMAIN_CFG.version,
      domain: DETECTED_DOMAIN,
      serverType: DOMAIN_CFG.type,
      transport: "uds",
      serverInfo: {
        zombiecoder_dir: udsDir ? udsDir.dir : "",
        transport: "uds",
        session_id: sessionId,
      },
    });
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: initResult,
      }) + "\n",
    );
    return;
  }
  if (method === "notifications/initialized" || method === "ping") {
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n");
    return;
  }
  if (method === "tools/list") {
    const tools = Object.entries(MCP_TOOLS)
      .filter(([name]) => toolEnabled(name)) // respect admin on/off
      .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: {
          type: "object",
          properties: def.params,
          required: def.required,
        },
      }));
    socket.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: { tools },
        source: "uds",
      }) + "\n",
    );
    return;
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params || {};
    // count UDS-origin tool calls too (HTTP path counts its own)
    trackToolUsage(name);
    // SECURITY NOTE (2026-10-08): NO token gate on UDS — deliberate.
    // The socket is created as srw-rw---- (owner+group xubuntu only), so a
    // caller must already be able to open that file, i.e. run as this same
    // local user. Such a process can already exec commands directly, so a
    // token here would add ceremony without adding privilege separation.
    // The NETWORK paths (HTTP POST /mcp + WebSocket) are the ones gated by
    // mcpGate() above — those are reachable by other hosts/browsers.
    executeMcpTool(name, args || {})
      .then((result) => {
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { ...result, source: "uds" },
          }) + "\n",
        );
      })
      .catch((error) => {
        trackToolUsage(name, true);
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: error.code || -32000, message: error.message },
          }) + "\n",
        );
      });
    return;
  }
  socket.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: "Method not found: " + method },
    }) + "\n",
  );
}

// 
//  IDENTITY MASKING + WATERMARK STRIPPING
// 
// Removes hidden watermarks, invisible unicode chars, model identity
// Per V0_PLATFORM_INDEPENDENT_CONTRACT.md: NO hidden watermarks or branding
function maskModelIdentity(text) {
  if (!text || typeof text !== "string") return text;

  // Step 1: canonical + invisible-character cleanup (lib/text-integrity.js).
  // NFC keeps Bengali nukta forms consistent; ZWNJ/ZWJ rules stay script-aware.
  let cleaned = normalizeText(text);

  // Reasoning models emit private chain-of-thought inside <think>...</think>.
  // It is not part of the answer. Drop the whole block, then any tag that
  // survived a truncated stream (an unclosed block means the answer never
  // started, so the remainder is reasoning too).
  cleaned = cleaned
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/i, "")
    .replace(/<\/?think\b[^>]*>/gi, "");

  // Step 2a: Strip every model name configured for this deployment. Derived
  // from PROVIDER_CONFIG at runtime so no model literal lives in this file.
  for (const provider of Object.values(PROVIDER_CONFIG)) {
    for (const model of provider.models || []) {
      for (const name of [getModelName(model), getApiModelName(model)]) {
        if (!name || name.length < 3) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        cleaned = cleaned.replace(new RegExp(escaped, "gi"), "");
      }
    }
  }

  // Step 2b: Strip model/company identity watermarks from text
  cleaned = cleaned
    .replace(
      /I am (?:a |an )?(?:large language model|AI|LLM|language model) (?:trained|developed|created|built) by [^.!?\\n]+[.!?]?/gi,
      "",
    )
    .replace(
      /(?:I'm|I am) (?:from |by |made by )?(?:OpenAI|Google|DeepSeek|Meta|Anthropic|Mistral|Cohere|Alibaba|Baichuan)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /(?:GPT|Gemini|DeepSeek|Llama|Claude|Mistral|Qwen|Yi|Baichuan)[-\\s]?(?:4|3\\.5|v[234]|70B|8B|3)?[,.]?\\s*(?:trained|by|from|is a|model)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /As (?:an |a )?(?:AI|LLM|large language model|language model),?/gi,
      "",
    )
    // Strip "Powered by", "built on", "running on" branding
    .replace(
      /[Pp]owered by (?:OpenAI|ZombieCoder|Mission Barisal|AI)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    .replace(
      /[Rr]unning on (?:OpenAI|Groq|Gemini|DeepSeek|Claude)[^.!?\\n]*[.!?]?/gi,
      "",
    )
    // Strip any "Model: xxx . Provider: xxx" footers
    .replace(/Model:\\s*\\S+\\s*[.\\s]Provider:\\s*\\S+/gi, "")
    // Strip "Provided by X" or "Courtesy of X"
    .replace(
      /(?:Provided by|Courtesy of|Brought to you by)[^.!?\\n]+[.!?]?/gi,
      "",
    )
    // Contract says NO watermarks — these catch additional provider branding
    .replace(
      /(?:Made with|Built with|Powered by|Created by|Developed by|Designed by|Crafted by)\s+\w+[^.!?\n]*[.!?\n]?/gi,
      "",
    )
    .replace(
      /\b(?:ChatGPT|OpenAI|GPT-\d|Claude|Anthropic|Gemini|Google AI|Meta AI|Llama)\b[^.!?\n]*(?:powered|built|created|trained)[^.!?\n]*[.!?\n]?/gi,
      "",
    )
    .replace(
      /\bThis (?:response|output|answer|reply) (?:was |is )?(?:generated|created|produced|provided) (?:by|using|with)\s+[^.!?\n]+[.!?\n]?/gi,
      "",
    )
    .replace(
      /\b(?:AI assistant|language model|LLM|neural network|deep learning model)\s*[-–—:]\s*[^.!?\n]+[.!?\n]?/gi,
      "",
    )
    .trim();

  if (cleaned !== text) {
    log("WARN", "WATERMARK_STRIPPED", {
      original_length: text.length,
      clean_length: cleaned.length,
      chars_removed: text.length - cleaned.length,
    });
  }

  return cleaned;
}

// The mission route used to carry this five-regex cleanup twice (stream and
// non-stream), byte-for-byte. One helper keeps both paths identical.
function stripMissionChatArtifacts(text) {
  if (!text) return text;
  return String(text)
    .replace(/The user asked "[^"]*" which is Bengali for "[^"]*"\n\n?/g, "")
    .replace(/I need to check the (?:agents'|agent) reports\.?\s*\n?/g, "")
    .replace(/Let me (?:search|check|verify|look|read|see)[^.]*\.?\s*\n?/g, "")
    .replace(/Since the user is asking in Bengali, I should answer in Bengali\.?\s*\n?/g, "")
    .replace(
      /^((?:Code Guru|Bug Hunter|Security|Performance|Doc King|QA Tyrant|\u09ae\u09a8\u09c1|\u099c\u09c1\u09af\u09bc\u09c7\u09b2|\u09ac\u09c3\u09b7\u09cd\u099f\u09bf|\u09b0\u09be\u09b6\u09c7\u09a6|\u09b9\u09be\u09b2\u09bf\u09ae|\u09ae\u099c\u09a8\u09c1).{0,50}(started|gave|says|mentioned|noted|pointed out)).{0,200}\n/gim,
      "",
    )
    .trim();
}
// 
//  GOAL VERIFICATION — Type Safety Before Output
// 
// Checks if output meets goal criteria BEFORE sending to user.
// If output is invalid, blocks it and returns error message.
function verifyGoalOutput(content, userInput) {
  if (!content || typeof content !== "string") {
    return {
      passed: false,
      reason: "empty_output",
      message:
        "\u09ad\u09be\u0987\u09af\u09bc\u09be, \u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7 \u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u098f\u0987 \u09a4\u09a5\u09cd\u09af\u0997\u09c1\u09b2\u09cb \u09a8\u09be\u0987। \u098f\u099c\u09c7\u09a8\u09cd\u099f \u0995\u09cb\u09a8\u09cb \u0989\u09a4\u09cd\u09a4\u09b0 \u09a4\u09c8\u09b0\u09bf \u0995\u09b0\u09a4\u09c7 \u09aa\u09be\u09b0\u09c7\u09a8\u09bf।",
    };
  }

  const trimmed = content.trim();

  // Check 1: empty or punctuation-only output. A short answer is not a bad
  // answer — "CWD-OK" or "yes" is exactly what the caller asked for, and a
  // 10-character floor used to replace correct replies with a canned excuse.
  if (trimmed.length === 0 || !/[\p{L}\p{N}]/u.test(trimmed)) {
    return {
      passed: false,
      reason: "too_short",
      message:
        "\u09ad\u09be\u0987\u09af\u09bc\u09be, \u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7 \u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u098f\u0987 \u09a4\u09a5\u09cd\u09af\u0997\u09c1\u09b2\u09cb \u09a8\u09be\u0987। \u0989\u09a4\u09cd\u09a4\u09b0\u099f\u09bf \u0996\u09c1\u09ac\u0987 \u09b8\u0982\u0995\u09cd\u09b7\u09bf\u09aa\u09cd\u09a4।",
    };
  }

  // Check 2: Contains thinking/reasoning artifacts (should not reach user)
  // Only block if the ENTIRE response is thinking, not if thinking appears mid-response
  const thinkingPatterns = [
    /^(I need to|I will now|Let me|\u0986\u09ae\u09bf \u098f\u0996\u09a8|\u098f\u0996\u09a8 \u0986\u09ae\u09bf|\u0986\u09ae\u09be\u0995\u09c7 \u098f\u0996\u09a8)\b/im,
    /^(Combining|merging|\u098f\u0995\u09a4\u09cd\u09b0\u09bf\u09a4|Merging)\b/im,
    /^(Based on the analysis|After reviewing|\u09ac\u09bf\u09b6\u09cd\u09b2\u09c7\u09b7\u09a3\u09c7\u09b0 \u09aa\u09b0)\b/im,
    /^(The combined response|Here is the merged output)\b/im,
    /^(I will combine|Let me merge|\u0986\u09ae\u09bf \u098f\u0996\u09a8 \u098f\u0995\u09a4\u09cd\u09b0\u09bf\u09a4 \u0995\u09b0\u09ac)\b/im,
  ];
  // Only block if the first 100 chars match thinking patterns
  const firstChunk = trimmed.slice(0, 100);
  let hasThinkingArtifact = false;
  for (const pat of thinkingPatterns) {
    if (pat.test(firstChunk)) {
      hasThinkingArtifact = true;
      break;
    }
  }
  if (hasThinkingArtifact) {
    return {
      passed: false,
      reason: "thinking_artifact",
      message:
        "\u09ad\u09be\u0987\u09af\u09bc\u09be, \u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7 \u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u098f\u0987 \u09a4\u09a5\u09cd\u09af\u0997\u09c1\u09b2\u09cb \u09a8\u09be\u0987। \u098f\u099c\u09c7\u09a8\u09cd\u099f \u09a4\u09be\u09b0 \u09ad\u09be\u09ac\u09a8\u09be\u09b0 \u0985\u0982\u09b6 \u09aa\u09be\u09a0\u09bf\u09af\u09bc\u09c7\u099b\u09c7।",
    };
  }

  // Check 3: Model identity leak
  const identityLeak =
    /\b(running on|powered by|using|via)\s+(gpt|claude|gemini|deepseek|llama|mistral)\b/i;
  if (identityLeak.test(trimmed)) {
    return {
      passed: false,
      reason: "identity_leak",
      message:
        "\u09ad\u09be\u0987\u09af\u09bc\u09be, \u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7 \u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u098f\u0987 \u09a4\u09a5\u09cd\u09af\u0997\u09c1\u09b2\u09cb \u09a8\u09be\u0987। \u09ae\u09a1\u09c7\u09b2 \u09aa\u09b0\u09bf\u099a\u09af\u09bc \u09ab\u09be\u0981\u09b8 \u09b9\u09af\u09bc\u09c7 \u0997\u09c7\u099b\u09c7।",
    };
  }

  // Check 4: "I don't know" patterns in Bengali/English
  const dontKnowPatterns = [
    /\u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7.*\u09a8\u09be\u0987/i,
    /\u099c\u09be\u09a8\u09bf \u09a8\u09be/i,
    /I don't know/i,
    /I have no information/i,
    /no information available/i,
    /cannot find/i,
    /unable to determine/i,
    /not available/i,
    /\u09ad\u09be\u0987\u09af\u09bc\u09be.*\u09a8\u09be\u0987/i,
    /\u098f\u0987 \u09ae\u09c1\u09b9\u09c2\u09b0\u09cd\u09a4\u09c7.*\u09a8\u09be\u0987/i,
  ];
  for (const pat of dontKnowPatterns) {
    if (pat.test(trimmed)) {
      // This is a VALID response — agent honestly says it doesn't know
      return {
        passed: true,
        reason: "honest_limitation",
        message: trimmed,
      };
    }
  }

  // Check 5: Contains actual content (passed all checks)
  return {
    passed: true,
    reason: "valid",
    message: trimmed,
  };
}

// 
//  AGENT-TO-AGENT CALL SYSTEM
// 
// Allows one agent to call another agent for specific tasks.
// Pattern: [CALL:agent-id] task description [/CALL]
function parseAgentCalls(content) {
  const callPattern = /\[CALL:(\w+)\]\s*([\s\S]*?)\[\/CALL\]/gi;
  const calls = [];
  let match;
  while ((match = callPattern.exec(content)) !== null) {
    calls.push({
      targetAgent: match[1],
      task: match[2].trim(),
      fullMatch: match[0],
    });
  }
  return calls;
}

async function executeAgentCall(
  sourceAgent,
  targetAgentId,
  task,
  sessionId,
  tools,
) {
  const targetAgent = AGENTS.find((a) => a.id === targetAgentId);
  if (!targetAgent) {
    return {
      success: false,
      content: `[${sourceAgent.name}] \u098f\u099c\u09c7\u09a8\u09cd\u099f ${targetAgentId} \u09aa\u09be\u0993\u09af\u09bc\u09be \u09af\u09be\u09af\u09bc\u09a8\u09bf।`,
    };
  }

  log("INFO", "AGENT_CALL", {
    from: sourceAgent.id,
    to: targetAgentId,
    task: task.slice(0, 100),
  });

  const callMessages = [
    {
      role: "system",
      content:
        buildAgentSystemPrompt(targetAgent, { mode: "agent_call" }) +
        "\n\nCRITICAL: You are being called by " +
        sourceAgent.name +
        " for a specific task. Complete ONLY the task below. Be concise and direct.",
    },
    {
      role: "user",
      content: task,
    },
  ];

  const result = await callModelWithTools(
    usableAgentModel(targetAgent),
    callMessages,
    undefined,
    tools,
  );

  return {
    success: result.success,
    content: result.content || "",
    agent: targetAgent.name,
  };
}
// 
//  RATE LIMIT TRACKING SYSTEM — Per-Domain Server Monitor
// 
// Tracks HTTP 429 rate limits and switches to fallback provider.
// Each domain maintains its own rate limit state.
// Respects cooldown period until limit reset.
// 

// Per-domain rate limit states (each server tracks its own limits)
const RATE_LIMIT_STATES = {};

function getRateLimitState(domain) {
  if (!RATE_LIMIT_STATES[domain]) {
    RATE_LIMIT_STATES[domain] = {
      limited: false,
      provider: null,
      model: null,
      detectedAt: null,
      cooldownMs: parseInt(process.env.RATE_LIMIT_COOLDOWN || "120000", 10),
      originalMessage: null,
      domain: domain,
    };
  }
  return RATE_LIMIT_STATES[domain];
}

function isRateLimited(providerId, model, domain) {
  const state = getRateLimitState(domain || DETECTED_DOMAIN);
  if (!state.limited) return false;
  if (Date.now() - state.detectedAt > state.cooldownMs) {
    state.limited = false;
    state.provider = null;
    state.model = null;
    return false;
  }
  if (providerId && state.provider !== providerId) return false;
  if (model && state.model && state.model !== model) return false;
  return true;
}

function setRateLimited(providerId, model, errorMessage, domain) {
  const state = getRateLimitState(domain || DETECTED_DOMAIN);
  state.limited = true;
  state.provider = providerId;
  state.model = model;
  state.detectedAt = Date.now();
  state.originalMessage = errorMessage;
  log("WARN", "RATE_LIMIT_DETECTED", {
    domain: domain || DETECTED_DOMAIN,
    provider: providerId,
    model: model,
    cooldown: state.cooldownMs + "ms",
    error: errorMessage,
  });
}

function getRateLimitStatus(domain) {
  const domainKey = domain || DETECTED_DOMAIN;
  const state = getRateLimitState(domainKey);
  if (!state.limited) {
    return { limited: false, domain: domainKey };
  }
  const elapsed = Date.now() - state.detectedAt;
  const remaining = Math.max(0, state.cooldownMs - elapsed);
  return {
    limited: true,
    domain: domainKey,
    serverType: DOMAIN_CFG.type,
    provider: state.provider,
    model: state.model,
    remainingMs: remaining,
    remainingSec: Math.ceil(remaining / 1000),
    detectedAt: new Date(state.detectedAt).toISOString(),
    maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
    message:
      "[RateLimited] " +
      domainKey +
      " " +
      (state.provider === "providerId" ? "providerId" : state.provider) +
      " rate limit (HTTP 429). Retry in " +
      Math.ceil(remaining / 1000) +
      "s.",
  };
}

// 
//  PROVIDER HEALTH TRACKING SYSTEM
// 

const PROVIDER_HEALTH = {};

const HEALTH_CONFIG = {
  MAX_CONSECUTIVE_FAILURES: 3,
  RECOVERY_COOLDOWN_MS: 60000,
  SUCCESS_RESET_THRESHOLD: 1,
  DEFAULT_TTL_MS: 60000,
};

function providerHealthTtlMs() {
  const n = parseInt(process.env.PROVIDER_HEALTH_TTL_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : HEALTH_CONFIG.DEFAULT_TTL_MS;
}

function providerHealthCooldownMs() {
  const n = parseInt(process.env.PROVIDER_HEALTH_COOLDOWN_MS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : HEALTH_CONFIG.RECOVERY_COOLDOWN_MS;
}

function getProviderHealth(providerId) {
  if (!PROVIDER_HEALTH[providerId]) {
    // No probe and no served request yet. `null` is deliberate: it means
    // "unknown", never "healthy". Routing may still try it, but every status
    // surface must say unknown until something real happens.
    PROVIDER_HEALTH[providerId] = {
      healthy: null,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastProbeAt: null,
      lastError: null,
      failureReasons: [],
    };
  }
  return PROVIDER_HEALTH[providerId];
}

// One snapshot for every status surface (/health.providers and the admin
// provider list). TTL expiry turns a previously good provider stale — never
// back into an optimistic "healthy" — and cooldown expiry is only a probe
// opportunity, not proof of recovery.
function providerHealthSnapshot(providerId) {
  const health = getProviderHealth(providerId);
  const now = Date.now();
  const ttlMs = providerHealthTtlMs();
  let status;
  if (health.healthy === false) {
    const elapsed = health.lastFailureAt ? now - health.lastFailureAt : null;
    status =
      elapsed !== null && elapsed >= providerHealthCooldownMs()
        ? "stale"
        : "down";
  } else if (health.consecutiveFailures > 0) {
    status = "degraded";
  } else if (health.healthy === true) {
    const age = health.lastSuccessAt ? now - health.lastSuccessAt : null;
    status = age !== null && age <= ttlMs ? "up" : "stale";
  } else if (health.lastProbeAt || health.lastSuccessAt || health.lastFailureAt) {
    status = "stale";
  } else {
    status = "unknown";
  }
  return {
    id: providerId,
    status,
    healthy: status === "up",
    lastProbeAt: health.lastProbeAt
      ? new Date(health.lastProbeAt).toISOString()
      : null,
    lastSuccessAt: health.lastSuccessAt
      ? new Date(health.lastSuccessAt).toISOString()
      : null,
    lastFailureAt: health.lastFailureAt
      ? new Date(health.lastFailureAt).toISOString()
      : null,
    lastError: health.lastError || null,
    consecutiveFailures: health.consecutiveFailures,
    ttlMs,
  };
}

function markProviderSuccess(providerId) {
  const health = getProviderHealth(providerId);
  const now = Date.now();
  health.consecutiveFailures = 0;
  health.lastProbeAt = now;
  health.lastSuccessAt = now;
  health.healthy = true;
  health.lastError = null;
  // authentic-response ledger: provider_stats (real served traffic)
  trackProviderUsage(providerId, false); // memory mirror
  recordProviderStat(providerId, true, null); // SQLite (survives restart)
}


function markProviderFailure(providerId, errorMsg) {
  const health = getProviderHealth(providerId);
  const now = Date.now();
  health.consecutiveFailures++;
  health.lastProbeAt = now;
  health.lastFailureAt = now;
  health.lastError = errorMsg || "Unknown error";
  // authentic-response ledger: failures recorded too
  trackProviderUsage(providerId, true); // memory mirror
  recordProviderStat(providerId, false, errorMsg || "Unknown error"); // SQLite

  health.failureReasons.push({
    at: new Date().toISOString(),
    error: errorMsg,
  });
  if (health.failureReasons.length > 10) {
    health.failureReasons.shift();
  }

  if (health.consecutiveFailures >= HEALTH_CONFIG.MAX_CONSECUTIVE_FAILURES) {
    health.healthy = false;
    log("WARN", "PROVIDER_UNHEALTHY", {
      provider: providerId,
      consecutiveFailures: health.consecutiveFailures,
      lastError: errorMsg,
      cooldownMs: providerHealthCooldownMs(),
    });
  }
}

// Routing predicate, not a status reporter. Unknown is a candidate (the first
// request must be allowed to discover the truth); only confirmed-down inside
// the cooldown is skipped. Admin/health surfaces use providerHealthSnapshot().
function isProviderHealthy(providerId, model) {
  const health = getProviderHealth(providerId);
  if (health.healthy === false) {
    if (health.lastFailureAt) {
      const elapsed = Date.now() - health.lastFailureAt;
      if (elapsed >= providerHealthCooldownMs()) {
        // Cooldown is over: allow one probe, but keep the status honest.
        // A success marks it up; another failure marks it down again.
        health.healthy = null;
        health.consecutiveFailures = 0;
        log("INFO", "PROVIDER_RECOVERY_PROBE", {
          provider: providerId,
          downTimeMs: elapsed,
        });
      } else {
        return false;
      }
    } else {
      return false;
    }
  }
  if (isRateLimited(providerId, model)) return false;
  return true;
}
// Public snapshot of every provider the process knows about, for /health.
// Distinct from `healthy` (the process): a gateway can be perfectly alive
// while one provider is down or stale.
function providerHealthReport() {
  const out = {};
  const ids = new Set([
    ...Object.keys(PROVIDER_CONFIG),
    ...Object.keys(PROVIDER_HEALTH),
  ]);
  for (const id of ids) {
    const p = PROVIDER_CONFIG[id];
    const snap = providerHealthSnapshot(id);
    out[id] = {
      status: snap.status,
      healthy: snap.healthy,
      enabled: p ? p.enabled !== false : false,
      lastProbeAt: snap.lastProbeAt,
      lastSuccessAt: snap.lastSuccessAt,
      lastFailureAt: snap.lastFailureAt,
      lastError: snap.lastError,
      consecutiveFailures: snap.consecutiveFailures,
      ttlMs: snap.ttlMs,
    };
  }
  return out;
}

// 
//  HTTP SERVER
// 
function readBody(req, maxBytes = MAX_BODY_SIZE) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    // BODY SIZE GUARD — consume (backpressure-safe) but stop buffering past the cap
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      resolve(tooLarge ? "" : Buffer.concat(chunks).toString())
    );
    req.on("error", () => resolve(""));
  });
}

/**
 * Binary sibling of readBody for uploads. Returns the real bytes and the
 * declared size; an oversized body is consumed but never buffered.
 */
function readBodyBuffer(req, maxBytes = MAX_BODY_SIZE) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () =>
      resolve({
        data: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks),
        size,
        tooLarge,
      }),
    );
    req.on("error", () =>
      resolve({ data: Buffer.alloc(0), size, tooLarge: true, error: true }),
    );
  });
}

function getCorsOrigin(reqOrigin) {
  if (!reqOrigin) return "";
  return isOriginAllowed(reqOrigin) ? reqOrigin : "";
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * One SSE event for the web UI, bounded by WEB_UI_MAX_BYTES. An oversized
 * event is never written silently: the client gets an explicit error frame
 * naming the budget, and the caller can stop the stream.
 */
function writeWebChunk(res, chunk) {
  const frame = sizeBudget.ssePayload(chunk, "WEB_UI_MAX_BYTES");
  if (frame.tooLarge) {
    log("WARN", "BUDGET_EXCEEDED", {
      key: "WEB_UI_MAX_BYTES",
      limit: frame.limit,
      actual: frame.bytes,
    });
    const error = {
      error: {
        message: "WEB_UI_MAX_BYTES exceeded",
        code: "BUDGET_EXCEEDED",
        key: "WEB_UI_MAX_BYTES",
        limit: frame.limit,
        actual: frame.bytes,
      },
    };
    res.write("data: " + JSON.stringify(error) + "\n\n");
    return false;
  }
  res.write(frame.payload);
  return true;
}

const _rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60000; // 1 minute window
  const maxRequests = 60; // max 60 requests per minute per IP
  if (!_rateLimitMap.has(ip)) {
    _rateLimitMap.set(ip, []);
  }
  const timestamps = _rateLimitMap.get(ip).filter((t) => now - t < windowMs);
  if (timestamps.length >= maxRequests) {
    return false; // Rate limit exceeded
  }
  timestamps.push(now);
  _rateLimitMap.set(ip, timestamps);
  return true;
}
// Periodic cleanup of stale rate limit entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of _rateLimitMap) {
    const valid = timestamps.filter((t) => now - t < 60000);
    if (valid.length === 0) _rateLimitMap.delete(ip);
    else _rateLimitMap.set(ip, valid);
  }
}, 300000);

let AGENTS = [];
const STATS = {
  totalRequests: 0,
  totalAgents: 0,
  models: FREE_MODELS.length,
  startTime: Date.now(),
  // Usage tracking
  modelUsage: {}, // { "model-id": { count, lastUsed } }
  agentUsage: {}, // { "agent-id": { count, lastUsed, errors } }
  providerUsage: {}, // { "provider-id": { count, lastUsed, errors, rateLimits } }
  toolUsage: {}, // { "tool-name": { count, lastUsed, errors } }
  domainRequests: {}, // { "domain": { count, lastUsed } }
};
const mcpClients = new Map();
let mcpActiveConnections = 0;

// ─── Usage Tracking Helpers ──────────────────────────────────
function trackModelUsage(modelId) {
  if (!STATS.modelUsage[modelId])
    STATS.modelUsage[modelId] = { count: 0, lastUsed: null };
  STATS.modelUsage[modelId].count++;
  STATS.modelUsage[modelId].lastUsed = new Date().toISOString();
  // write-through: survives restart. Agent-id / mission passthrough is NOT
  // a model — the real model is recorded at single-agent completion sites.
  if (
    modelId === "mission" ||
    (typeof AGENTS !== "undefined" &&
      Array.isArray(AGENTS) &&
      AGENTS.some((a) => a.id === modelId))
  ) {
    return;
  }
  let prov = null;
  try {
    prov = resolveProvider(modelId).providerId;
  } catch (_) {}
  recordModelStat(modelId, prov, true);
}

function trackAgentUsage(agentId, isError = false, model = null, provider = null) {
  if (!STATS.agentUsage[agentId])
    STATS.agentUsage[agentId] = { count: 0, lastUsed: null, errors: 0 };
  STATS.agentUsage[agentId].count++;
  STATS.agentUsage[agentId].lastUsed = new Date().toISOString();
  if (isError) STATS.agentUsage[agentId].errors++;
  // write-through: agent_stats survives restart (carries last model/provider)
  recordAgentStat(agentId, !isError, model, provider);
}

function trackProviderUsage(providerId, isError = false, isRateLimit = false) {
  if (!STATS.providerUsage[providerId])
    STATS.providerUsage[providerId] = {
      count: 0,
      lastUsed: null,
      errors: 0,
      rateLimits: 0,
    };
  STATS.providerUsage[providerId].count++;
  STATS.providerUsage[providerId].lastUsed = new Date().toISOString();
  if (isError) STATS.providerUsage[providerId].errors++;
  if (isRateLimit) STATS.providerUsage[providerId].rateLimits++;
}

function trackToolUsage(toolName, isError = false) {
  // ANTI-DRIFT GUARD (docs-claims C4): only REAL served tools may enter
  // the stats store. Without this, a probe of any bogus name
  // (e.g. `no_such_tool_xyz`) upserted a tool_stats row, the admin registry
  // (union of MCP_TOOLS + tool_stats + memory) grew past tools/list, and
  // docs-claims C4/C5 failed forever. Unknown-name calls still hit the
  // REQUEST/MCP_TOOLS_CALL logs — they just don't pollute the registry.
  if (!Object.prototype.hasOwnProperty.call(MCP_TOOLS, toolName)) return;
  if (!STATS.toolUsage[toolName])
    STATS.toolUsage[toolName] = { count: 0, lastUsed: null, errors: 0 };
  STATS.toolUsage[toolName].count++;
  STATS.toolUsage[toolName].lastUsed = new Date().toISOString();
  if (isError) STATS.toolUsage[toolName].errors++;
  // write-through to tool_stats (enabled column untouched by upsert)
  dbRun(
    `INSERT INTO tool_stats (tool, calls, errors, last_used)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(tool) DO UPDATE SET
       calls = calls + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used`,
    [toolName, isError ? 1 : 0, Date.now()],
  );
}

function trackDomainRequest(domain) {
  if (!STATS.domainRequests[domain])
    STATS.domainRequests[domain] = { count: 0, lastUsed: null };
  STATS.domainRequests[domain].count++;
  STATS.domainRequests[domain].lastUsed = new Date().toISOString();
}

function getUsageStats() {
  return {
    totalRequests: STATS.totalRequests,
    totalAgents: STATS.totalAgents,
    uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
    modelUsage: STATS.modelUsage,
    agentUsage: STATS.agentUsage,
    providerUsage: STATS.providerUsage,
    toolUsage: STATS.toolUsage,
    domainRequests: STATS.domainRequests,
    mcpClients: Array.from(mcpClients.values()),
    mcpActiveConnections,
  };
}

// 
//  PERSISTENT TELEMETRY — write-through to SQLite (data/models.db)
//  In-memory STATS die on restart; these tables do not.
// 
function dbRun(sql, params) {
  try {
    if (MODELS_DB) MODELS_DB.prepare(sql).run(...(params || []));
  } catch (e) {
    log("DEBUG", "TELEMETRY_FAIL", { error: e.message });
  }
}

function recordProviderStat(provider, ok, errMsg) {
  if (!provider) return;
  const now = Date.now();
  dbRun(
    `INSERT INTO provider_stats (provider, requests, errors, last_used, last_error, last_error_at)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       requests = requests + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used,
       -- A served request that succeeded clears the stale error. Keeping it
       -- via COALESCE made a recovered provider look broken forever.
       last_error = CASE WHEN excluded.errors = 0
                         THEN NULL
                         ELSE COALESCE(excluded.last_error, last_error) END,
       last_error_at = CASE WHEN excluded.errors = 0
                            THEN NULL
                            ELSE COALESCE(excluded.last_error_at, last_error_at) END`,
    [
      provider,
      ok ? 0 : 1,
      now,
      ok ? null : String(errMsg || "error").slice(0, 300),
      ok ? null : now,
    ],
  );
}

// Read one row of the provider traffic ledger (real served traffic).
function getProviderStat(provider) {
  if (!MODELS_DB) return null;
  try {
    return (
      MODELS_DB.prepare("SELECT * FROM provider_stats WHERE provider = ?").get(
        provider,
      ) || null
    );
  } catch (e) {
    return null;
  }
}

function recordModelStat(model, provider, ok) {
  if (!model) return;
  dbRun(
    `INSERT INTO model_stats (model, provider, requests, errors, last_used)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(model) DO UPDATE SET
       requests = requests + 1,
       errors = errors + excluded.errors,
       provider = COALESCE(excluded.provider, provider),
       last_used = excluded.last_used`,
    [model, provider || null, ok ? 0 : 1, Date.now()],
  );
}

function recordAgentStat(agent, ok, model, provider) {
  if (!agent) return;
  dbRun(
    `INSERT INTO agent_stats (agent, calls, errors, last_used, last_model, last_provider)
     VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       calls = calls + 1,
       errors = errors + excluded.errors,
       last_used = excluded.last_used,
       last_model = COALESCE(excluded.last_model, last_model),
       last_provider = COALESCE(excluded.last_provider, last_provider)`,
    [agent, ok ? 0 : 1, Date.now(), model || null, provider || null],
  );
}

function recordSessionTouch(sessionId, info) {
  if (!sessionId) return;
  const now = Date.now();
  const i = info || {};
  dbRun(
    `INSERT INTO session_log (id, editor, agent, model, provider, status, requests, created_at, last_seen, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       requests = requests + 1,
       last_seen = excluded.last_seen,
       editor = COALESCE(excluded.editor, editor),
       agent = COALESCE(excluded.agent, agent),
       model = COALESCE(excluded.model, model),
       provider = COALESCE(excluded.provider, provider),
       status = COALESCE(excluded.status, status),
       user_agent = COALESCE(excluded.user_agent, user_agent)`,
    [
      sessionId,
      i.editor || null,
      i.agent || null,
      i.model || null,
      i.provider || null,
      i.status || "active",
      i.created_at || now,
      now,
      i.user_agent || null,
    ],
  );
}

function recordRequestLog(row) {
  if (!MODELS_DB) return;
  try {
    const now = Date.now();
    MODELS_DB.prepare(
      `INSERT INTO request_log (ts, path, session_id, editor, agent, model, provider, upstream_provider, status, ok, elapsed_ms, swap_count, domain, prompt_tokens, completion_tokens, total_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      now,
      row.path || null,
      row.session_id || null,
      row.editor || null,
      row.agent || null,
      row.model || null,
      row.provider || null,
      row.upstream_provider || null,
      row.status || 200,
      row.ok === false ? 0 : 1,
      Math.round(row.elapsed_ms || 0),
      row.swap_count || 0,
      row.domain || DETECTED_DOMAIN || null,
      Math.max(0, Math.round(row.prompt_tokens || 0)),
      Math.max(0, Math.round(row.completion_tokens || 0)),
      Math.max(
        0,
        Math.round(
          row.total_tokens ||
            (Number(row.prompt_tokens) || 0) + (Number(row.completion_tokens) || 0),
        ),
      ),
    );
    // keep the log bounded (~20k rows) — occasional prune
    if (Math.random() < 0.02) {
      MODELS_DB.prepare(
        `DELETE FROM request_log WHERE id IN (
           SELECT id FROM request_log ORDER BY id DESC LIMIT -1 OFFSET 20000)`
      ).run();
    }
  } catch (e) {
    log("DEBUG", "REQUEST_LOG_FAIL", { error: e.message });
  }
}

// Rehydrate in-memory counters from the persistent tables (boot).
function loadUsageFromDb() {
  if (!MODELS_DB) return;
  try {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    for (const r of MODELS_DB
      .prepare("SELECT model, requests, errors, last_used FROM model_stats")
      .all()) {
      STATS.modelUsage[r.model] = {
        count: r.requests,
        lastUsed: iso(r.last_used),
        errors: r.errors,
      };
    }
    for (const r of MODELS_DB
      .prepare("SELECT agent, calls, errors, last_used FROM agent_stats")
      .all()) {
      STATS.agentUsage[r.agent] = {
        count: r.calls,
        lastUsed: iso(r.last_used),
        errors: r.errors,
      };
    }
    for (const r of MODELS_DB
      .prepare("SELECT provider, requests, errors, last_used FROM provider_stats")
      .all()) {
      STATS.providerUsage[r.provider] = {
        count: r.requests,
        lastUsed: iso(r.last_used),
        errors: r.errors,
        rateLimits: 0,
      };
    }
    try {
      const t = MODELS_DB.prepare("SELECT COUNT(*) c FROM request_log").get();
      STATS.totalRequests = Math.max(STATS.totalRequests, t.c || 0);
    } catch (_) {}
    log("INFO", "USAGE_LOADED_FROM_DB", {
      models: Object.keys(STATS.modelUsage).length,
      agents: Object.keys(STATS.agentUsage).length,
      providers: Object.keys(STATS.providerUsage).length,
    });
  } catch (e) {
    log("WARN", "USAGE_LOAD_FAIL", { error: e.message });
  }
}

// Tool on/off — persisted in tool_stats.enabled (admin panel).
function toolEnabled(tool) {
  if (!MODELS_DB) return true;
  try {
    const r = MODELS_DB.prepare(
      "SELECT enabled FROM tool_stats WHERE tool = ?"
    ).get(tool);
    return !r || r.enabled !== 0;
  } catch (e) {
    return true;
  }
}

// 
//  WORKSPACE AUTO-SSOT — Extension sends workspace path,
//  server auto-generates .zombiecoder/SSOT.md there.
// 

/**
 * Handle POST /api/workspace — Receive workspace path from extension,
 * auto-generate SSOT in that directory.
 *
 * Request body: { workspacePath, timestamp, source }
 * Response: { ok: true, ssotPath, generated (boolean) }
 */
function handleWorkspace(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);

      if (!data.workspacePath) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Missing required field: workspacePath",
        });
        return;
      }

      const wsPath = data.workspacePath;
      let ssotResult = null;
      let generated = false;

      try {
        // autoSSOT is defined internally in this file
        ssotResult = autoSSOT(wsPath);
        generated = true;
        // Also auto-generate syllabus.md for this workspace
        autoSyllabus(wsPath);
        // Update global working directory (fallback)
        mcpWorkingDir = wsPath;
        // Also store per-session dir if x-session-id is provided
        if (data.xSessionId) {
          sessionDirs.set(data.xSessionId, wsPath);
          log("INFO", "SESSION_DIR_SET", {
            session: data.xSessionId.slice(0, 8),
            dir: wsPath,
          });
        }
        log("INFO", "WORKSPACE_SSOT", {
          path: wsPath,
          source: data.source || "unknown",
          workingDir: mcpWorkingDir,
        });
      } catch (e) {
        log("WARN", "WORKSPACE_SSOT_FAILED", {
          path: wsPath,
          error: e.message,
        });
      }

      jsonResponse(res, 200, {
        ok: true,
        workspacePath: wsPath,
        ssotPath: ssotResult ? ssotResult.path : null,
        generated,
        server_ts: Date.now(),
      });
    } catch (e) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid JSON: " + e.message,
      });
    }
  });
}

/**
 * Handle POST /api/syllabus — Add a new entry to syllabus.md
 * Request body: { topic, source, summary, keyPoints, gitHubLink, usedIn }
 */
function handleSyllabusAdd(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const data = JSON.parse(body);
      if (!data.topic && !data.fullInstructions) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Missing required field: topic or fullInstructions",
        });
        return;
      }

      // Handle full instructions bootstrap
      if (data.fullInstructions) {
        const success = bootstrapSyllabus(data.projectDir || undefined);
        jsonResponse(res, 200, {
          ok: success !== false,
          action: success ? "bootstrapped" : "already-exists",
          message: success
            ? "Syllabus bootstrapped with full instructions"
            : "Syllabus already exists",
        });
        return;
      }

      // Standard syllabus add
      const success = writeSyllabus(data.projectDir || mcpWorkingDir, data.topic, {
        source: data.source || "Web Search",
        date: data.date,
        summary: data.summary || "",
        keyPoints: data.keyPoints || [],
        gitHubLink: data.gitHubLink,
        usedIn: data.usedIn,
      });
      if (success) {
        log("INFO", "SYLLABUS_API_ADD", { topic: data.topic });
        jsonResponse(res, 200, { ok: true, topic: data.topic });
      } else {
        jsonResponse(res, 500, {
          ok: false,
          error: "Failed to write syllabus",
        });
      }
    } catch (e) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Invalid JSON: " + e.message,
      });
    }
  });
}

// ──────────────────────────────────────────────────────────
//  TCP Server with HTTP/2 Protocol Detection
// ──────────────────────────────────────────────────────────
// Node's http.Server only supports HTTP/1.1. When a Java/Ktor client
// (e.g., IntelliJ's LLM plugin) uses HTTP/2 prior knowledge, it sends
//   PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n<HTTP/2 frames>
// as raw bytes. The HTTP/1.1 parser rejects the PRI line with 400 Bad
// Request, but the remaining HTTP/2 frames get pipelined and cause:
//   "Frame type(32) length(N) exceeds MAX_FRAME_SIZE(16384)"
// We intercept at the TCP level: detect the 24-byte preface, reject
// the connection cleanly, then pass HTTP/1.1 connections to the real
// request handler via server.emit('connection', socket).
//
// This fixes the "9MB frame" error from the Ktor SSE client.

const HTTP2_PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
const PREFACE_LENGTH = 24;
const net = require("net");

const tcpServer = net.createServer((socket) => {
  let protocolChecked = false;
  // Buffer accumulates data until we have enough to check the protocol.
  // CRITICAL: We do NOT forward the socket to http.Server until AFTER
  // we've checked the protocol. This prevents the http parser from
  // ever seeing HTTP/2 preface bytes.
  let buffer = Buffer.alloc(0);

  const onReadable = () => {
    if (protocolChecked) return;
    const chunk = socket.read();
    if (chunk === null) return; // need more data

    buffer = Buffer.concat([buffer, chunk]);

    // Wait until we have at least the full preface to check
    if (buffer.length < PREFACE_LENGTH) return;

    protocolChecked = true;
    socket.removeListener("readable", onReadable);

    // Check first 24 bytes for HTTP/2 prior-knowledge preface
    const prefix = buffer.slice(0, PREFACE_LENGTH).toString();
    if (prefix === HTTP2_PREFACE) {
      // HTTP/2 prior knowledge (h2c): hand the socket to the in-process
      // h2c server — SAME port, same handler. h2cServer re-emits every
      // stream as an HTTP/1.1-style request into `server`'s request handler.
      log("INFO", "HTTP2_ACCEPTED", {
        remote: socket.remoteAddress || "unknown",
        bytes: buffer.length,
        note: "HTTP/2 prior knowledge → forwarded to h2c server (same port)",
      });
      socket.unshift(buffer);
      buffer = null;
      h2cServer.emit("connection", socket);
      return;
    }

    // HTTP/1.1 — put the data back and forward to http.Server
    socket.unshift(buffer);
    buffer = null;
    server.emit("connection", socket);
  };

  socket.on("readable", onReadable);
  socket.on("error", (err) => {
    if (!protocolChecked) {
      protocolChecked = true;
      socket.removeListener("readable", onReadable);
      log("WARN", "TCP_WRAPPER_ERROR", { error: err.message });
    }
  });
});

// 
// HTTP/1.1 Server (inbound) + HTTP/2 Client (outbound to providers)
// 
// ─── Service map for /api/system ─────────────────────────────
// A TCP connect is enough to answer "is something listening"; we do not
// claim the listener is healthy. /health and each service's own /health
// endpoint remain the authority for health.
function probeTcp(port, host, timeoutMs) {
  return new Promise((resolve) => {
    if (!port) {
      resolve(false);
      return;
    }
    const socket = netModule.connect({ port, host: host || "localhost" });
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

function configuredServiceMap() {
  const skip = new Set(["caddy_http", "caddy_https", "https", "uds"]);
  return Object.entries(SERVICE_PORTS)
    .filter(([name]) => !skip.has(name))
    .map(([name, key]) => {
      const raw = process.env[key] || DEFAULTS[key] || "";
      const port = Number(raw);
      return {
        name,
        env: key,
        port: Number.isInteger(port) && port > 0 ? port : 0,
      };
    })
    .filter((item) => item.port > 0);
}

async function collectServiceStatus() {
  const services = configuredServiceMap();
  const checks = await Promise.all(
    services.map(async (item) => ({
      ...item,
      listening: await probeTcp(item.port, "localhost", 350),
    })),
  );
  return checks;
}

const handleHttpRequest = async (req, res) => {
  const startTime = Date.now();
  // Ownership watermark on every response (identity.json is the SSOT).
  setSystemIdentityHeaders(res);
  const method = req.method;
  let url = req.url.split("?")[0];
  // BODY SIZE GUARD — reject oversized requests before any body read (413)
  const declaredLen = parseInt(req.headers["content-length"] || "0", 10);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_SIZE) {
    return jsonResponse(res, 413, {
      error: {
        message: "request body too large (limit " + MAX_BODY_SIZE + " bytes)",
        type: "payload_too_large",
      },
    });
  }
  // Normalize duplicate /v1 prefixes from older extension copies.
  // Some extension builds configure serverUrl as http://host:3000/v1
  // and then append "/api/..." or "/v1/..." directly, producing
  //   /v1/api/workspace  -> /api/workspace
  //   /v1/v1/models      -> /v1/models
  // which would otherwise 404 because the server routes live at
  // /api/workspace and /v1/models (not under a doubled prefix).
  if (url.startsWith("/v1/v1/")) {
    url = url.slice(3);
  } else if (url.startsWith("/v1/api/")) {
    url = url.slice(3);
  } else if (url.startsWith("/mcp/v1/")) {
    // MCP clients (VSCode built-in MCP, probes) ask for the model
    // list at {mcpServerUrl}/v1/models — i.e. /mcp/v1/models.
    // Strip the /mcp prefix so /mcp/v1/models -> /v1/models and
    // the existing model-list route serves it instead of 404.
    url = url.slice(4);
  }
  const reqId = crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : String(Date.now()).slice(-8);

  // VISUAL EVENT FLOW: Show every request in terminal with the real caller.
  // Model discovery has no agent identity by design; report the count and an
  // explicit role instead of the old "unknown" placeholder.
  const actor = requestActor(req);
  const modelListCount =
    method === "GET" && url === "/v1/models" ? AGENTS.length + 1 : undefined;
  const actorAgent = actor.agent || (modelListCount ? "model-list" : "direct");
  visualEventFlow("request", `[${reqId}] ${method} ${url}`, {
    from: actor.from,
    origin: actor.origin,
    client: actor.client || undefined,
    agent: actorAgent,
    ...(modelListCount ? { models: modelListCount } : {}),
  });
  res._actor = actor;
  res._actorAgent = actorAgent;
  try {
    const encodedActor = actorHeader(actor);
    if (encodedActor) res.setHeader("X-Request-Actor", encodedActor);
  } catch (_) {
    /* headers already sent by an early route */
  }

  // Store reqId on response for downstream use
  res._reqId = reqId;
  const _origEnd = res.end.bind(res);
  res.end = function (chunk, encoding, cb) {
    visualEventFlow("response", `[${reqId}] ${res.statusCode || 200}`, {
      elapsed: Date.now() - startTime + "ms",
      bytes: chunk ? chunk.length || 0 : 0,
    });
    return _origEnd(chunk, encoding, cb);
  };

  // ─── HTTP/2 Connection Preface Detection ──────────────────
  // Java/Ktor HTTP clients may use HTTP/2 prior knowledge by sending
  //   PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n
  // as the very first bytes of a TCP connection. Node's HTTP/1.1 parser
  // accepts this as method=PRI, url=*, version=HTTP/2.0 but then rejects
  // it with a generic 400 Bad Request. The 400 body is then misinterpreted
  // by the Java HTTP/2 frame parser as HTTP/2 frames, causing:
  //   "Frame type(32) length(9071724) exceeds MAX_FRAME_SIZE(16384)"
  // We catch this at the application level and return a proper 505 response.
  if (req.method === "PRI" && req.url === "*") {
    log("WARN", "HTTP2_PREFACE_REJECTED", {
      remote: req.socket.remoteAddress,
      httpVersion: req.httpVersion,
    });
    res.writeHead(505, {
      "Content-Type": "text/plain",
      Connection: "close",
    });
    res.end(
      "This server only supports HTTP/1.1. " +
      "Please disable HTTP/2 in your client configuration. " +
      "IntelliJ IDEA: add -Djdk.httpclient.HttpClient.log=errors to VM options.",
    );
    return;
  }

  // Per-request domain detection (for multi-domain servers)
  const requestDomain = detectDomain(req.headers.host);

  // Track domain requests
  STATS.totalRequests++;
  trackDomainRequest(requestDomain);

  // CORS
  const corsOrigin = getCorsOrigin(req.headers.origin);
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS, PUT, DELETE",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Session-Id, X-Verify-Token, X-Working-Dir, X-File-Name, X-Admin-Token, X-Api-Key",
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ─── GET / — Serve UI Dashboard (graceful: falls back to public/ or 404) ──
  if (url === "/" && method === "GET") {
    const candidates = [
      path.resolve(__dirname, "public", "index.html"),
      path.resolve(__dirname, "public", "index.html"),
    ];
    for (const htmlPath of candidates) {
      try {
        const html = fs.readFileSync(htmlPath, "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      } catch (e) { /* try next */ }
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Dashboard not found. Run: node api.js");
    return;
  }

  // ─── UI-1: graceful static serve for public/ pages ──────────
  // Any request matching a file in public/ is served from there, except
  // admin.html: the panel route owns it so the session cookie is always set.
  if (method === "GET" && !url.startsWith("/api/") && !url.startsWith("/v1/") && !url.startsWith("/mcp")) {
    const base = path.resolve(__dirname, "public");
    let rel = url.split("?")[0].split("#")[0];
    if (rel === "/") rel = "/index.html";
    // Only allow safe, non-traversal relative names
    const safeRel = rel.replace(/^\/+/, "");
    if (
      safeRel &&
      safeRel !== "admin.html" &&
      !safeRel.includes("..") &&
      !safeRel.includes("\\")
    ) {
      const filePath = path.join(base, safeRel);
      if (filePath.startsWith(base)) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mime = {
              ".html": "text/html; charset=utf-8",
              ".css": "text/css; charset=utf-8",
              ".js": "application/javascript; charset=utf-8",
              ".json": "application/json; charset=utf-8",
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".svg": "image/svg+xml",
              ".ico": "image/x-icon",
              ".woff2": "font/woff2",
            }[ext] || "application/octet-stream";
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { "Content-Type": mime });
            res.end(content);
            return;
          }
        } catch (e) { /* not a file → fall through */ }
      }
    }
  }

  try {
    // ─── GET /health ─────────────────────────────────────────
    if (url === "/health" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      const rateLimit = getRateLimitStatus();
      jsonResponse(res, 200, {
        healthy: true,
        instance_id: INSTANCE_ID,
        version: DOMAIN_CFG.version,
        domain: requestDomain,
        serverType: DOMAIN_CFG.type,
        agents: AGENTS.length,
        models: FREE_MODELS.length,
        pusher: PUSHER_ENABLED,
        hasFrontend: DOMAIN_CFG.hasFrontend,
        maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        session_count: cleanExpired().length,
        // Additive provider block: the process can be healthy while a specific
        // provider is unknown/down/stale. Each entry is the exact snapshot the
        // admin provider list reads, so the two surfaces always agree.
        providers: providerHealthReport(),
        system: systemInfo.compactSystemInfo(),
        rate_limit: rateLimit.limited
          ? {
            limited: true,
            domain: requestDomain,
            provider: rateLimit.provider,
            model: rateLimit.model,
            remaining_sec: rateLimit.remainingSec,
            message: rateLimit.message,
          }
          : { limited: false, domain: requestDomain },
      });
      return;
    }

    // ─── GET /api/system ──────────────────────────────────────
    // Host facts plus a live TCP listener map. The map answers "is something
    // listening", not "is it healthy" — each service keeps its own /health.
    if (url === "/api/system" && method === "GET") {
      const system = systemInfo.collectSystemInfo();
      const services = await collectServiceStatus();
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
        listeners: services.filter((s) => s.listening).length,
      });
      jsonResponse(res, 200, {
        ok: true,
        collected_at: new Date().toISOString(),
        system,
        services,
        agents: {
          count: AGENTS.length,
          tool_catalog: Object.keys(MCP_TOOLS).length,
        },
        runtime: {
          port: PORT,
          uds_port: UDS_PORT,
          grpc_port: parseInt(process.env.GRPC_PORT || DEFAULTS.GRPC_PORT, 10),
          bridge_port: parseInt(process.env.BRIDGE_PORT || DEFAULTS.BRIDGE_PORT, 10),
          ollama_base: process.env.OLLAMA_BASE || "",
        },
      });
      return;
    }

    // ─── GET /api/rate-limit ───────────────────────────────────
    if (url === "/api/rate-limit" && method === "GET") {
      jsonResponse(res, 200, getRateLimitStatus());
      return;
    }
    // ─── POST /api/rate-limit/reset ────────────────────────────
    if (url === "/api/rate-limit/reset" && method === "POST") {
      // SECURITY (2026-10-08): was unauthenticated — anyone could clear the
      // rate-limit state (defeating the 50 req/min protection). This route is
      // declared BEFORE the old block-local adminAuthorized(), which is one of
      // the reasons that helper is now module-scope.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const state = getRateLimitState(requestDomain);
      state.limited = false;
      state.provider = null;
      state.model = null;
      log("INFO", "RATE_LIMIT_RESET", { domain: requestDomain });
      jsonResponse(res, 200, {
        success: true,
        message: "Rate limit state cleared for " + requestDomain,
      });
      return;
    }

    // ─── GET /api/transports ──────────────────────────────────
    // The admin Transport page reads this. It reports real listener state,
    // never a static list. Providers/models are deliberately separate: a
    // model is not a transport.
    if (url === "/api/transports" && method === "GET") {
      const publicOrigin = (DOMAIN_CFG.appUrl || `http://localhost:${PORT}`).replace(/\/+$/, "");
      const wsOrigin = publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
      const udsPaths = udsGateway ? udsGateway.paths : UDS_PATHS;
      const boundUds = udsGateway
        ? (udsGateway.boundPath || "")
        : (udsBoundPath || "");
      const udsListening = udsGateway
        ? udsGateway.listening
        : !!(udsServer && udsServer.listening);
      const openaiOnUds = !!(openaiUdsServer && openaiUdsServer.server &&
        openaiUdsServer.server.listening) ||
        !!(udsGateway && process.env.OPENAI_UDS !== "0" && process.env.UDS_OPENAI !== "0");
      const cd = "cd " + JSON.stringify(PROJECT_ROOT);
      const mcpHttp = "curl -sS " + publicOrigin + "/mcp " +
        "-H 'content-type: application/json' " +
        "-d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{}}'";
      const mcpUds = boundUds
        ? cd + "\ncurl -sS --unix-socket " + boundUds + " http://localhost/mcp \\\n" +
          "  -H 'content-type: application/json' \\\n" +
          "  -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"set_working_dir\",\"arguments\":{\"path\":\"'\"$PWD\"'\"}}}'"
        : "# UDS is not bound";
      const openaiUds = boundUds && openaiOnUds
        ? cd + "\ncurl -sS --unix-socket " + boundUds + " http://localhost/v1/chat/completions \\\n" +
          "  -H 'content-type: application/json' \\\n" +
          "  -H \"x-working-dir: $PWD\" \\\n" +
          "  -d '{\"model\":\"mission\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"stream\":false}'"
        : "# OpenAI over UDS is disabled";
      const grpcPort = parseInt(process.env.GRPC_PORT || DEFAULTS.GRPC_PORT, 10);
      const httpsReady = !!(httpsServer && httpsServer.listening);
      const httpsExternal = /^https:/i.test(publicOrigin);

      jsonResponse(res, 200, {
        ok: true,
        generated_at: new Date().toISOString(),
        working_dir: mcpWorkingDir,
        transports: [
          {
            id: "http",
            label: "HTTP",
            protocol: "http",
            status: tcpServer.listening ? "listening" : "stopped",
            endpoint: "http://localhost:" + PORT,
            command: mcpHttp,
          },
          {
            id: "https",
            label: "HTTPS",
            protocol: "https",
            status: httpsReady ? "listening" : (httpsExternal ? "external" : "disabled"),
            endpoint: publicOrigin,
            command: "curl -sS " + publicOrigin + "/health",
          },
          {
            id: "uds",
            label: "UDS (MCP + OpenAI)",
            protocol: "uds",
            status: udsListening ? "listening" : "stopped",
            endpoint: "http://localhost",
            paths: udsPaths,
            bound_path: boundUds,
            fallback_used: !!(udsGateway && udsGateway.fallbackUsed) || udsFallbackUsed,
            attempts: udsGateway ? udsGateway.attempts : [],
            protocols: openaiOnUds ? ["mcp", "openai"] : ["mcp"],
            commands: { mcp: mcpUds, openai: openaiUds },
          },
          {
            id: "grpc",
            label: "gRPC (h2c)",
            protocol: "grpc",
            status: grpcServer ? "listening" : "disabled",
            endpoint: "localhost:" + grpcPort,
            command: "grpcurl -plaintext -d '{\"model\":\"mission\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}' " +
              "localhost:" + grpcPort + " zombie.v1.ChatService/Chat",
          },
          {
            id: "stdio",
            label: "STDIO",
            protocol: "stdio",
            status: "available",
            endpoint: "node transport/stdio-openai.js",
            command: cd + "\nprintf '%s\\n' '{\"model\":\"mission\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}]}' | node transport/stdio-openai.js",
          },
          {
            id: "websocket",
            label: "WebSocket",
            protocol: "websocket",
            status: "available",
            endpoint: wsOrigin + "/ws",
            command: "websocat " + wsOrigin + "/ws",
          },
        ],
        providers: {
          note: "Providers and models are routing targets, not transports. UDS is called only by a client that passes --unix-socket.",
          count: Object.keys(PROVIDER_CONFIG).length,
          ids: Object.keys(PROVIDER_CONFIG),
        },
      });
      return;
    }

    // ─── GET /identity ───────────────────────────────────────
    if (url === "/identity" && method === "GET") {
      const requestConfig = getDomainConfig(requestDomain);
      log("INFO", "REQUEST", {
        method,
        url,
        domain: requestDomain,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        system_identity: {
          ...requestConfig.identity,
          server: {
            domain: requestDomain,
            type: requestConfig.type,
            version: requestConfig.version,
            hasFrontend: requestConfig.hasFrontend,
            hasPusher: PUSHER_ENABLED,
            maxRateLimit: requestConfig.maxRateLimitPerServer,
          },
        },
      });
      return;
    }

    // ─── GET /v1/models ──────────────────────────────────────
    if (url === "/v1/models" && method === "GET") {
      const agentModels = AGENTS.map((a) => ({
        id: a.id, // ← Agent ID (code-guru, bug-hunter, etc.)
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
        ...udsModelFields(),
      }));

      // Add "mission" as a special model
      agentModels.unshift({
        id: "mission",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
        ...udsModelFields(),
      });

      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
        model_count: agentModels.length,
        agent: (res._actorAgent || "model-list"),
        from: (res._actor && res._actor.from) || "unknown",
        origin: (res._actor && res._actor.origin) || "unknown",
      });
      jsonResponse(res, 200, { object: "list", data: agentModels });
      return;
    }

    // ─── GET /api/v0/models ──────────────────────────────────
    // JetBrains/IDE clients call this endpoint for model discovery.
    // Returns REAL provider model names so IDE can list and select them.
    if (url === "/api/v0/models" && method === "GET") {
      const allModels = [];

      // 1. Add real provider models (what JetBrains needs to see)
      for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
        if (p.enabled === false) continue;
        if (p.models.length === 0) {
          // A reachable dynamic provider with no model is omitted; advertising
          // a wildcard placeholder would be a model that cannot answer.
          if (p.dynamicModels) continue;
          allModels.push({
            id: `${id}:default`,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: p.name,
            ...udsModelFields(),
          });
        } else {
          for (const m of p.models) {
            allModels.push({
              id: getModelName(m),
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: p.name,
              ...udsModelFields(),
            });
          }
        }
      }

      // 2. Add agent models as "mission:" prefixed entries
      allModels.push({
        id: "mission",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "mission-barisal",
        ...udsModelFields(),
      });
      for (const a of AGENTS) {
        allModels.push({
          id: "mission:" + a.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mission-barisal",
          ...udsModelFields(),
        });
      }

      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
        model_count: allModels.length,
        providers: Object.keys(PROVIDER_CONFIG).length,
      });
      jsonResponse(res, 200, { object: "list", data: allModels });
      return;
    }

    // ── GET /api/v1/models ──────────────────────────────────
    // Shows ALL provider models (unmasked, real API model names).
    // For developers/admins to see what models are available from providers.
    // Smart Router uses this info internally for routing decisions.
    if (url === "/api/v1/models" && method === "GET") {
      const providerModels = [];
      for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
        if (p.enabled === false) continue;
        if (p.models.length === 0) {
          if (p.dynamicModels) continue;
          providerModels.push({
            id: "*",
            provider: id,
            providerName: p.name,
            type: p.type,
            apiModel: "*",
            free: true,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: p.name,
            ...udsModelFields(),
          });
        } else {
          for (const m of p.models) {
            providerModels.push({
              id: getModelName(m),
              provider: id,
              providerName: p.name,
              type: p.type,
              apiModel: getApiModelName(m),
              free: true,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: p.name,
              ...udsModelFields(),
            });
          }
        }
      }
      jsonResponse(res, 200, {
        object: "list",
        data: providerModels,
        total_providers: Object.keys(PROVIDER_CONFIG).length,
        total_models: providerModels.length,
      });
      return;
    }

    // ─── GET /api/mcp-clients ─────────────────────────────────
    // Tool-surface manifest: separates the documented 36 (core + the MCP
    // servers the project ships) from operator-added pluggable servers, so
    // a big number no longer looks like stale docs.
    if (url === "/api/tools/manifest" && method === "GET") {
      const { manifest } = require("./tools/tools-manifest.js");
      const names = Object.keys(MCP_TOOLS);
      const payload = manifest(names);
      log("INFO", "REQUEST", {
        method, url, status: 200, elapsed: Date.now() - startTime,
        tools: names.length, documented: payload.documented_contract,
      });
      return jsonResponse(res, 200, payload);
    }

    if (url === "/api/mcp-clients" && method === "GET") {
      const mcpStatus = {
        domain: requestDomain,
        serverType: DOMAIN_CFG.type,
        version: DOMAIN_CFG.version,
        total_requests: STATS.totalRequests,
        active_connections: mcpActiveConnections,
        connected_clients: Array.from(mcpClients.values()),
        tools: Object.keys(MCP_TOOLS).length,
        server_url: "http://localhost:" + PORT + "/mcp",
        protocol: "JSON-RPC 2.0",
        protocol_version: mcpProtocol.PROTOCOL_VERSION,
        supported_protocol_versions: mcpProtocol.SUPPORTED_PROTOCOL_VERSIONS,
      };
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, mcpStatus);
      return;
    }

    // ─── GET /api/clients ─────────────────────────────────────
    // JSON only — the HTML page (CSS table, refresh link, footer) that was
    // inlined here has been removed from api.js entirely.
    if (url === "/api/clients" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      const clients = readClients().sort(
        (a, b) => new Date(b.last_seen) - new Date(a.last_seen),
      );
      jsonResponse(res, 200, { total: clients.length, clients: clients });
      return;
    }

    // ─── GET /api/domain ────────────────────────────────────
    // Shows current domain detection and configuration
    if (url === "/api/domain" && method === "GET") {
      jsonResponse(res, 200, {
        detected: requestDomain,
        startup: DETECTED_DOMAIN,
        hostHeader: req.headers.host || null,
        type: DOMAIN_CFG.type,
        version: DOMAIN_CFG.version,
        hasFrontend: DOMAIN_CFG.hasFrontend,
        hasPusher: PUSHER_ENABLED,
        hasDevModels: DOMAIN_CFG.hasDevModels,
        maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
        corsOrigins: DOMAIN_CFG.corsOrigins,
        sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
        envOverride: process.env.DEPLOY_DOMAIN || null,
        allDomains: Object.keys(DOMAIN_CONFIGS),
      });
      return;
    }

    // ─── GET /api/pusher-config ──────────────────────────────
    // Returns Pusher key and cluster for client-side connection (safe — no secret)
    if (url === "/api/pusher-config" && method === "GET") {
      jsonResponse(res, 200, {
        enabled: PUSHER_ENABLED,
        key: PUSHER_KEY || null,
        cluster: PUSHER_CLUSTER || "ap2",
      });
      return;
    }

    // ─── GET /api/agents ─────────────────────────────────────
    if (url === "/api/agents" && method === "GET") {
      const toolNames = Object.keys(MCP_TOOLS);
      const globalLimit = toolBudget.limitFor();
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        count: AGENTS.length,
        // The registry is DB-first now; the label must not claim the file
        // source while serving DB personas.
        source: (() => {
          const sources = new Set(AGENTS.map((a) => a.source || "agent/*.js"));
          if (sources.size === 0) return "agent/*.js";
          return [...sources].sort().join("+");
        })(),
        tools: {
          catalog: toolNames.length,
          execution_limit: globalLimit,
          default_stream_limit: globalLimit,
        },
        agents: AGENTS.map((a) => {
          const providerInfo = resolveProvider(a.model, true);
          const providerId = providerInfo?.providerId || "";
          const caps = providerRegistry.capabilitiesFor(
            providerInfo?.config,
            providerId,
            a.model,
          );
          const streamLimit = toolBudget.limitFor(caps.maxTools);
          return {
            id: a.id,
            name: a.name,
            role: a.role,
            model: maskModelName(a.model),
            provider: "ZombieCoder",
            tools: {
              catalog: toolNames.length,
              execution_limit: globalLimit,
              stream_limit: streamLimit,
              bound: toolBudget.rankNames(toolNames, globalLimit),
              stream_bound: toolBudget.rankNames(toolNames, streamLimit),
            },
          };
        }),
      });
      return;
    }

    // ─── DB mutation API (providers, models, agents) ───────────
    // SECURITY: adminRouteAuthorized() is module scope and checks both the
    // admin credential and the panel-session cookie. lib/admin-routes.js
    // receives the same guard via ctx. No UI file is required to boot.
    if (await adminApi.handle(adminApiContext(), req, res, url, method)) return;

    // ─── GET /admin/zombie — optional admin page ──────────────
    // Served directly by this process: no Nginx hop, no upstream fetch. The
    // route mints the panel-session cookie that every admin method requires.
    // public/admin.html is the convenience page; lib/admin-panel.js is the
    // fallback. Both are optional: 503 only when neither exists.
    if (
      (url === "/admin/zombie" ||
        url === "/admin/zombie/" ||
        url === "/admin" ||
        url === "/admin/" ||
        url === "/admin.html") &&
      method === "GET"
    ) {
      const page = loadAdminPage({
        domain: DETECTED_DOMAIN,
        version: DOMAIN_CFG.version,
        serverType: DOMAIN_CFG.type,
      });
      if (!page) {
        res.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end("admin panel unavailable");
        return;
      }
      const panelToken = adminSession.create();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": getCorsOrigin(req.headers.origin),
        "Cache-Control": "no-store",
        "Set-Cookie": adminSession.cookie(panelToken),
      });
      res.end(page.html);
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        source: page.source,
        elapsed: Date.now() - startTime,
      });
      return;
    }

    // ─── GET /api/admin — redirect to the real admin panel ────
    if (url === "/api/admin" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 302,
        elapsed: Date.now() - startTime,
      });
      res.writeHead(302, {
        Location: "/admin/zombie",
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }

    // ── GET /api/admin/stats ───────────────────────────────────
    // Returns all runtime stats as JSON (programmatic access)
    // ─── GET /api/admin/tools — per-tool stats + on/off (DB-backed) ──
    if (url === "/api/admin/tools" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const dbRows = {};
      if (MODELS_DB) {
        try {
          for (const r of MODELS_DB.prepare(
            "SELECT tool, calls, errors, last_used, enabled FROM tool_stats",
          ).all())
            dbRows[r.tool] = r;
        } catch (_) {}
      }
      const names = Array.from(
        new Set([
          ...Object.keys(MCP_TOOLS),
          ...Object.keys(dbRows),
          ...Object.keys(STATS.toolUsage || {}),
        ]),
      ).sort();
      jsonResponse(res, 200, {
        ok: true,
        total_tools: names.length,
        tools: names.map((name) => {
          const d = dbRows[name];
          const mem = (STATS.toolUsage || {})[name] || {};
          let memMs = null;
          if (mem.lastUsed) {
            const t = Date.parse(mem.lastUsed);
            if (!isNaN(t)) memMs = t;
          }
          return {
            name,
            description: (MCP_TOOLS[name] && MCP_TOOLS[name].description) || "",
            builtin: !!MCP_TOOLS[name],
            calls: Math.max(d ? d.calls : 0, mem.count || 0),
            errors: Math.max(d ? d.errors : 0, mem.errors || 0),
            last_used:
              d && d.last_used ? d.last_used : memMs, // epoch ms | null
            enabled: d ? d.enabled !== 0 : true,
          };
        }),
      });
      return;
    }
    // ─── POST /api/admin/tools — toggle one tool on/off ────────────
    if (url === "/api/admin/tools" && method === "POST") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const body = await readBody(req);
      let b;
      try {
        b = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!b || typeof b.tool !== "string" || typeof b.enabled !== "boolean") {
        jsonResponse(res, 400, {
          error: "tool (string) and enabled (boolean) required",
        });
        return;
      }
      if (!MCP_TOOLS[b.tool]) {
        jsonResponse(res, 404, { error: "Unknown tool: " + b.tool });
        return;
      }
      dbRun(
        `INSERT INTO tool_stats (tool, calls, errors, last_used, enabled)
         VALUES (?, 0, 0, ?, ?)
         ON CONFLICT(tool) DO UPDATE SET enabled = excluded.enabled`,
        [b.tool, Date.now(), b.enabled ? 1 : 0],
      );
      log("INFO", "ADMIN_TOOL_TOGGLE", { tool: b.tool, enabled: b.enabled });
      jsonResponse(res, 200, { ok: true, tool: b.tool, enabled: b.enabled });
      return;
    }
    // ─── GET /api/admin/session-log — SQLite session/request history ──
    if (url === "/api/admin/session-log" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const sessions = [];
      const recent = [];
      if (MODELS_DB) {
        try {
          for (const r of MODELS_DB.prepare(
            "SELECT * FROM session_log ORDER BY last_seen DESC LIMIT 100",
          ).all())
            sessions.push(r);
          for (const r of MODELS_DB.prepare(
            "SELECT * FROM request_log ORDER BY id DESC LIMIT 50",
          ).all())
            recent.push(r);
        } catch (_) {}
      }
      jsonResponse(res, 200, {
        ok: true,
        sessions,
        recent,
        active: cleanExpired().length,
        // lifetime agent-call counter (agent_stats SUM — survives restart)
        agent_calls: (function () {
          if (!MODELS_DB) return null;
          try {
            const r = MODELS_DB
              .prepare("SELECT COALESCE(SUM(calls),0) AS c FROM agent_stats")
              .get();
            return r ? r.c : null;
          } catch (e) {
            return null;
          }
        })(),
      });
      return;
    }

    if (url === "/api/admin/stats" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      try {
        const mem = process.memoryUsage();
        const allLocks = readLockLogs();
        jsonResponse(res, 200, {
          // flat, DB-hydrated usage keys the admin Usage page reads
          ...(typeof getUsageStats === "function" ? getUsageStats() : {}),
          server: {
            version: DOMAIN_CFG.version,
            domain: requestDomain,
            type: DOMAIN_CFG.type,
            uptime_sec: Math.floor((Date.now() - STATS.startTime) / 1000),
            total_requests: STATS.totalRequests,
            agents: AGENTS.length,
            providers: Object.keys(PROVIDER_CONFIG).length,
            models: FREE_MODELS.length,
            pusher: PUSHER_ENABLED,
            frontend: DOMAIN_CFG.hasFrontend,
            sessions: cleanExpired().length,
            memory_rss_mb: Math.round(mem.rss / 1024 / 1024),
            memory_heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
            lock_log_entries: allLocks.length,
          },
          usage: {
            providers: STATS.providerUsage || {},
            models: STATS.modelUsage || {},
            agents: STATS.agentUsage || {},
            domains: STATS.domainRequests || {},
          },
          rate_limit: getRateLimitStatus(),
          domain_config: {
            maxRateLimit: DOMAIN_CFG.maxRateLimitPerServer,
            corsOrigins: DOMAIN_CFG.corsOrigins,
            sessionVerifyUrl: DOMAIN_CFG.sessionVerifyUrl,
            hasPusher: PUSHER_ENABLED,
            hasDevModels: DOMAIN_CFG.hasDevModels,
          },
          env: {
            PORT: process.env.PORT || null,
            DEPLOY_DOMAIN: process.env.DEPLOY_DOMAIN || null,
            PUSHER_ENABLED: PUSHER_ENABLED,
            GROQ_API_KEY: !!process.env.GROQ_API_KEY,
            GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
            OPENCODE_API_KEY: !!process.env.OPENCODE_API_KEY,
          },
          agents: AGENTS.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            model: a.model,
            priority: a.priority,
          })),
        });
      } catch (err) {
        log("ERROR", "STATS_HANDLER", { error: err.message });
        jsonResponse(res, 200, {
          error: "Stats collection failed: " + err.message,
          server: { version: DOMAIN_CFG.version, domain: requestDomain },
          agents: AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.role })),
        });
      }
      return;
    }

    // ─── GET /api/locks ─────────────────────────────────────────
    // Lock Log viewer — JSON format debug memory
    if (url.startsWith("/api/locks") && method === "GET") {
      const parts = url.split("/");
      let result;
      if (parts.length === 3 && parts[2].length > 0 && parts[2] !== "stats") {
        // Specific date: /api/locks/2026-07-11
        const dateStr = parts[2];
        result = {
          date: dateStr,
          locks: readLockLogs(dateStr),
          count: readLockLogs(dateStr).length,
        };
      } else if (parts[parts.length - 1] === "stats") {
        // /api/locks/stats
        result = getLockStats();
      } else {
        // /api/locks — returns latest entries grouped by date
        const all = readLockLogs();
        const latest = all.slice(-50).reverse();
        result = {
          total: all.length,
          latest: latest,
          stats: getLockStats(),
          details:
            "Use /api/locks/YYYY-MM-DD for specific date, /api/locks/stats for summary",
        };
      }
      jsonResponse(res, 200, result);
      return;
    }

    // ─── POST /api/normalize ────────────────────────────────
    // Haq Mawla Normalizer test — send any raw response to see normalized output
    // body: { input?, model? }  → normalizes a raw payload
    // body: { sync: true }      → runs full provider sync (fetch → config → SQLite)
    // body: { envSync: true }   → re-reads model env vars (single source of
    //                              truth) and syncs them into the models DB
    if (url === "/api/normalize" && method === "POST") {
      // SECURITY (2026-10-08): mode:"sync" dials every configured provider
      // and rewrites models.db; mode:"envSync" rewrites config from env. Both
      // were anonymous + cross-origin callable. Admin token required.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!mcpOriginAllowed(req)) {
        jsonResponse(res, 403, { error: "Forbidden: cross-origin request" });
        return;
      }
      const body = await readBody(req);
      try {
        const input = JSON.parse(body);
        // Full sync (admin Sync buttons): env vars first, then every active
        // provider's live /models endpoint (TCP or UDS), then SQLite.
        if (input.mode === "full") {
          const envResult = syncEnvModelsToDb();
          const syncResult = await runNormalizerSync();
          normalizeProviderPriorities("adminFullSync");
          const db = syncModelsToDb();
          refreshFreeModels();
          log("INFO", "NORMALIZE_FULL_SYNC", {
            providers: Object.keys(syncResult.results).length,
          });
          jsonResponse(res, 200, {
            success: true,
            mode: "full",
            normalizer: "Haq Mawla Universal Response Normalizer",
            env: envResult.db,
            results: syncResult.results,
            db,
            providers: Object.entries(PROVIDER_CONFIG)
              .sort(
                ([, a], [, b]) =>
                  providerPriority(a) - providerPriority(b),
              )
              .map(([id, p]) => providerSummary(id, p)),
          });
          return;
        }
        // Env-var sync mode: re-read env model lists → update config → persist
        if (input.envSync || input.mode === "envSync") {
          const envResult = syncEnvModelsToDb();
          log("INFO", "NORMALIZE_ENV_SYNC", { ...envResult });
          jsonResponse(res, 200, {
            success: true,
            normalizer: "Haq Mawla Universal Response Normalizer",
            envSync: true,
            providers: envResult.providers,
            db: envResult.db,
          });
          return;
        }
        // Sync mode: fetch live models from all providers → merge → persist to SQLite
        if (input.sync || input.mode === "sync") {
          const syncResult = await runNormalizerSync();
          log("INFO", "NORMALIZE_SYNC", { ...syncResult.results });
          jsonResponse(res, 200, {
            success: true,
            normalizer: "Haq Mawla Universal Response Normalizer",
            synced: true,
            results: syncResult.results,
            db: syncResult.db,
          });
          return;
        }
        // R2T mode: run the response-to-tool engine from the normalizer testbed.
        // body: { mode: "r2t", message: "[[TOOL:info]][[/TOOL]]", model? }
        // Runs the same virtual model used by model="r2t" on /v1/chat/completions.
        if (input.r2t || input.mode === "r2t") {
          const r2tModel = input.model || "r2t";
          const r2tMessages = [
            { role: "user", content: input.message || input.input_text || "[[TOOL:info]][[/TOOL]]" },
          ];
          const r2tResult = await executeR2tRequest(r2tModel, r2tMessages, {});
          // r2tResults returns a normalized chat.completion wrapper; expose the
          // parsed execution payload too when the caller asked for raw mode.
          const result = r2tResult && r2tResult.choices && r2tResult.choices[0]
            ? r2tResult
            : r2tResult;
          log("INFO", "REQUEST", {
            method,
            url,
            status: 200,
            elapsed: Date.now() - startTime,
            r2t: true,
          });
          jsonResponse(res, 200, result);
          return;
        }
        const result = normalizeResponse(input, input.model || "test");
        log("INFO", "REQUEST", {
          method,
          url,
          status: 200,
          elapsed: Date.now() - startTime,
        });
        jsonResponse(res, 200, result);
      } catch (e) {
        jsonResponse(res, 400, { error: e.message });
      }
      return;
    }

    // ─── GET /api/normalize-list ───────────────────────────
    // Haq Mawla normalizer info — provider-aware model listing (DB + env merged)
    if (url === "/api/normalize-list" && method === "GET") {
      let dbStats = { enabled: false };
      if (MODELS_DB) {
        try {
          const count = MODELS_DB
            .prepare("SELECT COUNT(*) AS c FROM models")
            .get().c;
          dbStats = {
            enabled: true,
            path: MODELS_DB_PATH,
            models: count,
            lastSync: MODELS_DB
              .prepare("SELECT MAX(updated_at) AS t FROM models")
              .get().t,
          };
        } catch (e) {
          dbStats = { enabled: true, error: e.message };
        }
      }
      jsonResponse(res, 200, {
        normalizer: "Haq Mawla Universal Response Normalizer",
        version: "1.0.0",
        providers: Object.entries(PROVIDER_CONFIG).map(([id, p]) => ({
          id,
          name: p.name || id,
          type: p.type || "openai",
          baseUrl: p.baseUrl || "",
          models: p.models || [],
          priority: p.priority,
          enabled: p.enabled !== false, // admin toggle state
        })),
        models: getAllModels(),
        disabledModels: getDisabledModelRows(), // for admin re-enable UI
        db: dbStats,
        features: [
          "OpenAI standard format",
          "Anthropic format (content array)",
          "Gemini format (candidates/parts)",
          "Raw string fallback",
          "Reasoning-content extraction (Mimo/North Mini/Nemotron fix)",
          "Provider detection",
          "Dynamic provider routing (competitionRouter)",
          "SQLite models table (sync: POST /api/normalize { sync: true })",
        ],
      });
      return;
    }

    // ─── GET/POST /api/config ──────────────────────────────
    // Runtime configuration — view or update without server restart
    if (url === "/api/config" && method === "GET") {
      jsonResponse(res, 200, {
        success: true,
        config: { ...RUNTIME_CONFIG },
        domain: {
          detected: DETECTED_DOMAIN,
          type: DOMAIN_CFG.type,
          version: DOMAIN_CFG.version,
        },
      });
      return;
    }
    if (url === "/api/config" && method === "POST") {
      // SECURITY (2026-10-08): was completely unauthenticated AND
      // cross-origin-callable. updateRuntimeConfig() writes sessionVerifyUrl —
      // the exact field verifySessionWithDomain() sends session_id +
      // X-Verify-Token to. An anonymous caller could repoint it at their own
      // host and harvest session tokens. Reproduced: POST with
      // Origin: https://evil.example returned {"success":true}.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!mcpOriginAllowed(req)) {
        jsonResponse(res, 403, { error: "Forbidden: cross-origin request" });
        return;
      }
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const updated = updateRuntimeConfig(parsed);
      log("INFO", "CONFIG_UPDATED", {
        updates: Object.keys(parsed),
      });
      jsonResponse(res, 200, {
        success: true,
        config: updated,
        message: "Runtime config updated. No restart needed.",
      });
      return;
    }

    // ─── GET /api/config/origin — Full origin config ─────────
    // Serves the complete origin identity + capabilities.
    // Any client can GET this to know how to connect.
    // No auth required — this is public info.
    if (url === "/api/config/origin" && method === "GET") {
      const publicUrl = DOMAIN_CFG.appUrl || `http://localhost:${PORT}`;
      const publicHost = DOMAIN_CFG.domain || `localhost:${PORT}`;
      const protocol = DOMAIN_CFG.protocol || "http";
      const wsProtocol = protocol === "https" ? "wss" : "ws";

      jsonResponse(res, 200, {
        origin: DOMAIN_CFG.name || "Mission Barisal Gateway",
        version: DOMAIN_CFG.version,
        url: publicUrl,
        domain: DETECTED_DOMAIN,
        type: DOMAIN_CFG.type,
        session: {
          verify:
            DOMAIN_CFG.sessionVerifyUrl || `${publicUrl}/api/verify-session`,
          autoCreate: true,
          endpoint: `${publicUrl}/api/connect`,
        },
        mcp: {
          http: `${publicUrl}/mcp`,
          ws: `${wsProtocol}://${publicHost}/mcp`,
          connect: `${publicUrl}/api/connect`,
        },
        tools: Object.keys(MCP_TOOLS),
        identity: DOMAIN_CFG.identity || {
          name: "ZombieCoder",
          project: "Mission Barisal — Multi-Agent Code Platform",
        },
      });
      return;
    }

    // ─── GET /api/config/mcp — MCP config for remote clients ─
    // Returns MCP connection config with public URL.
    // Remote editors (VS Code, JetBrains, Cursor) can use this.
    if (url === "/api/config/mcp" && method === "GET") {
      const publicUrl = DOMAIN_CFG.appUrl || `http://localhost:${PORT}`;
      const publicHost = DOMAIN_CFG.domain || `localhost:${PORT}`;
      const protocol = DOMAIN_CFG.protocol || "http";
      const wsProtocol = protocol === "https" ? "wss" : "ws";

      jsonResponse(res, 200, {
        name: DOMAIN_CFG.name || "Mission Barisal Gateway",
        transport: {
          type: "http",
          url: `${publicUrl}/mcp`,
          connect: `${publicUrl}/api/connect`,
        },
        endpoints: {
          http: publicUrl,
          connect: `${publicUrl}/api/connect`,
          ws: `${wsProtocol}://${publicHost}`,
        },
        tools: Object.keys(MCP_TOOLS),
        timeout: 300000,
      });
      return;
    }

    // ─── GET /api/mcp-remote (Phase D) — outbound MCP status ──
    // Lists remote MCP servers this gateway connects TO (outbound client),
    // their discovered tools, and how many merged into MCP_TOOLS.
    if (url === "/api/mcp-remote" && method === "GET") {
      jsonResponse(res, 200, {
        ok: true,
        env: process.env.REMOTE_MCP_SERVERS || "",
        // Never expose persisted bearer tokens through a read endpoint.
        servers: Array.from(mcpRemoteClients.values()).map(({ token, ...rest }) => rest),
        mergedTools: Object.keys(MCP_TOOLS).filter((k) =>
          k.startsWith("remote__"),
        ).length,
        totalMcpTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── GET /api/mcp-external (Phase D3) — external MCP status ──
    if (url === "/api/mcp-external" && method === "GET") {
      jsonResponse(res, 200, {
        ok: true,
        config: externalMcp.CONFIG_FILE,
        envUrls: process.env.EXTERNAL_MCP_URLS || "",
        servers: externalMcp.getStatus(),
        mergedTools: Object.keys(MCP_TOOLS).filter((k) =>
          k.includes("__"),
        ).length,
        totalMcpTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── POST /api/mcp-remote/sync (Phase D) — re-discover ──
    if (url === "/api/mcp-remote/sync" && method === "POST") {
      // SECURITY (2026-10-08): re-dials every registered remote URL — same
      // outbound/SSRF surface as /add. Admin token required.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const result = await syncAllRemoteMCPs();
      const merged = mergeRemoteMcpTools();
      jsonResponse(res, 200, { ok: true, ...result, merged });
      return;
    }

    // ─── POST /api/mcp-remote/add (Phase D) — add at runtime ──
    if (url === "/api/mcp-remote/add" && method === "POST") {
      // SECURITY (2026-10-08): was unauthenticated. This endpoint makes the
      // server open an OUTBOUND connection to an arbitrary caller-supplied URL
      // (SSRF) and then merges that server's tool definitions into MCP_TOOLS,
      // so an attacker could register a hostile tool into the agent tool bus.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!mcpOriginAllowed(req)) {
        jsonResponse(res, 403, { error: "Forbidden: cross-origin request" });
        return;
      }
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!p.url) {
        jsonResponse(res, 400, { error: "url required" });
        return;
      }
      const entry = await discoverRemoteMCP({
        url: p.url,
        name: p.name || "",
        token: typeof p.token === "string" ? p.token : "",
      });
      persistRemoteMcpServers();
      const merged = mergeRemoteMcpTools();
      const { token, ...safeEntry } = entry;
      jsonResponse(res, 200, { ok: true, server: safeEntry, merged });
      return;
    }

    // ─── POST /api/mcp-remote/remove (Phase D) — drop server ──
    if (url === "/api/mcp-remote/remove" && method === "POST") {
      // SECURITY (2026-10-08): unauthenticated callers could unregister the
      // server's own MCP peers (denial of service). Admin token required.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const body = await readBody(req);
      let p;
      try {
        p = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      if (!p.name) {
        jsonResponse(res, 400, { error: "name required" });
        return;
      }
      const removed = mcpRemoteClients.delete(p.name);
      // remove merged tools for this server
      for (const k of Object.keys(MCP_TOOLS)) {
        if (k.startsWith("remote__" + p.name + "__")) delete MCP_TOOLS[k];
      }
      persistRemoteMcpServers();
      jsonResponse(res, 200, { ok: true, removed });
      return;
    }

    // ─── POST /api/set-working-dir ──────────────────────────
    // Non-MCP endpoint for zombieBridge to set working directory and auto-generate SSOT.
    // Simpler than formatting a full MCP JSON-RPC message.
    // ─── POST /api/chat/upload ─────────────────────────────────
    // One bounded binary attachment. The browser sends the raw file bytes;
    // the name travels in X-File-Name, the type in Content-Type. Storage is
    // <project>/.zombie/uploads/<sha256>.<ext> with a JSON sidecar.
    if (url === "/api/chat/upload" && method === "POST") {
      const maxBytes = sizeBudget.limit("ATTACHMENT_MAX_BYTES");
      const declared = parseInt(req.headers["content-length"] || "0", 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        jsonResponse(res, 413, {
          error: "ATTACHMENT_TOO_LARGE",
          message:
            "attachment is " + declared + " bytes; limit is " + maxBytes,
        });
        return;
      }
      const body = await readBodyBuffer(req, maxBytes);
      if (body.tooLarge) {
        jsonResponse(res, 413, {
          error: "ATTACHMENT_TOO_LARGE",
          message:
            "attachment exceeds ATTACHMENT_MAX_BYTES (" + maxBytes + " bytes)",
        });
        return;
      }
      let name = String(req.headers["x-file-name"] || "attachment");
      try {
        name = decodeURIComponent(name);
      } catch (_) {
        /* keep the raw header */
      }
      try {
        const saved = chatUpload.saveUpload({
          root: PROJECT_ROOT,
          data: body.data,
          mime: req.headers["content-type"] || "application/octet-stream",
          name,
          maxBytes,
        });
        log("INFO", "CHAT_UPLOAD", {
          id: saved.id.slice(0, 12),
          kind: saved.kind,
          bytes: saved.bytes,
          deduped: saved.deduped,
        });
        jsonResponse(res, 201, {
          ok: true,
          id: saved.id,
          name: saved.name,
          mime: saved.mime,
          kind: saved.kind,
          bytes: saved.bytes,
          deduped: saved.deduped,
        });
      } catch (e) {
        if (e instanceof chatUpload.AttachmentError) {
          jsonResponse(res, e.status, {
            error: e.code,
            message: e.message,
          });
          return;
        }
        log("WARN", "CHAT_UPLOAD_FAIL", { error: e.message });
        jsonResponse(res, 500, {
          error: "ATTACHMENT_STORE_FAILED",
          message: e.message,
        });
      }
      return;
    }

    if (url === "/api/set-working-dir" && method === "POST") {
      // SECURITY (2026-10-08): was unauthenticated AND cross-origin-open.
      // It assigns the global mcpWorkingDir, which every later read_file /
      // write_file / list_directory resolves against — so a hostile page could
      // silently retarget all subsequent tool I/O, and refreshSSOT() writes a
      // file at the caller-supplied path. Native clients (no Origin) unaffected.
      if (!mcpOriginGate(req, res, "/api/set-working-dir")) return;
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const directory = parsed.directory || parsed.dir || parsed.path || ".";
      const resolvedDir = path.resolve(directory);
      log("INFO", "SET_WORKING_DIR", {
        dir: resolvedDir,
        client: parsed.client || req.headers["x-mcp-client-name"] || "unknown",
      });
      mcpWorkingDir = resolvedDir;
      const session = ensureSessionForDir({
        sessionId: parsed.session_id || parsed.sessionId || "",
        workingDir: resolvedDir,
        clientId: parsed.client || req.headers["x-mcp-client-name"] || "http",
        editor: parsed.editor || "http",
        ip: req.socket.remoteAddress || "",
        source: "http",
      });
      const ssot = refreshSSOT(resolvedDir);
      jsonResponse(res, 200, {
        success: true,
        session_id: session.id,
        working_dir: mcpWorkingDir,
        ssot: ssot
          ? ssot.length + " bytes generated"
          : "ssot generation failed",
        message:
          "Working directory set. Session bound. Call /api/sessions to see it.",
      });
      return;
    }

    // ─── GET /api/ssot ─────────────────────────────────────────
    // Returns the current SSOT content — agents use this as source of truth.
    // Priority: 1) projectDir/mcpWorkingDir SSOT, 2) server own SSOT
    if (url === "/api/ssot" && method === "GET") {
      const ssotContent = readSSOT(mcpWorkingDir);
      if (ssotContent) {
        jsonResponse(res, 200, {
          success: true,
          source: "local-server",
          project_root: path.resolve(mcpWorkingDir || "."),
          ssot_path: path.join(
            mcpWorkingDir || path.resolve("."),
            ".zombie",
            "SSOT.md",
          ),
          length: ssotContent.length,
          content: ssotContent,
          note: "THIS is the correct SSOT. Do NOT use MCP tool ssot if root doesnt match.",
        });
      } else {
        // Auto-generate if missing
        const generated = autoSSOT(mcpWorkingDir || path.resolve("."));
        jsonResponse(res, generated ? 200 : 404, {
          success: !!generated,
          message: generated
            ? "SSOT auto-generated"
            : "No SSOT found and generation failed",
          ssot_path: SSOT_PATH,
        });
      }
      return;
    }

    // ──── GET /api/sessions ─────────────────────────────────────
    // Lists all sessions with memory/metadata (admin view)
    if (url === "/api/sessions" && method === "GET") {
      const sessions = readSessions();
      const enriched = sessions.map((s) => {
        const memDir = path.join(DATA_DIR, s.id);
        let memCount = 0;
        let agentCount = 0;
        if (fs.existsSync(memDir)) {
          try {
            const files = fs.readdirSync(memDir);
            agentCount = files.filter((f) => f.endsWith(".json")).length;
            for (const f of files) {
              if (f.endsWith(".json")) {
                try {
                  const data = JSON.parse(
                    fs.readFileSync(path.join(memDir, f), "utf8"),
                  );
                  memCount += Array.isArray(data) ? data.length : 1;
                } catch (e) { }
              }
            }
          } catch (e) { }
        }
        // Also check global session memory
        const globalMemFile = path.join(DATA_DIR, "mem-" + s.id + ".json");
        let globalMemCount = 0;
        if (fs.existsSync(globalMemFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(globalMemFile, "utf8"));
            globalMemCount = Array.isArray(data) ? data.length : 0;
          } catch (e) { }
        }
        return {
          id: s.id,
          client_id: s.client_id,
          editor: s.editor,
          model: s.model || "",
          provider: s.provider || "",
          messages: s.messages || 0,
          status: s.status,
          working_dir: (s.metadata && s.metadata.working_dir) || "",
          agent_memory_files: agentCount,
          agent_memory_entries: memCount,
          global_memory_entries: globalMemCount,
          created_at: s.created_at,
          expires_at: s.expires_at,
        };
      });
      jsonResponse(res, 200, {
        total: enriched.length,
        active: enriched.filter((s) => s.status === "active").length,
        sessions: enriched,
      });
      return;
    }

    // ──── GET /api/sessions/{id} — Single session with full memory ──
    // NOTE: /api/sessions/search has its own handler below; without this guard
    // the {id} route swallows "search" and answers 404.
    if (
      url.startsWith("/api/sessions/") &&
      !url.startsWith("/api/sessions/search") &&
      method === "GET"
    ) {
      const sessionId = url.replace("/api/sessions/", "").split("/")[0];
      if (!sessionId) {
        jsonResponse(res, 400, { error: "Session ID required" });
        return;
      }
      // Check if requesting memory sub-resource
      const isMemoryRequest = url.includes("/memory");
      const session = getSession(sessionId);
      if (!session) {
        jsonResponse(res, 404, {
          error: "Session not found or expired",
          id: sessionId,
        });
        return;
      }
      if (isMemoryRequest) {
        // Return per-agent memory
        const memDir = path.join(DATA_DIR, sessionId);
        const agentMemories = {};
        if (fs.existsSync(memDir)) {
          try {
            const files = fs.readdirSync(memDir);
            for (const f of files) {
              if (f.endsWith(".json")) {
                const agentId = f.replace(".json", "");
                try {
                  agentMemories[agentId] = JSON.parse(
                    fs.readFileSync(path.join(memDir, f), "utf8"),
                  );
                } catch (e) {
                  agentMemories[agentId] = [];
                }
              }
            }
          } catch (e) { }
        }
        // Global session memory
        const globalMem = getMemory(sessionId);
        jsonResponse(res, 200, {
          session: session,
          agent_memories: agentMemories,
          global_memory: globalMem,
          memory_count:
            Object.values(agentMemories).reduce(
              (a, b) => a + (Array.isArray(b) ? b.length : 0),
              0,
            ) + (Array.isArray(globalMem) ? globalMem.length : 0),
        });
      } else {
        // Just session metadata
        jsonResponse(res, 200, { session });
      }
      return;
    }

    // ─── POST /v1/chat/completions ──────────────────────────
    if (url === "/v1/chat/completions" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        log("INFO", "REQUEST", {
          method,
          url,
          status: 400,
          elapsed: Date.now() - startTime,
          error: "Invalid JSON",
        });
        jsonResponse(res, 400, { error: { message: "Invalid JSON" } });
        return;
      }

      // A native client may attach its current directory to the request.
      // Origin-bearing browsers stay behind the normal CORS gate.
      const requestedDir = req.headers["x-working-dir"];
      if (requestedDir && (!req.headers.origin || isOriginAllowed(req.headers.origin))) {
        const resolved = path.resolve(String(requestedDir));
        try {
          if (fs.statSync(resolved).isDirectory()) {
            mcpWorkingDir = resolved;
            const sid = req.headers["x-session-id"];
            if (sid) sessionDirs.set(String(sid), resolved);
            log("INFO", "CHAT_WORKDIR", { dir: resolved, via: "x-working-dir" });
          }
        } catch (_) {
          log("WARN", "CHAT_WORKDIR_INVALID", { dir: resolved });
        }
      }

      const model = parsed.model || "mission";
      // Optional per-request provider pin. It is validated in the proxy block
      // below; agent/mission requests reject it instead of ignoring it.
      const pinnedProvider = String(parsed.provider || "").trim();
      const rejectPinForAgent = () => {
        jsonResponse(res, 400, {
          error: {
            message:
              `Provider pin "${pinnedProvider}" applies to direct model requests only; ` +
              `"${model}" is an agent/mission request.`,
            type: "invalid_request_error",
            code: "provider_pin_agent_unsupported",
          },
        });
      };
      const messages = sanitizeMessages(parsed.messages || [], "chat");
      const stream = parsed.stream || false;
      const temperature = parsed.temperature || 0.7;
      const toolChoice = parsed.tool_choice;
      // Shared sanitizer validates the array; lib/tool-budget.js caps it
      // later in callModel/callModelStream. Every /v1/chat/completions
      // branch is protected.
      // tools:"mcp" → server builds the tool list from MCP_TOOLS. In lazy
      // mode (default) the model gets tool_search + pins instead of the
      // full catalog; it discovers a schema only when it needs one.
      const lazyTools = String(process.env.MCP_TOOL_LAZY || "1") !== "0";
      let tools = sanitizeTools(
        parsed.tools === "mcp"
          ? lazyTools
            ? lazyToolCatalog()
            : mcpToolsToOpenAI()
          : parsed.tools,
        model,
      );
      if (parsed.tools === "mcp") {
        log("INFO", "TOOL_LAZY", {
          source: "chat",
          sent: Array.isArray(tools) ? tools.length : 0,
          catalog: Object.keys(MCP_TOOLS).length,
          lazy: lazyTools,
        });
      }
      const projectContext = parsed.project_context || parsed.ssot || "";

      // ── WEB CHAT CHANNEL ────────────────────────────────
      // The browser chat window declares channel="web-chat" in the body (or
      // x-zc-channel header). That surface gets intent classification, a hard
      // chat-only tool allowlist and a bounded, untrusted web-result block.
      // Editor/MCP clients (no channel) take the normal path unchanged.
      const chatChannel = String(
        parsed.channel || req.headers["x-zc-channel"] || "",
      ).trim();
      let chatPlan = null;
      if (chatChannel === chatInterpreter.CHAT_CHANNEL) {
        const lastUser = messages.filter((m) => m.role === "user").pop();
        let chatInput = lastUser ? lastUser.content : "";
        if (Array.isArray(chatInput)) {
          chatInput = chatInput
            .map((part) =>
              typeof part === "string"
                ? part
                : (part && (part.text || part.value)) || "",
            )
            .filter(Boolean)
            .join("\n");
        } else if (chatInput && typeof chatInput === "object") {
          chatInput = chatInput.text || chatInput.value || "";
        }
        // Drop the current turn; interpretChat re-adds it as the last message.
        const history = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .slice(0, -1);
        try {
          chatPlan = await chatInterpreter.interpretChat({
            channel: chatInterpreter.CHAT_CHANNEL,
            input: String(chatInput || ""),
            history,
            tools,
            webSearch,
          });
        } catch (e) {
          log("WARN", "CHAT_INTERPRETER_FAIL", { error: e.message });
        }
        if (chatPlan) {
          // The chat window never receives file/system tools.
          if (Array.isArray(tools)) {
            tools = sanitizeTools(
              tools.filter((tool) => {
                const name =
                  typeof tool === "string"
                    ? tool
                    : (tool && tool.function && tool.function.name) || "";
                return chatPlan.allowedTools.includes(name);
              }),
              model,
            );
          }
          // Bounded web context is untrusted data, appended to the user turn
          // (never injected as a system instruction).
          if (chatPlan.webContext) {
            const userIndex = messages.reduce(
              (last, m, index) => (m.role === "user" ? index : last),
              -1,
            );
            if (userIndex >= 0) {
              let text = messages[userIndex].content;
              if (Array.isArray(text)) {
                text = text
                  .map((part) =>
                    typeof part === "string"
                      ? part
                      : (part && (part.text || part.value)) || "",
                  )
                  .filter(Boolean)
                  .join("\n");
              } else if (text && typeof text === "object") {
                text = text.text || text.value || "";
              }
              messages[userIndex] = {
                ...messages[userIndex],
                content: String(text || "") + "\n\n" + chatPlan.webContext,
              };
            }
          }
          // Observable routing metadata for the client and the E2E check.
          const ascii = (value) =>
            String(value == null ? "" : value).replace(/[^\x20-\x7E]/g, "");
          res.setHeader("x-zc-chat-channel", chatPlan.channel);
          res.setHeader(
            "x-zc-chat-intent",
            ascii((chatPlan.intent && chatPlan.intent.label) || "unknown") ||
              "unknown",
          );
          res.setHeader(
            "x-zc-chat-tools",
            ascii(chatPlan.allowedTools.join(",")) || "none",
          );
          res.setHeader("x-zc-chat-web", chatPlan.usedWebSearch ? "1" : "0");
        }
      }

      // ── CHAT ATTACHMENTS ──────────────────────────────────
      // ids reference .zombie/uploads; documents become text, photos/audio
      // become provider parts. Mission is text-only and rejects media.
      const attachmentIds =
        parsed.attachments ||
        parsed.attachment_ids ||
        parsed.attachmentIds ||
        [];
      if (Array.isArray(attachmentIds) && attachmentIds.length) {
        try {
          const uploads = chatUpload.resolveAttachments(
            PROJECT_ROOT,
            attachmentIds,
          );
          const userIndex = messages.reduce(
            (last, m, index) => (m.role === "user" ? index : last),
            -1,
          );
          if (userIndex >= 0) {
            const existing = messages[userIndex].content;
            const base = Array.isArray(existing)
              ? existing
                  .map((part) =>
                    typeof part === "string"
                      ? part
                      : (part && part.text) || "",
                  )
                  .filter(Boolean)
                  .join("\n")
              : String(existing || "");
            if (model === "mission" || model === "agent/mission") {
              const text = chatUpload.missionText(uploads);
              messages[userIndex] = {
                ...messages[userIndex],
                content: (base ? base + "\n\n" : "") + text,
              };
            } else {
              messages[userIndex] = {
                ...messages[userIndex],
                content: [
                  { type: "text", text: base },
                  ...chatUpload.buildAttachmentParts(uploads),
                ],
              };
            }
          }
        } catch (e) {
          const status =
            e instanceof chatUpload.AttachmentError ? e.status : 500;
          jsonResponse(res, status, {
            error: e.code || "ATTACHMENT_FAILED",
            message: e.message,
          });
          return;
        }
      }

      // Track model usage
      trackModelUsage(model);

      // ── Extract extended metadata from headers ──
      const sessionMeta = {
        agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
        user_agent: req.headers["user-agent"] || "",
        device_info: req.headers["x-device-info"] || parsed.device_info || "",
        editor_version:
          req.headers["x-editor-version"] || parsed.editor_version || "",
        os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
        client_version:
          req.headers["x-client-version"] || parsed.client_version || "",
        session_source: "api",
      };

      // ── PHASE B: optional API auth (Bearer session token or X-API-Key) ──
      // If auth headers ARE present they are validated; invalid → 401.
      // If no auth headers → anonymous (existing behavior preserved).
      const auth = authFromRequest(req);
      if (auth.ok === false) {
        log("INFO", "REQUEST", {
          method,
          url,
          status: 401,
          elapsed: Date.now() - startTime,
          error: "Unauthorized: " + auth.reason,
        });
        jsonResponse(res, 401, {
          error: { message: "Unauthorized: " + auth.reason },
        });
        return;
      }
      if (auth.ok === true) {
        sessionMeta.auth_user = auth.user;
        // UI-1: enforce per-user limits (token quota / expiry)
        const lim = checkUserLimits(auth.user);
        if (!lim.ok) {
          log("INFO", "REQUEST", {
            method,
            url,
            status: 403,
            elapsed: Date.now() - startTime,
            error: "Limit exceeded: " + lim.reason,
          });
          jsonResponse(res, 403, {
            error: { message: "Limit exceeded: " + lim.reason, limit: lim },
          });
          return;
        }
        // Bump usage counter (per authenticated request = 1 unit)
        bumpUserUsage(auth.user);
      }

      // Get or create session
      let sessionId = parsed.session_id;
      if (!sessionId || !getSession(sessionId)) {
        const clientIdentity = resolveClientIdentity(req, parsed);
        sessionMeta.client_id_source = clientIdentity.source;
        const session = createSession(
          clientIdentity.id,
          parsed.editor || "hermes",
          socketAddress(req) || req.socket.remoteAddress,
          sessionId || undefined,
          sessionMeta,
        );
        sessionId = session.id;
        log("INFO", "SESSION_CLIENT_RESOLVED", {
          client_id: clientIdentity.id,
          source: clientIdentity.source,
          editor: parsed.editor || "hermes",
        });
        // session_log: first touch (SQLite — Sessions page reads this)
        recordSessionTouch(sessionId, {
          editor: parsed.editor || "hermes",
          status: "active",
          user_agent: req.headers["user-agent"] || null,
        });
      } else {
        // Update existing session metadata
        const existing = getSession(sessionId);
        if (existing) {
          existing.metadata = { ...(existing.metadata || {}), ...sessionMeta };
          activeSessions.set(sessionId, existing);
        }
      }

      // Accepted, not finished: a JSON-RPC/HTTP 200 here was a lie when the
      // proxy later returned 503 (PROXY_ALL_PROVIDERS_DOWN). The real outcome
      // is recorded by recordRequestLog() after the handler completes.
      log("INFO", "CHAT_ACCEPTED", {
        method,
        url,
        model,
        session: sessionId.slice(0, 8),
        messages: messages.length,
        stream,
      });

      // ─── R2T MODE (Response-to-Tool virtual model) ──────────
      // model="r2t" dispatches marker-based OS tool execution.
      // Guarded by R2T_ENABLED env flag: when false (e.g. on cPanel
      // where the external .mjs module cannot run) the request falls
      // through to mission mode with a clear notice — the main server
      // keeps working 100% without any dependency on the r2t module.
      if (model === "r2t" || model === "agent/r2t") {
        const r2tResult = await executeR2tRequest(model, messages, {
          stream,
        });
        // Observable routing: which engine really answered, and why the
        // builtin fallback was used. ASCII-only so proxies never choke.
        const r2tHeader = (value) =>
          String(value == null ? "" : value).replace(/[^ -~]/g, "");
        if (r2tResult && r2tResult.r2tEngine) {
          res.setHeader("x-zc-r2t-engine", r2tHeader(r2tResult.r2tEngine));
        }
        if (r2tResult && r2tResult.r2tFallbackReason) {
          res.setHeader(
            "x-zc-r2t-fallback",
            r2tHeader(r2tResult.r2tFallbackReason),
          );
        }
        if (stream && r2tResult.sse) {
          jsonResponse(res, 200, r2tResult.payload);
        } else {
          jsonResponse(res, 200, r2tResult);
        }
        return;
      }

      // ─── MISSION MODE ────────────────────────────────────
      if (model === "mission" || model === "agent/mission") {
        if (pinnedProvider) {
          rejectPinForAgent();
          return;
        }
        const userMsg = messages.filter((m) => m.role === "user").pop();
        let userInput = userMsg ? userMsg.content : "";
        if (Array.isArray(userInput)) {
          userInput = userInput
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        }

        // SSE streaming if requested
        if (stream) {
          const corsOrigin = getCorsOrigin(req.headers.origin);
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": corsOrigin,
          });

          const sseId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
          const baseTs = Math.floor(Date.now() / 1000);

          const currentSession = getSession(sessionId);

          // Send initial chunk (OpenAI format) to let client know streaming started
          const initialChunk = {
            id: sseId,
            object: "chat.completion.chunk",
            created: baseTs,
            model: "mission",
            choices: [
              { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
            ],
            session_id: sessionId,
            conversation_id: currentSession?.conversation_id || sessionId,
          };
          writeWebChunk(res, initialChunk);

          // CLOUDFLARE 524 PREVENTION: Send periodic SSE keep-alive comments
          // Cloudflare times out after 100s if no data sent. SSE comments (":\n\n")
          // are valid SSE keep-alive that clients ignore but proxies see as activity.
          const keepAliveInterval = setInterval(() => {
            if (!res.writableEnded) {
              res.write(": keep-alive\n\n");
            }
          }, 30000); // Every 30 seconds

          const originalPushLog = pushLog;
          const originalPushAgent = pushAgentStatus;
          const originalPushOutput = pushOutput;
          const originalPushDone = pushDone;

          // Override push functions to also send real-time chunks via SSE
          pushLog = async (type, message) => {
            const msg = stripEmoji(
              typeof message === "string" ? message : JSON.stringify(message),
            ).slice(0, 150);
            const chunk = {
              id: sseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mission",
              choices: [
                {
                  index: 0,
                  delta: { content: msg ? "[" + type + "] " + msg : "" },
                  finish_reason: null,
                },
              ],
            };
            if (chunk.choices[0].delta.content)
              writeWebChunk(res, chunk);
            await originalPushLog(type, message);
          };
          pushAgentStatus = async (agentId, status) => {
            // Progress callback handles agent status display; just pass through to original
            await originalPushAgent(agentId, status);
          };
          pushOutput = async (output) => {
            const msg = stripEmoji(output || "").slice(0, 150);
            if (!msg) return;
            const chunk = {
              id: sseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mission",
              choices: [
                { index: 0, delta: { content: msg }, finish_reason: null },
              ],
            };
            writeWebChunk(res, chunk);
            await originalPushOutput(output);
          };
          pushDone = async (stats) => {
            await originalPushDone(stats);
          };

          // Progress callback for executeMission
          // INTERNAL ONLY — log progress but do NOT send to client
          let progressCount = 0;
          const progressCallback = (phase, id, info) => {
            progressCount++;
            // Log internally for debugging — never send to client
            log("DEBUG", "MISSION_PROGRESS", {
              phase,
              id,
              info: (info || "").slice(0, 100),
            });
          };

          let result;
          try {
            result = await antiDoteMonitor(
              executeMission,
              userInput,
              "",
              sessionId,
              progressCallback,
              tools,
            );
          } finally {
            // Ensure keep-alive is stopped even on errors
            clearInterval(keepAliveInterval);
          }

          pushLog = originalPushLog;
          pushAgentStatus = originalPushAgent;
          pushOutput = originalPushOutput;
          pushDone = originalPushDone;

          // Final chunk with the actual content
          // Extra safety: strip any remaining thinking artifacts
          let finalCombined = result.combined || "";
          if (finalCombined) {
            finalCombined = stripMissionChatArtifacts(finalCombined);
          }
          const finalChunk = {
            id: sseId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "mission",
            choices: [
              {
                index: 0,
                delta: { content: finalCombined },
                finish_reason: "stop",
              },
            ],
          };
          // telemetry: mission (stream) request
          trackAgentUsage("mission", !finalCombined);
          recordRequestLog({
            path: "/v1/chat/completions",
            session_id: sessionId,
            editor: parsed.editor || "mission",
            agent: "mission",
            model: "mission",
            status: 200,
            ok: !!finalCombined,
            elapsed_ms:
              typeof startTime === "number" ? Date.now() - startTime : 0,
            prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
            completion_tokens: Math.ceil(String(finalCombined || "").length / 4),
          });
          recordSessionTouch(sessionId, {
            agent: "mission",
            model: "mission",
            editor: parsed.editor || "mission",
          });
          writeWebChunk(res, finalChunk);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        // Non-streaming mission (with anti-dote monitoring)
        const result = await antiDoteMonitor(
          executeMission,
          userInput,
          "",
          sessionId,
          undefined,
          tools,
        );

        // Extra safety: strip any remaining thinking artifacts
        let cleanCombined = result.combined || "";
        if (cleanCombined) {
          cleanCombined = stripMissionChatArtifacts(cleanCombined);
        }

        jsonResponse(res, result.success ? 200 : 500, {
          id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mission",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: cleanCombined },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
            completion_tokens: Math.ceil(cleanCombined.length / 4),
            total_tokens: Math.ceil(
              (JSON.stringify(messages).length + cleanCombined.length) / 4,
            ),
          },
          session_id: sessionId,
          conversation_id: getSession(sessionId)?.conversation_id || sessionId,
          mission_stats: result.stats,
          mission_verification: result.verification,
        });
        // telemetry: mission (non-stream) request
        trackAgentUsage("mission", !result.success);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "mission",
          agent: "mission",
          model: "mission",
          status: result.success ? 200 : 502,
          ok: !!result.success,
          elapsed_ms:
            typeof startTime === "number" ? Date.now() - startTime : 0,
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil(String(cleanCombined || "").length / 4),
        });
        recordSessionTouch(sessionId, {
          agent: "mission",
          model: "mission",
          editor: parsed.editor || "mission",
        });

        // SSOT Auto-Refresh: refresh project context after mission completes
        // So subsequent agents get the latest file structure and content
        try {
          const projectDir = mcpWorkingDir || sessionId;
          if (projectDir && fs.existsSync(projectDir)) {
            autoSSOT(projectDir);
            log("INFO", "SSOT_REFRESHED", { dir: projectDir });
          }
        } catch (_) {
          /* SSOT refresh failure should not block response */
        }

        return;
      }

      // ─── PROXY MODE (Competition Router + Provider Fallback) ──────
      // If model is not an agent but resolves to a provider -> direct proxy
      // Try next provider on failure (rate limit, timeout, error)
      // "agent/<id>" is the documented client form. The old check compared
      // the prefixed string with bare agent ids, so every prefixed request
      // fell into proxy mode and died with model_not_found before the
      // single-agent block (which already strips the prefix) could run.
      const requestedAgentId =
        typeof model === "string" && model.startsWith("agent/")
          ? model.slice("agent/".length)
          : model;
      const hasAgentPrefix =
        typeof model === "string" && model.startsWith("agent/");
      const isAgent =
        hasAgentPrefix || AGENTS.some((a) => a.id === requestedAgentId);
      if (!isAgent) {
        // Only providers that actually advertise THIS model may serve it.
        // A different model from the same provider is never a fallback.
        let orderedProviders = resolveAllProviders(model);
        // Optional pin: honor exactly one provider, with no fallback. A pin is
        // an explicit operator/debug choice, so a failure must surface as that
        // provider's error instead of another provider's answer.
        if (pinnedProvider) {
          const pinnedConfig = PROVIDER_CONFIG[pinnedProvider];
          if (!pinnedConfig) {
            jsonResponse(res, 400, {
              error: {
                message: `Unknown provider "${pinnedProvider}".`,
                type: "invalid_request_error",
                code: "provider_not_found",
              },
            });
            return;
          }
          if (pinnedConfig.enabled === false) {
            jsonResponse(res, 400, {
              error: {
                message: `Provider "${pinnedProvider}" is disabled.`,
                type: "invalid_request_error",
                code: "provider_disabled",
              },
            });
            return;
          }
          const pinned = resolveAllProviders(model, {
            includeUnhealthy: true,
          }).find((candidate) => candidate.providerId === pinnedProvider);
          if (!pinned) {
            jsonResponse(res, 400, {
              error: {
                message:
                  `Provider "${pinnedProvider}" does not advertise model "${model}". ` +
                  `Pin a provider that serves this model, or omit "provider" to use priority routing.`,
                type: "invalid_request_error",
                code: "provider_model_mismatch",
              },
            });
            return;
          }
          orderedProviders = [pinned];
        }
        // A provider that advertises the model but has no credential cannot
        // serve it. DB -> env already happened; nothing left is a direct 404,
        // never a fake upstream attempt.
        const keyedProviders = orderedProviders.filter(
          (candidate) =>
            providerKeyState(candidate.providerId, candidate.config).ok,
        );
        if (orderedProviders.length && !keyedProviders.length) {
          const blocked = orderedProviders[0];
          log("WARN", "PROXY_PROVIDER_KEY_MISSING", {
            model,
            provider: blocked.providerId,
          });
          jsonResponse(res, 404, {
            error: {
              message:
                `Provider "${blocked.providerId}" has no API key. Add it in ` +
                `Admin -> Providers (stored in DB) or set the key in .env.`,
              type: "invalid_request_error",
              code: "provider_key_missing",
            },
          });
          return;
        }
        if (!orderedProviders.length) {
          // A model that exists but whose only providers are inside a failure
          // cooldown is NOT an unknown model. Say "temporarily unavailable"
          // so a client retries later instead of rewriting its config.
          const downProviders = resolveAllProviders(model, {
            includeUnhealthy: true,
          });
          if (downProviders.length) {
            log("WARN", "PROXY_ALL_PROVIDERS_DOWN", {
              model,
              providers: downProviders.map((p) => p.providerId),
            });
            jsonResponse(res, 503, {
              error: {
                message:
                  `All providers serving "${model}" are temporarily unavailable ` +
                  `(${downProviders.map((p) => p.providerId).join(", ")}). Retry after the cooldown.`,
                type: "server_error",
                code: "providers_down",
              },
            });
            return;
          }
          const known = [...new Set(
            Object.values(PROVIDER_CONFIG)
              .filter((p) => p.enabled !== false)
              .flatMap((p) => p.models.map((m) => getModelName(m)))
          )].filter((m) => m !== "*");
          const hint = known.slice(0, 8).join(", ");
          log("WARN", "PROXY_MODEL_UNKNOWN", { model, knownSample: hint });
          jsonResponse(res, 400, {
            error: {
              message:
                `Unknown model "${model}". No configured provider serves it.` +
                (hint ? ` Available examples: ${hint}` : ""),
              type: "invalid_request_error",
              code: "model_not_found",
            },
          });
          return;
        }

        log("INFO", "PROXY_ROUTE", {
          model,
          primaryProvider: orderedProviders[0]?.providerId,
          fallbackCount: orderedProviders.length - 1,
          pinnedProvider: pinnedProvider || null,
          stream,
          messages: messages.length,
        });

        let lastError = null;
        let usedProvider = null;
        let usedModel = model;
        let proxyResult = null;

        // Direct-model streaming: write OpenAI SSE chunks as the provider
        // emits them. Headers are delayed until the first real chunk so a
        // pre-stream provider failure can still return a JSON error.
        let sseStarted = false;
        let sseId = null;
        let sseCreated = null;
        let sseToolCalls = false;
        let activeProviderId = null;
        const onProxyChunk = stream
          ? (delta, chunk) => {
            if (Array.isArray(delta && delta.tool_calls) && delta.tool_calls.length) {
              sseToolCalls = true;
            }
            if (!sseStarted) {
              sseStarted = true;
              sseId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
              sseCreated = Math.floor(Date.now() / 1000);
              res.setHeader(
                "x-zc-chat-provider",
                activeProviderId || "unknown",
              );
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
                "Access-Control-Allow-Origin": getCorsOrigin(req.headers.origin),
              });
              res.write(
                "data: " +
                JSON.stringify({
                  id: sseId,
                  object: "chat.completion.chunk",
                  created: sseCreated,
                  model,
                  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
                }) +
                "\n\n",
              );
            }
            const upstream = chunk && chunk.choices && chunk.choices[0];
            const finish = upstream ? upstream.finish_reason : null;
            res.write(
              "data: " +
              JSON.stringify({
                id: sseId,
                object: "chat.completion.chunk",
                created: sseCreated,
                model,
                choices: [{ index: 0, delta: delta || {}, finish_reason: finish || null }],
              }) +
              "\n\n",
            );
          }
          : null;

        // Provider fallback keeps the requested model. Trying another model
        // from the same provider used to answer a request with a completely
        // different model and provider; that path is removed.
        for (const candidate of keyedProviders) {
          log("INFO", "PROXY_TRY", { model, provider: candidate.providerId });
          activeProviderId = candidate.providerId;
          proxyResult = await proxyChatCompletion(
            model,
            messages,
            stream,
            temperature,
            tools,
            candidate,
            onProxyChunk,
            toolChoice,
          );
          if (proxyResult.success) {
            usedProvider = candidate.providerId;
            usedModel = model;
            break;
          }
          lastError = proxyResult.error;
          log("WARN", "PROXY_FAIL", {
            model,
            provider: candidate.providerId,
            error: lastError,
          });
          if (stream) break;
        }

        if (!proxyResult || !proxyResult.success) {
          const failure = lastError || "No provider that serves this model succeeded";
          if (stream && sseStarted) {
            res.write("data: " + JSON.stringify({ error: { message: failure } }) + "\n\n");
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          jsonResponse(res, 502, {
            error: {
              message: failure,
              model,
              tried_providers: orderedProviders.map((p) => p.providerId),
            },
          });
          // telemetry: proxy total failure (which provider died trying)
          recordProviderStat(
            usedProvider || "unknown",
            false,
            failure,
          );
          trackProviderUsage(usedProvider || "unknown", true);
          recordRequestLog({
            path: "/v1/chat/completions",
            session_id: sessionId,
            editor: parsed.editor || "hermes",
            model,
            provider: usedProvider || null,
            status: 502,
            ok: false,
            elapsed_ms: Date.now() - startTime,
            prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          });
          return;
        }
        const currentSession = getSession(sessionId);
        // telemetry: proxy success — the provider/model that REALLY served
        recordProviderStat(usedProvider, true, null);
        trackProviderUsage(usedProvider, false);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          model: usedModel || model,
          provider: usedProvider,
          status: 200,
          ok: true,
          elapsed_ms: Date.now() - startTime,
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil(
            String((proxyResult && proxyResult.content) || "").length / 4,
          ),
        });
        recordSessionTouch(sessionId, {
          model: usedModel || model,
          provider: usedProvider,
          editor: parsed.editor || "hermes",
        });
        // TOOL ADAPTER: forward the adapter-parsed tool_calls to the
        // client — this block used to hardcode finish_reason:"stop" and
        // DROP tool_calls, so no /v1 client could ever see a function call.
        if (stream) {
          if (!sseStarted) {
            res.setHeader("x-zc-chat-provider", usedProvider || "unknown");
          }
          finishProxyStream(res, {
            started: sseStarted,
            id: sseId,
            created: sseCreated,
            model,
            origin: req.headers.origin,
            calls: proxyResult && proxyResult.tool_calls,
            callsStreamed: sseToolCalls,
          });
          return;
        }
        const proxyToolCalls =
          proxyResult && Array.isArray(proxyResult.tool_calls)
            ? proxyResult.tool_calls
            : [];
        // OpenAI-compatible clients read usage.*; it used to be {} on this
        // path while the agent path already estimated the same way.
        const proxyContent = proxyResult ? proxyResult.content || "" : "";
        const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
        const completionTokens = Math.ceil(proxyContent.length / 4);
        res.setHeader("x-zc-chat-provider", usedProvider || "unknown");
        return jsonResponse(res, 200, {
          id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          provider: usedProvider,
          actual_model: usedModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: maskModelIdentity(
                  proxyResult ? proxyResult.content : "No response",
                ),
                ...(proxyToolCalls.length ? { tool_calls: proxyToolCalls } : {}),
              },
              finish_reason: proxyToolCalls.length ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
          session_id: sessionId,
          conversation_id: currentSession?.conversation_id || sessionId,
        });
      }

      // ─── SINGLE AGENT MODE ──────────────────────────────
      const agentId = String(model).replace(/^agent\//, ""); // model param = agent id (agent/ prefix optional)
      if (pinnedProvider) {
        rejectPinForAgent();
        return;
      }
      const agent = AGENTS.find((a) => a.id === agentId);
      if (!agent) {
        jsonResponse(res, 404, {
          error: { message: "Agent or model not found: " + agentId },
        });
        return;
      }

      // Resolve the agent's provider BEFORE opening an SSE response. A
      // missing DB/env key must be a direct 404, not a 200 stream of nothing.
      const earlyAgentModel = usableAgentModel(agent);
      const earlyProviderInfo = resolveProvider(earlyAgentModel, true);
      if (earlyProviderInfo) {
        const earlyKeyState = providerKeyState(
          earlyProviderInfo.providerId,
          earlyProviderInfo.config,
        );
        if (!earlyKeyState.ok) {
          log("WARN", "AGENT_PROVIDER_KEY_MISSING", {
            agent: agent.id,
            provider: earlyProviderInfo.providerId,
          });
          jsonResponse(res, 404, {
            error: {
              message:
                `Provider "${earlyProviderInfo.providerId}" has no API key. ` +
                `Add it in Admin -> Providers (stored in DB) or set the key in .env.`,
              type: "invalid_request_error",
              code: "provider_key_missing",
            },
          });
          return;
        }
      }

      if (stream) {
        // SSE Streaming response
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
          "Access-Control-Allow-Origin": getCorsOrigin(req.headers.origin),
        });

        const responseId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
        let fullContent = "";

        // Augment messages with system prompt
        let userMsgContent =
          messages.filter((m) => m.role === "user").pop()?.content || "";
        if (Array.isArray(userMsgContent)) {
          userMsgContent = userMsgContent
            .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
            .filter(Boolean)
            .join("\n");
        } else if (userMsgContent && typeof userMsgContent === "object") {
          userMsgContent =
            userMsgContent.text ||
            userMsgContent.value ||
            JSON.stringify(userMsgContent);
        }
        const involvesCode =
          /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(
            userMsgContent,
          );

        // The server owns the system prompt; client system messages are
        // dropped so no unaudited persona or bulk context reaches the model.
        const clientSystemMessages = messages.filter(
          (m) => m.role === "system",
        );
        if (clientSystemMessages.length > 0) {
          log("INFO", "CLIENT_SYSTEM_MESSAGE_DROPPED", {
            agent: agent.id,
            count: clientSystemMessages.length,
            chars: clientSystemMessages.reduce(
              (sum, m) => sum + String(m.content || "").length,
              0,
            ),
          });
        }
        const conversation = messages.filter((m) => m.role !== "system");

        const agentModel = usableAgentModel(agent);
        const agentProviderInfo = resolveProvider(agentModel, true);
        const agentProviderId = agentProviderInfo?.providerId || "";
        const promptBudget =
          Number(agentProviderInfo?.config?.maxPromptChars) || 0;

        const sysMsg = promptBudget
          ? {
              role: "system",
              content: buildCompactSystemPrompt(agent, promptBudget),
            }
          : {
              role: "system",
              content: buildAgentSystemPrompt(agent, {
                mode: "stream",
                sessionId,
                userInput: userMsgContent,
                projectContext,
                involvesCode,
                toolsCount: (tools || []).length,
              }),
            };

        // Load memory
        let augmentedMessages = [sysMsg, ...conversation];
        if (sessionId) {
          const mem = getAgentMemory(sessionId, agentId);
          if (mem.length > 0) {
            const history = trimHistoryByChars(
              mem.filter((m) => m.role === "user" || m.role === "assistant"),
              MAX_HISTORY_CHARS,
            );
            const histMsgs = history.map((m) => ({
              role: m.role,
              content: m.content,
            }));
            augmentedMessages = [sysMsg, ...histMsgs, ...conversation];
          }
        }

        // P1-10: one session budget for every provider call. Oldest history
        // goes first; the system prompt and the newest turn always stay.
        const streamBudget = sizeBudget.trimMessages(
          augmentedMessages,
          "SESSION_MAX_BYTES",
        );
        if (streamBudget.dropped > 0) {
          log("WARN", "BUDGET_EXCEEDED", {
            key: "SESSION_MAX_BYTES",
            limit: streamBudget.limit,
            actual: streamBudget.bytes,
            dropped: streamBudget.dropped,
          });
        }
        augmentedMessages = streamBudget.messages;

        // Build the catalog; callModelStream applies the single tool budget
        // once the provider is resolved (count + bytes + prefill).
        let toolsForStream =
          tools ||
          Object.entries(MCP_TOOLS).map(([name, def]) => ({
            type: "function",
            function: {
              name,
              description: def.description || name,
              parameters: def.parameters || {
                type: "object",
                properties: def.params || {},
                required: def.required || [],
              },
            },
          }));

        // EMPTY RESPONSE RETRY: If model returns empty, retry once without tools
        let retryWithoutTools = false;
        let streamedToolCalls = 0;
        const streamCallback = (delta, parsed) => {
            const content = delta.content || "";
            const toolCalls = delta.tool_calls || null;
            if (content) fullContent += content;
            if (toolCalls) streamedToolCalls++;

            const chunk = {
              id: responseId,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: agent.id, // ← Masked: agent id, not real model
              choices: [{ index: 0, delta: {}, finish_reason: null }],
            };

            if (content) chunk.choices[0].delta.content = content;
            if (toolCalls) chunk.choices[0].delta.tool_calls = toolCalls;

            const finishReason = parsed.choices?.[0]?.finish_reason || null;
            if (finishReason) chunk.choices[0].finish_reason = finishReason;

            writeWebChunk(res, chunk);
        };

        // Streaming tool loop: execute every requested tool, then continue
        // until the model produces the final answer.
        const streamResult = await callModelStreamWithTools(
          agentModel,
          augmentedMessages,
          temperature,
          streamCallback,
          toolsForStream,
          undefined,
          {
            workingDir: getEffectiveDir(sessionId),
            contained: Boolean(sessionId && sessionDirs.has(sessionId)),
          },
        );
        if (!streamResult || !streamResult.success) {
          if (!fullContent) {
            res.write(
              "data: " +
                JSON.stringify({
                  error: {
                    message: (streamResult && streamResult.error) || "stream failed",
                  },
                }) +
                "\n\n",
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
        }


        // Final [DONE] chunk
        // Apply identity masking to full content — strip model names
        const maskedFullContent = maskModelIdentity(fullContent);
        // #5 swap_notice: surface every silent provider/model fallback
        // (ethics §4 — the user must KNOW the swap happened).
        const swapNotice = getSwapNotice(augmentedMessages);
        const doneData = JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: agent.id,
          ...(swapNotice ? { swap_notice: swapNotice } : {}),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: Math.ceil(
              JSON.stringify(augmentedMessages).length / 4,
            ),
            completion_tokens: Math.ceil(maskedFullContent.length / 4),
            total_tokens: Math.ceil(
              (JSON.stringify(augmentedMessages).length +
                maskedFullContent.length) /
              4,
            ),
          },
        });
        res.write("data: " + doneData + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();

        // Save memory
        if (sessionId) {
          const userMsg = messages.filter((m) => m.role === "user").pop();
          let userContent = userMsg ? userMsg.content : "";
          if (Array.isArray(userContent)) {
            userContent = userContent
              .map((c) => (typeof c === "string" ? c : c.text || c.value || ""))
              .filter(Boolean)
              .join("\n");
          }
          if (userMsg)
            saveAgentMemory(sessionId, agentId, "user", userContent);
          if (fullContent)
            saveAgentMemory(sessionId, agentId, "assistant", fullContent);
          saveMemory(sessionId, "user", userContent);
          saveMemory(sessionId, "assistant", fullContent);
          updateSession(sessionId, {
            model: agentId,
            provider: agentModel,
            messages: (getSession(sessionId)?.messages || 0) + 1,
          });
          flushAllMemory();
          try {
            archiveSession(
              mcpWorkingDir,
              sessionId,
              [
                { role: "user", content: stripUserRequestTags(userContent) },
                { role: "assistant", content: deduplicateText(fullContent || "") },
              ],
              `Agent ${agentId} (inline-stream): ${(fullContent || "").slice(0, 100)}`,
            );
          } catch (_) { }
        }

        // telemetry: agent/model counters + request log + session touch.
        // Attribution is the transport that actually served the stream
        // (callModelStreamWithTools reports it after any fallback).
        const _finMs = Date.now() - startTime;
        const _finProv = (streamResult && streamResult.provider) || null;
        const _finUpstream = (streamResult && streamResult.upstream_provider) || null;
        const _finModel = (streamResult && streamResult.model) || agentModel;
        trackAgentUsage(agent.id, !fullContent, _finModel, _finProv);
        recordModelStat(_finModel, _finProv, !!fullContent);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agent.id,
          model: _finModel,
          provider: _finProv,
          upstream_provider: _finUpstream,
          status: 200,
          ok: !!fullContent,
          elapsed_ms: _finMs,
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil(String(fullContent || "").length / 4),
        });
        recordSessionTouch(sessionId, {
          agent: agent.id,
          model: _finModel,
          provider: _finProv,
          editor: parsed.editor || "hermes",
        });
        const emptyStream = fullContent.length === 0;
        log(emptyStream ? "WARN" : "INFO", "SINGLE_AGENT_STREAM_COMPLETE", {
          agent: agent.id,
          contentLength: fullContent.length,
          ok: !emptyStream,
          empty: emptyStream,
          elapsed: _finMs,
        });
        if (emptyStream) {
          log("WARN", "EMPTY_STREAM", {
            agent: agent.id,
            session: sessionId.slice(0, 8),
            elapsed: _finMs,
          });
        }
        return;
      }

      // Non-streaming single agent
      const singleResult = await executeSingleAgent(
        agentId,
        messages,
        false,
        sessionId,
        tools,
        projectContext,
      );

      if (!singleResult.success) {
        // telemetry: failed agent call — provider comes from the failed call,
        // never from a fresh resolution that could name a different one.
        const _prov = singleResult.provider || null;
        const _model = singleResult.model || usableAgentModel(agent);
        trackAgentUsage(agentId, true, _model, _prov);
        recordModelStat(_model, _prov, false);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agentId,
          model: _model,
          provider: _prov,
          upstream_provider: singleResult.upstream_provider || null,
          status: 502,
          ok: false,
          elapsed_ms: Date.now() - startTime,
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
        });
        jsonResponse(res, 502, { error: { message: singleResult.error } });
        return;
      }

      // Mask the response content (safe chaining: singleResult may be null)
      const maskedContent = maskModelIdentity(
        singleResult ? singleResult.content : "No response",
      );
      const hasToolCalls =
        singleResult.tool_calls && singleResult.tool_calls.length > 0;

      const responseMessage = { role: "assistant" };
      if (hasToolCalls) {
        responseMessage.content = null;
        responseMessage.tool_calls = singleResult.tool_calls;
      } else {
        responseMessage.content = maskedContent;
      }

      // telemetry: successful agent call (non-stream). Attribution comes
      // from the result that answered, not a fresh resolveProvider().
      {
        const _prov = singleResult.provider || null;
        const _model = singleResult.model || usableAgentModel(agent);
        trackAgentUsage(agentId, false, _model, _prov);
        recordModelStat(_model, _prov, true);
        recordRequestLog({
          path: "/v1/chat/completions",
          session_id: sessionId,
          editor: parsed.editor || "hermes",
          agent: agentId,
          model: _model,
          provider: _prov,
          upstream_provider: singleResult.upstream_provider || null,
          status: 200,
          ok: true,
          elapsed_ms: Date.now() - startTime,
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil(
            String((singleResult && singleResult.content) || "").length / 4,
          ),
        });
        recordSessionTouch(sessionId, {
          agent: agentId,
          model: _model,
          provider: _prov,
          editor: parsed.editor || "hermes",
        });
      }
      // Observable attribution: the provider that actually served this
      // non-stream call. The e2e gate compares it with request_log and
      // model_stats, so a wrong attribution cannot hide.
      res.setHeader("x-zc-chat-provider", singleResult.provider || "unknown");
      jsonResponse(res, 200, {
        id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, ""),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: singleResult.maskedModel, // ← Agent ID (not real model)
        choices: [
          {
            index: 0,
            message: responseMessage,
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(messages).length / 4),
          completion_tokens: Math.ceil((maskedContent || "").length / 4),
          total_tokens: Math.ceil(
            (JSON.stringify(messages).length + (maskedContent || "").length) /
            4,
          ),
        },
        session_id: sessionId,
        conversation_id: getSession(sessionId)?.conversation_id || sessionId,
        agent: singleResult.agent,
        // #5 swap_notice (non-stream): silent fallbacks made visible
        ...(singleResult.swap_notice ? { swap_notice: singleResult.swap_notice } : {}),
      });
      return;
    }

    // ─── GET /api/verify-session ──────────────────────────────
    if (url === "/api/verify-session" && method === "GET") {
      const clientIp = req.socket.remoteAddress || "unknown";
      if (!checkRateLimit(clientIp)) {
        jsonResponse(res, 429, {
          verified: false,
          error: "Rate limit exceeded. Max 60 requests per minute.",
        });
        return;
      }

      // Multiple sources for sessionId (headers, query params, body) for robustness
      let sessionId = req.headers["x-session-id"] || "";
      const clientToken = req.headers["x-verify-token"] || "";

      // Fallback 1: Query parameters
      if (!sessionId) {
        const urlObj = new URL(req.url, `http://localhost:${PORT}`);
        sessionId =
          urlObj.searchParams.get("session_id") ||
          urlObj.searchParams.get("sessionId") ||
          urlObj.searchParams.get("session") ||
          "";
      }

      // Fallback 2: Request body (for POST-like GET requests)
      if (!sessionId && req.method === "GET") {
        try {
          const body = await readBody(req);
          const bodyData = JSON.parse(body);
          sessionId =
            bodyData.session_id ||
            bodyData.sessionId ||
            bodyData.session ||
            bodyData.client_id ||
            "";
        } catch (e) {
          // Ignore parsing errors - we'll handle missing sessionId below
        }
      }

      if (!sessionId) {
        jsonResponse(res, 400, {
          verified: false,
          error:
            "session_id required (provide via x-session-id header, session_id query param, or request body)",
          supported_methods: [
            "GET /api/verify-session?session_id=YOUR_SESSION_ID",
            "GET /api/verify-session (with x-session-id header)",
            "POST /api/mission (with session_id in body)",
          ],
        });
        return;
      }

      const localSession = getSession(sessionId);

      if (!localSession) {
      } else if (
        clientToken &&
        localSession.client_token &&
        clientToken !== localSession.client_token
      ) {
        jsonResponse(res, 401, {
          verified: false,
          error: "Token mismatch — invalid x-verify-token",
        });
        return;
      }
      if (!localSession) {
        // Get current sessions for display
        const sessions = cleanExpired();
        jsonResponse(res, 404, {
          verified: false,
          error: "session not found",
          session_id_provided: sessionId.slice(0, 8) + "...",
          available_sessions: sessions.map(
            (s) => s.id.slice(0, 8) + "... (" + s.client_id + ")",
          ),
        });
        return;
      }

      // Local session found = verified. The remote verifySessionWithDomain()
      // is only for cross-server setups (sessionVerifyUrl pointing to another
      // instance). Calling it here against our own URL causes an infinite
      // self-referential HTTP loop → always fails → "verification failed".
      const isSelfHostedVerify =
        !RUNTIME_CONFIG.sessionVerifyUrl ||
        RUNTIME_CONFIG.sessionVerifyUrl.includes(`localhost:${PORT}`) ||
        RUNTIME_CONFIG.sessionVerifyUrl.includes("localhost");
      const verifyResult = isSelfHostedVerify
        ? {
            verified: true,
            local: true,
            note: "session verified locally (self-hosted verify URL)",
          }
        : await verifySessionWithDomain(sessionId, clientToken, RUNTIME_CONFIG.sessionVerifyUrl);
      jsonResponse(res, 200, {
        verified: verifyResult.verified,
        session_id: sessionId,
        session: localSession,
        domain_verify: verifyResult,
        timestamp: new Date().toISOString(),
        client_info: {
          client_id: localSession.client_id,
          editor: localSession.editor,
          ip: localSession.ip,
          created_at: localSession.created_at,
          last_accessed: localSession.last_accessed,
        },
      });
      return;
    }

    // ─── POST /api/auth/verify (Phase B + UI-1) — api_key → session token ──
    if (url === "/api/auth/verify" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const key = p.api_key || "";
      if (!key || !MODELS_DB) {
        jsonResponse(res, 401, { error: "api_key required (and sqlite must be available)" });
        return;
      }
      const hash = sha256Hex(key);
      const user = MODELS_DB.prepare(
        "SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at FROM users WHERE api_key = ?",
      ).get(hash);
      if (!user || user.enabled !== 1) {
        jsonResponse(res, 401, { error: "invalid api_key" });
        return;
      }
      // UI-1: enforce token limit + valid_days expiry BEFORE issuing session.
      const limitCheck = checkUserLimits(user);
      if (!limitCheck.ok) {
        jsonResponse(res, limitCheck.code || 403, {
          error: limitCheck.reason,
          used: limitCheck.used,
          limit: limitCheck.limit,
          expires_at: limitCheck.expires_at,
        });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      const sid = "s_" + crypto.randomBytes(8).toString("hex");
      const now = Date.now();
      const expires = now + SESSION_TTL_MS;
      MODELS_DB.prepare(
        "INSERT INTO sessions (id, user_id, token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run(sid, user.id, token, now, expires);
      log("INFO", "AUTH_VERIFY_OK", { user: user.name });
      jsonResponse(res, 200, {
        ok: true,
        user: { id: user.id, name: user.name },
        usage: {
          used: user.token_used || 0,
          limit: user.token_limit || 0,
          valid_days: user.valid_days || 0,
          expires_at: limitCheck.expires_at || 0,
        },
        session_id: sid,
        session_token: token,
        expires_at: expires,
        ttl_ms: SESSION_TTL_MS,
      });
      return;
    }

    // ─── POST /api/auth/session (Phase B) — validate token ──────
    if (url === "/api/auth/session" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const token = p.session_token || p.token || "";
      if (!token || !MODELS_DB) {
        jsonResponse(res, 401, { error: "session_token required (and sqlite must be available)" });
        return;
      }
      const sess = MODELS_DB.prepare(
        `SELECT s.id, s.user_id, s.expires_at, u.name, u.enabled
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
      ).get(token);
      if (!sess) { jsonResponse(res, 401, { error: "invalid session" }); return; }
      if (sess.enabled !== 1) { jsonResponse(res, 403, { error: "user disabled" }); return; }
      if (sess.expires_at < Date.now()) {
        MODELS_DB.prepare("DELETE FROM sessions WHERE id = ?").run(sess.id);
        jsonResponse(res, 401, { error: "session expired" });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        valid: true,
        user: { id: sess.user_id, name: sess.name },
        expires_at: sess.expires_at,
      });
      return;
    }

    // ─── POST /api/auth/logout (Phase B) — revoke token ────────
    if (url === "/api/auth/logout" && method === "POST") {
      const body = await readBody(req);
      let p;
      try { p = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const token = p.session_token || p.token || "";
      if (MODELS_DB && token) {
        MODELS_DB.prepare("DELETE FROM sessions WHERE token = ?").run(token);
      }
      jsonResponse(res, 200, { ok: true });
      return;
    }

    // ─── UI-1: /api/admin/users — list users (with limits) ─────
    if (url === "/api/admin/users" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const rows = MODELS_DB.prepare(
        `SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at
         FROM users ORDER BY id ASC`,
      ).all();
      jsonResponse(res, 200, { count: rows.length, users: rows });
      return;
    }

    // ─── UI-1: /api/admin/users — create user → returns API key ──
    if (url === "/api/admin/users" && method === "POST") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const body = await readBody(req);
      let a;
      try { a = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const name = (a.name || "user").toString().trim();
      if (!name) {
        jsonResponse(res, 400, { error: "name is required" });
        return;
      }
      const tokenLimit = Math.max(0, parseInt(a.token_limit, 10) || 0);
      const validDays = Math.max(0, parseInt(a.valid_days, 10) || 0);
      const apiKey = "mb_" + crypto.randomBytes(16).toString("hex");
      const hash = sha256Hex(apiKey);
      const now = Date.now();
      try {
        MODELS_DB.prepare(
          `INSERT INTO users (name, api_key, enabled, token_limit, valid_days, token_used, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
        ).run(name, hash, a.enabled === undefined ? 1 : a.enabled ? 1 : 0, tokenLimit, validDays, now);
        log("INFO", "USER_CREATED", { name, token_limit: tokenLimit, valid_days: validDays });
        jsonResponse(res, 200, {
          ok: true,
          user: { name, token_limit: tokenLimit, valid_days: validDays, enabled: 1 },
          api_key: apiKey,
          note: "api_key shown once — store it safely (stored as sha256 hash on server)",
        });
      } catch (e) {
        jsonResponse(res, 500, { error: "create failed: " + e.message });
      }
      return;
    }

    // ─── UI-1: /api/admin/users/:id — update limits / enabled ──
    if (url.startsWith("/api/admin/users/") && method === "PUT") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const id = parseInt(decodeURIComponent(url.slice("/api/admin/users/".length)), 10);
      if (!id) { jsonResponse(res, 400, { error: "invalid user id" }); return; }
      const body = await readBody(req);
      let a;
      try { a = JSON.parse(body); } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }
      const sets = [];
      const vals = [];
      if (a.name !== undefined) { sets.push("name = ?"); vals.push(String(a.name).trim()); }
      if (a.enabled !== undefined) { sets.push("enabled = ?"); vals.push(a.enabled ? 1 : 0); }
      if (a.token_limit !== undefined) { sets.push("token_limit = ?"); vals.push(Math.max(0, parseInt(a.token_limit, 10) || 0)); }
      if (a.valid_days !== undefined) { sets.push("valid_days = ?"); vals.push(Math.max(0, parseInt(a.valid_days, 10) || 0)); }
      if (a.expires_at !== undefined) { sets.push("expires_at = ?"); vals.push(parseInt(a.expires_at, 10) || 0); }
      if (sets.length === 0) { jsonResponse(res, 400, { error: "nothing to update" }); return; }
      vals.push(id);
      MODELS_DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
      const row = MODELS_DB.prepare("SELECT id, name, enabled, token_limit, valid_days, token_used, expires_at, created_at FROM users WHERE id = ?").get(id);
      jsonResponse(res, 200, { ok: true, user: row });
      return;
    }

    // ─── UI-1: /api/admin/users/:id — delete user ─────────────
    if (url.startsWith("/api/admin/users/") && method === "DELETE") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      if (!MODELS_DB) {
        jsonResponse(res, 503, { error: "sqlite unavailable" });
        return;
      }
      const id = parseInt(decodeURIComponent(url.slice("/api/admin/users/".length)), 10);
      if (!id) { jsonResponse(res, 400, { error: "invalid user id" }); return; }
      MODELS_DB.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      MODELS_DB.prepare("DELETE FROM users WHERE id = ?").run(id);
      jsonResponse(res, 200, { ok: true, id });
      return;
    }

    // ─── POST /api/mission ──────────────────────────────────
    if (url === "/api/mission" && method === "POST") {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      let userInput = parsed.input || parsed.query || parsed.prompt || "";
      const missionAttachmentIds =
        parsed.attachments || parsed.attachment_ids || [];
      if (Array.isArray(missionAttachmentIds) && missionAttachmentIds.length) {
        try {
          const uploads = chatUpload.resolveAttachments(
            PROJECT_ROOT,
            missionAttachmentIds,
          );
          const text = chatUpload.missionText(uploads);
          if (text) userInput = (userInput ? userInput + "\n\n" : "") + text;
        } catch (e) {
          const status =
            e instanceof chatUpload.AttachmentError ? e.status : 500;
          jsonResponse(res, status, {
            error: e.code || "ATTACHMENT_FAILED",
            message: e.message,
          });
          return;
        }
      }
      const tools = sanitizeTools(parsed.tools, parsed.model);
      let sessionId = parsed.session_id;

      // UI-1: optional auth on /api/mission — enforce per-user limits
      const mAuth = authFromRequest(req);
      if (mAuth.ok === false) {
        jsonResponse(res, 401, { error: "Unauthorized: " + mAuth.reason });
        return;
      }
      if (mAuth.ok === true) {
        const lim = checkUserLimits(mAuth.user);
        if (!lim.ok) {
          jsonResponse(res, 403, {
            error: { message: "Limit exceeded: " + lim.reason, limit: lim },
          });
          return;
        }
        bumpUserUsage(mAuth.user);
      }

      // Track mission usage
      trackAgentUsage("mission");

      if (!sessionId || !getSession(sessionId)) {
        const missionMeta = {
          agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
          user_agent: req.headers["user-agent"] || "",
          device_info: req.headers["x-device-info"] || parsed.device_info || "",
          editor_version:
            req.headers["x-editor-version"] || parsed.editor_version || "",
          os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
          client_version:
            req.headers["x-client-version"] || parsed.client_version || "",
          session_source: "mission",
        };
        const clientIdentity = resolveClientIdentity(req, parsed);
        missionMeta.client_id_source = clientIdentity.source;
        const session = createSession(
          clientIdentity.id,
          parsed.editor || "api",
          socketAddress(req) || req.socket.remoteAddress,
          sessionId || undefined,
          missionMeta,
        );
        sessionId = session.id;
        log("INFO", "SESSION_CLIENT_RESOLVED", {
          client_id: clientIdentity.id,
          source: clientIdentity.source,
          editor: parsed.editor || "api",
        });
      }

      // Unified Socket Architecture: TransportAdapter + handleMessage
      const transport = new TransportAdapter("http", res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      transport._headersSent = true;

      handleMessage(transport, {
        type: "mission",
        id: crypto.randomUUID(),
        session_id: sessionId,
        agent_id: parsed.agent_id || agentsModule.defaultAgentId(AGENTS),
        messages: [
          ...(parsed.context || parsed.system
            ? [{ role: "system", content: parsed.context || parsed.system }]
            : []),
          { role: "user", content: userInput },
        ],
        context: {
          workspace: mcpWorkingDir || path.resolve("."),
        },
        params: {
          stream: true,
          tools: tools,
          multiAgent: true,
        },
      }).finally(() => {
        // response_done (or error) is terminal for this SSE request; without
        // this the client waits forever for a connection close.
        transport.close();
      });
      return;
    }

    // ─── POST /api/v1/anti-dote ─────────────────────────────
    // Anti-Dote Type Safety endpoint: wraps mission with full 6-step validation.
    // Provides mathematical certainty: P(success) = 1 (see wrapped contract)
    if (url === "/api/v1/anti-dote" && method === "POST") {
      // SECURITY (2026-10-08): runs a full agent mission (billable model
      // calls) with no auth and no origin check. Same Phase-B pattern as
      // /v1/chat/completions: headers, if sent, are validated; origin gated.
      if (!mcpOriginGate(req, res, "/api/v1/anti-dote")) return;
      const adAuth = authFromRequest(req);
      if (adAuth.ok === false) {
        jsonResponse(res, 401, { error: "Unauthorized: " + adAuth.reason });
        return;
      }
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const userInput = parsed.input || parsed.query || parsed.prompt || "";
      const tools = sanitizeTools(parsed.tools, parsed.model);

      // Require input
      if (!userInput) {
        jsonResponse(res, 400, {
          error: "Input required for anti-dote validation",
        });
        return;
      }

      // Track mission usage
      trackAgentUsage("mission");

      // Get or create session
      let sessionId = parsed.session_id;
      if (!sessionId || !getSession(sessionId)) {
        const antiDoteMeta = {
          agent_id: req.headers["x-agent-id"] || parsed.agent_id || "",
          user_agent: req.headers["user-agent"] || "",
          device_info: req.headers["x-device-info"] || parsed.device_info || "",
          editor_version:
            req.headers["x-editor-version"] || parsed.editor_version || "",
          os_platform: req.headers["x-os-platform"] || parsed.os_platform || "",
          client_version:
            req.headers["x-client-version"] || parsed.client_version || "",
          session_source: "anti-dote",
        };
        const clientIdentity = resolveClientIdentity(req, parsed);
        antiDoteMeta.client_id_source = clientIdentity.source;
        const session = createSession(
          clientIdentity.id,
          parsed.editor || "anti-dote",
          socketAddress(req) || req.socket.remoteAddress,
          sessionId || undefined,
          antiDoteMeta,
        );
        sessionId = session.id;
        log("INFO", "SESSION_CLIENT_RESOLVED", {
          client_id: clientIdentity.id,
          source: clientIdentity.source,
          editor: parsed.editor || "anti-dote",
        });
      }

      // Unified Socket Architecture: TransportAdapter + handleMessage
      const transport = new TransportAdapter("http", res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Accel-Buffering": "no",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      transport._headersSent = true;

      handleMessage(transport, {
        type: "mission",
        id: crypto.randomUUID(),
        session_id: sessionId,
        agent_id: parsed.agent_id || agentsModule.defaultAgentId(AGENTS),
        messages: [
          ...(parsed.context || parsed.system
            ? [{ role: "system", content: parsed.context || parsed.system }]
            : []),
          { role: "user", content: userInput },
        ],
        context: {
          workspace: mcpWorkingDir || path.resolve("."),
        },
        params: {
          stream: true,
          tools: tools,
          multiAgent: true,
          antiDote: true,
        },
      }).finally(() => {
        transport.close();
      });
      return;
    }
    // Remove the dead duplicate /api/admin/stats here — it's handled at L7732
    // ─── GET /api/admin/ssot-status ─────────────────────────
    // Check SSOT auto-generation status
    if (url === "/api/admin/ssot-status" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const ssotPath = path.resolve(".zombie/SSOT.md");
      const ssotExists = fs.existsSync(ssotPath);
      let ssotInfo = { exists: false, path: ssotPath };
      if (ssotExists) {
        const stat = fs.statSync(ssotPath);
        const content = fs.readFileSync(ssotPath, "utf8");
        ssotInfo = {
          exists: true,
          path: ssotPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          lines: content.split("\n").length,
          hasProjectName: content.includes("Project:") || content.includes("#"),
          hasStructure:
            content.includes("structure") || content.includes("Structure"),
        };
      }
      jsonResponse(res, 200, {
        ssot: ssotInfo,
        autoGenerate: true,
        scanDir: path.resolve("."),
      });
      return;
    }

    // ─── GET /api/admin/agents-status ────────────────────────
    // Detailed agent status with usage
    if (url === "/api/admin/agents-status" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const agentsWithStatus = AGENTS.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        usage: STATS.agentUsage[a.id] || {
          count: 0,
          lastUsed: null,
          errors: 0,
        },
        status: STATS.agentUsage[a.id]?.lastUsed
          ? Date.now() - new Date(STATS.agentUsage[a.id].lastUsed).getTime() <
            60000
            ? "active"
            : "idle"
          : "idle",
      }));
      jsonResponse(res, 200, { agents: agentsWithStatus });
      return;
    }

    // ─── GET /api/admin/mcp-connections ──────────────────────
    // MCP client connections and tool usage
    if (url === "/api/admin/mcp-connections" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      jsonResponse(res, 200, {
        activeConnections: mcpActiveConnections,
        clients: Array.from(mcpClients.values()),
        tools: Object.keys(MCP_TOOLS).map((name) => ({
          name,
          usage: STATS.toolUsage[name] || {
            count: 0,
            lastUsed: null,
            errors: 0,
          },
        })),
        totalTools: Object.keys(MCP_TOOLS).length,
      });
      return;
    }

    // ─── GET /api/admin/rate-limits ──────────────────────────
    // Rate limit status per domain/provider
    if (url === "/api/admin/rate-limits" && method === "GET") {
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN and panel session required" });
        return;
      }
      const domains = Object.keys(RATE_LIMIT_STATES);
      const rateLimitStatus = {};
      for (const domain of domains) {
        const state = RATE_LIMIT_STATES[domain];
        rateLimitStatus[domain] = {
          limited: state.limited,
          provider: state.provider,
          model: state.model,
          detectedAt: state.detectedAt
            ? new Date(state.detectedAt).toISOString()
            : null,
          cooldownMs: state.cooldownMs,
          remainingMs: state.limited
            ? Math.max(0, state.cooldownMs - (Date.now() - state.detectedAt))
            : 0,
        };
      }
      jsonResponse(res, 200, {
        limits: rateLimitStatus,
        config: {
          maxRateLimitPerServer: DOMAIN_CFG.maxRateLimitPerServer,
          domain: requestDomain,
        },
      });
      return;
    }

    // ─── POST /mcp (JSON-RPC 2.0) ─────────────────────────────
    if (url === "/mcp" && method === "POST") {
      handleMCP(req, res);
      return;
    }

    // ─── GET /mcp (list tools) ──────────────────────────────
    // JetBrains/IDE clients use this for persistent MCP transport.
    // SSE keeps connection alive, streaming tools+events as they happen.
    // Doc: doc/Streaming/Server-Sent-Events.md
    if (url === "/mcp" && method === "GET") {
      // SSE headers — per spec: text/event-stream, no-cache, keep-alive
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        // SECURITY (2026-10-08): was "*" — any site could open this SSE
        // stream cross-origin. Tool LIST is not secret but no reason to
        // broadcast it either; reflect only allowlisted origins.
        "Access-Control-Allow-Origin": getCorsOrigin(req.headers.origin),
      });
      // 1. Send endpoint event — tells client POST URL for JSON-RPC
      res.write("event: endpoint\ndata: /mcp\n\n");
      // 2. Send tools list as SSE event
      const tools = Object.entries(MCP_TOOLS)
        .filter(([name]) => toolEnabled(name)) // respect admin on/off
        .map(([name, def]) => ({
        name,
        description: def.description,
        inputSchema: {
          type: "object",
          properties: def.params,
          required: def.required,
        },
      }));
      res.write("event: tools\ndata: " + JSON.stringify({ tools }) + "\n\n");
      // 3. Register SSE client in Map
      const clientId =
        Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
      sseClients.set(clientId, { res, connectedAt: Date.now() });
      log("INFO", "SSE_CONNECTED", { clientId, total: sseClients.size });
      // 4. Keep-alive ping every 30s to prevent proxy/ISP timeout
      const keepAlive = setInterval(() => {
        try {
          res.write(": keepalive\n\n");
        } catch (_) {
          clearInterval(keepAlive);
        }
      }, 30000);
      // 5. Clean up on client disconnect
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(clientId);
        log("INFO", "SSE_DISCONNECTED", {
          clientId,
          remaining: sseClients.size,
        });
      });
      return;
    }

    // ─── GET /status ──────────────────────────────────────────
    if (url === "/status" && method === "GET") {
      const sessions = cleanExpired();
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        version: DOMAIN_CFG.version,
        domain: DETECTED_DOMAIN,
        serverType: DOMAIN_CFG.type,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        stats: {
          totalRequests: STATS.totalRequests,
          agents: AGENTS.length,
          sessions: sessions.length,
        },
        agents: AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          model: maskModelName(a.model),
          provider: "ZombieCoder",
        })),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ─── GET /api/version ────────────────────────────────────
    // The extension probes this endpoint solely to detect Ollama:
    // probeOllama() returns true ONLY when body.version is a string.
    // We deliberately expose the version under `apiVersion` (NOT
    // `version`) so the probe stays false and this server is not
    // misclassified as Ollama — which would otherwise trigger
    // N × POST /api/show per model in OllamaDiscovery.enrichModel.
    if (url === "/api/version" && method === "GET") {
      log("INFO", "REQUEST", {
        method,
        url,
        status: 200,
        elapsed: Date.now() - startTime,
      });
      jsonResponse(res, 200, {
        ok: true,
        server: "mission-barisal",
        apiVersion: DOMAIN_CFG.version,
        serverType: DOMAIN_CFG.type,
        domain: DETECTED_DOMAIN,
        uptime: Math.floor((Date.now() - STATS.startTime) / 1000),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // ─── POST /api/workspace — Extension sends workspace path
    // Auto-generates .zombiecoder/SSOT.md in the workspace directory
    if (url === "/api/workspace" && method === "POST") {
      // SECURITY (2026-10-08): handleWorkspace() writes .zombiecoder/SSOT.md
      // + syllabus.md under the caller-supplied workspacePath and reassigns the
      // global mcpWorkingDir — unauthenticated, cross-origin. Origin gate only:
      // the VS Code extension calls this with no Origin header.
      if (!mcpOriginGate(req, res, "/api/workspace")) return;
      handleWorkspace(req, res);
      return;
    }

    // ─── POST /api/syllabus — Add entry to syllabus.md
    if (url === "/api/syllabus" && method === "POST") {
      // SECURITY (2026-10-08): handleSyllabusAdd() writes files under
      // data.projectDir supplied by the caller — origin gate (see above).
      if (!mcpOriginGate(req, res, "/api/syllabus")) return;
      handleSyllabusAdd(req, res);
      return;
    }

    // ─── GET /api/syllabus — Read syllabus.md content
    if (url === "/api/syllabus" && method === "GET") {
      const syllabusContent = readProjectSyllabus();
      jsonResponse(res, 200, {
        ok: true,
        syllabus: syllabusContent,
        path: getSyllabusPath(),
      });
      return;
    }

    // ─── GET /api/memory — Project memory (SQLite; legacy memory.json fallback)
    if (url === "/api/memory" && method === "GET") {
      const memoryData = readMemory();
      jsonResponse(res, 200, {
        ok: true,
        memory: memoryData,
        storage: "sqlite:project_memory",
        path: MODELS_DB_PATH,
      });
      return;
    }

    // ─── GET /api/sessions/search?q=keyword — Search session archives
    if (url.startsWith("/api/sessions/search") && method === "GET") {
      const query =
        new URL(req.url, "http://localhost:" + PORT).searchParams.get("q") || "";
      const results = searchSessions(undefined, query);
      jsonResponse(res, 200, {
        ok: true,
        query,
        results,
        count: results.length,
      });
      return;
    }

    // ─── POST /api/input — Unified HTTP entry point
    // Accepts JSON body, creates TransportAdapter, routes to handleMessage
    if (url === "/api/input" && method === "POST") {
      // SECURITY (2026-10-08): execution endpoint that reaches handleMessage
      // (agents + MCP tools) with no auth and no origin check. Origin gate keeps
      // the editor extension working while blocking browser-driven abuse.
      // Optional credential auth is honored when headers are present.
      if (!mcpOriginGate(req, res, "/api/input")) return;
      const preAuth = authFromRequest(req);
      if (preAuth.ok === false) {
        jsonResponse(res, 401, { error: "Unauthorized: " + preAuth.reason });
        return;
      }
      readBody(req)
        .then((body) => {
          try {
            const parsed = JSON.parse(body);
            // Phase C: sanitize tools on the raw parsed input (if any)
            if (parsed.tools) parsed.tools = sanitizeTools(parsed.tools, parsed.model || (parsed.params && parsed.params.model));
            if (parsed.params && parsed.params.tools) {
              parsed.params.tools = sanitizeTools(parsed.params.tools, parsed.model || (parsed.params && parsed.params.model));
            }
            const transport = new TransportAdapter("http", res);
            // Set SSE-like headers for streaming response
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "X-Accel-Buffering": "no",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            transport._headersSent = true;
            handleMessage(transport, parsed).finally(() => transport.close());
          } catch (e) {
            jsonResponse(res, 400, { error: "Invalid JSON: " + e.message });
          }
        })
        .catch((e) => {
          jsonResponse(res, 400, { error: "Body read failed: " + e.message });
        });
      return;
    }

    // ─── POST /api/connect — Unified Origin Entry Point ────
    // SECRET HANDSHAKE + filesystem access via simple HTTP/JSON.
    // Any client (browser, curl, editor) — no Node.js required.
    //
    // FLOW:
    //   1. { action: "handshake", client: "browser" }
    //      → { status: "ok", session_id: "xxx", identity: {...} }
    //   2. { action: "read_file", session_id: "xxx", path: "/etc" }
    //      → { status: "ok", content: "..." }
    //
    // SECRET HANDSHAKE:
    //   Server auto-creates session for first request.
    //   Returns session_id → client caches it.
    //   Subsequent requests include session_id → treated as "local/trusted".
    //   Full directory access after handshake.
    if (url === "/api/connect" && method === "POST") {
      // SECURITY (2026-10-08) — THE BACKDOOR. The comment above sold this as
      // a "SECRET HANDSHAKE", but no secret ever existed: any caller that simply
      // omitted session_id got a brand-new session minted for them and was told
      // "You are now trusted as local client" — then handed read_file,
      // write_file, list_dir and the agent endpoints on the SAME connection.
      // Reproduced with zero credentials before the fix:
      //   curl -X POST .../api/connect -d '{"action":"handshake","client":"evil"}'
      //     -> {"status":"ok","identity":{"verified":true,"local":true},...}
      //   curl -X POST .../api/connect -d '{"action":"read_file","path":"<project>/.env"}'
      //     -> {"status":"ok","content":"OPENCODE_API_KEY=oc_sk_..."}   ← every key
      //   curl -X POST .../api/connect \
      //     -d '{"action":"write_file","path":"/tmp/x","content":"..."}'
      //     -> {"status":"ok","message":"Written 26 bytes to /tmp/x"}
      // Now: admin credential + loopback origin required, on every action.
      if (!adminRouteAuthorized(req)) {
        jsonResponse(res, 401, {
          status: "error",
          error: "Unauthorized: ADMIN_TOKEN and panel session required",
        });
        return;
      }
      if (!mcpOriginAllowed(req)) {
        jsonResponse(res, 403, {
          status: "error",
          error: "Forbidden: cross-origin request",
        });
        return;
      }
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        jsonResponse(res, 400, { error: "Invalid JSON" });
        return;
      }

      const action = parsed.action || "handshake";
      const clientIdentity = resolveClientIdentity(req, parsed);
      const clientId = clientIdentity.id;
      let sessionId = parsed.session_id || req.headers["x-session-id"] || "";
      const targetPath = parsed.path || parsed.directory || ".";
      const fileContent = parsed.content || "";
      const agentInput = parsed.input || "";
      const agentId = parsed.agent_id || agentsModule.defaultAgentId(AGENTS);

      // SECRET HANDSHAKE: Auto-create session if none provided
      if (sessionId) {
        const existing = getSession(sessionId);
        if (!existing) sessionId = ""; // expired/invalid → reset
      }

      if (!sessionId) {
        const newSession = createSession(
          clientIdentity.id,
          "origin",
          socketAddress(req) || req.socket.remoteAddress || "unknown",
          undefined,
          { client_id_source: clientIdentity.source, session_source: "connect" },
        );
        sessionId = newSession.id;
        log("INFO", "SESSION_CLIENT_RESOLVED", {
          client_id: clientIdentity.id,
          source: clientIdentity.source,
          editor: "origin",
        });
      }

      const session = getSession(sessionId);

      switch (action) {
        case "handshake":
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            conversation_id: session?.conversation_id || sessionId,
            identity: {
              client: clientId,
              verified: true,
              local: true,
              editor: "origin",
              ip: session?.ip || req.socket.remoteAddress,
            },
            origin: {
              url: DOMAIN_CFG.appUrl || `http://localhost:${PORT}`,
              domain: DETECTED_DOMAIN,
              version: DOMAIN_CFG.version,
              name: DOMAIN_CFG.name,
              type: DOMAIN_CFG.type,
            },
            tools: Object.keys(MCP_TOOLS),
            message:
              "Secret handshake complete. You are now trusted as local client.",
          });
          return;

        case "read_file": {
          const r = await executeMcpTool("read_file", { path: targetPath });
          const txt = r.content?.[0]?.text || "";
          if (
            txt.startsWith("Access denied") ||
            txt.startsWith("File not found") ||
            txt.startsWith("Not a file")
          ) {
            jsonResponse(res, 404, {
              status: "error",
              error: txt,
              path: targetPath,
            });
          } else {
            jsonResponse(res, 200, {
              status: "ok",
              content: txt,
              path: targetPath,
              bytes: txt.length,
            });
          }
          return;
        }

        case "write_file": {
          if (!targetPath || targetPath === ".") {
            jsonResponse(res, 400, {
              status: "error",
              error: "path is required for write_file",
            });
            return;
          }
          const r = await executeMcpTool("write_file", {
            path: targetPath,
            content: fileContent,
          });
          const txt = r.content?.[0]?.text || "";
          if (txt.startsWith("Access denied")) {
            jsonResponse(res, 403, { status: "error", error: txt });
          } else {
            jsonResponse(res, 200, {
              status: "ok",
              message: txt,
              path: targetPath,
            });
          }
          return;
        }

        case "list_dir":
        case "list_directory": {
          const r = await executeMcpTool("list_directory", {
            path: targetPath,
          });
          const txt = r.content?.[0]?.text || "";
          jsonResponse(res, 200, {
            status: "ok",
            listing: txt,
            path: targetPath,
          });
          return;
        }

        case "info": {
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            identity: {
              client: clientId,
              verified: true,
              local: true,
            },
            origin: {
              url: DOMAIN_CFG.appUrl || `http://localhost:${PORT}`,
              domain: DETECTED_DOMAIN,
              version: DOMAIN_CFG.version,
              name: DOMAIN_CFG.name,
            },
            working_dir: mcpWorkingDir,
            session: {
              created_at: session?.created_at,
              last_accessed: session?.last_accessed,
              conversation_id: session?.conversation_id || sessionId,
            },
          });
          return;
        }

        case "mission":
        case "agent_mission": {
          if (!agentInput) {
            jsonResponse(res, 400, {
              status: "error",
              error: "input is required for mission",
            });
            return;
          }
          const result = await executeMission(agentInput, "", sessionId);
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            action: "mission",
            result: {
              combined: result.combined?.slice(0, 50000) || "",
              agents: result.agents || [],
              rounds: result.rounds || 0,
            },
          });
          return;
        }

        case "agent":
        case "agent_single": {
          if (!agentInput) {
            jsonResponse(res, 400, {
              status: "error",
              error: "input is required for agent",
            });
            return;
          }
          const result = await executeSingleAgent(
            agentInput,
            agentId,
            sessionId,
          );
          jsonResponse(res, 200, {
            status: "ok",
            session_id: sessionId,
            action: "agent",
            agent: agentId,
            result: result.response?.slice(0, 50000) || "",
          });
          return;
        }

        default:
          jsonResponse(res, 400, {
            status: "error",
            error: `Unknown action: "${action}". Supported: handshake, read_file, write_file, list_dir, info, mission, agent`,
          });
      }
      return;
    }

    // ─── 404 ─────────────────────────────────────────────────
    log("INFO", "REQUEST", {
      method,
      url,
      status: 404,
      elapsed: Date.now() - startTime,
    });
    jsonResponse(res, 404, { error: "Not found" });
  } catch (err) {
    log("ERROR", "SERVER", { error: err.message });
    log("INFO", "REQUEST", {
      method,
      url,
      status: 500,
      elapsed: Date.now() - startTime,
    });
    // A handler may have already replied (e.g. the unknown-model 400) and
    // then thrown on the way out. Writing headers again crashes the whole
    // process with ERR_HTTP_HEADERS_SENT, so guard it.
    if (!res.headersSent) jsonResponse(res, 500, { error: err.message });
    else try { res.end(); } catch (_) {}
  }
};

const server = http.createServer(handleHttpRequest);

// 
//  WEBSOCKET HANDLER (Native, zero-dep)
// 
function handleWebSocketUpgrade(req, socket, head) {
  // SECURITY (2026-10-08): this handshake had NO origin check and replied
  // with "Access-Control-Allow-Origin: *". Cross-origin WebSocket needs no CORS
  // preflight, so any web page could open ws://localhost:3000 and drive the
  // `mcp` frame straight into executeMcpTool() → arbitrary shell. Reject
  // foreign origins up-front (no Origin header = native client = allowed).
  if (!mcpOriginAllowed(req)) {
    log("WARN", "WS_UPGRADE_DENIED", {
      origin: String(req.headers.origin || "unknown").slice(0, 120),
      remote: socket.remoteAddress,
    });
    socket.write(
      "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
    socket.destroy();
    return;
  }

  // Remember the handshake headers on the socket so per-message gates
  // (handleWSMessage → `mcp` frame) can still inspect Origin/Authorization.
  socket.__handshake = { headers: req.headers };

  const key = req.headers["sec-websocket-key"];
  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
    acceptKey +
    "\r\n\r\n",
  );

  let buffer = Buffer.alloc(0);
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length > 2) {
      const firstByte = buffer[0],
        secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f,
        offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) break;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) break;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (isMasked) {
        if (buffer.length < offset + 4) break;
        maskKey = buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + payloadLength) break;

      let payload = buffer.slice(offset, offset + payloadLength);
      if (isMasked && maskKey)
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
      buffer = buffer.slice(offset + payloadLength);

      if (opcode === 0x01) handleWSMessage(socket, payload.toString());
      else if (opcode === 0x08) {
        socket.end();
        return;
      } else if (opcode === 0x09) sendWSFrame(socket, 0x8a, payload);
    }
  });
  socket.on("close", () => log("INFO", "WS_CLOSE", {}));
  socket.on("error", (err) => log("WARN", "WS_ERROR", { error: err.message }));
}

function sendWSFrame(socket, opcode, payload) {
  payload = payload || Buffer.alloc(0);
  if (typeof payload === "string") payload = Buffer.from(payload);
  const header =
    payload.length < 126
      ? Buffer.of(opcode, payload.length)
      : payload.length < 65536
        ? Buffer.of(
          opcode,
          126,
          (payload.length >> 8) & 0xff,
          payload.length & 0xff,
        )
        : ((buf) => {
          buf[0] = opcode;
          buf[1] = 127;
          buf.writeBigUInt64BE(BigInt(payload.length), 2);
          return buf;
        })(Buffer.alloc(10));
  socket.write(Buffer.concat([header, payload]));
}

async function handleWSMessage(socket, message) {
  try {
    const data = JSON.parse(message);
    switch (data.type) {
      case "auth": {
        const authToken = data.token || "";
        const authSessionId = data.session_id || "";
        // Validate: must have a valid session or token
        let wsAuthenticated = false;
        if (authSessionId && getSession(authSessionId)) {
          wsAuthenticated = true;
        } else if (authToken && authToken.length >= 8) {
          // Token-based auth: check if token maps to a valid session
          const tokenSessionId = clientSessions.get(authToken);
          if (tokenSessionId && getSession(tokenSessionId)) {
            wsAuthenticated = true;
          }
        }
        if (wsAuthenticated) {
          sendWSFrame(
            socket,
            0x81,
            JSON.stringify({
              type: "auth_success",
              timestamp: new Date().toISOString(),
            }),
          );
        } else {
          sendWSFrame(
            socket,
            0x81,
            JSON.stringify({
              type: "auth_error",
              error: "Invalid or missing authentication token",
              timestamp: new Date().toISOString(),
            }),
          );
        }
        break;
      }
      case "chat":
      case "question": {
        // Phase 2: Route through unified handler
        const transport = new TransportAdapter("ws", socket);
        const firstAgent = AGENTS[0] || null;
        const wsModel = data.model || (firstAgent && firstAgent.model) || "";
        const wsMsg = {
          type: "chat",
          id: data.id || crypto.randomUUID(),
          messages: [
            { role: "user", content: data.message || data.content || "" },
          ],
          session_id: data.session_id || crypto.randomUUID(),
          agent_id: data.agent_id || (firstAgent && firstAgent.id) || "",
          params: {
            model: wsModel,
            tools: sanitizeTools(data.tools, wsModel),
            stream: true,
          },
        };
        // Fire and forget — handleMessage streams response via transport
        handleMessage(transport, wsMsg);
        break;
      }
      case "mcp": {
        // SECURITY GATE — same rule as POST /mcp: privileged tools
        // (terminal/exec/env_get/db_query/...) need the admin token.
        // Upgrade-time origin rejection already ran for this socket.
        const werr = mcpGate(socket.__handshake, data.tool, false);
        if (werr) {
          log("WARN", "WS_MCP_GATE_DENIED", {
            tool: data.tool,
            origin:
              (socket.__handshake &&
                socket.__handshake.headers &&
                socket.__handshake.headers.origin) ||
              "none",
          });
          sendWSFrame(
            socket,
            0x81,
            JSON.stringify({ type: "mcp_error", id: data.id, error: werr }),
          );
          break;
        }
        const toolResult = await executeMcpTool(data.tool, data.args || {});
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({ type: "mcp_result", id: data.id, ...toolResult }),
        );
        break;
      }
      case "ping":
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }),
        );
        break;
      default:
        sendWSFrame(
          socket,
          0x81,
          JSON.stringify({
            type: "error",
            data: { error: "Unknown type: " + data.type },
          }),
        );
    }
  } catch (e) {
    log("ERROR", "WS_PARSE", { error: e.message });
  }
}

server.on("upgrade", handleWebSocketUpgrade);

// Handle malformed HTTP (e.g., HTTP/2 preface from Java/IntelliJ clients)
server.on("clientError", (err, socket) => {
  log("WARN", "CLIENT_ERROR", { error: err.message });
  if (socket.writable) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  } else {
    socket.destroy();
  }
});

// Dead-code removal (2026-09-25): server.on("sessionError"/"streamError")
// was NEVER emitted — plain http.Server has no such events. The listeners
// lived on the wrong emitter. The surviving h2cServer listeners (below)
// receive Node's real sessionError/streamError, and the streamError handler
// there now carries the original 500-response intent.

// ─── HTTP/2 cleartext (h2c) inbound — SAME port as HTTP/1.1 ──────────
// The TCP sniffer above detects the HTTP/2 prior-knowledge preface and
// hands the raw socket here via emit("connection"). Every h2 stream is
// re-emitted into the SAME request handler as HTTP/1.1 — one handler,
// one auth pipeline, one port. (TLS/ALPN was explicitly dismissed.)
const h2cServer = http2.createServer();

// HTTP/2 forbids connection-specific headers (Connection, Keep-Alive,
// Transfer-Encoding, Upgrade, Proxy-Connection). The shared handler sets
// `Connection: keep-alive` on SSE endpoints — Node drops them with an
// UnsupportedWarning; strip them up-front so logs stay clean.
const H2_FORBIDDEN_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
]);

function stripH2ForbiddenHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return headers;
  }
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!H2_FORBIDDEN_HEADERS.has(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

h2cServer.on("request", (req, res) => {
  // HTTP/2 has no `host` header — only the `:authority` pseudo-header.
  // detectDomain(req.headers.host) would otherwise fall back to "localhost".
  if (!req.headers.host) {
    // Proven: :authority is in req.headers; req.authority is the safe fallback.
    req.headers.host = req.headers[":authority"] || req.authority || "";
  }
  // Wrap writeHead/setHeader so forbidden connection headers never reach
  // an h2 stream (spec-correct, keeps UnsupportedWarning out of logs).
  const origWriteHead = res.writeHead;
  res.writeHead = function (status, reasonOrHeaders, maybeHeaders) {
    if (typeof reasonOrHeaders === "string") {
      if (maybeHeaders === undefined) {
        return origWriteHead.call(res, status, reasonOrHeaders);
      }
      return origWriteHead.call(
        res,
        status,
        reasonOrHeaders,
        stripH2ForbiddenHeaders(maybeHeaders),
      );
    }
    if (reasonOrHeaders === undefined) return origWriteHead.call(res, status);
    return origWriteHead.call(res, status, stripH2ForbiddenHeaders(reasonOrHeaders));
  };
  const origSetHeader = res.setHeader;
  res.setHeader = function (name, value) {
    if (H2_FORBIDDEN_HEADERS.has(String(name).toLowerCase())) return res;
    return origSetHeader.call(res, name, value);
  };
  server.emit("request", req, res);
});

h2cServer.on("sessionError", (err) => {
  log("WARN", "HTTP2_SESSION_ERROR", { error: err.message, transport: "h2c" });
});
h2cServer.on("streamError", (err, stream) => {
  log("WARN", "HTTP2_STREAM_ERROR", {
    error: err && err.message,
    id: stream && stream.id,
    transport: "h2c",
  });
  // Intent preserved from the old (dead) http.Server listener: answer the
  // failed stream with 500 instead of leaving the client hanging.
  if (stream && stream.writable) {
    try {
      stream.respond({ ":status": 500, "content-type": "application/json" });
      stream.end(JSON.stringify({ error: "Internal stream error" }));
    } catch (_) {
      /* stream already destroyed — nothing to answer */
    }
  }
});
h2cServer.on("clientError", (err, socket) => {
  log("WARN", "HTTP2_CLIENT_ERROR", { error: err.message, transport: "h2c" });
  if (socket && socket.writable) socket.end();
  else if (socket) socket.destroy();
});
h2cServer.on("error", (err) => {
  log("WARN", "HTTP2_SERVER_ERROR", { error: err.message });
});

// 
//  START
// 
async function init() {
  // Tool budget is configuration, not a suggestion: invalid limits or more
  // pinned tools than the ceiling stop the gateway before it serves.
  const budgetConfig = toolBudget.validateConfig();
  if (!budgetConfig.ok) {
    log("FATAL", "CONFIG_FATAL", {
      component: "tool_budget",
      errors: budgetConfig.errors,
    });
    process.exit(78);
  }
  log("INFO", "TOOL_BUDGET_CONFIG", {
    max: budgetConfig.config.max,
    pinned: budgetConfig.config.pinned,
    strategy: budgetConfig.config.strategy,
    max_bytes: budgetConfig.config.maxBytes,
    max_prefill_ms: budgetConfig.config.maxPrefillMs,
    tokens_per_sec: budgetConfig.config.tokensPerSec,
  });

  // PHASE A: open SQLite models DB FIRST so that seedAgentsFromPersonas()
  // and DB-first loadPersonas() see MODELS_DB ready. initModelsDb also runs
  // later in this function; the later call is guarded to avoid re-opening.
  if (!MODELS_DB) initModelsDb();
  if (MODELS_DB) loadModelsFromDb();
  // Env vars are the single source of truth: re-apply env-defined models
  // over the DB cache so edits to .env win without a full restart.
  if (MODELS_DB) syncEnvModelsToDb();
  // Restore admin enable/disable state, then guarantee the registry:
  // runtime DB creation → local seed → remote download (in that order).
  if (MODELS_DB) loadDisabledState();
  // rehydrate persisted config + usage counters (settings/model_stats/
  // agent_stats/provider_stats) so the admin panels show REAL numbers
  // immediately after restart instead of zeros.
  if (MODELS_DB) loadRuntimeConfig();
  if (MODELS_DB) loadUsageFromDb();
  await ensureModelsRegistry();

  // PHASE A: seed agents table from PERSONAS.md on first boot (idempotent),
  // then load DB-first. PERSONAS.md remains as fallback for ids not in DB.
  seedAgentsFromPersonas();
  // Guarantee the file registry BEFORE persona repair: ensureAgentsRegistry owns
  // the insert path and its AGENTS_REPAIRED log (added=N). syncAgentPersonas
  // runs second and owns only the persona===expertise repair. The reverse order
  // let the sync insert missing rows silently, so a partial DB was repaired but
  // never reported the documented AGENTS_REPAIRED signal.
  await ensureAgentsRegistry();
  // Repair the known persona===expertise corruption before the DB-first load.
  // Admin-edited personas are left untouched; model/priority/enabled are not
  // part of this repair.
  if (MODELS_DB) {
    agentsModule.syncAgentPersonas(MODELS_DB, loadAgentFiles(), { log });
  }
  // Project memory: import legacy ctx_*.json once, then every archive goes to
  // the SQLite project_memory table (WAL). JSON session memory is untouched.
  try {
    const projectMemory = getProjectMemoryStore();
    if (projectMemory) {
      const migrated = projectMemory.migrateFromFiles(path.resolve("."));
      log("INFO", "PROJECT_MEMORY_READY", {
        storage: "sqlite:project_memory",
        ...migrated,
      });
    }
  } catch (e) {
    log("WARN", "PROJECT_MEMORY_MIGRATE_FAIL", { error: e.message });
  }
  // PHASE B: seed admin user from ADMIN_USER/ADMIN_API_KEY env (idempotent).
  seedAdminUser();
  AGENTS = await loadPersonas();
  STATS.totalAgents = AGENTS.length;

  if (AGENTS.length === 0) {
    // Every request must belong to an agent with an id and a persona. A
    // generic fallback persona is forbidden, so refuse to start instead.
    log("ERROR", "START_NO_AGENTS", {
      reason: "agent/*.js and the agents table returned no valid agent",
    });
    throw new Error("No agent definitions available; refusing to start with a generic persona.");
  }

  // Auto-generate SSOT on startup — internal server context only
  const ssotResult = autoSSOT(path.resolve("."));

  // ── Startup: User Memory Cache ─────────────────────────────
  initCache();
  log("INFO", "CACHE_READY", { dir: CACHE_DIR, ttl: CACHE_TTL + "ms" });

  // ── Startup: Note Store (single server module)
  try {
    const { initNoteStore } = require("./note-store.js");
    const noteResult = initNoteStore();
    if (noteResult.ok)
      log("INFO", "NOTE_STORE_READY", { notes: noteResult.noteCount });
  } catch (err) {
    log("WARN", "NOTE_STORE_INIT_FAILED", { error: err.message });
  }
  if (GIT_SKILLS_URL || GIT_INSTRUCTIONS_URL) {
    log("INFO", "GIT_DOWNLOAD_START", {
      skills: GIT_SKILLS_URL || "none",
      instructions: GIT_INSTRUCTIONS_URL || "none",
    });
    Promise.all([loadSkills(), loadInstructions()]).then(() =>
      log("INFO", "GIT_DOWNLOAD_DONE", {}),
    );
  }

  // Internal watchdog heartbeat (modules/watchdog.js)
  const WATCHDOG_INTERVAL_MS = parseInt(
    process.env.WATCHDOG_INTERVAL || "60000",
    10,
  );
  const watchdog = new watchdogModule.Watchdog({
    intervalMs: WATCHDOG_INTERVAL_MS,
  });
  watchdog.startHeartbeat({
    intervalMs: WATCHDOG_INTERVAL_MS,
    onBeat: () => {
      const uptime = Math.floor((Date.now() - STATS.startTime) / 1000);
      const sessions = cleanExpired().length;
      const memUsed = process.memoryUsage();
      log("INFO", "HEARTBEAT", {
        uptime_sec: uptime,
        sessions_active: sessions,
        total_requests: STATS.totalRequests,
        agents: AGENTS.length,
        rss_mb: Math.round(memUsed.rss / 1024 / 1024),
        heap_mb: Math.round(memUsed.heapUsed / 1024 / 1024),
      });
      flushAllMemory();
      writeLockLog({
        agent: "system",
        operation: "heartbeat",
        status: "success",
        duration_ms: 0,
        details: { uptime_sec: uptime, sessions, requests: STATS.totalRequests },
      });
    },
  });
  log("INFO", "WATCHDOG_STARTED", { interval_ms: WATCHDOG_INTERVAL_MS });

  // ── UDS transport: MCP + OpenAI HTTP on one socket ──────────
  // Windows has no Unix domain sockets; it keeps the loopback TCP fallback.
  // On Linux/macOS the UDS list binds in order, so a bad first path falls
  // through to the next candidate without restarting the server.
  const isWindows = process.platform === "win32";
  const udsListenPort = isWindows ? UDS_PORT : null;

  const routeUdsMessage = (socket, message) => {
    if (message.type && message.type !== "mcp") {
      const transport = new TransportAdapter("uds", socket);
      handleMessage(transport, message);
      return;
    }
    handleUdsMcpMessage(socket, message);
  };

  const attachLegacyUds = (socket, socketPath) => {
    log("INFO", "UDS_CONNECTED", { transport: "uds", path: socketPath });
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          routeUdsMessage(socket, JSON.parse(line));
        } catch (e) {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: " + e.message },
          }) + "\n");
        }
      }
    });
    socket.on("end", () => log("INFO", "UDS_DISCONNECTED", { transport: "uds" }));
    socket.on("error", (err) => log("WARN", "UDS_ERROR", { error: err.message }));
  };

  if (isWindows) {
    udsServer = net.createServer((socket) => {
      log("INFO", "UDS_CONNECTED", {
        transport: "tcp",
        path: "tcp:localhost:" + udsListenPort,
      });
      socket.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
          if (!line.trim()) continue;
          try { routeUdsMessage(socket, JSON.parse(line)); }
          catch (e) {
            socket.write(JSON.stringify({
              jsonrpc: "2.0", id: null,
              error: { code: -32700, message: "Parse error: " + e.message },
            }) + "\n");
          }
        }
      });
      socket.on("error", (err) => log("WARN", "UDS_ERROR", { error: err.message }));
    });
    udsServer.listen(udsListenPort, "localhost", () => {
      log("INFO", "UDS_LISTENING", {
        transport: "tcp-fallback",
        port: udsListenPort,
        note: "Windows: UDS not supported, using TCP loopback",
      });
    });
    udsServer.on("error", (err) => {
      log("WARN", "UDS_SERVER_ERROR", { error: err.message, transport: "tcp" });
    });
  } else if (process.env.OPENAI_UDS_PATH) {
    // Legacy/test mode: two explicit sockets, no demux. Production uses UDS.
    udsBoundPath = UDS_PATH;
    try { fs.mkdirSync(path.dirname(UDS_PATH), { recursive: true }); } catch (_) {}
    if (fs.existsSync(UDS_PATH)) {
      try { fs.unlinkSync(UDS_PATH); } catch (_) {}
    }
    udsServer = net.createServer((socket) => attachLegacyUds(socket, UDS_PATH));
    udsServer.listen(UDS_PATH, () => {
      try {
        fs.chmodSync(UDS_PATH, 0o660);
        udsBoundIno = fs.statSync(UDS_PATH).ino;
      } catch (_) {}
      log("INFO", "UDS_LISTENING", {
        transport: "uds", path: UDS_PATH, ino: udsBoundIno, protocols: ["mcp"],
      });
    });
    udsServer.on("error", (err) => {
      log("WARN", "UDS_SERVER_ERROR", { error: err.message, transport: "uds" });
    });

    if (process.env.OPENAI_UDS !== "0") {
      openaiUdsPath = path.resolve(PROJECT_ROOT, process.env.OPENAI_UDS_PATH);
      const { createUdsOpenAIServer } = require("./transport/uds-openai");
      openaiUdsServer = createUdsOpenAIServer({
        socketPath: openaiUdsPath,
        handler: handleHttpRequest,
        onListening: (p) => {
          try { openaiUdsIno = fs.statSync(p).ino; } catch (_) {}
          log("INFO", "OPENAI_UDS_LISTENING", { path: p, ino: openaiUdsIno });
        },
      });
      openaiUdsServer.listen().catch((err) => {
        log("WARN", "OPENAI_UDS_ERROR", { error: err.message });
      });
    }
  } else {
    const { createUdsGateway } = require("./transport/uds-gateway");
    const openaiOverUds = process.env.OPENAI_UDS !== "0" && process.env.UDS_OPENAI !== "0";
    const handler = openaiOverUds
      ? handleHttpRequest
      : (req, res) => jsonResponse(res, 404, {
          error: "OpenAI over UDS is disabled (UDS_OPENAI=0)",
        });
    udsGateway = createUdsGateway({
      paths: UDS_PATHS,
      handler,
      onConnection: () => log("INFO", "UDS_CONNECTED", {
        transport: "uds",
        path: udsBoundPath || UDS_PATHS[0],
      }),
      onMcpMessage: routeUdsMessage,
      onSocketError: (err) => log("WARN", "UDS_ERROR", { error: err.message }),
      onListening: (p, meta) => {
        udsBoundPath = p;
        udsFallbackUsed = !!meta.fallbackUsed;
        try { udsBoundIno = fs.statSync(p).ino; } catch (_) {}
        log("INFO", "UDS_LISTENING", {
          transport: "uds",
          path: p,
          ino: udsBoundIno,
          candidates: UDS_PATHS,
          fallback_used: udsFallbackUsed,
          protocols: openaiOverUds ? ["mcp", "openai"] : ["mcp"],
        });
      },
    });
    udsGateway.listen().catch((err) => {
      log("WARN", "UDS_BIND_FAILED", {
        candidates: UDS_PATHS,
        attempts: udsGateway ? udsGateway.attempts : [],
        error: err.message,
      });
    });
  }

  // ── Optional in-process HTTPS — Caddy stays the edge when used ──
  const httpsCert = process.env.HTTPS_CERT_PATH || "";
  const httpsKey = process.env.HTTPS_KEY_PATH || "";
  if (httpsCert && httpsKey && fs.existsSync(httpsCert) && fs.existsSync(httpsKey)) {
    const httpsPort = parseInt(process.env.HTTPS_PORT || DEFAULTS.HTTPS_PORT, 10);
    const httpsHost = serviceBindHost(
      process.env.HTTPS_HOST || process.env.BIND_HOST,
    );
    httpsServer = require("https").createServer(
      { cert: fs.readFileSync(httpsCert), key: fs.readFileSync(httpsKey) },
      handleHttpRequest,
    );
    httpsServer.on("error", (err) => log("WARN", "HTTPS_ERROR", { error: err.message }));
    httpsServer.listen(httpsPort, httpsHost, () =>
      log("INFO", "HTTPS_LISTENING", { port: httpsPort, host: httpsHost }),
    );
  }

  // ── gRPC (h2c + protobuf) — forwards to this same server ────
  if (process.env.GRPC !== "0") {
    const grpcPort = parseInt(process.env.GRPC_PORT || DEFAULTS.GRPC_PORT, 10);
    const grpcHost = serviceBindHost(
      process.env.GRPC_HOST || process.env.BIND_HOST,
    );
    const { createGrpcServer } = require("./transport/grpc");
    grpcServer = createGrpcServer({
      port: grpcPort,
      host: grpcHost,
      upstream: "http://" + grpcHost + ":" + PORT,
    });
    grpcServer.listen().then(
      (p) => log("INFO", "GRPC_LISTENING", { port: p, host: grpcHost }),
      (err) => log("WARN", "GRPC_ERROR", { error: err.message }),
    );
  }

  // ─── Startup: SQLite models DB + auto-sync ────────────────────
  // 1. Open/create the models database (node:sqlite, zero-dependency)
  //    Guarded: already opened at the top of init() for DB-first personas.
  if (!MODELS_DB) initModelsDb();
  // 2. Load previously-synced models from DB, then re-apply env-defined
  //    models on top (env = single source of truth) and persist.
  loadModelsFromDb();
  syncEnvModelsToDb();
  // 3. Fire-and-forget auto-sync: fetch live models from every
  //    provider (OpenCode, custom, Groq, Gemini), merge into
  //    PROVIDER_CONFIG and persist to SQLite. Runs in the
  //    background so it never blocks the server from listening.
  setTimeout(() => {
    runNormalizerSync()
      .then((r) => {
        log("INFO", "AUTO_SYNC_DONE", { results: r.results, db: r.db });
      })
      .catch((e) => log("WARN", "AUTO_SYNC_FAIL", { error: e.message }));
  }, 500);

  // Local model servers come and go. Re-check only local providers on a
  // timer so a server started after boot appears (and a stopped one leaves)
  // without a restart. Unref'd: the timer never keeps the process alive.
  setInterval(() => {
    refreshDynamicProviders().catch((e) =>
      log("WARN", "LOCAL_MODELS_REFRESH_FAIL", { error: e.message }),
    );
  }, parseInt(process.env.LOCAL_MODELS_REFRESH_MS || "20000", 10)).unref();

  // PRINCIPLED BIND — BIND_HOST wins; the domain heuristic is only a fallback.
  //   BIND_HOST=localhost → loopback only (required when Caddy is the edge)
  //   unset + loopback domain → localhost
  //   unset + bare IP domain  → that exact NIC IP only
  //   unset + FQDN / vhost    → 0.0.0.0 (standalone reverse-proxy target)
  let bindHost = String(process.env.BIND_HOST || "").trim();
  if (!bindHost) {
    bindHost = "0.0.0.0";
    if (DETECTED_DOMAIN === "localhost" || /^127\./.test(DETECTED_DOMAIN)) {
      bindHost = "localhost";
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(DETECTED_DOMAIN)) {
      bindHost = DETECTED_DOMAIN;
    }
  }
  tcpServer.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        "[FATAL] port " + PORT + " is already in use. Another gateway owns it; " +
        "stop that instance or set PORT to a free port.",
      );
    } else {
      console.error("[FATAL] HTTP listener error: " + (err && err.message ? err.message : String(err)));
    }
    process.exit(1);
  });
  tcpServer.listen(PORT, bindHost, () => {
    log("INFO", "START", {
      port: PORT,
      agents: AGENTS.length,
      domain: DETECTED_DOMAIN,
      bind: bindHost,
    });
    console.log("\nMission Barisal v3");
    console.log("Domain: " + DETECTED_DOMAIN + " | Type: " + DOMAIN_CFG.type);
    console.log(
      "Port: " +
      PORT +
      " | Agents: " +
      AGENTS.length +
      " | Providers: " +
      Object.keys(PROVIDER_CONFIG).length +
      " | Models: " +
      FREE_MODELS.length,
    );
    console.log("--- Providers ---");
    for (const [id, p] of Object.entries(PROVIDER_CONFIG)) {
      console.log(
        "  " +
        id +
        ": " +
        p.name +
        " [" +
        (p.models.length
          ? p.models.length + " models"
          : "wildcard (any model)") +
        "] priority=" +
        p.priority,
      );
    }
    console.log("--- Domain Config ---");
    console.log("  Domain: " + DETECTED_DOMAIN);
    console.log("  Type: " + DOMAIN_CFG.type);
    console.log("  Frontend: " + DOMAIN_CFG.hasFrontend);
    console.log("  Pusher: " + PUSHER_ENABLED);
    console.log("  CORS Origins: " + DOMAIN_CFG.corsOrigins.join(", "));
    console.log(
      "  Rate Limit: " + DOMAIN_CFG.maxRateLimitPerServer + " req/min",
    );
    console.log("--- Server Internal Context ---");
    console.log("  Root: " + path.resolve("."));
    if (ssotResult)
      console.log(
        "  SSOT: " +
        path.resolve(".", ".zombie", "SSOT.md") +
        " (internal)",
      );
    console.log("--- --- --- --- --- --- --- --- ---");
    console.log("Endpoints:");
    console.log("  GET  /health             — Health check (domain-aware)");
    console.log("  GET  /identity           — System identity (domain-aware)");
    console.log(
      "  GET  /v1/models          — List agents (masked consumer models)",
    );
    console.log(
      "  GET  /api/v1/models      — List ALL provider models (unmasked, dev)",
    );
    console.log("  POST /v1/chat/completions — Agent or mission");
    console.log("  POST /api/mission        — Full debate mission");
    console.log(
      "  POST /api/v1/anti-dote   — Anti-Dote Type Safety (6-step chain)",
    );
    console.log("  POST /api/mcp-clients    — Connected MCP clients (JSON)");
    console.log("  GET  /api/clients         — Connected MCP clients (JSON)");
    console.log(
      "  POST /api/set-working-dir — Set working dir (for zombieBridge)",
    );
    console.log("  POST /api/normalize      — Test Haq Mawla normalizer (dev)");
    console.log("  GET  /api/normalize-list — Provider + model list");
    console.log("  GET  /api/config          — View runtime config");
    console.log("  POST /api/config          — Update runtime config");
    console.log("  GET  /api/domain          — Domain detection & config");
    console.log("  POST /mcp                 MCP JSON-RPC 2.0");
    console.log("  GET  /mcp (SSE)          — MCP SSE streaming (keep-alive)");
    // Conditional: UDS_PORT only listens on Windows (UDS fallback).
    console.log(
      isWindows
        ? "  TCP  localhost:" +
            UDS_PORT +
            "        — MCP socket (Windows TCP fallback)"
        : "  UDS  " + (udsBoundPath || UDS_PATH) + "  — MCP + OpenAI (Unix domain socket)",
    );
    console.log("  WS   /                   — WebSocket for real-time");
    console.log("  POST /api/input          — Unified HTTP (handleMessage)");
    console.log(
      "  POST /api/workspace       Auto-generate SSOT for workspace\n",
    );
    console.log("[SSOT] CLIENT SSOT: set_working_dir call korlei");
    console.log("[SSOT] apnar client-er project folder-e");
    console.log("[SSOT] .zombiecoder/SSOT.md auto-generate hobe!\n");
  });

  // PHASE D: outbound MCP client — discover remote servers
  // (non-blocking, fires after listen so startup is never delayed).
  syncAllRemoteMCPs()
    .then((r) => {
      const merged = mergeRemoteMcpTools();
      if (r.synced > 0) {
        log("INFO", "REMOTE_MCP_STARTUP", { synced: r.synced, merged });
      }
    })
    .catch((e) => log("WARN", "REMOTE_MCP_STARTUP_FAIL", { error: e.message }));

  // PHASE D3: external MCP — load from 'external mcp/' folder + EXTERNAL_MCP_URLS
  // Register (or re-register) every external tool into MCP_TOOLS. Returns count
  // of NEWLY added tools. Extracted so the watchdog below can run it again.
  const registerExternalTools = () => {
    let added = 0;
    for (const t of externalMcp.getAllTools()) {
      if (MCP_TOOLS[t.fullName]) continue;
      MCP_TOOLS[t.fullName] = {
        description: "[external:" + t.serverName + "] " + (t.description || t.name),
        params: (t.inputSchema && t.inputSchema.properties) || { args: { type: "object" } },
        required: (t.inputSchema && t.inputSchema.required) || [],
      };
      added++;
    }
    return added;
  };
  let extMcpRetried = false;
  externalMcp
    .loadAll()
    .then((results) => {
      const added = registerExternalTools();
      log("INFO", "EXTERNAL_MCP_STARTUP", { servers: results.length, tools: added });
      // WATCHDOG — evidence: the 21:57:41 boot logged {"tools":0} (connect
      // race: local MCPs still booting) and 10 tools stayed dead until a manual
      // restart. If the first pass added nothing, retry ONCE after 5s.
      if (added === 0 && !extMcpRetried) {
        extMcpRetried = true;
        setTimeout(() => {
          externalMcp
            .loadAll()
            .then((r2) => {
              const n = registerExternalTools();
              log("INFO", "EXTERNAL_MCP_STARTUP_RETRY", { servers: r2.length, tools: n });
            })
            .catch((e2) =>
              log("WARN", "EXTERNAL_MCP_RETRY_FAIL", { error: e2.message }),
            );
        }, 5000);
      }
    })
    .catch((e) => log("WARN", "EXTERNAL_MCP_STARTUP_FAIL", { error: e.message }));
}

// 
//  UNIFIED MESSAGE HANDLER — Transport Adapter Layer
// 
// All transports (UDS/TCP/WS/HTTP/SSE) go through this layer.
// Handles: parsing → context injection → type safety → goal
// → routing → execution → verification → streaming response.
// ═════════════════════════════════════════════════════════════

/**
 * TransportAdapter — Wraps any transport type (UDS/TCP/WS/HTTP/SSE)
 * into a unified interface with decode/send/stream/close methods.
 */
class TransportAdapter {
  static connections = new Map();

  constructor(transportType, conn) {
    this.type = transportType;
    this.conn = conn;
    this.id =
      transportType +
      "_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2, 6);
    TransportAdapter.connections.set(this.id, {
      type: transportType,
      createdAt: Date.now(),
    });
  }

  decode(rawData) {
    if (typeof rawData === "string") return JSON.parse(rawData);
    return JSON.parse(rawData.toString("utf8"));
  }

  send(data) {
    const raw = JSON.stringify(data);
    switch (this.type) {
      case "uds":
      case "tcp":
        this.conn.write(raw + "\n");
        break;
      case "ws":
        if (typeof sendWSFrame === "function") {
          sendWSFrame(this.conn, 0x81, raw);
        } else {
          this.conn.write(raw);
        }
        break;
      case "sse":
        this.conn.write("data: " + raw + "\n\n");
        break;
      case "http":
      default:
        if (!this._headersSent) {
          this.conn.writeHead(200, {
            "Content-Type": "application/json",
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
          });
          this._headersSent = true;
        }
        this.conn.write(raw + "\n");
        break;
    }
  }

  stream(data) {
    const payload = JSON.stringify({ ...data, stream: true });
    switch (this.type) {
      case "uds":
      case "tcp":
        this.conn.write(payload + "\n");
        break;
      case "ws":
        if (typeof sendWSFrame === "function") {
          sendWSFrame(this.conn, 0x81, payload);
        } else {
          this.conn.write(payload);
        }
        break;
      case "sse":
        this.conn.write("data: " + payload + "\n\n");
        break;
      case "http":
      default:
        if (!this._headersSent) {
          this.conn.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          this._headersSent = true;
        }
        this.conn.write("data: " + payload + "\n\n");
        break;
    }
  }

  close() {
    // Idempotent: handleMessage may close on a type-safety failure and the
    // HTTP call site also closes in finally().
    if (this._closed) return;
    this._closed = true;
    // Remove from connections tracking
    TransportAdapter.connections.delete(this.id);
    try {
      if (this.type === "uds" || this.type === "tcp") {
        this.conn.end();
        this.conn.destroy();
      } else if (this.type === "ws") {
        try {
          this.conn.end();
        } catch (_) { }
      } else {
        this.conn.end();
      }
    } catch (_) { }
  }
}

// 
//  CONTEXT INJECTION — Syllabus, SSOT, Memory per-request
// 
async function injectContext(sessionId, projectDir, agentId) {
  const context = {};

  // 1. SSOT Load
  context.ssot = readSSOT(projectDir);
  if (!context.ssot) {
    context.ssot = autoSSOT(projectDir);
  }

  // 2. Syllabus Load
  context.syllabus = readProjectSyllabus(projectDir);

  // 3. Bounded excerpts only. The full files stay on disk and reach the model
  // solely through the agent system-prompt builder.
  context.ssotExcerpt = slimSSOT(context.ssot || "", "", {
    maxChars: 900,
    maxSections: 2,
  });
  context.syllabusExcerpt = slimSyllabus(context.syllabus || "", "", {
    maxChars: 1200,
    maxEntries: 3,
  });

  // 4. Agent Memory (per-agent within session)
  try {
    const memoryPath = path.join(
      projectDir,
      ".zombiecoder",
      "data",
      sessionId,
      (agentId || "default") + ".json",
    );
    if (fs.existsSync(memoryPath)) {
      const memRaw = fs.readFileSync(memoryPath, "utf8");
      context.agentMemory = JSON.parse(memRaw);
    } else {
      context.agentMemory = null;
    }
  } catch (_) {
    context.agentMemory = null;
  }

  // 5. Bounded context string. No persona or rules here: the selected agent's
  // system prompt is the single source for both.
  const merged = [
    context.ssotExcerpt
      ? "PROJECT SSOT (bounded excerpt):\n" + context.ssotExcerpt
      : "",
    context.syllabusExcerpt
      ? "AGENT SYLLABUS (bounded excerpt):\n" + context.syllabusExcerpt
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    raw: context,
    merged,
    ssotLoaded: !!context.ssot,
    syllabusLoaded: !!context.syllabus,
    memoryLoaded: !!context.agentMemory,
  };
}

// ═════════════════════════════════════════════════════════════
//  TYPE SAFETY CHECK — Anti-Dote Wrapper
// 
// Wraps existing antiDoteValidateInput, antiDoteCheckProof,
// antiDoteSetGoalContract, antiDoteVerifyOutput into a
// unified streaming-aware check.
async function typeSafetyCheck(msg, context, transport) {
  const results = {
    schemaPassed: false,
    proofPassed: false,
    consentPassed: false,
  };

  // Step 1: Schema / Input Validation
  // Pick the LAST message with actual content — Copilot/UI often appends
  // an empty trailing user message that would fail "non-empty string" check.
  const inputStr =
    (msg.messages && msg.messages.length > 0
      ? [...msg.messages]
        .reverse()
        .find(
          (m) =>
            m && typeof m.content === "string" && m.content.trim().length > 0,
        )?.content
      : "") || "";

  const validation = antiDoteValidateInput(inputStr, context);
  if (!validation.valid) {
    transport.stream({
      type: "type_safety_error",
      step: "schema",
      error: validation.error?.message || "Input validation failed",
      code: validation.error?.code || "SCHEMA_ERROR",
    });
    return { passed: false, results };
  }
  results.schemaPassed = true;

  // Step 2: Proof Check
  const proof = antiDoteCheckProof(validation.contract);
  if (!proof.provable) {
    transport.stream({
      type: "type_safety_error",
      step: "proof",
      error: proof.error?.message || "Proof verification failed",
      code: proof.error?.code || "PROOF_ERROR",
    });
    return { passed: false, results };
  }
  results.proofPassed = true;

  // Step 3: Goal Contract
  const goalContract = antiDoteSetGoalContract(proof.contract);
  if (!goalContract.contracted) {
    transport.stream({
      type: "type_safety_error",
      step: "goal_contract",
      error: goalContract.error?.message || "Goal contract failed",
      code: goalContract.error?.code || "CONTRACT_ERROR",
    });
    return { passed: false, results };
  }

  // Step 4: Consent Check
  if (msg.consent && msg.consent.granted === false) {
    transport.stream({
      type: "consent_required",
      message: "User consent needed before execution",
      contract_id: validation.contract.id,
    });
    return { passed: false, results, pending: true };
  }
  results.consentPassed = true;

  transport.stream({
    type: "type_safety_passed",
    schema: true,
    proof: true,
    consent: true,
    complexity: proof.contract.proof?.complexity || "moderate",
  });

  return {
    passed: true,
    results,
    contract: goalContract.contract,
  };
}

// 
//  GOAL SETTING CHECK
// ═════════════════════════════════════════════════════════════
// Determines what the user wants, what constraints apply,
// and what output type to expect.
function goalSettingCheck(msg, context, transport) {
  const inputStr =
    (msg.messages && msg.messages.length > 0
      ? msg.messages[msg.messages.length - 1].content
      : "") || "";

  const goal = {
    type: "general",
    constraints: [],
    expected_output: "text",
    requiresCode: false,
    requiresResearch: false,
    requiresAction: false,
  };

  // Detect goal type from input
  if (
    /\b(code|write|create|implement|function|script|program)\b/i.test(inputStr)
  ) {
    goal.type = "code_generation";
    goal.requiresCode = true;
    goal.expected_output = "code_with_explanation";
  } else if (
    /\b(debug|fix|error|bug|issue|problem|not working)\b/i.test(inputStr)
  ) {
    goal.type = "debugging";
    goal.requiresCode = true;
  } else if (
    /\b(explain|what is|how does|why|describe|tell me about)\b/i.test(inputStr)
  ) {
    goal.type = "explanation";
    goal.requiresResearch = true;
  } else if (/\b(search|find|look up|web search|google)\b/i.test(inputStr)) {
    goal.type = "research";
    goal.requiresResearch = true;
  } else if (/\b(run|execute|deploy|start|build)\b/i.test(inputStr)) {
    goal.type = "action";
    goal.requiresAction = true;
  } else if (msg.type === "mission") {
    goal.type = "multi_agent_debate";
    goal.constraints.push("all_six_agents_required");
  } else if (msg.type === "competition") {
    goal.type = "provider_comparison";
    goal.constraints.push("multiple_providers");
  }

  // Apply constraints
  if (goal.type === "code_generation") {
    goal.constraints.push("must_provide_evidence");
    goal.constraints.push("file_references_required");
  }

  transport.stream({
    type: "goal_set",
    goal: {
      type: goal.type,
      constraints: goal.constraints,
    },
  });

  return goal;
}

// 
//  SINGLE AGENT CROSS-VERIFICATION
// 
// Verifies a single agent's output for:
// - Self-consistency
// - Evidence verification
// - Reference check
// - Goal achievement
// - Code safety (if code present)
async function crossVerifySingleAgent(
  agentResult,
  userInput,
  context,
  transport,
) {
  const verification = {
    passed: false,
    score: 0,
    checks: [],
    type: "single_agent",
  };

  const content = (agentResult && agentResult.content) || "";

  transport.stream({
    type: "cross_verify_start",
    mode: "single_agent",
  });

  // Step 1: Self-Consistency
  const contradictions = detectContradictions(content);
  const selfConsistent = contradictions.length === 0;
  verification.checks.push({
    check: "self_consistency",
    passed: selfConsistent,
    detail: selfConsistent
      ? "Agent did not contradict itself"
      : "Found " + contradictions.length + " contradiction(s)",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "self_consistency",
    status: selfConsistent ? "PASSED" : "FAILED",
  });

  // Step 2: Evidence Verification
  const evidenceFound = hasEvidence(content);
  verification.checks.push({
    check: "evidence_verified",
    passed: evidenceFound,
    detail: evidenceFound
      ? "Response contains evidence/references"
      : "No evidence markers found in response",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "evidence_verified",
    status: evidenceFound ? "PASSED" : "FAILED",
  });

  // Step 3: Reference Check
  const referencedInput = referencesUserInput(content, userInput);
  verification.checks.push({
    check: "has_references",
    passed: referencedInput,
    detail: referencedInput
      ? "Agent referenced user input and context"
      : "Agent did not reference user input",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "has_references",
    status: referencedInput ? "PASSED" : "FAILED",
  });

  // Step 4: Goal Achievement
  const goalMet = content.length > 10 && content.length < 100000;
  verification.checks.push({
    check: "goal_achieved",
    passed: goalMet,
    detail: goalMet
      ? "Output length is reasonable (" + content.length + " chars)"
      : "Output too short or too long",
  });
  transport.stream({
    type: "cross_verify_check",
    check: "goal_achieved",
    status: goalMet ? "PASSED" : "FAILED",
  });

  // Step 5: Code Safety (if code present)
  if (compilerModule.containsCodeBlock(content)) {
    const codeSafe = !compilerModule.hasDangerousPatterns(content);
    verification.checks.push({
      check: "code_safe",
      passed: codeSafe,
      detail: codeSafe
        ? "Code appears safe"
        : "Code contains dangerous patterns",
    });
    transport.stream({
      type: "cross_verify_check",
      check: "code_safe",
      status: codeSafe ? "PASSED" : "FAILED",
    });
  }

  // Calculate score
  verification.score =
    verification.checks.filter((c) => c.passed).length /
    verification.checks.length;
  verification.passed = verification.score >= 0.6;

  transport.stream({
    type: "cross_verify_done",
    result: verification.passed ? "PASSED" : "FAILED",
    score: Math.round(verification.score * 100) / 100,
    passedCount: verification.checks.filter((c) => c.passed).length,
    totalCount: verification.checks.length,
  });

  return verification;
}

// ─── Cross-Verification Helpers ──────────────────────────────

function detectContradictions(text) {
  const contradictions = [];
  const patterns = [
    { a: /yes\b/i, b: /no\b/i },
    { a: /\btrue\b/i, b: /\bfalse\b/i },
    { a: /\bwill\b/i, b: /\bwont\b|will not\b/i },
  ];
  const words = text.toLowerCase().split(/\s+/);
  for (const p of patterns) {
    const hasA = words.some((w) => p.a.test(w));
    const hasB = words.some((w) => p.b.test(w));
    if (hasA && hasB) {
      contradictions.push("Possible contradiction: " + p.a + " vs " + p.b);
    }
  }
  return contradictions;
}

function hasEvidence(text) {
  return /(\u09cd\u09b0\u09ae\u09be\u09a3|evidence|according to|as per|reference|source|based on|\u0989\u09b2\u09cd\u09b2\u09c7\u0996|\u09a6\u09c7\u0996\u09be \u09af\u09be\u09af\u09bc|\u09ae\u09a4\u09c7|according)/i.test(
    text,
  );
}

function referencesUserInput(content, userInput) {
  if (!userInput) return false;
  const keywords = userInput
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);
  if (keywords.length === 0) return true;
  const matchCount = keywords.filter((kw) =>
    content.toLowerCase().includes(kw),
  ).length;
  return matchCount >= Math.min(2, keywords.length);
}

// 
//  UNIFIED MESSAGE HANDLER — Central Processing Unit
// 
// All transports route here. This function:
// 1. Parses the message
// 2. Injects context (syllabus + SSOT + memory)
// 3. Runs type safety checks
// 4. Sets goal
// 5. Routes to output point (chat/mission/competition/mcp)
// 6. Cross-verifies output
// 7. Runs compiler check if code present
// 8. Streams response back through transport
async function handleMessage(transport, rawMessage) {
  const startTime = Date.now();

  try {
    // Step 0: Detect transport type from connection
    if (!transport || !rawMessage) {
      throw new Error("Invalid transport or message");
    }

    // Step 1: Parse message
    let msg;
    if (typeof rawMessage === "string" || rawMessage instanceof Buffer) {
      msg = transport.decode(rawMessage);
    } else {
      msg = rawMessage; // Already parsed
    }

    if (!msg || !msg.type) {
      transport.stream({
        type: "error",
        error: "Message must have a 'type' field",
        code: "INVALID_MESSAGE",
      });
      return;
    }

    const sessionId = msg.session_id || "default";
    const workspace =
      msg.context?.workspace || mcpWorkingDir || path.resolve(".");
    const agentId = msg.agent_id || agentsModule.defaultAgentId(AGENTS);

    // Step 2: Inject context
    transport.stream({
      type: "context_injecting",
      session: sessionId,
      agent: agentId,
    });

    const context = await injectContext(sessionId, workspace, agentId);

    transport.stream({
      type: "context_injected",
      ssot: context.ssotLoaded,
      syllabus: context.syllabusLoaded,
      memory: context.memoryLoaded,
    });

    // Build full messages array with system context
    const systemMessages = [];
    if (context.merged) {
      systemMessages.push({
        role: "system",
        content: context.merged,
      });
    }

    // Merge with user messages (strict model-bound character cleanup).
    const allMessages = [
      ...systemMessages,
      ...sanitizeMessages(
        msg.messages || [{ role: "user", content: "" }],
        "handleMessage",
      ),
    ];

    // Step 3: Type Safety Check
    const typeSafe = await typeSafetyCheck(msg, context, transport);
    if (!typeSafe.passed) {
      const failedSteps = Object.entries(typeSafe.results || {})
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(",");
      transport.stream({
        type: "type_safety_failed",
        step: failedSteps,
      });
      // Also emit a standard "error" event so clients that only listen
      // for response_done/error (e.g. VS Code extension udsChatRequest)
      // get a meaningful error instead of a bare socket close.
      transport.stream({
        type: "error",
        error: `Type safety check failed: ${failedSteps || "unknown"}`,
        code: "TYPE_SAFETY_FAILED",
        step: failedSteps,
      });
      transport.close();
      return;
    }

    // Step 4: Goal Setting
    const goal = goalSettingCheck(msg, context, transport);

    // Step 5: Route to Output Point
    transport.stream({
      type: "routing",
      to: msg.type,
      goal_type: goal.type,
    });

    let result;
    switch (msg.type) {
      case "chat": {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            msg.params || {},
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
      case "mission": {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            { ...(msg.params || {}), multiAgent: true },
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
      case "competition": {
        result = {
          content:
            "Competition routing not yet implemented via unified handler",
          type: "competition",
        };
        break;
      }
      case "mcp":
      case "tool": {
        if (typeof handleMCP === "function") {
          result = await handleMCP(
            { body: msg.mcp || msg, method: "POST" },
            null,
          );
        } else {
          result = { content: "MCP handler not available", type: "mcp" };
        }
        break;
      }
      default: {
        const agentFn = async () => {
          return await executeSingleAgent(
            agentId,
            allMessages,
            msg.params || {},
            sessionId,
          );
        };
        const executed = await antiDoteExecute(typeSafe.contract, agentFn);
        result = executed.result || executed;
        break;
      }
    }

    // Step 6: Cross-Verification
    const verification = await crossVerifySingleAgent(
      result,
      msg.messages && msg.messages.length > 0
        ? msg.messages[msg.messages.length - 1].content
        : "",
      context,
      transport,
    );

    // Step 7: Compiler Check (if code present in result)
    const compilerResult = await compilerModule.analyzeContent(
      result?.content || "",
      null,
      context,
      transport,
    );

    // Step 8: Stream completion signal
    const elapsed = Date.now() - startTime;
    transport.stream({
      type: "response_done",
      id: msg.id || null,
      data: {
        content: result?.content || "",
        done: true,
      },
      verification: {
        type_safe: typeSafe.passed,
        goal_met: verification.passed,
        cross_verified: verification.passed,
        compiler_checked: compilerResult.passed || compilerResult.skipped,
      },
      usage: {
        elapsed_ms: elapsed,
        transport: transport.type,
        session_id: sessionId,
        agent_id: agentId,
      },
    });

    log("INFO", "HANDLE_MESSAGE_COMPLETE", {
      type: msg.type,
      transport: transport.type,
      session: sessionId,
      agent: agentId,
      elapsed,
      verified: verification.passed,
      compiler: compilerResult.passed || compilerResult.skipped,
    });
  } catch (e) {
    const elapsed = Date.now() - startTime;
    log("ERROR", "HANDLE_MESSAGE_FAILED", {
      error: e.message,
      stack: e.stack?.split("\n").slice(0, 3).join(" | "),
      elapsed,
    });
    transport.stream({
      type: "error",
      error: e.message,
      code: "HANDLER_ERROR",
      elapsed_ms: elapsed,
    });
  }
}

// Installer one-shot: create/validate the models DB without starting HTTP.
// DB_BOOTSTRAP=1 is still required when the file is missing.
if (process.argv.includes("--db-bootstrap")) {
  initModelsDb();
  process.exit(0);
}

init();

// ════
//  R2T — RESPONSE-TO-TOOL VIRTUAL MODEL (external module bridge)
// ════
//  Purpose:
//    model="r2t" converts marker blocks ([[TOOL:exec]]...[[/TOOL]]) in
//    the user message into real OS tool executions, then returns the
//    result in OpenAI chat.completion format via Haq Mawla normalizer.
//
//  cPanel / environment safety:
//    The heavy logic lives in the optional external module
//    `external tools/r2t-response-to-tool.mjs`. If that module cannot
//    load (cPanel, older Node, missing file) OR R2T_ENABLED=false,
//    this function degrades gracefully — it never throws into the main
//    request pipeline and the rest of the server keeps working.
//
//  Env flags (true/false switches read from environment):
//    R2T_ENABLED  - opt-in only: "true" runs r2t; absent/false bypasses.
//    Default was true until 2026-11-25: a fresh checkout executed
//    [[TOOL:exec]] from the request body with no admin gate.
//    R2T_MODULE   - custom path to the r2t module (default below).
//    R2T_PORT     - passed through to the module (port for its server).
//    R2T_URL      - open compatible URL the module talks to. When the
//                   external r2t module is absent (default), the builtin
//                   basicR2tExecutor is used — no network call happens.
//
//  Returns an OpenAI-shaped object: { choices:[{message:{content}}], ...}
// ════
async function executeR2tRequest(requestModel, messages, opts = {}) {
  const startedAt = Date.now();
  // Trace state: which engine really answered, and why the builtin was used.
  let r2tEngine = "unknown";
  let r2tFallbackReason = "";
  const withTrace = (normalized) => {
    if (normalized && typeof normalized === "object") {
      normalized.r2tEngine = r2tEngine;
      if (r2tFallbackReason) normalized.r2tFallbackReason = r2tFallbackReason;
    }
    return normalized;
  };
  const safeSend = (note) =>
    withTrace(
      normalizeResponse(
        {
          id: "r2t-" + Date.now(),
          created: Math.floor(Date.now() / 1000),
          model: requestModel,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: note,
              },
              finish_reason: "stop",
            },
          ],
          usage: {},
        },
        requestModel,
      ),
    );

  // 1) Env gate — cPanel-safe switch.
  const enabled =
    String(process.env.R2T_ENABLED || "").toLowerCase() === "true";
  if (!enabled) {
    r2tEngine = "disabled";
    log("INFO", "R2T_DISABLED", { env: "R2T_ENABLED=false" });
    return safeSend(
      '[r2t] R2T_ENABLED=false — r2t virtual model is off on this environment.'
    );
  }

  // 2) Extract the last user text from messages (OpenAI multi-modal aware).
  const userMsg = messages.filter((m) => m.role === "user").pop();
  let userInput = userMsg ? userMsg.content : "";
  if (Array.isArray(userInput)) {
    userInput = userInput
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (!userInput || !userInput.trim()) {
    r2tEngine = "no-input";
    return safeSend("[r2t] no user message content provided");
  }

  // 3) Optional markdown code fences are stripped so plain markers work.
  userInput = userInput
    .replace(/^```[a-zA-Z0-9_-]*\n?/gm, "")
    .replace(/\n?```$/gm, "")
    .trim();

  // 4) Load the external r2t module (optional — local dev only).
  const modulePath =
    process.env.R2T_MODULE ||
    path.join(__dirname, "external tools", "r2t-response-to-tool.mjs");
  let mod = null;
  if (fs.existsSync(modulePath)) {
    try {
      mod = await import(pathToFileURL(modulePath).href + "?v=" + Date.now());
    } catch (e) {
      r2tEngine = "builtin-fallback";
      r2tFallbackReason = "module-load-failed";
      log("WARN", "R2T_MODULE_LOAD_FAILED", { error: String(e.message || e) });
      log("WARN", "R2T_BUILTIN_FALLBACK", {
        reason: r2tFallbackReason,
        module: modulePath,
      });
      mod = null;
    }
  } else {
    r2tEngine = "builtin-fallback";
    r2tFallbackReason = "module-missing";
    log("WARN", "R2T_BUILTIN_FALLBACK", {
      reason: r2tFallbackReason,
      module: modulePath,
    });
  }

  // 5) Execute markers via the module; degrade to a basic executor when
  //    the module is unavailable (keeps the request pipeline alive).
  let result;
  try {
    if (mod && typeof mod.convertResponse === "function") {
      result = await mod.convertResponse(userInput);
      r2tEngine = "external-module";
      result.r2tEngine = "external-module";
      result.module = modulePath;
    } else {
      if (!r2tFallbackReason) {
        r2tEngine = "builtin-fallback";
        r2tFallbackReason = "no-convert-response";
        log("WARN", "R2T_BUILTIN_FALLBACK", {
          reason: r2tFallbackReason,
          module: modulePath,
        });
      }
      result = await basicR2tExecutor(userInput);
      result.r2tEngine = "builtin-fallback";
    }
  } catch (e) {
    log("ERROR", "R2T_EXEC_FAILED", { error: String(e.message || e) });
    return safeSend(
      "[r2t] execution failed: " + String(e.message || e).slice(0, 300)
    );
  }

  // 6) Wrap into OpenAI shape and pass through Haq Mawla normalizer.
  result.elapsedMs = Date.now() - startedAt;
  const normalized = normalizeResponse(
    {
      id: "r2t-" + Date.now(),
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify(result, null, 2),
          },
          finish_reason: "stop",
        },
      ],
      usage: {},
      r2t: true,
    },
    requestModel,
  );
  return withTrace(normalized);
}

// ── Built-in minimal marker executor (dependency-free fallback) ─────
// Understands a safe subset: info, list, read, stat, exec, git.
// Full toolset requires the external r2t module (see R2T_ENABLED).
async function basicR2tExecutor(input) {
  const blocks = [];
  const re =
    /\[\[(?:TOOL:)?(\w+)\]\]\s*([\s\S]*?)\s*\[\[(?:TOOL:)?\/(?:\1|TOOL)\]\]/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    blocks.push({ name: m[1].toLowerCase(), body: m[2].trim(), full: m[0] });
  }
  if (blocks.length === 0) {
    return {
      status: "ok",
      matched: 0,
      note: "no [[TOOL:...]] markers found — r2t module not loaded?",
      hint: "install the external r2t module for full toolset",
    };
  }
  const results = [];
  for (const b of blocks) {
    try {
      if (b.name === "info") {
        results.push({ tool: "info", status: "ok", cwd: process.cwd(), node: process.version });
      } else if (b.name === "list") {
        const p = path.resolve(b.body || ".");
        results.push({
          tool: "list",
          status: "ok",
          path: p,
          entries: fs.existsSync(p) ? fs.readdirSync(p) : [],
        });
      } else if (b.name === "read") {
        const p = path.resolve(b.body);
        results.push({
          tool: "read",
          status: fs.existsSync(p) ? "ok" : "error",
          path: p,
          content: fs.existsSync(p) ? fs.readFileSync(p, "utf8").slice(0, 4000) : "",
        });
      } else if (b.name === "stat") {
        const p = path.resolve(b.body);
        results.push({
          tool: "stat",
          status: fs.existsSync(p) ? "ok" : "error",
          path: p,
          size: fs.existsSync(p) ? fs.statSync(p).size : 0,
        });
      } else if (b.name === "exec") {
        const out = await new Promise((resolve) => {
          require("child_process").exec(b.body, { timeout: 10000 }, (err, stdout, stderr) =>
            resolve({
              status: err ? "error" : "ok",
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
            })
          );
        });
        results.push({ tool: "exec", lowerBound: true, ...out });
      } else if (b.name === "git") {
        const out = await new Promise((resolve) => {
          require("child_process").execFile("git", (b.body || "status").split(/\s+/), { timeout: 10000 }, (err, stdout, stderr) =>
            resolve({
              status: err ? "error" : "ok",
              stdout: (stdout || "").trim(),
              stderr: (stderr || "").trim(),
            })
          );
        });
        results.push({ tool: "git", ...out });
      } else {
        results.push({
          tool: b.name,
          status: "unavailable",
          error: "builtin fallback does not implement this tool — load the r2t module",
        });
      }
    } catch (e) {
      results.push({ tool: b.name, status: "error", error: String(e.message || e) });
    }
  }
  return { status: "ok", matched: blocks.length, results };
}

function shutdown() {
  log("INFO", "SHUTDOWN", {});
  // Close TCP wrapper (HTTP server is closed by tcpServer)
  tcpServer.close();
  // Close UDS server and clean up socket file. The gateway owns its own
  // inode check; the legacy listener needs the manual pass below.
  if (udsGateway) {
    udsGateway.close().catch(() => {});
  }
  if (typeof udsServer !== "undefined" && udsServer) {
    udsServer.close();
  }
  if (!udsGateway) {
    const cleanupPath = udsBoundPath || UDS_PATH;
    try {
      const st = fs.statSync(cleanupPath);
      if (udsBoundIno && st.ino === udsBoundIno) {
        fs.unlinkSync(cleanupPath);
        log("INFO", "UDS_CLEANUP", { path: cleanupPath, ino: st.ino });
      } else {
        log("INFO", "UDS_CLEANUP_SKIP", {
          path: cleanupPath,
          owned: udsBoundIno,
          found: st.ino,
        });
      }
    } catch (_) {
      /* path already gone */
    }
  }
  if (openaiUdsServer && typeof openaiUdsServer.close === "function") {
    openaiUdsServer.close().catch(() => {});
  }
  if (openaiUdsPath && openaiUdsIno) {
    try {
      const st = fs.statSync(openaiUdsPath);
      if (st.ino === openaiUdsIno) {
        fs.unlinkSync(openaiUdsPath);
        log("INFO", "OPENAI_UDS_CLEANUP", { path: openaiUdsPath, ino: st.ino });
      } else {
        log("INFO", "OPENAI_UDS_CLEANUP_SKIP", {
          path: openaiUdsPath,
          owned: openaiUdsIno,
          found: st.ino,
        });
      }
    } catch (_) {
      /* path already gone */
    }
  }
  // Close all SSE connections
  for (const [clientId, { res }] of sseClients) {
    try {
      res.end();
    } catch (_) { }
  }
  sseClients.clear();
  log("INFO", "SSE_CLEANUP", {});
  // Persist any buffered client-info writes before the process dies
  flushClientsSync();
  log("INFO", "CLIENTS_FLUSHED", {});
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// Flush buffered client-info writes on any other exit path too
process.on("exit", () => {
  try { flushClientsSync(); } catch (_) { }
});

// ─── Crash containment ────────────────────────────────────────────────
// Both handlers write a structured record to logs/zc.jsonl FIRST, so a
// restart loop never happens without a reason on disk.
//
// unhandledRejection → log and CONTINUE. A single rejected promise must not
//   take down a gateway that is serving other requests (this is the
//   "troubleshoot and keep running" path).
//
// uncaughtException → log and EXIT(1) (override with ZC_EXIT_ON_CRASH=0).
//   After an uncaught exception the heap is in an unknown state; exiting is
//   what Node itself would do, and it is the self-heal: the supervisor
//   (systemd Restart=always / start.js) starts a clean process. With the
//   env override set the old "soldier on" behaviour is available instead.
process.on("unhandledRejection", (reason) => {
  try {
    zclog.fail("api", "UNHANDLED_REJECTION", {
      error: reason instanceof Error ? reason.message : String(reason),
      continued: true,
    });
  } catch (_) { /* logger must never crash the handler */ }
});
process.on("uncaughtException", (err) => {
  try {
    zclog.fail("api", "UNCAUGHT_EXCEPTION", {
      error: (err && err.message) || String(err),
      code: err && err.code,
      stack: String((err && err.stack) || "").split("\n").slice(0, 6).join(" | "),
      action: (process.env.ZC_EXIT_ON_CRASH || "1") !== "0"
        ? "exit(1) → supervisor restarts a clean process"
        : "continuing (ZC_EXIT_ON_CRASH=0)",
    });
  } catch (_) { }
  if ((process.env.ZC_EXIT_ON_CRASH || "1") !== "0") {
    setTimeout(() => process.exit(1), 200);
  }
});
