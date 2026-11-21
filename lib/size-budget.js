"use strict";

/**
 * lib/size-budget.js — the one helper for every bounded payload.
 *
 * lib/env.js owns the defaults and validation; this module turns a key into
 * an effective limit and applies it. Callers log BUDGET_EXCEEDED with the
 * returned numbers instead of silently slicing.
 *
 * Rules:
 *   - bytes mean UTF-8 bytes, never String.length.
 *   - a limit read from process.env wins; invalid/<=0 falls back to DEFAULTS.
 *   - truncation is explicit: capText appends a marker naming the key.
 */

const { DEFAULTS } = require("./env.js");

const KEYS = Object.freeze({
  MAX_BODY_SIZE: Number(DEFAULTS.MAX_BODY_SIZE),
  ATTACHMENT_MAX_BYTES: Number(DEFAULTS.ATTACHMENT_MAX_BYTES),
  MAX_HISTORY: Number(DEFAULTS.MAX_HISTORY),
  MAX_HISTORY_CHARS: Number(DEFAULTS.MAX_HISTORY_CHARS),
  SESSION_MAX_BYTES: Number(DEFAULTS.SESSION_MAX_BYTES),
  WEB_UI_MAX_BYTES: Number(DEFAULTS.WEB_UI_MAX_BYTES),
  MAX_FRAME_BYTES: Number(DEFAULTS.MAX_FRAME_BYTES),
  TOOL_RESULT_MAX_BYTES: Number(DEFAULTS.TOOL_RESULT_MAX_BYTES),
});

function limit(key) {
  const fallback = KEYS[key];
  if (!Number.isFinite(fallback)) {
    throw new Error("unknown size budget key: " + key);
  }
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function byteLength(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text == null ? "" : text, "utf8");
}

/**
 * Cap one text value to `key`. The marker is part of the returned text so a
 * model (and the log reader) can see that the value was shortened.
 */
function capText(text, key) {
  const budgetKey = key || "TOOL_RESULT_MAX_BYTES";
  const max = limit(budgetKey);
  const source = typeof text === "string" ? text : JSON.stringify(text);
  const value = source == null ? "" : source;
  const bytes = byteLength(value);
  if (bytes <= max) {
    return { text: value, bytes, limit: max, truncated: false };
  }

  const marker = "\n[truncated: " + budgetKey + "=" + max + " actual=" + bytes + "]";
  const markerBytes = byteLength(marker);
  if (markerBytes >= max) {
    return { text: marker, bytes, limit: max, truncated: true };
  }

  // Buffer.subarray can split a multi-byte character; drop the replacement
  // character it produces instead of returning mojibake.
  const keep = max - markerBytes;
  let head = Buffer.from(value, "utf8").subarray(0, keep).toString("utf8");
  if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
  const out = head + marker;
  return { text: out, bytes, limit: max, truncated: true, keptBytes: byteLength(out) };
}

/**
 * Keep a message list under `key` bytes: system messages stay, the oldest
 * non-system messages are dropped until the budget fits (the newest message
 * is never dropped). Returns a new array.
 */
function trimMessages(messages, key) {
  const budgetKey = key || "SESSION_MAX_BYTES";
  const max = limit(budgetKey);
  const input = Array.isArray(messages) ? messages : [];
  const system = input.filter((m) => m && m.role === "system");
  const rest = input.filter((m) => !m || m.role !== "system");
  const current = () => system.concat(rest);
  const bytes = byteLength(current());
  if (bytes <= max) {
    return { messages: current(), bytes, limit: max, dropped: 0 };
  }

  let dropped = 0;
  while (rest.length > 1 && byteLength(system.concat(rest)) > max) {
    rest.shift();
    dropped += 1;
  }
  const out = system.concat(rest);
  return { messages: out, bytes: byteLength(out), limit: max, dropped };
}

/**
 * Serialize one SSE event and report whether it fits the web-UI budget.
 * The caller decides how to surface an overflow (never a silent write).
 */
function ssePayload(chunk, key) {
  const budgetKey = key || "WEB_UI_MAX_BYTES";
  const max = limit(budgetKey);
  const payload = "data: " + JSON.stringify(chunk) + "\n\n";
  const bytes = byteLength(payload);
  return { payload, bytes, limit: max, tooLarge: bytes > max };
}

function config() {
  const out = {};
  for (const key of Object.keys(KEYS)) out[key] = limit(key);
  return out;
}

module.exports = {
  KEYS,
  config,
  limit,
  byteLength,
  capText,
  trimMessages,
  ssePayload,
};
