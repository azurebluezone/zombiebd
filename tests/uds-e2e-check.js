#!/usr/bin/env node
"use strict";

/*
 * UDS end-to-end gate.
 *
 * Every request below goes through the real Unix socket: OpenAI HTTP and MCP
 * JSON-RPC share that one path. HTTP 200 alone is not proof — the tool section
 * writes a random token outside the project and passes only when the agent
 * echoes it, which is impossible without a real read_file/list_directory run.
 *
 * Also checks:
 *   - every project DB has 9/9 enabled agents with persona and model
 *   - dynamic UDS_1..N parsing, dedupe, order and bind fallback
 *   - exactly one bound socket among the configured candidates
 *   - model lists carry transport=uds / transportLabel="UDS model"
 *   - the local LLM bridge answers immediately with no fake model when no
 *     local server is running (no boot stall, no invented model)
 *
 * Run: node tests/uds-e2e-check.js
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const { loadEnv } = require("../lib/env.js");
const { collectUdsPaths, createUdsGateway } = require("../transport/uds-gateway.js");

const ENV = loadEnv({ root: ROOT });
const UDS_PATHS = ENV.derived.udsPaths && ENV.derived.udsPaths.length
  ? ENV.derived.udsPaths
  : ["/tmp/zombiecoder/mcp.sock"];
const UDS = UDS_PATHS[0];
const SCRATCH = path.join(os.tmpdir(), "zombiecoder", "uds-e2e-" + process.pid);

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " :: " + detail : ""));
  } else {
    fail += 1;
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentOf(json) {
  const choice = json && json.choices && json.choices[0];
  const message = choice && choice.message;
  return message && typeof message.content === "string" ? message.content : "";
}

// One client for both surfaces: a Unix socket path or 127.0.0.1 + port.
function send(options) {
  const opts = options || {};
  const payload = opts.body === undefined
    ? null
    : Buffer.from(typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body), "utf8");
  return new Promise((resolve) => {
    const target = opts.socketPath
      ? { socketPath: opts.socketPath }
      : { host: "127.0.0.1", port: opts.port };
    const req = http.request(
      Object.assign({}, target, {
        path: opts.pathname || "/",
        method: opts.method || (payload ? "POST" : "GET"),
        timeout: opts.timeoutMs || 120000,
        headers: Object.assign(
          { Accept: "application/json" },
          payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
        ),
      }),
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, text: "", json: null, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "", json: null, error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function uds(pathname, body, timeoutMs) {
  return send({ socketPath: UDS, pathname, body, timeoutMs });
}

function mcpCall(name, args, socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath || UDS });
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 15000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args || {} },
      }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const cut = buffer.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      try { finish({ ok: true, json: JSON.parse(buffer.slice(0, cut)) }); }
      catch (_) { finish({ ok: false, error: "invalid json" }); }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}

function canConnect(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(400, () => finish(false));
  });
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function dbFiles() {
  const out = [];
  const roots = [path.join(ROOT, "data"), path.join(ROOT, "dist", "data")];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".db")) out.push(full);
      }
    }
  }
  return out;
}

function auditDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table", "agents");
    if (!table) return { file, table: false };
    const rows = db.prepare("SELECT id, persona, model FROM agents WHERE enabled = 1").all();
    const complete = rows.filter(
      (row) => String(row.persona || "").trim().length > 0 && String(row.model || "").trim().length > 0,
    ).length;
    return { file, table: true, total: rows.length, complete };
  } finally {
    db.close();
  }
}

function streamOverUds(body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        socketPath: UDS,
        path: "/v1/chat/completions",
        method: "POST",
        timeout: 120000,
        headers: { "Content-Type": "application/json", "Content-Length": payload.length },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          const deltas = [];
          for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              if (delta && typeof delta.content === "string" && delta.content) deltas.push(delta.content);
            } catch (_) {}
          }
          resolve({ status: res.statusCode, text, deltas });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, text: "", deltas: [], error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "", deltas: [], error: "timeout" });
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  fs.mkdirSync(SCRATCH, { recursive: true });

  // 1. The gateway answers on the socket itself.
  const health = await uds("/health", undefined, 10000);
  check(
    "gateway health over the real UDS",
    health.status === 200 && !!health.json && health.json.healthy === true,
    "status=" + health.status,
  );

  // 2. One bound socket, the rest are candidates only.
  const transports = await uds("/api/transports", undefined, 10000);
  const entry = transports.json && (transports.json.transports || []).find((t) => t.id === "uds");
  check(
    "transports reports the UDS listener and bound path",
    !!(entry && entry.status === "listening" && entry.bound_path),
    "bound=" + (entry && entry.bound_path) + " status=" + (entry && entry.status),
  );
  let liveSockets = 0;
  for (const candidate of UDS_PATHS) {
    if (fs.existsSync(candidate) && (await canConnect(candidate))) liveSockets += 1;
  }
  check(
    "exactly one listening socket among UDS candidates",
    liveSockets === 1,
    "live=" + liveSockets + " candidates=" + UDS_PATHS.length,
  );
  check(
    "bound path is one of the configured candidates",
    !!(entry && UDS_PATHS.includes(entry.bound_path)),
    String(entry && entry.bound_path),
  );
  check(
    "transports exposes bind attempts",
    !!(entry && Array.isArray(entry.attempts) && entry.attempts.length > 0),
    "attempts=" + (entry && entry.attempts ? entry.attempts.length : 0),
  );

  // 3. Dynamic env parsing: UDS_1..N (gaps allowed) + legacy comma list.
  const sampleRoot = "/tmp/zc-uds-parse";
  const parsed = collectUdsPaths({
    UDS_1: "/tmp/zc-uds-parse/a.sock",
    UDS_2: "b.sock",
    UDS_3: "b.sock",
    UDS_PATH_4: "/tmp/zc-uds-parse/d.sock",
    UDS_5: "/tmp/zc-uds-parse/c.sock",
    UDS: "/tmp/zc-uds-parse/a.sock,legacy.sock",
  }, sampleRoot);
  const expected = [
    "/tmp/zc-uds-parse/a.sock",
    "/tmp/zc-uds-parse/legacy.sock",
    "/tmp/zc-uds-parse/b.sock",
    "/tmp/zc-uds-parse/d.sock",
    "/tmp/zc-uds-parse/c.sock",
  ];
  check(
    "UDS_1..N parse, dedupe and numeric order",
    JSON.stringify(parsed) === JSON.stringify(expected),
    "got=" + JSON.stringify(parsed),
  );

  // 4. Real bind fallback: a live first path is skipped, the next one binds.
  const busyPath = path.join(SCRATCH, "busy.sock");
  const freePath = path.join(SCRATCH, "free.sock");
  const busy = net.createServer((socket) => socket.end());
  let busySurvived = false;
  await new Promise((resolve) => busy.listen(busyPath, resolve));
  const gateway = createUdsGateway({
    paths: [busyPath, freePath],
    handler: (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("gw-ok");
    },
    onMcpMessage: () => {},
  });
  try {
    const bound = await gateway.listen();
    check(
      "bind fallback skips a live path and uses the next",
      bound === freePath && gateway.fallbackUsed === true &&
        /already listening/.test(gateway.attempts[0].reason || ""),
      "bound=" + bound + " attempts=" + JSON.stringify(gateway.attempts),
    );
    const probe = await send({ socketPath: freePath, pathname: "/ping", timeoutMs: 5000 });
    check(
      "fallback socket serves HTTP",
      probe.status === 200 && probe.text === "gw-ok",
      "status=" + probe.status,
    );
  } catch (err) {
    check("bind fallback", false, err.message);
  } finally {
    await gateway.close();
    busySurvived = fs.existsSync(busyPath) && (await canConnect(busyPath));
    await new Promise((resolve) => busy.close(resolve));
  }
  check(
    "close removes only the socket this process owns",
    !fs.existsSync(freePath) && busySurvived,
    "free_exists=" + fs.existsSync(freePath) + " busy_survived=" + busySurvived,
  );

  // 5. Persona + model in every project DB, plus the live agent source.
  const audited = dbFiles().map(auditDb).filter((db) => db.table);
  check(
    "9/9 enabled agents have persona+model in every project DB",
    audited.length > 0 && audited.every((db) => db.total >= 9 && db.complete === db.total),
    audited.map((db) => path.relative(ROOT, db.file) + " " + db.complete + "/" + db.total).join("; ") || "no DB",
  );
  const { loadAgentFiles } = require("../agent");
  const fileAgents = loadAgentFiles();
  check(
    "agent/*.js personas load (model comes from the DB)",
    fileAgents.length >= 9 && fileAgents.every(
      (agent) => String(agent.persona || "").trim(),
    ),
    "count=" + fileAgents.length + " personas=" +
      fileAgents.filter((agent) => String(agent.persona || "").trim()).length,
  );

  // 6. Real Gemini provider through the socket.
  const gemini = await uds("/v1/chat/completions", {
    model: "gemini-lite",
    messages: [{ role: "user", content: "Reply with exactly: PROVIDER-OK" }],
    max_tokens: 24,
    temperature: 0,
  });
  check(
    "Gemini live reply over UDS",
    gemini.status === 200 && /PROVIDER-OK/.test(contentOf(gemini.json)),
    "status=" + gemini.status + " content=" + JSON.stringify(contentOf(gemini.json).slice(0, 50)),
  );

  // 7. OpenCode: a real reply or an honestly recorded upstream quota block.
  const catalog = await uds("/api/v1/models", undefined, 10000);
  const opencodeModel = ((catalog.json && catalog.json.data) || []).find((m) => m.provider === "opencode");
  let opencodeOk = false;
  let opencodeDetail = "no opencode model in /api/v1/models";
  if (opencodeModel) {
    const reply = await uds("/v1/chat/completions", {
      model: opencodeModel.id,
      messages: [{ role: "user", content: "Reply with exactly: OPENCODE-OK" }],
      max_tokens: 24,
      temperature: 0,
    });
    const text = contentOf(reply.json);
    const errText = (reply.json && reply.json.error && reply.json.error.message) || reply.text || "";
    if (reply.status === 200 && text) {
      opencodeOk = true;
      opencodeDetail = "model=" + opencodeModel.id + " status=200 content=" + JSON.stringify(text.slice(0, 40));
    } else if (/429|rate.?limit|quota|Free usage limit/i.test(text + " " + errText)) {
      opencodeOk = true;
      opencodeDetail = "model=" + opencodeModel.id + " status=" + reply.status +
        " recorded quota=" + JSON.stringify(String(errText).slice(0, 90));
    } else {
      opencodeDetail = "model=" + opencodeModel.id + " status=" + reply.status +
        " err=" + JSON.stringify(String(errText).slice(0, 90));
    }
  }
  check("OpenCode reachable (reply or recorded quota)", opencodeOk, opencodeDetail);

  // 8. Agent non-streaming.
  const agentReply = await uds("/v1/chat/completions", {
    model: "code-guru",
    messages: [{ role: "user", content: "Reply with exactly: AGENT-OK" }],
    max_tokens: 24,
    temperature: 0,
  });
  check(
    "agent non-stream over UDS",
    agentReply.status === 200 && /AGENT-OK/.test(contentOf(agentReply.json)),
    "status=" + agentReply.status + " content=" + JSON.stringify(contentOf(agentReply.json).slice(0, 50)),
  );

  // 9. Agent SSE streaming.
  const stream = await streamOverUds({
    model: "code-guru",
    messages: [{ role: "user", content: "Count from 1 to 5 as digits, nothing else." }],
    max_tokens: 40,
    temperature: 0,
    stream: true,
  });
  const streamed = stream.deltas.join("");
  check(
    "agent SSE stream over UDS",
    stream.status === 200 && stream.deltas.length >= 1 && streamed.length > 0 && /\[DONE\]/.test(stream.text),
    "chunks=" + stream.deltas.length + " text=" + JSON.stringify(streamed.slice(0, 50)),
  );

  // 10. Tool calling + file/folder access outside the project. The token is
  // random and never sent to the model: only a real read_file can return it.
  const token = "ZC-" + crypto.randomBytes(8).toString("hex");
  const proofDir = path.join(os.tmpdir(), "opencode");
  const proofFile = path.join(proofDir, "uds-e2e-" + process.pid + ".txt");
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(proofFile, token + "\n", "utf8");
  const toolReply = await uds("/v1/chat/completions", {
    model: "code-guru",
    messages: [{
      role: "user",
      content: "Use the read_file tool on " + proofFile + " and the list_directory tool on " +
        proofDir + ". Reply with the exact file content and confirm whether " +
        path.basename(proofFile) + " appears in the directory listing.",
    }],
    max_tokens: 300,
    temperature: 0,
  });
  const toolText = contentOf(toolReply.json);
  check(
    "agent tool call reads a file outside the project",
    toolReply.status === 200 && toolText.includes(token),
    "status=" + toolReply.status + " token_seen=" + toolText.includes(token) +
      " content=" + JSON.stringify(toolText.slice(0, 80)),
  );
  check(
    "agent tool call lists the directory",
    toolReply.status === 200 && toolText.includes(path.basename(proofFile)),
    "status=" + toolReply.status + " name_seen=" + toolText.includes(path.basename(proofFile)),
  );

  // 11. MCP tools directly on the same socket, including /etc (outside project).
  const read = await mcpCall("read_file", { path: "/etc/hostname" });
  const readText = read.ok && read.json && read.json.result && read.json.result.content &&
    read.json.result.content[0] && read.json.result.content[0].text;
  check(
    "MCP read_file outside the project over UDS",
    read.ok && typeof readText === "string" && readText.trim() === os.hostname(),
    "content=" + JSON.stringify(String(readText || "").trim().slice(0, 40)),
  );
  const list = await mcpCall("list_directory", { path: os.tmpdir() });
  const listText = list.ok && list.json && list.json.result && list.json.result.content &&
    list.json.result.content[0] && list.json.result.content[0].text;
  check(
    "MCP list_directory over UDS",
    list.ok && typeof listText === "string" && listText.includes("opencode"),
    "has_opencode=" + String(listText || "").includes("opencode"),
  );

  // 12. Every model list marks models reachable through this socket.
  for (const endpoint of ["/v1/models", "/api/v0/models", "/api/v1/models"]) {
    const res = await uds(endpoint, undefined, 10000);
    const rows = (res.json && res.json.data) || [];
    const labelled = rows.filter(
      (m) => m.transport === "uds" && m.transportLabel === "UDS model",
    ).length;
    check(
      "UDS model label on " + endpoint,
      res.status === 200 && rows.length > 0 && labelled === rows.length,
      labelled + "/" + rows.length,
    );
  }

  // 12b. The gateway must not advertise a local model the bridge does not
  // serve. Asserted only when this host's bridge reports an empty list, so
  // the check is meaningful on a machine with a real local model too.
  const serviceBridge = await send({
    port: ENV.ports.bridge || 11435,
    pathname: "/health",
    timeoutMs: 3000,
  });
  if (
    serviceBridge.status === 200 &&
    serviceBridge.json &&
    Array.isArray(serviceBridge.json.installed_models) &&
    serviceBridge.json.installed_models.length === 0
  ) {
    const localCatalog = await uds("/api/v1/models", undefined, 10000);
    const localRows = ((localCatalog.json && localCatalog.json.data) || []).filter(
      (m) => m.provider === "ollama",
    );
    check(
      "no phantom local model when the bridge has none",
      localRows.length === 0,
      "gateway_local=" + localRows.length,
    );
  }

  // 13. Local LLM bridge with no upstream: no fake model, no boot stall.
  const deadPort = await freePort();
  const bridgePort = await freePort();
  const startedAt = Date.now();
  const bridge = spawn(process.execPath, [path.join(ROOT, "local-llm-bridge.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_BACKEND: "auto",
      BRIDGE_UPSTREAMS: "http://127.0.0.1:" + deadPort,
      BRIDGE_PROBE_DEFAULTS: "0",
      BRIDGE_PROBE_TIMEOUT_MS: "300",
      BRIDGE_REFRESH_MS: "3000",
      BRIDGE_MODEL: "",
      BRIDGE_UPSTREAM_MODEL: "",
      BRIDGE_OLLAMA_URL: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let bridgeLog = "";
  if (bridge.stdout) bridge.stdout.on("data", (d) => (bridgeLog += d.toString()));
  if (bridge.stderr) bridge.stderr.on("data", (d) => (bridgeLog += d.toString()));
  try {
    let bridgeHealth = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await send({ port: bridgePort, pathname: "/health", timeoutMs: 1500 });
      if (res.status === 200) {
        bridgeHealth = res;
        break;
      }
      await sleep(250);
    }
    const bootMs = Date.now() - startedAt;
    check(
      "bridge listens without waiting for an upstream",
      !!bridgeHealth && bootMs < 6000,
      "boot_ms=" + bootMs,
    );
    check(
      "bridge reports no-upstream with no invented model",
      !!bridgeHealth && bridgeHealth.json.status === "no-upstream" &&
        Array.isArray(bridgeHealth.json.installed_models) &&
        bridgeHealth.json.installed_models.length === 0 &&
        bridgeHealth.json.upstream.ready === false,
      "status=" + (bridgeHealth && bridgeHealth.json && bridgeHealth.json.status),
    );
    const modelList = await send({ port: bridgePort, pathname: "/v1/models", timeoutMs: 5000 });
    check(
      "bridge model list is empty when nothing is running",
      modelList.status === 200 && !!modelList.json &&
        Array.isArray(modelList.json.data) && modelList.json.data.length === 0,
      "count=" + (modelList.json && modelList.json.data ? modelList.json.data.length : "?"),
    );
    const failStart = Date.now();
    const noUpstream = await send({
      port: bridgePort,
      pathname: "/v1/chat/completions",
      body: { model: "any-model", messages: [{ role: "user", content: "hi" }] },
      timeoutMs: 8000,
    });
    const failMs = Date.now() - failStart;
    check(
      "bridge chat fails fast instead of hanging",
      noUpstream.status === 503 && failMs < 3000 &&
        !!(noUpstream.json && noUpstream.json.error && noUpstream.json.error.type === "no_upstream"),
      "status=" + noUpstream.status + " ms=" + failMs,
    );
  } finally {
    bridge.kill("SIGTERM");
    await sleep(250);
  }

  // 14. Discovery is dynamic: a server started later is picked up without a
  // restart. The live gateway is a real OpenAI-compatible upstream on this
  // machine, so bridge -> gateway -> Gemini proves discovery and routing.
  const discoveredPort = await freePort();
  const discovered = spawn(process.execPath, [path.join(ROOT, "local-llm-bridge.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BRIDGE_PORT: String(discoveredPort),
      BRIDGE_BACKEND: "auto",
      BRIDGE_UPSTREAMS: "gateway=http://127.0.0.1:" + (ENV.ports.api || 5050),
      BRIDGE_PROBE_DEFAULTS: "0",
      BRIDGE_PROBE_TIMEOUT_MS: "800",
      BRIDGE_REFRESH_MS: "3000",
      BRIDGE_MODEL: "",
      BRIDGE_UPSTREAM_MODEL: "",
      BRIDGE_OLLAMA_URL: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let discoveredHealth = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await send({ port: discoveredPort, pathname: "/health", timeoutMs: 1500 });
      if (res.status === 200 && res.json && res.json.upstream && res.json.upstream.ready === true) {
        discoveredHealth = res;
        break;
      }
      await sleep(250);
    }
    const discoveredModels = await send({ port: discoveredPort, pathname: "/v1/models", timeoutMs: 5000 });
    const ids = ((discoveredModels.json && discoveredModels.json.data) || []).map((m) => m.id);
    check(
      "bridge discovers a live upstream at request time",
      !!discoveredHealth && ids.includes("code-guru"),
      "models=" + ids.length + " has_code_guru=" + ids.includes("code-guru"),
    );
    const routed = await send({
      port: discoveredPort,
      pathname: "/v1/chat/completions",
      body: {
        model: "code-guru",
        messages: [{ role: "user", content: "Reply with exactly: BRIDGE-OK" }],
        max_tokens: 24,
        temperature: 0,
      },
      timeoutMs: 120000,
    });
    check(
      "bridge routes to the discovered model",
      routed.status === 200 && /BRIDGE-OK/.test(contentOf(routed.json)),
      "status=" + routed.status + " content=" + JSON.stringify(contentOf(routed.json).slice(0, 40)),
    );
  } finally {
    discovered.kill("SIGTERM");
    await sleep(250);
  }

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(proofFile, { force: true });

  console.log("");
  console.log("checks=" + (pass + fail) + " pass=" + pass + " fail=" + fail);
  if (fail === 0) {
    console.log("RESULT: UDS E2E PASS");
  } else {
    console.log("RESULT: UDS E2E FAIL");
    for (const item of failures) console.log(" - " + item);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.log("RESULT: UDS E2E FAIL");
  console.log(" - uncaught: " + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
