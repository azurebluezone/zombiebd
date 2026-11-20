#!/usr/bin/env node
"use strict";

/**
 * tests/bridge-discovery-check.js
 *
 * P0-05 release gate: the local bridge discovers only what the operator
 * configured.
 *
 *   1. lib/net.js is the one loopback definition: localhost, 127.0.0.1,
 *      ::1 and [::1], with no duplicate entries.
 *   2. lib/env.js consumes that definition instead of keeping a second copy.
 *   3. A loopback URL on the bridge/gateway port is a self-reference for
 *      every spelling, and a public host on the same port is not.
 *   4. Candidate upstreams come only from BRIDGE_UPSTREAMS, the configured
 *      BRIDGE_OLLAMA_URL and an explicit llama backend.
 *   5. Loopback aliases for the same port and path collapse to one upstream.
 *   6. The old DEFAULT_PROBE_PORTS scan is gone from source and config.
 *   7. A real bridge process with BRIDGE_PROBE_DEFAULTS=1, no explicit
 *      upstreams and backend=auto reports upstreams=[] even when a local
 *      Ollama is listening on 11434.
 *
 * Prints BRIDGE_DISCOVERY_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BRIDGE = path.join(ROOT, "local-llm-bridge.js");

const {
  LOOPBACK_HOSTS,
  isLoopbackHost,
  isSelfReference,
  upstreamKey,
} = require(path.join(ROOT, "lib", "net.js"));
const { buildCandidates } = require(path.join(ROOT, "lib", "bridge-upstreams.js"));

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

function run(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function stripComments(source) {
  const lines = String(source).split("\n");
  const out = [];
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    out.push(line.replace(/(^|[^:])\/\/.*$/, "$1"));
  }
  return out.join("\n");
}

function countInCode(relativePath, needle) {
  const file = path.join(ROOT, relativePath);
  if (!fs.existsSync(file)) return -1;
  const code = stripComments(fs.readFileSync(file, "utf8"));
  let count = 0;
  let index = 0;
  while ((index = code.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

// ─── 1. One loopback definition ──────────────────────────────────────
run("lib/net.js recognises every loopback spelling and rejects public hosts", () => {
  const hosts = [...LOOPBACK_HOSTS];
  assert.strictEqual(new Set(hosts).size, hosts.length, "LOOPBACK_HOSTS has duplicates");
  for (const host of ["localhost", "127.0.0.1", "::1", "[::1]"]) {
    assert.ok(hosts.includes(host), "LOOPBACK_HOSTS is missing " + host);
    assert.ok(isLoopbackHost(host), "isLoopbackHost rejected " + host);
  }
  assert.ok(isLoopbackHost("LOCALHOST"), "loopback match must be case-insensitive");
  assert.ok(isLoopbackHost("0:0:0:0:0:0:0:1"), "expanded IPv6 loopback must match");
  for (const host of ["10.0.0.1", "example.com", "127.0.0.1.evil.test", ""]) {
    assert.ok(!isLoopbackHost(host), "isLoopbackHost accepted public host " + JSON.stringify(host));
  }
});

run("lib/env.js consumes the shared definition instead of a second copy", () => {
  const env = require(path.join(ROOT, "lib", "env.js"));
  assert.strictEqual(env.LOOPBACK_HOSTS, LOOPBACK_HOSTS, "lib/env.js exports a different Set");
  assert.strictEqual(
    countInCode("lib/env.js", 'new Set(["localhost"'),
    0,
    "lib/env.js still defines its own localhost set",
  );
});

// ─── 2. Self-reference and dedupe ────────────────────────────────────
run("self-reference covers 127.0.0.1, localhost and [::1] on own ports", () => {
  const own = new Set([5050, 11435]);
  for (const url of [
    "http://127.0.0.1:5050/v1",
    "http://localhost:5050/v1",
    "http://[::1]:5050/v1",
    "http://127.0.0.1:11435/v1",
    "http://[::1]:11435/v1",
  ]) {
    assert.ok(isSelfReference(url, own), "missed self-reference " + url);
  }
  for (const url of [
    "http://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://10.0.0.1:5050/v1",
    "https://api.groq.com:443/v1",
  ]) {
    assert.ok(!isSelfReference(url, own), "false self-reference " + url);
  }
});

run("loopback aliases for the same port and path share one key", () => {
  const a = upstreamKey("http://localhost:11434/v1");
  const b = upstreamKey("http://127.0.0.1:11434/v1");
  const c = upstreamKey("http://[::1]:11434/v1");
  assert.strictEqual(a, b);
  assert.strictEqual(b, c);
  assert.notStrictEqual(a, upstreamKey("http://127.0.0.1:11434/v2"));
  assert.notStrictEqual(a, upstreamKey("http://127.0.0.1:11435/v1"));
});

// ─── 3. Explicit-only candidates ─────────────────────────────────────
run("candidates come only from explicit upstreams, configured URL and llama", () => {
  const built = buildCandidates({
    explicitUpstreams: [
      { name: "gateway", baseUrl: "http://127.0.0.1:5050/v1" },
      { name: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
    ],
    configuredUrl: "http://localhost:11434/v1",
    backend: "auto",
    internalPort: 11437,
    selfPorts: new Set([5050, 11435]),
  });
  assert.deepStrictEqual(
    built.candidates.map((u) => u.baseUrl),
    ["http://127.0.0.1:11434/v1"],
    "expected one deduped Ollama candidate",
  );
  assert.deepStrictEqual(
    built.selfReferences.map((u) => u.baseUrl),
    ["http://127.0.0.1:5050/v1"],
    "gateway self-reference was not reported",
  );

  const llama = buildCandidates({
    explicitUpstreams: [],
    configuredUrl: "",
    backend: "llama",
    internalPort: 11437,
    selfPorts: new Set([11435]),
  });
  assert.deepStrictEqual(
    llama.candidates.map((u) => u.baseUrl),
    ["http://localhost:11437"],
    "llama backend must add its own internal port",
  );

  const empty = buildCandidates({
    explicitUpstreams: [],
    configuredUrl: "",
    backend: "auto",
    internalPort: 11437,
    selfPorts: new Set([11435]),
  });
  assert.deepStrictEqual(empty.candidates, [], "no configuration must mean no candidates");
  assert.deepStrictEqual(empty.selfReferences, []);
});

// ─── 4. The hidden scan is gone from source and config ───────────────
run("source and .env.example contain no hidden probe list", () => {
  assert.strictEqual(
    countInCode("local-llm-bridge.js", "DEFAULT_PROBE_PORTS"),
    0,
    "DEFAULT_PROBE_PORTS is still in local-llm-bridge.js",
  );
  assert.strictEqual(
    countInCode("local-llm-bridge.js", "BRIDGE_PROBE_DEFAULTS"),
    0,
    "BRIDGE_PROBE_DEFAULTS scan is still in local-llm-bridge.js",
  );
  assert.strictEqual(
    countInCode(".env.example", "BRIDGE_PROBE_DEFAULTS"),
    0,
    ".env.example still advertises BRIDGE_PROBE_DEFAULTS",
  );
  assert.strictEqual(
    countInCode("lib/bridge-upstreams.js", "9932"),
    0,
    "lib/bridge-upstreams.js still lists a conventional probe port",
  );
});

// ─── 5. Real bridge: the flag cannot resurrect the scan ──────────────
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname, timeout: 800 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (error) {
            reject(new Error("invalid JSON from " + pathname + ": " + error.message));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await getJson(port, "/health");
      if (res.status === 200 && res.json) return res.json;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    "bridge health did not answer in " + timeoutMs + "ms" +
      (lastError ? " (" + lastError.message + ")" : ""),
  );
}

async function runtimeNoScan() {
  const port = await freePort();
  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      BRIDGE_PORT: String(port),
      BRIDGE_BACKEND: "auto",
      BRIDGE_UPSTREAMS: "",
      BRIDGE_OLLAMA_URL: "",
      // Deliberately re-enable the old flag: it must not bring the scan back.
      BRIDGE_PROBE_DEFAULTS: "1",
      BRIDGE_PROBE_TIMEOUT_MS: "200",
      BRIDGE_REFRESH_MS: "3000",
      BRIDGE_MODEL: "",
      BRIDGE_UPSTREAM_MODEL: "",
      BRIDGE_SOCKET: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  if (child.stdout) child.stdout.on("data", (chunk) => (log += chunk.toString()));
  if (child.stderr) child.stderr.on("data", (chunk) => (log += chunk.toString()));

  try {
    const health = await waitHealth(port, 10000);
    assert.strictEqual(health.status, "no-upstream", "bridge status was " + health.status);
    assert.deepStrictEqual(health.upstreams, [], "hidden scan still found an upstream");
    assert.deepStrictEqual(health.self_references, [], "unexpected self-reference");

    const models = await getJson(port, "/v1/models");
    assert.strictEqual(models.status, 200);
    assert.deepStrictEqual(models.json.data, [], "bridge invented a model");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill("SIGKILL");
    if (failed > 0 && log) {
      console.log("--- bridge output ---\n" + log.slice(-2000));
    }
  }
}

(async () => {
  try {
    await runtimeNoScan();
    pass("a real bridge with BRIDGE_PROBE_DEFAULTS=1 discovers nothing without config");
  } catch (error) {
    fail(
      "a real bridge with BRIDGE_PROBE_DEFAULTS=1 discovers nothing without config",
      error && error.message ? error.message : String(error),
    );
  }

  console.log("\npassed=" + passed + " failed=" + failed);
  if (failed > 0) {
    console.error("BRIDGE_DISCOVERY_FAILED");
    process.exit(1);
  }
  console.log("BRIDGE_DISCOVERY_OK");
})();
