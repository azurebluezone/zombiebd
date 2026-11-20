"use strict";
// ─── provider/transport.js ────────────────────────────────────────────
// Shared HTTP layer used by every provider adapter.
//
// All four official APIs speak HTTP + JSON, three of them stream SSE:
//   OpenAI  POST /chat/completions        data: {json}\n\n ... data: [DONE]
//   Groq    POST /chat/completions        data: {json}\n\n ... data: [DONE]
//   Ollama  POST /api/chat                NDJSON lines (no "data:" prefix)
//   Gemini  POST /models/{m}:streamGenerateContent?alt=sse   data: {json}
//
// Transport policy (kept out of api.js so the API server stays thin):
//   • https://  → HTTP/2, falling back to HTTP/1.1
//   • http://   → HTTP/1.1
//   • UDS socketPath → HTTP/1.1 over the unix domain socket
//
// Docs:
//   https://platform.openai.com/docs/api-reference/chat
//   https://console.groq.com/docs/api-reference
//   https://docs.ollama.com/api/chat
//   https://ai.google.dev/api/generate-content

const http = require("http");
const https = require("https");
const http2 = require("http2");
const { resolveProviderTimeouts } = require("../lib/provider-timeout");
const sizeBudget = require("../lib/size-budget");

// cfg.timeout / cfg.streamTimeout always win; when a caller omits them the
// single resolver supplies the same deadline for JSON and stream. No numeric
// default lives here — a stale 60s/300s pair hid the bridge mismatch.
function fallbackTimeouts() {
  return resolveProviderTimeouts("", process.env);
}

// ─── Frame-size guard ─────────────────────────────────────────────────
// One knob for every body we buffer: a single response body (non-stream)
// and a single SSE/NDJSON frame (stream) may not exceed this many bytes.
// Overflow destroys the request and rejects with FRAME_TOO_LARGE so the
// fallback chain runs instead of the process ballooning in memory.
// The default lives in lib/env.js; MAX_FRAME_BYTES overrides it.
const MAX_FRAME_BYTES = sizeBudget.limit("MAX_FRAME_BYTES");
const FRAME_TOO_LARGE = "provider frame exceeds MAX_FRAME_BYTES";

// ─── Single JSON request ──────────────────────────────────────────────
// Returns { statusCode, headers, body } where body is the raw string.
// Never throws on HTTP status — the caller decides fallback policy.
function request(cfg, target, body) {
  cfg = cfg || {};
  const url = new URL(target);
  const useSocket = !!cfg.socketPath;
  const method = String(cfg.method || "POST").toUpperCase();

  const options = {
    method: method,
    timeout: cfg.timeout || fallbackTimeouts().timeout,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      cfg.headers || {},
    ),
  };

  if (useSocket) {
    options.socketPath = cfg.socketPath;
    options.path = url.pathname + url.search;
    options.hostname = "localhost";
  } else {
    options.hostname = url.hostname;
    options.port = url.port || (url.protocol === "https:" ? 443 : 80);
    options.path = url.pathname + url.search;
  }

  const payload =
    method === "GET" || method === "HEAD"
      ? ""
      : typeof body === "string"
        ? body
        : JSON.stringify(body || {});

  // HTTP/2 only for cleartext-secure (https) direct connections.
  if (!useSocket && url.protocol === "https:") {
    return http2Request(url, options, payload).catch(function (h2Err) {
      // HTTP/2 failed → fall back to HTTP/1.1 rather than dropping the call.
      return rawRequest(https, options, payload);
    });
  }
  const proto = url.protocol === "https:" ? https : http;
  return rawRequest(proto, options, payload);
}

function rawRequest(proto, options, payload) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    let total = 0;
    const req = proto.request(options, function (res) {
      const chunks = [];
      res.on("data", function (c) {
        total += c.length;
        if (total > MAX_FRAME_BYTES) {
          if (!settled) {
            settled = true;
            req.destroy();
            reject(new Error(FRAME_TOO_LARGE));
          }
          return;
        }
        chunks.push(c);
      });
      res.on("end", function () {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", function (e) {
      if (!settled) { settled = true; reject(e); }
    });
    req.on("timeout", function () {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("request timeout"));
    });
    req.end(payload);
  });
}

function http2Request(url, options, payload) {
  return new Promise(function (resolve, reject) {
    const client = http2.connect(url.origin, {
      // Reject self-signed / mismatched certs rather than silently trusting.
      rejectUnauthorized: true,
    });
    let settled = false;
    const done = function (fn, arg) {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (e) { /* already closed */ }
      fn(arg);
    };
    client.on("error", function (e) { done(reject, e); });
    const headers = {
      ":method": options.method || "POST",
      ":path": url.pathname + url.search,
      "content-type": options.headers["Content-Type"] || "application/json",
    };
    for (const k of Object.keys(options.headers)) {
      if (k === "Content-Type") continue;
      headers[k] = options.headers[k];
    }
    const req = client.request(headers);
    const chunks = [];
    let status = 200;
    let total = 0;
    req.on("response", function (h) { status = h[":status"]; });
    req.on("data", function (c) {
      total += c.length;
      if (total > MAX_FRAME_BYTES) {
        done(reject, new Error(FRAME_TOO_LARGE));
        try { req.close(); } catch (e) { /* already closed */ }
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      done(resolve, {
        statusCode: status,
        headers: {},
        body: Buffer.concat(chunks).toString("utf8"),
      });
    });
    req.on("error", function (e) { done(reject, e); });
    req.setTimeout(options.timeout || fallbackTimeouts().timeout, function () {
      req.close();
      done(reject, new Error("request timeout"));
    });
    req.end(payload);
  });
}

// ─── Streaming request ────────────────────────────────────────────────
// Calls onLine(rawLine) for every decoded line of the response body.
//   • SSE endpoints: onLine receives the payload AFTER "data: " is stripped,
//     and "[DONE]" markers are never delivered.
//   • NDJSON endpoints (Ollama /api/chat): onLine receives each raw line.
// Options:
//   sse:true        → strip "data: " prefix, drop [DONE]  (OpenAI/Groq/Gemini)
//   ndjson:true     → deliver raw lines                   (Ollama)
// Resolves { statusCode, headers, text } — text is the full body so callers
// can still parse it if the stream turned out to be an error JSON.
function stream(cfg, target, body, onLine, opts) {
  opts = opts || {};
  const url = new URL(target);
  const useSocket = !!cfg.socketPath;
  const timeout = cfg.streamTimeout || fallbackTimeouts().streamTimeout;

  const options = {
    method: "POST",
    timeout,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=utf-8",
        Accept: opts.sse ? "text/event-stream" : "application/json, text/event-stream",
      },
      cfg.headers || {},
    ),
  };
  if (useSocket) {
    options.socketPath = cfg.socketPath;
    options.path = url.pathname + url.search;
    options.hostname = "localhost";
  } else {
    options.hostname = url.hostname;
    options.port = url.port || (url.protocol === "https:" ? 443 : 80);
    options.path = url.pathname + url.search;
  }

  const proto = url.protocol === "https:" ? https : http;
  const payload = typeof body === "string" ? body : JSON.stringify(body || {});

  return new Promise(function (resolve, reject) {
    let settled = false;
    const req = proto.request(options, function (res) {
      let buf = "";
      let full = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        if (settled) return;
        // Frame-size guard: neither the partial line buffer nor the whole
        // body may exceed MAX_FRAME_BYTES. Overflow destroys the stream so
        // the caller's fallback chain runs (memory stays bounded).
        if (buf.length + chunk.length > MAX_FRAME_BYTES ||
            full.length + chunk.length > MAX_FRAME_BYTES) {
          settled = true;
          req.destroy();
          reject(new Error(FRAME_TOO_LARGE));
          return;
        }
        full += chunk;
        buf += chunk;
        let nl;
        // Split on newline; keep the trailing partial line in buf.
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let payloadLine = line;
          if (opts.sse) {
            if (line.indexOf("data:") === 0) payloadLine = line.slice(5).trim();
            else continue;                    // event:/id:/retry: comments
            if (payloadLine === "[DONE]") continue;
          }
          try { onLine(payloadLine); } catch (e) { /* one bad frame must not kill the stream */ }
        }
      });
      res.on("end", function () {
        if (settled) return;
        // Flush any trailing frame.
        if (buf.trim()) {
          let payloadLine = buf.trim();
          if (opts.sse && payloadLine.indexOf("data:") === 0) {
            payloadLine = payloadLine.slice(5).trim();
            if (payloadLine === "[DONE]") payloadLine = "";
          }
          if (payloadLine && payloadLine !== "[DONE]") {
            try { onLine(opts.sse ? payloadLine : buf.trim()); } catch (e) { /* ignore */ }
          }
        }
        settled = true;
        resolve({ statusCode: res.statusCode, headers: res.headers, text: full });
      });
    });
    req.on("error", function (e) {
      if (!settled) { settled = true; reject(e); }
    });
    req.on("timeout", function () {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error("stream timeout"));
    });
    req.end(payload);
  });
}

// ─── Error extraction ─────────────────────────────────────────────────
// Providers disagree on error shape; normalise all of them to a message.
function errorMessage(statusCode, rawBody) {
  let msg = "HTTP " + statusCode;
  if (!rawBody) return msg;
  try {
    const j = JSON.parse(rawBody);
    if (typeof j === "string") return j;
    // OpenAI / Groq / Ollama: {error:{message}}   Gemini: {error:{message}}
    const e = j.error;
    if (e) {
      if (typeof e === "string") return e;
      if (e.message) return e.message;
    }
    if (j.message) return j.message;
    if (j.error_message) return j.error_message;
  } catch (parseErr) { /* body wasn't JSON */ }
  return msg;
}

module.exports = {
  request,
  stream,
  errorMessage,
  MAX_FRAME_BYTES,
  FRAME_TOO_LARGE,
};
