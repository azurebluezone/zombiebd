#!/usr/bin/env node
"use strict";

// Full-stack acceptance: a local model is actually loaded, the provider suite,
// the live gateway and the proxy/upstream rule all pass together.
//
// Contract: gc-mwh9z0wk — prints FULL_STACK_OK only when every check passes.
// The upstream rule: Ollama Cloud may be an upstream; the project's own local
// gateway (agent ids) must never appear as a bridge upstream.

const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_MODEL = "lfm3:1.7b";
const AGENT_IDS = [
  "mission",
  "code-guru",
  "bug-hunter",
  "security-hero",
  "perf-wizard",
  "doc-king",
  "qa-tyrant",
  "team-heart",
  "customer-experience-specialist",
  "ecommerce-operations-analyst",
];

function die(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function getJson(port, target, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "localhost", port, path: target, method: "GET", headers: { host: `localhost:${port}` }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, body: null, error: String(error.message || error) }));
    req.end();
  });
}

function runSuite(label, script, marker) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, "tests", script)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 90000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const elapsed = Date.now() - started;
  if (result.status !== 0) {
    die(`${label} exited ${result.status} in ${elapsed}ms: ${output.slice(-500)}`);
  }
  if (!output.includes(marker)) {
    die(`${label} did not print ${marker}: ${output.slice(-300)}`);
  }
  console.log(`OK   ${label} exit 0 in ${elapsed}ms (${marker})`);
  return output;
}

async function main() {
  // 1. A real model must be loaded before the suites run.
  const ps = await getJson(11434, "/api/ps");
  if (ps.status !== 200 || !ps.body || !Array.isArray(ps.body.models)) {
    die(`ollama /api/ps unavailable (HTTP ${ps.status}${ps.error ? `, ${ps.error}` : ""})`);
  }
  const loaded = ps.body.models.map((model) => String(model.name || model.model || ""));
  if (!loaded.includes(LOCAL_MODEL)) {
    die(`${LOCAL_MODEL} is not loaded (loaded: ${loaded.join(", ") || "none"})`);
  }
  console.log(`OK   ollama loaded: ${loaded.join(", ")}`);

  // 2. Upstream rule: the local gateway is never a bridge upstream.
  const bridge = await getJson(11435, "/v1/models");
  if (bridge.status !== 200 || !bridge.body || !Array.isArray(bridge.body.data)) {
    die(`bridge /v1/models unavailable (HTTP ${bridge.status})`);
  }
  const ids = bridge.body.data.map((model) => String(model.id));
  const leaked = ids.filter((id) => AGENT_IDS.includes(id));
  if (leaked.length > 0) die(`bridge discovered the local gateway agent ids: ${leaked.join(", ")}`);
  if (!ids.includes(LOCAL_MODEL)) die(`bridge is missing the loaded local model ${LOCAL_MODEL}`);
  console.log(`OK   bridge upstreams: ${ids.join(", ")} (no local gateway agent ids)`);

  // 3. Provider acceptance suite.
  const suite = runSuite("provider-suite", "provider-suite-check.js", "PROVIDER_SUITE_OK");
  const okLine = suite.split("\n").find((line) => line.includes("PROVIDER_SUITE_OK")) || "";
  const passed = (okLine.match(/passed=(\d+)/) || [])[1];
  if (passed !== "19") die(`provider suite passed=${passed}, expected 19`);

  // 4. Live gateway acceptance.
  runSuite("provider-live", "provider-live-check.js", "PROVIDER_LIVE_OK");

  // 5. Proxy + edge upstream acceptance.
  runSuite("proxy-upstream", "proxy-upstream-check.js", "PROXY_UPSTREAM_OK");

  console.log("FULL_STACK_OK");
}

main().catch((error) => die(String(error?.stack || error)));
