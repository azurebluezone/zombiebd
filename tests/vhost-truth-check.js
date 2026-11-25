#!/usr/bin/env node
"use strict";
/**
 * tests/vhost-truth-check.js — runbook row 17 (Phase C).
 *
 * The 2026-11-25 edge audit found seven 502 vhosts (ocr, screen, tts, ads,
 * public, combined, adapter): their upstream ports had no listener because
 * those tools are stdio MCP children, not HTTP services. The live Caddyfile
 * now has one site, https://127.0.0.1, and no localhost alias.
 *
 * This gate proves the removal is pinned in the renderer/template AND that
 * every live configured site answers /health with HTTP 200. A retired host
 * may be absent; it must never be configured and failing.
 *
 * Run: node tests/vhost-truth-check.js
 * Exit 0 + VHOST_TRUTH_OK only when every assertion passes (or live Caddy
 * is root-only unreadable and the skip is explicit).
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const edge = require(path.join(ROOT, "modules", "edge-proxy.js"));
const LIVE_CADDY = process.env.CADDYFILE || "/etc/caddy/Caddyfile";
const RETIRED = ["ocr", "screen", "tts", "ads", "public", "combined", "adapter"];

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name, detail) { pass++; console.log("PASS " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { fail++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
function skipOne(name, detail) { skip++; console.log("SKIP " + name + (detail ? " :: " + detail : "")); }
function check(name, cond, detail) { cond ? ok(name, detail) : bad(name, detail); }

function liveCaddyText() {
  try {
    return fs.readFileSync(LIVE_CADDY, "utf8");
  } catch (error) {
    try {
      return execFileSync("sudo", ["-n", "cat", LIVE_CADDY], { encoding: "utf8", timeout: 5000 });
    } catch (_) {
      return null;
    }
  }
}

function siteHosts(text) {
  const hosts = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*https:\/\/([^\s{]+)\s*\{/);
    if (match) hosts.push(match[1]);
  }
  return hosts;
}

function health(host, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      host,
      port: 443,
      path: "/health",
      method: "GET",
      rejectUnauthorized: false,
      timeout: timeoutMs || 5000,
      servername: host === "127.0.0.1" ? undefined : host,
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, error: error.message }));
    req.end();
  });
}

(async () => {
  // 1. The contract is one literal list in code and one explanation in the
  //    template. A stale tools.json cannot silently resurrect a dead site.
  check(
    "renderer exports the retired host list",
    Array.isArray(edge.RETIRED_TOOL_HOSTS) && RETIRED.every((h) => edge.RETIRED_TOOL_HOSTS.includes(h)),
    JSON.stringify(edge.RETIRED_TOOL_HOSTS),
  );
  for (const host of RETIRED) {
    check("isRetiredToolHost(" + host + ")", edge.isRetiredToolHost(host) === true);
    check("isRetiredToolHost(" + host + ".example.test)", edge.isRetiredToolHost(host + ".example.test") === true);
  }
  check("active host 127.0.0.1 is not retired", edge.isRetiredToolHost("127.0.0.1") === false);
  check("prefix lookalike is not retired", edge.isRetiredToolHost("ocr-live.example.test") === false);

  const runbook = fs.readFileSync(
    path.join(ROOT, "docs", "RUNBOOK-OPTIMIZATION-2026-11-19.md"),
    "utf8",
  );
  check(
    "runbook documents all seven retired hosts",
    RETIRED.every((h) => runbook.includes(h)),
    "runbook §17",
  );

  const config = edge.resolveEdgeConfig({ root: ROOT, env: Object.assign({}, process.env, { TOOL_BASE_DOMAIN: "edge.example.test" }) });
  config.tools = RETIRED.map((name) => ({ name, hostEnv: "", subdomain: name, portEnv: "STALE_" + name.toUpperCase() + "_PORT" }));
  for (const name of RETIRED) config.env["STALE_" + name.toUpperCase() + "_PORT"] = "3900";
  const rendered = edge.renderCaddy(config);
  const renderedHosts = siteHosts(rendered);
  check("retired hosts never render", RETIRED.every((h) => !renderedHosts.some((host) => edge.isRetiredToolHost(host))), renderedHosts.join(","));
  check("active main host still renders", renderedHosts.includes(config.mainHost), renderedHosts.join(","));
  check("renderer wrote an https site for the main host", /https:\/\//.test(rendered), "sites=" + renderedHosts.length);

  // 2. Live truth. Each configured site must answer 200. Retired names that
  //    are not configured are absent by definition and need no request.
  const live = liveCaddyText();
  if (!live) {
    skipOne("live Caddyfile readable", LIVE_CADDY + " is root-only; render/template checks still passed");
  } else {
    const hosts = siteHosts(live);
    ok("live Caddyfile readable", LIVE_CADDY + " sites=" + hosts.length);
    check("live edge has at least one site", hosts.length > 0, hosts.join(","));
    for (const host of hosts) {
      const result = await health(host, 5000);
      check("configured site " + host + " answers /health 200", result.status === 200, "status=" + result.status + (result.error ? " error=" + result.error : ""));
    }
    const configuredRetired = hosts.filter((host) => edge.isRetiredToolHost(host));
    check("no retired host is configured", configuredRetired.length === 0, configuredRetired.join(",") || "absent");
    check("localhost alias is absent", !hosts.includes("localhost"), hosts.join(","));
    const stale = hosts.filter((host) => /:(5000|3110|3111|3112|3121|3122|3123|5400)$/.test(host));
    check("no dead upstream port appears in a site address", stale.length === 0, stale.join(",") || "none");
  }

  if (fail > 0) {
    console.log("VHOST_TRUTH_FAIL pass=" + pass + " fail=" + fail + " skip=" + skip);
    process.exit(1);
  }
  console.log("VHOST_TRUTH_OK pass=" + pass + " fail=0 skip=" + skip);
})().catch((error) => {
  console.error("VHOST_TRUTH_ERROR " + (error && error.stack || error));
  process.exit(2);
});
