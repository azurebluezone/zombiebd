"use strict";

/**
 * lib/expand-env.js - expand ${VAR} placeholders in config strings.
 *
 * Why: "external mcp/servers.json" used to hardcode every port, so editing
 * .env changed nothing — the spawn path even pinned the stale JSON value
 * back into the child's env, silently overriding the user's choice.
 *
 * Unknown variables expand to "" on purpose: a missing reference must fail
 * loudly at URL parse, never silently reuse an old port.
 */

const path = require("path");
const { readEnvFile } = require("./env");

const ROOT = path.resolve(__dirname, "..");
let envLoaded = false;

// Callers parse servers.json at module load, often before their own .env
// loader runs (api.js) or without one at all (healthcheck standalone).
// Fill only falsy keys — shell/parent env always wins, same rule as the
// loader in api.js.
function ensureEnv() {
  if (envLoaded) return;
  envLoaded = true;
  const fileVars = readEnvFile(path.join(ROOT, ".env"));
  for (const [key, value] of Object.entries(fileVars)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function expandEnv(str) {
  ensureEnv();
  return String(str).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
    process.env[name] || "",
  );
}

module.exports = { expandEnv, ensureEnv };
