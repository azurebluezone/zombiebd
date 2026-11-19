#!/usr/bin/env node
"use strict";

/*
 * Live workspace + agent artifact check for the project itself.
 *
 * Proves the gateway works on the real project root, not a temporary
 * workspace selected by an earlier request:
 *   1. MCP get_working_dir returns the checkout.
 *   2. memory_recent answers from that project's SQLite archives.
 *   3. .zombiecoder/SSOT.md and the canonical .zombiecoder/syllabus.md exist.
 *   4. The project has exactly one syllabus (no agents/syllabus.md).
 *   5. SQLite project_memory holds archives for the project root.
 *   6. Per-session JSON transcripts still live under data/<session>/.
 *
 * Run: node tests/workspace-agent-check.js
 * Exit 0 prints WORKSPACE_AGENT_OK.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const { loadEnv, readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const RAW = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const PORT = ENV.ports.api || 5050;
const TOKEN =
  process.env.MCP_ADMIN_TOKEN ||
  process.env.ADMIN_API_KEY ||
  RAW.MCP_ADMIN_TOKEN ||
  RAW.ADMIN_API_KEY ||
  "";
const SSOT = path.join(ROOT, ".zombiecoder", "SSOT.md");
const SYLLABUS = path.join(ROOT, ".zombiecoder", "syllabus.md");
const LEGACY_SYLLABUS = path.join(ROOT, ".zombiecoder", "agents", "syllabus.md");
const DB = path.join(ROOT, "data", "models.db");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

function mcp(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args || {} },
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/mcp",
        method: "POST",
        timeout: 15000,
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:" + PORT,
          authorization: "Bearer " + TOKEN,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            resolve({ parse_error: text.slice(0, 300) });
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ transport_error: err.message }));
    req.write(body);
    req.end();
  });
}

function textOf(response) {
  return response?.result?.content?.[0]?.text || "";
}

(async () => {
  check("authenticated MCP token is configured", Boolean(TOKEN));
  const cwd = await mcp("get_working_dir", {});
  check(
    "live MCP working directory is the project root",
    textOf(cwd).trim() === ROOT,
    textOf(cwd).trim() || JSON.stringify(cwd).slice(0, 200),
  );

  const recent = await mcp("memory_recent", { limit: 5 });
  let recentItems = null;
  try {
    recentItems = JSON.parse(textOf(recent));
  } catch (_) {
    recentItems = null;
  }
  check(
    "memory_recent answers from the project archives",
    Array.isArray(recentItems) && recentItems.length > 0,
    Array.isArray(recentItems) ? "items=" + recentItems.length : textOf(recent).slice(0, 200),
  );

  const ssot = fs.existsSync(SSOT) ? fs.readFileSync(SSOT, "utf8") : "";
  check("project SSOT.md exists", ssot.length > 0, "bytes=" + ssot.length);
  check(
    "SSOT records the project root",
    ssot.includes("`" + ROOT + "`") || ssot.includes(ROOT),
  );

  const syllabus = fs.existsSync(SYLLABUS) ? fs.readFileSync(SYLLABUS, "utf8") : "";
  check("canonical project syllabus exists", syllabus.length > 0, "bytes=" + syllabus.length);
  check("project has no second syllabus", !fs.existsSync(LEGACY_SYLLABUS), LEGACY_SYLLABUS);

  const db = new DatabaseSync(DB, { readOnly: true });
  const archives = db
    .prepare("SELECT COUNT(*) AS c FROM project_memory WHERE project_dir = ?")
    .get(ROOT).c;
  check("project archives are in SQLite", archives > 0, "rows=" + archives);

  const dataDir = path.join(ROOT, "data");
  const transcripts = fs.readdirSync(dataDir).filter((entry) => {
    try {
      return (
        fs.statSync(path.join(dataDir, entry)).isDirectory() &&
        fs.readdirSync(path.join(dataDir, entry)).some((file) => file.endsWith(".json"))
      );
    } catch (_) {
      return false;
    }
  });
  check(
    "agent session transcripts are saved as JSON",
    transcripts.length > 0,
    "dirs=" + transcripts.length,
  );

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    console.log("WORKSPACE_AGENT_FAIL");
    process.exit(1);
  }
  console.log("WORKSPACE_AGENT_OK");
})();
