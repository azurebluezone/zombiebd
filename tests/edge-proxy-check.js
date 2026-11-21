#!/usr/bin/env node
"use strict";

/*
 * EDGE_PROXY_OK — proves the edge + token-accounting contract with real runs.
 *
 *   1. modules/edge-proxy.js renders Caddy and nginx from env values:
 *      MAIN_HOST/APP_URL, PORT, CADDY_HTTP_PORT, CADDY_HTTPS_PORT, TLS_MODE.
 *   2. Caddy's rendered config passes `caddy validate`.
 *   3. nginx gets a self-signed localhost certificate with SAN
 *      DNS:localhost + IP:127.0.0.1 (nginx -t is skipped when nginx is absent).
 *   4. /admin and /api/admin are answered 404 at the edge, before the
 *      catch-all reverse_proxy — admin stays loopback-only.
 *   5. A real isolated boot creates request_log.prompt_tokens /
 *      completion_tokens / total_tokens and writes the edge block into
 *      data/startup-config.json.
 *   6. The MCP tools/list response is measured (the ~42 KB / ~29-packet
 *      payload the operator sees in the logs).
 *   7. The Bengali audit MP3 exists, decodes and is longer than 60 seconds.
 *
 * Isolation: ZC_DIST_DIR, DATA_DIR, LOG_DIR, DB, UDS, PORT and EDGE_OUT_DIR
 * are temporary. The live stack and the live /etc/caddy/Caddyfile are not
 * touched (EDGE_APPLY=0).
 *
 * Run: node tests/edge-proxy-check.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const { spawn, execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zc-edge-proxy-"));
const DATA = path.join(TMP, "data");
const LOGS = path.join(TMP, "logs");
const DB_PATH = path.join(DATA, "models.db");
const EDGE_OUT = path.join(TMP, "edge");
const CERTS = path.join(TMP, "certs");
const AUDIO = path.join(
  os.homedir(),
  "Music",
  "mp3",
  "zc lama",
  "zc-edge-audit-2026-11-21.mp3",
);

let pass = 0;
let fail = 0;
let skipped = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

function skip(name, reason) {
  skipped++;
  console.log("SKIP " + name + "  [" + reason + "]");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, method, pathName, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        timeout: 5000,
        headers: Object.assign(
          { Accept: "application/json, text/event-stream" },
          payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {},
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, bytes: buffer.length, body: buffer.toString("utf8") });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, bytes: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, bytes: 0, body: "" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealth(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const res = await httpJson(port, "GET", "/health");
    if (res.status === 200) return true;
    await sleep(300);
  }
  return false;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 8000;
  while (
    Date.now() < deadline &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    await sleep(100);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await sleep(500);
  }
}

function bootStack(port) {
  const logFile = path.join(TMP, "boot.log");
  const out = fs.openSync(logFile, "a");
  const env = Object.assign({}, process.env, {
    APP_ROOT: ROOT,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    GRPC: "0",
    GRPC_PORT: String(port + 1),
    HTTPS_PORT: String(port + 2),
    BRIDGE_AUTORUN: "0",
    BRIDGE_PORT: String(port + 3),
    UDS: path.join(TMP, "mcp.sock"),
    UDS_PATH: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "0",
    DATA_DIR: DATA,
    LOG_DIR: LOGS,
    CACHE_DIR: path.join(TMP, "cache"),
    LOCK_DIR: path.join(TMP, "locks"),
    MCP_CLIENTS_FILE: path.join(DATA, "mcp-clients.json"),
    DB_SQLITE_PATH: DB_PATH,
    ZC_DIST_DIR: path.join(TMP, "dist"),
    ZC_SYSTEMD: "0",
    STATUS_INTERVAL_MS: "0",
    EDGE_PROVIDER: "caddy",
    EDGE_APPLY: "0",
    EDGE_OUT_DIR: EDGE_OUT,
    EDGE_CERT_DIR: CERTS,
    CADDY_HTTP_PORT: "18080",
    CADDY_HTTPS_PORT: "18443",
    MAIN_HOST: "localhost",
    APP_URL: "https://localhost",
    TLS_MODE: "internal",
  });
  delete env.DB_BOOTSTRAP;
  delete env.ZC_SKIP_BUILD;
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "start.js"), "--start-all", "-s"],
    { cwd: ROOT, env, stdio: ["ignore", out, out] },
  );
  return { child, logFile };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  // ── static: the dead outbound proxy stub is gone ────────────────────────
  const apiSrc = read(path.join(ROOT, "api.js"));
  check(
    "api.js no longer reads PROXY_LIST / CUSTOM_PROXY_API_KEY",
    !/PROXY_LIST|proxyListState|CUSTOM_PROXY_API_KEY/.test(apiSrc),
  );
  check(
    "api.js request_log DDL has token columns",
    /prompt_tokens INTEGER DEFAULT 0/.test(apiSrc) &&
      /completion_tokens INTEGER DEFAULT 0/.test(apiSrc) &&
      /total_tokens INTEGER DEFAULT 0/.test(apiSrc),
  );
  check(
    "api.js request_log INSERT records token columns",
    apiSrc.includes("prompt_tokens, completion_tokens, total_tokens"),
  );
  const envText = read(path.join(ROOT, ".env"));
  check(
    ".env has no orphan CUSTOM_PROXY_API_KEY",
    !envText.includes("CUSTOM_PROXY_API_KEY"),
  );

  const startSrc = read(path.join(ROOT, "start.js"));
  check(
    "start.js requires modules/edge-proxy and logs [EDGE]",
    startSrc.includes('require("./modules/edge-proxy")') &&
      startSrc.includes("[EDGE] "),
  );

  // ── render both providers from env ──────────────────────────────────────
  const edge = require("../modules/edge-proxy");
  const env = {
    EDGE_PROVIDER: "caddy",
    PORT: "5050",
    CADDY_HTTP_PORT: "18080",
    CADDY_HTTPS_PORT: "18443",
    MAIN_HOST: "localhost",
    APP_URL: "https://localhost",
    TLS_MODE: "internal",
    TOOL_BASE_DOMAIN: "",
    EDGE_OUT_DIR: EDGE_OUT,
    EDGE_CERT_DIR: CERTS,
  };
  const cfg = edge.resolveEdgeConfig({ root: ROOT, env });
  check(
    "edge config resolves host + ports from env",
    cfg.mainHost === "localhost" &&
      cfg.apiPort === 5050 &&
      cfg.httpPort === 18080 &&
      cfg.httpsPort === 18443 &&
      cfg.tlsMode === "internal",
    "host=" + cfg.mainHost + " api=" + cfg.apiPort + " http=" + cfg.httpPort + " https=" + cfg.httpsPort,
  );

  const caddy = edge.renderCaddy(cfg);
  check("Caddy renders http_port 18080", caddy.includes("http_port 18080"));
  check("Caddy renders https_port 18443", caddy.includes("https_port 18443"));
  check("Caddy renders the main host", caddy.includes("https://localhost {"));
  check("Caddy uses tls internal (self-signed localhost)", caddy.includes("tls internal"));
  check(
    "Caddy proxies the API on loopback",
    caddy.includes("reverse_proxy 127.0.0.1:5050"),
  );
  check(
    "Caddy blocks /admin and /api/admin before the catch-all",
    caddy.includes("@admin path /admin* /api/admin*") &&
      caddy.includes("respond @admin 404") &&
      caddy.indexOf("respond @admin 404") < caddy.indexOf("reverse_proxy 127.0.0.1:5050"),
  );

  const nginx = edge.renderNginx(cfg);
  check("nginx renders :18080 -> :18443 redirect", nginx.includes("listen 18080;") && nginx.includes("return 301 https://$host$request_uri;"));
  check("nginx renders the TLS listener", nginx.includes("listen 18443 ssl;"));
  check("nginx references the self-signed cert", nginx.includes("ssl_certificate \""));
  check("nginx proxies the API on loopback", nginx.includes("proxy_pass http://127.0.0.1:5050;"));
  check(
    "nginx blocks /admin and /api/admin with 404",
    nginx.includes("location ^~ /api/admin") &&
      nginx.includes("location ^~ /admin") &&
      (nginx.match(/return 404;/g) || []).length >= 2,
  );

  fs.mkdirSync(EDGE_OUT, { recursive: true });
  const caddyFile = path.join(EDGE_OUT, "Caddyfile");
  fs.writeFileSync(caddyFile, caddy, "utf8");
  const caddyCheck = edge.validateCaddy(caddyFile);
  check(
    "caddy validate accepts the rendered config",
    caddyCheck.ok,
    caddyCheck.error || caddyCheck.output,
  );

  const nginxFile = path.join(EDGE_OUT, "nginx.conf");
  fs.writeFileSync(nginxFile, nginx, "utf8");
  const nginxCheck = edge.validateNginx(nginxFile);
  if (nginxCheck.skipped) skip("nginx -t accepts the rendered config", nginxCheck.reason);
  else check("nginx -t accepts the rendered config", nginxCheck.ok, nginxCheck.error || "");

  const self = edge.ensureSelfSigned(cfg);
  check(
    "nginx self-signed localhost certificate exists",
    fs.existsSync(cfg.certFile) && fs.existsSync(cfg.keyFile),
    self.created ? "created" : "reused",
  );
  if (fs.existsSync(cfg.certFile)) {
    const cert = execFileSync(
      "openssl",
      ["x509", "-in", cfg.certFile, "-noout", "-subject", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    check(
      "certificate covers localhost and 127.0.0.1",
      /DNS:localhost/.test(cert) && /IP Address:127\.0\.0\.1/.test(cert),
      cert.trim().split(/\r?\n/).slice(-2).join(" | "),
    );
  } else {
    check("certificate covers localhost and 127.0.0.1", false, "certificate missing");
  }

  // ── real isolated boot: DB columns + seed snapshot + MCP payload ────────
  const port = await freePort();
  const boot = bootStack(port);
  const healthy = await waitHealth(port, boot.child, 90000);
  check("isolated boot answers /health 200", healthy, "port=" + port);
  const bootLog = read(boot.logFile);
  check(
    "boot rendered and validated the edge",
    /\[EDGE\] provider=caddy .*validate=ok/.test(bootLog),
    (bootLog.match(/\[EDGE\][^\n]*/) || [""])[0],
  );

  if (healthy) {
    // External MCP servers are stdio children that autoConnect asynchronously.
    // The base registry answers immediately; wait for the merged tools so the
    // payload measurement reflects what the operator sees in the logs.
    let mcp = { bytes: 0, body: "" };
    let toolCount = 0;
    const mcpDeadline = Date.now() + 35000;
    while (Date.now() < mcpDeadline) {
      mcp = await httpJson(port, "POST", "/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      try {
        const line =
          mcp.body.split(/\r?\n/).find((l) => l.startsWith("data: ")) || mcp.body;
        const parsed = JSON.parse(line.replace(/^data: /, ""));
        toolCount = ((parsed.result && parsed.result.tools) || []).length;
      } catch (_) {
        toolCount = 0;
      }
      if (mcp.bytes > 40000) break;
      await sleep(2000);
    }
    check(
      "MCP tools/list payload is the ~42 KB source",
      mcp.bytes > 40000,
      "bytes=" +
        mcp.bytes +
        " tools=" +
        toolCount +
        " packets~" +
        Math.ceil(mcp.bytes / 1448),
    );

    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const cols = db
        .prepare("PRAGMA table_info(request_log)")
        .all()
        .map((c) => c.name);
      check(
        "request_log has prompt/completion/total token columns",
        ["prompt_tokens", "completion_tokens", "total_tokens"].every((c) =>
          cols.includes(c),
        ),
        cols.join(","),
      );
      const agents = db.prepare("SELECT COUNT(*) c FROM agents").get().c;
      check("boot seeded all 9 agents", agents >= 9, "agents=" + agents);
    } finally {
      db.close();
    }

    const snapshotFile = path.join(DATA, "startup-config.json");
    let snapshot = null;
    try {
      snapshot = JSON.parse(read(snapshotFile));
    } catch (_) {}
    check(
      "data/startup-config.json carries the edge block",
      snapshot &&
        snapshot.edge &&
        snapshot.edge.provider === "caddy" &&
        String(snapshot.edge.httpPort) === "18080" &&
        String(snapshot.edge.httpsPort) === "18443" &&
        snapshot.edge.tlsMode === "internal" &&
        Array.isArray(snapshot.edge.adminPaths) &&
        snapshot.edge.adminPaths.includes("/api/admin"),
      snapshot && snapshot.edge ? JSON.stringify(snapshot.edge) : "missing",
    );
  }

  await stop(boot.child);

  // ── the Bengali audit MP3 is real, not a placeholder ────────────────────
  check("audit MP3 exists", fs.existsSync(AUDIO), AUDIO);
  if (fs.existsSync(AUDIO)) {
    const size = fs.statSync(AUDIO).size;
    let duration = 0;
    try {
      duration = Number(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", AUDIO],
          { encoding: "utf8" },
        ).trim(),
      );
    } catch (_) {}
    check("audit MP3 is longer than 60 seconds", duration > 60, "duration=" + duration + "s size=" + size + "B");
    let decodes = true;
    try {
      execFileSync("ffmpeg", ["-v", "error", "-i", AUDIO, "-f", "null", "-"], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (_) {
      decodes = false;
    }
    check("audit MP3 decodes without errors", decodes);
  } else {
    check("audit MP3 is longer than 60 seconds", false, "missing");
    check("audit MP3 decodes without errors", false, "missing");
  }

  console.log("\n" + pass + " passed, " + fail + " failed, " + skipped + " skipped");
  if (fail > 0) {
    const tail = bootLog.split(/\r?\n/).slice(-40).join("\n");
    if (tail) {
      console.log("\n--- boot.log (tail) ---\n" + tail);
    }
    process.exit(1);
  }
  console.log("EDGE_PROXY_OK");
}

main()
  .catch((error) => {
    console.error("FAIL " + (error && error.stack ? error.stack : String(error)));
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {}
  });
