#!/usr/bin/env node
"use strict";

/**
 * env-ensure.js - make an existing .env complete without changing values that
 * are already set. Missing keys are copied from .env.example; generated secrets
 * are written only with --fresh (a .env this installer just created).
 *
 *   node scripts/env-ensure.js
 *   node scripts/env-ensure.js --fresh
 *   node scripts/env-ensure.js --ollama-model llama3.2:latest
 *
 * Only key names are printed. Values, especially keys and tokens, never are.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");
const FRESH = process.argv.includes("--fresh");
const ollamaIndex = process.argv.indexOf("--ollama-model");
const OLLAMA_MODEL = ollamaIndex !== -1 ? String(process.argv[ollamaIndex + 1] || "").trim() : "";

if (!fs.existsSync(EXAMPLE)) {
  console.error("ENV_ENSURE_FAIL .env.example missing");
  process.exit(1);
}
if (!fs.existsSync(ENV_FILE)) {
  console.error("ENV_ENSURE_FAIL .env missing (copy .env.example first)");
  process.exit(1);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function parse(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    map.set(match[1], match[2]);
  }
  return map;
}

function unquote(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function setKey(text, key, value) {
  const line = key + "=" + value;
  const re = new RegExp("^\\s*" + key + "\\s*=.*$", "m");
  if (re.test(text)) return text.replace(re, line);
  const base = text === "" || text.endsWith("\n") ? text : text + "\n";
  return base + line + "\n";
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

let text = read(ENV_FILE);
const current = parse(text);
const example = parse(read(EXAMPLE));
const added = [];
const generated = [];

for (const [key, value] of example) {
  if (!current.has(key)) {
    text = setKey(text, key, value);
    added.push(key);
  }
}

const resolved = parse(text);

function resolvedValue(key) {
  return unquote(resolved.get(key) || "");
}

if (FRESH) {
  for (const key of ["ADMIN_TOKEN", "ADMIN_API_KEY", "MCP_ADMIN_TOKEN"]) {
    if (resolved.has(key) && resolvedValue(key) === "") {
      text = setKey(text, key, crypto.randomBytes(24).toString("hex"));
      generated.push(key);
    }
  }
}

const mainHost = resolvedValue("MAIN_HOST") || (() => {
  try { return new URL(resolvedValue("APP_URL")).hostname; } catch { return "localhost"; }
})();
const port = resolvedValue("PORT") || "5050";
const origins = new Set([
  "http://127.0.0.1:" + port,
  "http://localhost:" + port,
  "https://" + mainHost,
]);
if (mainHost !== "localhost" && mainHost !== "127.0.0.1") {
  origins.add("http://" + mainHost + ":" + port);
}

for (const key of ["ALLOWED_ORIGINS", "CORS_ORIGINS"]) {
  const existing = splitList(resolved.get(key) || "");
  if (existing.includes("*")) continue;
  const merged = Array.from(new Set(existing.concat(Array.from(origins))));
  if (merged.join(",") !== existing.join(",")) {
    text = setKey(text, key, merged.join(","));
  }
}

if (OLLAMA_MODEL) {
  const canonical = resolvedValue("BRIDGE_UPSTREAM_MODEL") || OLLAMA_MODEL;
  const existing = splitList(resolved.get("MODEL_ALIASES") || "");
  const hasLlamaLocal = existing.some((entry) => entry.split(":")[0] === "llama-local");
  if (FRESH || !hasLlamaLocal) {
    const rest = existing.filter((entry) => entry.split(":")[0] !== "llama-local");
    rest.push("llama-local:" + canonical);
    text = setEnvKey(text, "MODEL_ALIASES", rest.filter(Boolean).join(","));
  }
}

const before = read(ENV_FILE);
if (text !== before) {
  const mode = fs.statSync(ENV_FILE).mode;
  fs.writeFileSync(ENV_FILE, text, { mode });
}
fs.chmodSync(ENV_FILE, 0o600);

console.log("ENV_ENSURE_OK keys_added=" + (added.length ? added.join(",") : "none"));
if (generated.length) {
  console.log("ENV_SECRETS_WRITTEN keys=" + generated.join(",") + " (values not printed)");
}
if (OLLAMA_MODEL) console.log("ENV_OLLAMA_ALIAS llama-local -> " + OLLAMA_MODEL);
