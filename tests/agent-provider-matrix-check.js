#!/usr/bin/env node
"use strict";

/*
 * Agent -> provider matrix acceptance test.
 *
 * Real inputs, no mocks:
 *   - live gateway http://localhost:5050
 *   - live agents table (data/models.db; GET /api/agents masks names)
 *   - live model catalogue (GET /api/v1/models)
 *   - a throw-away directory under /tmp/opencode with one vault file
 *
 * For every agent the test:
 *   1. checks the live agents row names the expected model
 *   2. checks the live catalogue serves that model from the expected provider
 *   3. streams an OpenAI chat request with list_directory + read_file tools
 *   4. executes the emitted tool calls CLIENT-SIDE against the throw-away dir
 *   5. replays the tool results and requires the final answer to contain the
 *      access code that only exists inside the vault file
 *
 * A pass therefore proves the agent used a real tool result, not that it
 * guessed the answer.
 */

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.BASE_URL || "http://localhost:5050";
const TMP = process.env.TEST_DIR || path.join("/tmp/opencode", "agent-provider-matrix-" + process.pid);
const ACCESS_CODE = "ZOMBIE-7421";
const ROUND_TIMEOUT_MS = 75000;
const MAX_ROUNDS = 5;
const MAX_ATTEMPTS = 3;
// A retry that fires immediately just burns more of Groq's 60s TPM window.
// Back off long enough for the window to move before the next attempt.
const RETRY_DELAY_MS = 8000;

// The matrix is intentionally explicit: an acceptance test should fail when
// the mapping drifts, not silently follow whatever the DB happens to contain.
const EXPECTED = [
  { id: "security-hero", model: "qwen3-1.7b-abliterated", provider: "llama-uds" },
  { id: "perf-wizard", model: "qwen3:0.6b", provider: "ollama" },
  { id: "doc-king", model: "gpt-oss:20b", provider: "ollama_cloud" },
  { id: "qa-tyrant", model: "openai/gpt-oss-20b", provider: "groq" },
  { id: "team-heart", model: "gpt-oss:20b", provider: "ollama_cloud" },
  { id: "customer-experience-specialist", model: "gemini-2.5-flash", provider: "gemini" },
  { id: "ecommerce-operations-analyst", model: "gpt-oss:120b", provider: "ollama_cloud" },
  { id: "bug-hunter", model: "openai/gpt-oss-120b", provider: "groq" },
  { id: "code-guru", model: "gpt-oss:120b", provider: "ollama_cloud" },
];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List file and folder names in a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path." } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute file path." } },
        required: ["path"],
      },
    },
  },
];

function pass(name, detail) {
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

async function getJson(pathname, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(BASE + pathname, { signal: ctrl.signal });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// /api/agents masks model names for public display (llama-uds-check). The
// runtime source of truth is the agents table, so read the raw model there.
function readLiveAgentModels() {
  const dbPath = path.join(ROOT, "data", "models.db");
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id, model FROM agents").all();
    return new Map(rows.map((row) => [row.id, row.model]));
  } finally {
    db.close();
  }
}

async function streamChat(body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ROUND_TIMEOUT_MS);
  const out = { content: "", calls: [], finish: null, swap: null, status: 0, error: "" };
  try {
    const r = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Id": body.model },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    out.status = r.status;
    if (!r.ok) {
      out.error = (await r.text()).slice(0, 300);
      return out;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let j;
        try { j = JSON.parse(payload); } catch (_) { continue; }
        if (j.error) { out.error = JSON.stringify(j.error).slice(0, 300); continue; }
        if (j.swap_notice) out.swap = j.swap_notice;
        const choice = j.choices && j.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content) out.content += delta.content;
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = typeof tc.index === "number" ? tc.index : out.calls.length;
            const slot = out.calls[i] || (out.calls[i] = { id: "", type: "function", function: { name: "", arguments: "" } });
            if (tc.id) slot.id = tc.id;
            if (tc.type) slot.type = tc.type;
            if (tc.function) {
              if (tc.function.name) slot.function.name += tc.function.name;
              if (typeof tc.function.arguments === "string") slot.function.arguments += tc.function.arguments;
            }
            for (const k of Object.keys(tc)) {
              if (k === "index" || k === "id" || k === "type" || k === "function") continue;
              slot[k] = tc[k];
            }
          }
        }
        if (choice.finish_reason) out.finish = choice.finish_reason;
      }
    }
    out.calls = out.calls.filter(Boolean);
    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  } finally {
    clearTimeout(timer);
  }
}

function resolveInside(requested) {
  const root = path.resolve(TMP);
  const resolved = path.resolve(root, requested || ".");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes the test directory: " + requested);
  }
  return resolved;
}

function executeTool(name, args) {
  try {
    const target = resolveInside(args.path || ".");
    if (name === "list_directory") {
      if (!fs.statSync(target).isDirectory()) return { ok: false, result: "not a directory: " + target };
      return { ok: true, result: JSON.stringify(fs.readdirSync(target)) };
    }
    if (name === "read_file") {
      return { ok: true, result: fs.readFileSync(target, "utf8").slice(0, 4000) };
    }
    return { ok: false, result: "unknown tool: " + name };
  } catch (e) {
    return { ok: false, result: e.message };
  }
}

async function attemptAgent(expected, attempt) {
  const user = {
    role: "user",
    content:
      "This is a tool-call acceptance test. The test directory is " + TMP + ". " +
      "1) Call list_directory with path \"" + TMP + "\". " +
      "2) Call read_file with path \"" + TMP + "/vault.txt\". " +
      "Do not answer from memory. After the tool results arrive, reply with the exact access code from vault.txt." +
      (attempt > 1
        ? " Your previous reply failed the test because it did not call a tool. You must call the provided tools now."
        : ""),
  };
  const messages = [user];
  let toolCalls = 0;
  let readCode = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const res = await streamChat({
      model: expected.id,
      stream: true,
      temperature: 0,
      max_tokens: 300,
      tools: TOOLS,
      messages,
      // The gateway reuses one session per anonymous client and replays its
      // memory. A unique id per attempt and round keeps this acceptance test
      // isolated instead of letting an old answer steer the model.
      session_id: "matrix-" + process.pid + "-" + expected.id + "-a" + attempt + "-r" + round,
    });
    if (res.status !== 200) return { ok: false, retryable: true, reason: "HTTP " + res.status + " " + res.error };
    if (res.swap) return { ok: false, retryable: true, reason: "provider swap: " + JSON.stringify(res.swap) };
    if (res.error) return { ok: false, retryable: true, reason: "stream error: " + res.error };

    if (!res.calls.length) {
      const answered = String(res.content).includes(ACCESS_CODE);
      if (answered && readCode) return { ok: true, rounds: round, toolCalls };
      return {
        ok: false,
        retryable: true,
        reason: answered
          ? "answered without reading the vault through a tool"
          : "no tool call (finish=" + res.finish + ", content=" + String(res.content).slice(0, 120) + ")",
      };
    }

    for (const tc of res.calls) {
      if (!tc.id || !tc.function || !tc.function.name || typeof tc.function.arguments !== "string") {
        return { ok: false, retryable: true, reason: "malformed tool call: " + JSON.stringify(tc).slice(0, 160) };
      }
    }

    const assistant = {
      role: "assistant",
      content: res.content || null,
      tool_calls: res.calls.map((tc) => {
        const call = { ...tc, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } };
        delete call.index;
        return call;
      }),
    };
    messages.push(assistant);

    for (const tc of res.calls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) { args = {}; }
      const out = executeTool(tc.function.name, args);
      toolCalls++;
      if (tc.function.name === "read_file" && out.ok && String(out.result).includes(ACCESS_CODE)) {
        readCode = true;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(out.result) });
    }
  }

  return {
    ok: false,
    retryable: true,
    reason: "no final answer after " + MAX_ROUNDS + " rounds",
    rounds: MAX_ROUNDS,
    toolCalls,
  };
}

async function runAgent(expected) {
  let last = { ok: false, retryable: true, reason: "not attempted" };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
    last = await attemptAgent(expected, attempt);
    if (last.ok) return last;
    if (!last.retryable) return last;
  }
  return last;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(path.join(TMP, "vault.txt"), "ACCESS_CODE=" + ACCESS_CODE + "\n");
  fs.writeFileSync(path.join(TMP, "notes.txt"), "This directory exists only for the agent tool-call test.\n");

  const failures = [];
  const agentsRes = await getJson("/api/agents");
  if (agentsRes.status !== 200 || !agentsRes.json || !Array.isArray(agentsRes.json.agents)) {
    console.log("FAIL live agents endpoint — HTTP " + agentsRes.status);
    console.log("RESULT: AGENT PROVIDER MATRIX FAIL");
    process.exit(1);
  }
  const liveAgents = readLiveAgentModels();
  if (!liveAgents || liveAgents.size === 0) {
    console.log("FAIL live agents table — data/models.db has no agents rows");
    console.log("RESULT: AGENT PROVIDER MATRIX FAIL");
    process.exit(1);
  }

  const modelsRes = await getJson("/api/v1/models", 20000);
  const modelList = (modelsRes.json && (modelsRes.json.data || modelsRes.json.models)) || [];
  if (modelsRes.status !== 200 || !Array.isArray(modelList) || modelList.length === 0) {
    console.log("FAIL live model catalogue — HTTP " + modelsRes.status);
    console.log("RESULT: AGENT PROVIDER MATRIX FAIL");
    process.exit(1);
  }

  // ── mapping: DB rows and live catalogue agree ─────────────────────
  for (const expected of EXPECTED) {
    const liveModel = liveAgents.get(expected.id);
    if (liveModel !== expected.model) {
      failures.push(expected.id + " model=" + (liveModel || "(missing)") + " expected=" + expected.model);
      fail("mapping " + expected.id, "live model=" + (liveModel || "(missing)") + " expected=" + expected.model);
      continue;
    }
    const served = modelList.some((m) => m.id === expected.model && m.provider === expected.provider);
    if (!served) {
      failures.push(expected.id + " provider=" + expected.provider + " missing from catalogue");
      fail("catalogue " + expected.id, expected.model + " is not served by " + expected.provider);
      continue;
    }
    pass("mapping " + expected.id, expected.model + " via " + expected.provider);
  }

  // ── real tool calls, providers in parallel, one agent per provider ──
  // Groq's free tier enforces an 8000 TPM window per model. Firing
  // bug-hunter and code-guru (same model) together makes the second one
  // return 429 and an empty stream, so agents inside one provider run in
  // order while different providers still overlap.
  const byProvider = new Map();
  for (const expected of EXPECTED) {
    if (!byProvider.has(expected.provider)) byProvider.set(expected.provider, []);
    byProvider.get(expected.provider).push(expected);
  }
  const grouped = await Promise.all(
    [...byProvider.values()].map(async (group) => {
      const out = [];
      for (const expected of group) {
        out.push({ expected, result: await runAgent(expected) });
      }
      return out;
    }),
  );
  const results = grouped.flat();

  let toolcalls = 0;
  for (const { expected, result } of results) {
    if (result.ok) {
      toolcalls++;
      pass("toolcall " + expected.id, "tools=" + result.toolCalls + " rounds=" + result.rounds + " code=ok");
    } else {
      failures.push(expected.id + " toolcall: " + result.reason);
      fail("toolcall " + expected.id, result.reason);
    }
  }

  // ── docs must carry the same matrix ──────────────────────────────
  let docsOk = true;
  const matrixDoc = path.join(ROOT, "docs", "AGENT-PROVIDER-MATRIX.md");
  if (!fs.existsSync(matrixDoc)) {
    docsOk = false;
    fail("docs", "docs/AGENT-PROVIDER-MATRIX.md is missing");
  } else {
    const doc = fs.readFileSync(matrixDoc, "utf8");
    for (const expected of EXPECTED) {
      if (!doc.includes(expected.id) || !doc.includes(expected.model) || !doc.includes(expected.provider)) {
        docsOk = false;
        fail("docs row " + expected.id, "matrix doc does not contain id/model/provider");
      }
    }
    if (!doc.includes("tests/agent-provider-matrix-check.js")) {
      docsOk = false;
      fail("docs command", "matrix doc does not name the check command");
    }
  }
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  if (!readme.includes("docs/AGENT-PROVIDER-MATRIX.md")) {
    docsOk = false;
    fail("docs README", "README.md does not link the matrix doc");
  }
  const spec = fs.readFileSync(path.join(ROOT, "docs", "EDGE-RUNTIME-SPEC.md"), "utf8");
  if (!spec.includes("AGENT-PROVIDER-MATRIX.md")) {
    docsOk = false;
    fail("docs EDGE-RUNTIME-SPEC", "spec does not reference the matrix doc");
  }
  if (docsOk) pass("docs", "matrix doc, README and spec agree on 9 agents / 5 providers");

  const providers = new Set(EXPECTED.map((e) => e.provider));
  console.log("");
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  if (failures.length === 0 && toolcalls === EXPECTED.length && docsOk) {
    console.log("RESULT: AGENT PROVIDER MATRIX PASS agents=" + EXPECTED.length + " providers=" + providers.size + " toolcalls=" + toolcalls + " docs=ok");
    process.exit(0);
  }
  console.log("RESULT: AGENT PROVIDER MATRIX FAIL agents=" + EXPECTED.length + " providers=" + providers.size + " toolcalls=" + toolcalls + " docs=" + (docsOk ? "ok" : "fail") + " failures=" + failures.length);
  process.exit(1);
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.stack ? e.stack : e));
  console.log("RESULT: AGENT PROVIDER MATRIX FAIL");
  process.exit(1);
});
