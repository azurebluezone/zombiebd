"use strict";

/**
 * lib/env.js - single source of truth for runtime configuration.
 *
 * Rules:
 *   - Every port and hostname comes from an environment variable.
 *   - Defaults live here and nowhere else.
 *   - Derived values are computed, never stored in .env.
 *   - This module has no dependencies outside the Node standard library.
 */

const fs = require("fs");
const path = require("path");

const DEFAULTS = Object.freeze({
  APP_URL: "",
  MAIN_HOST: "",
  TOOL_BASE_DOMAIN: "",
  TLS_MODE: "internal",
  ACME_EMAIL: "",
  CADDY_HTTP_PORT: "80",
  CADDY_HTTPS_PORT: "443",

  APP_ROOT: "",
  BIND_HOST: "127.0.0.1",
  PORT: "5050",
  UDS_PORT: "5150",
  UDS: path.join(require("os").tmpdir(), "zombiecoder", "mcp.sock"),
  UDS_OPENAI: "1",
  // Legacy names remain readable so existing test harnesses and installs
  // keep working; new deployments should set UDS only.
  UDS_PATH: path.join(require("os").tmpdir(), "zombiecoder", "mcp.sock"),
  OPENAI_UDS_PATH: path.join(require("os").tmpdir(), "zombiecoder", "openai.sock"),
  GRPC_PORT: "5052",
  HTTPS_PORT: "5444",

  FRONTEND_PORT: "8081",

  OCR_MCP_PORT: "3110",
  SCREEN_MCP_PORT: "3111",
  TTS_MCP_PORT: "3112",
  FB_ADS_MCP_PORT: "3121",
  PUBLIC_API_MCP_PORT: "3122",
  COMBINED_MCP_PORT: "3123",
  ADAPTER_HTTP_PORT: "5400",
  ADAPTER_HTTPS_PORT: "5443",

  BRIDGE_PORT: "11435",
  BRIDGE_INTERNAL_PORT: "11437",
  DB_SQLITE_PATH: path.join("data", "models.db"),
});

/** Logical service name -> env key that owns the port. */
const SERVICE_PORTS = Object.freeze({
  api: "PORT",
  uds: "UDS_PORT",
  grpc: "GRPC_PORT",
  https: "HTTPS_PORT",
  frontend: "FRONTEND_PORT",
  ocr: "OCR_MCP_PORT",
  screen: "SCREEN_MCP_PORT",
  tts: "TTS_MCP_PORT",
  facebook_ads: "FB_ADS_MCP_PORT",
  public_api: "PUBLIC_API_MCP_PORT",
  combined: "COMBINED_MCP_PORT",
  adapter_http: "ADAPTER_HTTP_PORT",
  adapter_https: "ADAPTER_HTTPS_PORT",
  bridge: "BRIDGE_PORT",
  bridge_internal: "BRIDGE_INTERNAL_PORT",
  caddy_http: "CADDY_HTTP_PORT",
  caddy_https: "CADDY_HTTPS_PORT",
});

const NUMERIC_KEYS = new Set(Object.values(SERVICE_PORTS));

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parseEnvFile(text) {
  const out = Object.create(null);
  const lines = String(text || "").split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();

    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      let end = -1;
      for (let i = 1; i < value.length; i++) {
        if (value[i] === "\\") {
          i++;
          continue;
        }
        if (value[i] === quote) {
          end = i;
          break;
        }
      }
      const inner = end === -1 ? value.slice(1) : value.slice(1, end);
      value = inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\(["'\\])/g, "$1");
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
      Object.prototype.hasOwnProperty.call(out, name)
        ? out[name]
        : process.env[name] || "",
    );

    out[key] = value;
  }

  return out;
}

function readEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  return parseEnvFile(fs.readFileSync(file, "utf8"));
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      out[key] = source[key];
    }
  }
  return out;
}

function toPort(value, key, errors) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    errors.push(key + " must be an integer between 1 and 65535 (got " + JSON.stringify(value) + ")");
    return null;
  }
  return n;
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch (_) {
    return "";
  }
}

function resolvePath(root, value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function loadEnv(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const envFile = options.envFile === undefined ? path.join(root, ".env") : options.envFile;
  const sourceEnv = options.env || process.env;
  const fileVars = options.fileVars || readEnvFile(envFile);

  const knownKeys = new Set([...Object.keys(DEFAULTS), ...Object.keys(fileVars)]);
  const values = {
    ...DEFAULTS,
    ...pick(fileVars, knownKeys),
    ...pick(sourceEnv, knownKeys),
  };

  const errors = [];
  const warnings = [];

  const ports = {};
  for (const [service, key] of Object.entries(SERVICE_PORTS)) {
    const parsed = toPort(values[key], key, errors);
    if (parsed !== null) ports[service] = parsed;
  }

  const seen = new Map();
  for (const [service, port] of Object.entries(ports)) {
    if (!seen.has(port)) seen.set(port, []);
    seen.get(port).push(service);
  }
  for (const [port, services] of seen.entries()) {
    if (services.length > 1) {
      errors.push(
        "port " + port + " is assigned to more than one service: " + services.join(", "),
      );
    }
  }

  const appUrl = String(values.APP_URL || "").trim();
  let publicHost = "";
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("APP_URL must use http: or https:");
      }
      publicHost = parsed.hostname;
    } catch (_) {
      errors.push("APP_URL is not a valid absolute URL: " + appUrl);
    }
  } else {
    warnings.push("APP_URL is empty; public URLs fall back to http://localhost:" + values.PORT);
  }

  const mainHost = String(values.MAIN_HOST || "").trim() || publicHost;
  const toolBaseDomain = String(values.TOOL_BASE_DOMAIN || "").trim().replace(/^\.+/, "");
  const tlsMode = String(values.TLS_MODE || "internal").trim().toLowerCase();
  if (!["internal", "acme"].includes(tlsMode)) {
    errors.push("TLS_MODE must be internal or acme (got " + tlsMode + ")");
  }

  const acmeEmail = String(values.ACME_EMAIL || "").trim();
  if (tlsMode === "acme" && !acmeEmail) {
    errors.push("ACME_EMAIL is required when TLS_MODE=acme");
  }
  if (tlsMode === "acme" && !mainHost) {
    errors.push("MAIN_HOST (or APP_URL) is required when TLS_MODE=acme");
  }

  const bindHost = String(values.BIND_HOST || "").trim();
  if (!bindHost) errors.push("BIND_HOST is empty");
  if (!LOOPBACK_HOSTS.has(bindHost) && bindHost !== "0.0.0.0" && bindHost !== "::") {
    warnings.push("BIND_HOST " + bindHost + " is not loopback; services will be reachable directly");
  }

  const appRoot = resolvePath(root, values.APP_ROOT) || root;
  const publicOrigin = normalizeOrigin(appUrl) || "http://localhost:" + values.PORT;

  return {
    root,
    envFile,
    values,
    ports,
    derived: {
      appRoot,
      publicOrigin,
      publicHost,
      mainHost,
      toolBaseDomain,
      tlsMode,
      acmeEmail,
      bindHost,
      isLoopbackBind: LOOPBACK_HOSTS.has(bindHost),
      dbPath: resolvePath(appRoot, values.DB_SQLITE_PATH),
      udsPath: resolvePath(appRoot, String(values.UDS || values.UDS_PATH || "").split(",")[0].trim()),
      udsPaths: String(values.UDS || values.UDS_PATH || "")
        .split(",")
        .map((item) => resolvePath(appRoot, item.trim()))
        .filter(Boolean),
      udsPort: ports.uds,
      wsOrigin: publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
    },
    errors,
    warnings,
  };
}

function formatReport(config) {
  const lines = [];
  lines.push("APP_ROOT=" + config.derived.appRoot);
  lines.push("APP_URL=" + (config.derived.publicOrigin || "(unset)"));
  lines.push("MAIN_HOST=" + (config.derived.mainHost || "(unset)"));
  lines.push("TLS_MODE=" + config.derived.tlsMode);
  for (const [service, key] of Object.entries(SERVICE_PORTS)) {
    lines.push(key + "=" + config.ports[service] + " (" + service + ")");
  }
  return lines.join("\n");
}

module.exports = {
  DEFAULTS,
  SERVICE_PORTS,
  NUMERIC_KEYS,
  LOOPBACK_HOSTS,
  parseEnvFile,
  readEnvFile,
  loadEnv,
  formatReport,
  resolvePath,
};
