#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: R2T fallback trace (runbook P1-07, gate R2T_TRACE_OK)
// =============================================================================
// Method (real HTTP, spawned gateways, no mocks):
//   1) Spawn api.js with R2T_MODULE pointing at a missing file.
//      POST model=r2t -> x-zc-r2t-engine: builtin-fallback,
//      x-zc-r2t-fallback: module-missing, body r2tEngine, log marker.
//   2) Spawn api.js with a real temp .mjs exporting convertResponse.
//      POST model=r2t -> x-zc-r2t-engine: external-module, no fallback header.
//
// Run: node tests/r2t-trace-check.js
// Exit 0 + R2T_TRACE_OK only when every assertion passes.
// =============================================================================
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "r2t-trace-"));

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail += 1;
    rows.push(["FAIL", name, detail || ""]);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function freePorts(n) {
  const seen = new Set();
  const out = [];
  while (out.length < n) {
    const p = await freePort();
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function httpJson(port, pathname, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        timeout: timeoutMs || 10000,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch (e) {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: data, json });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) =>
      resolve({ status: 0, headers: {}, body: "", error: e.message }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

function startInstance(port, grpcPort, httpsPort, r2tModule) {
  const dataDir = path.join(TMP, "data-" + port);
  const logDir = path.join(TMP, "logs-" + port);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    APP_ROOT: TMP,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: path.join(dataDir, "models.db"),
    DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp-" + port + ".sock"),
    UDS_OPENAI: "1",
    INSTANCE_ID: "r2t-trace-" + port,
    R2T_ENABLED: "true",
    R2T_MODULE: r2tModule,
    BRIDGE_ENABLED: "0",
    OPENCODE_ENABLED: "false",
    OLLAMA_CLOUD_API_KEY: "",
    GROQ_API_KEY: "",
    GEMINI_API_KEY: "",
    NVIDIA_API_KEY: "",
  });
  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  return { child, output: () => output };
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 60000);
  while (Date.now() < deadline) {
    const res = await httpJson(port, "/health", "GET", null, 2000);
    if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
    await sleep(300);
  }
  return null;
}

async function stopInstance(instance) {
  const child = instance.child;
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

function contentOf(res) {
  const choice = res.json && res.json.choices && res.json.choices[0];
  const message = choice && choice.message;
  return message && typeof message.content === "string" ? message.content : "";
}

async function runCase(label, modulePath, expectedEngine, expectedFallback) {
  const [port, grpcPort, httpsPort] = await freePorts(3);
  const instance = startInstance(port, grpcPort, httpsPort, modulePath);
  try {
    const health = await waitHealth(port, 60000);
    assert(label + ": spawned gateway healthy", !!health, health ? "HTTP 200" : "timeout");
    if (!health) return;

    const res = await httpJson(
      port,
      "/v1/chat/completions",
      "POST",
      {
        model: "r2t",
        messages: [{ role: "user", content: "[[TOOL:info]][[/TOOL]]" }],
        stream: false,
      },
      20000,
    );
    assert(label + ": HTTP 200", res.status === 200, String(res.status));
    assert(
      label + ": x-zc-r2t-engine=" + expectedEngine,
      String(res.headers["x-zc-r2t-engine"] || "") === expectedEngine,
      String(res.headers["x-zc-r2t-engine"] || ""),
    );

    if (expectedFallback) {
      assert(
        label + ": x-zc-r2t-fallback=" + expectedFallback,
        String(res.headers["x-zc-r2t-fallback"] || "") === expectedFallback,
        String(res.headers["x-zc-r2t-fallback"] || ""),
      );
    } else {
      assert(
        label + ": no fallback header on the real module",
        res.headers["x-zc-r2t-fallback"] === undefined,
        String(res.headers["x-zc-r2t-fallback"] || "absent"),
      );
    }

    let parsed = null;
    try {
      parsed = JSON.parse(contentOf(res));
    } catch (e) {
      parsed = null;
    }
    assert(
      label + ": body reports r2tEngine=" + expectedEngine,
      !!parsed && parsed.r2tEngine === expectedEngine,
      parsed ? String(parsed.r2tEngine) : "unparsed content",
    );

    if (expectedFallback === "module-missing") {
      await sleep(300);
      const out = instance.output();
      assert(
        label + ": log has R2T_BUILTIN_FALLBACK",
        out.includes("R2T_BUILTIN_FALLBACK"),
        "output bytes=" + out.length,
      );
      assert(
        label + ": log names module-missing",
        out.includes("module-missing"),
        out.includes("module-missing") ? "found" : "missing",
      );
    }
  } finally {
    await stopInstance(instance);
  }
}

(async () => {
  const timer = setTimeout(() => {
    console.error("R2T_TRACE_TIMEOUT");
    process.exit(1);
  }, 110000);
  try {
    const missing = path.join(TMP, "missing-r2t.mjs");
    await runCase("missing-module", missing, "builtin-fallback", "module-missing");

    const fake = path.join(TMP, "fake-r2t.mjs");
    fs.writeFileSync(
      fake,
      'export async function convertResponse(input) {\n' +
        '  return { status: "ok", engine: "fake-external", matched: 0 };\n' +
        '}\n',
    );
    await runCase("external-module", fake, "external-module", "");

    const src = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
    assert("api.js logs R2T_BUILTIN_FALLBACK", src.includes('"R2T_BUILTIN_FALLBACK"'));
    assert("api.js sets x-zc-r2t-engine", src.includes('"x-zc-r2t-engine"'));
    assert("api.js sets x-zc-r2t-fallback", src.includes('"x-zc-r2t-fallback"'));
  } finally {
    clearTimeout(timer);
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: R2T fallback trace");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    const tag = status === "PASS" ? "  PASS " : "  FAIL ";
    console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (!fail) console.log("R2T_TRACE_OK");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("R2T_TRACE_ERROR", e);
  process.exit(1);
});
