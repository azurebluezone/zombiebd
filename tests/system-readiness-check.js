#!/usr/bin/env node
"use strict";

/**
 * System readiness audit.
 *
 * Everything here talks to real processes and real files:
 *   - static deliverables and syntax
 *   - a throwaway bridge process with a deliberately wrong model name
 *   - the live gateway (/health, /api/system, /api/agents, /mcp)
 *   - the operator log line for an identified MCP request
 *   - the per-agent tool audit as a child process
 *   - the rendered Caddyfile through `caddy validate`
 *
 * Caddy on :80/:443 is reported as live (HTTP redirect + HTTPS /health
 * through Caddy) or installer-ready when the unit has not been installed.
 * The live check runs as the normal user, so it proves the user path rather
 * than root-only process facts.
 */

const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { loadEnv } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const API_PORT = ENV.ports.api || 5050;
const BRIDGE_PORT = ENV.ports.bridge || 11435;
const MAIN_HOST = ENV.derived.mainHost || "";
const API = process.env.ZOMBIE_API_URL || "http://127.0.0.1:" + API_PORT;
const OLLAMA = process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434";
const ORIGIN = "https://audit.local";
const IDENTITY_AGENT = "readiness-audit";
const LOG_DIR = path.resolve(ROOT, ENV.values.LOG_DIR || "logs");
const UDS_MCP = ENV.derived.udsPath || "/tmp/zombiecoder/mcp.sock";
const UDS_OPENAI =
  ENV.values.OPENAI_UDS_PATH || "/tmp/zombiecoder/openai.sock";

const state = {
  api: 0,
  bridge: 0,
  system: false,
  identity: false,
  tools: 0,
  agents: 0,
  bound: 0,
  probes: 0,
  edge: false,
  edgeMode: "not-checked",
};

let failures = 0;
function pass(message) {
  console.log("PASS " + message);
}
function fail(message) {
  failures++;
  console.log("FAIL " + message);
}

function request(url, options) {
  const payload = options && options.body ? JSON.stringify(options.body) : null;
  const parsed = new URL(url);
  const headers = Object.assign({}, (options && options.headers) || {});
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: (options && options.method) || "GET",
        headers,
        timeout: (options && options.timeoutMs) || 8000,
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* non-JSON is reported through status/text */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// HTTPS through Caddy with SNI set to MAIN_HOST. The certificate is the
// internal CA (TLS_MODE=internal), so the local check does not require the
// host CA to be installed; the proxy path and payload are what matter here.
function httpsRequest(pathname, hostHeader) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: 443,
        path: pathname,
        method: "GET",
        servername: hostHeader || MAIN_HOST,
        rejectUnauthorized: false,
        timeout: 6000,
        headers: { Host: hostHeader || MAIN_HOST, Accept: "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* non-JSON is reported through status/text */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, text: "", error: "timeout" });
    });
    req.end();
  });
}

// MCP over UDS is newline-delimited JSON-RPC, not HTTP. The OpenAI UDS is a
// real HTTP server. Both are checked because a listener whose path was
// unlinked during a restart still shows in `ss` but no client can reach it.
function udsMcpTools(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath });
    let buf = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 5000);
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "readiness-uds",
          method: "tools/list",
          params: {},
        }) + "\n",
      );
    });
    socket.on("data", (d) => {
      buf += d;
      const cut = buf.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      try {
        finish({ ok: true, json: JSON.parse(buf.slice(0, cut)) });
      } catch (_) {
        finish({ ok: false, error: "invalid json" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}

function udsHttpGet(socketPath, pathname) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: pathname,
        method: "GET",
        timeout: 5000,
        headers: { Accept: "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "timeout" });
    });
    req.end();
  });
}

async function localUds() {
  const mcp = await udsMcpTools(UDS_MCP);
  if (!mcp.ok) throw new Error("mcp.sock " + mcp.error + " path=" + UDS_MCP);
  const tools = mcp.json && mcp.json.result && mcp.json.result.tools;
  if (!Array.isArray(tools) || tools.length !== 153) {
    throw new Error("mcp.sock tools=" + (Array.isArray(tools) ? tools.length : "bad"));
  }
  const openai = await udsHttpGet(UDS_OPENAI, "/v1/models");
  if (openai.status !== 200 || !openai.json || !Array.isArray(openai.json.data)) {
    throw new Error(
      "openai.sock status=" + openai.status + " error=" + (openai.error || "no data"),
    );
  }
  pass(
    "uds mcp_tools=" +
      tools.length +
      " openai_models=" +
      openai.json.data.length +
      " paths=" +
      UDS_MCP +
      "," +
      UDS_OPENAI,
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function run(command, args, options) {
  return spawnSync(command, args, Object.assign({ cwd: ROOT, encoding: "utf8", timeout: 30000 }, options));
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((value) => {
      if (value === false) throw new Error("check returned false");
      pass(name);
      return true;
    })
    .catch((err) => {
      fail(name + " — " + err.message);
      return false;
    });
}

async function bridgeAutoSelect() {
  const port = await freePort();
  const socket = path.join("/tmp/opencode", "readiness-bridge-" + process.pid + ".sock");
  const child = spawn(process.execPath, [path.join(ROOT, "local-llm-bridge.js")], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BRIDGE_BACKEND: "ollama",
      BRIDGE_PORT: String(port),
      BRIDGE_SOCKET: socket,
      BRIDGE_MODEL: "definitely-not-installed",
      BRIDGE_UPSTREAM_MODEL: "definitely-not-installed",
      BRIDGE_OLLAMA_URL: OLLAMA,
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));

  try {
    let health = null;
    for (let i = 0; i < 60; i++) {
      const res = await request("http://127.0.0.1:" + port + "/health", { timeoutMs: 1200 });
      if (res.status === 200 && res.json) {
        health = res.json;
        break;
      }
      await sleep(250);
    }
    if (!health) {
      throw new Error("bridge did not answer on :" + port + " output=" + output.slice(-300));
    }
    state.bridge = 200;
    if (health.model_source !== "autoselect") {
      throw new Error("model_source=" + health.model_source + " expected=autoselect");
    }
    if (!health.model || health.model === "definitely-not-installed") {
      throw new Error("selected model is still the configured alias: " + health.model);
    }
    if (!Array.isArray(health.installed_models) || health.installed_models.length === 0) {
      throw new Error("installed_models is empty");
    }
    if (!health.upstream || health.upstream.ready !== true) {
      throw new Error("upstream not ready: " + JSON.stringify(health.upstream));
    }
    pass(
      "bridge autoselect configured=definitely-not-installed selected=" +
        health.model +
        " source=" +
        health.model_source +
        " installed=" +
        health.installed_models.join(","),
    );
    return true;
  } finally {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
    await sleep(150);
    try {
      fs.unlinkSync(socket);
    } catch (_) {}
  }
}

async function liveApi() {
  const health = await request(API + "/health", { timeoutMs: 5000 });
  if (health.status !== 200 || !health.json || health.json.healthy !== true) {
    throw new Error("status=" + health.status + " error=" + (health.error || "unhealthy"));
  }
  state.api = health.status;
  pass("api /health status=200 healthy=true");

  const system = health.json.system;
  if (!system || !system.hostname || !system.cpu || !system.memory || !system.disk) {
    throw new Error("/health.system incomplete: " + JSON.stringify(system || null));
  }
  pass(
    "health.system host=" +
      system.hostname +
      " cpu=" +
      system.cpu +
      " cores=" +
      system.cores +
      " mem_free=" +
      system.memory.free_gb +
      "GB disk_free=" +
      system.disk.free_gb +
      "GB",
  );

  const apiSystem = await request(API + "/api/system", { timeoutMs: 8000 });
  if (apiSystem.status !== 200 || !apiSystem.json || apiSystem.json.ok !== true) {
    throw new Error("/api/system status=" + apiSystem.status);
  }
  const full = apiSystem.json.system || {};
  if (!full.hostname || !full.os || !full.kernel || !full.arch || !full.node || !full.cpu) {
    throw new Error("/api/system missing host fields");
  }
  if (!Array.isArray(apiSystem.json.services) || apiSystem.json.services.length === 0) {
    throw new Error("/api/system services missing");
  }
  const apiService = apiSystem.json.services.find((s) => s.name === "api");
  if (!apiService || apiService.listening !== true) {
    throw new Error("api service not listening in service map");
  }
  const seen = apiSystem.json.services.filter((s) => s.listening).map((s) => s.name + ":" + s.port);
  state.system = true;
  pass(
    "/api/system host=" +
      full.hostname +
      " " +
      full.os +
      "/" +
      full.arch +
      " node=" +
      full.node +
      " listeners=" +
      seen.join(","),
  );

  const agents = await request(API + "/api/agents", { timeoutMs: 5000 });
  if (agents.status !== 200 || !agents.json || !Array.isArray(agents.json.agents)) {
    throw new Error("/api/agents status=" + agents.status);
  }
  state.agents = agents.json.agents.length;
  if (state.agents !== 9) throw new Error("agents=" + state.agents + " expected=9");
  const first = agents.json.agents[0];
  state.tools = (first && first.tools && first.tools.catalog) || 0;
  state.bound = (first && first.tools && first.tools.bound && first.tools.bound.length) || 0;
  if (state.tools !== 153) throw new Error("catalog=" + state.tools + " expected=153");
  if (state.bound !== 25) throw new Error("bound=" + state.bound + " expected=25");
  pass("agents=9 tools=153 bound=25 source=/api/agents");
}

function decodeActor(value) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

async function mcpIdentity() {
  const logFile = path.join(LOG_DIR, new Date().toISOString().slice(0, 10) + ".log");
  let before = 0;
  try {
    before = fs.statSync(logFile).size;
  } catch (_) {
    before = 0;
  }

  const headers = {
    "X-Agent-Id": IDENTITY_AGENT,
    "X-MCP-Client-Name": "system-readiness-check",
    Origin: ORIGIN,
    Accept: "application/json",
  };
  const toolsResponse = await request(API + "/mcp", {
    method: "POST",
    headers,
    timeoutMs: 8000,
    body: { jsonrpc: "2.0", id: "readiness-tools", method: "tools/list", params: {} },
  });
  if (toolsResponse.status !== 200 || !toolsResponse.json) {
    throw new Error("/mcp status=" + toolsResponse.status + " error=" + toolsResponse.error);
  }
  const tools = toolsResponse.json.result && toolsResponse.json.result.tools;
  if (!Array.isArray(tools)) throw new Error("/mcp tools/list returned no tools");
  if (tools.length !== 153) throw new Error("/mcp tools=" + tools.length + " expected=153");
  state.tools = tools.length;

  const actor = decodeActor(toolsResponse.headers["x-request-actor"]);
  if (!actor) throw new Error("X-Request-Actor missing");
  if (actor.agent !== IDENTITY_AGENT) throw new Error("actor.agent=" + actor.agent);
  if (actor.origin !== ORIGIN) throw new Error("actor.origin=" + actor.origin);
  if (actor.from === "unknown") throw new Error("actor.from=unknown");

  await sleep(250);
  let appended = "";
  try {
    // statSync().size is bytes, String#slice is UTF-16 code units. Reading the
    // file as a string and slicing at a byte offset starts mid-line once the
    // log contains Bengali text, so slice the Buffer instead.
    const all = fs.readFileSync(logFile);
    appended = all.subarray(before).toString("utf8");
  } catch (err) {
    throw new Error("log unreadable " + logFile + ": " + err.message);
  }
  const lines = appended
    .split("\n")
    .filter((line) => line.includes("MCP_TOOLS_LIST"))
    .filter((line) => line.includes(JSON.stringify(IDENTITY_AGENT)) && line.includes(JSON.stringify(ORIGIN)));
  if (!lines.length) {
    throw new Error(
      "MCP_TOOLS_LIST does not carry agent/origin; appended=" +
        JSON.stringify(appended.slice(-400)),
    );
  }
  const leaked = appended.includes('"origin":"direct"');
  if (leaked) throw new Error('log still contains origin:"direct" for the probe');

  state.identity = true;
  pass(
    "mcp identity agent=" +
      actor.agent +
      " origin=" +
      actor.origin +
      " from=" +
      actor.from +
      " header=X-Request-Actor log=MCP_TOOLS_LIST",
  );
}

async function agentPrefixDispatch() {
  const response = await request(API + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-Id": IDENTITY_AGENT, Origin: ORIGIN },
    timeoutMs: 8000,
    body: {
      model: "agent/__none__",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      stream: false,
    },
  });
  if (response.status !== 404) {
    throw new Error("status=" + response.status + " expected=404");
  }
  const message =
    (response.json && response.json.error && (response.json.error.message || response.json.error)) || "";
  if (!String(message).includes("Agent or model not found")) {
    throw new Error("unexpected body: " + String(message).slice(0, 120));
  }
  pass("agent/__none__ status=404 agent_mode=true message=Agent or model not found");
}

function agentToolAudit() {
  const result = spawnSync(process.execPath, [path.join(ROOT, "tests", "agent-tools-check.js")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
    env: Object.assign({}, process.env, { PORT: String(API_PORT), ZOMBIE_API_URL: API }),
  });
  const output = (result.stdout || "") + (result.stderr || "");
  for (const line of output.split("\n")) {
    if (line.startsWith("PASS ") || line.startsWith("FAIL ") || line.startsWith("FINDING ") || line.startsWith("RESULT: ")) {
      console.log("  " + line);
    }
  }
  if (result.status !== 0) {
    throw new Error("agent-tools-check exit=" + result.status);
  }
  const match = output.match(/RESULT: AGENT TOOLS PASS agents=(\d+) catalog=(\d+) bound=(\d+) probes=(\d+)/);
  if (!match) throw new Error("agent-tools-check sentinel missing");
  state.agents = Number(match[1]);
  state.tools = Number(match[2]);
  state.bound = Number(match[3]);
  state.probes = Number(match[4]);
  if (state.probes !== 9) throw new Error("probes=" + state.probes + " expected=9");
  pass("agent tools audit probes=" + state.probes + " exit=0");
}

async function edgeReady() {
  const caddy = run("caddy", ["version"]);
  if (caddy.status !== 0) throw new Error("caddy binary missing");
  const version = (caddy.stdout || caddy.stderr || "").split("\n")[0];

  const out = path.join("/tmp/opencode", "Caddyfile.readiness." + process.pid);
  const render = run(process.execPath, [path.join(ROOT, "scripts", "caddy-render.js"), "--out", out]);
  if (render.status !== 0) {
    throw new Error("caddy-render exit=" + render.status + " " + (render.stderr || "").slice(-200));
  }
  const validate = run("caddy", ["validate", "--config", out, "--adapter", "caddyfile"]);
  const text = (validate.stdout || "") + (validate.stderr || "");
  if (validate.status !== 0 || !text.includes("Valid configuration")) {
    throw new Error("caddy validate exit=" + validate.status + " " + text.slice(-200));
  }

  const installer = path.join(ROOT, "deploy", "install-edge.sh");
  const installerText = fs.readFileSync(installer, "utf8");
  if (!installerText.includes("AmbientCapabilities=CAP_NET_BIND_SERVICE")) {
    throw new Error("installer unit is missing CAP_NET_BIND_SERVICE");
  }
  const mode = fs.statSync(installer).mode;
  if ((mode & 0o111) === 0) throw new Error("deploy/install-edge.sh is not executable");

  let live = false;
  let httpCode = 0;
  let httpsCode = 0;
  let httpsHealthy = false;

  const caddyState = run("systemctl", ["is-active", "caddy"]);
  const caddyActive = (caddyState.stdout || "").trim() === "active";
  if (caddyActive) {
    if (!MAIN_HOST) throw new Error("MAIN_HOST is required for the live edge check");
    for (let i = 0; i < 20; i++) {
      const httpRes = await request("http://127.0.0.1/health", {
        timeoutMs: 2500,
        headers: { Host: MAIN_HOST },
      });
      const httpsRes = await httpsRequest("/health");
      httpCode = httpRes.status;
      httpsCode = httpsRes.status;
      httpsHealthy = httpsRes.status === 200 && httpsRes.json && httpsRes.json.healthy === true;
      const redirects =
        (httpCode === 301 || httpCode === 302 || httpCode === 307 || httpCode === 308) &&
        String(httpRes.headers.location || "").startsWith("https://");
      const caddyServes =
        String(httpRes.headers.server || "").toLowerCase().includes("caddy");
      if (redirects && caddyServes && httpsHealthy) {
        live = true;
        break;
      }
      await sleep(500);
    }
    if (!live) {
      throw new Error(
        "caddy active but user path failed http=" +
          httpCode +
          " https=" +
          httpsCode +
          " healthy=" +
          httpsHealthy,
      );
    }
    const apacheState = run("systemctl", ["is-active", "apache2"]);
    if ((apacheState.stdout || "").trim() === "active") {
      throw new Error("apache2 is still active while caddy is live");
    }
  }

  state.edge = true;
  state.edgeMode = live ? "live" : "installer-ready";
  pass(
    "edge validate=ok " +
      version.trim() +
      " mode=" +
      state.edgeMode +
      (live
        ? " http=" + httpCode + " https=" + httpsCode + " health=ok host=" + MAIN_HOST
        : " next=sudo bash deploy/install-edge.sh"),
  );
}

async function main() {
  console.log("=== zombiebd system readiness ===");
  console.log("root=" + ROOT + " api=" + API + " bridge=" + BRIDGE_PORT + " ollama=" + OLLAMA);

  await check("static files present", () => {
    const required = [
      "api.js",
      "start.js",
      "local-llm-bridge.js",
      "lib/system-info.js",
      "lib/env.js",
      "scripts/boot-all.sh",
      "scripts/caddy-render.js",
      "deploy/install-edge.sh",
      "deploy/Caddyfile.template",
      "tests/agent-tools-check.js",
    ];
    const missing = required.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    if (missing.length) throw new Error("missing " + missing.join(","));
  });

  await check("static syntax", () => {
    for (const file of ["api.js", "start.js", "local-llm-bridge.js", "lib/system-info.js", "scripts/caddy-render.js", "tests/agent-tools-check.js"]) {
      const result = run(process.execPath, ["--check", path.join(ROOT, file)]);
      if (result.status !== 0) throw new Error(file + ": " + (result.stderr || "").trim().slice(0, 160));
    }
    for (const file of ["scripts/boot-all.sh", "deploy/install-edge.sh"]) {
      const result = run("bash", ["-n", path.join(ROOT, file)]);
      if (result.status !== 0) throw new Error(file + ": " + (result.stderr || "").trim().slice(0, 160));
    }
  });

  await check("static wiring", () => {
    const bridge = fs.readFileSync(path.join(ROOT, "local-llm-bridge.js"), "utf8");
    if (!bridge.includes("refreshModelState") || !bridge.includes("resolveRequestModel")) {
      throw new Error("bridge has no model auto-select");
    }
    const start = fs.readFileSync(path.join(ROOT, "start.js"), "utf8");
    if (!start.includes("[SYSTEM]") || !start.includes("startBridge")) {
      throw new Error("start.js has no system banner or bridge startup");
    }
    const api = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
    if (!api.includes("/api/system") || !api.includes("X-Request-Actor") || !api.includes("requestActor")) {
      throw new Error("api.js has no system route or request identity");
    }
  });

  await check("bridge auto-select on a throwaway port", bridgeAutoSelect);
  await check("live API and system details", liveApi);
  await check("local UDS transports", localUds);
  await check("MCP request identity", mcpIdentity);
  await check("agent/<id> dispatch", agentPrefixDispatch);
  await check("per-agent tool audit", agentToolAudit);
  await check("edge deliverable", edgeReady);

  if (failures === 0) {
    console.log(
      "RESULT: SYSTEM READINESS PASS api=" +
        state.api +
        " bridge=" +
        state.bridge +
        " system=" +
        (state.system ? "ok" : "fail") +
        " identity=" +
        (state.identity ? "ok" : "fail") +
        " tools=" +
        state.tools +
        " agents=" +
        state.agents +
        " bound=" +
        state.bound +
        " probes=" +
        state.probes +
        " edge=" +
        (state.edgeMode === "live" ? "live" : "ready"),
    );
    console.log("EDGE_MODE: " + state.edgeMode);
    process.exitCode = 0;
    return;
  }
  console.log("RESULT: SYSTEM READINESS FAIL failures=" + failures);
  process.exitCode = 1;
}

main().catch((err) => {
  console.log("RESULT: SYSTEM READINESS FAIL error=" + err.message);
  process.exitCode = 1;
});
