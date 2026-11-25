#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: surface policy (runbook row 13)
// =============================================================================
// One table must describe what each product surface may do, and runtime code
// must import that table instead of keeping private copies:
//   - web-chat: allowlist only (no privileged/file/shell tools)
//   - mission:  full catalog, tool calls run in-process
//   - editor:   full catalog, privileged tools need an admin token at /mcp
// The docs table must be generated from the same module, so it cannot drift.
//
// Run: node tests/surface-policy-check.js
// Exit 0 + SURFACE_POLICY_OK only when every check passes.
// =============================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const rows = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, fn) {
  try {
    const detail = fn();
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } catch (err) {
    fail += 1;
    rows.push(["FAIL", name, String((err && err.message) || err)]);
  }
}

function sameArray(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

let policy = null;
check("module loads", () => {
  policy = require(path.join(ROOT, "modules/surface-policy.js"));
  assert(policy && typeof policy === "object", "modules/surface-policy.js exports nothing");
  return "modules/surface-policy.js";
});

check("exactly three surfaces", () => {
  assert(sameArray(policy.SURFACE_IDS, ["web-chat", "mission", "editor"]), "SURFACE_IDS must be web-chat, mission, editor");
  assert(Object.keys(policy.SURFACES).length === 3, "SURFACES must have exactly 3 entries");
  return policy.SURFACE_IDS.join(", ");
});

check("every surface is complete and non-admin", () => {
  for (const id of policy.SURFACE_IDS) {
    const surface = policy.SURFACES[id];
    for (const field of policy.REQUIRED_FIELDS) {
      assert(surface[field] !== undefined, `${id} is missing ${field}`);
    }
    assert(surface.admin === false, `${id} must not be an admin surface`);
    assert(surface.id === id, `${id}.id mismatch`);
  }
  return "required fields + admin=false";
});

check("web-chat allowlist is non-privileged", () => {
  const expected = ["web_search", "get_time", "calculate"];
  assert(sameArray(policy.WEB_CHAT_TOOLS, expected), "WEB_CHAT_TOOLS drifted");
  for (const tool of policy.WEB_CHAT_TOOLS) {
    assert(!policy.isPrivilegedTool(tool), `${tool} is privileged but in the chat allowlist`);
  }
  const chat = policy.policyFor("web-chat");
  assert(chat.tools === "allowlist", "web-chat must use an allowlist");
  assert(chat.privileged === "deny", "web-chat must deny privileged tools");
  assert(chat.fileWrite === "deny" && chat.shell === "deny", "web-chat must deny file write and shell");
  return expected.join(", ");
});

check("toolsFor enforces the allowlist", () => {
  const catalog = [...policy.PRIVILEGED_TOOLS, ...policy.WEB_CHAT_TOOLS, "unknown_tool"];
  const chat = policy.toolsFor("web-chat", catalog);
  assert(sameArray(chat, policy.WEB_CHAT_TOOLS), "web-chat toolsFor leaked a non-allowlisted tool");
  const mission = policy.toolsFor("mission", catalog);
  assert(mission.length === catalog.length, "mission toolsFor must keep the full catalog");
  return "chat filtered, mission full";
});

check("mission privileged tools need an admin token", () => {
  const mission = policy.policyFor("mission");
  assert(mission.tools === "catalog", "mission must see the full catalog");
  assert(mission.privileged === "admin-token", "mission privileged tools must require the admin token");
  assert(mission.admin === false, "mission is not an admin surface");
  return "catalog + admin-token";
});

check("editor privileged tools need an admin token", () => {
  const editor = policy.policyFor("editor");
  assert(editor.tools === "catalog", "editor must see the full catalog");
  assert(editor.privileged === "admin-token", "editor privileged tools must require the admin token");
  assert(editor.admin === false, "editor is not an admin surface");
  return "catalog + admin-token";
});

check("chat-interpreter imports the policy allowlist", () => {
  const chat = require(path.join(ROOT, "modules/chat-interpreter.js"));
  assert(sameArray(chat.CHAT_TOOL_ALLOWLIST, policy.WEB_CHAT_TOOLS), "chat-interpreter keep its own allowlist");
  const selected = chat.selectChatTools([
    { name: "terminal" },
    { function: { name: "web_search" } },
    { name: "exec" },
    { name: "get_time" },
  ]);
  assert(selected.length === 2, "selectChatTools must keep only allowlisted tools");
  assert(selected.every((tool) => policy.WEB_CHAT_TOOLS.includes(tool.name || (tool.function && tool.function.name))), "selectChatTools leaked a privileged tool");
  return "selectChatTools uses WEB_CHAT_TOOLS";
});

check("api.js builds the privileged set from the policy", () => {
  const api = read("api.js");
  assert(api.includes('require("./modules/surface-policy.js")'), "api.js must require modules/surface-policy.js");
  assert(api.includes("const PRIVILEGED_MCP_TOOLS = new Set(surfacePolicy.PRIVILEGED_TOOLS);"), "api.js must build PRIVILEGED_MCP_TOOLS from the policy");
  assert(api.includes("return surfacePolicy.isPrivilegedTool(name);"), "isPrivilegedMcpTool must delegate to the policy");
  assert(api.includes("if (isPrivilegedMcpTool(toolName))"), "mcpGate must use isPrivilegedMcpTool");
  assert(policy.isPrivilegedTool("terminal") && policy.isPrivilegedTool("write_file"), "policy lost a privileged tool");
  assert(!policy.isPrivilegedTool("web_search"), "policy marked a chat tool privileged");
  return "PRIVILEGED_MCP_TOOLS + mcpGate wired";
});

check("docs table matches the module table", () => {
  const doc = read("docs/SURFACE-POLICY.md");
  const start = "<!-- SURFACE_POLICY_TABLE_START -->";
  const end = "<!-- SURFACE_POLICY_TABLE_END -->";
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  assert(from !== -1 && to > from, "docs/SURFACE-POLICY.md is missing the table markers");
  const block = doc.slice(from + start.length, to).trim();
  const expected = policy.toMarkdown().trim();
  assert(block === expected, "docs table drifted from modules/surface-policy.js");
  return "docs/SURFACE-POLICY.md";
});

for (const [status, name, detail] of rows) {
  console.log(`${status}  ${name}${detail ? " — " + detail : ""}`);
}
console.log(`\n${pass} passed, ${fail} failed`);

if (fail > 0) {
  console.error("\nSURFACE_POLICY_FAIL");
  process.exit(1);
}
console.log("\nSURFACE_POLICY_OK");
