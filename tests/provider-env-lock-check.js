#!/usr/bin/env node
"use strict";

/**
 * tests/provider-env-lock-check.js
 *
 * Deterministic regression gate for two real provider bugs:
 *
 *   1. A partial `/models` response used to prune env-declared model rows.
 *      The fix keeps env rows, drops only stale non-env rows, and never
 *      expands a custom provider's strict env allowlist.
 *   2. `POST /api/admin/providers {enabled:true}` used to reopen a provider
 *      that an env flag had disabled (OPENCODE_ENABLED=false). The fix
 *      refuses with 409 and leaves it disabled.
 *
 * It also asserts the release state: old build/log evidence is gone, dist is
 * a fresh build of the current source, and every module parses with the real
 * `node --check` parser.
 *
 * Prints PROVIDER_ENV_LOCK_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "provider-env-lock-" + process.pid);
const ADMIN_TOKEN = "provider-env-lock-token";
const KEEP_A = "keep-a";
const KEEP_B = "keep-b";

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

// ── 1. Pure merge rules ─────────────────────────────────────
const providerModels = require(path.join(ROOT, "modules", "provider-models.js"));

expect("env rows survive a partial live list", () => {
  const merged = providerModels.reconcileModels(
    [KEEP_A, KEEP_B, "stale-live"],
    [KEEP_A],
    { envModels: [KEEP_A, KEEP_B] },
  );
  assert.deepStrictEqual(merged, [KEEP_A, KEEP_B]);
});

expect("non-strict providers append genuinely new live models", () => {
  const merged = providerModels.reconcileModels([KEEP_A], [KEEP_A, "live-new"], {
    envModels: [KEEP_A],
  });
  assert.deepStrictEqual(merged, [KEEP_A, "live-new"]);
});

expect("a custom strict allowlist is never expanded", () => {
  const merged = providerModels.reconcileModels(
    [KEEP_A, KEEP_B],
    [KEEP_A, "live-new"],
    { envModels: [KEEP_A, KEEP_B], strict: true },
  );
  assert.deepStrictEqual(merged, [KEEP_A, KEEP_B]);
});

expect("masked env pairs survive a partial live list", () => {
  const pair = { name: "public-alias", apiModel: "upstream-model" };
  const merged = providerModels.reconcileModels([pair], [], {
    envModels: [pair],
  });
  assert.deepStrictEqual(merged, [pair]);
});

expect("dynamic refresh keeps env rows and appends new live rows", () => {
  const merged = providerModels.mergeDynamicModels(
    [KEEP_A, "live-new"],
    [KEEP_A, KEEP_B],
  );
  assert.deepStrictEqual(merged, [KEEP_A, KEEP_B, "live-new"]);
});

expect("DB cache keeps env rows first and appends cached rows", () => {
  const merged = providerModels.mergeDbModels([KEEP_A], [KEEP_A, "db-cached"]);
  assert.deepStrictEqual(merged, [KEEP_A, "db-cached"]);
});

// ── 2. Source wiring ────────────────────────────────────────
const apiSource = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const adminSource = fs.readFileSync(path.join(ROOT, "lib", "admin-routes.js"), "utf8");

expect("api.js wires the deterministic merge module", () => {
  assert.ok(
    apiSource.includes('require("./modules/provider-models.js")'),
    "provider-models require missing",
  );
  assert.ok(
    apiSource.includes("providerModels.reconcileModels"),
    "normalizer does not use reconcileModels",
  );
  assert.ok(
    apiSource.includes("providerModels.mergeDynamicModels"),
    "dynamic refresh does not use mergeDynamicModels",
  );
  assert.ok(
    apiSource.includes("p.envModels = p.models.slice()"),
    "built-in env model lists are not recorded",
  );
});

expect("lib/admin-routes.js refuses to reopen an env-disabled provider", () => {
  assert.ok(
    adminSource.includes("provider.envDisabled === true"),
    "envDisabled guard missing",
  );
  assert.ok(adminSource.includes("409"), "refusal status missing");
});

// ── 3. Real parser check ────────────────────────────────────
expect("api.js, lib/admin-routes.js and every module parse", () => {
  const files = ["api.js", path.join("lib", "admin-routes.js")];
  for (const name of fs.readdirSync(path.join(ROOT, "modules"))) {
    if (name.endsWith(".js")) files.push(path.join("modules", name));
  }
  for (const file of files) {
    const result = spawnSync(
      process.execPath,
      ["--check", path.join(ROOT, file)],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.strictEqual(
      result.status,
      0,
      file + ": " + String(result.stderr || "").slice(0, 240),
    );
  }
});

// ── 4. Release state ────────────────────────────────────────
expect("old verification evidence is gone", () => {
  assert.ok(
    !fs.existsSync(path.join(ROOT, "logs", "verify")),
    "logs/verify still exists",
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, "tmp", "final-report-zombiebd.md")),
    "tmp/final-report-zombiebd.md still exists",
  );
  assert.ok(
    !fs.existsSync(path.join(ROOT, "tmp", "delivery-receipt-gc.md")),
    "tmp/delivery-receipt-gc.md still exists",
  );
  const evidence = fs
    .readdirSync(path.join(ROOT, "tmp"))
    .filter((name) => /^evidence-.*\.md$/.test(name));
  assert.deepStrictEqual(evidence, []);
});

expect("dist is a fresh build of the current source", () => {
  const manifestPath = path.join(ROOT, "dist", "manifest.json");
  assert.ok(fs.existsSync(manifestPath), "dist/manifest.json missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const builtAt = Date.parse(manifest.builtAt);
  assert.ok(Number.isFinite(builtAt), "manifest.builtAt invalid");
  for (const file of ["api.js", path.join("lib", "admin-routes.js"), "modules/provider-models.js"]) {
    const sourceMtime = fs.statSync(path.join(ROOT, file)).mtimeMs;
    assert.ok(
      builtAt + 1000 >= sourceMtime,
      file + " is newer than dist (rebuild required)",
    );
  }
  assert.ok(
    fs.existsSync(path.join(ROOT, "dist", "modules", "provider-models.js")),
    "dist/modules/provider-models.js missing",
  );
});

// ── 5. Real source instance + partial /models stub ──────────
async function liveCheck() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  let stubHits = 0;
  const stub = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      stubHits++;
      res.writeHead(200, { "content-type": "application/json" });
      // Deliberately partial: keep-b is declared in env but absent here.
      res.end(JSON.stringify({ object: "list", data: [{ id: KEEP_A }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub-completion",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: KEEP_A,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "STUB_OK" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "localhost", resolve);
  });
  const stubPort = stub.address().port;

  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();

  const env = Object.assign({}, process.env, {
    PORT: String(port),
    GRPC: "0",
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    UDS_PORT: String(udsPort),
    // Keep generated .missionbarisal config inside this test's temp tree.
    APP_ROOT: TMP,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: path.join(dataDir, "models.db"),
    DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "0",
    INSTANCE_ID: "provider-env-lock-" + Date.now(),
    ADMIN_TOKEN,
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    // Env-closed provider. The admin toggle must not reopen it.
    OPENCODE_ENABLED: "false",
    OPENCODE_MODELS: "oc-free",
    OPENCODE_API_KEY: "oc_test_key",
    // Keep startup away from real networks; only the local stub matters.
    CUSTOM_PROVIDER_1_ENABLED: "false",
    CUSTOM_PROVIDER_9_URL: "http://127.0.0.1:" + stubPort + "/v1",
    CUSTOM_PROVIDER_9_KEY: "",
    CUSTOM_PROVIDER_9_TYPE: "openai",
    CUSTOM_PROVIDER_9_MODELS: KEEP_A + "," + KEEP_B,
    CUSTOM_PROVIDER_9_PRIORITY: "9",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0",
  });

  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  try {
    const health = await waitHealth(port, 45000);
    if (!health) {
      fail("source gateway healthy", "no health\n" + output.slice(-2000));
      return;
    }
    pass("source gateway healthy", "agents=" + health.agents + " models=" + health.models);

    const tempConfig = path.join(TMP, ".missionbarisal", "mcp-config.json");
    if (fs.existsSync(tempConfig)) {
      pass("runtime config stays inside APP_ROOT", tempConfig);
    } else {
      fail("runtime config stays inside APP_ROOT", "missing " + tempConfig);
    }

    const hitDeadline = Date.now() + 20000;
    while (stubHits === 0 && Date.now() < hitDeadline) await sleep(200);
    if (stubHits === 0) {
      fail("provider sync reached the stub", "no /v1/models request");
      return;
    }
    pass("provider sync reached the stub", "hits=" + stubHits);
    // The merge happens immediately after the stub response.
    await sleep(750);

    await expectAsync("env rows survive a real partial /models response", async () => {
      const v1 = await httpJson(port, "/api/v1/models", "GET", null, 10000);
      const rows = (v1.json && (v1.json.data || v1.json.models)) || [];
      const custom = rows
        .filter((row) => row && row.provider === "custom_9")
        .map((row) => row.id);
      assert.ok(custom.includes(KEEP_A), KEEP_A + " missing: " + JSON.stringify(custom));
      assert.ok(custom.includes(KEEP_B), KEEP_B + " missing: " + JSON.stringify(custom));
    });

    await expectAsync("a 127.0.0.1 provider is keyless through the real gateway", async () => {
      const chat = await httpJson(
        port,
        "/v1/chat/completions",
        "POST",
        {
          model: KEEP_A,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
        },
        15000,
      );
      assert.strictEqual(
        chat.status,
        200,
        "status=" + chat.status + " body=" + String(chat.text || "").slice(0, 200),
      );
      const content = String(
        (chat.json &&
          chat.json.choices &&
          chat.json.choices[0] &&
          chat.json.choices[0].message &&
          chat.json.choices[0].message.content) ||
          "",
      ).trim();
      assert.strictEqual(content, "STUB_OK");
    });

    await expectAsync("admin cannot reopen an env-disabled provider", async () => {
      const toggle = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        { id: "opencode", enabled: true },
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(toggle.status, 409, "status=" + toggle.status + " body=" + toggle.text.slice(0, 200));
      assert.strictEqual(toggle.json && toggle.json.envDisabled, true);
      assert.strictEqual(toggle.json && toggle.json.enabled, false);
    });

    await expectAsync("env-disabled provider stays disabled in admin state", async () => {
      const adm = await httpJson(
        port,
        "/api/admin/providers",
        "GET",
        null,
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      const opencode = ((adm.json && adm.json.providers) || []).find(
        (provider) => provider.id === "opencode",
      );
      assert.ok(opencode, "opencode missing from admin providers");
      assert.strictEqual(opencode.envDisabled, true);
      assert.strictEqual(opencode.enabled, false);
    });

    await expectAsync("opencode stays absent from /api/v1/models", async () => {
      const v1 = await httpJson(port, "/api/v1/models", "GET", null, 10000);
      const rows = (v1.json && (v1.json.data || v1.json.models)) || [];
      const opencode = rows.filter(
        (row) => row && (row.provider === "opencode" || row.owned_by === "OpenCode"),
      );
      assert.strictEqual(opencode.length, 0);
    });
  } finally {
    await stopChild(child);
    await new Promise((resolve) => stub.close(resolve));
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
    console.error("PROVIDER_ENV_LOCK_FAILED");
    process.exit(1);
  }
  console.log("PROVIDER_ENV_LOCK_OK");
}

main().catch((error) => {
  console.error("PROVIDER_ENV_LOCK_FAILED — " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
