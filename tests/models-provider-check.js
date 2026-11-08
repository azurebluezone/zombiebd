#!/usr/bin/env node
"use strict";

/**
 * Models/Providers acceptance gate — live gateway only.
 *
 * Proves the admin-facing contract with real requests against the running
 * server, never against a mock of our own code:
 *
 *   1. mode:"full" sync reads env + every active provider and writes SQLite.
 *   2. Priorities are unique and contiguous 1..N after sync and after edits.
 *   3. An invalid API key is rejected before any DB write.
 *   4. A valid key is stored encrypted (enc:v1:) and reported keySource=db.
 *   5. A provider that needs a key but has none yields HTTP 404
 *      provider_key_missing instead of a fake upstream attempt.
 *   6. Models of an inactive provider are absent; enabling it brings them back.
 *   7. A provider dialled over the llama unix socket lists its models as
 *      "llama UDS" and answers a real chat request over that socket.
 *
 * Boundary: the key-validation fixture (item 3/4) is a local HTTP server —
 * it stands in for a remote provider credential authority, and the test says
 * so. The llama UDS chat is NOT a fixture: it is the live CPU engine.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const { readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const PORT = Number(ENV.PORT || 5050);
const API = process.env.ZOMBIE_API_URL || "http://127.0.0.1:" + PORT;
const ADMIN_TOKEN =
  ENV.ADMIN_TOKEN || ENV.ADMIN_API_KEY || ENV.MCP_ADMIN_TOKEN || "";
const DB_PATH = path.resolve(ROOT, ENV.DB_SQLITE_PATH || "data/models.db");
const LLAMA_SOCKET = String(ENV.LLAMA_CPP_SOCKET || "").trim();
const LLAMA_DEFAULT_SOCKET = "/tmp/llama-1000/llama.sock";
const LLAMA_MODEL = String(ENV.LLAMA_CPP_MODEL || "qwen3-1.7b-abliterated").trim();

let passed = 0;
let failures = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  failures++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}
function expect(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function request(pathname, options) {
  const opts = options || {};
  const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
  const url = new URL(pathname, API);
  const headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (ADMIN_TOKEN && !headers["X-Admin-Token"]) {
    headers["X-Admin-Token"] = ADMIN_TOKEN;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method || "GET",
        headers,
        timeout: opts.timeoutMs || 30000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          done({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ status: 0, json: null, text: "request timeout" });
    });
    req.on("error", (e) => done({ status: 0, json: null, text: e.message }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function openDb() {
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(DB_PATH, { readOnly: true });
  } catch (e) {
    return null;
  }
}

function adminProviders() {
  return request("/api/admin/providers").then((r) => ({
    status: r.status,
    list: (r.json && r.json.providers) || [],
    raw: r,
  }));
}

// ─── Fixture: a credential authority that only accepts "good-key" ─────
function startKeyAuthority() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = String(req.headers.authorization || "");
      const expected = "Bearer good-key";
      if (auth !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      if (req.url.startsWith("/v1/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "key-gate-model", object: "model" }],
          }),
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function saveProvider(body) {
  return request("/api/admin/providers", { method: "POST", body });
}

async function deleteProvider(id) {
  return request("/api/admin/providers/" + encodeURIComponent(id), {
    method: "DELETE",
  });
}

async function main() {
  console.log("Models/Providers check — live gateway at " + API);
  console.log("DB: " + DB_PATH);

  // ─── 1. Gateway is alive ─────────────────────────────────────────−──
  const health = await request("/health");
  expect(
    "gateway health",
    health.status === 200 && health.json && health.json.healthy === true,
    "HTTP " + health.status,
  );
  if (!health.json || health.json.healthy !== true) {
    console.log("Models/Providers check cannot run without a live gateway.");
    console.log("MODELS_PROVIDER_CHECK FAIL — gateway down");
    process.exit(1);
  }

  // ─── 2. Baseline full sync (env → live providers → SQLite) ─────────
  const sync1 = await request("/api/normalize", {
    method: "POST",
    body: { mode: "full" },
    timeoutMs: 180000,
  });
  const syncPayload = sync1.json || {};
  expect("mode=full sync responds 200", sync1.status === 200, "HTTP " + sync1.status);
  expect(
    "mode=full sync reports success",
    syncPayload.success === true && syncPayload.mode === "full",
    syncPayload.error || "",
  );
  expect(
    "env sync persisted models to SQLite",
    !!(syncPayload.env && syncPayload.env.ok && syncPayload.env.synced > 0),
    syncPayload.env ? JSON.stringify(syncPayload.env) : "no env result",
  );
  expect(
    "live provider probes recorded",
    !!(syncPayload.results && Object.keys(syncPayload.results).length > 0),
    Object.keys(syncPayload.results || {}).join(","),
  );

  // ─── 3. Priorities contiguous 1..N ─────────────────────────────────
  const prov1 = await adminProviders();
  expect(
    "admin providers endpoint authorized",
    prov1.status === 200 && prov1.list.length > 0,
    "HTTP " + prov1.status,
  );
  const priorities = prov1.list.map((p) => Number(p.priority)).sort((a, b) => a - b);
  const contiguous = priorities.every((n, i) => n === i + 1);
  expect(
    "provider priorities unique and contiguous 1..N",
    contiguous,
    priorities.join(","),
  );

  // ─── 4. Invalid key rejected before write ──────────────────────────
  const authority = await startKeyAuthority();
  const authorityPort = authority.address().port;
  const authorityBase = "http://127.0.0.1:" + authorityPort + "/v1";
  let db = openDb();
  try {
    const before = db
      ? db.prepare("SELECT COUNT(*) AS c FROM providers WHERE id = ?").get("tests-badkey").c
      : 0;
    const bad = await saveProvider({
      action: "save",
      id: "tests-badkey",
      name: "Bad Key Gate",
      type: "openai",
      baseUrl: authorityBase,
      apiKey: "bad-key",
      models: "key-gate-model",
      enabled: true,
      requiresKey: true,
    });
    expect(
      "invalid API key rejected with 400",
      bad.status === 400,
      "HTTP " + bad.status + " " + ((bad.json && bad.json.error) || bad.text.slice(0, 120)),
    );
    const after = db
      ? db.prepare("SELECT COUNT(*) AS c FROM providers WHERE id = ?").get("tests-badkey").c
      : 0;
    expect(
      "rejected key never written to DB",
      before === after,
      "rows before=" + before + " after=" + after,
    );

    // ─── 5. Valid key persisted encrypted, keySource=db ─────────────
    const good = await saveProvider({
      action: "save",
      id: "tests-key",
      name: "Key Gate",
      type: "openai",
      baseUrl: authorityBase,
      apiKey: "good-key",
      models: "key-gate-model",
      enabled: true,
      requiresKey: true,
    });
    expect(
      "valid API key accepted",
      good.status === 200 && good.json && good.json.ok === true,
      "HTTP " + good.status + " " + ((good.json && good.json.error) || ""),
    );
    const row = db
      ? db.prepare("SELECT api_key FROM providers WHERE id = ?").get("tests-key")
      : null;
    expect(
      "key stored encrypted at rest",
      !!row && String(row.api_key).startsWith("enc:v1:") && !String(row.api_key).includes("good-key"),
      row ? String(row.api_key).slice(0, 18) + "…" : "no row",
    );
    const keyFile = path.join(path.dirname(DB_PATH), ".provider-keys.key");
    let keyFileMode = "";
    try {
      keyFileMode = (fs.statSync(keyFile).mode & 0o777).toString(8);
    } catch (_) {
      keyFileMode = "missing";
    }
    expect(
      "encryption key file is 0600",
      keyFileMode === "600",
      "mode=" + keyFileMode,
    );
    const provKey = (await adminProviders()).list.find((p) => p.id === "tests-key");
    expect(
      "admin reports keySource=db",
      !!provKey && provKey.keySource === "db" && provKey.hasKey === true,
      provKey ? "keySource=" + provKey.keySource + " hasKey=" + provKey.hasKey : "not listed",
    );

    // ─── 6. Missing key → direct 404 provider_key_missing ───────────
    const nokey = await saveProvider({
      action: "save",
      id: "tests-nokey",
      name: "No Key Gate",
      type: "openai",
      baseUrl: authorityBase,
      models: "nokey-model",
      enabled: true,
      requiresKey: true,
    });
    expect(
      "keyless provider saved without a key",
      nokey.status === 200 && nokey.json && nokey.json.ok === true,
      "HTTP " + nokey.status,
    );
    const chat = await request("/v1/chat/completions", {
      method: "POST",
      body: {
        model: "nokey-model",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      },
      timeoutMs: 60000,
    });
    const chatCode =
      chat.json && chat.json.error && (chat.json.error.code || chat.json.error);
    expect(
      "missing key returns HTTP 404 provider_key_missing",
      chat.status === 404 && chatCode === "provider_key_missing",
      "HTTP " + chat.status + " code=" + JSON.stringify(chatCode),
    );

    // ─── 7. Inactive provider models hidden ────────────────────────
    const hiddenSave = await saveProvider({
      action: "save",
      id: "tests-hidden",
      name: "Hidden Gate",
      type: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      models: "hidden-model",
      enabled: false,
    });
    expect(
      "inactive provider saved",
      hiddenSave.status === 200 && hiddenSave.json && hiddenSave.json.ok === true,
      "HTTP " + hiddenSave.status,
    );
    const listOff = await request("/api/normalize-list");
    const modelsOff = (listOff.json && listOff.json.models) || [];
    expect(
      "inactive provider models absent from the list",
      !modelsOff.some((m) => (m.model || m.name) === "hidden-model"),
      "models=" + modelsOff.length,
    );
    const toggle = await request("/api/admin/providers", {
      method: "POST",
      body: { action: "toggle", id: "tests-hidden", enabled: 1 },
    });
    expect(
      "provider enable toggle accepted",
      toggle.status === 200 && toggle.json && toggle.json.enabled === true,
      "HTTP " + toggle.status,
    );
    const listOn = await request("/api/normalize-list");
    const modelsOn = (listOn.json && listOn.json.models) || [];
    expect(
      "enabled provider models appear immediately",
      modelsOn.some((m) => (m.model || m.name) === "hidden-model"),
      "models=" + modelsOn.length,
    );

    // ─── 8. llama UDS provider: list, label, real chat ─────────────
    let socketPath = LLAMA_SOCKET;
    if (!socketPath && fs.existsSync(LLAMA_DEFAULT_SOCKET)) socketPath = LLAMA_DEFAULT_SOCKET;
    expect(
      "llama unix socket exists",
      !!socketPath && fs.existsSync(socketPath),
      socketPath || "not found",
    );
    if (socketPath) {
      const udsSave = await saveProvider({
        action: "save",
        id: "llama-uds",
        name: "llama-cpu-uds",
        type: "openai",
        baseUrl: "http://localhost:9932/v1",
        socketPath,
        models: "llama-uds-check=>" + LLAMA_MODEL,
        enabled: true,
      });
      expect(
        "UDS provider saved",
        udsSave.status === 200 && udsSave.json && udsSave.json.ok === true,
        "HTTP " + udsSave.status + " " + ((udsSave.json && udsSave.json.error) || ""),
      );

      const sync2 = await request("/api/normalize", {
        method: "POST",
        body: { mode: "full" },
        timeoutMs: 180000,
      });
      const udsResult =
        sync2.json && sync2.json.results && sync2.json.results["llama-uds"];
      expect(
        "live sync lists models over the UDS socket",
        !!udsResult && udsResult.ok === true,
        udsResult ? JSON.stringify(udsResult).slice(0, 160) : "no result",
      );

      const list = await request("/api/normalize-list");
      const udsRows = ((list.json && list.json.models) || []).filter(
        (m) => m.provider === "llama-uds",
      );
      expect(
        "UDS models labeled llama UDS",
        udsRows.length > 0 && udsRows.every((m) => m.providerName === "llama UDS"),
        udsRows.map((m) => m.providerName + ":" + m.model).join(","),
      );
      expect(
        "UDS model classified as chat",
        udsRows.length > 0 && udsRows.every((m) => m.type === "chat"),
        udsRows.map((m) => m.type).join(","),
      );

      const udsChat = await request("/v1/chat/completions", {
        method: "POST",
        body: {
          model: "llama-uds-check",
          messages: [{ role: "user", content: "Reply with the single word OK" }],
          stream: false,
          max_tokens: 24,
          temperature: 0,
        },
        timeoutMs: 180000,
      });
      const content =
        udsChat.json &&
        udsChat.json.choices &&
        udsChat.json.choices[0] &&
        udsChat.json.choices[0].message &&
        udsChat.json.choices[0].message.content;
      expect(
        "real chat over the llama UDS socket returns content",
        udsChat.status === 200 && typeof content === "string" && content.trim().length > 0,
        "HTTP " + udsChat.status + " content=" + JSON.stringify(String(content || "").slice(0, 60)),
      );
    }

    // ─── 9. DB truth: display name, type, priorities ──────────────
    if (db && socketPath) {
      const udsDbRows = db
        .prepare("SELECT name, provider_name, type, priority FROM models WHERE provider = ?")
        .all("llama-uds");
      expect(
        "DB rows carry the llama UDS display name",
        udsDbRows.length > 0 && udsDbRows.every((r) => r.provider_name === "llama UDS"),
        JSON.stringify(udsDbRows.slice(0, 2)),
      );
      expect(
        "DB rows carry type=chat (not the wire dialect)",
        udsDbRows.length > 0 && udsDbRows.every((r) => r.type === "chat"),
        udsDbRows.map((r) => r.type).join(","),
      );
      const providerPriorities = db
        .prepare("SELECT id, priority FROM providers ORDER BY priority ASC")
        .all();
      const dbPrios = providerPriorities.map((r) => Number(r.priority));
      expect(
        "DB provider priorities match the live 1..N order",
        providerPriorities.every((r) => {
          const live = prov1.list.find((p) => p.id === r.id);
          return !live || Number(live.priority) === Number(r.priority);
        }),
        providerPriorities.map((r) => r.id + "=" + r.priority).join(","),
      );
      expect(
        "DB priority values are unique",
        new Set(dbPrios).size === dbPrios.length,
        dbPrios.join(","),
      );
    } else {
      fail("DB truth checks", "database not readable at " + DB_PATH);
    }

    // ─── cleanup: temporary providers only; llama-uds stays ───────
    for (const id of ["tests-key", "tests-nokey", "tests-hidden", "tests-badkey"]) {
      await deleteProvider(id);
    }
    await sleep(100);
  } finally {
    try {
      authority.close();
    } catch (_) {
      /* already closed */
    }
    if (db) {
      try {
        db.close();
      } catch (_) {
        /* noop */
      }
    }
  }

  console.log("");
  if (failures === 0) {
    console.log("MODELS_PROVIDER_CHECK PASS (" + passed + " checks)");
  } else {
    console.log("MODELS_PROVIDER_CHECK FAIL (" + failures + " failed, " + passed + " passed)");
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.stack ? e.stack : e));
  console.log("MODELS_PROVIDER_CHECK FAIL");
  process.exit(1);
});
