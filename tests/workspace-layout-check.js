#!/usr/bin/env node
"use strict";

/*
 * Canonical workspace layout acceptance check.
 *
 * Proves:
 *   1. modules/workspace.js creates exactly one .zombiecoder tree:
 *      SSOT.md, syllabus.md, memory/, .state/ — never agents/ or
 *      agents/sessions/.
 *   2. The canonical syllabus path is .zombiecoder/syllabus.md.
 *   3. A legacy agents/syllabus.md is migrated (content preserved), and a
 *      duplicate is reported but never deleted behind the operator's back.
 *   4. Syllabus appends land in the canonical file and duplicates are skipped.
 *   5. MCP bootstrap from a bare cwd creates nothing; roots create the
 *      canonical layout.
 *   6. api.js holds no second syllabus implementation and initialize uses the
 *      stable project root, not the mutable working directory.
 *   7. Live project state has one syllabus, no legacy agents/ tree, the
 *      required JSON session files, and the wrong Desktop/1 workspace is gone.
 *   8. The running gateway was booted from dist/ (the built runtime).
 *
 * Run: node tests/workspace-layout-check.js
 * Exit 0 prints WORKSPACE_LAYOUT_OK.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const { loadEnv, readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "workspace-layout-check-" + process.pid);
const ENV = loadEnv({ root: ROOT });
const RAW = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const PORT = ENV.ports.api || 5050;
const TOKEN =
  process.env.MCP_ADMIN_TOKEN ||
  process.env.ADMIN_API_KEY ||
  RAW.MCP_ADMIN_TOKEN ||
  RAW.ADMIN_API_KEY ||
  "";
const WRONG_WORKSPACE = "/home/sahon/Desktop/1";

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

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listTree(dir) {
  const out = [];
  const walk = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel ? rel + "/" + entry.name : entry.name;
      out.push(childRel + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) walk(path.join(current, entry.name), childRel);
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out.sort();
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

function gatewayProcesses() {
  const found = [];
  const proc = "/proc";
  for (const pid of fs.readdirSync(proc)) {
    if (!/^\d+$/.test(pid)) continue;
    let cmd = "";
    let cwd = "";
    try {
      cmd = fs.readFileSync(path.join(proc, pid, "cmdline"), "utf8").replace(/\0/g, " ").trim();
      cwd = fs.readlinkSync(path.join(proc, pid, "cwd"));
    } catch (_) {
      continue;
    }
    if (!/node/.test(cmd) || !/start\.js/.test(cmd)) continue;
    found.push({ pid: Number(pid), cmd, cwd });
  }
  return found;
}

fs.rmSync(TMP, { recursive: true, force: true });

const workspace = require(path.join(ROOT, "modules", "workspace.js"));
const syllabus = require(path.join(ROOT, "modules", "syllabus.js"));
const mcpProtocol = require(path.join(ROOT, "modules", "mcp-protocol.js"));

// ── 1. Canonical layout ─────────────────────────────────────
const ws = fresh("project");
const layout = workspace.ensureWorkspace(ws);
const tree = listTree(path.join(ws, ".zombiecoder"));
check(
  "ensureWorkspace creates SSOT, syllabus, memory and .state",
  fs.existsSync(layout.ssot) &&
    fs.existsSync(layout.syllabus) &&
    fs.existsSync(layout.memory) &&
    fs.existsSync(layout.state),
  tree.join(", "),
);
check(
  "ensureWorkspace never creates .zombiecoder/agents",
  !fs.existsSync(path.join(ws, ".zombiecoder", "agents")),
  tree.join(", "),
);
check(
  "canonical syllabus is .zombiecoder/syllabus.md",
  path.relative(ws, layout.syllabus) === path.join(".zombiecoder", "syllabus.md"),
  layout.syllabus,
);
check(
  "legacy syllabus path is read-only metadata",
  layout.legacySyllabus === path.join(ws, ".zombiecoder", "agents", "syllabus.md") &&
    !fs.existsSync(layout.legacySyllabus),
  layout.legacySyllabus,
);

const again = workspace.ensureWorkspace(ws);
check("second ensureWorkspace is idempotent", again.created.length === 0, JSON.stringify(again.created));
check(
  "workspace fingerprint reads the canonical syllabus",
  /^[a-f0-9]{16}$/.test(workspace.workspaceFingerprint(ws).syllabus),
);

// ── 2. Legacy migration ─────────────────────────────────────
const legacyWs = fresh("legacy-project");
const legacyDir = path.join(legacyWs, ".zombiecoder", "agents");
fs.mkdirSync(legacyDir, { recursive: true });
fs.writeFileSync(path.join(legacyDir, "syllabus.md"), "# Legacy syllabus\n\nKEEP_ME_LEGACY\n", "utf8");
const migrated = workspace.ensureWorkspace(legacyWs);
check(
  "legacy agents/syllabus.md migrates to the canonical path",
  migrated.legacy.migrated === true &&
    fs.readFileSync(migrated.syllabus, "utf8").includes("KEEP_ME_LEGACY"),
  migrated.syllabus,
);
check(
  "migration removes the empty legacy agents dir",
  !fs.existsSync(legacyDir),
);

const duplicateWs = fresh("duplicate-project");
const dupAgents = path.join(duplicateWs, ".zombiecoder", "agents");
fs.mkdirSync(dupAgents, { recursive: true });
fs.writeFileSync(path.join(duplicateWs, ".zombiecoder", "syllabus.md"), "# Root\n", "utf8");
fs.writeFileSync(path.join(dupAgents, "syllabus.md"), "# Legacy duplicate\n", "utf8");
const duplicate = workspace.ensureWorkspace(duplicateWs);
check(
  "duplicate legacy file is reported, not deleted",
  duplicate.legacy.duplicate === true &&
    fs.existsSync(path.join(dupAgents, "syllabus.md")) &&
    fs.readFileSync(path.join(duplicateWs, ".zombiecoder", "syllabus.md"), "utf8").includes("# Root"),
);

// ── 3. Syllabus appends ─────────────────────────────────────
const appendWs = fresh("append-project");
const firstAppend = syllabus.appendSyllabusEntry({
  dir: appendWs,
  input: "Add a canonical workspace check for the project",
  source: "test",
});
const secondAppend = syllabus.appendSyllabusEntry({
  dir: appendWs,
  input: "Add a canonical workspace check for the project",
  source: "test",
});
check("syllabus append writes the canonical file", firstAppend.written === true, firstAppend.path);
check(
  "syllabus append leaves no second syllabus",
  fs.existsSync(path.join(appendWs, ".zombiecoder", "syllabus.md")) &&
    !fs.existsSync(path.join(appendWs, ".zombiecoder", "agents", "syllabus.md")),
);
check(
  "duplicate syllabus append is skipped",
  secondAppend.written === false && secondAppend.reason === "duplicate",
  secondAppend.reason,
);

const learningWs = fresh("learning-project");
const learned = syllabus.recordLearning(
  learningWs,
  "check-run",
  { source: "test", summary: "recorded", keyPoints: ["one"] },
);
check(
  "recordLearning appends to the canonical syllabus",
  learned === true &&
    fs.readFileSync(path.join(learningWs, ".zombiecoder", "syllabus.md"), "utf8").includes("### check-run"),
);

// ── 4. MCP bootstrap ────────────────────────────────────────
const cwdOnly = fresh("cwd-only");
const cwdBoot = mcpProtocol.bootstrapWorkspace({ roots: [], cwd: cwdOnly });
check(
  "bootstrapWorkspace from bare cwd creates no workspace tree",
  cwdBoot.source === "cwd" &&
    cwdBoot.created.length === 0 &&
    !fs.existsSync(path.join(cwdOnly, ".zombiecoder")),
  cwdBoot.source,
);

const rootsWs = fresh("roots-project");
const rootsBoot = mcpProtocol.bootstrapWorkspace({
  roots: [{ uri: "file://" + rootsWs }],
  cwd: cwdOnly,
});
const rootsTree = listTree(path.join(rootsWs, ".zombiecoder"));
check(
  "bootstrapWorkspace from MCP roots creates the canonical layout",
  rootsBoot.source === "mcp-roots" &&
    fs.existsSync(path.join(rootsWs, ".zombiecoder", "syllabus.md")) &&
    fs.existsSync(path.join(rootsWs, ".zombiecoder", "memory")) &&
    !fs.existsSync(path.join(rootsWs, ".zombiecoder", "agents")),
  rootsTree.join(", "),
);
check(
  "bootstrap paths expose canonical and legacy locations",
  rootsBoot.paths.syllabus === path.join(rootsWs, ".zombiecoder", "syllabus.md") &&
    rootsBoot.paths.legacySyllabus ===
      path.join(rootsWs, ".zombiecoder", "agents", "syllabus.md"),
);

// ── 5. api.js single implementation ─────────────────────────
const apiSrc = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
check(
  "api.js delegates syllabus storage to modules/syllabus.js",
  apiSrc.includes('require("./modules/syllabus.js")') &&
    apiSrc.includes("syllabusModule.ensureSyllabus") &&
    apiSrc.includes("syllabusModule.recordLearning"),
);
check(
  "api.js has no gateway agents/syllabus path",
  !apiSrc.includes(".zombiecoder/agents/syllabus") &&
    !/path\.join\(agentsDir,\s*"syllabus\.md"\)/.test(apiSrc),
);
check(
  "MCP initialize uses the stable project root",
  (apiSrc.match(/cwd: CHECKOUT_ROOT/g) || []).length === 2 &&
    !apiSrc.includes("cwd: mcpWorkingDir"),
);
check(
  "working directory defaults to the checkout, not process.cwd()",
  apiSrc.includes("let mcpWorkingDir = CHECKOUT_ROOT") &&
    !apiSrc.includes('let mcpWorkingDir = path.resolve(".")') &&
    apiSrc.includes("let probe = CHECKOUT_ROOT") &&
    !apiSrc.includes("let probe = path.resolve(\".\")"),
);

// ── 6. Live project state ───────────────────────────────────
const liveSyllabus = path.join(ROOT, ".zombiecoder", "syllabus.md");
const liveLegacySyllabus = path.join(ROOT, ".zombiecoder", "agents", "syllabus.md");
check("live canonical syllabus exists", fs.existsSync(liveSyllabus));
check(
  "live project has no second syllabus",
  !fs.existsSync(liveLegacySyllabus),
  liveLegacySyllabus,
);
check(
  "live project has no gateway agents/sessions tree",
  !fs.existsSync(path.join(ROOT, ".zombiecoder", "agents", "sessions")),
);
const wrongTree = path.join(WRONG_WORKSPACE, ".zombiecoder");
check("the wrong Desktop/1 workspace tree is gone", !fs.existsSync(wrongTree), wrongTree);

const dataDir = path.join(ROOT, "data");
const dataEntries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : [];
const memJson = dataEntries.filter((n) => n.startsWith("mem-") && n.endsWith(".json"));
const sessionDirs = dataEntries.filter((n) => {
  try {
    return fs.statSync(path.join(dataDir, n)).isDirectory() && fs.readdirSync(path.join(dataDir, n)).some((f) => f.endsWith(".json"));
  } catch (_) {
    return false;
  }
});
check("JSON session memory mem-*.json is intact", memJson.length > 0, "files=" + memJson.length);
check("per-session JSON transcripts are intact", sessionDirs.length > 0, "dirs=" + sessionDirs.length);

let pluginJsonl = [];
try {
  pluginJsonl = fs.readdirSync(path.join(ROOT, ".zombiecoder", "memory")).filter((n) => n.endsWith(".jsonl"));
} catch (_) {
  pluginJsonl = [];
}
check("plugin JSONL session memory is intact", pluginJsonl.length > 0, "files=" + pluginJsonl.length);

// ── 7. Live gateway: project root + dist runtime ─────────────
const pendingCwd = mcp("get_working_dir", {});
(async () => {
  check("authenticated MCP token is configured", Boolean(TOKEN));
  const cwdResponse = await pendingCwd;
  check(
    "live MCP working directory is the project root",
    textOf(cwdResponse).trim() === ROOT,
    textOf(cwdResponse).trim() || JSON.stringify(cwdResponse).slice(0, 200),
  );

  const gateways = gatewayProcesses().filter(
    (entry) => entry.cwd === ROOT || entry.cwd === path.join(ROOT, "dist"),
  );
  check("a gateway process is running for this project", gateways.length > 0, "pids=" + gateways.map((g) => g.pid).join(","));
  check(
    "the running gateway was booted from dist/",
    gateways.length > 0 && gateways.every((entry) => /dist[\/\\]start\.js/.test(entry.cmd)),
    gateways.map((entry) => entry.cmd).join(" | "),
  );

  const sourceApi = fs.statSync(path.join(ROOT, "api.js")).mtimeMs;
  const builtApi = fs.statSync(path.join(ROOT, "dist", "api.js")).mtimeMs;
  check(
    "dist/api.js is not older than the source build",
    builtApi >= sourceApi,
    "source=" + new Date(sourceApi).toISOString() + " dist=" + new Date(builtApi).toISOString(),
  );

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    console.log("WORKSPACE_LAYOUT_FAIL");
    process.exit(1);
  }
  console.log("WORKSPACE_LAYOUT_OK");
})();
