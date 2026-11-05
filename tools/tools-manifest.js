/**
 * tools-manifest.js — single source of truth for what the server exposes
 * ═══════════════════════════════════════════════════════════════════════
 * WHY
 *   The docs claim 36 tools. The live registry reported 131. Both numbers
 *   were "true" but they meant different things, and nothing in the code
 *   distinguished them — so nobody could tell whether the docs were stale or
 *   the server had grown:
 *
 *     26  core      built into api.js (files, shell, agents, db, web)
 *     10  external  the MCP servers the project itself ships
 *                   (ocr, screen-recorder, tts)          ── together: 36 ✅ docs
 *     95  pluggable third-party MCP servers the operator adds
 *                   (public-api, facebook-ads, combined)  ── optional
 *
 *   `CORE_TOOL_COUNT` (36) is what the documentation talks about.
 *   `EXTERNAL_MCP_SOURCES` are extras: they appear in tools/list when their
 *   server is reachable and silently disappear when it is not. A missing
 *   pluggable server must never look like a broken core.
 *
 * Consumers:
 *     tests/docs-claims.test.js  — verifies the 36 claim against CORE only
 *     /api/tools/manifest        — reports the split to the admin panel
 */
"use strict";

/** Tools built into api.js, excluding anything an external MCP contributes. */
const CORE_TOOL_COUNT = 36;

/**
 * External MCP servers that belong to the project's own tool surface.
 * Changing these changes the documented tool count, so they are listed
 * explicitly rather than inferred.
 */
const SHIPPED_EXTERNAL_MCP = ["ocr", "screen-recorder", "tts"];

/**
 * Operator-added MCP servers. Not part of the documented contract; each may
 * appear or disappear with its own availability.
 */
const PLUGGABLE_MCP_PREFIXES = ["public-api", "combined", "facebook-ads", "zombie-mini", "skill"];

function classify(tools) {
  const core = [];
  const shipped = [];
  const pluggable = [];
  for (const name of tools) {
    if (!name.includes("__")) {
      core.push(name);
      continue;
    }
    const server = name.split("__")[0];
    if (SHIPPED_EXTERNAL_MCP.includes(server)) shipped.push(name);
    else if (PLUGGABLE_MCP_PREFIXES.some((p) => server.startsWith(p))) pluggable.push(name);
    else pluggable.push(name); // unknown server — treat as pluggable, never core
  }
  return { core, shipped, pluggable };
}

/** @param {string[]} toolNames from tools/list */
function manifest(toolNames) {
  const { core, shipped, pluggable } = classify(toolNames || []);
  const documented = core.length + shipped.length;
  return {
    documented_contract: documented,
    expected_documented: CORE_TOOL_COUNT,
    docs_match: documented === CORE_TOOL_COUNT,
    core: { count: core.length, tools: core },
    shipped_external: { count: shipped.length, tools: shipped },
    pluggable: { count: pluggable.length, tools: pluggable },
    total_exposed: toolNames ? toolNames.length : 0,
    note:
      "documented_contract = core + shipped external (the 36 in the docs). " +
      "pluggable servers are operator-added and are not part of that claim.",
  };
}

module.exports = { CORE_TOOL_COUNT, SHIPPED_EXTERNAL_MCP, PLUGGABLE_MCP_PREFIXES, classify, manifest };