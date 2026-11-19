#!/usr/bin/env node
"use strict";

// Edge proxy + local bridge upstream acceptance check.
// Real HTTP/TLS and real systemd only: no mocks.
//
// Contract: gc-mwh9ps83 — prints PROXY_UPSTREAM_OK only when the live
// proxy, the rendered Caddyfile, the bridge catalog and the gateway
// ownership all match the recorded pass criteria.

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CADDYFILE = path.join(ROOT, "dist", "deploy", "Caddyfile");
const EXPECTED_HOSTS = [
  "adapter.localhost",
  "ads.localhost",
  "combined.localhost",
  "localhost",
  "ocr.localhost",
  "public.localhost",
  "screen.localhost",
  "tts.localhost",
].sort();
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

function request(options) {
  const { protocol = "http", host = "localhost", port, servername, path: target = "/", method = "GET", headers = {}, body, timeoutMs = 15000 } = options;
  return new Promise((resolve) => {
    const mod = protocol === "https" ? https : http;
    const req = mod.request(
      {
        host,
        port,
        path: target,
        method,
        servername,
        rejectUnauthorized: false,
        headers: { host: servername || host, ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, body: "", error: String(error.message || error) }));
    if (body) req.write(body);
    req.end();
  });
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  // 1. :80 redirects to :443 for the main host.
  const redirect = await request({ port: 80, servername: "localhost", path: "/" });
  if (redirect.status !== 308) die(`http://localhost/ expected 308, got ${redirect.status || redirect.error}`);
  const location = String(redirect.headers.location || "");
  if (!/^https:\/\/localhost\/?$/.test(location)) die(`redirect Location wrong: ${location}`);
  console.log(`OK   :80 -> ${location} (308)`);

  // 2. Main site answers through the proxy.
  const health = await request({ protocol: "https", port: 443, servername: "localhost", path: "/health" });
  const healthBody = json(health.body);
  if (health.status !== 200 || !healthBody || healthBody.healthy !== true) {
    die(`https://localhost/health expected 200 healthy:true, got ${health.status} ${health.body.slice(0, 160)}`);
  }
  console.log(`OK   https://localhost/health 200 (agents=${healthBody.agents}, models=${healthBody.models})`);

  // 3. Rendered Caddyfile: bare hostnames only, exactly the expected sites.
  const rendered = fs.readFileSync(CADDYFILE, "utf8");
  const siteLines = rendered.split("\n").filter((line) => line.startsWith("https://"));
  for (const line of siteLines) {
    if ((line.match(/https:\/\//g) || []).length !== 1) die(`site address contains a scheme inside the host: ${line}`);
  }
  const hosts = siteLines.map((line) => line.replace(/^https:\/\//, "").replace(/\s*\{$/, "").trim()).sort();
  if (JSON.stringify(hosts) !== JSON.stringify(EXPECTED_HOSTS)) {
    die(`rendered hosts mismatch: ${JSON.stringify(hosts)}`);
  }
  console.log(`OK   Caddyfile hosts: ${hosts.join(", ")}`);

  // 4. Caddy accepts the rendered file.
  const validate = spawnSync("caddy", ["validate", "--config", CADDYFILE, "--adapter", "caddyfile"], {
    encoding: "utf8",
    timeout: 30000,
  });
  if (validate.status !== 0) die(`caddy validate failed: ${(validate.stderr || validate.stdout || "").slice(0, 300)}`);
  console.log("OK   caddy validate exit 0");

  // 5. The live Caddy config (admin API) matches all eight hosts.
  const admin = await request({ port: 2019, headers: { host: "localhost:2019" }, path: "/config/" });
  const config = json(admin.body);
  if (admin.status !== 200 || !config) die(`caddy admin config unavailable (HTTP ${admin.status})`);
  const liveHosts = new Set();
  for (const server of Object.values(config.apps?.http?.servers || {})) {
    for (const route of server.routes || []) {
      for (const match of route.match || []) {
        for (const host of match.host || []) liveHosts.add(host);
      }
    }
  }
  for (const host of EXPECTED_HOSTS) {
    if (!liveHosts.has(host)) die(`live Caddy config is missing host ${host}`);
  }
  console.log(`OK   live Caddy hosts: ${[...liveHosts].sort().join(", ")}`);

  // 6. Bridge discovery must not contain the gateway's own agent ids.
  const bridge = await request({ port: 11435, path: "/v1/models" });
  const bridgeBody = json(bridge.body);
  if (bridge.status !== 200 || !bridgeBody || !Array.isArray(bridgeBody.data)) {
    die(`bridge /v1/models unavailable (HTTP ${bridge.status})`);
  }
  const bridgeIds = bridgeBody.data.map((model) => String(model.id));
  for (const required of ["lfm3:1.7b", "deepseek-v4-pro"]) {
    if (!bridgeIds.includes(required)) die(`bridge is missing real upstream model ${required}`);
  }
  const leaked = bridgeIds.filter((id) => AGENT_IDS.includes(id));
  if (leaked.length > 0) die(`bridge discovered gateway agent ids as upstreams: ${leaked.join(", ")}`);
  console.log(`OK   bridge models: ${bridgeIds.join(", ")}`);

  // 7. The gateway must not advertise its own agent ids as bridge models.
  const catalog = await request({ port: 5050, path: "/api/v1/models" });
  const catalogBody = json(catalog.body);
  if (catalog.status !== 200 || !catalogBody || !Array.isArray(catalogBody.data)) {
    die(`gateway /api/v1/models unavailable (HTTP ${catalog.status})`);
  }
  const bridgeRows = catalogBody.data.filter((row) => String(row.provider) === "bridge").map((row) => String(row.id));
  const selfRows = bridgeRows.filter((id) => AGENT_IDS.includes(id));
  if (selfRows.length > 0) die(`gateway advertises its own agents as bridge models: ${selfRows.join(", ")}`);
  console.log(`OK   gateway bridge rows: ${bridgeRows.join(", ")}`);

  // 8. The gateway runs from dist under the systemd unit.
  let active = "";
  try {
    active = execFileSync("systemctl", ["--user", "is-active", "zombiecoder-gateway.service"], { encoding: "utf8" }).trim();
  } catch (error) {
    active = String(error.stdout || "").trim();
  }
  if (active !== "active") die(`zombiecoder-gateway.service is ${active || "unknown"}`);
  const shown = execFileSync("systemctl", ["--user", "show", "zombiecoder-gateway.service", "-p", "MainPID"], { encoding: "utf8" });
  const mainPid = Number((shown.match(/MainPID=(\d+)/) || [])[1] || 0);
  if (!mainPid) die("systemd unit has no MainPID");
  const cmdline = fs.readFileSync(`/proc/${mainPid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  if (!cmdline.includes("dist/start.js")) die(`MainPID ${mainPid} is not the dist runtime: ${cmdline}`);
  console.log(`OK   systemd active MainPID=${mainPid} (${cmdline})`);

  // 9. A tool subdomain must route through Caddy to a live upstream.
  const tool = await request({ protocol: "https", port: 443, servername: "ocr.localhost", path: "/" });
  if (tool.status === 0) die(`ocr.localhost TLS failed: ${tool.error}`);
  if (tool.status === 502) die("ocr.localhost returned 502: upstream not reachable");
  console.log(`OK   https://ocr.localhost/ -> HTTP ${tool.status} (routed)`);

  console.log("PROXY_UPSTREAM_OK");
}

main().catch((error) => die(String(error?.stack || error)));
