"use strict";

/**
 * lib/bridge-upstreams.js — explicit-only discovery for the local bridge.
 *
 * The bridge used to append DEFAULT_PROBE_PORTS and probe eight conventional
 * loopback ports on every refresh. That was hidden egress: a user who only
 * configured one upstream still had their machine scanned, and the same
 * Ollama server could appear twice (localhost and 127.0.0.1). Discovery is
 * now exactly the operator's list:
 *
 *   BRIDGE_UPSTREAMS     name=url,url
 *   BRIDGE_OLLAMA_URL    legacy single configured upstream
 *   BRIDGE_BACKEND=llama  the bundled llama-server this process spawns
 *
 * A loopback URL on one of this process's own ports is a self-reference and
 * is rejected before any request is made.
 */

const { isSelfReference, upstreamKey } = require("./net");

// "name=url,url" — one entry per upstream. The name is only for logs and
// owned_by; routing is by the model ids each upstream reports.
function parseUpstreamList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf("=");
      if (eq > 0) {
        return { name: item.slice(0, eq).trim(), baseUrl: item.slice(eq + 1).trim() };
      }
      return { name: "", baseUrl: item };
    })
    .filter((u) => /^https?:\/\//i.test(u.baseUrl));
}

/**
 * @param {{
 *   explicitUpstreams?: Array<{name?: string, baseUrl: string}>,
 *   configuredUrl?: string,
 *   backend?: string,
 *   internalPort?: number|string,
 *   selfPorts?: Set<number>|number[],
 * }} options
 * @returns {{candidates: Array<{name: string, baseUrl: string}>, selfReferences: Array<{name: string, baseUrl: string}>}}
 */
function buildCandidates(options) {
  const opts = options || {};
  const out = [];
  const selfReferences = [];
  const seen = new Set();
  const selfPorts = opts.selfPorts instanceof Set
    ? opts.selfPorts
    : new Set(opts.selfPorts || []);

  const add = (name, rawUrl) => {
    const base = String(rawUrl || "").replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) return;
    let parsed;
    try {
      parsed = new URL(base);
    } catch (_) {
      return;
    }
    if (!parsed.hostname) return;
    if (isSelfReference(base, selfPorts)) {
      selfReferences.push({ name: name || base, baseUrl: base });
      return;
    }
    const key = upstreamKey(base);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: name || base, baseUrl: base });
  };

  for (const u of opts.explicitUpstreams || []) {
    add(u.name || "explicit", u.baseUrl);
  }
  if (opts.configuredUrl) add("configured", opts.configuredUrl);
  if (opts.backend === "llama") {
    add("llama-server", "http://localhost:" + opts.internalPort);
  }

  return { candidates: out, selfReferences };
}

module.exports = {
  buildCandidates,
  parseUpstreamList,
};
