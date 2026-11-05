/**
 * discover.js — Modern MCP client auto-registration
 * ═══════════════════════════════════════════════════════════════════════
 * Finds the config file of every mainstream MCP client on this machine and
 * merges an entry for the universal adapter into it.
 *
 * Design rules:
 *   • DRY RUN IS THE DEFAULT. Nothing is written without --write.
 *   • Every file is backed up before it is touched (.bak-<timestamp>).
 *   • A missing config file is reported, never created blind — the user
 *     decides whether that client is even installed.
 *   • Existing user settings are preserved; only our key is inserted.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const SELF = path.join(__dirname, "index.js");

/**
 * Each client stores servers under its own key. `shape` tells us where to
 * put ours inside the JSON document.
 */
const CLIENTS = [
  { id: "claude-desktop", label: "Claude Desktop", file: path.join(HOME, ".config/Claude/claude_desktop_config.json"), key: "mcpServers", shape: "stdio" },
  { id: "cursor", label: "Cursor", file: path.join(HOME, ".cursor/mcp.json"), key: "mcpServers", shape: "stdio" },
  { id: "vscode-user", label: "VS Code (user)", file: path.join(HOME, ".config/Code/User/mcp.json"), key: "servers", shape: "stdio" },
  { id: "opencode", label: "OpenCode", file: path.join(HOME, ".config/opencode/opencode.json"), key: "mcp", shape: "remote" },
  { id: "opencode-alt", label: "OpenCode (~/.opencode)", file: path.join(HOME, ".opencode/opencode.json"), key: "mcp", shape: "remote" },
  { id: "windsurf", label: "Windsurf", file: path.join(HOME, ".codeium/windsurf/mcp_config.json"), key: "mcpServers", shape: "stdio" },
  { id: "zed", label: "Zed", file: path.join(HOME, ".config/zed/settings.json"), key: "context_servers", shape: "stdio" },
  { id: "continue", label: "Continue (IDE)", file: path.join(HOME, ".continue/config.json"), key: "mcpServers", shape: "stdio" },
  { id: "vscode-project", label: "VS Code (this project)", file: path.join(process.cwd(), ".vscode/mcp.json"), key: "servers", shape: "stdio" },
];

function readJSON(file) {
  try {
    return { exists: true, data: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (e) {
    if (e.code === "ENOENT") return { exists: false, data: {} };
    return { exists: true, data: {}, error: e.message };
  }
}

/** Build the adapter entry in whichever dialect this client expects. */
function entryFor(client, url) {
  if (client.shape === "remote") {
    return { type: "remote", url, enabled: true, oauth: false };
  }
  return { command: "node", args: [SELF, "--stdio"], env: {} };
}

function scan(url) {
  const found = [];
  for (const client of CLIENTS) {
    const { exists, data, error } = readJSON(client.file);
    const bucket = data[client.key] || {};
    found.push({
      ...client,
      exists,
      broken: error || null,
      serverCount: Object.keys(bucket).length,
      alreadyRegistered: Boolean(bucket["zombie-universal"]),
    });
  }
  return found;
}

/**
 * @param {string} url   the https MCP url clients should point at
 * @param {boolean} write actually persist (default: report only)
 */
function register(url, write = false) {
  const results = [];
  for (const client of scan(url)) {
    if (!client.exists) {
      results.push({ ...client, action: "skipped — config file not found (client probably not installed)" });
      continue;
    }
    if (client.broken) {
      results.push({ ...client, action: `skipped — JSON is invalid: ${client.broken}` });
      continue;
    }

    const { data } = readJSON(client.file);
    if (!data[client.key] || typeof data[client.key] !== "object") data[client.key] = {};
    if (data[client.key]["zombie-universal"]) {
      results.push({ ...client, action: "unchanged — already registered" });
      continue;
    }

    if (!write) {
      results.push({ ...client, action: "would add entry (dry run — pass --write to apply)" });
      continue;
    }

    // Back up before mutating. Never overwrite someone's config without a copy.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(client.file, `${client.file}.bak-${stamp}`);

    data[client.key]["zombie-universal"] = entryFor(client, url);
    fs.writeFileSync(client.file, JSON.stringify(data, null, 2) + "\n", "utf8");
    results.push({ ...client, action: `registered · backup ${path.basename(`${client.file}.bak-${stamp}`)}` });
  }
  return results;
}

module.exports = { CLIENTS, scan, register, SELF };