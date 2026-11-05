#!/usr/bin/env node
"use strict";

/**
 * scripts/caddy-render.js - render a Caddyfile from the env contract.
 *
 * Every hostname and port is resolved at build time. The generated file has
 * fixed loopback upstreams; it must never contain a query-driven upstream.
 */

const fs = require("fs");
const path = require("path");
const { loadEnv, SERVICE_PORTS } = require("../lib/env");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = path.join(ROOT, "deploy", "tools.json");
const SERVICE_BY_KEY = Object.fromEntries(
  Object.entries(SERVICE_PORTS).map(([service, key]) => [key, service]),
);

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

function readManifest() {
  const parsed = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  if (!Array.isArray(parsed.tools)) throw new Error("deploy/tools.json: tools must be an array");
  return parsed.tools;
}

function resolveHost(config, tool) {
  const explicit = String(config.values[tool.hostEnv] || "").trim();
  if (explicit) return explicit;
  const base = config.derived.toolBaseDomain;
  if (!base) return "";
  return tool.subdomain + "." + base;
}

function siteBlock(host, port, tlsMode) {
  const lines = [];
  lines.push("https://" + host + " {");
  if (tlsMode === "internal") lines.push("\ttls internal");
  lines.push("\treverse_proxy 127.0.0.1:" + port + " {");
  lines.push("\t\theader_up Host {host}");
  lines.push("\t\theader_up X-Real-IP {remote_host}");
  lines.push("\t\tflush_interval -1");
  lines.push("\t}");
  lines.push("}");
  return lines.join("\n");
}

function render(config) {
  const manifest = readManifest();
  const mainHost = config.derived.mainHost;
  if (!mainHost) throw new Error("MAIN_HOST or APP_URL is required to render the main site");

  const sites = [];
  const seenHosts = new Set([mainHost]);
  sites.push({ host: mainHost, port: config.ports.api, name: "main" });

  for (const tool of manifest) {
    const host = resolveHost(config, tool);
    if (!host) continue;
    if (seenHosts.has(host)) throw new Error("duplicate hostname in manifest: " + host);
    const portKey = tool.portEnv;
    const service = SERVICE_BY_KEY[portKey];
    const port = service ? config.ports[service] : 0;
    if (!port) throw new Error("no resolved port for " + tool.name + " (" + portKey + ")");
    seenHosts.add(host);
    sites.push({ host, port, name: tool.name });
  }

  const global = ["{"];
  global.push("\thttp_port " + config.ports.caddy_http);
  global.push("\thttps_port " + config.ports.caddy_https);
  if (config.derived.tlsMode === "acme" && config.derived.acmeEmail) {
    global.push("\temail " + config.derived.acmeEmail);
  }
  global.push("}");

  return {
    sites,
    content:
      global.join("\n") +
      "\n\n" +
      sites.map((site) => siteBlock(site.host, site.port, config.derived.tlsMode)).join("\n\n") +
      "\n",
  };
}

function main() {
  const outFile = argValue("--out");
  const config = loadEnv({ root: ROOT });
  if (config.errors.length > 0) {
    process.stderr.write("ENV_FAIL\n" + config.errors.join("\n") + "\n");
    process.exit(1);
  }

  let result;
  try {
    result = render(config);
  } catch (error) {
    process.stderr.write("CADDY_RENDER_FAIL " + error.message + "\n");
    process.exit(1);
  }

  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), result.content, "utf8");
    console.log(
      "CADDY_RENDER_OK sites=" + result.sites.length + " out=" + path.resolve(outFile),
    );
  } else {
    process.stdout.write(result.content);
    process.stderr.write("CADDY_RENDER_OK sites=" + result.sites.length + "\n");
  }
}

main();
