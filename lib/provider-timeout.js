"use strict";
// ─── provider-timeout.js ──────────────────────────────────────────────
// One resolver for every provider deadline.
//
// Before this file the same decision lived in four places and disagreed:
//   provider/transport.js   60000 request / 300000 stream defaults
//   api.js (ollama)         OLLAMA_TIMEOUT_MS / OLLAMA_STREAM_TIMEOUT_MS
//   api.js (bridge)         no timeout at all → transport's 60s won
//   local-llm-bridge.js     BRIDGE_TIMEOUT_MS || 120000 (upstream)
// The bridge upstream is allowed to think for BRIDGE_TIMEOUT_MS, so the
// gateway must wait at least that long plus a grace period; otherwise the
// gateway aborts while the bridge is still working (P0-07 / P1-01).
//
// Precedence for a provider call:
//   1. <PROVIDER>_TIMEOUT_MS      e.g. OLLAMA_TIMEOUT_MS, OLLAMA_STREAM_TIMEOUT_MS
//   2. PROVIDER_TIMEOUT_MS        global override
//   3. DEFAULT_PROVIDER_TIMEOUT_MS
// Streaming falls back to the resolved request timeout, so a provider can
// never accidentally hold one deadline for JSON and a different one for SSE.

const DEFAULT_PROVIDER_TIMEOUT_MS = 300000;
const DEFAULT_BRIDGE_TIMEOUT_MS = 120000;
const DEFAULT_BRIDGE_GRACE_MS = 5000;

function positiveInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function nonNegativeInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Bridge deadlines. `upstream` is the bridge's own budget for one CPU
 * prefill (local-llm-bridge.js uses the same value); `timeout` is what the
 * gateway waits, deliberately larger so the bridge's real error wins the
 * race instead of a bare gateway timeout.
 */
function resolveBridgeTimeouts(env) {
  const source = env || process.env;
  const upstream =
    positiveInt(source.BRIDGE_TIMEOUT_MS) || DEFAULT_BRIDGE_TIMEOUT_MS;
  const explicitGrace = nonNegativeInt(source.BRIDGE_TIMEOUT_GRACE_MS);
  const grace =
    explicitGrace === undefined ? DEFAULT_BRIDGE_GRACE_MS : explicitGrace;
  const timeout = upstream + grace;
  return { upstream, grace, timeout, streamTimeout: timeout };
}

/**
 * Resolve the request and stream deadlines for one provider id.
 * Always returns positive numbers; invalid env values are ignored rather
 * than forwarded to Node (undefined timeout silently became 5s on Node 24).
 */
function resolveProviderTimeouts(providerId, env) {
  const source = env || process.env;
  const id = String(providerId || "").toLowerCase();

  if (id === "bridge") {
    const bridge = resolveBridgeTimeouts(source);
    return { timeout: bridge.timeout, streamTimeout: bridge.streamTimeout };
  }

  const prefix = id.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const specificTimeout = prefix
    ? positiveInt(source[prefix + "_TIMEOUT_MS"])
    : undefined;
  const specificStream = prefix
    ? positiveInt(source[prefix + "_STREAM_TIMEOUT_MS"])
    : undefined;

  const timeout =
    specificTimeout ||
    positiveInt(source.PROVIDER_TIMEOUT_MS) ||
    DEFAULT_PROVIDER_TIMEOUT_MS;
  const streamTimeout =
    specificStream ||
    positiveInt(source.PROVIDER_STREAM_TIMEOUT_MS) ||
    timeout;

  return { timeout, streamTimeout };
}

module.exports = {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  DEFAULT_BRIDGE_GRACE_MS,
  resolveProviderTimeouts,
  resolveBridgeTimeouts,
};
