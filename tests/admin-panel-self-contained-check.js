#!/usr/bin/env node
"use strict";

/**
 * tests/admin-panel-self-contained-check.js
 *
 * Proves the admin panel is optional and API-only:
 *
 *   1. lib/admin-panel.js owns the built-in document, CSS and client JS.
 *   2. public/admin.html, when present, is a convenience page that only calls
 *      this gateway's same-origin /api/* routes: no provider auth header, no
 *      absolute fetch, no proxy and no scraping code.
 *   3. api.js serves /admin/zombie from public/admin.html when ADMIN_DIR has
 *      it, and falls back to renderAdminPanel() when the file is absent.
 *   4. Both paths mint the zc_panel cookie; admin methods require that cookie
 *      plus the admin token.
 *   5. A real gateway with an empty ADMIN_DIR serves the built-in panel; a
 *      second gateway with a static page serves that page. The panel's POST
 *      persists custom_9 in SQLite; DELETE removes it.
 *
 * Prints ADMIN_PAGE_OPTIONAL_OK only when every check passes.
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

expect("api.js resolves the optional page and the module fallback", () => {
  assert.ok(apiSource.includes('require("./lib/admin-panel.js")'), "require missing");
  assert.ok(apiSource.includes("function loadAdminPanel"), "panel loader missing");
  assert.ok(apiSource.includes("function loadAdminPage"), "page loader missing");
  assert.ok(apiSource.includes("adminPageFile"), "static page path missing");
  assert.ok(
    !/^const adminPanel = require/m.test(apiSource),
    "panel is still required at boot",
  );
  assert.ok(apiSource.includes("renderAdminPanel(options)"), "render call missing");
  assert.ok(apiSource.includes("adminSession.create()"), "panel session mint missing");
  assert.ok(apiSource.includes("adminRouteAuthorized"), "panel gate missing");
  const start = apiSource.indexOf("// ─── GET /admin/zombie — optional admin page");
  const end = apiSource.indexOf("// ─── GET /api/admin — redirect", start);
  assert.ok(start > 0 && end > start, "admin route block missing");
  const block = apiSource.slice(start, end);
  assert.ok(block.includes("loadAdminPage"), "route does not use the page loader");
  assert.ok(block.includes("Set-Cookie"), "panel route does not set the session cookie");
  assert.ok(!block.includes("http.request"), "panel route proxies over HTTP");
  assert.ok(!block.includes("fetch("), "panel route fetches upstream");
});

expect("public/admin.html is an optional API-only convenience page", () => {
  const staticPath = path.join(ROOT, "public", "admin.html");
  if (fs.existsSync(staticPath)) {
    const html = fs.readFileSync(staticPath, "utf8");
    assert.ok(html.includes('id="adminTokenInput"'), "admin token input missing");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, "client script missing");
    for (const script of scripts) new Function(script);
    const code = scripts
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.ok(!/fetch\(\s*["'`]https?:/i.test(code), "absolute fetch target");
    assert.ok(!/\bAuthorization\b|\bBearer\b|x-api-key/i.test(code), "provider auth header");
    assert.ok(
      !/\bproxy_pass\b|http-proxy|ProxyAgent|createProxy|\bscrap(e|ing|er)\b|cheerio|puppeteer|playwright/i.test(code),
      "proxy or scraping code",
    );
    assert.ok(/const API = ['"]{2}/.test(code), "API base is not same-origin");
    assert.ok(/X-Admin-Token/i.test(code), "admin token header missing");
  }
  assert.ok(
    !apiSource.includes("// ─── GET /admin/:file"),
    "legacy /admin/:file route still exists",
  );
  assert.ok(!rendered.includes('id="adminTokenInput"'), "legacy admin markup leaked into the module");
  assert.ok(rendered.includes('id="tokenInput"'), "module token input missing");
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

// ── 2. Live gateways: module fallback and static page ─────────
async function liveCheck(options) {
  const mode = options.mode;
  const adminDir = options.adminDir;
  const runTmp = path.join(TMP, mode);
  const dataDir = path.join(runTmp, "data");
  const logDir = path.join(runTmp, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(adminDir, { recursive: true });
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
    APP_ROOT: runTmp,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: dbPath,
    DB_BOOTSTRAP: "1",
    UDS: path.join(runTmp, "mcp.sock"),
    UDS_OPENAI: "0",
    ADMIN_DIR: adminDir,
    INSTANCE_ID: "admin-panel-" + mode + "-" + Date.now(),
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

    const panelMarker =
      mode === "file" ? 'id="adminTokenInput"' : 'data-panel="self-contained"';
    const otherMarker =
      mode === "file" ? 'data-panel="self-contained"' : 'id="adminTokenInput"';
    const modeLabel = mode === "file" ? "static page" : "module fallback";

    await expectAsync("[" + mode + "] GET /admin serves the " + modeLabel, async () => {
      const res = await httpText(port, "/admin", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status + " body=" + res.text.slice(0, 200));
      assert.ok(/text\/html/.test(String(res.headers["content-type"] || "")), "wrong content-type");
      assert.ok(res.text.includes(panelMarker), modeLabel + " marker missing");
      assert.ok(!res.text.includes(otherMarker), "wrong page served");
    });

    await expectAsync("[" + mode + "] GET /admin/ serves the same page", async () => {
      const res = await httpText(port, "/admin/", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status);
      assert.ok(res.text.includes(panelMarker), modeLabel + " marker missing");
    });

    let PANEL_COOKIE = "";
    await expectAsync("[" + mode + "] GET /admin/zombie serves the " + modeLabel + " and mints a session cookie", async () => {
      const res = await httpText(port, "/admin/zombie", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status);
      assert.ok(res.text.includes(panelMarker), modeLabel + " marker missing");
      const raw = res.headers["set-cookie"];
      const first = Array.isArray(raw) ? raw[0] : raw;
      assert.ok(first && String(first).startsWith("zc_panel="), "zc_panel cookie missing");
      PANEL_COOKIE = String(first).split(";")[0];
    });

    await expectAsync("[" + mode + "] GET /admin.html serves the same page", async () => {
      const res = await httpText(port, "/admin.html", "GET", null, 10000);
      assert.strictEqual(res.status, 200, "status=" + res.status);
      assert.ok(res.text.includes(panelMarker), modeLabel + " marker missing");
    });

    await expectAsync("[" + mode + "] admin methods require the panel session and the admin token", async () => {
      const noCookie = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
      });
      assert.strictEqual(noCookie.status, 401, "status=" + noCookie.status);
      assert.ok(/panel session/i.test(noCookie.text), "panel-session error missing");

      const noToken = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        cookie: PANEL_COOKIE,
      });
      assert.strictEqual(noToken.status, 401, "status=" + noToken.status);

      const withBoth = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
        cookie: PANEL_COOKIE,
      });
      assert.strictEqual(withBoth.status, 200, "status=" + withBoth.status);
    });

    await expectAsync("[" + mode + "] OPTIONS advertises the admin methods", async () => {
      const res = await httpText(port, "/api/admin/providers", "OPTIONS", null, 10000, {
        origin: "http://localhost:" + port,
        "access-control-request-method": "POST",
      });
      assert.strictEqual(res.status, 204, "status=" + res.status);
      const methods = String(res.headers["access-control-allow-methods"] || "");
      for (const method of ["GET", "POST", "OPTIONS", "PUT", "DELETE"]) {
        assert.ok(methods.includes(method), "missing method " + method);
      }
      const allowed = String(res.headers["access-control-allow-headers"] || "");
      assert.ok(/x-admin-token/i.test(allowed), "x-admin-token missing from allow-headers");
    });

    await expectAsync("[" + mode + "] the panel's POST creates custom_9 in SQLite", async () => {
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
        { "x-admin-token": ADMIN_TOKEN, cookie: PANEL_COOKIE },
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

    await expectAsync("[" + mode + "] GET returns the row and DELETE removes it", async () => {
      const list = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
        cookie: PANEL_COOKIE,
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
        { "x-admin-token": ADMIN_TOKEN, cookie: PANEL_COOKIE },
      );
      assert.strictEqual(del.status, 200, "status=" + del.status + " body=" + del.text.slice(0, 200));
      const after = await httpJson(port, "/api/admin/providers", "GET", null, 10000, {
        "x-admin-token": ADMIN_TOKEN,
        cookie: PANEL_COOKIE,
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
      fs.rmSync(runTmp, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const emptyDir = path.join(TMP, "empty-admin");
  fs.mkdirSync(emptyDir, { recursive: true });
  await liveCheck({ adminDir: emptyDir, mode: "module" });

  const staticSrc = path.join(ROOT, "public", "admin.html");
  if (fs.existsSync(staticSrc)) {
    const staticDir = path.join(TMP, "static-admin");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.copyFileSync(staticSrc, path.join(staticDir, "admin.html"));
    await liveCheck({ adminDir: staticDir, mode: "file" });
  } else {
    pass("static page absent: file mode skipped (module fallback proven)");
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {
    /* best effort */
  }

  console.log("\npassed=" + passed + " failed=" + failed);
  if (failed > 0) {
    console.error("ADMIN_PAGE_OPTIONAL_FAILED");
    process.exit(1);
  }
  console.log("ADMIN_PAGE_OPTIONAL_OK");
}

main().catch((error) => {
  console.error(
    "ADMIN_PAGE_OPTIONAL_FAILED — " +
      (error && error.stack ? error.stack : error),
  );
  process.exit(1);
});
