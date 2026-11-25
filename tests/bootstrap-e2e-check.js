#!/usr/bin/env node
"use strict";

/*
 * Bootstrap acceptance — the installed stack after a fresh build.
 *
 * Contract: gc-mwiafkk3 — prints BOOTSTRAP_E2E_OK only when every check
 * passes. No mocks: the systemd unit, the live gateway, the real SQLite
 * database and the persisted Caddyfile are inspected directly.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { loadEnv, readEnvFile } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const RAW_ENV = Object.assign({}, readEnvFile(path.join(ROOT, ".env")), process.env);
const API_PORT = ENV.ports.api || 5050;
const API_HOST = "127.0.0.1";
const DB_PATH = path.join(ROOT, "data", "models.db");
const DIST = path.join(ROOT, "dist");
const CADDY_DIST = path.join(DIST, "deploy", "Caddyfile");
const CADDY_LIVE = "/etc/caddy/Caddyfile";

function die(message) {
  console.error("FAIL " + message);
  process.exit(1);
}

function ok(message) {
  console.log("OK   " + message);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function getJson(pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: API_HOST,
        port: API_PORT,
        path: pathname,
        method: "GET",
        headers: Object.assign({ accept: "application/json" }, headers || {}),
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body = null;
          try {
            body = JSON.parse(text);
          } catch (_) {
            body = null;
          }
          resolve({ status: res.statusCode, body, text, headers: res.headers });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, body: null, text: error.message }));
    req.end();
  });
}

async function main() {
  // start.js is the repo-root launcher and is deliberately not copied into
  // dist (scripts/build.js); the launcher execs dist/api.js.
  if (!fs.existsSync(path.join(ROOT, "start.js"))) die("missing artifact: start.js");
  for (const rel of [
    "dist/api.js",
    "dist/VERSION",
    "dist/manifest.json",
    "dist/deploy/Caddyfile",
    "data/models.db",
  ]) {
    if (!fs.existsSync(path.join(ROOT, rel))) die("missing artifact: " + rel);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.length < 100) {
    die("dist/manifest.json is not a real build manifest");
  }
  ok("dist artifacts present: files=" + manifest.files.length + " version=" + manifest.version);

  if (!fs.existsSync(CADDY_LIVE)) die("missing " + CADDY_LIVE);
  const distHash = sha256(CADDY_DIST);
  const liveHash = sha256(CADDY_LIVE);
  if (distHash !== liveHash) {
    die("Caddyfile drift: dist=" + distHash + " live=" + liveHash);
  }
  const caddyText = fs.readFileSync(CADDY_DIST, "utf8");
  if (!caddyText.includes("reverse_proxy 127.0.0.1:")) die("rendered Caddyfile has no 127.0.0.1 upstream");
  if (caddyText.includes("reverse_proxy localhost:")) die("rendered Caddyfile still uses localhost upstream");
  ok("Caddyfile sha256=" + distHash.slice(0, 16) + " matches /etc/caddy");

  let active = "";
  try {
    active = execFileSync("systemctl", ["--user", "is-active", "zombiecoder-gateway.service"], {
      encoding: "utf8",
    }).trim();
  } catch (_) {
    active = "inactive";
  }
  if (active !== "active") die("zombiecoder-gateway.service is " + active);
  const shown = execFileSync(
    "systemctl",
    ["--user", "show", "zombiecoder-gateway.service", "-p", "MainPID"],
    { encoding: "utf8" },
  );
  const mainPid = Number((shown.match(/MainPID=(\d+)/) || [])[1] || 0);
  if (!mainPid) die("gateway unit has no MainPID");
  const cmdline = fs.readFileSync("/proc/" + mainPid + "/cmdline", "utf8").replace(/\0/g, " ").trim();
  if (!/(^|\/)start\.js\b/.test(cmdline)) die("MainPID " + mainPid + " is not start.js: " + cmdline);
  ok("gateway active MainPID=" + mainPid + " (" + cmdline + ")");

  const health = await getJson("/health");
  if (health.status !== 200 || !health.body || health.body.healthy !== true) {
    die("GET /health failed: " + health.status + " " + health.text.slice(0, 200));
  }
  if (!(health.body.agents > 0) || !(health.body.models > 0)) {
    die("health reports agents=" + health.body.agents + " models=" + health.body.models);
  }
  ok("health healthy agents=" + health.body.agents + " models=" + health.body.models);

  const token = RAW_ENV.ADMIN_TOKEN || RAW_ENV.ADMIN_API_KEY || "";
  if (!token) die("ADMIN_TOKEN is not set; cannot read the live provider catalog");
  const panel = await getJson("/admin/zombie", { "x-admin-token": token });
  const panelCookie = [].concat(panel.headers && panel.headers["set-cookie"] || [])
    .map((line) => String(line).split(";")[0])
    .join("; ");
  if (!panelCookie) die("GET /admin/zombie did not mint a panel session cookie (status " + panel.status + ")");
  const admin = await getJson("/api/admin/providers", { "x-admin-token": token, cookie: panelCookie });
  if (admin.status !== 200 || !admin.body || !Array.isArray(admin.body.providers)) {
    die("GET /api/admin/providers failed: " + admin.status + " " + admin.text.slice(0, 200));
  }
  const liveProviders = admin.body.providers;
  if (liveProviders.length < 5) die("live provider catalog is too small: " + liveProviders.length);

  const db = new DatabaseSync(DB_PATH);
  const rows = db
    .prepare("SELECT id, source, enabled, models, base_url FROM providers ORDER BY priority ASC, id ASC")
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = liveProviders.map((provider) => provider.id).filter((id) => !byId.has(id));
  if (missing.length) die("providers missing from data/models.db: " + missing.join(", "));

  for (const provider of liveProviders) {
    const row = byId.get(provider.id);
    if (row.source !== "env" && row.source !== "db") {
      die("provider " + provider.id + " has invalid source=" + row.source);
    }
    const wantEnabled = provider.enabled ? 1 : 0;
    if (Number(row.enabled) !== wantEnabled) {
      die("provider " + provider.id + " enabled drift: db=" + row.enabled + " live=" + wantEnabled);
    }
  }

  const stale = rows.filter(
    (row) => row.source === "env" && !liveProviders.some((provider) => provider.id === row.id),
  );
  if (stale.length) die("stale env provider rows: " + stale.map((row) => row.id).join(", "));

  const modelCount = db.prepare("SELECT count(*) AS c FROM models").get().c;
  if (!(modelCount > 0)) die("models table is empty");

  ok("providers persisted: " + rows.map((row) => row.id + "(" + row.source + ")").join(", "));
  ok("models persisted: " + modelCount);
  console.log("BOOTSTRAP_E2E_OK");
}

main().catch((error) => die(error && error.stack ? error.stack : String(error)));
