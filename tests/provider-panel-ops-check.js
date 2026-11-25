#!/usr/bin/env node
"use strict";

/**
 * tests/provider-panel-ops-check.js
 *
 * Proves the admin panel's provider operations against a real gateway:
 *
 *   1. The panel owns auto custom_N ids, Test, Sync, provider/model switches.
 *   2. action:test reads a real /v1/models list before anything is saved.
 *   3. action:sync re-reads the live list and persists a new model in
 *      providers.models and the models table.
 *   4. Priority is unique: a new provider at 1 moves the old holder to the
 *      end; editing to an occupied slot swaps the two and stays gap-free.
 *   5. Provider/model toggles are reflected by GET /api/admin/providers.
 *   6. A runtime-down provider (network errors, not admin/env disabled) is
 *      skipped by resolveProvider after the failure threshold, so one dead
 *      endpoint cannot break a model that a healthy provider also serves.
 *   7. The gateway keeps OpenAI tool_calls intact through a provider.
 *
 * Prints PROVIDER_PANEL_OPS_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "panel-ops-" + process.pid);
const ADMIN_TOKEN = "panel-ops-token";

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

function expect(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
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

// ── 1. Static: one module owns the panel operations ───────────
const panelPath = path.join(ROOT, "lib", "admin-panel.js");
const apiPath = path.join(ROOT, "api.js");
const routesPath = path.join(ROOT, "lib", "admin-routes.js");
const panelSource = fs.readFileSync(panelPath, "utf8");
const apiSource = fs.readFileSync(apiPath, "utf8");
const routesSource = fs.readFileSync(routesPath, "utf8");
const panel = require(panelPath);
const rendered = panel.renderAdminPanel({ domain: "localhost", version: "3.2.1" });

expect("the panel renders Test, Sync and both switches", () => {
  assert.ok(rendered.includes("Test /v1/models"), "Test button missing");
  assert.ok(rendered.includes("Provider &amp; model sync"), "Sync-all missing");
  assert.ok(rendered.includes('data-action="toggle-provider"'), "provider switch missing");
  assert.ok(rendered.includes('data-action="toggle-model"'), "model switch missing");
  assert.ok(rendered.includes('data-action="sync"'), "per-provider Sync missing");
  assert.ok(rendered.includes("/api/admin/models"), "model toggle route missing");
  assert.ok(rendered.includes("readonly title="), "auto id is not read-only");
  assert.ok(rendered.includes("placeholder=\"auto\""), "priority is not auto");
});

expect("the panel client uses the plain provider actions", () => {
  assert.ok(panelSource.includes('action: "test"'), "test action missing");
  assert.ok(panelSource.includes('action: "sync"'), "sync action missing");
  assert.ok(panelSource.includes('action: "toggle"'), "toggle action missing");
  assert.ok(panelSource.includes("persist:"), "test persist hint missing");
  assert.ok(panelSource.includes("setInterval"), "background poll missing");
  assert.ok(panelSource.includes("x-admin-token"), "auth header missing");
});

expect("api.js owns auto ids, test, sync, modelStates and health skip", () => {
  assert.ok(apiSource.includes("function nextCustomProviderId"), "auto id missing");
  assert.ok(apiSource.includes("const id = requestedId || nextCustomProviderId()"), "save does not auto-id");
  assert.ok(apiSource.includes("PROVIDER_PRIORITY_SWAP"), "priority swap missing");
  assert.ok(apiSource.includes("async function testProviderFromAdmin"), "test handler missing");
  assert.ok(apiSource.includes("async function syncProvidersFromAdmin"), "sync handler missing");
  assert.ok(apiSource.includes("modelStates: providerModelStates"), "modelStates missing");
  assert.ok(apiSource.includes("PROVIDER_SKIP_DOWN"), "down skip missing");
});

expect("admin routes expose test and sync actions", () => {
  assert.ok(routesSource.includes('action === "test"'), "test route missing");
  assert.ok(routesSource.includes('action === "sync"'), "sync route missing");
  assert.ok(routesSource.includes("testProviderFromAdmin"), "test ctx missing");
  assert.ok(routesSource.includes("syncProvidersFromAdmin"), "sync ctx missing");
});

expect("the modules parse", () => {
  for (const file of ["api.js", "lib/admin-panel.js", "lib/admin-routes.js"]) {
    const result = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, file + ": " + String(result.stderr || "").slice(0, 240));
  }
});

// ── 2. Live stub provider + isolated gateway ──────────────────
function startStub(modelsRef) {
  const state = {
    models: modelsRef,
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
          data: state.models.map((id) => ({ id, object: "model" })),
        });
      }
      if (req.method === "POST" && url === "/v1/chat/completions") {
        state.chatRequests++;
        let parsed = {};
        try {
          parsed = JSON.parse(body || "{}");
        } catch (_) {
          parsed = {};
        }
        if (Array.isArray(parsed.tools) && parsed.tools.length) {
          return send(200, {
            id: "chatcmpl-tool",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: parsed.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_stub_1",
                      type: "function",
                      function: {
                        name: "get_time",
                        arguments: "{\"tz\":\"Asia/Dhaka\"}",
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
        return send(200, {
          id: "chatcmpl-stub",
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

async function liveCheck() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const dbPath = path.join(dataDir, "models.db");

  const stubModels = ["alpha", "beta", "tool-model"];
  const stub = await startStub(stubModels);
  const stubBase = "http://127.0.0.1:" + stub.port + "/v1";
  const deadPort = await freePort();
  const deadBase = "http://127.0.0.1:" + deadPort + "/v1";

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

  const listProviders = async () => {
    const res = await httpJson(port, "/api/admin/providers", "GET", null, 15000, auth);
    assert.strictEqual(res.status, 200, "GET providers status=" + res.status + " " + res.text.slice(0, 200));
    return res.json.providers || [];
  };

  const providerById = async (id) => {
    const providers = await listProviders();
    return providers.find((p) => p.id === id) || null;
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

  const chat = async (model, tools) => {
    const payload = {
      model,
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    return httpJson(port, "/v1/chat/completions", "POST", payload, 30000);
  };

  try {
    const health = await waitHealth(port, 60000);
    if (!health) {
      fail("isolated gateway healthy", "no health\n" + output.slice(-2000));
      return;
    }
    pass("isolated gateway healthy");

    // The admin contract is credential AND panel cookie (lib/admin-session.js).
    // Mint the cookie the same way a browser does before calling admin APIs.
    const panelPage = await httpText(port, "/admin/zombie", "GET", null, 10000);
    assert.strictEqual(panelPage.status, 200, "panel page status=" + panelPage.status);
    const setCookie = String(panelPage.headers["set-cookie"] || "");
    assert.ok(setCookie.startsWith("zc_panel="), "panel cookie missing: " + setCookie);
    auth.cookie = setCookie.split(";")[0];
    pass("panel session cookie established");

    let providers = await listProviders();
    expect("the baseline priority list is unique and gap-free", () => {
      const priorities = providers.map((p) => p.priority).sort((a, b) => a - b);
      assert.deepStrictEqual(priorities, priorities.map((_, i) => i + 1));
    });

    await expectAsync("action:test reads the stub /v1/models before saving", async () => {
      const before = stub.modelRequests;
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { action: "test", type: "openai", baseUrl: stubBase, apiKey: "stub-key" },
        20000,
        auth,
      );
      assert.strictEqual(res.status, 200, "status=" + res.status + " " + res.text.slice(0, 240));
      assert.deepStrictEqual(res.json.models.slice().sort(), ["alpha", "beta", "tool-model"]);
      assert.strictEqual(res.json.persisted, false);
      assert.ok(stub.modelRequests > before, "stub was not called");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT id FROM providers WHERE id = 'custom_90'").get();
        assert.strictEqual(row, undefined, "test wrote a provider row");
      } finally {
        db.close();
      }
    });

    await expectAsync("Save assigns the next free priority and stores the row", async () => {
      const before = await listProviders();
      const maxPriority = Math.max(...before.map((p) => p.priority));
      const saved = await saveProvider({
        id: "custom_90",
        name: "Panel Stub",
        baseUrl: stubBase,
        models: "alpha,beta,tool-model",
      });
      assert.strictEqual(saved.provider.id, "custom_90");
      assert.strictEqual(saved.provider.priority, maxPriority + 1);
      assert.strictEqual(saved.provider.source, "db");
      assert.strictEqual(saved.provider.modelStates.length, 3);
      assert.ok(saved.provider.modelStates.every((m) => m.enabled === true));
    });

    await expectAsync("action:sync persists a newly added model", async () => {
      stub.models.push("gamma");
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { action: "sync", id: "custom_90" },
        20000,
        auth,
      );
      assert.strictEqual(res.status, 200, "status=" + res.status + " " + res.text.slice(0, 240));
      const result = res.json.results.custom_90;
      assert.ok(result && result.ok, JSON.stringify(res.json).slice(0, 240));
      assert.deepStrictEqual(result.added, ["gamma"]);
      assert.strictEqual(result.total, 4);

      const row = await providerById("custom_90");
      assert.ok(row.modelList.includes("gamma"), "gamma missing from provider config");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const stored = db
          .prepare("SELECT models FROM providers WHERE id = 'custom_90'")
          .get();
        assert.ok(String(stored.models).includes("gamma"), "providers.models missing gamma");
        const model = db
          .prepare("SELECT enabled FROM models WHERE provider = 'custom_90' AND name = 'gamma'")
          .get();
        assert.ok(model, "models table missing gamma");
        assert.strictEqual(model.enabled, 1);
      } finally {
        db.close();
      }
    });

    await expectAsync("a removed upstream model is pruned on the next sync", async () => {
      stub.models = stub.models.filter((m) => m !== "beta");
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { action: "sync", id: "custom_90" },
        20000,
        auth,
      );
      const result = res.json.results.custom_90;
      assert.deepStrictEqual(result.removed, ["beta"]);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db
          .prepare("SELECT name FROM models WHERE provider = 'custom_90' AND name = 'beta'")
          .get();
        assert.strictEqual(row, undefined, "beta row survived the prune");
      } finally {
        db.close();
      }
    });

    await expectAsync("model on/off is persisted and visible", async () => {
      const off = await httpJson(
        port,
        "/api/admin/models",
        "POST",
        { provider: "custom_90", name: "alpha", enabled: false },
        15000,
        auth,
      );
      assert.strictEqual(off.status, 200, "toggle status=" + off.status);
      let row = await providerById("custom_90");
      let alpha = row.modelStates.find((m) => m.name === "alpha");
      assert.strictEqual(alpha.enabled, false, "alpha still enabled in GET");
      const on = await httpJson(
        port,
        "/api/admin/models",
        "POST",
        { provider: "custom_90", name: "alpha", enabled: true },
        15000,
        auth,
      );
      assert.strictEqual(on.status, 200);
      row = await providerById("custom_90");
      alpha = row.modelStates.find((m) => m.name === "alpha");
      assert.strictEqual(alpha.enabled, true, "alpha did not re-enable");
    });

    await expectAsync("provider on/off is independent from down status", async () => {
      const off = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { action: "toggle", id: "custom_90", enabled: false },
        15000,
        auth,
      );
      assert.strictEqual(off.status, 200);
      let row = await providerById("custom_90");
      assert.strictEqual(row.enabled, false);
      const on = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { action: "toggle", id: "custom_90", enabled: true },
        15000,
        auth,
      );
      assert.strictEqual(on.status, 200);
      row = await providerById("custom_90");
      assert.strictEqual(row.enabled, true);
      assert.strictEqual(row.envDisabled, false);
    });

    await expectAsync("a new provider at priority 1 moves the old holder to the end", async () => {
      const before = await listProviders();
      const holder = before.find((p) => p.priority === 1);
      const maxPriority = Math.max(...before.map((p) => p.priority));
      const saved = await saveProvider({
        id: "custom_91",
        name: "Swap One",
        baseUrl: stubBase,
        models: "swap-model",
        priority: 1,
      });
      assert.strictEqual(saved.provider.priority, 1, "new provider did not take priority 1");
      assert.deepStrictEqual(saved.prioritySwap, {
        id: holder.id,
        from: 1,
        to: maxPriority + 1,
      });
      const after = await listProviders();
      const moved = after.find((p) => p.id === holder.id);
      assert.ok(moved.priority > 1, "old holder kept priority 1");
      assert.strictEqual(new Set(after.map((p) => p.priority)).size, after.length);
    });

    await expectAsync("editing to an occupied priority swaps the two slots", async () => {
      const before = await listProviders();
      const target = before.find((p) => p.priority === 2);
      const moved = before.find((p) => p.id === "custom_90");
      assert.ok(target, "no provider at priority 2");
      const saved = await saveProvider({
        id: "custom_90",
        name: "Panel Stub",
        baseUrl: stubBase,
        models: "alpha,tool-model,gamma",
        priority: 2,
      });
      assert.strictEqual(saved.provider.priority, 2);
      assert.deepStrictEqual(saved.prioritySwap, {
        id: target.id,
        from: 2,
        to: moved.priority,
      });
      const after = await listProviders();
      assert.strictEqual(after.find((p) => p.id === target.id).priority, moved.priority);
      assert.strictEqual(new Set(after.map((p) => p.priority)).size, after.length);
      const sorted = after.map((p) => p.priority).sort((a, b) => a - b);
      assert.deepStrictEqual(sorted, sorted.map((_, i) => i + 1));
    });

    await expectAsync("a runtime-down provider is skipped after 3 failures", async () => {
      await saveProvider({
        id: "custom_92",
        name: "Dead Endpoint",
        baseUrl: deadBase,
        models: "health-probe-model",
        priority: 1,
      });
      await saveProvider({
        id: "custom_93",
        name: "Healthy Stub",
        baseUrl: stubBase,
        models: "health-probe-model",
      });

      for (let i = 0; i < 3; i++) {
        const res = await chat("health-probe-model");
        assert.strictEqual(res.status, 200, "request " + (i + 1) + " status=" + res.status);
        assert.strictEqual(
          res.json.choices[0].message.content,
          "stub ok",
          "request " + (i + 1) + " did not reach the healthy fallback",
        );
      }
      let dead = await providerById("custom_92");
      assert.strictEqual(dead.errors, 3, "expected 3 recorded failures, got " + dead.errors);
      assert.strictEqual(dead.status, "down");
      assert.strictEqual(dead.enabled, true, "down must not mean admin-disabled");

      const fourth = await chat("health-probe-model");
      assert.strictEqual(fourth.status, 200);
      assert.strictEqual(fourth.json.choices[0].message.content, "stub ok");
      dead = await providerById("custom_92");
      assert.strictEqual(dead.errors, 3, "resolveProvider retried the down provider");
      assert.strictEqual(dead.status, "down");
      const healthy = await providerById("custom_93");
      assert.ok(healthy.requests >= 4, "healthy provider did not serve every request");
    });

    await expectAsync("tool_calls survive the gateway path", async () => {
      const res = await chat("tool-model", [
        {
          type: "function",
          function: {
            name: "get_time",
            description: "Return the current time",
            parameters: {
              type: "object",
              properties: { tz: { type: "string" } },
              required: ["tz"],
            },
          },
        },
      ]);
      assert.strictEqual(res.status, 200, "status=" + res.status + " " + res.text.slice(0, 240));
      const message = res.json.choices[0].message;
      assert.ok(Array.isArray(message.tool_calls), "tool_calls missing");
      assert.strictEqual(message.tool_calls[0].function.name, "get_time");
      assert.deepStrictEqual(
        JSON.parse(message.tool_calls[0].function.arguments),
        { tz: "Asia/Dhaka" },
      );
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

async function main() {
  await liveCheck();
  console.log("\npassed=" + passed + " failed=" + failed);
  if (failed > 0) {
    console.error("PROVIDER_PANEL_OPS_FAILED");
    process.exit(1);
  }
  console.log("PROVIDER_PANEL_OPS_OK");
}

main().catch((error) => {
  console.error(
    "PROVIDER_PANEL_OPS_FAILED — " + (error && error.stack ? error.stack : error),
  );
  process.exit(1);
});
