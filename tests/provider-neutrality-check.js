#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: provider neutrality and local-special-case removal
//
// Proves the approved cleanup in one place:
//   1. provider/opencode.js sends no fake CLI identity headers.
//   2. No bridge-only tool cap remains; the generic provider ceiling stays.
//   3. No Ollama CPU prompt/reasoning knobs remain in code or env files.
//   4. A spawned gateway writes its runtime config inside APP_ROOT.
//   5. The facebook-ads example is disabled when it is not configured.
//
// Run: node tests/provider-neutrality-check.js
// Exit 0 + PROVIDER_NEUTRAL_OK only when every check passes.
// =============================================================================

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " :: " + detail : ""));
    return;
  }
  fail += 1;
  failures.push(name + (detail ? " :: " + detail : ""));
  console.log("FAIL " + name + (detail ? " :: " + detail : ""));
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function includesAny(source, needles) {
  return needles.filter((needle) => source.includes(needle));
}

function runCheck(label, script, marker, timeoutMs) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs || 300000,
  });
  const output = String(result.stdout || "") + String(result.stderr || "");
  check(
    label,
    result.status === 0 && output.includes(marker),
    "exit=" + result.status + " marker=" + marker + " tail=" + output.slice(-300),
  );
}

const opencode = read("provider/opencode.js");
const identity = includesAny(opencode, [
  "x-opencode-client",
  "x-opencode-session",
  "x-opencode-project",
  "x-opencode-request",
  "opencode/latest",
  'User-Agent',
  "uuid(",
]);
check("provider/opencode.js has no fake CLI identity", identity.length === 0, identity.join(","));
check("provider/opencode.js keeps the OpenAI adapter path", opencode.includes('require("./openai")'));

const budget = read("lib/tool-budget.js");
const bridgeBudget = includesAny(budget, [
  "bridgeMaxTools",
  "PROVIDER_BRIDGE_MAX_TOOLS",
  "BRIDGE_MAX_TOOLS",
]);
check("lib/tool-budget.js has no bridge-only cap", bridgeBudget.length === 0, bridgeBudget.join(","));
check("lib/tool-budget.js keeps the generic provider ceiling", budget.includes("providerMaxOf"));

const api = read("api.js");
const bridgeWiring = includesAny(api, [
  "bridgeMaxTools",
  "PROVIDER_BRIDGE_MAX_TOOLS",
  "BRIDGE_MAX_TOOLS",
  "capabilities: { maxTools",
]);
check("api.js has no bridge-only cap wiring", bridgeWiring.length === 0, bridgeWiring.join(","));

const ollamaSpecial = includesAny(api, [
  "OLLAMA_MAX_PROMPT_CHARS",
  "OLLAMA_MAX_TOKENS",
  "OLLAMA_EXTRA_BODY",
]);
check("api.js has no Ollama CPU prompt/reasoning knobs", ollamaSpecial.length === 0, ollamaSpecial.join(","));
check("api.js keeps the generic maxPromptChars mechanism", api.includes("maxPromptChars"));

for (const envFile of [".env.example", ".env"]) {
  if (!fs.existsSync(path.join(ROOT, envFile))) continue;
  const env = read(envFile);
  const leftovers = includesAny(env, [
    "OLLAMA_MAX_PROMPT_CHARS",
    "OLLAMA_MAX_TOKENS",
    "OLLAMA_EXTRA_BODY",
    "PROVIDER_BRIDGE_MAX_TOOLS",
    "BRIDGE_MAX_TOOLS",
  ]);
  check(envFile + " has no removed knobs", leftovers.length === 0, leftovers.join(","));
}

const example = JSON.parse(read("external mcp/servers.example.json"));
const facebookAds = (example.servers || []).find((server) => server.name === "facebook-ads");
check(
  "facebook-ads example stays disabled until configured",
  !!facebookAds && facebookAds.enabled === false,
  facebookAds ? "enabled=" + facebookAds.enabled : "missing",
);

const envLock = read("tests/provider-env-lock-check.js");
check("provider-env-lock sets APP_ROOT", envLock.includes("APP_ROOT: TMP"));

const budgetTest = read("tests/tool-budget-check.js");
check("tool-budget test no longer asserts bridgeMaxTools", !budgetTest.includes("bridgeMaxTools"));

if (fail === 0) {
  runCheck("real tool-budget gate", "tests/tool-budget-check.js", "TOOL_BUDGET_OK");
  runCheck(
    "real provider env-lock gate",
    "tests/provider-env-lock-check.js",
    "PROVIDER_ENV_LOCK_OK",
  );
}

console.log("");
console.log("checks=" + (pass + fail) + " pass=" + pass + " fail=" + fail);
if (fail === 0) {
  console.log("PROVIDER_NEUTRAL_OK");
} else {
  console.error("PROVIDER_NEUTRAL_FAIL");
  for (const item of failures) console.error(" - " + item);
  process.exit(1);
}
