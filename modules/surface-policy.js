"use strict";

/**
 * modules/surface-policy.js — one table for the three product surfaces.
 *
 * The table is the single source of truth for what each surface may do.
 * Runtime code imports it:
 *   - modules/chat-interpreter.js uses WEB_CHAT_TOOLS;
 *   - api.js builds PRIVILEGED_MCP_TOOLS from PRIVILEGED_TOOLS.
 *
 * Trust boundaries (verified by tests/surface-policy-check.js):
 *   - web-chat: browser chat window; allowlist only; no filesystem or shell.
 *   - mission: /api/mission + agent_mission; full catalog; tool calls run
 *     in-process, so the transport admin gate does not apply. Recorded as
 *     `in-process`, never as `admin-token`.
 *   - editor: /mcp, /v1 and UDS; full catalog; privileged tools require
 *     MCP_ADMIN_TOKEN/ADMIN_API_KEY at the transport gate.
 *
 * No surface is an admin surface.
 */

const PRIVILEGED_TOOLS = Object.freeze([
  "terminal",
  "exec",
  "env_get",
  "db_query",
  "db_list_tables",
  "write_file",
  "delete_file",
  "rename_file",
  "set_working_dir",
  "http_request",
  "browse_cdp",
  "open_browser",
]);

const WEB_CHAT_TOOLS = Object.freeze(["web_search", "get_time", "calculate"]);

const SURFACES = Object.freeze({
  "web-chat": Object.freeze({
    id: "web-chat",
    entry: "POST /v1/chat/completions (channel=web-chat), WS chat",
    tools: "allowlist",
    allowlist: WEB_CHAT_TOOLS,
    privileged: "deny",
    fileWrite: "deny",
    shell: "deny",
    web: "allow",
    auth: "none",
    admin: false,
  }),
  mission: Object.freeze({
    id: "mission",
    entry: "POST /api/mission, agent_mission, agent_single",
    tools: "catalog",
    allowlist: null,
    privileged: "in-process",
    fileWrite: "in-process",
    shell: "in-process",
    web: "allow",
    auth: "optional user session",
    admin: false,
  }),
  editor: Object.freeze({
    id: "editor",
    entry: "POST /mcp, /v1/chat/completions, UDS",
    tools: "catalog",
    allowlist: null,
    privileged: "admin-token",
    fileWrite: "admin-token",
    shell: "admin-token",
    web: "allow",
    auth: "admin token for privileged tools",
    admin: false,
  }),
});

const SURFACE_IDS = Object.freeze(Object.keys(SURFACES));

const TABLE_COLUMNS = Object.freeze([
  "Surface",
  "Entry",
  "Tools",
  "Privileged",
  "File write",
  "Shell",
  "Web",
  "Auth",
]);

const REQUIRED_FIELDS = Object.freeze([
  "id",
  "entry",
  "tools",
  "privileged",
  "fileWrite",
  "shell",
  "web",
  "auth",
  "admin",
]);

function policyFor(id) {
  return SURFACES[String(id || "")] || null;
}

function isPrivilegedTool(name) {
  return PRIVILEGED_TOOLS.includes(String(name || ""));
}

function toolNames(catalog) {
  if (Array.isArray(catalog)) {
    return catalog
      .map((item) => (typeof item === "string" ? item : item && (item.name || item.id)))
      .filter(Boolean);
  }
  return Object.keys(catalog || {});
}

/**
 * Return the tool names a surface may use from a catalog.
 * `allowlist` surfaces keep only the listed names; `catalog` surfaces keep all.
 */
function toolsFor(id, catalog) {
  const policy = policyFor(id);
  if (!policy) return [];
  const names = toolNames(catalog);
  if (policy.tools === "allowlist") {
    return names.filter((name) => policy.allowlist.includes(name));
  }
  return names.slice();
}

function tableRows() {
  return SURFACE_IDS.map((id) => {
    const policy = SURFACES[id];
    return {
      Surface: id,
      Entry: policy.entry,
      Tools: policy.tools === "allowlist" ? policy.allowlist.join(", ") : "full catalog",
      Privileged: policy.privileged,
      "File write": policy.fileWrite,
      Shell: policy.shell,
      Web: policy.web,
      Auth: policy.auth,
    };
  });
}

function toMarkdown() {
  const header = "| " + TABLE_COLUMNS.join(" | ") + " |";
  const divider = "|" + TABLE_COLUMNS.map(() => "---").join("|") + "|";
  const rows = tableRows().map(
    (row) => "| " + TABLE_COLUMNS.map((column) => row[column]).join(" | ") + " |",
  );
  return [header, divider, ...rows].join("\n");
}

module.exports = {
  SURFACES,
  SURFACE_IDS,
  TABLE_COLUMNS,
  REQUIRED_FIELDS,
  PRIVILEGED_TOOLS,
  WEB_CHAT_TOOLS,
  policyFor,
  isPrivilegedTool,
  toolsFor,
  tableRows,
  toMarkdown,
};
