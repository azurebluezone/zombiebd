"use strict";

/**
 * lib/secret-store.js - encrypt provider API keys at rest.
 *
 * WHY
 *   keys live in SQLite (`providers.api_key`). A DB copy, backup or dump must
 *   not expose them, so plaintext is never written. The AES key stays in a
 *   separate 0600 file next to the DB and never inside the DB itself.
 *
 * FAIL CLOSED
 *   If no key file and no ADMIN_TOKEN fallback exist, encryptSecret throws.
 *   The API layer then refuses to persist the key instead of silently
 *   storing it in plaintext.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { resolveRuntimePaths } = require("./env");

const PREFIX = "enc:v1:";
let cachedKey = null;
let cachedFile = "";
let configuredFile = "";

function configure(filePath) {
  if (!filePath) return;
  const next = path.resolve(filePath);
  if (next !== configuredFile) {
    configuredFile = next;
    cachedKey = null;
    cachedFile = "";
  }
}

function keyFile() {
  if (process.env.PROVIDER_KEY_FILE) {
    return path.resolve(process.env.PROVIDER_KEY_FILE);
  }
  if (configuredFile) return configuredFile;
  const dbPath = resolveRuntimePaths(process.env).dbPath;
  return path.join(path.dirname(dbPath), ".provider-keys.key");
}

function loadKey() {
  const file = keyFile();
  if (cachedKey && cachedFile === file) return cachedKey;
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file);
      if (raw.length >= 32) {
        cachedKey = crypto.createHash("sha256").update(raw).digest();
        cachedFile = file;
        return cachedKey;
      }
    }
    const secret = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      /* a restrictive umask already covered it */
    }
    cachedKey = crypto.createHash("sha256").update(secret).digest();
    cachedFile = file;
    return cachedKey;
  } catch (error) {
    // Last-resort fallback: derive from ADMIN_TOKEN so a read-only data dir
    // still encrypts instead of writing plaintext. Rotating ADMIN_TOKEN then
    // makes old keys undecryptable, which falls back to env by design.
    if (process.env.ADMIN_TOKEN) {
      cachedKey = crypto
        .createHash("sha256")
        .update("zombiecoder-provider-key:" + process.env.ADMIN_TOKEN)
        .digest();
      cachedFile = file;
      return cachedKey;
    }
    throw new Error("provider key store unavailable: " + error.message);
  }
}

function encryptSecret(plain) {
  const text = String(plain == null ? "" : plain);
  if (!text) return "";
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    PREFIX +
    [iv, tag, data].map((buf) => buf.toString("base64url")).join(":")
  );
}

function decryptSecret(stored) {
  const text = String(stored == null ? "" : stored);
  if (!text) return "";
  // Rows written before this module are plaintext. Keep them readable; the
  // next successful save rewrites them encrypted.
  if (!text.startsWith(PREFIX)) return text;
  try {
    const parts = text.slice(PREFIX.length).split(":");
    if (parts.length !== 3) return "";
    const key = loadKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(parts[0], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (_) {
    return "";
  }
}

module.exports = {
  configure,
  keyFile,
  encryptSecret,
  decryptSecret,
};
