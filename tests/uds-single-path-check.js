#!/usr/bin/env node
"use strict";

/** UDS_SINGLE_PATH_OK — row 6. */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const ROOT = path.resolve(__dirname, "..");
const { createUdsGateway, collectUdsPaths } = require(path.join(ROOT, "transport/uds-gateway.js"));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
function requestOverSocket(socketPath, request) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/health", method: "GET", headers: { host: "localhost" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

(async () => {
  await check("canonical path collector reads UDS/UDS_PATH/UDS_N", () => {
    const got = collectUdsPaths({ UDS_PATH: "/tmp/one.sock", UDS_1: "/tmp/two.sock", UDS_3: "/tmp/three.sock" }, "/");
    assert.deepStrictEqual(got, ["/tmp/one.sock", "/tmp/two.sock", "/tmp/three.sock"]);
  });

  await check("one socket serves HTTP and MCP without a second path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-uds-"));
    const sock = path.join(dir, "gateway.sock");
    const seen = [];
    const gw = createUdsGateway({
      paths: [sock],
      handler: (req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("http-ok"); },
      onMcpMessage: (socket, msg) => { seen.push(msg); socket.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } }) + "\n"); },
    });
    try {
      await gw.listen();
      const httpOut = await requestOverSocket(sock);
      assert.strictEqual(httpOut.status, 200);
      assert.strictEqual(httpOut.body, "http-ok");
      const reply = await new Promise((resolve, reject) => {
        const s = net.createConnection({ path: sock });
        let buf = "";
        s.setEncoding("utf8");
        s.on("connect", () => s.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) + "\n"));
        s.on("data", (c) => { buf += c; if (buf.includes("\n")) { s.destroy(); resolve(buf.trim()); } });
        s.on("error", reject);
        setTimeout(() => reject(new Error("MCP reply timeout")), 3000);
      });
      assert.deepStrictEqual(seen, [{ jsonrpc: "2.0", id: 7, method: "ping" }]);
      assert.strictEqual(JSON.parse(reply).id, 7);
    } finally {
      await gw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("no OPENAI_UDS_PATH remains in runtime or scripts", () => {
    const files = ["api.js", "lib/env.js", "transport/stdio-openai.js", "scripts/dist-verify.sh", "scripts/p4-verify.sh", "scripts/verify-start-dist.sh", "scripts/cleanup-verify.sh"];
    for (const file of files) {
      assert.ok(!read(file).includes("OPENAI_UDS_PATH"), file + " still references the legacy path");
    }
    assert.ok(!fs.existsSync(path.join(ROOT, "transport/uds-openai.js")), "legacy uds-openai module still exists");
  });

  await check("api.js binds through the canonical gateway only", () => {
    const api = read("api.js");
    assert.ok(api.includes('require("./transport/uds-gateway")'), "canonical gateway not required");
    assert.ok(api.includes("udsGateway = createUdsGateway({"), "canonical gateway not constructed");
    assert.ok(!api.includes("attachLegacyUds"), "legacy attach helper remains");
    assert.ok(!api.includes("openaiUdsServer"), "legacy server variable remains");
    assert.ok(!api.includes("OPENAI_UDS_CLEANUP"), "legacy cleanup remains");
  });

  await check("stdio bridge targets the canonical socket", () => {
    const bridge = read("transport/stdio-openai.js");
    assert.ok(/process\.env\.UDS_PATH\s*\|\|\s*process\.env\.UDS/.test(bridge), "bridge does not use canonical UDS env");
  });

  console.log("\nUDS_SINGLE_PATH_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
  process.exitCode = fail === 0 ? 0 : 1;
})();
