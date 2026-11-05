/**
 * transport-http.js — HTTP and HTTPS transports
 * ═══════════════════════════════════════════════════════════════════════
 * Both transports share one request handler; only the server object differs.
 *
 * Each server answers four MCP entry styles, because different clients pick
 * different paths and content types:
 *   • POST /mcp                 → JSON-RPC, returns JSON or SSE (content-negotiated)
 *   • POST /mcp (SSE requested) → server-sent events stream
 *   • GET  /mcp                 → SSE stream (legacy streamable-http clients)
 *   • ANY  /sse                 → SSE stream (older MCP clients)
 *
 * This is what lets Claude Desktop, Cursor, VS Code, OpenCode, Zed and
 * Cline all talk to one process.
 */
"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");
const { handleRpc } = require("./registry");
const zclog = require("../lib/zc-log");
const tls = require("./tls");

const log = (...a) => console.log("[ua:http]", ...a);

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version",
  };
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

/** Open an SSE stream and register it so GET-based clients stay connected. */
function openSSE(res, label) {
  res.writeHead(200, sseHeaders());
  res.write(`event: endpoint\ndata: /mcp\n\n`);
  // Comment frames keep proxies from closing an idle connection.
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      clearInterval(keepAlive);
    }
  }, 25000);
  res.on("close", () => clearInterval(keepAlive));
  log("SSE stream open:", label);
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  // ── Plain status endpoint (handy for humans and health checks) ──
  if (path === "/" || path === "/health" || path === "/status") {
    return sendJSON(res, 200, {
      ok: true,
      service: "zombie-universal-adapter",
      transports: global.__UA_TRANSPORTS__ || [],
      mcp: { http: "/mcp", https: "/mcp", stdio: "spawn this process" },
    });
  }

  const isMcp = path === "/mcp" || path === "/sse" || path === "/message";

  // ── Request lifecycle log for MCP calls (health probes stay out of the log) ──
  if (isMcp && req.method === "POST") {
    const t0 = Date.now();
    res.on("finish", () => {
      let rpcMethod;
      try {
        const m = JSON.parse(raw);
        rpcMethod = Array.isArray(m) ? m[0] && m[0].method : m && m.method;
      } catch {
        /* body unparseable — rpc_method stays undefined */
      }
      zclog[res.statusCode < 400 ? "info" : "fail"]("transport", "HTTP_REQUEST", {
        proto: "http",
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - t0,
        rpc_method: rpcMethod,
      });
    });
  }

  // ── GET on an MCP path → SSE (streamable-http / legacy MCP clients) ──
  if (req.method === "GET" && isMcp) return openSSE(res, `GET ${path}`);

  if (req.method !== "POST" || !isMcp) {
    return sendJSON(res, 404, { error: "not found", path, hint: "MCP lives at POST /mcp" });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return sendJSON(res, 413, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: err.message },
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJSON(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "parse error: body is not valid JSON" },
    });
  }

  const wantsSSE =
    (req.headers.accept || "").includes("text/event-stream") && (req.headers.accept || "").includes("application/json");

  if (wantsSSE) {
    // Client asked for the negotiated stream form — reply as SSE, matching
    // what the MCP spec requires when both types are advertised.
    res.writeHead(200, sseHeaders());
    // handleRpc may return a Promise (remote tools are forwarded upstream),
    // so every transport awaits it — awaiting a plain value is a no-op.
    for (const reply of [].concat(await handleRpc(parsed)).filter(Boolean)) {
      res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    }
    return res.end();
  }

  const out = await handleRpc(parsed);
  if (out === null) {
    // Notification — no body, just acknowledge.
    res.writeHead(202, corsHeaders());
    return res.end();
  }
  return sendJSON(res, 200, out);
}

function startHTTP({ port = 5400, host = "127.0.0.1" } = {}) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      zclog.fail("transport", "HTTP_HANDLER_ERROR", { error: err.message || String(err) });
      if (!res.headersSent) sendJSON(res, 500, { error: err.message });
      else res.end();
    });
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    // A dead port must not take the whole adapter down — the HTTPS transport
    // (and stdio) can still serve, and the log says exactly what failed.
    server.on("error", (err) => {
      zclog.fail("transport", "HTTP_BIND_FAIL", { host, port, error: err.message });
      done(null);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      log(`HTTP  listening → http://${host}:${addr.port}/mcp`);
      zclog.info("transport", "HTTP_BOUND", { url: `http://${host}:${addr.port}/mcp`, loopback_only: host !== "0.0.0.0" });
      done({ name: "http", server, port: addr.port, url: `http://${host}:${addr.port}/mcp` });
    });
  });
}

/**
 * HTTPS binds loopback by default. It used to default to 0.0.0.0, which put
 * the adapter on every LAN interface; loopback is all the local clients need
 * and nothing else should reach it. Override with ADAPTER_HTTPS_HOST if a
 * remote client really must connect.
 */
function startHTTPS({ port = 5443, host = "127.0.0.1", hosts = ["localhost", "127.0.0.1"] } = {}) {
  let creds;
  try {
    creds = tls.ensure(hosts);
    log(creds.generated ? "generated a new self-signed certificate" : "reusing cached certificate");
    log("fingerprint (sha256):", tls.fingerprint());
  } catch (err) {
    log("TLS DISABLED —", err.message);
    zclog.fail("transport", "TLS_DISABLED", { error: err.message, hosts, port });
    return Promise.resolve(null);
  }

  const server = https.createServer({ key: creds.key, cert: creds.cert }, (req, res) => {
    handle(req, res).catch((err) => {
      zclog.fail("transport", "HTTPS_HANDLER_ERROR", { error: err.message || String(err) });
      if (!res.headersSent) sendJSON(res, 500, { error: err.message });
      else res.end();
    });
  });
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    server.on("error", (err) => {
      zclog.fail("transport", "HTTPS_BIND_FAIL", { host, port, error: err.message });
      done(null);
    });
    server.listen(port, host, () => {
      const addr = server.address();
      log(`HTTPS listening → https://${hosts[0]}:${addr.port}/mcp (bound to ${host}:${addr.port})`);
      zclog.info("transport", "HTTPS_BOUND", {
        url: `https://${hosts[0]}:${addr.port}/mcp`,
        bind: `${host}:${addr.port}`,
        loopback_only: host !== "0.0.0.0",
        cert: tls.CRT_FILE,
      });
      done({
        name: "https",
        server,
        port: addr.port,
        url: `https://${hosts[0]}:${addr.port}/mcp`,
        certPath: tls.CRT_FILE,
      });
    });
  });
}

module.exports = { startHTTP, startHTTPS, handle };