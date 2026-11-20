#!/usr/bin/env node
"use strict";

/**
 * tests/provider-health-honesty-check.js
 *
 * Runbook P0-08 / section 10.2 — provider health must be honest:
 *
 *   1. A fresh provider (no probe, no served request) is `unknown`,
 *      never `up`; /health.healthy still describes the process.
 *   2. An HTTP 500 from a stub provider produces degraded/down with a
 *      lastError in /health.providers AND provider_stats.last_error.
 *   3. A later success clears provider_stats.last_error / last_error_at
 *      and marks the provider up (COALESCE no longer keeps the old error).
 *   4. TTL expiry turns an idle provider stale, not optimistically healthy,
 *      while the process /health.healthy stays true.
 *   5. GET /api/admin/providers and /health.providers report the same status
 *      because both read one snapshot function.
 *   6. An unknown provider is still a routing candidate (first request is
 *      tried), and a confirmed-down provider is skipped without a new error.
 *
 * Prints PROVIDER_HEALTH_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "health-honesty-" + process.pid);
const ADMIN_TOKEN = "health-honesty-token";
const TTL_MS = 3000;
const COOLDOWN_MS = 1200;

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

async function expectAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpText(port, requestPath, method, body, timeoutMs, headers) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        host: "localhost",
        port,
        path: requestPath,
        method,
        timeout: timeoutMs || 15000,
        headers: requestHeaders,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode, text, headers: res.headers }),
        );
      },
    );
    req.on("error", (error) =>
      resolve({ status: 0, text: error.message, headers: {} }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "timeout", headers: {} });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function httpJson(port, requestPath, method, body, timeoutMs, headers) {
  const res = await httpText(port, requestPath, method, body, timeoutMs, headers);
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch (_) {
    json = null;
  }
  return Object.assign({}, res, { json });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health", "GET", null, 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) {
      return res.json;
    }
    await sleep(250);
  }
  return null;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

// ── 1. Static: one snapshot function, one additive /health block ──
const apiPath = path.join(ROOT, "api.js");
const apiSource = fs.readFileSync(apiPath, "utf8");

(async () => {
  await expectAsync("api.js owns the health snapshot and additive /health block", async () => {
    assert.ok(apiSource.includes("function providerHealthSnapshot"), "snapshot missing");
    assert.ok(apiSource.includes("function providerHealthReport"), "report missing");
    assert.ok(apiSource.includes("providers: providerHealthReport()"), "/health block missing");
    assert.ok(apiSource.includes("PROVIDER_HEALTH_TTL_MS"), "TTL env missing");
    assert.ok(apiSource.includes("PROVIDER_HEALTH_COOLDOWN_MS"), "cooldown env missing");
    assert.ok(
      apiSource.includes("CASE WHEN excluded.errors = 0"),
      "success does not clear the stale last_error",
    );
    assert.ok(
      !apiSource.includes("healthy = true;\n  } catch (_) {\n    /* keep the optimistic default"),
      "providerSummary still defaults to optimistic healthy",
    );
  });

  await expectAsync("api.js parses", async () => {
    const result = spawnSync(process.execPath, ["--check", apiPath], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, String(result.stderr || "").slice(0, 240));
  });

  await liveCheck();
})()
  .catch((error) => {
    console.error(
      "PROVIDER_HEALTH_FAILED — " + (error && error.stack ? error.stack : error),
    );
    process.exit(1);
  })
  .finally(() => {
    console.log("\npassed=" + passed + " failed=" + failed);
    if (failed > 0) {
      console.error("PROVIDER_HEALTH_FAILED");
      process.exit(1);
    }
    console.log("PROVIDER_HEALTH_OK");
  });

// ── 2. Live stub provider + isolated gateway ──────────────────
function startStub() {
  const state = {
    mode: "ok", // ok | fail
    modelRequests: 0,
    chatRequests: 0,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      const url = req.url.split("?")[0];
      const send = (status, payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (req.method === "GET" && url === "/v1/models") {
        state.modelRequests++;
        return send(200, {
          object: "list",
          data: [{ id: "health-model", object: "model" }],
        });
      }
      if (req.method === "POST" && url === "/v1/chat/completions") {
        state.chatRequests++;
        if (state.mode === "fail") {
          return send(500, { error: { message: "stub provider exploded" } });
        }
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch (_) {
          parsed = {};
        }
        return send(200, {
          id: "chatcmpl-health",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: parsed.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "stub ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.close = () => new Promise((done) => server.close(done));
      resolve(state);
    });
  });
}

function readProviderStat(dbPath, providerId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT requests, errors, last_error, last_error_at FROM provider_stats WHERE provider = ?",
      )
      .get(providerId);
  } finally {
    db.close();
  }
}

async function liveCheck() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const dbPath = path.join(dataDir, "models.db");

  const stub = await startStub();
  const stubBase = "http://127.0.0.1:" + stub.port + "/v1";
  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();

  const env = {};
  for (const key of Object.keys(process.env)) env[key] = process.env[key];
  Object.assign(env, {
    PORT: String(port),
    GRPC: "0",
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    UDS_PORT: String(udsPort),
    APP_ROOT: TMP,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: dbPath,
    DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "0",
    ADMIN_TOKEN,
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0",
    NORMALIZER_AUTORUN: "0",
    PROVIDER_HEALTH_TTL_MS: String(TTL_MS),
    PROVIDER_HEALTH_COOLDOWN_MS: String(COOLDOWN_MS),
  });

  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  const auth = { "x-admin-token": ADMIN_TOKEN };

  const healthJson = async () => {
    const res = await httpJson(port, "/health", "GET", null, 15000);
    assert.strictEqual(res.status, 200, "health status=" + res.status);
    return res.json;
  };

  const listProviders = async () => {
    const res = await httpJson(port, "/api/admin/providers", "GET", null, 15000, auth);
    assert.strictEqual(
      res.status,
      200,
      "GET providers status=" + res.status + " " + res.text.slice(0, 200),
    );
    return res.json.providers || [];
  };

  const saveProvider = async (payload) => {
    const res = await httpJson(
      port,
      "/api/admin/providers",
      "POST",
      Object.assign({ action: "save", type: "openai", enabled: true }, payload),
      20000,
      auth,
    );
    assert.strictEqual(res.status, 200, "save status=" + res.status + " " + res.text.slice(0, 240));
    assert.ok(res.json && res.json.ok, "save not ok: " + res.text.slice(0, 200));
    return res.json;
  };

  const chat = async (model) => {
    return httpJson(
      port,
      "/v1/chat/completions",
      "POST",
      {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      30000,
    );
  };

  try {
    const health = await waitHealth(port, 60000);
    if (!health) {
      fail("isolated gateway healthy", "no health\n" + output.slice(-2000));
      return;
    }
    pass("isolated gateway healthy");

    await expectAsync("fresh providers are unknown, not healthy", async () => {
      const providers = health.providers;
      assert.ok(providers && typeof providers === "object", "providers block missing");
      const ids = Object.keys(providers);
      assert.ok(ids.length > 0, "providers block is empty");
      for (const id of ids) {
        const p = providers[id];
        assert.strictEqual(
          p.status,
          "unknown",
          id + " was reported " + p.status + " before any probe",
        );
        assert.strictEqual(p.healthy, false, id + " claimed healthy before a probe");
        assert.strictEqual(p.lastProbeAt, null, id + " has a probe timestamp");
      }
      assert.strictEqual(health.healthy, true, "process health must stay true");
    });

    await expectAsync("Save does not fake a healthy provider", async () => {
      await saveProvider({
        id: "custom_94",
        name: "Health Stub",
        baseUrl: stubBase,
        models: "health-model",
      });
      const row = (await listProviders()).find((p) => p.id === "custom_94");
      assert.ok(row, "custom_94 missing");
      assert.strictEqual(row.status, "unknown", "save reported " + row.status);
      assert.strictEqual(row.healthy, false);
    });

    await expectAsync("an unknown provider is still a routing candidate", async () => {
      const res = await chat("health-model");
      assert.strictEqual(res.status, 200, "status=" + res.status + " " + res.text.slice(0, 240));
      assert.strictEqual(res.json.choices[0].message.content, "stub ok");
      const health = await healthJson();
      const p = health.providers.custom_94;
      assert.strictEqual(p.status, "up", "status=" + p.status);
      assert.strictEqual(p.healthy, true);
      assert.ok(p.lastProbeAt, "lastProbeAt missing");
      assert.ok(p.lastSuccessAt, "lastSuccessAt missing");
      assert.strictEqual(p.lastError, null);
    });

    await expectAsync("a 500 is reported as degraded/down with lastError", async () => {
      stub.mode = "fail";
      for (let i = 0; i < 3; i++) {
        const res = await chat("health-model");
        assert.notStrictEqual(res.status, 200, "failing stub answered 200 on try " + (i + 1));
      }
      const health = await healthJson();
      const p = health.providers.custom_94;
      assert.ok(
        p.status === "degraded" || p.status === "down",
        "status=" + p.status + " after 3 failures",
      );
      assert.strictEqual(p.status, "down", "3 consecutive failures must be down");
      assert.ok(p.lastError, "lastError missing after failures");
      assert.strictEqual(p.healthy, false);
      const stat = readProviderStat(dbPath, "custom_94");
      assert.ok(stat, "provider_stats row missing");
      assert.ok(stat.last_error, "SQLite last_error not set");
      assert.ok(stat.last_error_at, "SQLite last_error_at not set");
      assert.ok(stat.errors >= 3, "expected >=3 errors, got " + stat.errors);
    });

    await expectAsync("a confirmed-down provider is skipped without a new error", async () => {
      const before = readProviderStat(dbPath, "custom_94");
      const res = await chat("health-model");
      assert.strictEqual(res.status, 503, "status=" + res.status + " " + res.text.slice(0, 240));
      assert.strictEqual(res.json.error.code, "providers_down");
      const after = readProviderStat(dbPath, "custom_94");
      assert.strictEqual(after.errors, before.errors, "resolveProvider retried the down provider");
      const p = (await healthJson()).providers.custom_94;
      assert.strictEqual(p.status, "down");
    });

    await expectAsync("a success clears the stale SQLite error and marks it up", async () => {
      stub.mode = "ok";
      await sleep(COOLDOWN_MS + 200);
      const res = await chat("health-model");
      assert.strictEqual(res.status, 200, "status=" + res.status + " " + res.text.slice(0, 240));
      assert.strictEqual(res.json.choices[0].message.content, "stub ok");
      const health = await healthJson();
      const p = health.providers.custom_94;
      assert.strictEqual(p.status, "up", "status=" + p.status);
      assert.strictEqual(p.healthy, true);
      assert.strictEqual(p.lastError, null);
      const stat = readProviderStat(dbPath, "custom_94");
      assert.strictEqual(stat.last_error, null, "stale last_error survived a success");
      assert.strictEqual(stat.last_error_at, null, "stale last_error_at survived a success");
    });

    await expectAsync("admin list and /health.providers share one status", async () => {
      const health = await healthJson();
      const admin = await listProviders();
      let compared = 0;
      for (const row of admin) {
        if (!health.providers[row.id]) continue;
        compared++;
        assert.strictEqual(
          row.status,
          health.providers[row.id].status,
          row.id + ": admin=" + row.status + " health=" + health.providers[row.id].status,
        );
      }
      assert.ok(compared > 0, "no shared providers to compare");
    });

    await expectAsync("TTL expiry is stale, while the process stays healthy", async () => {
      await sleep(TTL_MS + 600);
      const health = await healthJson();
      assert.strictEqual(health.healthy, true, "process health flipped to false");
      const p = health.providers.custom_94;
      assert.strictEqual(p.status, "stale", "status=" + p.status + " after TTL");
      assert.strictEqual(p.healthy, false, "stale provider claimed healthy");
      assert.strictEqual(p.lastError, null);
    });
  } finally {
    await stopChild(child);
    await stub.close().catch(() => {});
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}
