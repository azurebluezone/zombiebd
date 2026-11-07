"use strict";
/*
 * One Unix-domain socket for two wire protocols.
 *
 * MCP clients write newline-delimited JSON-RPC. OpenAI clients write HTTP.
 * The first bytes decide the protocol; after that the connection belongs to
 * exactly one parser. Both parsers share the same bound socket, so a client
 * never needs a second path just to use the OpenAI surface.
 */

const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const HTTP_PREFIX = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /;

function normalizePaths(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = String(item || "").trim();
    if (!text) continue;
    const resolved = path.resolve(text);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

// One env var per candidate (`UDS_1`..`UDS_N`), plus the legacy comma list
// (`UDS`, `UDS_PATH`, `UDS_PATHS`). Numbered keys are read dynamically: adding
// UDS_4 needs no code change, and gaps are fine (UDS_1, UDS_3 still work).
// Order decides fallback: the first usable path wins, the next one is the
// immediate fallback when a path is busy or cannot be bound.
function collectUdsPaths(env, root) {
  const source = env || process.env;
  const base = path.resolve(root || process.cwd());
  const raw = [];

  for (const key of ["UDS", "UDS_PATH", "UDS_PATHS"]) {
    raw.push(...String(source[key] || "").split(","));
  }

  const numbered = Object.keys(source)
    .map((key) => ({ key, match: /^UDS(?:_PATH)?_(\d+)$/.exec(key) }))
    .filter((item) => item.match && String(source[item.key] || "").trim())
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  for (const item of numbered) raw.push(source[item.key]);

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const text = String(item || "").trim();
    if (!text) continue;
    const resolved = path.resolve(base, text);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

async function preparePath(socketPath) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!fs.existsSync(socketPath)) return { ok: true };
  if (await canConnect(socketPath)) {
    return { ok: false, reason: "already listening" };
  }
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    return { ok: false, reason: "stale socket cannot be removed: " + err.message };
  }
  return { ok: true };
}

function listenOnce(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function createUdsGateway(options) {
  const opts = options || {};
  if (typeof opts.onMcpMessage !== "function") {
    throw new Error("onMcpMessage is required");
  }
  if (typeof opts.handler !== "function") {
    throw new Error("handler is required");
  }

  const paths = normalizePaths(opts.paths);
  if (!paths.length) throw new Error("at least one UDS path is required");

  const httpServer = http.createServer(opts.handler);
  const netServer = net.createServer();
  let boundPath = "";
  let boundIno = 0;
  let fallbackUsed = false;
  let listening = false;
  const attempts = [];

  httpServer.on("clientError", (err, socket) => {
    if (opts.onClientError) opts.onClientError(err, socket);
    try { socket.destroy(); } catch (_) {}
  });

  netServer.on("connection", (socket) => {
    if (opts.onConnection) opts.onConnection(socket);
    let buffer = Buffer.alloc(0);
    let lineBuffer = "";
    let mode = "";

    const drainLines = () => {
      let cut;
      while ((cut = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, cut).trim();
        lineBuffer = lineBuffer.slice(cut + 1);
        if (!line) continue;
        try {
          opts.onMcpMessage(socket, JSON.parse(line));
        } catch (err) {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error: " + err.message },
          }) + "\n");
        }
      }
    };

    socket.on("data", (chunk) => {
      if (mode === "http") return;
      if (mode === "mcp") {
        lineBuffer += chunk.toString("utf8");
        drainLines();
        return;
      }

      buffer = Buffer.concat([buffer, chunk]);
      const preview = buffer.toString("latin1", 0, Math.min(buffer.length, 64))
        .replace(/^[\r\n\t ]+/, "");
      if (!preview) return;

      if (HTTP_PREFIX.test(preview)) {
        mode = "http";
        socket.pause();
        socket.removeAllListeners("data");
        socket.unshift(buffer);
        httpServer.emit("connection", socket);
        socket.resume();
        return;
      }

      mode = "mcp";
      lineBuffer = buffer.toString("utf8");
      buffer = Buffer.alloc(0);
      drainLines();
    });

    socket.on("error", (err) => {
      if (opts.onSocketError) opts.onSocketError(err, socket);
    });
  });

  return {
    httpServer,
    server: netServer,
    paths,
    get boundPath() { return boundPath; },
    get boundIno() { return boundIno; },
    get fallbackUsed() { return fallbackUsed; },
    get listening() { return listening; },
    get attempts() { return attempts.slice(); },
    async listen() {
      for (let i = 0; i < paths.length; i += 1) {
        const candidate = paths[i];
        const prepared = await preparePath(candidate);
        attempts.push({ path: candidate, ok: prepared.ok, reason: prepared.reason || "" });
        if (!prepared.ok) continue;
        try {
          await listenOnce(netServer, candidate);
        } catch (err) {
          attempts[attempts.length - 1].reason = err.code || err.message;
          try { netServer.close(); } catch (_) {}
          continue;
        }
        boundPath = candidate;
        fallbackUsed = i > 0;
        try {
          fs.chmodSync(candidate, 0o660);
          boundIno = fs.statSync(candidate).ino;
        } catch (_) {}
        listening = true;
        if (opts.onListening) opts.onListening(candidate, { fallbackUsed, attempts });
        return candidate;
      }
      throw new Error("no UDS path could be bound: " + JSON.stringify(attempts));
    },
    close() {
      return new Promise((resolve) => {
        if (!listening) return resolve();
        listening = false;
        netServer.close(() => {
          try {
            if (boundIno && fs.statSync(boundPath).ino === boundIno) {
              fs.unlinkSync(boundPath);
            }
          } catch (_) {}
          resolve();
        });
      });
    },
  };
}

module.exports = { createUdsGateway, collectUdsPaths, normalizePaths };
