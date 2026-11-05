#!/usr/bin/env node
/**
 * index.js — ZombieCoder Universal Transport Adapter
 * ═══════════════════════════════════════════════════════════════════════
 * One process, three transports, one MCP tool registry.
 *
 *   HTTP    → http://127.0.0.1:5400/mcp      (no TLS, loopback)
 *   HTTPS   → https://localhost:5443/mcp     (self-signed TLS)
 *   stdio   → spawned as a subprocess, JSON on stdin/stdout
 *
 * Usage:
 *   node index.js                 start HTTP + HTTPS + TLS + client scan
 *   node index.js --stdio         stdio only (this is what desktop clients spawn)
 *   node index.js --scan          list detected client configs, change nothing
 *   node index.js --register      actually write the adapter into those configs
 *   node index.js --verify        self-check: hit every transport and print proof
 */
"use strict";

// stdio mode: stdout IS the JSON-RPC channel — a single stray console.log
// corrupts the stream. The unified logger must be file-only here, so set the
// switch BEFORE any module (transports → registry → main-sync) loads zc-log.
if (process.argv.includes("--stdio")) process.env.ZC_LOG_CONSOLE = "0";

const path = require("path");
const http = require("http");
const https = require("https");
const { startHTTP, startHTTPS } = require("./transport-http");
const stdio = require("./transport-stdio");
const discover = require("./discover");
const registry = require("./registry");
const tls = require("./tls");
const zclog = require("../lib/zc-log");

const HTTP_PORT = parseInt(process.env.ADAPTER_HTTP_PORT || "5400", 10);
const HTTPS_PORT = parseInt(process.env.ADAPTER_HTTPS_PORT || "5443", 10);
const HOST = process.env.ADAPTER_HOST || "127.0.0.1";

const arg = (name) => process.argv.includes(name);
const valueOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const log = (...a) => console.log("[adapter]", ...a);
const bar = () => console.log("─".repeat(68));

function banner(modes) {
  bar();
  log("ZombieCoder Universal Transport Adapter v1.0.0");
  bar();
  log("root allowed :", registry.ROOTS.join(", "));
  log("tools (local):", registry.listTools().length, "→", registry.listTools().join(", "));
  const remote = registry.mainSync.status();
  log(
    "tools (main) :",
    remote.tools,
    remote.reachable ? `pulled from ${remote.url}` : `UNREACHABLE — ${remote.error || "not synced yet"}`,
  );
  log("tools (total):", registry.listTools().length + registry.mainSync.list().filter((t) => !registry.listTools().includes(t.name)).length);
  log("transports   :", modes.join(", "));
  bar();
}

// ─── Verification: prove every transport really answers ──────────────────────

function request(lib, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(
      {
        method: body ? "POST" : "GET",
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        rejectUnauthorized: false, // our cert is self-signed by design
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function verify(modes) {
  let pass = 0,
    fail = 0;
  const ok = (name, cond, detail = "") => {
    if (cond) {
      pass++;
      console.log("  ✅ " + name);
    } else {
      fail++;
      console.log("  ❌ " + name + (detail ? "  → " + detail : ""));
    }
  };
  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const CALL = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "system_info", arguments: {} } };

  if (modes.includes("http")) {
    const base = `http://127.0.0.1:${HTTP_PORT}`;
    let r;
    try {
      r = await request(http, `${base}/mcp`, INIT);
      const j = JSON.parse(r.body);
      ok(`HTTP  initialize`, r.status === 200 && j.result?.serverInfo?.name === "zombie-universal-adapter", r.body.slice(0, 80));
      r = await request(http, `${base}/mcp`, LIST);
      const n = JSON.parse(r.body).result.tools.length;
      ok(`HTTP  tools/list (${n} tools)`, n >= 8);
      r = await request(http, `${base}/mcp`, CALL);
      const info = JSON.parse(JSON.parse(r.body).result.content[0].text);
      ok(`HTTP  tools/call system_info`, typeof info.hostname === "string" && typeof info.node === "string");
    } catch (e) {
      ok("HTTP  reachable", false, e.message);
    }
    try {
      const r = await request(http, `${base}/health`);
      ok("HTTP  /health status page", r.status === 200);
    } catch (e) {
      ok("HTTP  /health status page", false, e.message);
    }
  }

  if (modes.includes("https")) {
    const base = `https://127.0.0.1:${HTTPS_PORT}`;
    try {
      const r = await request(https, `${base}/mcp`, INIT);
      const j = JSON.parse(r.body);
      ok("HTTPS initialize (TLS handshake)", r.status === 200 && !!j.result, r.body.slice(0, 80));
      const r2 = await request(https, `${base}/mcp`, CALL);
      ok("HTTPS tools/call system_info", r2.status === 200);
    } catch (e) {
      ok("HTTPS reachable", false, e.message);
    }
    // Prove the certificate is really there and really ours.
    const c = tls.ensure(["localhost", "127.0.0.1"]);
    ok("TLS  certificate present", !!c.cert && !!c.key);
    log("     fingerprint:", tls.fingerprint());
    log("     cert file   :", tls.CRT_FILE);
  }

  // stdio cannot be checked from inside the same process, so exercise the
  // dispatcher directly — that is the exact code path stdio runs.
  {
    const r = await registry.handleRpc(LIST);
    ok(`stdio tools/list (${r.result.tools.length} tools, same dispatcher)`, r.result.tools.length >= 8);
    const c = await registry.handleRpc(CALL);
    ok("stdio tools/call system_info", !!c.result.content[0].text.includes("hostname"));
    const bad = await registry.handleRpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } });
    ok("stdio rejects an unknown tool", !!bad.error);
  }

  bar();
  console.log(`  SELFTEST: ${pass} passed, ${fail} failed`);
  bar();
  return fail === 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (arg("--stdio")) {
    // Desktop clients spawn exactly this. Keep stdout clean.
    return stdio.start();
  }

  const httpsUrl = `https://localhost:${HTTPS_PORT}/mcp`;

  if (arg("--scan")) {
    const rows = discover.scan(httpsUrl);
    console.log("\n  Detected MCP client configs\n" + "─".repeat(68));
    for (const r of rows) {
      const mark = !r.exists ? "·" : r.alreadyRegistered ? "✓" : "+";
      console.log(`  ${mark} ${r.label.padEnd(22)} ${r.exists ? `${r.serverCount} server(s)` : "not installed"}`);
      if (r.exists) console.log(`      ${r.file}`);
    }
    console.log("─".repeat(68));
    console.log("  + = would register · ✓ = already done · · = no config file\n");
    return;
  }

  if (arg("--register")) {
    const rows = discover.register(httpsUrl, true);
    console.log("\n  Registration results\n" + "─".repeat(68));
    for (const r of rows) console.log(`  ${r.label.padEnd(22)} ${r.action}`);
    console.log("─".repeat(68) + "\n");
    return;
  }

  const modes = [];
  banner(["http (starting…)"]);

  const httpT = await startHTTP({ port: HTTP_PORT, host: HOST });
  if (httpT) {
    modes.push("http");
    global.__UA_TRANSPORTS__ = [{ name: "http", url: httpT.url }];
  } else {
    global.__UA_TRANSPORTS__ = [];
  }

  const httpsT = await startHTTPS({
    port: HTTPS_PORT,
    // Loopback only — see transport-http.js. Set ADAPTER_HTTPS_HOST=0.0.0.0
    // deliberately if a LAN client has to reach the adapter.
    host: process.env.ADAPTER_HTTPS_HOST || "127.0.0.1",
    hosts: ["localhost", "127.0.0.1"],
  });
  if (httpsT) {
    modes.push("https");
    global.__UA_TRANSPORTS__.push({ name: "https", url: httpsT.url });
  }
  global.__UA_TRANSPORTS__.push({ name: "stdio", url: `node ${path.join(__dirname, "index.js")} --stdio` });

  // The first banner prints before the initial pull finishes, which made it
  // claim "UNREACHABLE" even when the main server answered fine. Wait here so
  // the real numbers are on screen.
  await registry.mainSync.ensureSynced();

  banner(modes);
  if (httpT) log("MCP endpoint  :", httpT.url);
  else log("MCP endpoint  :", "NONE — HTTP bind failed (see logs/zc.jsonl, HTTP_BIND_FAIL)");
  if (httpsT) log("MCP over TLS  :", httpsT.url);
  log("stdio command :", `node "${path.join(__dirname, "index.js")}" --stdio`);
  log("status page   :", `http://127.0.0.1:${HTTP_PORT}/health`);
  bar();

  zclog.info("adapter", "START", {
    modes,
    http: httpT ? httpT.url : null,
    https: httpsT ? httpsT.url : null,
    tools_total: Object.keys(registry.STATS).length + (registry.mainSync.list().length),
    main_sync: registry.mainSync.status().reachable,
    log_file: zclog.file,
  });

  if (arg("--verify")) {
    const okAll = await verify(modes);
    // The transports keep the event loop alive, so without this the process
    // would hang forever and a caller could never read the pass/fail code.
    for (const t of [httpT, httpsT]) {
      try {
        if (t && t.server) t.server.close();
      } catch {
        /* best effort */
      }
    }
    process.exit(okAll ? 0 : 1);
  }

  // Graceful shutdown — stdio clients rely on a clean exit.
  const shutdown = (sig) => {
    log(`received ${sig}, shutting down`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[adapter] fatal:", err);
  zclog.fail("adapter", "FATAL", { error: err.message || String(err), stack: String(err.stack || "").split("\n").slice(0, 5).join(" | ") });
  process.exit(1);
});