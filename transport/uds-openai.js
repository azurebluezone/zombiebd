"use strict";
/*
 * OpenAI-compatible HTTP transport over a Unix domain socket.
 * It is a second listener for the SAME request handler as TCP: one auth
 * pipeline, one routing table, no NDJSON dialect.
 */

const fs = require("fs");
const http = require("http");
const path = require("path");

function createUdsOpenAIServer(options) {
  const opts = options || {};
  if (!opts.socketPath) throw new Error("socketPath is required");
  if (typeof opts.handler !== "function") throw new Error("handler is required");

  const server = http.createServer(opts.handler);
  let listening = false;
  let boundIno = 0;

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        fs.mkdirSync(path.dirname(opts.socketPath), { recursive: true });
        try {
          if (fs.existsSync(opts.socketPath)) fs.unlinkSync(opts.socketPath);
        } catch (_) {
          // A live socket from another process must surface on listen().
        }
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          try {
            fs.chmodSync(opts.socketPath, 0o660);
            boundIno = fs.statSync(opts.socketPath).ino;
          } catch (_) {}
          listening = true;
          if (typeof opts.onListening === "function") opts.onListening(opts.socketPath);
          resolve(opts.socketPath);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(opts.socketPath);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!listening) return resolve();
        listening = false;
        server.close(() => {
          // Only remove the path if it still points at this server. A newer
          // process may already own the same path after a restart.
          try {
            if (boundIno) {
              const st = fs.statSync(opts.socketPath);
              if (st.ino === boundIno) fs.unlinkSync(opts.socketPath);
            }
          } catch (_) {}
          resolve();
        });
      });
    },
  };
}

module.exports = { createUdsOpenAIServer };
