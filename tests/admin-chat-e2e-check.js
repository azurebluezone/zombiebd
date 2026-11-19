#!/usr/bin/env node
"use strict";

/*
 * Step 2 acceptance — the admin panel is API-only, never a runtime
 * dependency, and its agent->model mapping drives a real provider call.
 *
 * Contract: gc-mwiay5jp — prints ADMIN_CHAT_E2E_OK only when every check
 * passes. No mocks: the live gateway, the real SQLite database, the real
 * Ollama provider and the actual files on disk are inspected.
 *
 * Steps:
 *   1. /admin serves the admin panel (not the chat UI)
 *   2. every route the panel fetches answers live JSON with the admin token
 *   3. every admin route refuses an unauthenticated caller
 *   4. with public/admin.html + dist/public/admin.html hidden the panel is
 *      gone (404) but /health, /api/agents and /api/admin/agents still work
 *   5. the panel carries no hardcoded agent-count fallback and its model
 *      saver sends no synthesized persona; index.html declares web-chat
 *   6. POST /api/admin/agents maps doc-king to deepseek-r1:1.5b: persona is
 *      preserved, a real chat request returns content with x-zc-chat-*
 *      headers and no swap_notice, and request_log/model_stats record the
 *      new model on provider ollama
 *   7. the original mapping and persona are restored
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { DatabaseSync } = require("node:sqlite");
const { loadEnv, readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const RAW_ENV = Object.assign(
  {},
  readEnvFile(path.join(ROOT, ".env")),
  process.env,
);
const PORT = ENV.ports.api || 5050;
const HOST = "127.0.0.1";
const TOKEN = RAW_ENV.ADMIN_TOKEN || RAW_ENV.ADMIN_API_KEY || "";
const DB_PATH = path.join(ROOT, "data", "models.db");
const ADMIN_SRC = path.join(ROOT, "public", "admin.html");
const ADMIN_DIST = path.join(ROOT, "dist", "public", "admin.html");
const INDEX_SRC = path.join(ROOT, "public", "index.html");
const AGENT_ID = "doc-king";
const NEW_MODEL = "deepseek-r1:1.5b";

function die(message) {
  console.error("FAIL " + message);
  process.exit(1);
}

function ok(message) {
  console.log("OK   " + message);
}

function request(method, pathname, body, headers) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: Object.assign(
          { accept: "application/json" },
          payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {},
          headers || {},
        ),
        timeout: pathname === "/v1/chat/completions" ? 180000 : 20000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (_) {
            parsed = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, body: null, text: error.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function adminHeaders() {
  return { "x-admin-token": TOKEN };
}

async function adminJson(pathname, expectedKey) {
  const res = await request("GET", pathname, undefined, adminHeaders());
  if (res.status !== 200 || !res.body || typeof res.body !== "object") {
    die("GET " + pathname + " failed: " + res.status + " " + res.text.slice(0, 200));
  }
  if (expectedKey && !(expectedKey in res.body)) {
    die("GET " + pathname + " missing key " + expectedKey);
  }
  return res.body;
}

function readAgentsFromDb(db) {
  return db
    .prepare("SELECT id, model, persona FROM agents WHERE id = ?")
    .get(AGENT_ID);
}

async function restoreAgent(db, original) {
  if (!original) return;
  await request("POST", "/api/admin/agents", { id: AGENT_ID, model: original.model }, adminHeaders());
  const current = readAgentsFromDb(db);
  if (!current || current.model !== original.model || current.persona !== original.persona) {
    console.error("WARN restore verification failed for " + AGENT_ID);
  }
}

async function main() {
  if (!TOKEN) die("ADMIN_TOKEN is not set");

  // ── 1. /admin is the panel, not the chat UI ────────────────
  const adminPage = await request("GET", "/admin");
  if (adminPage.status !== 200) die("/admin returned " + adminPage.status);
  if (!adminPage.text.includes('id="adminTokenInput"')) {
    die("/admin does not serve the admin panel (adminTokenInput missing)");
  }
  if (adminPage.text.includes("<title>Mission Barisal — Copilot Interface</title>")) {
    die("/admin is serving the chat UI, not the admin panel");
  }
  ok("/admin serves the admin panel");

  // ── 2. Every panel route answers live JSON ─────────────────
  const panelRoutes = [
    ["/health"],
    ["/identity", "system_identity"],
    ["/status"],
    ["/api/agents", "agents"],
    ["/api/config"],
    ["/api/transports"],
    ["/api/pusher-config"],
    ["/api/normalize-list", "models"],
    ["/api/admin/agents", "agents"],
    ["/api/admin/providers", "providers"],
    ["/api/admin/tools", "tools"],
    ["/api/admin/session-log"],
    ["/api/admin/stats"],
    ["/api/admin/agents-status"],
    ["/api/admin/ssot-status"],
    ["/api/admin/mcp-connections"],
    ["/api/admin/rate-limits"],
  ];
  for (const [pathname, key] of panelRoutes) {
    // Panel requests always carry the admin token; use it for every route so
    // the check exercises exactly the requests the panel makes.
    const res = await request("GET", pathname, undefined, adminHeaders());
    if (res.status !== 200 || !res.body || typeof res.body !== "object") {
      die("panel route " + pathname + " failed: " + res.status + " " + res.text.slice(0, 160));
    }
    if (key && !(key in res.body)) {
      die("panel route " + pathname + " missing " + key);
    }
  }
  const health = await request("GET", "/health", undefined, adminHeaders());
  if (health.body.healthy !== true) die("/health is not healthy");
  const agentsPayload = await request("GET", "/api/agents", undefined, adminHeaders());
  if (!Array.isArray(agentsPayload.body.agents) || agentsPayload.body.agents.length < 1) {
    die("/api/agents returned no agents");
  }
  ok("panel routes live: " + panelRoutes.length + " (health agents=" + health.body.agents + " models=" + health.body.models + ")");

  // ── 3. Admin routes are admin-only ─────────────────────────
  const guarded = [
    "/api/admin/agents",
    "/api/admin/providers",
    "/api/admin/tools",
    "/api/admin/session-log",
    "/api/admin/stats",
    "/api/admin/agents-status",
    "/api/admin/ssot-status",
    "/api/admin/mcp-connections",
    "/api/admin/rate-limits",
  ];
  for (const pathname of guarded) {
    const res = await request("GET", pathname);
    if (res.status !== 401) {
      die("unauthenticated " + pathname + " should be 401, got " + res.status);
    }
  }
  ok("admin routes refuse unauthenticated callers: " + guarded.length);

  // ── 4. Panel files are not a runtime dependency ────────────
  const hidden = [];
  try {
    for (const file of [ADMIN_SRC, ADMIN_DIST]) {
      if (!fs.existsSync(file)) die("missing panel file: " + file);
      const target = file + ".step2-hidden";
      fs.renameSync(file, target);
      hidden.push([file, target]);
    }
    const gone = await request("GET", "/admin");
    if (gone.status === 200) die("/admin still answers 200 with admin.html hidden");
    const liveHealth = await request("GET", "/health");
    const liveAgents = await request("GET", "/api/agents");
    const liveAdmin = await request("GET", "/api/admin/agents", undefined, adminHeaders());
    if (liveHealth.status !== 200 || liveHealth.body.healthy !== true) {
      die("/health broke without admin.html: " + liveHealth.status);
    }
    if (liveAgents.status !== 200 || !Array.isArray(liveAgents.body.agents)) {
      die("/api/agents broke without admin.html: " + liveAgents.status);
    }
    if (liveAdmin.status !== 200 || !Array.isArray(liveAdmin.body.agents)) {
      die("/api/admin/agents broke without admin.html: " + liveAdmin.status);
    }
    ok("admin.html hidden: /admin=" + gone.status + " while health/agents/admin-api stay 200");
  } finally {
    for (const [file, target] of hidden) {
      if (fs.existsSync(target)) fs.renameSync(target, file);
    }
  }
  if (!fs.existsSync(ADMIN_SRC) || !fs.existsSync(ADMIN_DIST)) {
    die("admin.html was not restored");
  }

  // ── 5. Source audit: no static fallback, no persona overwrite ──
  const adminHtml = fs.readFileSync(ADMIN_SRC, "utf8");
  if (/\?\s*6\s*:/.test(adminHtml)) die("admin.html still has a hardcoded ? 6 : fallback");
  if (/persona\s*:\s*persona\s*\|\|/.test(adminHtml)) {
    die("admin.html still synthesizes a persona when saving a model");
  }
  const indexHtml = fs.readFileSync(INDEX_SRC, "utf8");
  const channelCount = (indexHtml.match(/channel:\s*'web-chat'/g) || []).length;
  if (channelCount !== 2) {
    die("index.html should declare channel: 'web-chat' in both request bodies, found " + channelCount);
  }
  ok("source audit: no static agent fallback, no persona overwrite, index sends web-chat");

  // ── 6. Admin-driven mapping -> real provider call ──────────
  const db = new DatabaseSync(DB_PATH, { timeout: 5000 });
  const adminAgents = await adminJson("/api/admin/agents", "agents");
  const before = adminAgents.agents.find((agent) => agent.id === AGENT_ID);
  if (!before) die(AGENT_ID + " is missing from /api/admin/agents");
  if (!before.persona) die(AGENT_ID + " has no stored persona to protect");

  const mapping = await request(
    "POST",
    "/api/admin/agents",
    { id: AGENT_ID, model: NEW_MODEL },
    adminHeaders(),
  );
  if (mapping.status !== 200 || !mapping.body || mapping.body.ok !== true) {
    die("POST /api/admin/agents failed: " + mapping.status + " " + mapping.text.slice(0, 200));
  }

  const afterMap = await request("GET", "/api/admin/agents", undefined, adminHeaders());
  const mapped = (afterMap.body.agents || []).find((agent) => agent.id === AGENT_ID);
  if (!mapped || mapped.model !== NEW_MODEL) {
    die("admin mapping did not stick: " + JSON.stringify(mapped));
  }
  if (mapped.persona !== before.persona) {
    die("admin mapping overwrote the persona");
  }
  const dbMapped = readAgentsFromDb(db);
  if (!dbMapped || dbMapped.model !== NEW_MODEL || dbMapped.persona !== before.persona) {
    die("DB mapping drift: " + JSON.stringify(dbMapped));
  }
  ok("admin mapping applied: " + AGENT_ID + " -> " + NEW_MODEL + " (persona preserved)");

  try {
    // Header form on a cheap 404 proves x-zc-channel is honored.
    const headerProbe = await request(
      "POST",
      "/v1/chat/completions",
      {
        model: "agent/__step2_no_such_agent__",
        messages: [{ role: "user", content: "hello there" }],
        stream: false,
      },
      { "x-zc-channel": "web-chat" },
    );
    if (headerProbe.status !== 404) {
      die("header probe should be 404, got " + headerProbe.status);
    }
    if (headerProbe.headers["x-zc-chat-channel"] !== "web-chat") {
      die("x-zc-channel header was not honored (no x-zc-chat-channel)");
    }
    ok("x-zc-channel header reaches the chat interpreter");

    // The real call: doc-king now routes to deepseek-r1:1.5b on Ollama.
    const chat = await request("POST", "/v1/chat/completions", {
      channel: "web-chat",
      model: AGENT_ID,
      messages: [{ role: "user", content: "Answer in one short sentence: what is 2+2?" }],
      max_tokens: 256,
      temperature: 0,
      stream: false,
    });
    if (chat.status !== 200 || !chat.body) {
      die("real chat failed: " + chat.status + " " + chat.text.slice(0, 300));
    }
    const choice = (chat.body.choices || [])[0];
    const content = choice && choice.message ? String(choice.message.content || "") : "";
    if (!content.trim()) die("real chat returned empty content");
    if (chat.body.swap_notice) die("real chat silently swapped models: " + JSON.stringify(chat.body.swap_notice));
    if (!chat.body.agent || chat.body.agent.id !== AGENT_ID) {
      die("real chat did not run as " + AGENT_ID + ": " + JSON.stringify(chat.body.agent));
    }
    if (chat.headers["x-zc-chat-channel"] !== "web-chat") die("response missing x-zc-chat-channel");
    if (!chat.headers["x-zc-chat-intent"]) die("response missing x-zc-chat-intent");
    if (!("x-zc-chat-tools" in chat.headers)) die("response missing x-zc-chat-tools");
    if (!/^[01]$/.test(String(chat.headers["x-zc-chat-web"]))) die("response missing x-zc-chat-web");
    ok(
      "real chat: " + AGENT_ID + " answered " + content.trim().length + " chars, intent=" +
        chat.headers["x-zc-chat-intent"] + " tools=" + chat.headers["x-zc-chat-tools"] +
        " web=" + chat.headers["x-zc-chat-web"],
    );

    const logged = db
      .prepare(
        `SELECT agent, model, provider, status, ok FROM request_log
         WHERE path = '/v1/chat/completions' AND agent = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(AGENT_ID);
    if (!logged) die("no request_log row for " + AGENT_ID);
    if (logged.model !== NEW_MODEL) die("request_log model=" + logged.model + " want " + NEW_MODEL);
    if (logged.provider !== "ollama") die("request_log provider=" + logged.provider + " want ollama");
    if (Number(logged.status) !== 200 || Number(logged.ok) !== 1) {
      die("request_log status/ok not successful: " + JSON.stringify(logged));
    }
    const stat = db
      .prepare("SELECT requests FROM model_stats WHERE model = ? AND provider = 'ollama'")
      .get(NEW_MODEL);
    if (!stat || Number(stat.requests) < 1) {
      die("model_stats has no successful request for " + NEW_MODEL);
    }
    ok("provider evidence: request_log + model_stats record " + NEW_MODEL + " on ollama");
  } finally {
    await restoreAgent(db, before);
  }

  // ── 7. Restore verified ────────────────────────────────────
  const restored = await request("GET", "/api/admin/agents", undefined, adminHeaders());
  const back = (restored.body.agents || []).find((agent) => agent.id === AGENT_ID);
  if (!back || back.model !== before.model || back.persona !== before.persona) {
    die("restore failed: " + JSON.stringify(back));
  }
  const dbBack = readAgentsFromDb(db);
  if (!dbBack || dbBack.model !== before.model || dbBack.persona !== before.persona) {
    die("DB restore failed: " + JSON.stringify(dbBack));
  }
  ok("mapping restored: " + AGENT_ID + " -> " + before.model + " (persona unchanged)");

  db.close();
  console.log("ADMIN_CHAT_E2E_OK");
}

main().catch((error) => die(error && error.stack ? error.stack : String(error)));
