#!/usr/bin/env node
"use strict";

/**
 * bind-llama-cpp.js - register a live llama.cpp OpenAI endpoint as provider
 * custom_5 and point every agent row at the model it serves.
 *
 * The probe is real: /v1/models must answer before a single file is written.
 * If the endpoint is unreachable the script exits 2 and changes nothing.
 *
 *   node scripts/bind-llama-cpp.js                 # probe, write .env + DB
 *   node scripts/bind-llama-cpp.js --probe         # probe only, no writes
 *   node scripts/bind-llama-cpp.js --chat          # also prove one completion
 *   node scripts/bind-llama-cpp.js --model NAME    # override model selection
 *   node scripts/bind-llama-cpp.js --url URL       # override endpoint
 *   node scripts/bind-llama-cpp.js --db PATH       # override sqlite path
 *   node scripts/bind-llama-cpp.js --force         # replace a conflicting custom_5
 *
 * Secrets are never printed. The endpoint is loopback by default.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const PROVIDER_NUM = "5";
const PROVIDER_KEY = "CUSTOM_PROVIDER_" + PROVIDER_NUM;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : "";
}
function hasFlag(flag) {
  return process.argv.includes(flag);
}

function readEnvFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function envValue(text, key) {
  const match = text.match(new RegExp("^" + key + "=(.*)$", "m"));
  if (!match) return "";
  return match[1].replace(/^["']|["']$/g, "").trim();
}

function setEnvKey(text, key, value) {
  const line = key + "=" + value;
  const re = new RegExp("^" + key + "=.*$", "m");
  if (re.test(text)) return text.replace(re, line);
  const base = text.endsWith("\n") || text === "" ? text : text + "\n";
  return base + line + "\n";
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function getJson(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs || 4000),
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + url);
  return response.json();
}

async function probeModels(baseUrl) {
  const data = await getJson(stripTrailingSlash(baseUrl) + "/models");
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  const ids = list.map((m) => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
  return ids;
}

async function proveChat(baseUrl, model) {
  const response = await fetch(stripTrailingSlash(baseUrl) + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120000),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: PONG" }],
      max_tokens: 200,
      stream: false,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("chat HTTP " + response.status);
  const json = JSON.parse(text);
  const message = json.choices && json.choices[0] && json.choices[0].message;
  const content = String((message && message.content) || "").trim();
  if (!content) throw new Error("chat returned empty content");
  return content;
}

function chooseModel(ids, requested, previous) {
  if (requested) {
    if (!ids.includes(requested)) {
      throw new Error("requested model " + requested + " is not advertised by the endpoint");
    }
    return requested;
  }
  if (previous && ids.includes(previous)) return previous;
  const usable = ids.filter((id) => !/embed|rerank/i.test(id));
  if (usable.length === 0) throw new Error("endpoint advertises no chat model");
  return usable[0];
}

function writeEnv(updates, force) {
  let text = readEnvFile(ENV_FILE);
  const currentUrl = envValue(text, PROVIDER_KEY + "_URL");
  const currentName = envValue(text, PROVIDER_KEY + "_NAME");
  if (!force && currentUrl && currentUrl !== updates[PROVIDER_KEY + "_URL"]) {
    throw new Error(
      PROVIDER_KEY + " already points at " + currentUrl + " (name=" + (currentName || "unset") + "). " +
      "Re-run with --force to replace it.",
    );
  }
  const before = text;
  for (const [key, value] of Object.entries(updates)) {
    text = setEnvKey(text, key, value);
  }
  if (text !== before) {
    const mode = fs.existsSync(ENV_FILE) ? fs.statSync(ENV_FILE).mode : 0o600;
    fs.writeFileSync(ENV_FILE, text, { mode });
  }
  return text !== before;
}

function bindDatabase(dbPath, model) {
  const { DatabaseSync } = require("node:sqlite");
  if (!fs.existsSync(dbPath)) {
    // A fresh clone has no database yet: the gateway creates and seeds it on
    // first boot. Deferring is not an error — install.sh binds again after
    // the stack starts, and a manual run can simply be repeated.
    return { ok: false, deferred: true, reason: "database not created yet: " + dbPath };
  }
  const db = new DatabaseSync(dbPath);
  try {
    const now = Date.now();
    const agents = db.prepare("SELECT id FROM agents ORDER BY priority, id").all();
    db.prepare("UPDATE agents SET model = ?, updated_at = ?").run(model, now);
    db.prepare(
      `INSERT INTO models (provider, name, api_model, provider_name, type, priority, updated_at, enabled, pinned, supports_tools, supports_stream)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1)
       ON CONFLICT(provider, name) DO UPDATE SET
         api_model = excluded.api_model,
         provider_name = excluded.provider_name,
         type = excluded.type,
         priority = excluded.priority,
         updated_at = excluded.updated_at,
         enabled = 1,
         pinned = 1,
         supports_tools = 1,
         supports_stream = 1`,
    ).run("custom_" + PROVIDER_NUM, model, model, "llama-cpp", "openai", 0, now);
    return { ok: true, agents: agents.map((a) => a.id), count: agents.length };
  } finally {
    db.close();
  }
}

async function main() {
  const url = stripTrailingSlash(argValue("--url") || process.env.LLAMA_CPP_URL || "http://127.0.0.1:9932/v1");
  const requestedModel = argValue("--model") || process.env.LLAMA_CPP_MODEL || "";
  const dbPath = path.resolve(
    ROOT,
    argValue("--db") || process.env.DB_SQLITE_PATH || path.join("data", "models.db"),
  );

  let ids;
  try {
    ids = await probeModels(url);
  } catch (err) {
    console.error("LLAMA_PROBE_FAIL url=" + url + " reason=" + err.message);
    console.error("Nothing written. Start llama.cpp with an OpenAI-compatible server, then retry.");
    process.exit(2);
  }
  if (ids.length === 0) {
    console.error("LLAMA_PROBE_FAIL url=" + url + " reason=no models advertised");
    process.exit(2);
  }

  const envText = readEnvFile(ENV_FILE);
  const model = chooseModel(ids, requestedModel, envValue(envText, PROVIDER_KEY + "_MODELS").split(",")[0].trim());
  console.log("LLAMA_PROBE_OK url=" + url + " models=" + ids.length + " chosen=" + model);

  if (hasFlag("--probe")) {
    console.log("PROBE_ONLY no files written");
    return;
  }

  if (hasFlag("--chat")) {
    const reply = await proveChat(url, model);
    console.log("LLAMA_CHAT_OK reply=" + JSON.stringify(reply.slice(0, 80)));
  }

  const changed = writeEnv({
    [PROVIDER_KEY + "_NAME"]: "llama-cpp",
    [PROVIDER_KEY + "_URL"]: url,
    [PROVIDER_KEY + "_KEY"]: "",
    [PROVIDER_KEY + "_MODELS"]: model,
    [PROVIDER_KEY + "_TYPE"]: "openai",
    [PROVIDER_KEY + "_PRIORITY"]: "0",
    [PROVIDER_KEY + "_ENABLED"]: "true",
    // Local CPU prefill often needs more than the 60s cloud default.
    [PROVIDER_KEY + "_TIMEOUT_MS"]: "300000",
    [PROVIDER_KEY + "_STREAM_TIMEOUT_MS"]: "600000",
    // Keep the agent prompt inside what this model can prefill quickly.
    // Persona + rules stay; SSOT/syllabus prose and tool schemas do not.
    [PROVIDER_KEY + "_MAX_PROMPT_CHARS"]: "2500",
  }, hasFlag("--force"));
  console.log("ENV_" + (changed ? "UPDATED" : "UNCHANGED") + " provider=custom_" + PROVIDER_NUM);

  const db = bindDatabase(dbPath, model);
  if (!db.ok) {
    if (db.deferred) {
      console.log("DB_BIND_DEFERRED " + db.reason);
      console.log("NEXT start the gateway once (it creates and seeds the DB), then re-run this script.");
      return;
    }
    console.error("DB_BIND_SKIPPED " + db.reason);
    process.exit(1);
  }
  console.log("DB_BOUND agents=" + db.count + " model=" + model + " ids=" + db.agents.join(","));
  console.log("NEXT restart the gateway (systemctl --user restart zombiecoder-gateway.service) to refresh the in-memory AGENTS registry.");
}

main().catch((err) => {
  console.error("BIND_FAIL " + err.message);
  process.exit(1);
});
