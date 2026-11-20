#!/usr/bin/env node
"use strict";

// =============================================================================
// external mcp/skill-mcp.js — local skill library over MCP stdio
// =============================================================================
// Reads `skills/skills.db` (read-only) and exposes two tools:
//   search_skills(query, limit)   find skills by English or Bengali intent
//   get_skill(slug, mode)         compact card or the full Markdown body
//
// No network, no writes, no reference-project dependency. The database path
// is resolved from this repository, so the server works from any editor or
// working directory.
// =============================================================================

const path = require("path");
const { openStore } = require(path.join(__dirname, "..", "modules", "skill-db.js"));
const {
  SLUG_RE,
  DEFAULT_CARD_CHARS,
  MIN_CARD_CHARS,
  MAX_CARD_CHARS,
  MAX_FULL_CHARS,
  compactCard,
  publicMatch,
  fullBody,
} = require(path.join(__dirname, "..", "modules", "skill-parser.js"));

const SERVER_NAME = "zombiecoder-skills";
const VERSION = "1.0.0";

const TOOL_SPECS = [
  {
    name: "search_skills",
    description:
      "Find up to five local skills for a task. Call this before answering when the task may match a skill domain. One short sentence is enough; English or Bengali works.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's task, in one short sentence." },
        limit: { type: "integer", minimum: 1, maximum: 5, default: 3 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_skill",
    description:
      "Load one skill by slug. Start with mode=card; use mode=full only when the card does not contain the needed step.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Exact slug returned by search_skills." },
        mode: { type: "string", enum: ["card", "full"], default: "card" },
        max_chars: {
          type: "integer",
          minimum: MIN_CARD_CHARS,
          maximum: MAX_FULL_CHARS,
          default: DEFAULT_CARD_CHARS,
        },
      },
      required: ["slug"],
    },
  },
];

function textResult(payload, isError) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function callTool(store, name, args) {
  const input = args && typeof args === "object" ? args : {};
  if (name === "search_skills") {
    const query = String(input.query || "").trim();
    if (!query) return textResult("Error: missing_query", true);
    const limit = Math.max(1, Math.min(Number(input.limit) || 3, 5));
    const matches = store.route(query, limit, 3.0).map(publicMatch);
    return textResult({ query, matches });
  }
  if (name === "get_skill") {
    const slug = String(input.slug || "").trim();
    if (!SLUG_RE.test(slug)) return textResult("Error: invalid_slug", true);
    const skill = store.get(slug);
    if (!skill) return textResult("Error: not_found " + slug, true);
    const mode = String(input.mode || "card").toLowerCase();
    if (mode === "card") {
      const maxChars = Math.max(
        MIN_CARD_CHARS,
        Math.min(Number(input.max_chars) || DEFAULT_CARD_CHARS, MAX_CARD_CHARS),
      );
      return textResult({
        slug: skill.slug,
        name: skill.name,
        mode: "card",
        card: compactCard(skill, maxChars),
      });
    }
    if (mode === "full") {
      return textResult(fullBody(skill, Number(input.max_chars) || undefined));
    }
    return textResult("Error: invalid_mode (card or full)", true);
  }
  return textResult('Error: unknown tool "' + name + '"; allowed: search_skills, get_skill', true);
}

function handle(request, store) {
  const id = request.id;
  const method = request.method;
  const params = request.params && typeof request.params === "object" ? request.params : {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: String(params.protocolVersion || "2024-11-05"),
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOL_SPECS } };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/call") {
    const name = String(params.name || "");
    return { jsonrpc: "2.0", id, result: callTool(store, name, params.arguments) };
  }
  return errorResponse(id, -32601, "Method not found: " + method);
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function main() {
  let store;
  try {
    store = openStore();
  } catch (err) {
    console.error("[skill-mcp] " + err.message);
    process.exit(1);
  }
  console.error(
    "[" + SERVER_NAME + "] stdio, read-only, " + store.path + " (" + store.stats().active + " active skills)",
  );

  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        let request;
        try {
          request = JSON.parse(line);
        } catch (_) {
          write(errorResponse(null, -32700, "Parse error"));
          index = buffer.indexOf("\n");
          continue;
        }
        if (request && typeof request === "object" && request.id !== undefined) {
          try {
            write(handle(request, store));
          } catch (err) {
            write(errorResponse(request.id, -32603, "Internal error: " + err.message));
          }
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    store.close();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    store.close();
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { TOOL_SPECS, callTool, handle };
