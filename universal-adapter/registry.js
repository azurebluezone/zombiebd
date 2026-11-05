/**
 * registry.js — Universal MCP Tool Registry
 * ═══════════════════════════════════════════════════════════════════════
 * ONE registry. THREE transports (HTTP / HTTPS / stdio). Every transport
 * serves the exact same tools with the exact same JSON-RPC shapes.
 *
 * Zero dependencies — pure Node.js.
 *
 * Why a registry instead of per-transport handlers:
 *   • a tool added here appears on HTTP, HTTPS and stdio simultaneously
 *   • call/error counters stay consistent across transports
 *   • the enable/disable switch has exactly one choke point
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");
const mainSync = require("./main-sync");
const personas = require("./personas");
const zclog = require("../lib/zc-log");

// ─── State ───────────────────────────────────────────────────────────────────

/** tool name -> handler */
const HANDLERS = Object.create(null);
/** tool name -> { enabled, calls, errors } */
const STATS = Object.create(null);

function define(spec) {
  const name = spec.name;
  if (HANDLERS[name]) throw new Error(`duplicate tool: ${name}`);
  HANDLERS[name] = spec; // keep the whole spec: description + schema + handler
  STATS[name] = { enabled: spec.enabled !== false, calls: 0, errors: 0 };
}

// ─── JSON-RPC error helpers (spec-compliant codes) ───────────────────────────

const RPC = {
  // JSON-RPC 2.0 reserved
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // MCP-specific
  METHOD_NOT_FOUND_MCP: -32601,
};

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ─── Helper: sandboxed path resolution ───────────────────────────────────────
// The adapter exposes a limited root so a connected client cannot read the
// whole filesystem by accident.
//
// Defaults to THIS directory, not process.cwd(): start.js spawns the adapter
// with the project root as cwd, which would silently widen the sandbox from
// universal-adapter/ to the whole project tree.

const ROOTS = (process.env.ADAPTER_ROOTS || __dirname)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p));

function resolveInside(argPath) {
  const raw = typeof argPath === "string" ? argPath : "";
  if (!raw) throw new RpcError(RPC.INVALID_PARAMS, "path is required");
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ROOTS[0], raw);
  const ok = ROOTS.some((root) => abs === root || abs.startsWith(root + path.sep));
  if (!ok) {
    throw new RpcError(
      RPC.INVALID_PARAMS,
      `path outside allowed roots: ${abs}`,
      { allowedRoots: ROOTS },
    );
  }
  return abs;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

define({
  name: "adapter_status",
  description:
    "Universal adapter status: which transports are live, tool counts, uptime.",
  handler() {
    return {
      name: "universal-adapter",
      pid: process.pid,
      node: process.version,
      uptime_sec: Math.round(process.uptime()),
      transports: global.__UA_TRANSPORTS__ || [],
      tools_local: Object.keys(HANDLERS).length,
      tools_remote: mainSync.list().filter((t) => !HANDLERS[t.name]).length,
      tools_total:
        Object.keys(STATS).filter((t) => STATS[t].enabled).length +
        mainSync.list().filter((t) => !HANDLERS[t.name]).length,
      tools_enabled:
        Object.keys(STATS).filter((t) => STATS[t].enabled).length +
        mainSync.list().filter((t) => !HANDLERS[t.name]).length,
      main_server: mainSync.status(),
      roots: ROOTS,
    };
  },
});

define({
  name: "system_info",
  description: "Cross-platform system info: OS, arch, Node version, hostname, memory.",
  handler() {
    return {
      platform: os.platform(),
      arch: os.arch(),
      os: os.type(),
      release: os.release(),
      hostname: os.hostname(),
      node: process.version,
      pid: process.pid,
      cwd: process.cwd(),
      uptime_sec: Math.round(os.uptime()),
      cpu_cores: os.cpus().length,
      memory_mb: Math.round(os.totalmem() / 1048576),
      loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
    };
  },
});

define({
  name: "list_directory",
  description: "List files and folders in a directory. Args: { path?, recursive?, limit? }",
  schema: {
    path: { type: "string", description: "Directory path (relative to an allowed root, or absolute). Defaults to the first root." },
    recursive: { type: "boolean", description: "Descend into subdirectories (skips dot-directories)." },
    limit: { type: "number", description: "Stop after this many entries. Default 500." },
  },
  handler({ path: dirPath = ".", recursive = false, limit = 500 } = {}) {
    const abs = resolveInside(dirPath);
    const entries = [];
    const walk = (dir, depth) => {
      if (entries.length >= limit) return;
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entries.length >= limit) return;
        const full = path.join(dir, item.name);
        entries.push({
          name: item.name,
          path: path.relative(ROOTS[0], full),
          type: item.isDirectory() ? "dir" : "file",
          size: item.isFile() ? fs.statSync(full).size : 0,
        });
        if (recursive && item.isDirectory() && !item.name.startsWith(".")) {
          walk(full, depth + 1);
        }
      }
    };
    walk(abs, 0);
    return { directory: path.relative(ROOTS[0], abs) || ".", count: entries.length, entries };
  },
});

define({
  name: "read_file",
  description: "Read a UTF-8 text file. Args: { path, maxBytes? }",
  schema: {
    path: { type: "string", description: "File path (relative to an allowed root, or absolute)." },
    maxBytes: { type: "number", description: "Reject files larger than this. Default 512000." },
  },
  required: ["path"],
  handler({ path: filePath, maxBytes = 512000 } = {}) {
    const abs = resolveInside(filePath);
    const stat = fs.statSync(abs);
    if (stat.size > maxBytes) {
      throw new RpcError(RPC.INVALID_PARAMS, `file too large: ${stat.size} bytes (max ${maxBytes})`);
    }
    return { path: path.relative(ROOTS[0], abs), size: stat.size, content: fs.readFileSync(abs, "utf8") };
  },
});

define({
  name: "write_file",
  description: "Write a UTF-8 text file (creates parent folders). Args: { path, content }",
  schema: {
    path: { type: "string", description: "File path (relative to an allowed root, or absolute)." },
    content: { type: "string", description: "Full file content to write." },
  },
  required: ["path", "content"],
  handler({ path: filePath, content } = {}) {
    const abs = resolveInside(filePath);
    if (typeof content !== "string") throw new RpcError(RPC.INVALID_PARAMS, "content must be a string");
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return { path: path.relative(ROOTS[0], abs), bytes: Buffer.byteLength(content), written: true };
  },
});

define({
  name: "delete_file",
  description: "Delete a file. Args: { path }",
  schema: {
    path: { type: "string", description: "File path (relative to an allowed root, or absolute)." },
  },
  required: ["path"],
  handler({ path: filePath } = {}) {
    const abs = resolveInside(filePath);
    fs.unlinkSync(abs);
    return { path: path.relative(ROOTS[0], abs), deleted: true };
  },
});

define({
  name: "glob",
  description: "Find files by a simple glob pattern. Args: { pattern, limit? }",
  schema: {
    pattern: { type: "string", description: "Glob pattern, e.g. 'app/**/*.php'. * and ? are supported; everything else is literal." },
    limit: { type: "number", description: "Stop after this many matches. Default 300." },
  },
  required: ["pattern"],
  handler({ pattern = "*", limit = 300 } = {}) {
    const rx = new RegExp(
      "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    const hits = [];
    const walk = (dir, depth) => {
      if (hits.length >= limit || depth > 8) return;
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (hits.length >= limit) return;
        if (item.name.startsWith(".") || item.name === "node_modules" || item.name === ".git") continue;
        const full = path.join(dir, item.name);
        const rel = path.relative(ROOTS[0], full);
        if (rx.test(item.name) || rx.test(rel)) {
          hits.push({ path: rel, type: item.isDirectory() ? "dir" : "file" });
        }
        if (item.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(ROOTS[0], 0);
    return { pattern, count: hits.length, matches: hits };
  },
});

define({
  name: "grep",
  description: "Search file contents with a regular expression. Args: { pattern, glob?, maxMatches? }",
  schema: {
    pattern: { type: "string", description: "Regular expression to search for (case-insensitive)." },
    glob: { type: "string", description: "Only search files whose name matches this glob. Default '*'." },
    maxMatches: { type: "number", description: "Stop after this many matches. Default 200." },
  },
  required: ["pattern"],
  handler({ pattern, glob = "*", maxMatches = 200 } = {}) {
    if (!pattern) throw new RpcError(RPC.INVALID_PARAMS, "pattern is required");
    const rx = new RegExp(pattern, "i");
    const nameRx = new RegExp(
      "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    );
    const matches = [];
    const walk = (dir, depth) => {
      if (matches.length >= maxMatches || depth > 8) return;
      let items;
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        if (matches.length >= maxMatches) return;
        if (["node_modules", ".git", "data", "logs", "cache"].includes(item.name)) continue;
        if (item.name.startsWith(".")) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!nameRx.test(item.name)) continue;
        let text;
        try {
          if (fs.statSync(full).size > 1048576) continue;
          text = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) break;
          if (rx.test(lines[i])) {
            matches.push({ path: path.relative(ROOTS[0], full), line: i + 1, text: lines[i].trim().slice(0, 300) });
          }
        }
      }
    };
    walk(ROOTS[0], 0);
    return { pattern, count: matches.length, matches };
  },
});

define({
  name: "hash_text",
  description: "Hash a string (sha256). Args: { text, algorithm? }",
  schema: {
    text: { type: "string", description: "The text to hash." },
    algorithm: { type: "string", description: "Any algorithm Node's crypto supports. Default 'sha256'." },
  },
  required: ["text"],
  handler({ text, algorithm = "sha256" } = {}) {
    if (typeof text !== "string") throw new RpcError(RPC.INVALID_PARAMS, "text must be a string");
    return { algorithm, digest: crypto.createHash(algorithm).update(text).digest("hex") };
  },
});

define({
  name: "agent_personas",
  description:
    "Mission Barisal agent personas & constitution: identity, shared rules, " +
    "operating principles, and the 6-agent roster (Manu/Jarin/Brishti/Rashed/Halim/Majnu). " +
    "Args: { id?, section? } — id = one agent (e.g. 'bug-hunter' or 'Jarin'); " +
    "section = 'identity' | 'shared' | 'principles' | 'agents'.",
  schema: {
    id: { type: "string", description: "Agent id or name (case-insensitive)." },
    section: {
      type: "string",
      enum: ["identity", "shared", "principles", "agents"],
      description: "Return only this section of the constitution.",
    },
  },
  handler({ id, section } = {}) {
    if (id) {
      const agent = personas.get(id);
      if (!agent) {
        const known = personas.list().map((a) => `${a.id} (${a.name})`).join(", ");
        throw new RpcError(RPC.INVALID_PARAMS, `unknown agent: ${id} — known: ${known}`);
      }
      return { agent };
    }
    const all = personas.constitution();
    if (section) {
      if (!(section in all)) {
        throw new RpcError(
          RPC.INVALID_PARAMS,
          `unknown section: ${section} — known: ${Object.keys(all).join(", ")}`
        );
      }
      return { [section]: all[section] };
    }
    return all;
  },
});

// ─── JSON-RPC dispatch — the single choke point every transport shares ───────

function handleRpc(msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const fail = (code, message, data) => ({
    jsonrpc: "2.0",
    id: msg.id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });

  // Batch support: MCP allows an array of requests.
  if (Array.isArray(msg)) {
    const out = msg.map(handleRpc).filter((r) => r !== null);
    return out.length ? out : null;
  }
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(RPC.INVALID_REQUEST, "not a valid JSON-RPC 2.0 request");
  }
  const p = msg.params || {};

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: p.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: true }, logging: {} },
        serverInfo: { name: "zombie-universal-adapter", version: "1.0.0" },
        instructions:
          "Universal MCP adapter — HTTP, HTTPS and stdio from one process. " +
          `Allowed filesystem roots: ${ROOTS.join(", ")}`,
      });

    case "notifications/initialized":
    case "initialized":
      return null; // notification, no reply

    case "ping":
      return reply({});

    case "tools/list": {
      // Local descriptors are built eagerly; remote ones only after the cache
      // is warm, so the very first request still sees the main server's tools.
      const descriptor = (name) => ({
        name,
        description: HANDLERS[name].description || "",
        inputSchema: {
          type: "object",
          properties: HANDLERS[name].schema || {},
          required: HANDLERS[name].required || [],
          additionalProperties: false,
        },
      });
      const local = Object.keys(STATS)
        .filter((name) => STATS[name].enabled)
        .map(descriptor);

      return mainSync.ensureSynced().then(() => {
        // Collision policy: the local sandboxed implementation wins. The main
        // server's read_file/write_file/grep/... are unrestricted, and the
        // HTTPS transport binds 0.0.0.0, so those must never shadow ours.
        const remote = mainSync
          .list()
          .filter((t) => t && t.name && !HANDLERS[t.name])
          .map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema || { type: "object", properties: {} },
          }));
        return reply({ tools: local.concat(remote) });
      });
    }

    case "tools/call": {
      const name = p.name;
      if (!name) return fail(RPC.METHOD_NOT_FOUND, "tool name is required");

      if (HANDLERS[name]) {
        if (!STATS[name].enabled) {
          return fail(RPC.METHOD_NOT_FOUND, `tool disabled: ${name}`);
        }
        STATS[name].calls++;
        const t0 = Date.now();
        try {
          const value = HANDLERS[name].handler(p.arguments || {});
          zclog.info("registry", "TOOL_CALL_OK", {
            tool: name,
            source: "local",
            ms: Date.now() - t0,
          });
          return reply({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
        } catch (err) {
          STATS[name].errors++;
          zclog.fail("registry", "TOOL_CALL_FAIL", {
            tool: name,
            source: "local",
            ms: Date.now() - t0,
            error: err.message || String(err),
          });
          if (err instanceof RpcError) return fail(err.code, err.message, err.data);
          return fail(RPC.INTERNAL_ERROR, err.message || String(err));
        }
      }

      // Not ours → forward it upstream, then answer with the upstream reply.
      return mainSync.ensureSynced().then(() => {
        if (!mainSync.has(name)) {
          zclog.warn("registry", "TOOL_CALL_UNKNOWN", { tool: name });
          return fail(RPC.METHOD_NOT_FOUND, `unknown tool: ${name}`);
        }
        const t0 = Date.now();
        return mainSync.call(name, p.arguments || {}).then(
          (result) => {
            zclog.info("registry", "TOOL_CALL_OK", {
              tool: name,
              source: "upstream",
              ms: Date.now() - t0,
            });
            return reply(result || {});
          },
          (err) => {
            zclog.fail("registry", "TOOL_CALL_FAIL", {
              tool: name,
              source: "upstream",
              ms: Date.now() - t0,
              error: err.message || String(err),
            });
            return fail(RPC.INTERNAL_ERROR, `main server: ${err.message || String(err)}`);
          },
        );
      });
    }

    case "tools/enable":
    case "tools/disable": {
      const name = p.name;
      const enabled = msg.method === "tools/enable";
      if (STATS[name]) {
        STATS[name].enabled = enabled;
        return reply({ tool: name, enabled });
      }
      if (mainSync.knows(name)) {
        mainSync.setEnabled(name, enabled);
        return reply({ tool: name, enabled });
      }
      return fail(RPC.METHOD_NOT_FOUND, `unknown tool: ${name}`);
    }

    case "admin/stats":
      return reply({
        tools: Object.assign({}, STATS, mainSync.stats()),
        uptime_sec: Math.round(process.uptime()),
        transports: global.__UA_TRANSPORTS__ || [],
        main_server: mainSync.status(),
      });

    default:
      return fail(RPC.METHOD_NOT_FOUND, `method not found: ${msg.method}`);
  }
}

module.exports = {
  APIS: ["http", "https", "stdio"],
  ROOT: ROOTS[0],
  ROOTS,
  STATS,
  handleRpc,
  resolveInside,
  define,
  mainSync,
  listTools: () => Object.keys(STATS),
};