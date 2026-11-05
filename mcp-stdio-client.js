/**
 * stdio-client.js — MCP client transport for child-process servers
 * ═══════════════════════════════════════════════════════════════════════
 * Speaks newline-delimited JSON-RPC to a spawned Node process.
 *
 * Why: mcp-client.js is HTTP-only, which forces every helper MCP server to
 * own a TCP port. That means port allocation, port collisions between
 * concurrent deployments, sockets left listening after a crash, and no way
 * to tie a server's lifetime to its parent.
 *
 * With stdio the helper becomes a true child process:
 *   • zero ports
 *   • parent exit kills the child automatically
 *   • nothing exposed on any interface
 *
 * Contract: the child must run with MCP_TRANSPORT=stdio (see
 * external mcp/stdio-transport.js) and write replies to stdout.
 */
"use strict";

const { spawn } = require("child_process");
const readline = require("readline");

/**
 * Spawn an MCP server and talk JSON-RPC to it over stdin/stdout.
 *
 * @param {object} spec
 * @param {string} spec.command   executable (default: process.execPath)
 * @param {string[]} spec.args    script path + args
 * @param {object} [spec.env]     extra env vars
 * @param {number} [spec.timeoutMs] per-request timeout (default 30s)
 * @param {string} [spec.cwd]
 * @returns {object} { call, tools, kill, pid, stderr }
 */
function createStdioClient(spec) {
  const command = spec.command || process.execPath;
  const args = Array.isArray(spec.args) ? spec.args : [];
  const timeoutMs = spec.timeoutMs || 30000;

  const child = spawn(command, args, {
    cwd: spec.cwd,
    // MCP_TRANSPORT=stdio is what the server checks to pick stdio over HTTP.
    env: { ...process.env, ...(spec.env || {}), MCP_TRANSPORT: "stdio" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  /** id -> { resolve, reject, timer } */
  const pending = new Map();
  let nextId = 1;
  let closed = false;
  const stderrChunks = [];

  child.stderr.on("data", (d) => {
    const s = d.toString();
    stderrChunks.push(s);
    if (stderrChunks.length > 200) stderrChunks.shift();
    if (spec.debug) process.stderr.write(`[${spec.name || "mcp-stdio"}] ${s}`);
  });

  child.on("error", (err) => {
    // Fail every in-flight request instead of hanging forever.
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`child process error: ${err.message}`));
    }
    pending.clear();
  });

  child.on("exit", (code, signal) => {
    closed = true;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`server exited (${why})`));
    }
    pending.clear();
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // non-JSON noise on stdout — ignore rather than crash
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || "server error"));
    else entry.resolve(msg.result);
  });

  /** Issue one JSON-RPC call and await its result. */
  function call(method, params = {}) {
    if (closed || child.exitCode !== null) {
      return Promise.reject(new Error("stdio server is not running"));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Fetch the advertised tool list. */
  async function tools() {
    await call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "zombie-api", version: "3.2.1" },
    });
    const res = await call("tools/list", {});
    return (res && res.tools) || [];
  }

  function kill(signal = "SIGTERM") {
    try {
      child.kill(signal);
    } catch (_) {
      /* already gone */
    }
  }

  return {
    call,
    tools,
    kill,
    get pid() {
      return child.pid;
    },
    get running() {
      return !closed && child.exitCode === null;
    },
    stderr: () => stderrChunks.join(""),
  };
}

module.exports = { createStdioClient };