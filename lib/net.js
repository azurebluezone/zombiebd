"use strict";

/**
 * lib/net.js — one loopback definition for every caller.
 *
 * The copies had drifted:
 *   lib/env.js       new Set(["localhost", "::1", "localhost"])
 *   local-llm-bridge u.hostname === "localhost" || u.hostname === "localhost"
 * Both missed 127.0.0.1, so an upstream on http://127.0.0.1:5050 — the
 * gateway that calls the bridge — could be probed and proxied into a loop.
 *
 * URL.hostname keeps the brackets on IPv6 ([::1]); both spellings are listed
 * so a configured URL and a bind address resolve to the same answer.
 */

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
]);

function normalizeHost(host) {
  return String(host == null ? "" : host)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  // The whole 127/8 block is loopback, not only 127.0.0.1. The rule lives
  // here so callers never grow a private copy of this regex again.
  return (
    LOOPBACK_HOSTS.has(normalized) || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function portOf(url, fallback) {
  if (url.port) return Number(url.port);
  if (url.protocol === "https:") return 443;
  if (url.protocol === "http:") return 80;
  return fallback == null ? 0 : Number(fallback);
}

/**
 * True when a URL points at a loopback host on one of this process's own
 * ports. Non-loopback hosts are never self-references, even on the same port.
 */
function isSelfReference(rawUrl, selfPorts) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (_) {
    return false;
  }
  if (!isLoopbackHost(url.hostname)) return false;
  const ports = selfPorts instanceof Set ? selfPorts : new Set(selfPorts || []);
  return ports.has(portOf(url));
}

/**
 * Dedupe key for an upstream. Loopback aliases on the same port and path are
 * the same server, so localhost:11434 and 127.0.0.1:11434 must not be probed
 * twice and reported as two upstreams.
 */
function upstreamKey(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch (_) {
    return String(rawUrl || "");
  }
  const host = isLoopbackHost(url.hostname)
    ? "loopback"
    : normalizeHost(url.hostname);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return url.protocol + "//" + host + ":" + portOf(url) + path;
}

module.exports = {
  LOOPBACK_HOSTS,
  normalizeHost,
  isLoopbackHost,
  isSelfReference,
  upstreamKey,
};
