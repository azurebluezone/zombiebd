#!/usr/bin/env node
"use strict";

/**
 * scripts/build.js - build a self-contained dist/ from the source tree.
 * Uses only Node 24 built-ins. Copies code, links runtime state, renders the
 * env-derived Caddyfile, writes manifest.json + VERSION.
 *
 * Code is copied (a build is reproducible); operator state is linked
 * (data/, logs/, cache/, locks/, .zombiecoder/, .missionbarisal/ and .env)
 * so rebuilding dist never erases the live database or logs.
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
    // Match a real node runtime, not a shell command that merely mentions
    // dist/api.js (the build command itself used to trip this guard).
    const runtimeRe = new RegExp(
      "(?:^|\\s)\\S*node\\s+\\S*" +
        DIST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "/(?:start|api)\\.js(?:\\s|$)",
    );
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => runtimeRe.test(line))
      .map((line) => parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid)
      .filter((pid) => {
        // A defunct (zombie) process keeps its old argv in ps but cannot be
        // the live runtime. Ignoring it prevents an unreaped child from
        // blocking every rebuild.
        try {
          const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
          return stat.split(" ")[2] !== "Z";
        } catch (_) {
          return false;
        }
      });
  } catch (_) {
    return [];
  }
}

// A runtime launched by the repo-root start.js has argv `start.js`, not
// `dist/start.js`, so the ps scan above cannot see it. start.js writes this
// marker before it requires dist/api.js; the marker is removed on exit.
function liveRuntimeFromMarker() {
  if (process.platform === "win32") return [];
  try {
    const markerPath = path.join(DIST, ".runtime.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (path.resolve(String(marker.dist || "")) !== DIST) return [];
    const pid = Number(marker.pid);
    if (!Number.isFinite(pid) || pid <= 0) return [];
    try { process.kill(pid, 0); } catch (_) { return []; }
    try {
      const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
      if (stat.split(" ")[2] === "Z") return [];
      const cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ");
      if (!/start\.js|api\.js/.test(cmd)) return [];
    } catch (_) {
      return [];
    }
    return [pid];
  } catch (_) {
    return [];
  }
}

const live = Array.from(new Set([...liveRuntimePids(), ...liveRuntimeFromMarker()]));
if (live.length) {
  console.error(
    "BUILD_REFUSED dist is the live runtime (pid=" + live.join(",") +
    "). Run: node start.js --rebuild (stop -> build -> verify -> start), " +
    "or stop the gateway and run --build-only again.",
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
  "modules",
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

// start.js is the launcher and stays at the repo root. It is deliberately not
// copied: a built tree must be started by that launcher, which rebuilds dist
// every run, so a stale dist can never become a second entry point.
const COPY_FILES = [
  "api.js",
  "cdp-pipe.js",
  "domain-config.js",
  "external-mcp.js",
  "integrations.js",
  "mcp-client.js",
  "mcp-stdio-client.js",
  "note-store.js",
  "local-llm-bridge.js",
  "identity.json",
  "PERSONAS.md",
  "README.md",
];

// Operator state, not build output. One copy lives in the checkout and dist
// links to it, so a rebuild is disposable while models.db and logs survive.
const RUNTIME_LINKS = [
  "data",
  "logs",
  "cache",
  "locks",
  ".zombiecoder",
  ".missionbarisal",
];

function linkRuntimeState() {
  for (const name of RUNTIME_LINKS) {
    const src = path.join(ROOT, name);
    const dest = path.join(DIST, name);
    try { fs.mkdirSync(src, { recursive: true }); } catch (_) { }
    try {
      fs.symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      console.warn("BUILD_WARN runtime link failed name=" + name + " error=" + e.message);
      try {
        fs.cpSync(src, dest, { recursive: true });
      } catch (e2) {
        console.warn("BUILD_WARN runtime copy failed name=" + name + " error=" + e2.message);
      }
    }
  }
}

function linkEnvFile() {
  const src = path.join(ROOT, ".env");
  const dest = path.join(DIST, ".env");
  if (!fs.existsSync(src)) return;
  try {
    fs.symlinkSync(src, dest, "file");
  } catch (e) {
    console.warn("BUILD_WARN .env link failed error=" + e.message);
    try { fs.copyFileSync(src, dest); } catch (e2) {
      console.warn("BUILD_WARN .env copy failed error=" + e2.message);
    }
  }
}

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

  // Operator state stays in the checkout and is linked into dist/. The env
  // file is linked too, so editing .env never needs a rebuild.
  linkRuntimeState();
  linkEnvFile();
  const envExample = path.join(ROOT, ".env.example");
  if (fs.existsSync(envExample)) {
    copyFile(envExample, path.join(DIST, ".env.example"));
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
