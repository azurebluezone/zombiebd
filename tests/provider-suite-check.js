#!/usr/bin/env node
"use strict";

/*
 * Provider acceptance suite.
 *
 * Real inputs, no provider mocks:
 *   nvidia        custom_1  https://integrate.api.nvidia.com/v1
 *   gemini        gemini    https://generativelanguage.googleapis.com/v1beta
 *   groq          groq      https://api.groq.com/openai/v1
 *   ollama-local  ollama    http://localhost:11434/v1
 *   llama-cpu     llamacpp  http://localhost:9932/v1
 *   gateway       live      http://localhost:5050 (agent code-guru)
 *
 * It proves:
 *   1. api.js passes `node --check`
 *   2. api.js has no duplicate top-level function names
 *   3. api.js has no duplicate route + method handlers
 *   4. every non-opencode provider returns non-empty text in a real
 *      OpenAI chat.completion envelope through provider/index.js
 *   5. the live gateway still serves an agent completion end to end
 *   6. opencode is closed: a source instance with OPENCODE_ENABLED=false
 *      advertises no opencode model and rejects its model with 400
 *      model_not_found, while groq/gemini/nvidia/ollama stay visible
 *
 * Prints PROVIDER_SUITE_OK only when every check above passes.
 */

const fs = require("fs");
const net = require("net");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { readEnvFile } = require("../lib/env.js");
const { expandEnv } = require("../lib/expand-env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const GATEWAY = (process.env.BASE_URL || "http://localhost:5050").replace(/\/+$/, "");
const TMP = path.join("/tmp/opencode", "provider-suite-" + process.pid);

const MODELS = {
  nvidia: ENV.NVIDIA_TEST_MODEL || "nvidia/nemotron-3.5-bolt-e4b",
  gemini: ENV.GEMINI_TEST_MODEL || "gemini-3.5-flash",
  groq: ENV.GROQ_TEST_MODEL || "openai/gpt-oss-20b",
  ollama: ENV.OLLAMA_TEST_MODEL || "lfm3:1.7b",
  llamacpp: ENV.LLAMA_CPP_TEST_MODEL || ENV.LLAMA_CPP_MODEL || "deepseek-v4-pro",
};

const OPENCODE_MODEL = "deepseek-v4.1-flash-free";
// .env keeps LLAMA_CPP_BASE as the server root and LLAMA_CPP_URL as the
// OpenAI-compatible base (${LLAMA_CPP_BASE}/v1). Expand the reference here;
// readEnvFile returns the literal ${...} text.
const LLAMA_OPENAI_BASE = expandEnv(
  ENV.LLAMA_CPP_URL || ENV.LLAMA_CPP_BASE || "http://localhost:9932/v1",
);

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}
function fail(name, detail) {
  failed++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}
function expect(name, ok, detail) {
  if (ok) pass(name, detail);
  else fail(name, detail);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function httpJson(port, requestPath, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: "localhost",
        port,
        path: requestPath,
        method,
        timeout: timeoutMs || 10000,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d.toString()));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* keep null */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on("error", (e) => resolve({ status: 0, json: null, text: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, json: null, text: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function scanDuplicates(source) {
  function countAll(re, keyOf) {
    const out = new Map();
    let m;
    while ((m = re.exec(source))) {
      const key = keyOf(m);
      out.set(key, (out.get(key) || 0) + 1);
    }
    return out;
  }
  const functions = countAll(
    /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm,
    (m) => m[1],
  );
  const fnConsts = countAll(
    /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/gm,
    (m) => m[1],
  );
  const urlFirst = countAll(
    /if\s*\(\s*(?:url|pathname)\s*===\s*"([^"]+)"\s*&&\s*method\s*===\s*"([A-Z]+)"/g,
    (m) => m[2] + " " + m[1],
  );
  const methodFirst = countAll(
    /if\s*\(\s*method\s*===\s*"([A-Z]+)"\s*&&\s*(?:url|pathname)\s*===\s*"([^"]+)"/g,
    (m) => m[1] + " " + m[2],
  );
  const routes = new Map();
  for (const [key, n] of urlFirst) routes.set(key, (routes.get(key) || 0) + n);
  for (const [key, n] of methodFirst) routes.set(key, (routes.get(key) || 0) + n);
  const duplicates = (map) => [...map].filter(([, n]) => n > 1);
  return {
    functions: duplicates(functions),
    fnConsts: duplicates(fnConsts),
    routes: duplicates(routes),
    functionCount: functions.size,
    routeCount: routes.size,
  };
}

function startSourceInstance(port, grpcPort, httpsPort) {
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  const env = Object.assign({}, process.env, {
    PORT: String(port),
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: path.join(dataDir, "models.db"),
    DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "1",
    INSTANCE_ID: "provider-suite-" + Date.now(),
    // The disable must win over a real key and a real model list.
    OPENCODE_ENABLED: "false",
    OPENCODE_MODELS: OPENCODE_MODEL,
    OPENCODE_API_KEY: ENV.OPENCODE_API_KEY || "oc_sk_suite",
    // Keep unrelated cloud probes out of startup; the source .env still
    // supplies groq/gemini/nvidia/ollama model rows for the catalogue check.
    OLLAMA_CLOUD_API_KEY: "",
    BRIDGE_ENABLED: "0",
    CUSTOM_PROVIDER_9_URL: LLAMA_OPENAI_BASE,
    CUSTOM_PROVIDER_9_KEY: "",
    CUSTOM_PROVIDER_9_TYPE: "openai",
    CUSTOM_PROVIDER_9_MODELS: MODELS.llamacpp,
    CUSTOM_PROVIDER_9_PRIORITY: "9",
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
  const deadline = Date.now() + (timeoutMs || 45000);
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

async function directProviders(registry) {
  const messages = (marker) => [
    { role: "user", content: "Reply with exactly: " + marker },
  ];
  const cases = [
    {
      name: "nvidia",
      providerId: "custom_1",
      model: MODELS.nvidia,
      marker: "NVIDIA_OK",
      maxTokens: 64,
      dialect: "openai",
    },
    {
      name: "gemini",
      providerId: "gemini",
      model: MODELS.gemini,
      marker: "GEMINI_OK",
      maxTokens: 256,
      dialect: "gemini",
    },
    {
      name: "groq",
      providerId: "groq",
      model: MODELS.groq,
      marker: "GROQ_OK",
      maxTokens: 256,
      dialect: "groq",
    },
    {
      name: "ollama-local",
      providerId: "ollama",
      model: MODELS.ollama,
      marker: "OLLAMA_OK",
      maxTokens: 64,
      dialect: "ollama",
    },
    {
      name: "llama-cpu",
      config: {
        id: "llamacpp",
        type: "llamacpp",
        baseUrl: LLAMA_OPENAI_BASE,
        key: "",
        timeout: 180000,
      },
      model: MODELS.llamacpp,
      marker: "LLAMA_OK",
      maxTokens: 32,
      dialect: "llamacpp",
    },
  ];

  const results = await Promise.all(
    cases.map(async (c) => {
      const started = Date.now();
      try {
        const cfg = c.config
          ? c.config
          : Object.assign({}, registry.configForId(c.providerId), {
              timeout: 120000,
            });
        const res = await registry.chat({
          config: cfg,
          model: c.model,
          messages: messages(c.marker),
          temperature: 0,
          max_tokens: c.maxTokens,
        });
        const content = String(res.content || "").trim();
        const envelope = res.normalized || {};
        const choice = envelope.choices && envelope.choices[0];
        const ok =
          res.ok === true &&
          content.includes(c.marker) &&
          envelope.object === "chat.completion" &&
          !!choice &&
          choice.message &&
          choice.message.role === "assistant";
        return {
          name: c.name,
          ok,
          detail: ok
            ? "model=" +
              c.model +
              " ms=" +
              (Date.now() - started) +
              " dialect=" +
              (res.dialect || "?") +
              " content=" +
              JSON.stringify(content.slice(0, 40))
            : "model=" +
              c.model +
              " ok=" +
              res.ok +
              " object=" +
              envelope.object +
              " content=" +
              JSON.stringify(content.slice(0, 60)) +
              " error=" +
              (res.error || ""),
        };
      } catch (e) {
        return { name: c.name, ok: false, detail: "threw: " + (e && e.message) };
      }
    }),
  );

  for (const r of results) expect(r.name + " direct OpenAI completion", r.ok, r.detail);
  return results.filter((r) => r.ok).length;
}

async function gatewayCheck() {
  const started = Date.now();
  const res = await httpJson(
    Number(new URL(GATEWAY).port || 80),
    "/v1/chat/completions",
    "POST",
    {
      model: "code-guru",
      messages: [{ role: "user", content: "Reply with exactly: GATEWAY_OK" }],
      max_tokens: 64,
      temperature: 0,
    },
    120000,
  );
  const json = res.json || {};
  const choice = (json.choices && json.choices[0]) || {};
  const content = String((choice.message && choice.message.content) || "").trim();
  const ok =
    res.status === 200 &&
    json.object === "chat.completion" &&
    content.includes("GATEWAY_OK") &&
    json.agent &&
    json.agent.id === "code-guru";
  expect(
    "live gateway code-guru completion",
    ok,
    ok
      ? "ms=" +
          (Date.now() - started) +
          " agent=" +
          json.agent.id +
          " content=" +
          JSON.stringify(content.slice(0, 40))
      : "status=" +
          res.status +
          " object=" +
          json.object +
          " content=" +
          JSON.stringify(content.slice(0, 60)) +
          " body=" +
          String(res.text || "").slice(0, 160),
  );
}

async function opencodeDisabledCheck() {
  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const instance = startSourceInstance(port, grpcPort, httpsPort);
  try {
    const health = await waitHealth(port, 45000);
    expect(
      "source gateway healthy",
      !!health,
      health ? "agents=" + health.agents + " models=" + health.models : "no health",
    );
    if (!health) {
      console.log(instance.output().slice(-2000));
      return;
    }

    const v1 = await httpJson(port, "/api/v1/models", "GET", null, 10000);
    const rows = (v1.json && (v1.json.data || v1.json.models)) || [];
    const opencodeRows = rows.filter(
      (r) => r && (r.provider === "opencode" || r.owned_by === "OpenCode"),
    );
    expect(
      "opencode absent from /api/v1/models",
      v1.status === 200 && opencodeRows.length === 0,
      "status=" + v1.status + " rows=" + rows.length + " opencode=" + opencodeRows.length,
    );
    expect(
      "groq model visible in /api/v1/models",
      rows.some((r) => r && r.id === MODELS.groq && r.provider === "groq"),
      MODELS.groq,
    );
    expect(
      "gemini model visible in /api/v1/models",
      rows.some((r) => r && r.id === MODELS.gemini && r.provider === "gemini"),
      MODELS.gemini,
    );
    expect(
      "nvidia model visible in /api/v1/models",
      rows.some((r) => r && r.id === MODELS.nvidia && r.provider === "custom_1"),
      MODELS.nvidia,
    );
    expect(
      "ollama model visible in /api/v1/models",
      rows.some((r) => r && r.id === MODELS.ollama && r.provider === "ollama"),
      MODELS.ollama,
    );

    const v0 = await httpJson(port, "/api/v0/models", "GET", null, 10000);
    const rows0 = (v0.json && (v0.json.data || v0.json.models)) || [];
    const opencode0 = rows0.filter((r) => r && r.owned_by === "OpenCode");
    expect(
      "opencode absent from /api/v0/models",
      v0.status === 200 && opencode0.length === 0,
      "status=" + v0.status + " rows=" + rows0.length + " opencode=" + opencode0.length,
    );

    const blocked = await httpJson(
      port,
      "/v1/chat/completions",
      "POST",
      {
        model: OPENCODE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8,
      },
      15000,
    );
    const err = (blocked.json && blocked.json.error) || {};
    expect(
      "opencode model rejected with model_not_found",
      blocked.status === 400 && err.code === "model_not_found",
      "status=" + blocked.status + " code=" + (err.code || "") + " body=" + String(blocked.text || "").slice(0, 120),
    );
  } finally {
    await stopInstance(instance);
    try {
      fs.rmSync(TMP, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  }
}

async function main() {
  // The registry reads process.env at call time; give it the same values the
  // server sees, with the shell environment winning over .env.
  Object.assign(process.env, ENV);

  const apiPath = path.join(ROOT, "api.js");
  const syntax = spawnSync(process.execPath, ["--check", apiPath], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(
    "api.js syntax",
    syntax.status === 0,
    syntax.status === 0 ? "node --check ok" : String(syntax.stderr || "").slice(0, 200),
  );

  const source = fs.readFileSync(apiPath, "utf8");
  const duplicates = scanDuplicates(source);
  expect(
    "no duplicate top-level function names",
    duplicates.functions.length === 0 && duplicates.fnConsts.length === 0,
    "functions=" +
      duplicates.functionCount +
      " duplicate_functions=" +
      JSON.stringify(duplicates.functions) +
      " duplicate_fn_consts=" +
      JSON.stringify(duplicates.fnConsts),
  );
  expect(
    "no duplicate route + method handlers",
    duplicates.routes.length === 0,
    "routes=" + duplicates.routeCount + " duplicates=" + JSON.stringify(duplicates.routes),
  );

  const envFile = readEnvFile(path.join(ROOT, ".env"));
  expect(
    "opencode disabled in .env and api.js",
    envFile.OPENCODE_ENABLED === "false" &&
      /OPENCODE_ENABLED/.test(source) &&
      /PROVIDER_CONFIG\.opencode\.enabled\s*=\s*false/.test(source),
    "OPENCODE_ENABLED=" + (envFile.OPENCODE_ENABLED || "unset"),
  );

  const registry = require("../provider");
  const directOk = await directProviders(registry);
  expect(
    "all direct providers passed",
    directOk === 5,
    "passed=" + directOk + "/5",
  );

  await gatewayCheck();
  await opencodeDisabledCheck();

  console.log("");
  if (failed === 0) {
    console.log(
      "PROVIDER_SUITE_OK providers=nvidia,gemini,groq,ollama,llamacpp,gateway opencode=disabled duplicates=0 passed=" +
        passed,
    );
    process.exit(0);
  }
  console.log(
    "PROVIDER_SUITE_FAIL failed=" + failed + " passed=" + passed,
  );
  process.exit(1);
}

main().catch((e) => {
  console.log("FAIL unhandled — " + (e && e.stack ? e.stack : e));
  console.log("PROVIDER_SUITE_FAIL");
  process.exit(1);
});
