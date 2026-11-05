/**
 * stdio-transport.js — shared MCP stdio transport
 * ═══════════════════════════════════════════════════════════════════════
 * Lets an MCP server run as a CHILD PROCESS of api.js instead of opening a
 * TCP port. The parent speaks newline-delimited JSON-RPC over stdin/stdout;
 * stderr is free for logs.
 *
 * Why this matters
 *   • no port to allocate, collide on, or leave listening
 *   • lifetime is tied to the parent — kill api.js and the children die
 *   • no loopback socket exposed at all
 *   • this is the transport the MCP spec itself uses for local servers
 *
 * Usage inside a server:
 *   const { serveStdio } = require("./stdio-transport.js");
 *   serveStdio(async (req) => ({ jsonrpc:"2.0", id:req.id, result:{...} }));
 *   return;                       // <- do not fall through to listen()
 *
 * The handler returns the JSON-RPC reply object, or null for a notification.
 */
"use strict";

const readline = require("readline");

/**
 * @param {(req:any)=>Promise<any>|any} handleRpc
 * @param {string} name   server name, used in stderr logs only
 */
function serveStdio(handleRpc, name = "mcp") {
  // stdout belongs to the protocol. Emphasise that in the logs.
  process.stderr.write(`[${name}] stdio transport ready (pid ${process.pid})\n`);

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Serialize handling so two overlapping calls cannot interleave their
  // replies onto stdout.
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;

    queue = queue.then(async () => {
      let req;
      try {
        req = JSON.parse(text);
      } catch {
        return write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }

      let out;
      try {
        out = await handleRpc(req);
      } catch (e) {
        return write({
          jsonrpc: "2.0",
          id: req && req.id != null ? req.id : null,
          error: { code: -32603, message: e && e.message ? e.message : String(e) },
        });
      }

      // null === notification (notifications/initialized) — nothing to reply
      if (out === null || out === undefined) return;

      // A handler may return one reply or a batch.
      for (const item of Array.isArray(out) ? out : [out]) write(item);
    });
  });

  rl.on("close", () => {
    process.stderr.write(`[${name}] stdin closed, exiting\n`);
    process.exit(0);
  });
}

function write(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/** True when this process was spawned in stdio mode. */
function wantsStdio(env = process.env) {
  return env.MCP_TRANSPORT === "stdio" || env.MCP_STDIO === "1";
}

module.exports = { serveStdio, wantsStdio, write };