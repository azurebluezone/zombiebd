#!/usr/bin/env node
"use strict";

/*
 * zero-width-guard — one command that proves no hidden "dendi" is in the
 * project's code or text artifacts.
 *
 * It scans the source tree, the env files and tmp/ narration, then exits
 * non-zero on the first hidden character. The plugin-owned append-only
 * ledger (.zombiecoder/) is excluded by default because its Goal Contract
 * blocks record the user's raw input verbatim; use --include-ledger to see
 * those hits explicitly.
 *
 * Run: node scripts/zero-width-guard.js
 *      node scripts/zero-width-guard.js --include-ledger
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INCLUDE_LEDGER = process.argv.includes("--include-ledger");

const SCAN_ROOTS = [
  "api.js",
  "start.js",
  "domain-config.js",
  "local-llm-bridge.js",
  "mcp-client.js",
  "external-mcp.js",
  "integrations.js",
  "cdp-pipe.js",
  "package.json",
  ".env",
  ".env.example",
  "lib",
  "modules",
  "deploy",
  "tests",
  "scripts",
  "public",
  "transport",
  "provider",
  "agent",
  "tmp",
  ".zombie",
  ".zombiecoder",
];

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "docs",
  "data",
  "logs",
  "cache",
  "locks",
  ".missionbarisal",
]);

if (!INCLUDE_LEDGER) SKIP_DIRS.add(".zombiecoder");

const TEXT_EXT = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".json",
  ".md",
  ".sh",
  ".html",
  ".css",
  ".txt",
  ".yml",
  ".yaml",
  ".template",
  ".example",
]);

const INVISIBLE =
  /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFFD]/g;

let files = 0;
const hits = [];

function codepoint(ch) {
  return "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
}

function scanFile(absolute) {
  const name = path.basename(absolute);
  const ext = path.extname(absolute).toLowerCase();
  if (!TEXT_EXT.has(ext) && name !== ".env" && name !== ".env.example" && name !== "package.json") {
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (_) {
    return;
  }
  files++;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const matches = line.match(INVISIBLE);
    if (!matches) continue;
    hits.push({
      file: path.relative(ROOT, absolute).split(path.sep).join("/"),
      line: index + 1,
      chars: [...new Set(matches.map(codepoint))],
    });
    if (hits.length >= 50) return;
  }
}

function walk(absolute) {
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch (_) {
    return;
  }
  if (stat.isFile()) {
    scanFile(absolute);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries = [];
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    walk(path.join(absolute, entry.name));
    if (hits.length >= 50) return;
  }
}

for (const root of SCAN_ROOTS) {
  if (!INCLUDE_LEDGER && root === ".zombiecoder") continue;
  walk(path.join(ROOT, root));
}

if (hits.length > 0) {
  console.log("ZERO_WIDTH_GUARD_FAIL hits=" + hits.length + " files=" + files);
  for (const hit of hits) {
    console.log("  " + hit.file + ":" + hit.line + " " + hit.chars.join(","));
  }
  if (!INCLUDE_LEDGER) {
    console.log("  note: .zombiecoder/ is plugin-owned; run --include-ledger to inspect it.");
  }
  process.exitCode = 1;
} else {
  console.log(
    "ZERO_WIDTH_GUARD_OK files=" +
      files +
      (INCLUDE_LEDGER ? " ledger=included" : " ledger=excluded"),
  );
}
