#!/usr/bin/env node
"use strict";

/**
 * tests/agent-provider-ssot-check.js
 *
 * Release gate for two SSOT rules:
 *
 *   AGENTS
 *   1. The nine agent personas live in the SQLite `agents` table.
 *   2. A non-empty DB persona wins; agent/*.js is only a fallback when the
 *      DB persona is empty or the row is missing.
 *   3. A disabled DB agent stays disabled instead of being resurrected from
 *      agent/*.js.
 *   4. Custom `.zombiecoder/agents/*.md` files may add agents, never replace
 *      a DB persona.
 *   5. The boot repair writes the full agent/*.js persona when the DB row is
 *      the known corrupt shape (persona === expertise) and leaves model,
 *      priority and enabled untouched.
 *
 *   PROVIDERS
 *   6. Built-in provider base URLs live in provider/defaults.js only.
 *   7. Host-only official URLs are completed to their documented versioned
 *      path; Ollama defaults to 11434, never the stale 5051 fallback.
 *   8. provider/index.js can resolve the bridge without api.js.
 *   9. The system prompt sends a workspace label, not an absolute host path.
 *  10. No undocumented local/marker egress header is added by our code.
 *
 * Prints AGENT_PROVIDER_SSOT_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const LIVE_DB = path.join(ROOT, "data", "models.db");
const AGENT_MODULE = path.join(ROOT, "modules", "agents.js");
const PROMPT_MODULE = path.join(ROOT, "modules", "system-prompt.js");
const DEFAULTS_MODULE = path.join(ROOT, "provider", "defaults.js");
const ENV_MODULE = path.join(ROOT, "lib", "env.js");

const GROQ_URL = "https://api.groq.com/openai/v1";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENCODE_URL = "https://opencode.ai/zen/v1";
const OLLAMA_CLOUD_URL = "https://ollama.com";

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failed++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

function run(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function makeDb(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      model TEXT,
      expertise TEXT,
      persona TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 99,
      updated_at INTEGER DEFAULT 0
    );
    CREATE INDEX idx_agents_enabled ON agents(enabled);
  `);
  const insert = db.prepare(`
    INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.name || row.id,
      row.role || "general",
      row.model || "",
      row.expertise || "",
      row.persona == null ? "" : row.persona,
      row.enabled == null ? 1 : row.enabled,
      row.priority == null ? 99 : row.priority,
      row.updated_at || 0,
    );
  }
  return db;
}

function longText(label, repeats) {
  return (label + " ").repeat(repeats || 40).trim();
}

const FILE_AGENTS = [
  {
    id: "code-guru",
    name: "File Code Guru",
    role: "architecture",
    model: "file-model",
    expertise: "file expertise",
    priority: 1,
    enabled: 1,
    persona: longText("FILE CODE GURU PERSONA", 40),
  },
  {
    id: "disabled-agent",
    name: "File Disabled Agent",
    role: "general",
    model: "file-model",
    expertise: "file expertise",
    priority: 2,
    enabled: 1,
    persona: longText("FILE DISABLED PERSONA", 30),
  },
  {
    id: "empty-persona",
    name: "File Empty Persona",
    role: "general",
    model: "file-model",
    expertise: "file expertise",
    priority: 3,
    enabled: 1,
    persona: "FILE FALLBACK PERSONA FOR EMPTY DB ROW",
  },
  {
    id: "db-only",
    name: "DB Only Agent",
    role: "general",
    model: "db-model",
    expertise: "db expertise",
    priority: 4,
    enabled: 1,
    persona: "",
  },
];

function fileLoader(id) {
  return FILE_AGENTS.find((agent) => agent.id === id) || null;
}

function stripComments(source) {
  const lines = String(source).split("\n");
  const out = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    out.push(line.replace(/(^|[^:])\/\/.*$/, "$1"));
  }
  return out.join("\n");
}

function countInCode(relativePath, needle) {
  const file = path.join(ROOT, relativePath);
  if (!fs.existsSync(file)) return -1;
  const code = stripComments(fs.readFileSync(file, "utf8"));
  let count = 0;
  let index = 0;
  while ((index = code.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

// ─── 1. Live DB persona integrity ─────────────────────────────────────
run("live DB: nine enabled agents carry full personas, not expertise text", () => {
  assert.ok(fs.existsSync(LIVE_DB), "data/models.db is missing");
  const db = new DatabaseSync(LIVE_DB, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, persona, expertise, enabled FROM agents ORDER BY priority").all();
    const enabled = rows.filter((row) => Number(row.enabled) === 1);
    assert.strictEqual(enabled.length, 9, "expected 9 enabled agents, got " + enabled.length);
    const bad = enabled.filter((row) => {
      const persona = String(row.persona || "").trim();
      const expertise = String(row.expertise || "").trim();
      return !persona || persona === expertise || persona.length < 200;
    });
    assert.deepStrictEqual(
      bad.map((row) => row.id + ":" + String(row.persona || "").trim().length),
      [],
      "persona rows still corrupted",
    );
    const ids = new Set(enabled.map((row) => row.id));
    for (const id of [
      "code-guru",
      "bug-hunter",
      "security-hero",
      "perf-wizard",
      "doc-king",
      "qa-tyrant",
      "team-heart",
      "customer-experience-specialist",
      "ecommerce-operations-analyst",
    ]) {
      assert.ok(ids.has(id), "missing agent row: " + id);
    }
  } finally {
    db.close();
  }
});

// ─── 2. loadAgents is DB-first ────────────────────────────────────────
run("loadAgents: DB persona wins, empty DB persona falls back, disabled stays disabled", () => {
  const agents = require(AGENT_MODULE);
  const db = makeDb([
    {
      id: "code-guru",
      persona: longText("DB CODE GURU PERSONA", 12),
      expertise: "db expertise",
      model: "db-model",
      priority: 1,
      enabled: 1,
    },
    {
      id: "disabled-agent",
      persona: longText("DB DISABLED PERSONA", 12),
      expertise: "db expertise",
      model: "db-model",
      priority: 2,
      enabled: 0,
    },
    {
      id: "empty-persona",
      persona: "",
      expertise: "db expertise",
      model: "db-model",
      priority: 3,
      enabled: 1,
    },
  ]);
  try {
    const merged = agents.loadAgents({ db, fileAgents: FILE_AGENTS, log: () => {} });
    const byId = new Map(merged.map((agent) => [agent.id, agent]));

    const guru = byId.get("code-guru");
    assert.ok(guru, "code-guru missing from merged list");
    assert.strictEqual(guru.source, "db", "code-guru must come from the DB");
    assert.strictEqual(guru.persona_source, "db", "DB persona must not be replaced by the file");
    assert.strictEqual(guru.persona, longText("DB CODE GURU PERSONA", 12));

    assert.ok(!byId.has("disabled-agent"), "disabled DB agent was resurrected from agent/*.js");

    const empty = byId.get("empty-persona");
    assert.ok(empty, "empty-persona missing from merged list");
    assert.strictEqual(empty.source, "db", "empty-persona row must still be the DB row");
    assert.strictEqual(empty.persona_source, "agent/*.js", "empty DB persona must use the file fallback");
    assert.strictEqual(empty.persona, "FILE FALLBACK PERSONA FOR EMPTY DB ROW");
  } finally {
    db.close();
  }
});

// ─── 3. resolveAgent honours disabled rows ────────────────────────────
run("resolveAgent: DB persona wins and a disabled row is a hard stop", () => {
  const agents = require(AGENT_MODULE);
  const db = makeDb([
    {
      id: "code-guru",
      persona: longText("RESOLVED DB PERSONA", 12),
      expertise: "db expertise",
      model: "db-model",
      priority: 1,
      enabled: 1,
    },
    {
      id: "disabled-agent",
      persona: longText("DISABLED DB PERSONA", 12),
      expertise: "db expertise",
      model: "db-model",
      priority: 2,
      enabled: 0,
    },
  ]);
  try {
    const resolved = agents.resolveAgent("code-guru", { db, fileLoader });
    assert.strictEqual(resolved.source, "db");
    assert.strictEqual(resolved.persona, longText("RESOLVED DB PERSONA", 12));

    assert.throws(
      () => agents.resolveAgent("disabled-agent", { db, fileLoader }),
      (error) => error && error.code === "ZC_AGENT_DISABLED",
    );

    assert.throws(
      () => agents.resolveAgent("no-such-agent", { db, fileLoader }),
      (error) => error && error.code === "ZC_AGENT_NOT_FOUND",
    );
  } finally {
    db.close();
  }
});

// ─── 4. Custom files may add, never replace ───────────────────────────
run("custom agent markdown does not replace a DB persona", () => {
  const agents = require(AGENT_MODULE);
  const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-custom-agents-"));
  fs.writeFileSync(path.join(customDir, "code-guru.md"), "# override\n");
  const db = makeDb([
    {
      id: "code-guru",
      persona: longText("CUSTOM TEST DB PERSONA", 12),
      expertise: "db expertise",
      model: "db-model",
      priority: 1,
      enabled: 1,
    },
  ]);
  try {
    const merged = agents.loadAgents({
      db,
      fileAgents: FILE_AGENTS,
      customDir,
      parseCustom: () => ({ id: "code-guru", name: "Custom", role: "general", persona: "CUSTOM OVERRIDE" }),
      log: () => {},
    });
    const guru = merged.find((agent) => agent.id === "code-guru");
    assert.ok(guru, "code-guru missing");
    assert.strictEqual(guru.persona, longText("CUSTOM TEST DB PERSONA", 12));
    assert.strictEqual(guru.persona_source, "db");
  } finally {
    db.close();
    fs.rmSync(customDir, { recursive: true, force: true });
  }
});

// ─── 5. Boot repair for the known corrupt shape ───────────────────────
run("syncAgentPersonas repairs persona===expertise and preserves model/priority", () => {
  const agents = require(AGENT_MODULE);
  assert.strictEqual(typeof agents.syncAgentPersonas, "function", "syncAgentPersonas is not exported");
  const db = makeDb([
    {
      id: "code-guru",
      persona: "corrupt expertise text",
      expertise: "corrupt expertise text",
      model: "keep-this-model",
      priority: 7,
      enabled: 1,
    },
  ]);
  try {
    const fileAgent = FILE_AGENTS.find((agent) => agent.id === "code-guru");
    const result = agents.syncAgentPersonas(db, [fileAgent], { log: () => {} });
    assert.strictEqual(result.repaired, 1, "expected one repaired row");
    const row = db.prepare("SELECT persona, model, priority, enabled FROM agents WHERE id = ?").get("code-guru");
    assert.strictEqual(row.persona, fileAgent.persona);
    assert.strictEqual(row.model, "keep-this-model");
    assert.strictEqual(Number(row.priority), 7);
    assert.strictEqual(Number(row.enabled), 1);
  } finally {
    db.close();
  }
});

// ─── 6. Provider defaults: one module, documented paths ───────────────
function loadDefaults() {
  delete require.cache[require.resolve(DEFAULTS_MODULE)];
  return require(DEFAULTS_MODULE);
}

run("provider defaults: official URLs are complete and bridge resolves", () => {
  assert.ok(fs.existsSync(DEFAULTS_MODULE), "provider/defaults.js is missing");
  const defaults = loadDefaults();
  assert.strictEqual(typeof defaults.resolveBaseUrl, "function", "resolveBaseUrl is not exported");
  assert.strictEqual(
    defaults.resolveBaseUrl("groq", "", { env: {} }),
    GROQ_URL,
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("groq", "https://api.groq.com", { env: {} }),
    GROQ_URL,
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("gemini", "", { env: {} }),
    GEMINI_URL,
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("gemini", "https://generativelanguage.googleapis.com", { env: {} }),
    GEMINI_URL,
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("opencode", "", { env: {} }),
    OPENCODE_URL,
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("ollama", "", { env: {} }),
    "http://localhost:11434/v1",
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("ollama", "http://127.0.0.1:11434", { env: {}, dialect: "openai" }),
    "http://127.0.0.1:11434/v1",
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("ollama", "http://127.0.0.1:11434", { env: {}, dialect: "" }),
    "http://127.0.0.1:11434",
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("bridge", "", { env: { BRIDGE_PORT: "11435" } }),
    "http://localhost:11435/v1",
  );
  assert.strictEqual(
    defaults.resolveBaseUrl("bridge", "https://bridge.example/v1", { env: {} }),
    "https://bridge.example/v1",
  );
});

// ─── 7. One source for built-in URLs, no stale 5051 ───────────────────
run("built-in provider URLs are defined once and the 5051 fallback is gone", () => {
  const files = [
    "api.js",
    "provider/index.js",
    "provider/groq.js",
    "provider/gemini.js",
    "provider/opencode.js",
  ];
  for (const file of files) {
    assert.strictEqual(countInCode(file, GROQ_URL), 0, GROQ_URL + " is duplicated in " + file);
    assert.strictEqual(countInCode(file, GEMINI_URL), 0, GEMINI_URL + " is duplicated in " + file);
    assert.strictEqual(countInCode(file, OPENCODE_URL), 0, OPENCODE_URL + " is duplicated in " + file);
    assert.strictEqual(countInCode(file, OLLAMA_CLOUD_URL), 0, OLLAMA_CLOUD_URL + " is duplicated in " + file);
  }
  assert.strictEqual(countInCode("api.js", "5051"), 0, "stale Ollama port 5051 is still in api.js");
  assert.ok(countInCode("provider/defaults.js", GROQ_URL) >= 1, "defaults.js must own the Groq URL");
  assert.ok(countInCode("provider/defaults.js", GEMINI_URL) >= 1, "defaults.js must own the Gemini URL");
  assert.ok(countInCode("provider/defaults.js", OLLAMA_CLOUD_URL) >= 1, "defaults.js must own the Ollama Cloud URL");
});

// ─── 8. provider/index.js can resolve the bridge alone ────────────────
run("provider/index.js resolves bridge and Ollama without api.js", () => {
  const registry = require(path.join(ROOT, "provider", "index.js"));
  const bridge = registry.configForId("bridge");
  assert.ok(bridge && bridge.baseUrl, "bridge config has no baseUrl");
  assert.ok(/11435/.test(bridge.baseUrl), "bridge baseUrl must use the documented 11435 port: " + bridge.baseUrl);
  const ollama = registry.configForId("ollama");
  assert.ok(ollama && ollama.baseUrl, "ollama config has no baseUrl");
  assert.ok(/11434/.test(ollama.baseUrl), "ollama default must use 11434: " + ollama.baseUrl);
  assert.ok(!/5051/.test(ollama.baseUrl), "ollama must not use stale port 5051");
});

// ─── 9. Prompt must not leak the absolute workspace path ──────────────
run("system prompt sends a workspace label, not an absolute host path", () => {
  const { buildSystemPrompt } = require(PROMPT_MODULE);
  const persona = longText("PROMPT PERSONA", 40);
  const prompt = buildSystemPrompt({
    agent: { id: "code-guru", name: "Code Guru", role: "architecture", persona },
    session: {
      persona,
      workspace: "/home/example/secret-project",
      system_identity: { name: "ZombieCoder", type: "development", domain: "localhost" },
      os: {
        os: "Linux",
        platform: "linux",
        kernel: "6.0.0",
        arch: "x64",
        hostname: "internal-host",
        node: process.version,
        pid: 4242,
        cpu: { model: "test-cpu", cores: 4 },
        memory: { total_gb: 8, free_gb: 4, used_percent: 50 },
        load: [0.1, 0.1, 0.1],
      },
      metadata: { session_id: "ssot-check" },
    },
    compact: true,
    maxChars: 6000,
  });
  assert.ok(!prompt.includes("/home/example"), "absolute workspace path leaked into the prompt");
  assert.ok(!prompt.includes("internal-host"), "hostname leaked into the compact prompt");
  assert.ok(prompt.includes("workspace: secret-project"), "workspace label missing from the prompt");
});

// ─── 10. Bridge ports and browser paths stay portable ────────────────
run("bridge defaults come from lib/env and cdp has no host-pinned path", () => {
  const env = require(ENV_MODULE);
  assert.strictEqual(env.DEFAULTS.BRIDGE_PORT, "11435");
  assert.strictEqual(env.DEFAULTS.BRIDGE_INTERNAL_PORT, "11437");

  const bridge = stripComments(fs.readFileSync(path.join(ROOT, "local-llm-bridge.js"), "utf8"));
  assert.ok(
    bridge.includes("DEFAULTS.BRIDGE_PORT") &&
      bridge.includes("DEFAULTS.BRIDGE_INTERNAL_PORT"),
    "local-llm-bridge.js must read bridge defaults from lib/env",
  );
  assert.ok(
    !/\|\|\s*"1143[47]"/.test(bridge),
    "local-llm-bridge.js reintroduced a literal bridge port default",
  );

  const cdp = stripComments(fs.readFileSync(path.join(ROOT, "cdp-pipe.js"), "utf8"));
  assert.ok(!cdp.includes("/opt/google/chrome/chrome"), "cdp-pipe.js pins a distro Chrome path");
  assert.ok(!cdp.includes("/tmp/opencode"), "cdp-pipe.js pins a host tmp path");
  assert.ok(cdp.includes("os.tmpdir()"), "cdp-pipe.js must use os.tmpdir()");
});

// ─── 11. No undocumented local/marker egress headers ──────────────────
run("custom egress headers are provider-native and explicitly allowlisted", () => {
  const files = [
    "provider/openai.js",
    "provider/groq.js",
    "provider/gemini.js",
    "provider/ollama.js",
    "provider/opencode.js",
    "provider/llamacpp.js",
  ];
  // These are provider-owned headers, not internal ZombieCoder markers:
  // Gemini auth and Groq's documented app title. Client identity is never
  // impersonated.
  const allowed = new Set([
    "x-goog-api-key",
    "x-title",
  ]);
  const found = new Set();
  for (const relative of files) {
    const file = path.join(ROOT, relative);
    if (!fs.existsSync(file)) continue;
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const match of code.matchAll(/["'](x-[a-z0-9-]+)["']/gi)) {
      const header = match[1].toLowerCase();
      if (!allowed.has(header)) found.add(relative + ":" + header);
    }
  }
  assert.deepStrictEqual(
    [...found],
    [],
    "undocumented egress header(s): " + [...found].join(", "),
  );
  const opencode = stripComments(
    fs.readFileSync(path.join(ROOT, "provider/opencode.js"), "utf8"),
  );
  assert.ok(
    !/x-opencode|opencode\/latest/.test(opencode),
    "provider/opencode.js must not impersonate the OpenCode CLI",
  );
});

console.log("\npassed=" + passed + " failed=" + failed);
if (failed > 0) {
  console.error("AGENT_PROVIDER_SSOT_FAILED");
  process.exit(1);
}
console.log("AGENT_PROVIDER_SSOT_OK");
