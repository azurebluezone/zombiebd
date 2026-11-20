#!/usr/bin/env node
"use strict";

/**
 * tests/admin-panel-self-contained-check.js
 *
 * Proves the admin panel no longer depends on public/admin.html and that its
 * one-file render is a working client of the plain admin routes:
 *
 *   1. lib/admin-panel.js owns the document, CSS and client JS.
 *   2. api.js serves /admin and /admin/ from renderAdminPanel().
 *   3. The rendered page verifies the token once, optionally checks a
 *      session_id via /api/verify-session, then polls with x-admin-token on a
 *      setInterval; 401/403 stops the poll.
 *   4. The page adds provider rows and uses the same GET/POST/DELETE routes
 *      curl uses.
 *   5. A real gateway with an empty ADMIN_DIR still serves the panel, and the
 *      panel's POST persists custom_9 in SQLite; DELETE removes it.
 *
 * Prints ADMIN_PANEL_SELF_CONTAINED_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "admin-panel-" + process.pid);
const ADMIN_TOKEN = "admin-panel-token";

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
        timeout: timeoutMs || 10000,
        headers: requestHeaders,
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode, text, headers: res.headers }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: error.message, headers: {} }));
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

// ── 1. Static: one module owns the document ───────────────────
const panelPath = path.join(ROOT, "lib", "admin-panel.js");
assert.ok(fs.existsSync(panelPath), "lib/admin-panel.js missing");
const panelSource = fs.readFileSync(panelPath, "utf8");
const apiSource = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const oldAdmin = fs.readFileSync(path.join(ROOT, "public", "admin.html"), "utf8");

const panel = require(panelPath);
const rendered = panel.renderAdminPanel({ domain: "localhost", version: "3.2.1" });

expect("the module renders a complete document", () => {
  assert.strictEqual(panel.PANEL_MARKER, "zc-admin-panel");
  assert.ok(rendered.startsWith("<!doctype html>"), "missing doctype");
  assert.ok(rendered.includes('data-panel="self-contained"'), "marker missing");
  assert.ok(rendered.includes('id="zc-admin-panel"'), "panel id missing");
  assert.ok(rendered.includes("<style>"), "inline CSS missing");
  assert.ok(rendered.includes("Add provider row"), "add-row button missing");
});

expect("the client verifies once and polls authenticated headers", () => {
  assert.ok(panelSource.includes("setInterval"), "setInterval missing");
  assert.ok(panelSource.includes("x-admin-token"), "header missing");
  assert.ok(panelSource.includes("/api/verify-session"), "session verify missing");
  assert.ok(panelSource.includes("sessionStorage"), "sessionStorage missing");
  assert.ok(panelSource.includes("stopPolling"), "poll stop missing");
  assert.ok(panelSource.includes("401"), "401 handling missing");
});

expect("the client uses the plain curl routes", () => {
  assert.ok(panelSource.includes("/api/admin/providers"), "providers route missing");
  assert.ok(panelSource.includes('method: "POST"'), "POST missing");
  assert.ok(panelSource.includes('method: "DELETE"'), "DELETE missing");
  assert.ok(panelSource.includes("JSON.stringify(payload)"), "JSON body missing");
  assert.ok(panelSource.includes("type: tr.getAttribute(\"data-type\") || \"openai\""), "openai type fallback missing");
});

expect("the inline client JS parses", () => {
  const scripts = [...rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(scripts.length, 2, "expected config + client scripts");
  for (const script of scripts) new Function(script);
});

expect("api.js serves /admin from the module, not admin.html", () => {
  assert.ok(apiSource.includes('require("./lib/admin-panel.js")'), "require missing");
  assert.ok(apiSource.includes("adminPanel.renderAdminPanel"), "render call missing");
  const start = apiSource.indexOf("// ─── GET /admin — self-contained panel");
  const end = apiSource.indexOf("// ─── GET /admin/:file", start);
  assert.ok(start > 0 && end > start, "admin route block missing");
  const block = apiSource.slice(start, end);
  assert.ok(block.includes("renderAdminPanel"), "panel route does not render the module");
  assert.ok(!block.includes("readFileSync"), "panel route still reads a file");
  assert.ok(!block.includes('"/admin.html"'), "panel route still targets admin.html");
});

expect("the rendered page is not the legacy admin.html", () => {
  assert.ok(oldAdmin.includes('id="adminTokenInput"'), "legacy marker missing (test stale)");
  assert.ok(!rendered.includes('id="adminTokenInput"'), "legacy admin markup leaked in");
  assert.ok(rendered.includes('id="tokenInput"'), "new token input missing");
});

expect("api.js and the panel module parse", () => {
  for (const file of ["api.js", path.join("lib", "admin-panel.js")]) {
    const result = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, file + ": " + String(result.stderr || "").slice(0, 240));
  }
});

// ── 2. Live gateway with an empty ADMIN_DIR ───────────────────
async function liveCheck() {
  fs.mkdirSync(TMP, { recursive: true });
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  const emptyAdminDir = path.join(TMP, "empty-admin");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(emptyAdminDir, { recursive: true });
  const dbPath = path.join(dataDir, "models.db");

  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();

  const env = {};
  for (const key of Object.keys(process.env)) {
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
    ADMIN_DIR: emptyAdminDir,
    INSTANCE_ID: "admin-panel-" + Date.now(),
    ADMIN_TOKEN,
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    OPENCODE_ENABLED: "false",
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
      fail("isolated gateway healthy", "no health\n" + output.slice(-2000));
      return;
    }
    pass("isolated gateway healthy");

    await expectAsync("GET /admin works with an empty ADMIN_DIR", async () => {
      const res = await httpText(port, "/admin", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status + " body=" + res.text.slice(0, 200));
      assert.ok(/text\/html/.test(String(res.headers["content-type"] || "")), "wrong content-type");
      assert.ok(res.text.includes('data-panel="self-contained"'), "panel marker missing");
      assert.ok(res.text.includes("zc-admin-panel"), "panel id missing");
      assert.ok(!res.text.includes('id="adminTokenInput"'), "legacy admin served");
    });

    await expectAsync("GET /admin/ is the same rendered panel", async () => {
      const res = await httpText(port, "/admin/", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status);
      assert.ok(res.text.includes('data-panel="self-contained"'));
    });

    await expectAsync("the panel routes require the admin token", async () => {
      const noToken = await httpJson(port, "/api/admin/providers", "GET", null, 10000);
      assert.strictEqual(noToken.status, 401, "status=" + noToken.status);
      const withToken = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      assert.strictEqual(withToken.status, 200, "status=" + withToken.status);
    });

    await expectAsync("the panel's POST creates custom_9 in SQLite", async () => {
      const payload = {
        action: "save",
        id: "custom_9",
        name: "panel-nine",
        type: "openai",
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "",
        models: "nine-model=>nine-upstream",
        priority: "9",
        enabled: true,
      };
      const res = await httpJson(
        port,
        "/api/admin/providers",
        "POST",
        payload,
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(res.status, 200, "status=" + res.status + " body=" + res.text.slice(0, 240));
      assert.strictEqual(res.json.provider.id, "custom_9");
      assert.strictEqual(res.json.provider.type, "openai");
      assert.strictEqual(res.json.provider.source, "db");

      const db = new DatabaseSync(dbPath);
      try {
        const row = db
          .prepare("SELECT id, type, base_url, source FROM providers WHERE id = ?")
          .get("custom_9");
        assert.ok(row, "custom_9 row missing");
        assert.strictEqual(row.type, "openai");
        assert.strictEqual(row.base_url, "http://127.0.0.1:9/v1");
        assert.strictEqual(row.source, "db");
      } finally {
        db.close();
      }
    });

    await expectAsync("GET returns the row and DELETE removes it", async () => {
      const list = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      const row = (list.json.providers || []).find((p) => p.id === "custom_9");
      assert.ok(row, "custom_9 missing from GET");
      assert.strictEqual(row.type, "openai");

      const del = await httpJson(
        port,
        "/api/admin/providers/custom_9",
        "DELETE",
        null,
        10000,
        { "x-admin-token": ADMIN_TOKEN },
      );
      assert.strictEqual(del.status, 200, "status=" + del.status + " body=" + del.text.slice(0, 200));
      const after = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      assert.strictEqual(
        (after.json.providers || []).some((p) => p.id === "custom_9"),
        false,
        "custom_9 still listed",
      );
    });
  } finally {
    await stopChild(child);
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
    console.error("ADMIN_PANEL_SELF_CONTAINED_FAILED");
    process.exit(1);
  }
  console.log("ADMIN_PANEL_SELF_CONTAINED_OK");
}

main().catch((error) => {
  console.error(
    "ADMIN_PANEL_SELF_CONTAINED_FAILED — " +
      (error && error.stack ? error.stack : error),
  );
  process.exit(1);
});
