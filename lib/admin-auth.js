"use strict";

/**
 * lib/admin-auth.js — the admin credential policy in one testable place.
 *
 * Two rules that used to be inline in api.js:
 *   1. ADMIN_ALLOW_UNAUTHENTICATED is a development escape hatch only. It is
 *      ignored when the process declares itself production (NODE_ENV or
 *      SERVER_TYPE=production), so a copied .env cannot open the admin API.
 *   2. Every token comparison is constant-time; the first compare is no longer
 *      a plain `===` that returns before the hash compare.
 */

const crypto = require("crypto");

function digest(value) {
  return crypto.createHash("sha256").update(String(value == null ? "" : value)).digest();
}

/** Constant-time compare for two token strings (including empty strings). */
function constantTimeEqual(provided, expected) {
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

function isProductionRuntime(env) {
  const source = env || process.env;
  const nodeEnv = String(source.NODE_ENV || "").trim().toLowerCase();
  const serverType = String(source.SERVER_TYPE || "").trim().toLowerCase();
  return nodeEnv === "production" || serverType === "production";
}

/**
 * True only when the operator explicitly opted out AND this is not a
 * production process. Production never fails open, even with the flag set.
 */
function allowUnauthenticated(env) {
  const source = env || process.env;
  if (String(source.ADMIN_ALLOW_UNAUTHENTICATED || "").toLowerCase() !== "true") return false;
  return !isProductionRuntime(source);
}

/** Cookie Secure flag: explicit override, TLS socket, or a trusted proxy header. */
function requestIsSecure(req, env) {
  const source = env || process.env;
  const override = String(source.ADMIN_COOKIE_SECURE || "").toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  if (req && req.socket && req.socket.encrypted) return true;
  const forwarded = String((req && req.headers && req.headers["x-forwarded-proto"]) || "")
    .split(",")[0].trim().toLowerCase();
  return forwarded === "https";
}

module.exports = {
  constantTimeEqual,
  isProductionRuntime,
  allowUnauthenticated,
  requestIsSecure,
};
