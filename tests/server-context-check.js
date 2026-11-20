"use strict";

/**
 * Server independence gate.
 *
 * Proves the gateway no longer depends on the OpenCode plugin:
 *   - workspace creation writes only `.zombie/` and never `.zombiecoder/`;
 *   - the plugin tree is byte-identical before and after (read-only input);
 *   - plugin-only syllabus entries are merged into the server view;
 *   - the prompt carries input-matched SSOT/syllabus, fingerprint, the last
 *     10 SessionStore turns and the open GoalLedger goal;
 *   - the workspace id is a stable 12-hex value that resolves through the
 *     registry without a path separator;
 *   - runtime files contain no plugin install path and api.js uses the adapter
 *     and prompt engine;
 *   - the live gateway is healthy.
 *
 * Exit 0 + `SERVER_CONTEXT_OK` only when every check passes.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const { ensureWorkspace, workspaceFingerprint, resolveWorkspace } = require(path.join(ROOT, "modules", "workspace"));
const adapter = require(path.join(ROOT, "modules", "workspace-adapter"));
const context = require(path.join(ROOT, "modules", "context"));
const syllabus = require(path.join(ROOT, "modules", "syllabus"));
const { SessionStore } = require(path.join(ROOT, "modules", "sessions"));
const { GoalLedger } = require(path.join(ROOT, "modules", "goals"));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  [PASS] " + name + (detail ? " — " + detail : ""));
    return true;
  }
  failed += 1;
  const line = name + (detail ? " — " + detail : "");
  failures.push(line);
  console.log("  [FAIL] " + line);
  return false;
}

function sha(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (_) {
    return "missing";
  }
}

function treeHashes(dir) {
  const out = {};
  const walk = (current, prefix) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) out[rel] = sha(full);
    }
  };
  walk(dir, "");
  return out;
}

function getJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs || 4000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (_) {
          resolve({ status: res.statusCode, json: null });
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, json: null, error: error.message }));
  });
}

const base = fs.existsSync("/tmp/opencode")
  ? fs.mkdtempSync(path.join("/tmp/opencode", "zc-server-context-"))
  : fs.mkdtempSync(path.join(os.tmpdir(), "zc-server-context-"));
const project = path.join(base, "project");
const plugin = path.join(project, ".zombiecoder");
fs.mkdirSync(plugin, { recursive: true });

const pluginSsot = [
  "# Plugin SSOT",
  "",
  "## Provider Health",
  "",
  "Provider health must reflect the last real probe, never an optimistic guess.",
  "",
  "## Workspace",
  "",
  "Workspace isolation is mandatory; the plugin owns .zombiecoder.",
  "",
].join("\n");

const pluginKey = syllabus.entryKey("plugin provider health lesson");
const pluginSyllabus = [
  "# Plugin Syllabus",
  "",
  "### Plugin lesson: provider health",
  "<!-- zc-entry:" + pluginKey + " source:plugin at:2026-11-20T00:00:00.000Z -->",
  "- user input: plugin provider health lesson",
  "- summary: plugin already recorded this lesson",
  "",
  "### Plugin lesson: workspace id",
  "<!-- zc-entry:pluginworkspaceid source:plugin at:2026-11-20T00:00:00.000Z -->",
  "- user input: workspace id transport header",
  "- summary: the plugin uses a compact workspace id",
  "",
].join("\n");

fs.writeFileSync(path.join(plugin, "SSOT.md"), pluginSsot, "utf8");
fs.writeFileSync(path.join(plugin, "syllabus.md"), pluginSyllabus, "utf8");
fs.mkdirSync(path.join(plugin, "memory"), { recursive: true });
fs.writeFileSync(path.join(plugin, "memory", "plugin.jsonl"), '{"type":"plugin"}\n', "utf8");
fs.mkdirSync(path.join(plugin, ".state"), { recursive: true });
fs.writeFileSync(path.join(plugin, ".state", "plugin.json"), '{"plugin":true}\n', "utf8");

const pluginBefore = treeHashes(plugin);

console.log("Server independence check");
console.log("  workspace: " + project);

// 1. Server workspace creation
const layout = ensureWorkspace(project);
check("server workspace exists", fs.existsSync(path.join(project, ".zombie")), path.join(project, ".zombie"));
check("server SSOT exists", fs.existsSync(layout.ssot), layout.ssot);
check("server syllabus exists", fs.existsSync(layout.syllabus), layout.syllabus);
check("server memory dir exists", fs.existsSync(layout.memory), layout.memory);
check("server sessions dir exists", fs.existsSync(path.join(layout.memory, "sessions")), path.join(layout.memory, "sessions"));
check("server state dir exists", fs.existsSync(layout.state), layout.state);
check("server seeded SSOT from plugin", layout.fromPlugin && layout.fromPlugin.ssot === true, "fromPlugin=" + JSON.stringify(layout.fromPlugin));
check("server seeded syllabus from plugin", layout.fromPlugin && layout.fromPlugin.syllabus === true, "fromPlugin=" + JSON.stringify(layout.fromPlugin));

// 2. Plugin tree is read-only
const pluginAfter = treeHashes(plugin);
const pluginBeforeKeys = Object.keys(pluginBefore).sort().join(",");
const pluginAfterKeys = Object.keys(pluginAfter).sort().join(",");
check("plugin tree file list unchanged", pluginBeforeKeys === pluginAfterKeys, pluginAfterKeys);
let pluginBytesSame = true;
for (const rel of Object.keys(pluginBefore)) {
  if (pluginBefore[rel] !== pluginAfter[rel]) pluginBytesSame = false;
}
check("plugin tree bytes unchanged", pluginBytesSame, "files=" + Object.keys(pluginBefore).length);

// 3. Merge view
const merged = adapter.readMergedSyllabus(project);
check("merged syllabus includes plugin entry", merged.text.includes("Plugin lesson: provider health"), "plugin=" + merged.plugin);
check("merged syllabus includes plugin workspace entry", merged.text.includes("Plugin lesson: workspace id"), "plugin=" + merged.plugin);
check("readSyllabus returns merged view", syllabus.readSyllabus(project).includes("Plugin lesson: provider health"));
const duplicate = syllabus.appendSyllabusEntry({ dir: project, input: "plugin provider health lesson" });
check("server append skips a plugin entry", duplicate.written === false && (duplicate.reason === "duplicate" || duplicate.reason === "plugin-entry"), JSON.stringify(duplicate));

const fingerprint = workspaceFingerprint(project);
check("fingerprint reports plugin syllabus", fingerprint.plugin_syllabus === true, "combined=" + fingerprint.combined);
check("fingerprint has ssot and syllabus hashes", fingerprint.ssot !== "missing" && fingerprint.syllabus !== "missing", JSON.stringify({ ssot: fingerprint.ssot, syllabus: fingerprint.syllabus }));

// 4. SessionStore: 11 turns -> prompt carries only the last 10
const store = new SessionStore({ archiveDir: path.join(layout.memory, "sessions") });
store.create({ id: "ses_server_context", workspace: project });
for (let i = 1; i <= 11; i += 1) {
  store.append("ses_server_context", { role: i % 2 ? "user" : "assistant", content: "turn-" + i });
}
const recent = store.recentTurns("ses_server_context", 10);
check("recentTurns returns 10", recent.length === 10, "len=" + recent.length);
check("recentTurns drops the oldest turn", recent[0].content === "turn-2" && recent[9].content === "turn-11", recent.map((t) => t.content).join(","));

// 5. GoalLedger: open goal is visible in the prompt
const ledger = new GoalLedger({ dir: project, timeoutMs: 20000 });
const goal = ledger.open({
  goal: "prove the server prompt context",
  input: "verify server context",
  expected: "GOAL_MARKER_OK",
  check: 'node -e "console.log(\'GOAL_MARKER_OK\')"',
  pass: "the prompt carries the open goal",
  match: "contains",
});
const active = ledger.active();
check("GoalLedger.active returns the open goal", active && active.id === goal.id, active ? active.id : "null");

// 6. Prompt context
const prompt = context.buildPromptContext({
  dir: project,
  input: "provider health workspace",
  sessionId: "ses_server_context",
  sessions: store,
  goals: ledger,
});
check("prompt has input-matched SSOT", prompt.text.includes("PROJECT SSOT") && prompt.text.toLowerCase().includes("provider health"), "ssot=" + prompt.sections.ssot);
check("prompt has input-matched syllabus", prompt.text.includes("AGENT SYLLABUS") && prompt.text.includes("Plugin lesson"), "syllabus=" + prompt.sections.syllabus);
check("prompt has fingerprint", prompt.text.includes("Context fingerprint: " + prompt.fingerprint), prompt.fingerprint);
check("prompt has last 10 turns", prompt.text.includes("SESSION MEMORY") && prompt.text.includes("turn-2") && prompt.text.includes("turn-11"), "turns=" + prompt.turns.length);
check("prompt omits turn-1", !prompt.text.includes("turn-1\n") && !prompt.text.includes("user: turn-1\n"), "oldest excluded");
check("prompt has active goal", prompt.text.includes("ACTIVE GOAL") && prompt.text.includes("GOAL_MARKER_OK"), active ? active.id : "null");
check("prompt has 12-hex workspace id", /^[0-9a-f]{12}$/.test(prompt.workspaceId) && prompt.text.includes("Workspace id: " + prompt.workspaceId), prompt.workspaceId);
check("prompt stays bounded", prompt.text.length <= 6000, "chars=" + prompt.text.length);

// 7. Goal close runs the real check
const closed = ledger.close(goal.id);
check("GoalLedger close runs the check", closed.status === "PASS" && closed.exitCode === 0, JSON.stringify({ status: closed.status, exitCode: closed.exitCode }));

// 8. Workspace id registry
const id = adapter.workspaceId(project);
check("workspace id is 12 hex", /^[0-9a-f]{12}$/.test(id), id);
check("workspace id has no path separator", !id.includes("/") && !id.includes("\\"), id);
const registry = path.join(base, "workspaces.json");
const registered = adapter.registerWorkspace(project, { registry });
check("registerWorkspace returns the same id", registered === id, registered);
const lookedUp = adapter.lookupWorkspace(id, { registry });
check("lookupWorkspace resolves the directory", lookedUp === path.resolve(project), lookedUp);
const resolved = resolveWorkspace({ workspaceId: id, registry, cwd: base });
check("resolveWorkspace uses the compact id", resolved.dir === path.resolve(project) && resolved.source === "workspace-id", JSON.stringify(resolved));

// 9. Runtime files do not import the plugin install path
const runtimeFiles = [];
for (const rel of ["api.js", "start.js"]) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) runtimeFiles.push(file);
}
for (const dir of ["modules", "transport", "provider"]) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) continue;
  for (const name of fs.readdirSync(full)) {
    if (name.endsWith(".js")) runtimeFiles.push(path.join(full, name));
  }
}
const pluginPathPattern = /(?:\.config\/opencode\/plugins\/zombiecoder|plugins[\\/]zombiecoder[\\/]plugin\.ts)/;
const offenders = runtimeFiles.filter((file) => pluginPathPattern.test(fs.readFileSync(file, "utf8")));
check("runtime files have no plugin install path", offenders.length === 0, offenders.map((f) => path.relative(ROOT, f)).join(",") || "none");

const apiText = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
check("api.js requires the workspace adapter", apiText.includes('require("./modules/workspace-adapter.js")'), "workspace-adapter");
check("api.js uses the prompt engine", apiText.includes("buildPromptContext") && apiText.includes("contextModule"), "buildPromptContext");

// 10. Live gateway
getJson("http://127.0.0.1:5050/health", 4000).then((health) => {
  check("live gateway is healthy", health.status === 200 && health.json && health.json.healthy === true, health.error || ("status=" + health.status));

  console.log("");
  console.log("checks: " + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("SERVER_CONTEXT_FAIL");
    for (const line of failures) console.log("  - " + line);
    process.exit(1);
  }
  console.log("SERVER_CONTEXT_OK local=1 plugin_readonly=1 merged=1 prompt=1 turns=10 goal=1 id=12 runtime=clean live=1");
  process.exit(0);
});
