// =============================================================================
// Domain Configuration — Per-Server Identity & Settings
// Mission Barisal v3 — Zero Dependency
// =============================================================================
// IMPORTANT: No hardcoded domains! Everything comes from environment variables.
// Set these in .env file or export them in your shell.
//
// URL Resolution Priority:
//   1. APP_URL env var (explicit full URL: e.g., "https://mydomain.com")
//   2. DEPLOY_DOMAIN env var (domain only: e.g., "mydomain.com")
//   3. Host header from incoming request (runtime)
//   4. Fallback: "localhost"
//
// Session Verify URL:
//   If APP_URL is set, auto-derived as APP_URL + "/api/verify-session"
//   Can be overridden via SESSION_VERIFY_URL env var
//
// Optional env vars (shown with defaults):
//   APP_URL               — Full application URL (auto-detected if empty)
//   DEPLOY_DOMAIN         — Server domain (e.g., "mydomain.com", "localhost")
//   SERVER_NAME           — "Mission Barisal"
//   SERVER_VERSION        — "3.2.1"
//   SERVER_TYPE           — "production" | "development" | "custom"
//   PORT                  — Server port (used for CORS)
//   SESSION_VERIFY_URL    — Session verification endpoint
//   HAS_FRONTEND          — "true" | "false"
//   HAS_PUSHER            — "true" | "false"
//   HAS_DEV_MODELS        — "true" | "false"
//   MAX_RATE_LIMIT        — Requests/min per server instance
//   BRANDING_OWNER        — Owner name
//   BRANDING_ORGANIZATION — Organization name
//   BRANDING_EMAIL        — Contact email
//   BRANDING_WEBSITE      — Website URL
//   BRANDING_ADDRESS      — Physical address
//   BRANDING_LOCATION     — Location
// =============================================================================

const fs = require("fs");
const path = require("path");

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function hostOf(value) {
  try {
    return new URL(String(value).trim()).hostname.toLowerCase();
  } catch (_) {
    return "";
  }
}

function deriveCorsOrigins(env) {
  const appUrl = String(env.APP_URL || "").trim();
  const appHost = hostOf(appUrl);
  const port = String(env.PORT || "5050");
  const localApp = !appHost || LOOPBACK.has(appHost);

  let scheme = "https";
  let appPort = "";
  try {
    const parsed = new URL(appUrl);
    scheme = parsed.protocol.replace(":", "");
    appPort = parsed.port;
  } catch (_) {
    // An invalid APP_URL is reported by lib/env.js at startup.
  }

  const mainHost = (String(env.MAIN_HOST || "").trim() || appHost).toLowerCase();
  const toolBaseDomain = String(env.TOOL_BASE_DOMAIN || "").trim().replace(/^\.+/, "").toLowerCase();
  let tools = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "deploy", "tools.json"), "utf8"));
    if (Array.isArray(manifest.tools)) tools = manifest.tools;
  } catch (_) {
    // Caddy render fails on a missing manifest; origin derivation stays empty.
  }

  const origins = new Set();
  const add = (origin) => {
    try {
      const parsed = new URL(String(origin).trim());
      if (parsed.protocol === "http:" || parsed.protocol === "https:") origins.add(parsed.origin);
    } catch (_) {
      /* invalid candidate: ignore */
    }
  };

  add(appUrl);
  if (mainHost && !LOOPBACK.has(mainHost)) {
    add(scheme + "://" + mainHost + (appPort ? ":" + appPort : ""));
  }

  for (const tool of tools) {
    const explicitHost = tool && tool.hostEnv
      ? String(env[tool.hostEnv] || "").trim().toLowerCase()
      : "";
    const host = explicitHost || (
      toolBaseDomain && tool && tool.subdomain
        ? tool.subdomain.toLowerCase() + "." + toolBaseDomain
        : ""
    );
    if (!host || LOOPBACK.has(host)) continue;
    add(scheme + "://" + host + (appPort ? ":" + appPort : ""));
  }

  if (localApp) {
    add("http://localhost:" + port);
    add("http://127.0.0.1:" + port);
    if (mainHost && LOOPBACK.has(mainHost)) add("http://" + mainHost + ":" + port);
  }

  return Array.from(origins);
}

// ─── Default Fallback (all env-var driven) ────────────────────
function buildDefaultConfig() {
  const port = parseInt(process.env.PORT || "5050", 10);
  const appUrl = process.env.APP_URL || "";
  const deployDomain = process.env.DEPLOY_DOMAIN || "";

  // Determine domain from APP_URL or DEPLOY_DOMAIN
  let domain = "localhost";
  let protocol = "http";
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      domain = parsed.hostname;
      protocol = parsed.protocol.replace(":", "");
    } catch (e) {
      domain = appUrl;
    }
  } else if (deployDomain) {
    domain = deployDomain;
  }

  // Build session verify URL from APP_URL or domain
  let sessionVerifyUrl = "";
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      parsed.pathname = "/api/verify-session";
      sessionVerifyUrl = parsed.toString();
    } catch (e) {
      // fallback below
    }
  }
  if (!sessionVerifyUrl) {
    sessionVerifyUrl =
      process.env.SESSION_VERIFY_URL ||
      protocol + "://" + domain + ":" + port + "/api/verify-session";
  }

  return {
    name: process.env.SERVER_NAME || "Mission Barisal",
    domain: domain,
    appUrl: appUrl || protocol + "://" + domain + ":" + port,
    protocol: protocol,
    version: process.env.SERVER_VERSION || "3.2.1",
    type: process.env.SERVER_TYPE || "development",
    hasFrontend: process.env.HAS_FRONTEND === "true",
    hasPusher: process.env.HAS_PUSHER === "true",
    hasDevModels: process.env.HAS_DEV_MODELS !== "false",
    maxRateLimitPerServer: parseInt(process.env.MAX_RATE_LIMIT || "999999", 10),
    corsOrigins: deriveCorsOrigins(process.env),
    sessionVerifyUrl: sessionVerifyUrl,
    identity: {
      name: process.env.BRANDING_OWNER || "ZombieCoder",
      version: process.env.SERVER_VERSION || "3.2.1",
      tagline: process.env.BRANDING_TAGLINE || "যোনে কোড ও কথা বলে",
      branding: {
        owner: process.env.BRANDING_OWNER || "Development User",
        organization: process.env.BRANDING_ORGANIZATION || "Developer Zone",
        address: process.env.BRANDING_ADDRESS || "Local Development",
        location: process.env.BRANDING_LOCATION || "Barisal, Bangladesh",
        contact: {
          phone: process.env.BRANDING_PHONE || "",
          email: process.env.BRANDING_EMAIL || "dev@localhost",
          website: process.env.BRANDING_WEBSITE || appUrl || protocol + "://" + domain + ":" + port,
        },
      },
      project: "Mission Barisal — Multi-Agent Code Platform",
      runtime:
        "Zero Dependency · Pure Node.js" +
        (process.env.SERVER_TYPE === "development" ? " · Development" : ""),
    },
  };
}

// ─── DOMAIN_CONFIGS — empty by default, all config driven by env ──
// Domain-specific overrides can still be added here for advanced setups,
// but the recommended approach is to use environment variables.
const DOMAIN_CONFIGS = {};

// ─── Detect Domain ────────────────────────────────────────────
/**
 * Detect which domain this server instance is running on.
 * Priority:
 *   1. APP_URL env var (full URL parsed for hostname)
 *   2. DEPLOY_DOMAIN env var (explicit override)
 *   3. Request Host header (runtime detection)
 *   4. Fallback to "localhost"
 *
 * NO PORT-BASED DETECTION: Port 3000 no longer auto-routes to
 *    skilltoearn, port 7799 no longer auto-routes to kingwin360.
 *    Everything is explicit via env vars.
 */
function detectDomain(hostHeader) {
  // 0. APP_URL — highest priority, parse hostname from full URL
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      const parsed = new URL(appUrl);
      return parsed.hostname;
    } catch (e) {
      // If APP_URL is not a valid URL, treat as domain string
      if (appUrl.indexOf("://") === -1) return appUrl;
    }
  }

  // 1. DEPLOY_DOMAIN env var — explicit override
  const envDomain = process.env.DEPLOY_DOMAIN;
  if (envDomain) {
    return envDomain;
  }

  // 2. Host header from incoming request
  if (hostHeader) {
    const cleanHost = hostHeader.split(":")[0].toLowerCase();

    // Check explicit configs
    if (DOMAIN_CONFIGS[cleanHost]) return cleanHost;

    // Check env-based domain
    if (envDomain && cleanHost === envDomain) return envDomain;

    return cleanHost;
  }

  // 3. Fallback
  return "localhost";
}

/**
 * Get the full configuration for a detected domain.
 * Returns a merged config: env var driven with optional domain-specific overrides.
 */
function getDomainConfig(detectedDomain) {
  // Start with domain-specific config if exists
  const domainSpecific = DOMAIN_CONFIGS[detectedDomain];
  const base = domainSpecific || buildDefaultConfig();

  // If we have a domain-specific config, merge env overrides on top
  if (domainSpecific) {
    return applyEnvOverrides(base, detectedDomain);
  }

  // Otherwise just build from env
  return buildDefaultConfig();
}

/**
 * Apply environment variable overrides to a config object.
 */
function applyEnvOverrides(config, domain) {
  const overridden = { ...config };

  if (process.env.PUSHER_APP_ID) {
    overridden.hasPusher = true;
  }
  if (process.env.SESSION_VERIFY_URL) {
    overridden.sessionVerifyUrl = process.env.SESSION_VERIFY_URL;
  }
  if (process.env.MAX_RATE_LIMIT) {
    overridden.maxRateLimitPerServer = parseInt(process.env.MAX_RATE_LIMIT, 10);
  }
  if (process.env.SERVER_TYPE) {
    overridden.type = process.env.SERVER_TYPE;
  }
  if (process.env.HAS_FRONTEND) {
    overridden.hasFrontend = process.env.HAS_FRONTEND === "true";
  }
  if (process.env.HAS_DEV_MODELS) {
    overridden.hasDevModels = process.env.HAS_DEV_MODELS === "true";
  }

  return overridden;
}

module.exports = {
  DOMAIN_CONFIGS,
  detectDomain,
  getDomainConfig,
  buildDefaultConfig,
  deriveCorsOrigins,
};
