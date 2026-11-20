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
const os = require("os");
const path = require("path");
const { collectUdsPaths } = require("../transport/uds-gateway");
const { LOOPBACK_HOSTS } = require("./net");

const DEFAULTS = Object.freeze({
  APP_URL: "",
  MAIN_HOST: "",
  TOOL_BASE_DOMAIN: "",
  TLS_MODE: "internal",
  ACME_EMAIL: "",
  CADDY_HTTP_PORT: "80",
  CADDY_HTTPS_PORT: "443",

  APP_ROOT: "",
  BIND_HOST: "localhost",
  PORT: "5050",
  UDS_PORT: "5150",
  // Relative on purpose: every dist resolves its socket under its own root,
  // so two projects on one machine never share a /tmp path.
  UDS: path.join("data", "run", "mcp.sock"),
  UDS_OPENAI: "1",
  // Legacy names remain readable so existing test harnesses and installs
  // keep working; new deployments should set UDS_1..N only.
  UDS_PATH: path.join("data", "run", "mcp.sock"),
  OPENAI_UDS_PATH: path.join("data", "run", "openai.sock"),
  GRPC_PORT: "5052",
  HTTPS_PORT: "5444",

  FRONTEND_PORT: "8081",

  // Standalone universal-adapter ports. The gateway spawns the adapter over
  // stdio, so these are only used when it is run as its own HTTP service.
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
  adapter_http: "ADAPTER_HTTP_PORT",
  adapter_https: "ADAPTER_HTTPS_PORT",
  bridge: "BRIDGE_PORT",
  bridge_internal: "BRIDGE_INTERNAL_PORT",
  caddy_http: "CADDY_HTTP_PORT",
  caddy_https: "CADDY_HTTPS_PORT",
});

const NUMERIC_KEYS = new Set(Object.values(SERVICE_PORTS));

function parseEnvFile(text, warnings) {
  const out = Object.create(null);
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      if (Array.isArray(warnings)) {
        warnings.push("line " + (index + 1) + ": expected KEY=VALUE");
      }
      continue;
    }

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

/**
 * Load one .env file into a target environment object.
 *
 * This is the ONLY place that reads .env for the runtime. Callers get a
 * structured result instead of a silent no-op, so an unreadable file or a
 * malformed line is reported rather than swallowed.
 *
 * Parent values win by default (shell/systemd always overrides the file);
 * pass overwrite:true for tests that need the file values.
 */
function loadProcessEnv(options) {
  const o = options || {};
  const root = path.resolve(o.root || process.cwd());
  const envFile = o.envFile === undefined ? path.join(root, ".env") : o.envFile;
  const env = o.env || process.env;
  const overwrite = o.overwrite === true;
  const warnings = [];

  if (!envFile) {
    return { loaded: false, file: null, count: 0, vars: {}, warnings, missing: true };
  }

  let text;
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { loaded: false, file: envFile, count: 0, vars: {}, warnings, missing: true };
    }
    const detail =
      (error && error.code ? error.code + ": " : "") +
      (error && error.message ? error.message : String(error));
    return { loaded: false, file: envFile, count: 0, vars: {}, warnings, error: detail };
  }

  const fileVars = parseEnvFile(text, warnings);
  let count = 0;
  for (const [key, value] of Object.entries(fileVars)) {
    if (overwrite || !env[key]) {
      env[key] = value;
      count += 1;
    }
  }

  return { loaded: true, file: envFile, count, vars: fileVars, warnings };
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

// ─── Runtime paths — one resolver ─────────────────────────────────────
// Every project-owned location (data, logs, cache, DB, config, MCP output)
// is decided here. Consumers never join __dirname/process.cwd() themselves:
// an absolute env value stays absolute, a relative one resolves against
// APP_ROOT, and the same answer reaches api.js, start.js, the bridge and the
// MCP tools. os.homedir() is called in this file only.

function userHomeDir() {
  return os.homedir();
}

function expandHome(value) {
  const s = String(value || "");
  if (s === "~") return userHomeDir();
  if (s.startsWith("~/") || s.startsWith("~\\")) {
    return path.join(userHomeDir(), s.slice(2));
  }
  return s;
}

function resolveRootPath(appRoot, value) {
  const expanded = expandHome(value);
  if (!expanded) return "";
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(appRoot, expanded);
}

/**
 * Default runtime root. lib/ sits one level below the checkout, but inside a
 * dist/ build it sits one level below dist/. Walk up when the parent is a
 * dist/ tree next to the launcher so the UDS and data/ never resolve to
 * dist/data.
 */
function defaultProjectRoot() {
  const base = path.resolve(__dirname, "..");
  if (
    path.basename(base) === "dist" &&
    fs.existsSync(path.join(base, "..", "start.js"))
  ) {
    return path.resolve(base, "..");
  }
  return base;
}

/**
 * Resolve every runtime location once.
 *
 * options.appRoot wins over env.APP_ROOT; without either, APP_ROOT is the
 * project root (never a dist/ subfolder). Relative values always resolve
 * against APP_ROOT, never the shell's cwd.
 */
function resolveRuntimePaths(env, options) {
  const source = env || process.env;
  const o = options || {};
  const base = path.resolve(o.appRoot || defaultProjectRoot());
  const configuredRoot = String(source.APP_ROOT || "").trim();
  const appRoot = configuredRoot ? resolveRootPath(base, configuredRoot) : base;

  const dataDir =
    resolveRootPath(appRoot, source.DATA_DIR) || path.join(appRoot, "data");
  const logDir =
    resolveRootPath(appRoot, source.LOG_DIR) || path.join(appRoot, "logs");
  const cacheDir =
    resolveRootPath(appRoot, source.CACHE_DIR) || path.join(appRoot, "cache");
  const tmpDir = resolveRootPath(
    appRoot,
    source.TMP_DIR || path.join(os.tmpdir(), "zombiecoder"),
  );
  const dbPath =
    resolveRootPath(appRoot, source.DB_SQLITE_PATH) ||
    path.join(dataDir, "models.db");
  const configDir = resolveRootPath(
    appRoot,
    source.ZOMBIECODER_CONFIG_DIR || path.join(userHomeDir(), ".zombiecoder"),
  );
  const mcpOutputDir =
    resolveRootPath(appRoot, source.MCP_OUTPUT_DIR) ||
    path.join(dataDir, "mcp-output");
  const ttsOutputDir =
    resolveRootPath(appRoot, source.TTS_OUTPUT_DIR) ||
    path.join(dataDir, "tts");
  const screenDir =
    resolveRootPath(appRoot, source.SCREEN_RECORDINGS_DIR) ||
    path.join(dataDir, "recordings");

  return {
    appRoot,
    dataDir,
    logDir,
    cacheDir,
    tmpDir,
    dbPath,
    configDir,
    mcpOutputDir,
    ttsOutputDir,
    screenDir,
    homeDir: userHomeDir(),
  };
}

/** Throw PATH_ESCAPE unless `candidate` is root itself or below it. */
function assertPathInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  const inside =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
  if (inside) return true;
  const error = new Error(
    "PATH_ESCAPE root=" + resolvedRoot + " candidate=" + resolvedCandidate,
  );
  error.code = "PATH_ESCAPE";
  throw error;
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
  // TOOL_BASE_DOMAIN is a bare domain. A pasted URL ("https://localhost")
  // must not leak its scheme into the Caddy site address: that renders
  // "https://ocr.https://localhost", which Caddy parses as host "ocr.https"
  // plus a path, so the tool subdomain never matches.
  const toolBaseDomain = String(values.TOOL_BASE_DOMAIN || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/^\.+/, "");
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

  // UDS candidates: UDS_1..UDS_N plus the legacy comma list. Order is
  // fallback order and duplicates are removed once for every consumer.
  const udsCandidates = collectUdsPaths({ ...fileVars, ...sourceEnv }, appRoot);
  const legacyUds = String(values.UDS || values.UDS_PATH || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolvePath(appRoot, item));
  const udsPaths = udsCandidates.length
    ? udsCandidates
    : legacyUds.length
      ? legacyUds
      : [resolvePath(appRoot, DEFAULTS.UDS)];

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
      udsPath: udsPaths[0],
      udsPaths,
      udsPort: ports.uds,
      wsOrigin: publicOrigin.replace(/^http:/, "ws:").replace(/^https:/, "wss:"),
    },
    paths: resolveRuntimePaths(
      {
        ...DEFAULTS,
        ...fileVars,
        ...pick(sourceEnv, knownKeys),
        APP_ROOT: appRoot,
      },
      { appRoot },
    ),
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
  loadProcessEnv,
  loadEnv,
  formatReport,
  resolvePath,
  resolveRootPath,
  resolveRuntimePaths,
  assertPathInside,
  userHomeDir,
  expandHome,
};
