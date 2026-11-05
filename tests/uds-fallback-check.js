#!/usr/bin/env node
"use strict";

/*
 * Real-socket check for the single UDS transport:
 *   1. a stale/live path is skipped,
 *   2. the next candidate binds immediately,
 *   3. MCP newline JSON-RPC and OpenAI HTTP share the bound socket,
 *   4. close removes only the socket this process owns.
 */

const fs = require("fs");
const net = require("net");
const http = require("http");
const os = require("os");
const path = require("path");
const { createUdsGateway, normalizePaths } = require("../transport/uds-gateway");

const ROOT = path.join(os.tmpdir(), "opencode", "uds-check-" + process.pid);
const PRIMARY = path.join(ROOT, "mcp.sock");
const FALLBACK = path.join(ROOT, "fallback", "mcp.sock");

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " " + detail : ""));
  } else {
    fail += 1;
    console.log("FAIL " + name + (detail ? " " + detail : ""));
  }
}

function httpOverUds(socketPath, pathname, body) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      socketPath,
      path: pathname,
      method: body ? "POST" : "GET",
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length }
        : undefined,
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", (err) => resolve({ status: 0, text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function mcpOverUds(socketPath, message) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "timeout" });
    }, 5000);
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const cut = buffer.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve({ ok: true, json: JSON.parse(buffer.slice(0, cut)) });
      } catch (err) {
        resolve({ ok: false, error: "invalid json: " + err.message });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(PRIMARY), { recursive: true });

  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(PRIMARY, resolve);
  });

  const gateway = createUdsGateway({
    paths: [PRIMARY, FALLBACK],
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, transport: "http-over-uds" }));
    },
    onMcpMessage: (socket, message) => {
      socket.write(JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { ok: true, transport: "mcp-over-uds" },
      }) + "\n");
    },
  });

  try {
    const bound = await gateway.listen();
    check("primary busy -> fallback bound", bound === FALLBACK, "bound=" + bound);
    check("fallback flag", gateway.fallbackUsed === true);
    check("fallback socket exists", fs.existsSync(FALLBACK));
    check("socket mode is 660", (fs.statSync(FALLBACK).mode & 0o777) === 0o660,
      "mode=" + (fs.statSync(FALLBACK).mode & 0o777).toString(8));
    check("candidate list normalized", normalizePaths([PRIMARY, PRIMARY, FALLBACK]).length === 2);

    const httpResult = await httpOverUds(FALLBACK, "/v1/chat/completions", { model: "x" });
    check("HTTP over the same UDS", httpResult.status === 200 &&
      JSON.parse(httpResult.text || "{}").transport === "http-over-uds",
      "status=" + httpResult.status);

    const mcpResult = await mcpOverUds(FALLBACK, {
      jsonrpc: "2.0", id: 7, method: "tools/list", params: {},
    });
    check("MCP over the same UDS", mcpResult.ok &&
      mcpResult.json.result.transport === "mcp-over-uds",
      mcpResult.error || "id=" + (mcpResult.json && mcpResult.json.id));

    await gateway.close();
    check("bound socket removed on close", !fs.existsSync(FALLBACK));
    check("foreign primary socket untouched", fs.existsSync(PRIMARY));
  } finally {
    try { gateway.close(); } catch (_) {}
    await new Promise((resolve) => blocker.close(resolve));
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log("────────────────────────────────────────────────────────────");
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("ERROR: " + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
