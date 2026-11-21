"use strict";

/**
 * Panel-session cookie for the admin panel.
 *
 * The panel route mints a token and sets it as an HttpOnly cookie. Every
 * admin GET/POST/OPTIONS/PUT/DELETE must carry a live token in addition to
 * the ADMIN_TOKEN, so a token alone cannot drive the admin API from outside
 * the panel. The store is in-memory: a restart drops every session and the
 * next panel load mints a new one.
 */

const crypto = require("crypto");

const COOKIE_NAME = "zc_panel";
const TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

function readCookie(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return "";
}

function create() {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (now > expiresAt) sessions.delete(token);
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, now + TTL_MS);
  return token;
}

function verify(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + TTL_MS);
  return true;
}

function cookie(token) {
  return (
    COOKIE_NAME +
    "=" +
    token +
    "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" +
    Math.floor(TTL_MS / 1000)
  );
}

module.exports = { COOKIE_NAME, create, verify, cookie };
