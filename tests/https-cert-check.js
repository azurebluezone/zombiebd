#!/usr/bin/env node
"use strict";

/*
 * HTTPS_CERT_OK — proves the loopback TLS contract.
 *
 *   1. The .env certificate paths resolve to real files.
 *   2. The certificate covers 127.0.0.1 and localhost, verifies as
 *      self-signed, and the private key is mode 0600.
 *   3. api.js binds the optional HTTPS and gRPC listeners to the configured
 *      loopback host (BIND_HOST / HTTPS_HOST / GRPC_HOST), never a hardcoded
 *      "localhost".
 *   4. A real isolated boot starts the HTTPS listener and answers
 *      https://127.0.0.1:<HTTPS_PORT>/health with 200.
 *
 * Isolation: DATA_DIR, LOG_DIR, DB, UDS, ZC_DIST_DIR, edge output and the
 * HTTPS port are temporary. The live stack and /etc/caddy are untouched.
 *
 * Run: node tests/https-cert-check.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zc-https-cert-"));
const DATA = path.join(TMP, "data");
const LOGS = path.join(TMP, "logs");

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function envValue(text, key) {
  const match = String(text).match(new RegExp("^" + key + "=(.*)$", "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function resolveFromRoot(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
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

function getJson(port, useTls, pathName, timeoutMs) {
  return new Promise((resolve) => {
    const client = useTls ? https : http;
    const req = client.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "GET",
        timeout: timeoutMs || 4000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", (error) => resolve({ status: 0, body: String(error.message || error) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.end();
  });
}

async function waitHealth(port, useTls, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return null;
    const res = await getJson(port, useTls, "/health");
    if (res.status === 200) return res;
    await sleep(300);
  }
  return null;
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

function bootStack(port, httpsPort, certFile, keyFile) {
  const logFile = path.join(TMP, "boot.log");
  const out = fs.openSync(logFile, "a");
  const env = Object.assign({}, process.env, {
    APP_ROOT: ROOT,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    GRPC: "0",
    GRPC_PORT: String(port + 1),
    HTTPS_PORT: String(httpsPort),
    HTTPS_CERT_PATH: certFile,
    HTTPS_KEY_PATH: keyFile,
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
    DB_SQLITE_PATH: path.join(DATA, "models.db"),
    ZC_DIST_DIR: path.join(TMP, "dist"),
    ZC_SYSTEMD: "0",
    STATUS_INTERVAL_MS: "0",
    EDGE_PROVIDER: "caddy",
    EDGE_APPLY: "0",
    EDGE_OUT_DIR: path.join(TMP, "edge"),
    EDGE_CERT_DIR: path.join(TMP, "edge-certs"),
    CADDY_HTTP_PORT: "18080",
    CADDY_HTTPS_PORT: "18443",
    MAIN_HOST: "127.0.0.1",
    APP_URL: "https://127.0.0.1",
    TOOL_BASE_DOMAIN: "",
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

  // ── static: the optional listeners use the configured loopback host ────
  const apiSrc = read(path.join(ROOT, "api.js"));
  check(
    "api.js defines serviceBindHost and uses it for HTTPS/gRPC",
    /function serviceBindHost\(/.test(apiSrc) &&
      /const httpsHost = serviceBindHost\(/.test(apiSrc) &&
      /const grpcHost = serviceBindHost\(/.test(apiSrc),
  );
  check(
    "api.js no longer hardcodes localhost for HTTPS/gRPC listen",
    !/httpsServer\.listen\(httpsPort,\s*"localhost"/.test(apiSrc) &&
      !/createGrpcServer\(\{[\s\S]{0,200}?host:\s*"localhost"/.test(apiSrc),
  );
  check(
    "api.js logs the HTTPS listen host",
    /HTTPS_LISTENING",\s*\{\s*port:\s*httpsPort,\s*host:\s*httpsHost/.test(apiSrc),
  );

  const envText = read(path.join(ROOT, ".env"));
  const certPath = resolveFromRoot(envValue(envText, "HTTPS_CERT_PATH"));
  const keyPath = resolveFromRoot(envValue(envText, "HTTPS_KEY_PATH"));
  check(
    ".env HTTPS_CERT_PATH/KEY_PATH resolve under data/certs",
    certPath.includes(path.join(ROOT, "data", "certs")) &&
      keyPath.includes(path.join(ROOT, "data", "certs")),
    "cert=" + certPath + " key=" + keyPath,
  );

  // ── certificate material ───────────────────────────────────────────────
  check("HTTPS certificate exists", fs.existsSync(certPath), certPath);
  check("HTTPS private key exists", fs.existsSync(keyPath), keyPath);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const subject = execFileSync(
      "openssl",
      ["x509", "-in", certPath, "-noout", "-subject", "-ext", "subjectAltName"],
      { encoding: "utf8" },
    );
    check(
      "certificate covers 127.0.0.1 and localhost",
      /IP Address:127\.0\.0\.1/.test(subject) && /DNS:localhost/.test(subject),
      subject.trim().split(/\r?\n/).slice(-2).join(" | "),
    );
    let verified = "";
    try {
      verified = execFileSync(
        "openssl",
        ["verify", "-CAfile", certPath, certPath],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    } catch (error) {
      verified = String(error.stderr || error.message || error).trim();
    }
    check("certificate verifies as self-signed", /: OK$/.test(verified), verified);
    const mode = fs.statSync(keyPath).mode & 0o777;
    check("private key mode is 0600", mode === 0o600, "mode=" + mode.toString(8));
  }

  // ── real isolated boot: HTTPS /health over 127.0.0.1 ───────────────────
  const port = await freePort();
  const httpsPort = await freePort();
  const boot = bootStack(port, httpsPort, certPath, keyPath);
  const httpHealth = await waitHealth(port, false, boot.child, 90000);
  check("isolated boot answers HTTP /health 200", !!httpHealth, "port=" + port);

  let httpsHealth = null;
  if (httpHealth) {
    httpsHealth = await waitHealth(httpsPort, true, boot.child, 20000);
  }
  check(
    "isolated boot answers https://127.0.0.1:<HTTPS_PORT>/health 200",
    !!httpsHealth,
    "https_port=" + httpsPort + " status=" + (httpsHealth ? httpsHealth.status : 0),
  );

  const bootLog = read(boot.logFile);
  check(
    "boot logged HTTPS_LISTENING on the loopback host",
    /HTTPS_LISTENING/.test(bootLog) &&
      new RegExp('"port":' + httpsPort).test(bootLog) &&
      /"host":"127\.0\.0\.1"/.test(bootLog),
    (bootLog.match(/HTTPS_LISTENING[^\n]*/) || [""])[0],
  );
  check("boot logged no HTTPS_ERROR", !/HTTPS_ERROR/.test(bootLog));

  await stop(boot.child);

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    const tail = bootLog.split(/\r?\n/).slice(-30).join("\n");
    if (tail) console.log("\n--- boot.log (tail) ---\n" + tail);
    process.exit(1);
  }
  console.log("HTTPS_CERT_OK");
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
