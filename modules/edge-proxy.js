"use strict";

/**
 * modules/edge-proxy.js — the ONE owner of the edge reverse proxy.
 *
 * What this module owns:
 *   - the env contract for the public edge (MAIN_HOST/APP_URL, API PORT,
 *     CADDY_HTTP_PORT, CADDY_HTTPS_PORT, TLS_MODE, ACME_EMAIL),
 *   - the Caddy and nginx templates (deploy/templates/),
 *   - loopback self-signed TLS for nginx (Caddy uses `tls internal`),
 *   - validation before anything is installed,
 *   - the apply/reload path (root only, opt-in via EDGE_APPLY=1).
 *
 * What it never does:
 *   - proxy /admin or /api/admin. Both are answered 404 at the edge so the
 *     admin panel and its token header stay on 127.0.0.1.
 *   - change a running service without a validated config and a backup.
 *
 * A render/validate failure is reported, never fatal: the gateway must still
 * boot when the edge is temporarily unavailable.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { loadEnv } = require("../lib/env");

const ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = path.join(ROOT, "deploy", "templates");
const CADDY_TEMPLATE = path.join(TEMPLATE_DIR, "Caddyfile.template");
const NGINX_TEMPLATE = path.join(TEMPLATE_DIR, "nginx.conf.template");
const ADMIN_PATHS = Object.freeze(["/admin", "/api/admin"]);
const PROVIDERS = new Set(["auto", "caddy", "nginx", "none"]);

function commandExists(name) {
  try {
    execFileSync("sh", ["-c", "command -v " + name], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function readTemplate(file) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) throw new Error("template is empty: " + file);
  return text;
}

function fill(template, values) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return match;
    return values[key] == null ? "" : String(values[key]);
  });
}

function readTools(root) {
  const file = path.join(root, "deploy", "tools.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch (_) {
    return [];
  }
}

function detectProvider(env) {
  const requested = String(env.EDGE_PROVIDER || "auto").trim().toLowerCase();
  if (!PROVIDERS.has(requested)) {
    throw new Error(
      "EDGE_PROVIDER must be auto, caddy, nginx or none (got " +
        JSON.stringify(requested) +
        ")",
    );
  }
  if (requested !== "auto") return requested;
  if (commandExists("caddy")) return "caddy";
  if (commandExists("nginx")) return "nginx";
  return "none";
}

/**
 * Resolve the edge contract from lib/env.js plus the edge-only variables.
 * `options.env` is merged over process.env so tests never touch the live env.
 */
function resolveEdgeConfig(options) {
  const opts = options || {};
  const root = path.resolve(opts.root || ROOT);
  const env = Object.assign({}, process.env, opts.env || {});
  const config = loadEnv({ root, env });
  if (config.errors.length > 0) {
    const error = new Error("ENV_FAIL " + config.errors.join("; "));
    error.code = "ENV_FAIL";
    throw error;
  }

  const provider = detectProvider(env);
  const mainHost = String(config.derived.mainHost || "127.0.0.1").trim();
  const apiPort = Number(config.ports.api);
  const httpPort = Number(config.ports.caddy_http);
  const httpsPort = Number(config.ports.caddy_https);
  for (const [name, port] of [
    ["PORT", apiPort],
    ["CADDY_HTTP_PORT", httpPort],
    ["CADDY_HTTPS_PORT", httpsPort],
  ]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(name + " is not a valid port");
    }
  }

  const outDir = path.resolve(
    root,
    String(env.EDGE_OUT_DIR || path.join("data", "edge")),
  );
  const certDir = path.resolve(
    root,
    String(env.EDGE_CERT_DIR || path.join("data", "certs")),
  );
  const certFile = path.resolve(
    root,
    String(env.EDGE_CERT_FILE || path.join(certDir, "127.0.0.1.crt")),
  );
  const keyFile = path.resolve(
    root,
    String(env.EDGE_CERT_KEY_FILE || path.join(certDir, "127.0.0.1.key")),
  );

  return {
    root,
    env,
    provider,
    mainHost,
    apiPort,
    httpPort,
    httpsPort,
    tlsMode: config.derived.tlsMode,
    acmeEmail: config.derived.acmeEmail,
    adminPaths: ADMIN_PATHS.slice(),
    tools: readTools(root),
    toolBaseDomain: config.derived.toolBaseDomain,
    outDir,
    certFile,
    keyFile,
  };
}

function toolSites(cfg) {
  const sites = [];
  for (const tool of cfg.tools) {
    if (!tool || !tool.name || !tool.portEnv) continue;
    const explicit = tool.hostEnv ? String(cfg.env[tool.hostEnv] || "").trim() : "";
    const host =
      explicit ||
      (cfg.toolBaseDomain && tool.subdomain
        ? tool.subdomain + "." + cfg.toolBaseDomain
        : "");
    const port = Number(cfg.env[tool.portEnv] || 0);
    if (!host || !Number.isInteger(port) || port < 1) continue;
    sites.push({ name: tool.name, host, port });
  }
  return sites;
}

function caddyTlsLine(cfg) {
  if (cfg.tlsMode === "internal") return "\ttls internal";
  if (cfg.tlsMode === "acme" && cfg.acmeEmail) return "\ttls " + cfg.acmeEmail;
  return "";
}

function renderCaddyToolSites(cfg) {
  const blocks = [];
  for (const site of toolSites(cfg)) {
    const lines = ["https://" + site.host + " {"];
    const tls = caddyTlsLine(cfg);
    if (tls) lines.push(tls);
    lines.push("\troute {");
    lines.push("\t\t@admin path /admin* /api/admin*");
    lines.push("\t\trespond @admin 404");
    lines.push("\t\treverse_proxy 127.0.0.1:" + site.port + " {");
    lines.push("\t\t\tflush_interval -1");
    lines.push("\t\t}");
    lines.push("\t}");
    lines.push("}");
    blocks.push(lines.join("\n"));
  }
  return blocks.length ? "\n" + blocks.join("\n\n") + "\n" : "";
}

function renderNginxToolSites(cfg) {
  const blocks = [];
  for (const site of toolSites(cfg)) {
    const lines = [];
    lines.push("server {");
    lines.push("    listen " + cfg.httpsPort + " ssl;");
    lines.push("    server_name " + site.host + ";");
    lines.push('    ssl_certificate "' + cfg.certFile + '";');
    lines.push('    ssl_certificate_key "' + cfg.keyFile + '";');
    lines.push("    ssl_protocols TLSv1.2 TLSv1.3;");
    lines.push("    location ^~ /api/admin { return 404; }");
    lines.push("    location ^~ /admin { return 404; }");
    lines.push("    location / {");
    lines.push("        proxy_pass http://127.0.0.1:" + site.port + ";");
    lines.push("        proxy_http_version 1.1;");
    lines.push("        proxy_set_header Host $host;");
    lines.push("        proxy_set_header X-Real-IP $remote_addr;");
    lines.push("        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;");
    lines.push("        proxy_set_header X-Forwarded-Proto $scheme;");
    lines.push("        proxy_buffering off;");
    lines.push("    }");
    lines.push("}");
    blocks.push(lines.join("\n"));
  }
  return blocks.length ? "\n" + blocks.join("\n\n") + "\n" : "";
}

function renderCaddy(cfg) {
  const template = readTemplate(CADDY_TEMPLATE);
  const acmeGlobal =
    cfg.tlsMode === "acme" && cfg.acmeEmail ? "\temail " + cfg.acmeEmail : "";
  return fill(template, {
    HTTP_PORT: cfg.httpPort,
    HTTPS_PORT: cfg.httpsPort,
    MAIN_HOST: cfg.mainHost,
    API_PORT: cfg.apiPort,
    TLS_DIRECTIVE: caddyTlsLine(cfg),
    ACME_GLOBAL: acmeGlobal,
    TOOL_SITES: renderCaddyToolSites(cfg),
  });
}

function renderNginx(cfg) {
  const template = readTemplate(NGINX_TEMPLATE);
  return fill(template, {
    HTTP_PORT: cfg.httpPort,
    HTTPS_PORT: cfg.httpsPort,
    MAIN_HOST: cfg.mainHost,
    API_PORT: cfg.apiPort,
    CERT_FILE: cfg.certFile,
    KEY_FILE: cfg.keyFile,
    TOOL_SITES: renderNginxToolSites(cfg),
  });
}

/**
 * Create the nginx loopback certificate. Caddy does this itself with
 * `tls internal`; nginx needs explicit PEM files. No root is required because
 * the files live under the project's data directory.
 */
function ensureSelfSigned(cfg) {
  if (cfg.tlsMode !== "internal") {
    return { created: false, reason: "TLS_MODE=" + cfg.tlsMode };
  }
  if (fs.existsSync(cfg.certFile) && fs.existsSync(cfg.keyFile)) {
    return { created: false, exists: true, cert: cfg.certFile, key: cfg.keyFile };
  }
  if (!commandExists("openssl")) {
    throw new Error("openssl is required to create the nginx self-signed certificate");
  }
  fs.mkdirSync(path.dirname(cfg.certFile), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.keyFile), { recursive: true });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "825",
      "-keyout",
      cfg.keyFile,
      "-out",
      cfg.certFile,
      "-subj",
      "/CN=" + cfg.mainHost,
      "-addext",
      "subjectAltName=DNS:" +
        cfg.mainHost +
        ",DNS:*." +
        cfg.mainHost +
        ",IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  fs.chmodSync(cfg.keyFile, 0o600);
  return { created: true, cert: cfg.certFile, key: cfg.keyFile };
}

function validateCaddy(file) {
  if (!commandExists("caddy")) {
    return { ok: false, skipped: true, reason: "caddy not installed" };
  }
  try {
    const out = execFileSync(
      "caddy",
      ["validate", "--config", file, "--adapter", "caddyfile"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const ok = /Valid configuration/i.test(out);
    return {
      ok,
      output: out.trim().split(/\r?\n/).slice(-2).join(" | "),
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error.stderr || error.message || error).slice(0, 400),
    };
  }
}

function validateNginx(file) {
  if (!commandExists("nginx")) {
    return { ok: true, skipped: true, reason: "nginx not installed" };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-nginx-"));
  const full = path.join(dir, "nginx.conf");
  try {
    fs.writeFileSync(
      full,
      "events {}\nhttp {\n" + fs.readFileSync(file, "utf8") + "\n}\n",
      "utf8",
    );
    execFileSync("nginx", ["-t", "-c", full, "-p", dir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: String(error.stderr || error.message || error).slice(0, 400),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function canSudo() {
  if (typeof process.getuid === "function" && process.getuid() === 0) return true;
  try {
    execFileSync("sudo", ["-n", "true"], { stdio: "ignore" });
    return true;
  } catch (_) {
    return false;
  }
}

function sudoExec(args, options) {
  return execFileSync(
    "sudo",
    args,
    Object.assign({ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }, options),
  );
}

/**
 * Install the rendered file and reload the edge. The caller must opt in
 * (EDGE_APPLY=1). A backup is kept and restored when validation/reload fails.
 */
function applyEdge(cfg, state) {
  if (!state || !state.files) {
    return { applied: false, reason: "nothing rendered" };
  }
  if (!canSudo()) {
    return {
      applied: false,
      reason: "needs root; run: sudo bash deploy/install-edge.sh",
    };
  }

  if (cfg.provider === "caddy" && state.files.caddy) {
    const target = String(cfg.env.CADDYFILE_PATH || "/etc/caddy/Caddyfile");
    const backup = target + ".zc-backup-" + Date.now();
    const had = fs.existsSync(target);
    try {
      if (had) sudoExec(["cp", target, backup]);
      sudoExec(["cp", state.files.caddy, target]);
      const out = sudoExec([
        "caddy",
        "validate",
        "--config",
        target,
        "--adapter",
        "caddyfile",
      ]);
      if (!/Valid configuration/i.test(out)) {
        throw new Error("caddy validate did not report a valid configuration");
      }
      sudoExec(["systemctl", "reload", "caddy"]);
      return { applied: true, target, backup: had ? backup : null, reloaded: true };
    } catch (error) {
      if (had) {
        try {
          sudoExec(["cp", backup, target]);
          sudoExec(["systemctl", "reload", "caddy"]);
        } catch (_) {
          /* the original file is still on disk if the restore failed */
        }
      }
      return {
        applied: false,
        target,
        error: String(error.stderr || error.message || error).slice(0, 400),
      };
    }
  }

  if (cfg.provider === "nginx" && state.files.nginx) {
    const target = String(
      cfg.env.NGINX_CONF_PATH || "/etc/nginx/conf.d/zombiecoder.conf",
    );
    const backup = target + ".zc-backup-" + Date.now();
    const had = fs.existsSync(target);
    try {
      if (had) sudoExec(["cp", target, backup]);
      sudoExec(["cp", state.files.nginx, target]);
      sudoExec(["nginx", "-t"]);
      sudoExec(["systemctl", "reload", "nginx"]);
      return { applied: true, target, backup: had ? backup : null, reloaded: true };
    } catch (error) {
      if (had) {
        try {
          sudoExec(["cp", backup, target]);
          sudoExec(["systemctl", "reload", "nginx"]);
        } catch (_) {
          /* keep the backup for manual recovery */
        }
      }
      return {
        applied: false,
        target,
        error: String(error.stderr || error.message || error).slice(0, 400),
      };
    }
  }

  return { applied: false, reason: "no matching edge provider" };
}

/**
 * Render + validate the edge files. With `apply: true` (or EDGE_APPLY=1 in
 * the caller) the active provider is installed and reloaded.
 */
function ensureEdge(options) {
  const opts = options || {};
  const cfg = resolveEdgeConfig(opts);
  fs.mkdirSync(cfg.outDir, { recursive: true });

  const result = {
    provider: cfg.provider,
    outDir: cfg.outDir,
    files: {},
    validation: {},
    selfSigned: null,
    applied: false,
    config: cfg,
  };

  const renderCaddyFile =
    cfg.provider === "caddy" || cfg.provider === "none" || opts.renderAll === true;
  const renderNginxFile =
    cfg.provider === "nginx" || cfg.provider === "none" || opts.renderAll === true;

  if (renderCaddyFile) {
    const file = path.join(cfg.outDir, "Caddyfile");
    fs.writeFileSync(file, renderCaddy(cfg), "utf8");
    result.files.caddy = file;
    if (cfg.provider === "caddy") result.validation.caddy = validateCaddy(file);
  }

  if (renderNginxFile) {
    result.selfSigned = ensureSelfSigned(cfg);
    const file = path.join(cfg.outDir, "nginx.conf");
    fs.writeFileSync(file, renderNginx(cfg), "utf8");
    result.files.nginx = file;
    if (cfg.provider === "nginx") result.validation.nginx = validateNginx(file);
  }

  if (opts.apply === true) result.applied = applyEdge(cfg, result);
  return result;
}

function formatEdgeLine(result) {
  const parts = ["provider=" + (result && result.provider ? result.provider : "none")];
  if (result && result.files) {
    if (result.files.caddy) parts.push("caddy=" + result.files.caddy);
    if (result.files.nginx) parts.push("nginx=" + result.files.nginx);
  }
  const validation =
    result && result.validation
      ? result.validation.caddy || result.validation.nginx
      : null;
  if (validation) {
    if (validation.ok) {
      parts.push(
        "validate=" + (validation.skipped ? "skipped(" + validation.reason + ")" : "ok"),
      );
    } else {
      parts.push("validate=FAILED(" + (validation.error || "unknown") + ")");
    }
  }
  parts.push("apply=" + (result && result.applied ? "ok" : "skipped"));
  return parts.join(" ");
}

function formatApplyLine(applied) {
  if (!applied) return "apply=skipped";
  if (applied.applied) {
    return "apply=ok target=" + applied.target + " reloaded=" + !!applied.reloaded;
  }
  return "apply=skipped reason=" + (applied.reason || applied.error || "unknown");
}

module.exports = {
  ADMIN_PATHS,
  resolveEdgeConfig,
  renderCaddy,
  renderNginx,
  ensureSelfSigned,
  validateCaddy,
  validateNginx,
  ensureEdge,
  applyEdge,
  formatEdgeLine,
  formatApplyLine,
};
