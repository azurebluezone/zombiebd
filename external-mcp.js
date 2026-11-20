// =============================================================================
// Mission Barisal v3 — External MCP Loader
// Loads external MCP servers from TWO sources:
//   1) local files in  ./external mcp/servers.json   (folder config)
//   2) direct URLs from EXTERNAL_MCP_URLS env         (comma-separated)
// Local entries use stdio child processes; remote entries use MCPClientManager
// (mcp-client.js) over HTTP. No local server needs a TCP port.
// =============================================================================

const path = require("path");
const fs = require("fs");
const { MCPClientManager } = require("./mcp-client.js");
const { createStdioClient } = require("./mcp-stdio-client.js");
const { expandEnv } = require("./lib/expand-env.js");

const FOLDER_DIR = path.resolve(__dirname, "external mcp");
// EXTERNAL_MCP_CONFIG lets a test or an isolated deployment point at its own
// server list without touching the project's live servers.json.
const CONFIG_FILE = process.env.EXTERNAL_MCP_CONFIG
  ? path.resolve(process.env.EXTERNAL_MCP_CONFIG)
  : path.join(FOLDER_DIR, "servers.json");

let manager = null;
let exitHookInstalled = false;
let httpNames = new Set();

/** name -> { name, script, args, client, tools, status, lastSeen, error } */
const stdioServers = new Map();

function killAllStdio() {
  for (const entry of stdioServers.values()) {
    try {
      entry.client.kill("SIGKILL");
    } catch (_) {
      /* already gone */
    }
  }
}

function ensureExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", killAllStdio);
  // A signal does not fire the 'exit' event; handle both so a systemd stop
  // never leaves stdio children behind.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      killAllStdio();
      process.exit(0);
    });
  }
}

/** Resolve a servers.json script path against the project root, then the folder. */
function resolveScript(script) {
  const value = String(script || "").trim();
  if (!value) return "";
  if (path.isAbsolute(value)) return value;
  const fromRoot = path.resolve(__dirname, value);
  if (fs.existsSync(fromRoot)) return fromRoot;
  return path.resolve(FOLDER_DIR, value);
}

// ─── Load server definitions from the folder's servers.json ──
function loadFromFolder() {
  const servers = [];
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.warn("[EXTERNAL_MCP] no config at " + CONFIG_FILE);
      return servers;
    }
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const list = data.servers || [];
    for (const s of list) {
      if (!s || s.enabled === false) continue;
      const transport = String(s.transport || (s.script && !s.url ? "stdio" : "http")).toLowerCase();
      if (transport === "stdio") {
        const script = resolveScript(s.script);
        if (!script) continue;
        servers.push({
          name: (s.name || "").trim() || path.basename(script, ".js"),
          transport: "stdio",
          script,
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: s.env && typeof s.env === "object" ? s.env : {},
          autoConnect: s.autoConnect !== false,
          source: "folder",
        });
        continue;
      }
      if (!s.url) continue;
      servers.push({
        name: (s.name || "").trim() || hostFromUrl(s.url),
        url: expandEnv(s.url).trim(),
        transport,
        token: s.token || "",
        autoConnect: s.autoConnect !== false,
        source: "folder",
      });
    }
    console.log("[EXTERNAL_MCP] folder config: " + servers.length + " server(s)");
  } catch (e) {
    console.warn("[EXTERNAL_MCP] folder config parse failed: " + e.message);
  }
  return servers;
}

// ─── Load server definitions from EXTERNAL_MCP_URLS env ──────
function loadFromUrls() {
  const servers = [];
  const raw = (process.env.EXTERNAL_MCP_URLS || "").trim();
  if (!raw) return servers;
  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  for (const url of urls) {
    servers.push({
      name: hostFromUrl(url),
      url,
      transport: "http",
      token: "",
      autoConnect: true,
      source: "url",
    });
  }
  console.log("[EXTERNAL_MCP] env URLs: " + servers.length + " server(s)");
  return servers;
}

function hostFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.replace(/[^a-z0-9]/gi, "-");
  } catch (e) {
    return "external-" + Math.random().toString(36).slice(2, 8);
  }
}

// ─── Spawn or reuse a stdio child ───────────────────────────
async function connectStdio(def) {
  const existing = stdioServers.get(def.name);
  if (existing && existing.client.running && existing.status === "connected") {
    return { success: true, tools: existing.tools.length, server: def.name, transport: "stdio" };
  }
  if (existing) {
    try {
      existing.client.kill();
    } catch (_) {
      /* already gone */
    }
    stdioServers.delete(def.name);
  }

  ensureExitHook();
  const client = createStdioClient({
    name: def.name,
    args: [def.script, ...(def.args || [])],
    cwd: __dirname,
    env: def.env,
    debug: process.env.MCP_STDIO_DEBUG === "1",
    timeoutMs: Number(process.env.MCP_STDIO_TIMEOUT_MS || 30000),
  });
  const tools = await client.tools();
  stdioServers.set(def.name, {
    name: def.name,
    script: def.script,
    args: def.args,
    client,
    tools,
    status: "connected",
    lastSeen: Date.now(),
    error: null,
  });
  return { success: true, tools: tools.length, server: def.name, transport: "stdio" };
}

// ─── Connect all servers ────────────────────────────────────
async function loadAll() {
  if (!manager) manager = new MCPClientManager(console.log);
  const defs = [...loadFromFolder(), ...loadFromUrls()];
  httpNames = new Set(defs.filter((d) => d.transport !== "stdio").map((d) => d.name));
  const results = [];
  for (const def of defs) {
    if (def.transport === "stdio") {
      if (def.autoConnect === false) {
        results.push({ name: def.name, status: "registered", transport: "stdio", source: def.source });
        continue;
      }
      try {
        const res = await connectStdio(def);
        results.push({ name: def.name, ...res, source: def.source });
      } catch (e) {
        stdioServers.set(def.name, {
          name: def.name,
          script: def.script,
          args: def.args,
          client: null,
          tools: [],
          status: "error",
          lastSeen: null,
          error: e.message,
        });
        results.push({ name: def.name, error: e.message, transport: "stdio", source: def.source });
      }
      continue;
    }

    try {
      const res = await manager.connectServer(def.name, def.url, {
        transport: def.transport,
        token: def.token,
        autoConnect: def.autoConnect,
      });
      results.push({ name: def.name, ...res, source: def.source });
    } catch (e) {
      results.push({ name: def.name, error: e.message, source: def.source });
    }
  }
  return results;
}

// ─── Tools from all connected external servers ───────────────
function getAllTools() {
  const all = manager ? manager.getAllExternalTools() : [];
  for (const [name, entry] of stdioServers) {
    if (entry.status !== "connected" || !entry.tools.length) continue;
    for (const tool of entry.tools) {
      all.push({
        ...tool,
        fullName: name + "__" + tool.name,
        serverName: name,
      });
    }
  }
  return all;
}

// ─── Call an external tool: <server>__<tool> ─────────────────
async function call(name, tool, args) {
  const local = stdioServers.get(name);
  if (local) {
    if (local.status !== "connected" || !local.client || !local.client.running) {
      return {
        content: [
          {
            type: "text",
            text: "MCP stdio server '" + name + "' is not running: " + (local.error || "unknown"),
          },
        ],
      };
    }
    return local.client.call("tools/call", { name: tool, arguments: args || {} });
  }
  return manager ? manager.callExternalTool(name, tool, args || {}) : null;
}

// ─── Parse a full tool name like  server__tool  ──────────────
function parseToolName(fullName) {
  const idx = fullName.indexOf("__");
  if (idx === -1) return null;
  return { server: fullName.slice(0, idx), tool: fullName.slice(idx + 2) };
}

// ─── Server status list (for /api/mcp-external) ──────────────
function getStatus() {
  const rows = manager
    ? manager
        .listServers()
        .filter((s) => httpNames.has(s.name))
        .map((s) => ({
          name: s.name,
          url: s.url,
          transport: s.transport || "http",
          status: s.status,
          tools: (s.tools || []).length,
          lastSeen: s.lastSeen,
          error: s.error || null,
        }))
    : [];
  for (const entry of stdioServers.values()) {
    rows.push({
      name: entry.name,
      url: "stdio:" + entry.script,
      transport: "stdio",
      status: entry.status,
      tools: entry.tools.length,
      lastSeen: entry.lastSeen,
      error: entry.error || null,
    });
  }
  return rows;
}

function getManager() {
  return manager;
}

module.exports = {
  loadAll,
  getAllTools,
  call,
  parseToolName,
  getStatus,
  getManager,
  CONFIG_FILE,
};
