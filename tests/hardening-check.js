#!/usr/bin/env node
"use strict";

/*
 * HARDENING_OK — proves the hardening slice with real files and live calls.
 *
 *   1. modules/anti-dote.js owns antiDoteMonitor; api.js requires it and no
 *      longer defines antiDoteMonitor or wrapWithAntiDote.
 *   2. public/admin.html is an optional API-only convenience page; the
 *      built-in fallback panel lives in lib/admin-panel.js.
 *   3. lib/text-integrity.js sanitizeForModel and sanitizeForWrite strip
 *      U+200B/U+200C/U+200D/U+FEFF, soft hyphen, bidi controls, word joiners
 *      and C0/C1 controls while keeping newline, carriage return and tab.
 *   4. The source tree carries no zero-width/bidi character: a hidden
 *      "dendi" cannot be inserted into code or a file unnoticed.
 *   5. MCP_TOOLS exposes tool_search, executeMcpTool handles it, and the
 *      lazy catalog expands discovered schemas for the next model round.
 *   6. deploy/install-edge.sh treats caddy-owned :80/:443 as valid.
 *   7. Live gateway: /mcp tools/list includes tool_search; tools/call for
 *      tool_search returns the get_working_dir schema; tools/call for
 *      get_working_dir answers with a real path.
 *   8. Live edge: https://127.0.0.1/admin and /api/admin answer 404 while
 *      /health answers 200.
 *
 * Run: node tests/hardening-check.js
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const API_PORT = Number(process.env.LIVE_HTTP_PORT || 5050);
const EDGE_PORT = Number(process.env.LIVE_EDGE_PORT || 443);

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

function read(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), "utf8");
  } catch (_) {
    return "";
  }
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function requestJson(port, method, pathname, body, options) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    Object.assign(headers, (options && options.headers) || {});
    const req = http.request(
      { host: HOST, port, path: pathname, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode || 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: "", error: error.message }));
    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ status: 0, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function edgeGet(pathname) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: HOST,
        port: EDGE_PORT,
        path: pathname,
        method: "GET",
        rejectUnauthorized: false,
        headers: { Accept: "application/json" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode || 0, text, json });
        });
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: "", error: error.message }));
    req.setTimeout(12000, () => {
      req.destroy();
      resolve({ status: 0, text: "", error: "timeout" });
    });
    req.end();
  });
}

function mcp(method, params) {
  return requestJson(
    API_PORT,
    "POST",
    "/mcp",
    { jsonrpc: "2.0", id: "hardening-" + method, method, params: params || {} },
    {
      headers: {
        Origin: "http://127.0.0.1:" + API_PORT,
        "X-MCP-Client-Name": "hardening-check",
      },
    },
  );
}

function mcpText(response) {
  const content =
    response && response.json && response.json.result && response.json.result.content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => (item && item.text) || "").join("");
}

// ── 1. Static ownership ─────────────────────────────────────────
function staticChecks() {
  const api = read("api.js");
  const antiDote = read("modules/anti-dote.js");
  const panel = read("lib/admin-panel.js");
  const installEdge = read("deploy/install-edge.sh");

  check("modules/anti-dote.js exists", exists("modules/anti-dote.js"));
  check(
    "the module owns antiDoteMonitor",
    /function\s+antiDoteMonitor\s*\(/.test(antiDote) &&
      /antiDoteMonitor/.test(antiDote),
  );
  check(
    "api.js requires modules/anti-dote.js",
    /require\(\s*["']\.\/modules\/anti-dote\.js["']\s*\)/.test(api),
  );
  check(
    "api.js delegates antiDoteMonitor",
    /antiDoteModule\.antiDoteMonitor/.test(api),
  );
  check(
    "api.js no longer defines antiDoteMonitor",
    !/async\s+function\s+antiDoteMonitor\s*\(/.test(api),
  );
  check(
    "api.js no longer defines wrapWithAntiDote",
    !/async\s+function\s+wrapWithAntiDote\s*\(/.test(api) &&
      !/wrapWithAntiDote/.test(api),
  );

  const staticAdmin = read("public/admin.html");
  check(
    "public/admin.html is optional and API-only",
    !exists("public/admin.html") ||
      (staticAdmin.includes('id="adminTokenInput"') &&
        !/\bAuthorization\b|\bBearer\b|x-api-key/i.test(staticAdmin) &&
        !/fetch\(\s*["'`]https?:/i.test(staticAdmin)),
  );
  const distAdmin = read("dist/public/admin.html");
  check(
    "dist/public/admin.html is optional and mirrors the source",
    !exists("dist/public/admin.html") ||
      distAdmin.includes('id="adminTokenInput"'),
  );
  check(
    "legacy /admin/:file route is gone",
    !/GET \/admin\/:file/.test(api),
  );
  check(
    "lib/admin-panel.js owns the fallback panel",
    /PANEL_MARKER/.test(panel) && /renderAdminPanel/.test(panel),
  );
  check(
    "api.js resolves the optional page with a module fallback",
    /function\s+loadAdminPage\s*\(/.test(api) && /renderAdminPanel\s*\(/.test(api),
  );

  check(
    "MCP_TOOLS exposes tool_search",
    /tool_search\s*:\s*\{/.test(api),
  );
  check(
    "executeMcpTool handles tool_search",
    /case\s+["']tool_search["']\s*:/.test(api),
  );
  check(
    "lazy tool catalog exists",
    /function\s+lazyToolCatalog\s*\(/.test(api),
  );
  check(
    "discovered schemas expand the next round",
    /function\s+expandToolsFromSearch\s*\(/.test(api),
  );
  check(
    "write_file sanitizes persisted content",
    /sanitizeForWrite\(String\(args\.content/.test(api),
  );

  check(
    "install-edge tolerates caddy-owned :80/:443",
    /FOREIGN_OWNERS/.test(installEdge) &&
      /grep -v ['"]caddy['"]/.test(installEdge),
  );
}

// ── 2. Sanitizer behaviour ──────────────────────────────────────
function sanitizerChecks() {
  const integrity = require(path.join(ROOT, "lib", "text-integrity.js"));
  const dirty = "a\u200Bb\u200Cc\u200Dd\uFEFFe\u0007f\n\tg";
  const expected = "abcdef\n\tg";

  check(
    "sanitizeForModel strips zero-width/control characters",
    integrity.sanitizeForModel(dirty).text === expected,
    JSON.stringify(integrity.sanitizeForModel(dirty).removed),
  );
  check(
    "sanitizeForWrite strips zero-width/control characters",
    integrity.sanitizeForWrite(dirty).text === expected,
    JSON.stringify(integrity.sanitizeForWrite(dirty).removed),
  );
  check(
    "sanitizeForWrite strips soft hyphen, bidi and word joiner",
    integrity.sanitizeForWrite("x\u00ADy\u202Ez\u2060w\u180Ev").text === "xyzwv",
  );
  check(
    "sanitizeForWrite is idempotent on clean text",
    integrity.sanitizeForWrite("plain text\n").total === 0,
  );
}

// ── 3. Repository scan ─────────────────────────────────────────
function scanChecks() {
  const scanRoots = [
    "api.js",
    "start.js",
    "domain-config.js",
    "local-llm-bridge.js",
    "mcp-client.js",
    "external-mcp.js",
    "integrations.js",
    "cdp-pipe.js",
    "package.json",
    "lib",
    "modules",
    "deploy",
    "tests",
    "scripts",
    "public",
    "transport",
    "provider",
    "agent",
  ];
  const skipDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    ".zombiecoder",
    "tmp",
    "docs",
    "data",
    "logs",
    "cache",
    "locks",
    ".missionbarisal",
    ".zombie",
  ]);
  const textExt = new Set([
    ".js",
    ".cjs",
    ".mjs",
    ".ts",
    ".json",
    ".md",
    ".sh",
    ".html",
    ".css",
    ".txt",
    ".yml",
    ".yaml",
    ".template",
  ]);
  const invisible = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFFD]/g;
  const hits = [];

  const scanFile = (absolute) => {
    const ext = path.extname(absolute).toLowerCase();
    if (!textExt.has(ext) && !absolute.endsWith("package.json")) return;
    let text = "";
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch (_) {
      return;
    }
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const match = line.match(invisible);
      if (!match) continue;
      hits.push(
        path.relative(ROOT, absolute).split(path.sep).join("/") +
          ":" +
          (index + 1) +
          " " +
          match
            .map((ch) => "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"))
            .join(","),
      );
      if (hits.length >= 20) return;
    }
  };

  const walk = (absolute) => {
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (_) {
      return;
    }
    if (stat.isFile()) {
      scanFile(absolute);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries = [];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
      walk(path.join(absolute, entry.name));
      if (hits.length >= 20) return;
    }
  };

  for (const root of scanRoots) walk(path.join(ROOT, root));
  check(
    "source tree has no zero-width/bidi characters",
    hits.length === 0,
    hits.slice(0, 5).join(" | "),
  );
}

// ── 4. Live gateway + edge ─────────────────────────────────────
async function liveChecks() {
  const health = await requestJson(API_PORT, "GET", "/health");
  check(
    "live gateway /health answers 200",
    health.status === 200 && health.json && health.json.healthy === true,
    "status=" + health.status + (health.error ? " error=" + health.error : ""),
  );

  const list = await mcp("tools/list", {});
  const tools =
    list.json && list.json.result && Array.isArray(list.json.result.tools)
      ? list.json.result.tools
      : [];
  check(
    "live /mcp tools/list includes tool_search",
    list.status === 200 && tools.some((tool) => tool && tool.name === "tool_search"),
    "status=" + list.status + " tools=" + tools.length,
  );

  const search = await mcp("tools/call", {
    name: "tool_search",
    arguments: { query: "working dir", limit: 5 },
  });
  const searchText = mcpText(search);
  let searchJson = null;
  try {
    searchJson = JSON.parse(searchText);
  } catch (_) {}
  const discovered = searchJson && Array.isArray(searchJson.tools) ? searchJson.tools : [];
  check(
    "live tool_search returns the get_working_dir schema",
    search.status === 200 &&
      discovered.some(
        (tool) => tool && tool.function && tool.function.name === "get_working_dir",
      ),
    "status=" + search.status + " matches=" + discovered.length,
  );

  const workingDir = await mcp("tools/call", {
    name: "get_working_dir",
    arguments: {},
  });
  const workingDirText = mcpText(workingDir);
  check(
    "live get_working_dir answers with a path",
    workingDir.status === 200 && workingDirText.trim().length > 0,
    "status=" + workingDir.status,
  );

  const admin = await edgeGet("/admin");
  check(
    "edge /admin answers 404",
    admin.status === 404,
    "status=" + admin.status + (admin.error ? " error=" + admin.error : ""),
  );

  const adminApi = await edgeGet("/api/admin");
  check(
    "edge /api/admin answers 404",
    adminApi.status === 404,
    "status=" + adminApi.status + (adminApi.error ? " error=" + adminApi.error : ""),
  );

  const edgeHealth = await edgeGet("/health");
  check(
    "edge /health answers 200",
    edgeHealth.status === 200 &&
      edgeHealth.json &&
      edgeHealth.json.healthy === true,
    "status=" + edgeHealth.status + (edgeHealth.error ? " error=" + edgeHealth.error : ""),
  );
}

async function main() {
  console.log("Hardening check — source + live gateway + edge");
  console.log("  root: " + ROOT);
  console.log("  api:  http://" + HOST + ":" + API_PORT);
  console.log("  edge: https://" + HOST + ":" + EDGE_PORT);

  staticChecks();
  sanitizerChecks();
  scanChecks();
  await liveChecks();

  console.log(
    "\nRESULT: " +
      (fail === 0 ? "HARDENING_OK" : "HARDENING_FAIL") +
      " pass=" +
      pass +
      " fail=" +
      fail,
  );
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log("FAIL unhandled: " + (error && error.message ? error.message : error));
  console.log("\nRESULT: HARDENING_FAIL");
  process.exitCode = 1;
});
