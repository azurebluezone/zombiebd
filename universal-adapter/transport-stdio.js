/**
 * transport-stdio.js — stdio transport
 * ═══════════════════════════════════════════════════════════════════════
 * Newline-delimited JSON on stdin/stdout. This is what Claude Desktop,
 * Cursor and most desktop MCP clients spawn as a subprocess:
 *
 *   { "command": "node",
 *     "args": ["/path/to/zombiebd/universal-adapter/index.js", "--stdio"] }
 *
 * stdout is the protocol channel, so NOTHING else may ever write to it —
 * every diagnostic goes to stderr. That single rule is what keeps stdio
 * clients from choking on stray log lines.
 */
"use strict";

const readline = require("readline");
const { handleRpc } = require("./registry");
const zclog = require("../lib/zc-log");

const err = (...a) => console.error("[ua:stdio]", ...a);

function start() {
  // Tell the parent we are ready. Some clients wait for this line.
  process.stderr.write("[ua:stdio] ready\n");
  zclog.info("transport", "STDIO_BOUND", { note: "stdio transport ready (console logging suppressed — stdout is protocol)" });

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Remote tools are forwarded upstream, so handleRpc can return a Promise.
  // The handler is async for that reason; awaiting a plain value is a no-op.
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      zclog.fail("transport", "STDIO_PARSE_FAIL", { snippet: text.slice(0, 80) });
      return write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
    }

    let out;
    try {
      out = await handleRpc(parsed);
    } catch (e) {
      zclog.fail("transport", "STDIO_HANDLER_ERROR", { error: e.message || String(e) });
      return write({
        jsonrpc: "2.0",
        id: parsed && parsed.id ? parsed.id : null,
        error: { code: -32603, message: e.message || String(e) },
      });
    }

    // null === notification, nothing to send back
    if (out !== null) write(out);
  });

  rl.on("close", () => process.exit(0));
}

function write(payload) {
  // Batch replies are arrays — emit each element on its own line.
  for (const item of [].concat(payload)) {
    process.stdout.write(JSON.stringify(item) + "\n");
  }
}

module.exports = { start };