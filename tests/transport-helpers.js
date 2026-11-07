"use strict";

/*
 * Shared clients for the live transport audit. Every helper returns data,
 * never assertions, so the runner can report one named check per transport.
 */

const crypto = require("crypto");
const net = require("net");
const http = require("http");
const https = require("https");
const http2 = require("http2");
const path = require("path");
const { spawn } = require("child_process");
const { loadEnv } = require("../lib/env.js");
const {
  encodeChatRequest,
  decodeChatResponse,
  frame,
  unframe,
} = require(path.join(__dirname, "..", "transport", "protobuf"));

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const PORTS = ENV.ports;
const MAIN_HOST = ENV.derived.mainHost || "localhost";
const UDS_MCP = ENV.derived.udsPath || "/tmp/zombiecoder/mcp.sock";
const UDS_OPENAI = UDS_MCP;

// Canonically equivalent Bengali forms plus zero-width controls. The
// normalizer must produce one NFC form and must not corrupt any of them.
const BENGALI = {
  // Joynal: U+09DF (precomposed) and ya + nukta (decomposed). NFC resolves
  // both to the decomposed sequence because U+09DF is a composition exclusion.
  composed: "\u099C\u09DF\u09A8\u09BE\u09B2",
  decomposed: "\u099C\u09AF\u09BC\u09A8\u09BE\u09B2",
  canonical: "\u099C\u09AF\u09BC\u09A8\u09BE\u09B2",
  rraComposed: "\u09DC", // \u09a1\u09bc
  rraDecomposed: "\u09A1\u09BC",
  rhaComposed: "\u09DD", // \u09a2\u09bc
  rhaDecomposed: "\u09A2\u09BC",
  zwnj: "\u0995\u200C\u09B7",
  zwj: "\u0995\u200D\u09B7",
  zwsp: "\u0995\u200B\u09B7",
  astral: "\u{1D54F}",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawRequest(isHttps, options, body) {
  return new Promise((resolve) => {
    const mod = isHttps ? https : http;
    const payload = body === undefined ? null : Buffer.from(body, "utf8");
    const opts = Object.assign({ hostname: "127.0.0.1", timeout: 30000 }, options);
    if (payload) {
      opts.headers = Object.assign({}, options.headers, {
        "Content-Length": payload.length,
      });
    }
    if (isHttps) {
      opts.servername = options.servername || MAIN_HOST;
      opts.rejectUnauthorized = false;
    }
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text: buffer.toString("utf8"),
        });
      });
    });
    req.on("error", (err) => resolve({ status: 0, headers: {}, buffer: Buffer.alloc(0), text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, buffer: Buffer.alloc(0), text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function httpJson(pathname, method, body, headers) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return rawRequest(false, {
    port: PORTS.api,
    path: pathname,
    method: method || "GET",
    headers: Object.assign({ Accept: "application/json" }, headers),
    timeout: 60000,
  }, payload).then((res) => {
    let json = null;
    try { json = JSON.parse(res.text); } catch (_) {}
    return Object.assign(res, { json });
  });
}

function httpsJson(pathname, method, body, headers) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return rawRequest(true, {
    port: PORTS.caddy_https || 443,
    path: pathname,
    method: method || "GET",
    servername: MAIN_HOST,
    headers: Object.assign({ Host: MAIN_HOST, Accept: "application/json" }, headers),
    timeout: 60000,
  }, payload).then((res) => {
    let json = null;
    try { json = JSON.parse(res.text); } catch (_) {}
    return Object.assign(res, { json });
  });
}

function udsHttp(pathname, method, body) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request({
      socketPath: UDS_OPENAI,
      path: pathname,
      method: method || "GET",
      timeout: 30000,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": payload.length, Accept: "application/json" }
        : { Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", (err) => resolve({ status: 0, text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function udsMcp(method, params) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: UDS_MCP });
    let buffer = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 8000);
    socket.on("connect", () => {
      socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const cut = buffer.indexOf("\n");
      if (cut === -1) return;
      clearTimeout(timer);
      try {
        finish({ ok: true, json: JSON.parse(buffer.slice(0, cut)) });
      } catch (_) {
        finish({ ok: false, error: "invalid json" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}

function grpcCall(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = http2.connect("http://127.0.0.1:" + PORTS.grpc);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("grpc timeout"));
    }, timeoutMs || 60000);
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    const req = client.request({
      ":method": "POST",
      ":path": "/zombie.v1.ChatService/Chat",
      "content-type": "application/grpc",
      te: "trailers",
    });
    let buffer = Buffer.alloc(0);
    const responses = [];
    let grpcStatus = 0;
    let grpcMessage = "";
    req.on("response", (headers) => {
      if (headers["grpc-status"] !== undefined) grpcStatus = parseInt(headers["grpc-status"], 10);
      if (headers["grpc-message"]) grpcMessage = String(headers["grpc-message"]);
    });
    req.on("trailers", (headers) => {
      if (headers["grpc-status"] !== undefined) grpcStatus = parseInt(headers["grpc-status"], 10);
      if (headers["grpc-message"]) grpcMessage = String(headers["grpc-message"]);
    });
    req.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        try {
          const parsed = unframe(buffer);
          responses.push(decodeChatResponse(parsed.payload));
          buffer = parsed.rest;
        } catch (_) {
          break;
        }
      }
    });
    req.on("error", (err) => {
      clearTimeout(timer);
      client.close();
      reject(err);
    });
    req.on("end", () => {
      clearTimeout(timer);
      client.close();
      resolve({ grpcStatus, grpcMessage, responses });
    });
    req.end(frame(Buffer.from(encodeChatRequest(request))));
  });
}

function stdioCall(request, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "transport", "stdio-openai.js")], {
      env: Object.assign({}, process.env, { UDS: UDS_MCP }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { child.kill("SIGTERM"); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout", stderr }), timeoutMs || 60000);
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (!line) continue;
        let obj = null;
        try { obj = JSON.parse(line); } catch (_) {}
        if (obj && (obj.response || obj.error || obj.done)) {
          clearTimeout(timer);
          finish({ ok: !!obj.response, obj, stderr });
          return;
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

function encodeClientFrame(payload) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + len) return null;
  return {
    opcode,
    payload: buffer.subarray(offset, offset + len),
    rest: buffer.subarray(offset + len),
  };
}

function wsMcp(origin, tool, args) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host: "127.0.0.1", port: PORTS.api });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), 10000);
    socket.on("connect", () => {
      socket.write(
        "GET / HTTP/1.1\r\n" +
        "Host: 127.0.0.1:" + PORTS.api + "\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: " + key + "\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Origin: " + origin + "\r\n\r\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) {
          clearTimeout(timer);
          finish({ ok: false, error: head.split("\r\n")[0] });
          return;
        }
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        socket.write(encodeClientFrame(JSON.stringify({ type: "mcp", id: 1, tool, args: args || {} })));
      }
      const frame = decodeServerFrame(buffer);
      if (!frame) return;
      clearTimeout(timer);
      try {
        finish({ ok: true, json: JSON.parse(frame.payload.toString("utf8")) });
      } catch (_) {
        finish({ ok: false, error: "invalid ws json" });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.message });
    });
  });
}

function parseSse(text) {
  const events = [];
  let done = false;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      events.push(JSON.parse(data));
    } catch (_) {
      return { events, done, parseError: data.slice(0, 120) };
    }
  }
  return { events, done };
}

function nonStreamShape(json) {
  const errors = [];
  if (!json || typeof json !== "object") return ["body is not an object"];
  if (json.object !== "chat.completion") errors.push("object=" + json.object);
  if (typeof json.id !== "string" || !json.id.startsWith("chatcmpl-")) errors.push("id=" + json.id);
  if (typeof json.created !== "number") errors.push("created is not a number");
  if (typeof json.model !== "string" || !json.model) errors.push("model missing");
  if (!Array.isArray(json.choices) || json.choices.length === 0) {
    errors.push("choices empty");
    return errors;
  }
  const choice = json.choices[0];
  if (choice.index !== 0) errors.push("choice.index=" + choice.index);
  if (!choice.message || choice.message.role !== "assistant") {
    errors.push("message.role is not assistant");
  } else if (typeof choice.message.content !== "string") {
    errors.push("message.content is not a string");
  }
  if (!["stop", "length", "tool_calls", "content_filter"].includes(choice.finish_reason)) {
    errors.push("finish_reason=" + choice.finish_reason);
  }
  const usage = json.usage || {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    if (typeof usage[key] !== "number") errors.push("usage." + key + " missing");
  }
  return errors;
}

function streamShape(parsed) {
  const errors = [];
  if (!parsed.done) errors.push("missing [DONE]");
  if (parsed.parseError) errors.push("unparseable data: " + parsed.parseError);
  if (!parsed.events.length) errors.push("no chunk events");
  if (!parsed.events.length) return errors;
  const first = parsed.events[0];
  if (first.object !== "chat.completion.chunk") errors.push("first.object=" + first.object);
  if (!first.choices || !first.choices[0] || first.choices[0].delta.role !== "assistant") {
    errors.push("first chunk has no assistant role");
  }
  const ids = new Set(parsed.events.map((e) => e.id));
  if (ids.size !== 1) errors.push("id changes across chunks");
  for (const event of parsed.events) {
    if (event.object !== "chat.completion.chunk") errors.push("chunk.object=" + event.object);
    if (!Array.isArray(event.choices) || !event.choices.length) errors.push("chunk without choices");
    if (!event.choices[0].delta || typeof event.choices[0].delta !== "object") {
      errors.push("chunk without delta");
    }
  }
  const last = parsed.events[parsed.events.length - 1];
  if (!last.choices[0].finish_reason) errors.push("last chunk has no finish_reason");
  return errors;
}

module.exports = {
  ROOT,
  ENV,
  PORTS,
  MAIN_HOST,
  UDS_MCP,
  UDS_OPENAI,
  BENGALI,
  sleep,
  httpJson,
  httpsJson,
  udsHttp,
  udsMcp,
  grpcCall,
  stdioCall,
  wsMcp,
  parseSse,
  nonStreamShape,
  streamShape,
};
