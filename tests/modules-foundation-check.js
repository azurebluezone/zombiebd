"use strict";

/**
 * tests/modules-foundation-check.js
 *
 * Real check for the foundation modules. It builds a temp workspace and a real
 * in-memory SQLite database (`node:sqlite`), then exercises the documented
 * behaviour of every module. The success marker is printed only when every
 * assertion passes.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const config = require(path.join(ROOT, "modules", "config"));
const workspace = require(path.join(ROOT, "modules", "workspace"));
const agentModule = require(path.join(ROOT, "modules", "agents"));
const { SessionStore } = require(path.join(ROOT, "modules", "sessions"));
const contextModule = require(path.join(ROOT, "modules", "context"));
const { buildSystemPrompt } = require(path.join(ROOT, "modules", "system-prompt"));

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL - " + name + ": " + error.message);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zc-foundation-"));
const wsRoot = path.join(tmp, "client-project");
fs.mkdirSync(wsRoot, { recursive: true });

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, model TEXT, expertise TEXT,
    persona TEXT NOT NULL, enabled INTEGER DEFAULT 1, priority INTEGER DEFAULT 99,
    updated_at INTEGER DEFAULT 0
  );
`);

// ── 1. config: DB → env → explicit error ──────────────────────
check("config resolves DB before env, env when DB is empty, and errors otherwise", () => {
  const env = {
    ZC_CHECK_PORT: "6002",
    ZC_CHECK_ENV_ONLY: "from-env",
    ZC_CHECK_FLAG: "yes",
  };
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    "ZC_CHECK_PORT",
    "6001",
    0,
  );

  const fromDb = config.resolveSetting("ZC_CHECK_PORT", { db, env });
  assert.strictEqual(fromDb.value, "6001");
  assert.strictEqual(fromDb.source, "db");

  const fromEnv = config.resolveSetting("ZC_CHECK_ENV_ONLY", { db, env });
  assert.strictEqual(fromEnv.value, "from-env");
  assert.strictEqual(fromEnv.source, "env");

  assert.throws(
    () => config.requireSetting("ZC_CHECK_MISSING", { db, env }),
    (error) =>
      error.code === "ZC_CONFIG_MISSING" &&
      error.key === "ZC_CHECK_MISSING" &&
      /database settings table/.test(error.message),
  );

  assert.strictEqual(config.resolvePort("ZC_CHECK_PORT", { db, env }).value, 6001);
  assert.strictEqual(config.resolveBool("ZC_CHECK_FLAG", { db, env }).value, true);
});

// ── 2. workspace: auto-create + resolution order ──────────────
check("ensureWorkspace creates the canonical layout and roots beat env", () => {
  const first = workspace.ensureWorkspace(wsRoot);
  for (const target of [first.ssot, first.syllabus, first.memory, first.state]) {
    assert.ok(fs.existsSync(target), "missing " + target);
  }
  assert.ok(!fs.existsSync(path.join(wsRoot, ".zombiecoder", "agents")), "legacy agents dir must not be created");
  const second = workspace.ensureWorkspace(wsRoot);
  assert.deepStrictEqual(second.created, [], "second ensure must not rewrite files");

  const other = path.join(tmp, "other-project");
  fs.mkdirSync(other, { recursive: true });
  const resolved = workspace.resolveWorkspace({
    roots: [{ uri: "file://" + wsRoot }],
    env: { ZOMBIECODER_WORKING_DIR: other },
    cwd: tmp,
  });
  assert.strictEqual(resolved.dir, wsRoot);
  assert.strictEqual(resolved.source, "mcp-roots");

  const fromEnv = workspace.resolveWorkspace({
    roots: [],
    env: { ZOMBIECODER_WORKING_DIR: other },
    cwd: tmp,
  });
  assert.strictEqual(fromEnv.dir, other);
  assert.strictEqual(fromEnv.source, "env:ZOMBIECODER_WORKING_DIR");
});

// ── 3. agents: DB row → file persona → error ─────────────────
let dbAgent = null;
let session = null;
check("agent resolves DB first, file persona second, and injects session facts", () => {
  db.prepare(
    "INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "code-guru",
    "DB Guru",
    "architecture",
    "test/model",
    "db expertise",
    "DB persona wins for this agent.",
    1,
    1,
    0,
  );

  dbAgent = agentModule.resolveAgent("code-guru", { db });
  assert.strictEqual(dbAgent.source, "db");
  assert.strictEqual(dbAgent.persona, "DB persona wins for this agent.");

  const fileAgent = agentModule.resolveAgent("bug-hunter", { db });
  assert.strictEqual(fileAgent.source, "persona-default");
  assert.ok(fileAgent.persona.length > 20, "file persona must be non-empty");

  assert.throws(
    () => agentModule.resolveAgent("no-such-agent", { db }),
    (error) => error.code === "ZC_AGENT_NOT_FOUND",
  );

  session = agentModule.buildAgentSession(dbAgent, {
    workspace: wsRoot,
    metadata: { session_id: "sess-1", editor: "cursor", client: "cursor" },
    identity: { name: "ZombieCoder", type: "development", domain: "localhost" },
  });
  assert.strictEqual(session.metadata.session_id, "sess-1");
  assert.ok(session.os.platform, "os.platform must be injected");
  assert.ok(session.os.node, "node version must be injected");
  assert.strictEqual(session.system_identity.name, "ZombieCoder");
  assert.strictEqual(session.workspace, wsRoot);
  assert.ok(session.persona.length > 0);
});

// ── 4. sessions: 10 resident, every turn archived ────────────
check("12 sessions leave 10 resident, every turn is archived, evicted is readable", () => {
  const store = new SessionStore({
    maxResident: 10,
    archiveDir: path.join(wsRoot, ".zombiecoder", "memory", "sessions"),
    ttlMs: 60 * 60 * 1000,
  });
  for (let i = 0; i < 12; i += 1) {
    store.create({ id: "s" + i, agentId: "code-guru", workspace: wsRoot });
  }
  assert.strictEqual(store.residentIds().length, 10, "RAM budget is 10");
  assert.ok(!store.residentIds().includes("s0"), "oldest session must be evicted");

  for (let i = 0; i < 12; i += 1) {
    store.append("s" + i, { role: "user", content: "input " + i });
    store.append("s" + i, { role: "assistant", content: "output " + i });
  }
  assert.strictEqual(store.residentIds().length, 10, "appends must not grow RAM");

  const archived = store.get("s0");
  assert.ok(archived, "evicted session must be readable");
  assert.strictEqual(archived.turns.length, 2);
  assert.strictEqual(archived.turns[0].content, "input 0");
  assert.ok(fs.existsSync(store.archivePath("s0")), "archive file must exist");
  assert.strictEqual(store.residentIds().length, 10, "reading an archive must not promote it");
});

// ── 5. context: hard budget + fingerprint + targeted files ───
let sliced = null;
check("sliceContext stays under budget, fingerprints, and picks only matched sections", () => {
  const ssot = [
    "# Alpha Project",
    "",
    "## Provider pipeline",
    "",
    "Provider normalizer masking happens in normalizer/index.js; the watermark is applied after masking.",
    "",
    "## Deployment",
    "",
    "deployment ".repeat(2000),
  ].join("\n");
  const syllabus = [
    "# Syllabus",
    "",
    "## Provider masking lesson",
    "",
    "Masking strips provider identity before the agent call.",
    "",
    "## Unrelated topic",
    "",
    "unrelated ".repeat(2000),
  ].join("\n");
  fs.writeFileSync(workspace.ensureWorkspacePaths(wsRoot).ssot, ssot, "utf8");
  fs.writeFileSync(workspace.ensureWorkspacePaths(wsRoot).syllabus, syllabus, "utf8");
  workspace.clearCache();

  sliced = contextModule.sliceContext({
    dir: wsRoot,
    input: "how does provider masking work?",
  });
  assert.ok(sliced.chars <= contextModule.DEFAULT_BUDGET.totalChars, "hard budget exceeded");
  assert.match(sliced.fingerprint, /^[a-f0-9]{16}$/);
  assert.ok(sliced.text.includes("Masking strips provider identity"));
  assert.ok(!sliced.text.includes("unrelated unrelated unrelated"), "unmatched bulk leaked");
  assert.ok(sliced.text.length < fs.statSync(workspace.ensureWorkspacePaths(wsRoot).ssot).size);
  assert.ok(sliced.sections.syllabus_total_sections >= 2);

  const docs = path.join(wsRoot, "docs");
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(
    path.join(docs, "provider-masking.md"),
    "# Provider masking\n\nnormalizer provider masking notes\n",
    "utf8",
  );
  const files = contextModule.findRelevantFiles(wsRoot, "provider masking normalizer", { limit: 3 });
  assert.ok(
    files.some((file) => file.path === path.join("docs", "provider-masking.md")),
    "targeted file search must find the matching doc",
  );
});

// ── 6. system prompt: persona + runtime + metadata, bounded ──
check("buildSystemPrompt injects persona, OS, workspace, metadata and stays bounded", () => {
  const prompt = buildSystemPrompt({
    agent: dbAgent,
    session,
    context: sliced ? sliced.text : "",
    toolsCount: 4,
    maxChars: 3000,
  });
  assert.ok(prompt.length <= 3000, "prompt budget exceeded: " + prompt.length);
  assert.ok(prompt.includes("DB persona wins for this agent."), "persona missing");
  assert.ok(prompt.includes(session.os.platform), "os.platform missing");
  assert.ok(prompt.includes(wsRoot), "workspace missing");
  assert.ok(prompt.includes("sess-1"), "session id missing");
  assert.ok(prompt.includes("SYSTEM IDENTITY"), "system identity missing");
  assert.ok(prompt.includes("4 tools are available"), "tool note missing");
});

if (failures.length > 0) {
  console.error("\nMODULES_FOUNDATION_FAILED (" + failures.length + ")");
  process.exit(1);
}

console.log("\nMODULES_FOUNDATION_OK");
