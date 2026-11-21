"use strict";

/**
 * modules/chat-upload.js — bounded chat attachments.
 *
 * One module owns validation, storage and the provider content parts:
 *   - documents (text/markdown/csv/json) become a bounded text part;
 *   - photos (png/jpeg/webp/gif) become an OpenAI `image_url` data URI;
 *   - audio (mpeg/wav/ogg) becomes an OpenAI `input_audio` part.
 *
 * Files live under `<root>/.zombie/uploads/<sha256>.<ext>`; identical bytes
 * are stored once. Nothing here calls a model or writes outside `.zombie/`.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_ATTACHMENTS = 4;
const TEXT_MAX_BYTES = 65536;
const MAX_NAME_CHARS = 120;

const EXT_TYPES = Object.freeze({
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
});

const TYPES = Object.freeze({
  "text/plain": Object.freeze({ kind: "document", ext: ".txt" }),
  "text/markdown": Object.freeze({ kind: "document", ext: ".md" }),
  "text/csv": Object.freeze({ kind: "document", ext: ".csv" }),
  "application/json": Object.freeze({ kind: "document", ext: ".json" }),
  "image/png": Object.freeze({ kind: "image", ext: ".png" }),
  "image/jpeg": Object.freeze({ kind: "image", ext: ".jpg" }),
  "image/webp": Object.freeze({ kind: "image", ext: ".webp" }),
  "image/gif": Object.freeze({ kind: "image", ext: ".gif" }),
  "audio/mpeg": Object.freeze({ kind: "audio", ext: ".mp3", format: "mp3" }),
  "audio/wav": Object.freeze({ kind: "audio", ext: ".wav", format: "wav" }),
  "audio/x-wav": Object.freeze({ kind: "audio", ext: ".wav", format: "wav" }),
  "audio/ogg": Object.freeze({ kind: "audio", ext: ".ogg", format: "ogg" }),
});

class AttachmentError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
    this.status = status || 400;
  }
}

function normalizeMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function classify(mime) {
  return TYPES[normalizeMime(mime)] || null;
}

/** Browsers send application/octet-stream for unknown extensions; use the
 * file name as the fallback so .md/.csv/.mp3 still classify correctly. */
function inferMime(name, mime) {
  const declared = normalizeMime(mime);
  if (declared && declared !== "application/octet-stream") return declared;
  const ext = path.extname(String(name || "")).toLowerCase();
  return EXT_TYPES[ext] || declared;
}

function sanitizeName(value) {
  const base = path.basename(String(value || "").replace(/\\/g, "/"));
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  return (clean || "attachment").slice(0, MAX_NAME_CHARS);
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function uploadsDir(root) {
  return path.join(path.resolve(root), ".zombie", "uploads");
}

function sidecarFor(root, id) {
  return path.join(uploadsDir(root), id + ".json");
}

function fileFor(root, id, ext) {
  return path.join(uploadsDir(root), id + ext);
}

function readSidecar(root, id) {
  try {
    const parsed = JSON.parse(fs.readFileSync(sidecarFor(root, id), "utf8"));
    if (!parsed || parsed.id !== id) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Validate and store one upload. Throws AttachmentError with a stable code:
 *   ATTACHMENT_TYPE (415), ATTACHMENT_TOO_LARGE (413), ATTACHMENT_EMPTY (400).
 */
function saveUpload(input) {
  const opts = input || {};
  const root = String(opts.root || "").trim();
  if (!root) {
    throw new AttachmentError("ATTACHMENT_ROOT", "upload root is required");
  }
  const mime = inferMime(opts.name, opts.mime);
  const type = classify(mime);
  if (!type) {
    throw new AttachmentError(
      "ATTACHMENT_TYPE",
      "unsupported attachment type: " + (mime || "unknown"),
      415,
    );
  }
  const data = Buffer.isBuffer(opts.data)
    ? opts.data
    : Buffer.from(opts.data || []);
  if (!data.length) {
    throw new AttachmentError("ATTACHMENT_EMPTY", "attachment is empty", 400);
  }
  const maxBytes =
    Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 10 * 1024 * 1024;
  if (data.length > maxBytes) {
    throw new AttachmentError(
      "ATTACHMENT_TOO_LARGE",
      "attachment is " + data.length + " bytes; limit is " + maxBytes,
      413,
    );
  }

  const id = sha256(data);
  const name = sanitizeName(opts.name);
  const dir = uploadsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(root, id, type.ext);
  let deduped = true;
  if (!fs.existsSync(file)) {
    deduped = false;
    fs.writeFileSync(file, data, { flag: "wx" });
  }
  const meta = {
    id,
    sha256: id,
    name,
    mime,
    kind: type.kind,
    bytes: data.length,
    ext: type.ext,
    createdAt: new Date().toISOString(),
  };
  const sidecar = sidecarFor(root, id);
  if (!fs.existsSync(sidecar)) {
    fs.writeFileSync(sidecar, JSON.stringify(meta, null, 2), "utf8");
  }
  return Object.assign({}, meta, { deduped, path: file });
}

function assertId(id) {
  const value = String(id || "");
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AttachmentError("ATTACHMENT_ID", "invalid attachment id", 400);
  }
  return value;
}

/** Load one stored upload, including its bytes. Throws ATTACHMENT_NOT_FOUND. */
function loadUpload(root, id) {
  const safe = assertId(id);
  const meta = readSidecar(root, safe);
  if (!meta) {
    throw new AttachmentError(
      "ATTACHMENT_NOT_FOUND",
      "attachment not found",
      404,
    );
  }
  const file = fileFor(root, safe, meta.ext);
  let data;
  try {
    data = fs.readFileSync(file);
  } catch (_) {
    throw new AttachmentError(
      "ATTACHMENT_NOT_FOUND",
      "attachment file missing",
      404,
    );
  }
  return Object.assign({}, meta, { data, path: file });
}

/** Resolve a request's attachment ids in order; duplicates are kept once. */
function resolveAttachments(root, ids) {
  const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
  if (list.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(
      "ATTACHMENT_LIMIT",
      "at most " + MAX_ATTACHMENTS + " attachments per request",
      400,
    );
  }
  const seen = new Set();
  const out = [];
  for (const id of list) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(loadUpload(root, id));
  }
  return out;
}

function textPart(upload) {
  const raw = upload.data.toString("utf8");
  const bytes = Buffer.byteLength(raw, "utf8");
  let text = raw;
  if (bytes > TEXT_MAX_BYTES) {
    const marker =
      "\n[attachment truncated: ATTACHMENT_TEXT_MAX_BYTES=" +
      TEXT_MAX_BYTES +
      " actual=" +
      bytes +
      "]";
    const keep = Math.max(
      0,
      TEXT_MAX_BYTES - Buffer.byteLength(marker, "utf8"),
    );
    let head = Buffer.from(raw, "utf8").subarray(0, keep).toString("utf8");
    if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
    text = head + marker;
  }
  return {
    type: "text",
    text: "[Attachment: " + upload.name + "]\n" + text,
  };
}

function imagePart(upload) {
  return {
    type: "image_url",
    image_url: {
      url:
        "data:" +
        upload.mime +
        ";base64," +
        upload.data.toString("base64"),
    },
  };
}

function audioPart(upload) {
  const type = classify(upload.mime);
  const format = (type && type.format) || "mp3";
  return {
    type: "input_audio",
    input_audio: { data: upload.data.toString("base64"), format },
  };
}

/** Build the provider content parts for already-loaded uploads. */
function buildAttachmentParts(uploads) {
  const parts = [];
  for (const upload of Array.isArray(uploads) ? uploads : []) {
    if (!upload) continue;
    if (upload.kind === "document") parts.push(textPart(upload));
    else if (upload.kind === "image") parts.push(imagePart(upload));
    else if (upload.kind === "audio") parts.push(audioPart(upload));
  }
  return parts;
}

/**
 * Mission mode is text-only: documents become prompt text, while photo/audio
 * is rejected with a stable code so the UI can point at Single Agent mode.
 */
function missionText(uploads) {
  const list = Array.isArray(uploads) ? uploads : [];
  for (const upload of list) {
    if (upload && upload.kind !== "document") {
      throw new AttachmentError(
        "ATTACHMENT_SINGLE_AGENT_ONLY",
        "mission mode accepts documents only; use Single Agent for photo/audio",
        400,
      );
    }
  }
  return list
    .filter((upload) => upload && upload.kind === "document")
    .map((upload) => textPart(upload).text)
    .join("\n\n");
}

module.exports = {
  AttachmentError,
  MAX_ATTACHMENTS,
  TEXT_MAX_BYTES,
  TYPES,
  classify,
  sanitizeName,
  uploadsDir,
  saveUpload,
  loadUpload,
  resolveAttachments,
  buildAttachmentParts,
  missionText,
};
