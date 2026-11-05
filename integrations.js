/**
 * integrations.js — optional API connections to external systems
 * ═══════════════════════════════════════════════════════════════════════
 * DESIGN CONTRACT (the whole point of this module)
 *
 *   1. Never fatal. A connection that is absent, misconfigured, offline, or
 *      failing throws NOTHING into the caller. Features that depend on it are
 *      simply reported as unavailable.
 *   2. Never eager. connect() is lazy and memoised — a project that never asks
 *      for an integration pays no network cost and no startup delay.
 *   3. Never silent. Every integration exposes a status() so the admin panel
 *      and the API can show "not configured" honestly instead of pretending.
 *   4. No hardcoded credentials. Keys come from the environment only; nothing
 *      is ever written to disk or echoed back to a client.
 *
 * Use it from anywhere:
 *
 *     const integrations = require("./integrations.js");
 *     const fb = integrations.get("facebook-ads");
 *     if (fb.available()) {
 *       const r = await fb.get("/act").catch(() => null);   // null = failed, not fatal
 *     }
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;

/**
 * Declarative registry. Adding an integration is data, not code — no new
 * branch anywhere else in the server.
 */
const DEFINITIONS = {
  facebook: {
    name: "Facebook Ads",
    env: { appId: "FB_APP_ID", secret: "FB_APP_SECRET", token: "FB_ACCESS_TOKEN", version: "FB_GRAPH_VERSION" },
    defaults: { version: "v21.0" },
    build({ appId, secret, token, version }) {
      return { baseUrl: `https://graph.facebook.com/${version}`, token, appId, secret };
    },
  },

  shopify: {
    name: "Shopify",
    env: { store: "SHOPIFY_STORE_DOMAIN", token: "SHOPIFY_ACCESS_TOKEN", version: "SHOPIFY_API_VERSION" },
    defaults: { version: "2024-10" },
    build({ store, token, version }) {
      return { baseUrl: `https://${store}/admin/api/${version}/json`, token };
    },
  },

  facebookAds: {
    name: "Facebook Ads (Marketing API)",
    env: { adAccount: "FB_AD_ACCOUNT_ID", token: "FB_ADS_ACCESS_TOKEN", version: "FB_GRAPH_VERSION" },
    defaults: { version: "v21.0" },
    build({ adAccount, token, version }) {
      return { baseUrl: `https://graph.facebook.com/${version}`, token, adAccount };
    },
  },

  generic: {
    // Escape hatch: any OpenAI-compatible or REST endpoint by URL.
    name: "Generic REST",
    env: { url: "GENERIC_API_URL", token: "GENERIC_API_TOKEN" },
    build({ url, token }) {
      return { baseUrl: url, token };
    },
  },
};

/** Live state per integration — lazily filled, never blocking. */
const STATE = new Map();

function readEnv() {
  const out = {};
  const file = path.join(ROOT, ".env");
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || /^=+$/.test(t)) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!out[k]) out[k] = v;
    }
  } catch (_) {
    /* no .env — everything simply reads as unconfigured */
  }
  for (const [k, v] of Object.entries(process.env)) if (!out[k]) out[k] = v;
  return out;
}

/**
 * @returns {{ id, name, configured, baseUrl, status }}
 *   `configured` false means "feature unavailable" — callers must degrade,
 *   never crash.
 */
function get(id) {
  const key = String(id || "").trim();
  const def = DEFINITIONS[key];
  if (!def) {
    return {
      id: key,
      name: key,
      configured: false,
      status: "unknown integration",
      available: () => false,
      request: async () => ({ ok: false, error: "unknown integration" }),
    };
  }

  if (!STATE.has(key)) {
    const env = readEnv();
    const values = {};
    let missing = [];
    for (const [field, envKey] of Object.entries(def.env)) {
      const raw = env[envKey];
      // A placeholder is not a configuration — same rule as the provider keys.
      const usable = raw && !/^(<.*>|\{\{.*\}\}|YOUR_|CHANGEME)/i.test(String(raw).trim()) ? raw : "";
      values[field] = usable || def.defaults?.[field] || "";
      if (!usable && !def.defaults?.[field]) missing.push(envKey);
    }
    const cfg = missing.length ? null : def.build(values);
    STATE.set(key, {
      id: key,
      name: def.name,
      configured: !!cfg,
      baseUrl: cfg?.baseUrl || null,
      token: cfg?.token || null,
      extra: cfg ? { ...cfg, token: undefined } : null,
      missing,
      lastError: null,
      lastOkAt: null,
    });
  }

  const st = STATE.get(key);

  return {
    id: st.id,
    name: st.name,
    configured: st.configured,
    baseUrl: st.baseUrl,
    missing: st.missing,

    available: () => st.configured,

    /**
     * Fire an HTTP call. NEVER throws — always returns a plain result, so a
     * dead integration cannot take a request down with it.
     */
    async request(pathname = "/", options = {}) {
      if (!st.configured) {
        return {
          ok: false,
          available: false,
          error: `${st.name} is not configured (set ${st.missing.join(", ")})`,
        };
      }
      const url = st.baseUrl.replace(/\/$/, "") + (pathname.startsWith("/") ? pathname : "/" + pathname);
      try {
        const mod = url.startsWith("https:") ? require("https") : require("http");
        const res = await new Promise((resolve, reject) => {
          const req = mod.request(
            url,
            {
              method: options.method || "GET",
              headers: {
                Accept: "application/json",
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...(st.token ? { Authorization: `Bearer ${st.token}` } : {}),
                ...(options.headers || {}),
              },
              timeout: options.timeoutMs || 15000,
            },
            (r) => {
              let data = "";
              r.on("data", (c) => (data += c));
              r.on("end", () => resolve({ status: r.statusCode, body: data }));
            },
          );
          req.on("timeout", () => req.destroy(new Error("timeout")));
          req.on("error", reject);
          if (options.body) req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
          req.end();
        });
        let parsed = res.body;
        try { parsed = JSON.parse(res.body); } catch (_) {}
        st.lastOkAt = new Date().toISOString();
        st.lastError = null;
        return { ok: res.status >= 200 && res.status < 300, available: true, status: res.status, data: parsed };
      } catch (err) {
        st.lastError = err.message;
        return { ok: false, available: true, error: err.message };
      }
    },
  };
}

function list() {
  return Object.keys(DEFINITIONS).map((id) => {
    const i = get(id);
    return { id: i.id, name: i.name, configured: i.configured, baseUrl: i.baseUrl, missing: i.missing || [] };
  });
}

/** Test every integration without throwing; used by /api/integrations. */
async function probe() {
  const out = [];
  for (const row of list()) {
    const i = get(row.id);
    if (!i.configured) {
      out.push({ ...row, reachable: false, note: "not configured" });
      continue;
    }
    const r = await i.request("/");
    out.push({ ...row, reachable: !!r.ok, status: r.status, note: r.ok ? "ok" : r.error || `HTTP ${r.status}` });
  }
  return out;
}

module.exports = { get, list, probe, DEFINITIONS, _reset: () => STATE.clear() };