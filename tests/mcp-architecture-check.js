#!/usr/bin/env node
"use strict";

/**
 * tests/mcp-architecture-check.js
 *
 * Release gate for the MCP transport and admin-routes architecture:
 *
 *   1. local MCP servers run over stdio; the port launcher, combined gateway
 *      and invalid skill MCP are gone from runtime code;
 *   2. the generated editor config anchors the UDS under APP_ROOT, never
 *      under dist/data;
 *   3. the gateway boots with no admin UI directory, keeps serving /health,
 *      and the optional panel mints the session cookie that admin/curl writes
 *      need (token alone is not enough);
 *   4. an admin/curl-added HTTP MCP with a bearer token is discovered, its
 *      token is sent upstream, and it is persisted encrypted in SQLite.
 *
 * Prints MCP_STDIO_ADMIN_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(os.tmpdir(), "opencode", "mcp-architecture-" + process.pid);
const ADMIN_TOKEN = "mcp-architecture-token";
const AGENT_ID = "mcp-arch-agent";
const REMOTE_NAME = "figma-test";
const REMOTE_TOKEN = "tok-figma-secret";

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

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function exists(file) {
  return fs.existsSync(path.join(ROOT, file));
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

function httpJson(port, requestPath, method, body, headers, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const requestHeaders = Object.assign({}, headers || {});
    if (payload) {
      requestHeaders["Content-Type"] = "application/json";
      requestHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method,
        headers: requestHeaders,
        timeout: timeoutMs || 10000,
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
          resolve({ status: res.statusCode, json, text, headers: res.headers });
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

async function panelCookie(port) {
  const admin = await httpJson(port, "/admin", "GET");
  assert.strictEqual(admin.status, 200, "panel status=" + admin.status);
  const raw = admin.headers && admin.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const cookie = list
    .map((value) => String(value).split(";")[0])
    .filter(Boolean)
    .join("; ");
  assert.ok(cookie, "panel did not set a session cookie");
  return cookie;
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health", "GET", null, null, 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
    await sleep(250);
  }
  return null;
}

async function waitFor(fn, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs || 250);
  }
  return null;
}

function startRemoteStub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ authorization: req.headers.authorization || "", body });
      let msg = {};
      try {
        msg = JSON.parse(body);
      } catch (_) {
        /* reply parse error below */
      }
      let result = {};
      if (msg.method === "initialize") {
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "remote-stub", version: "1.0.0" },
        };
      } else if (msg.method === "tools/list") {
        result = {
          tools: [
            {
              name: "echo",
              description: "Echo text",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        };
      } else if (msg.method === "tools/call") {
        result = { content: [{ type: "text", text: "REMOTE_OK" }] };
      } else if (msg.method === "notifications/initialized") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id != null ? msg.id : null, result }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
}

// ── 1. Removed runtime files ────────────────────────────────
check("start-local-mcp.js is gone", () => {
  assert.ok(!exists("start-local-mcp.js"), "port launcher still exists");
});
check("combined.js is gone", () => {
  assert.ok(!exists("external mcp/combined.js"), "combined gateway still exists");
});
check("skill-mcp-tool.js is gone", () => {
  assert.ok(!exists("external mcp/skill-mcp-tool.js"), "invalid skill MCP still exists");
});
check("root admin-api.js is gone; core lib/admin-routes.js owns the routes", () => {
  assert.ok(!exists("admin-api.js"), "root admin-api.js still exists");
  assert.ok(exists("lib/admin-routes.js"), "lib/admin-routes.js missing");
  assert.ok(read("api.js").includes('require("./lib/admin-routes")'), "api.js does not require lib/admin-routes");
  assert.ok(!read("api.js").includes('require("./admin-api")'), "api.js still requires root admin-api");
});

// ── 2. Runtime source references ────────────────────────────
check("start.js no longer starts the port launcher", () => {
  assert.ok(!read("start.js").includes("startLocalServers"), "startLocalServers still referenced");
  assert.ok(!read("start.js").includes("start-local-mcp"), "start-local-mcp still referenced");
});
check("build/package/tests drop the retired files", () => {
  assert.ok(!read("scripts/build.js").includes("start-local-mcp.js"), "build copy list still has start-local-mcp.js");
  assert.ok(!read("scripts/build.js").includes('"admin-api.js"'), "build copy list still has admin-api.js");
  assert.ok(!read("tests/broker-free-check.js").includes("start-local-mcp.js"), "broker-free still lists start-local-mcp.js");
  assert.ok(!read("external mcp/package.json").includes("combined"), "external mcp package still references combined");
});
check("api.js has no MCP port-forwarding table", () => {
  const source = read("api.js");
  assert.ok(!source.includes("MCP_TABLE"), "MCP_TABLE still present");
  assert.ok(!source.includes("Unknown MCP server:"), "/mcp/<name> forward route still present");
});

// ── 3. stdio configuration ──────────────────────────────────
for (const file of ["external mcp/servers.json", "external mcp/servers.example.json"]) {
  check(file + " local servers are stdio and portless", () => {
    const parsed = JSON.parse(read(file));
    const local = (parsed.servers || []).filter((s) => s && s.local === true);
    assert.ok(local.length > 0, "no local servers");
    for (const server of local) {
      assert.strictEqual(server.transport, "stdio", server.name + " transport=" + server.transport);
      assert.ok(!server.url, server.name + " still has a url");
      assert.ok(server.script, server.name + " has no script");
    }
    assert.ok(!(parsed.servers || []).some((s) => s && s.name === "combined"), "combined entry still present");
  });
}
check("external-mcp.js has a real stdio client path", () => {
  const source = read("external-mcp.js");
  assert.ok(source.includes("createStdioClient"), "createStdioClient missing");
  assert.ok(source.includes('"stdio"'), "stdio transport missing");
  assert.ok(source.includes("stdioServers"), "stdio server registry missing");
});
check("public-api and facebook-ads expose stdio", () => {
  for (const file of ["external mcp/public-api-mcp.js", "external mcp/facebook-ads-mcp.js"]) {
    const source = read(file);
    assert.ok(source.includes("wantsStdio()"), file + " has no wantsStdio branch");
    assert.ok(source.includes("serveStdio("), file + " has no serveStdio call");
  }
});
check(".env.example and lib/env.js drop the retired local ports", () => {
  for (const key of ["OCR_MCP_PORT", "SCREEN_MCP_PORT", "TTS_MCP_PORT", "COMBINED_MCP_PORT", "PUBLIC_API_MCP_PORT", "FB_ADS_MCP_PORT"]) {
    assert.ok(!read(".env.example").includes(key), ".env.example still has " + key);
    assert.ok(!read("lib/env.js").includes(key), "lib/env.js still has " + key);
  }
});

// ── 4. Live gateway: stdio, APP_ROOT config, admin DB write ─
(async () => {
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const mcpConfig = path.join(TMP, "servers.json");
  fs.writeFileSync(
    mcpConfig,
    JSON.stringify({
      servers: [
        {
          name: "public-api",
          transport: "stdio",
          enabled: true,
          autoConnect: true,
          local: true,
          script: "external mcp/public-api-mcp.js",
        },
      ],
    }),
  );

  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();
  const dbPath = path.join(dataDir, "models.db");
  const udsPath = path.join(dataDir, "run", "mcp.sock");
  const adminDir = path.join(TMP, "admin-does-not-exist");

  const env = Object.assign({}, process.env, {
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
    UDS: path.join("data", "run", "mcp.sock"),
    UDS_OPENAI: "0",
    INSTANCE_ID: "mcp-architecture-" + Date.now(),
    ADMIN_TOKEN,
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    ADMIN_DIR: adminDir,
    EXTERNAL_MCP_CONFIG: mcpConfig,
    EXTERNAL_MCP_URLS: "",
    REMOTE_MCP_SERVERS: "",
    MCP_STDIO_TIMEOUT_MS: "20000",
    BRIDGE_ENABLED: "0",
    OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
  });

  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", (chunk) => (output += chunk.toString()));

  let stub = null;
  try {
    const health = await waitHealth(port, 60000);
    if (!health) {
      fail("gateway boots with no admin UI directory", "no /health\n" + output.slice(-3000));
      return;
    }
    pass("gateway boots with no admin UI directory", "agents=" + health.agents + " models=" + health.models);

    await checkAsync("generated UDS config resolves under APP_ROOT, not dist", async () => {
      const cfgPath = path.join(TMP, ".missionbarisal", "mcp-config.json");
      assert.ok(fs.existsSync(cfgPath), "mcp-config.json missing at " + cfgPath);
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.strictEqual(cfg.endpoints.uds, udsPath, "uds=" + cfg.endpoints.uds);
      assert.ok(!cfg.endpoints.uds.includes(path.sep + "dist" + path.sep), "config contains dist/data");
      const vscode = JSON.parse(fs.readFileSync(path.join(TMP, ".missionbarisal", "vscode.json"), "utf8"));
      assert.strictEqual(vscode.settings["mission-barisal.udsPath"], udsPath);
    });

    await checkAsync("UDS socket is bound under APP_ROOT", async () => {
      const bound = await waitFor(() => fs.existsSync(udsPath) && fs.statSync(udsPath).isSocket(), 15000);
      assert.ok(bound, "socket missing: " + udsPath);
    });

    await checkAsync("stdio MCP server reports tools through the gateway", async () => {
      const row = await waitFor(async () => {
        const res = await httpJson(port, "/api/mcp-external");
        const found = ((res.json && res.json.servers) || []).find((s) => s.name === "public-api");
        return found && found.status === "connected" && found.tools > 0 ? found : null;
      }, 45000);
      assert.ok(row, "public-api not connected via stdio");
      assert.strictEqual(row.transport, "stdio");
      assert.ok(row.tools > 0, "tools=" + row.tools);
    });

    await checkAsync("optional admin panel serves and mints a session cookie", async () => {
      const cookie = await panelCookie(port);
      assert.ok(cookie, "empty cookie");
      const again = await httpJson(port, "/health", "GET");
      assert.strictEqual(again.status, 200);
    });

    await checkAsync("admin API rejects a request without a token", async () => {
      const res = await httpJson(port, "/api/admin/agents", "GET");
      assert.strictEqual(res.status, 401, "status=" + res.status);
    });

    await checkAsync("a bare token cannot drive admin writes", async () => {
      const res = await httpJson(port, "/api/admin/agents", "GET", null, {
        "x-admin-token": ADMIN_TOKEN,
      });
      assert.strictEqual(res.status, 401, "status=" + res.status);
    });

    await checkAsync("curl-equivalent admin POST writes the SQLite DB", async () => {
      const headers = { "x-admin-token": ADMIN_TOKEN, cookie: await panelCookie(port) };
      const write = await httpJson(
        port,
        "/api/admin/agents",
        "POST",
        { id: AGENT_ID, name: "MCP Arch Agent", role: "general", persona: "test", enabled: true },
        headers,
      );
      assert.strictEqual(write.status, 200, "status=" + write.status + " body=" + write.text.slice(0, 300));

      const list = await httpJson(port, "/api/admin/agents", "GET", null, headers);
      assert.strictEqual(list.status, 200);
      assert.ok(
        ((list.json && list.json.agents) || []).some((agent) => agent.id === AGENT_ID),
        "agent missing from admin GET",
      );

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("SELECT id, name FROM agents WHERE id = ?").get(AGENT_ID);
      db.close();
      assert.ok(row, "agent row missing from SQLite");
      assert.strictEqual(row.name, "MCP Arch Agent");
    });

    // ── 5. Admin-added HTTP MCP: token sent upstream + encrypted in DB ──
    stub = await startRemoteStub();
    const remoteUrl = "http://127.0.0.1:" + stub.port + "/mcp";

    await checkAsync("admin/curl adds an HTTP MCP and stores it encrypted", async () => {
      const headers = { "x-admin-token": ADMIN_TOKEN, cookie: await panelCookie(port) };
      const added = await httpJson(
        port,
        "/api/mcp-remote/add",
        "POST",
        { url: remoteUrl, name: REMOTE_NAME, token: REMOTE_TOKEN },
        headers,
      );
      assert.strictEqual(added.status, 200, "status=" + added.status + " body=" + added.text.slice(0, 300));
      assert.ok(added.json && added.json.ok, "add not ok");
      assert.strictEqual(added.json.server.status, "connected", "server status=" + (added.json.server && added.json.server.status));
      assert.strictEqual(added.json.server.token, undefined, "add response leaked token");

      const withAuth = stub.seen.find((entry) => entry.authorization === "Bearer " + REMOTE_TOKEN);
      assert.ok(withAuth, "upstream never received Authorization: Bearer");

      const listed = await httpJson(port, "/api/mcp-remote", "GET");
      const row = ((listed.json && listed.json.servers) || []).find((s) => s.name === REMOTE_NAME);
      assert.ok(row, "added server missing from /api/mcp-remote");
      assert.strictEqual(row.token, undefined, "/api/mcp-remote leaked token");

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const savedRow = db.prepare("SELECT value FROM settings WHERE key = 'remote_mcp_servers'").get();
      db.close();
      assert.ok(savedRow && savedRow.value, "remote_mcp_servers setting missing");
      const saved = JSON.parse(savedRow.value);
      const savedRemote = saved.find((s) => s.name === REMOTE_NAME);
      assert.ok(savedRemote, "server missing from persisted settings");
      assert.ok(String(savedRemote.token).startsWith("enc:v1:"), "token is not encrypted");
      assert.ok(!String(savedRemote.token).includes(REMOTE_TOKEN), "plaintext token persisted");
    });

    await checkAsync("admin/curl removes the HTTP MCP and updates the DB", async () => {
      const headers = { "x-admin-token": ADMIN_TOKEN, cookie: await panelCookie(port) };
      const removed = await httpJson(
        port,
        "/api/mcp-remote/remove",
        "POST",
        { name: REMOTE_NAME },
        headers,
      );
      assert.strictEqual(removed.status, 200, "status=" + removed.status);
      assert.strictEqual(removed.json && removed.json.ok, true);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const savedRow = db.prepare("SELECT value FROM settings WHERE key = 'remote_mcp_servers'").get();
      db.close();
      const saved = savedRow && savedRow.value ? JSON.parse(savedRow.value) : [];
      assert.ok(!saved.some((s) => s.name === REMOTE_NAME), "server still persisted after remove");
    });
  } finally {
    if (stub) await new Promise((resolve) => stub.server.close(resolve));
    await stopChild(child);
    if (failed === 0) {
      try {
        fs.rmSync(TMP, { recursive: true, force: true });
      } catch (_) {
        /* leave the temp tree for inspection on failure */
      }
    }
  }

  console.log("\nchecks=" + (passed + failed) + " pass=" + passed + " fail=" + failed);
  if (failed === 0) {
    console.log("MCP_STDIO_ADMIN_OK");
  } else {
    console.log("MCP_STDIO_ADMIN_FAIL");
    process.exitCode = 1;
  }
})().catch((error) => {
  fail("unexpected test failure", error && error.stack ? error.stack : String(error));
  console.log("\nchecks=" + (passed + failed) + " pass=" + passed + " fail=" + failed);
  console.log("MCP_STDIO_ADMIN_FAIL");
  process.exitCode = 1;
});
