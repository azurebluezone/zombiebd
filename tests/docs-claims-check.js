#!/usr/bin/env node
"use strict";

/**
 * docs-claims-check.js - fail when the documentation stops matching reality.
 *
 * Two kinds of checks:
 *   1. Static: names, required facts, no dead relative links, no emoji.
 *   2. Live: the agent and tool counts printed in README headings must equal
 *      what the running gateway actually reports.
 *
 * Not a prose linter: it only checks claims that a user can verify.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { loadEnv } = require("../lib/env");

const ROOT = path.resolve(__dirname, "..");
const README = path.join(ROOT, "README.md");
const SPEC = path.join(ROOT, "docs", "EDGE-RUNTIME-SPEC.md");
const env = loadEnv({ root: ROOT });
const PORT = env.ports.api;
const failures = [];

function fail(message) {
  failures.push(message);
  console.log("FAIL " + message);
}
function pass(message) {
  console.log("PASS " + message);
}

function request(pathname, method, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path: pathname,
      method: method || "GET",
      timeout: 8000,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length, Accept: "application/json" }
        : { Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, json: null, text: "timeout" }); });
    req.on("error", (err) => resolve({ status: 0, json: null, text: err.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function relativeLinks(text) {
  const links = [];
  const re = /\]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(text))) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|#|\/)/i.test(target)) continue;
    target = target.split("#")[0].split("?")[0];
    if (!target) continue;
    links.push(decodeURIComponent(target));
  }
  return Array.from(new Set(links));
}

const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

async function main() {
  const readme = fs.readFileSync(README, "utf8");
  const spec = fs.readFileSync(SPEC, "utf8");

  if (readme.includes("Mission Barisal")) pass("name-mission-barisal");
  else fail("README does not name Mission Barisal");
  for (const forbidden of ["Monu The Builder", "মনুদা বিল্ডার"]) {
    if (readme.includes(forbidden) || spec.includes(forbidden)) fail("stale name: " + forbidden);
  }
  const node24Claim = /Node(?:\.js)?[^\n]{0,30}(?:≥|>=|24\s*\+|24 or newer)/i.test(readme);
  if (node24Claim) pass("node-version-claim");
  else fail("README does not contain an explicit Node 24+ requirement");

  for (const file of relativeLinks(readme).concat(relativeLinks(spec))) {
    if (!fs.existsSync(path.join(ROOT, file))) fail("dead documentation link: " + file);
  }
  if (relativeLinks(readme).concat(relativeLinks(spec)).every((f) => fs.existsSync(path.join(ROOT, f)))) {
    pass("relative-links");
  }

  if (emoji.test(readme) || emoji.test(spec)) fail("emoji in newly maintained docs");
  else pass("docs-no-emoji");

  const agentHeading = readme.match(/##\s+The Mission Barisal Agents\s*\((\d+)\)/);
  const toolHeading = readme.match(/##\s+MCP Tools\s*\((\d+)\)/);
  if (!agentHeading) fail("README has no 'The Mission Barisal Agents (N)' heading");
  if (!toolHeading) fail("README has no 'MCP Tools (N)' heading");

  const status = await request("/status");
  if (!status.json || !Array.isArray(status.json.agents)) {
    fail("live /status did not return an agent list");
  } else if (agentHeading && Number(agentHeading[1]) !== status.json.agents.length) {
    fail("README agent count " + agentHeading[1] + " != live " + status.json.agents.length);
  } else if (agentHeading) {
    pass("agent-count=" + status.json.agents.length);
  }

  const mcp = await request("/mcp", "POST", {
    jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
  });
  const tools = mcp.json && mcp.json.result && mcp.json.result.tools;
  if (!Array.isArray(tools)) {
    fail("live /mcp did not return a tool list (status " + mcp.status + ")");
  } else if (toolHeading && Number(toolHeading[1]) !== tools.length) {
    fail("README tool count " + toolHeading[1] + " != live " + tools.length);
  } else if (toolHeading) {
    pass("tool-count=" + tools.length);
  }

  if (!/verified 2026-11-06/.test(spec)) fail("EDGE-RUNTIME-SPEC is not marked verified 2026-11-06");
  if (/Phase 1 in progress/.test(spec)) fail("EDGE-RUNTIME-SPEC still claims Phase 1 in progress");

  if (failures.length) {
    console.log("DOCS_CLAIMS_FAIL count=" + failures.length);
    process.exit(1);
  }
  console.log("DOCS_CLAIMS_OK links=ok counts=live naming=ok");
}

main().catch((err) => {
  console.error("DOCS_CLAIMS_FAIL " + err.message);
  process.exit(1);
});
