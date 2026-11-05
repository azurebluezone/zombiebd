#!/usr/bin/env node
"use strict";

/**
 * scripts/build.js - build a self-contained dist/ from the source tree.
 * Uses only Node 24 built-ins. Copies files, renders env-derived Caddyfile,
 * writes manifest.json + VERSION, never symlinks source files.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST = process.env.BUILD_OUT
  ? path.resolve(process.env.BUILD_OUT)
  : path.join(ROOT, "dist");

// Replacing dist/ under a running gateway deletes the live runtime: the
// process keeps its loaded modules but recreates dist/logs, public assets and
// lazy requires point at files that no longer exist. Refuse instead of
// producing a half-dead deployment.
function liveRuntimePids() {
  if (process.platform === "win32") return [];
  try {
    const out = execSync("ps -eo pid=,args=", { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes(DIST) && /(start|api)\.js/.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  } catch (_) {
    return [];
  }
}

const live = liveRuntimePids();
if (live.length) {
  console.error(
    "BUILD_REFUSED dist is the live runtime (pid=" + live.join(",") +
    "). Stop the gateway, rebuild, then start it again.",
  );
  process.exit(1);
}

const VERSION = fs.existsSync(path.join(ROOT, "package.json"))
  ? (() => {
      try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version || "3.2.1"; } catch { return "3.2.1"; }
    })()
  : "3.2.1";

const COPY_DIRS = [
  "agent",
  "lib",
  "provider",
  "tools",
  "normalizer",
  "transport",
  "external mcp",
  "external tools",
  "universal-adapter",
  "public",
  "skills",
  "deploy",
  "scripts",
  "tests",
];

const COPY_FILES = [
  "api.js",
  "start.js",
  "start-local-mcp.js",
  "cdp-pipe.js",
  "domain-config.js",
  "external-mcp.js",
  "integrations.js",
  "mcp-client.js",
  "mcp-stdio-client.js",
  "note-store.js",
  "local-llm-bridge.js",
  "README.md",
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isSymbolicLink()) {
      const link = fs.readlinkSync(s);
      ensureDir(path.dirname(d));
      try { fs.symlinkSync(link, d); } catch { fs.copyFileSync(fs.realpathSync(s), d); }
    } else {
      copyFile(s, d);
    }
  }
}

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function main() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true, force: true });
  }
  ensureDir(DIST);

  for (const dir of COPY_DIRS) {
    const src = path.join(ROOT, dir);
    if (fs.existsSync(src)) copyDir(src, path.join(DIST, dir));
  }
  for (const file of COPY_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) copyFile(src, path.join(DIST, file));
  }

  // Copy .env.example as template; if a real .env exists, copy it so the
  // dist can boot without re-initialization in this environment.
  if (fs.existsSync(path.join(ROOT, ".env"))) {
    copyFile(path.join(ROOT, ".env"), path.join(DIST, ".env"));
  } else if (fs.existsSync(path.join(ROOT, ".env.example"))) {
    copyFile(path.join(ROOT, ".env.example"), path.join(DIST, ".env.example"));
  }

  // Render env-driven Caddyfile
  const caddyOut = path.join(DIST, "deploy", "Caddyfile");
  const res = spawnSync(process.execPath, [path.join(ROOT, "scripts", "caddy-render.js"), "--out", caddyOut], {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error("BUILD_FAIL caddy-render");
    process.exit(res.status || 1);
  }

  // Write VERSION and manifest
  fs.writeFileSync(path.join(DIST, "VERSION"), VERSION + "\n", "utf8");

  const files = [];
  function walk(dir, rel) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) {
        walk(full, r);
      } else if (e.isFile()) {
        files.push({ path: r, sha256: sha256File(full), bytes: fs.statSync(full).size });
      }
    }
  }
  walk(DIST, "");
  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    version: VERSION,
    builtAt: new Date().toISOString(),
    root: "dist",
    files,
  };
  fs.writeFileSync(path.join(DIST, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("BUILD_OK dist=" + DIST + " files=" + files.length + " version=" + VERSION);
}

main();
