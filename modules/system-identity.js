"use strict";

/**
 * modules/system-identity.js — the immutable identity core.
 *
 * `identity.json` at the project root is the single source of truth for the
 * system name, owner, tagline, contact data, license and the exact identity
 * sentence every agent must be able to say. The file is meant to be read-only
 * (no write bits); this module only reads it, validates it, and deep-freezes
 * the parsed result so no caller can mutate it at runtime.
 *
 * Nothing here performs network I/O and nothing depends on the database.
 */

const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.resolve(__dirname, "..", "identity.json");

const REQUIRED_PATHS = [
  "name",
  "product",
  "version",
  "tagline",
  "branding.owner",
  "branding.organization",
  "branding.address",
  "branding.location",
  "contact.email",
  "contact.website",
  "license",
  "identity_anchor",
];

function readPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function identityPath(file) {
  return path.resolve(file || process.env.ZC_IDENTITY_PATH || DEFAULT_PATH);
}

/** True when the identity file carries no write bit for anyone. */
function isReadOnly(file) {
  try {
    const stat = fs.statSync(identityPath(file));
    return (stat.mode & 0o222) === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Parse + validate one identity file. Returns a deep-frozen
 * `system_identity` object. Throws with a precise message on bad input.
 */
function loadIdentity(file) {
  const resolved = identityPath(file);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (e) {
    throw new Error("identity.json unreadable (" + resolved + "): " + e.message);
  }
  const identity = parsed && parsed.system_identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("identity.json: missing object system_identity");
  }
  const missing = REQUIRED_PATHS.filter((key) => !clean(readPath(identity, key)));
  if (missing.length > 0) {
    throw new Error("identity.json: missing fields " + missing.join(", "));
  }
  return deepFreeze(identity);
}

let _cachedFile = null;
let _cachedIdentity = null;

/** Cached identity for the current process (file contents are immutable). */
function getIdentity(file) {
  const resolved = identityPath(file);
  if (_cachedIdentity && _cachedFile === resolved) return _cachedIdentity;
  _cachedIdentity = loadIdentity(resolved);
  _cachedFile = resolved;
  return _cachedIdentity;
}

/** Exact sentence an agent must say when asked who it is. */
function identityAnchor(identity) {
  return clean((identity || getIdentity()).identity_anchor);
}

/** Compact metadata injected into every session's metadata object. */
function identityMetadata(identity) {
  const i = identity || getIdentity();
  return {
    name: i.name,
    product: i.product,
    version: i.version,
    owner: i.branding.owner,
    organization: i.branding.organization,
    license: i.license,
    source: "identity.json",
  };
}

/** Shape consumed by modules/system-prompt.js identityBlock(). */
function identityPromptBlock(identity) {
  const i = identity || getIdentity();
  return {
    name: i.name,
    product: i.product,
    version: i.version,
    tagline: i.tagline,
    owner: i.branding.owner,
    organization: i.branding.organization,
    address: i.branding.address,
    location: i.branding.location,
    email: i.contact.email,
    website: i.contact.website,
    license: i.license,
    anchor: i.identity_anchor,
  };
}

/**
 * Ownership headers attached to every HTTP response.
 * Derived from identity.json so the file stays the single source of truth.
 */
function identityHeaders(identity) {
  const i = identity || getIdentity();
  const product = clean(i.product) || "ZombieCoder";
  const owner = clean(i.branding.owner);
  return {
    "X-Powered-By": product + "-by-" + owner.replace(/\s+/g, ""),
    "X-System-Identity": product,
    "X-System-Owner": owner,
  };
}

module.exports = {
  DEFAULT_PATH,
  identityPath,
  isReadOnly,
  loadIdentity,
  getIdentity,
  identityAnchor,
  identityMetadata,
  identityPromptBlock,
  identityHeaders,
};
