#!/usr/bin/env node
"use strict";

/**
 * tests/custom-provider-n-check.js
 *
 * Proves the custom-provider contract end to end:
 *
 *   1. provider/custom.js resolves custom_1..custom_12 and custom_99 from the
 *      environment, with no numeric cap and no hardcoded id list.
 *   2. api.js and provider/index.js both use that one resolver; custom_N is
 *      always the OpenAI adapter (a native TYPE is warned about and ignored).
 *   3. The docs describe one generic N block and no longer hardcode 5/6.
 *   4. A real gateway persists a custom_7 provider through the admin HTTP
 *      route with no env seed, rejects custom_8 with a native type, keeps the
 *      row across a restart, and deletes it again.
 *
 * Prints CUSTOM_PROVIDER_N_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "custom-provider-n-" + process.pid);
const ADMIN_TOKEN = "custom-provider-n-token";
const NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "99"];

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

function httpJson(port, requestPath, method, body, timeoutMs, headers) {
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
        timeout: timeoutMs || 10000,
        headers: requestHeaders,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk.toString()));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* keep null */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", (error) => resolve({ status: 0, json: null, text: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null, text: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health", "GET", null, 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
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

function providerById(json, id) {
  const rows = (json && json.providers) || [];
  return rows.find((row) => row && row.id === id) || null;
}

// ── 1. Static: one resolver, no hardcoded ids ─────────────────
const apiSource = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const providerSource = fs.readFileSync(path.join(ROOT, "provider", "index.js"), "utf8");
const customSource = fs.readFileSync(path.join(ROOT, "provider", "custom.js"), "utf8");
const envExample = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

expect("api.js delegates custom_N to provider/custom.js", () => {
  assert.ok(
    apiSource.includes('require("./provider/custom.js")'),
    "require missing",
  );
  const start = apiSource.indexOf("function loadCustomProviders()");
  const end = apiSource.indexOf("loadCustomProviders();", start);
  assert.ok(start > 0 && end > start, "loader block missing");
  const loader = apiSource.slice(start, end);
  assert.ok(loader.includes("customProviders.fromEnv"), "fromEnv not used");
  assert.ok(loader.includes("customProviders.listCustomNumbers"), "list not used");
  assert.ok(
    !/CUSTOM_PROVIDER_\d+_/.test(loader),
    "loader still names a concrete provider number",
  );
});

expect("provider/index.js uses the same resolver", () => {
  assert.ok(providerSource.includes('require("./custom")'), "require missing");
  assert.ok(providerSource.includes("custom.isCustomId"), "isCustomId not used");
  assert.ok(providerSource.includes("custom.fromEnv"), "fromEnv not used");
  assert.ok(
    !/CUSTOM_PROVIDER_\d+_/.test(providerSource),
    "provider/index.js still names a concrete provider number",
  );
});

expect("the resolver has no numeric cap or id list", () => {
  assert.ok(customSource.includes("CUSTOM_PROVIDER_(\\d+)_"), "generic key regex missing");
  assert.ok(customSource.includes("function listCustomNumbers"), "list helper missing");
  assert.ok(
    !/const\s+(?:MAX|LIMIT|CAP)\b/.test(customSource),
    "cap constant found",
  );
});

expect(".env.example documents one generic N block, no 5/6", () => {
  assert.ok(/CUSTOM_PROVIDER_<N>_/.test(envExample), "<N> placeholder missing");
  assert.ok(/no cap/i.test(envExample), "no-cap wording missing");
  assert.ok(/OpenAI-compatible/i.test(envExample), "OpenAI-only wording missing");
  assert.ok(!/CUSTOM_PROVIDER_[56]_/.test(envExample), "custom_5/6 block remains");
  assert.ok(
    !/CUSTOM_PROVIDER_\w*TYPE\s*=\s*llamacpp/i.test(envExample),
    "a custom_N native TYPE example remains",
  );
});

expect("README no longer hardcodes custom_5/custom_6", () => {
  assert.ok(!/custom_[56]\b/.test(readme), "custom_5/custom_6 reference remains");
  assert.ok(/custom_<N>/.test(readme), "generic custom_<N> wording missing");
});

// ── 2. Resolver unit: any N, OpenAI only ──────────────────────
const seedEnv = {};
for (const n of NUMBERS) {
  const port = 20000 + Number(n);
  seedEnv["CUSTOM_PROVIDER_" + n + "_ENABLED"] = "true";
  seedEnv["CUSTOM_PROVIDER_" + n + "_NAME"] = "N-" + n;
  seedEnv["CUSTOM_PROVIDER_" + n + "_URL"] = "http://127.0.0.1:" + port + "/v1";
  seedEnv["CUSTOM_PROVIDER_" + n + "_KEY"] = "key_" + n;
  seedEnv["CUSTOM_PROVIDER_" + n + "_PRIORITY"] = n;
  seedEnv["CUSTOM_PROVIDER_" + n + "_MODELS"] = "model-" + n;
  seedEnv["CUSTOM_PROVIDER_" + n + "_TIMEOUT_MS"] = String(300000 + Number(n));
  seedEnv["CUSTOM_PROVIDER_" + n + "_STREAM_TIMEOUT_MS"] = String(600000 + Number(n));
}
// A native dialect request must still resolve as OpenAI.
seedEnv.CUSTOM_PROVIDER_13_URL = "http://127.0.0.1:20013/v1";
seedEnv.CUSTOM_PROVIDER_13_TYPE = "llamacpp";

const custom = require(path.join(ROOT, "provider", "custom.js"));

expect("listCustomNumbers sees every seeded N with no cap", () => {
  const seen = custom.listCustomNumbers(seedEnv);
  for (const n of NUMBERS) assert.ok(seen.includes(n), "missing N=" + n);
  assert.ok(seen.includes("13"), "missing N=13");
  assert.strictEqual(seen.length, NUMBERS.length + 1);
});

for (const n of NUMBERS) {
  expect("custom_" + n + " resolves as OpenAI with its own endpoint", () => {
    const cfg = custom.fromEnv("custom_" + n, seedEnv);
    assert.ok(cfg, "null config");
    assert.strictEqual(cfg.id, "custom_" + n);
    assert.strictEqual(cfg.type, "openai");
    assert.strictEqual(cfg.adapter, "openai");
    assert.strictEqual(cfg.name, "N-" + n);
    assert.strictEqual(cfg.baseUrl, "http://127.0.0.1:" + (20000 + Number(n)) + "/v1");
    assert.strictEqual(cfg.key, "key_" + n);
    assert.strictEqual(cfg.priority, Number(n));
    assert.strictEqual(cfg.timeout, 300000 + Number(n));
    assert.strictEqual(cfg.streamTimeout, 600000 + Number(n));
    assert.strictEqual(cfg.enabled, true);
  });
}

expect("a native TYPE is reported but custom_N stays OpenAI", () => {
  const cfg = custom.fromEnv("custom_13", seedEnv);
  assert.strictEqual(cfg.type, "openai");
  assert.strictEqual(custom.requestedType("custom_13", seedEnv), "llamacpp");
  assert.strictEqual(custom.requestedType("custom_1", seedEnv), "");
});

expect("a custom id without URL or SOCKET does not exist", () => {
  assert.strictEqual(custom.fromEnv("custom_14", seedEnv), null);
});

expect("provider/configForId also resolves the same custom id", () => {
  for (const key of Object.keys(process.env)) {
    if (/^CUSTOM_PROVIDER_\d+_/.test(key)) delete process.env[key];
  }
  for (const key of Object.keys(seedEnv)) process.env[key] = seedEnv[key];
  const provider = require(path.join(ROOT, "provider", "index.js"));
  const cfg = provider.configForId("custom_99");
  assert.strictEqual(cfg.type, "openai");
  assert.strictEqual(cfg.baseUrl, seedEnv.CUSTOM_PROVIDER_99_URL);
  assert.strictEqual(provider.adapterFor(cfg).id, "openai");
  const native = provider.configForId("custom_13");
  assert.strictEqual(native.type, "openai");
});

// ── 3. Live gateway: admin persists custom_7 without env ──────
async function liveCheck() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const dbPath = path.join(dataDir, "models.db");

  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();

  const env = {};
  for (const key of Object.keys(process.env)) {
    // Drop every inherited custom seed, including the unit-test values and
    // custom_7/8: this gateway must create custom_7 from the admin route.
    if (/^CUSTOM_PROVIDER_\d+_/.test(key)) continue;
    env[key] = process.env[key];
  }
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
    INSTANCE_ID: "custom-provider-n-" + Date.now(),
    ADMIN_TOKEN,
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    CUSTOM_PROVIDER_1_ENABLED: "true",
    CUSTOM_PROVIDER_1_NAME: "env-seed",
    CUSTOM_PROVIDER_1_URL: "http://127.0.0.1:9/v1",
    CUSTOM_PROVIDER_1_PRIORITY: "1",
    CUSTOM_PROVIDER_1_MODELS: "seed-model",
    OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0",
  });

  const children = [];
  async function startGateway() {
    const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const health = await waitHealth(port, 45000);
    if (!health) {
      throw new Error("gateway unhealthy\n" + output.slice(-2000));
    }
    return child;
  }

  try {
    await startGateway();
    pass("isolated gateway healthy");

    await expectAsync("env seed custom_1 appears as OpenAI", async () => {
      const res = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      const row = providerById(res.json, "custom_1");
      assert.ok(row, "custom_1 missing");
      assert.strictEqual(row.source, "env");
      assert.strictEqual(row.type, "openai");
    });

    await expectAsync("admin creates custom_7 with no environment seed", async () => {
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        {
          action: "save",
          id: "custom_7",
          name: "db-seven",
          type: "openai",
          baseUrl: "http://127.0.0.1:9/v1",
          models: "seven-model=>seven-upstream",
          priority: 7,
          enabled: true,
        },
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(res.status, 200, "status=" + res.status + " body=" + res.text.slice(0, 240));
      assert.ok(res.json && res.json.ok === true, "not ok");
      assert.strictEqual(res.json.provider.id, "custom_7");
      assert.strictEqual(res.json.provider.source, "db");
      assert.strictEqual(res.json.provider.type, "openai");
    });

    await expectAsync("admin rejects a native dialect for custom_8", async () => {
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        {
          action: "save",
          id: "custom_8",
          name: "db-eight",
          type: "gemini",
          baseUrl: "http://127.0.0.1:9",
          priority: 8,
          enabled: true,
        },
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(res.status, 400, "status=" + res.status);
      assert.strictEqual(res.json && res.json.code, "CUSTOM_PROVIDER_TYPE_REJECTED");
      assert.ok(/OpenAI-compatible/.test(String(res.json && res.json.error)));
    });

    await expectAsync("custom_7 is a real SQLite row with type openai", () => {
      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT id, type, base_url, source FROM providers WHERE id = ?")
          .get("custom_7");
        assert.ok(row, "custom_7 row missing");
        assert.strictEqual(row.type, "openai");
        assert.strictEqual(row.base_url, "http://127.0.0.1:9/v1");
        assert.strictEqual(row.source, "db");
      } finally {
        db.close();
      }
    });

    // Restart with the same env (still no custom_7 seed) and prove the row
    // came back from SQLite, not from a process-local cache.
    await stopChild(children[0]);
    await startGateway();
    pass("gateway restarted");

    await expectAsync("custom_7 survives a restart without env", async () => {
      const res = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      const row = providerById(res.json, "custom_7");
      assert.ok(row, "custom_7 missing after restart");
      assert.strictEqual(row.source, "db");
      assert.strictEqual(row.type, "openai");
    });

    await expectAsync("DELETE removes custom_7 from config and SQLite", async () => {
      const res = await httpJson(
        port,
        "/api/admin/providers/custom_7",
        "DELETE",
        null,
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(res.status, 200, "status=" + res.status + " body=" + res.text.slice(0, 240));
      const list = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      assert.strictEqual(providerById(list.json, "custom_7"), null, "still in config");
      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT id FROM providers WHERE id = ?")
          .get("custom_7");
        assert.strictEqual(row, undefined, "still in SQLite");
      } finally {
        db.close();
      }
    });
  } finally {
    for (const child of children) await stopChild(child);
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
    console.error("CUSTOM_PROVIDER_N_FAILED");
    process.exit(1);
  }
  console.log("CUSTOM_PROVIDER_N_OK");
}

main().catch((error) => {
  console.error(
    "CUSTOM_PROVIDER_N_FAILED — " +
      (error && error.stack ? error.stack : error),
  );
  process.exit(1);
});
