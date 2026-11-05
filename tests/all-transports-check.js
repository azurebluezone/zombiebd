#!/usr/bin/env node
"use strict";

/*
 * Live transport and wire-format audit.
 *
 * Every check talks to the real gateway/Caddy/bridge on this machine. No
 * fixture server and no mocked handler. One named check per inbound
 * transport, plus separate wire-format and Bengali byte-integrity checks.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
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
} = require("./transport-helpers.js");
const { normalizeText } = require("../lib/text-integrity.js");

const MODEL = process.env.TRANSPORT_CHECK_MODEL || "qwen2:0.5b";
const ALLOWED_ORIGIN = "https://" + MAIN_HOST;
const DENIED_ORIGIN = "https://evil.example";
const EXPECTED_TOOLS = 153;
const failures = [];
const transportChecks = [];

function pass(name, detail) {
  console.log("PASS " + name + (detail ? " " + detail : ""));
}
function fail(name, detail) {
  failures.push(name);
  console.log("FAIL " + name + (detail ? " " + detail : ""));
}
function checkTransport(name, ok, detail) {
  transportChecks.push(name);
  ok ? pass(name, detail) : fail(name, detail);
}
function badBytes(text, label) {
  const errors = [];
  if (typeof text !== "string") return [label + " is not a string"];
  if (text.includes("\uFFFD")) errors.push(label + " contains U+FFFD");
  if (Buffer.from(text, "utf8").toString("utf8") !== text) {
    errors.push(label + " does not round-trip as UTF-8");
  }
  return errors;
}
function envSecret(key) {
  try {
    const text = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
    }
  } catch (_) {}
  return "";
}
function chatBody(stream) {
  return {
    model: MODEL,
    messages: [
      { role: "user", content: "Reply with exactly: TRANSPORT_OK" },
      { role: "assistant", content: "TRANSPORT_OK" },
      { role: "user", content: "Repeat the same token once. /no_think" },
    ],
    max_tokens: 16,
    temperature: 0,
    stream: !!stream,
  };
}
function summarizeShape(errors, label) {
  return errors.length ? label + ": " + errors.join("; ") : "";
}
async function mcpToolHttp(origin, tool, args, extraHeaders) {
  return httpJson(
    "/mcp",
    "POST",
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: tool, arguments: args || {} } },
    Object.assign({ Origin: origin }, extraHeaders || {}),
  );
}
function mcpText(res) {
  const result = res && res.json && res.json.result;
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map((c) => c.text || "").join("");
}

async function main() {
  console.log("=== live transport audit ===");
  console.log("api=" + PORTS.api + " grpc=" + PORTS.grpc + " caddy=" + PORTS.caddy_https + " host=" + MAIN_HOST);

  // 1. Plain HTTP.
  const health = await httpJson("/health");
  checkTransport(
    "http",
    health.status === 200 && health.json && health.json.healthy === true,
    "status=" + health.status + " healthy=" + !!(health.json && health.json.healthy),
  );

  // 2. HTTPS through Caddy (internal CA, SNI set to MAIN_HOST).
  const tlsHealth = await httpsJson("/health");
  checkTransport(
    "https",
    tlsHealth.status === 200 &&
      tlsHealth.json &&
      tlsHealth.json.healthy === true &&
      String(tlsHealth.headers.via || "").toLowerCase().includes("caddy"),
    "status=" + tlsHealth.status + " via=" + (tlsHealth.headers.via || "none"),
  );

  // 3. MCP over HTTP.
  const mcpHttp = await httpJson(
    "/mcp",
    "POST",
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    { Origin: ALLOWED_ORIGIN },
  );
  const toolsHttp = mcpHttp.json && mcpHttp.json.result && mcpHttp.json.result.tools;
  checkTransport(
    "mcp-http",
    mcpHttp.status === 200 && Array.isArray(toolsHttp) && toolsHttp.length === EXPECTED_TOOLS,
    "status=" + mcpHttp.status + " tools=" + (Array.isArray(toolsHttp) ? toolsHttp.length : "bad"),
  );

  // 4. MCP over HTTPS through Caddy.
  const mcpHttps = await httpsJson(
    "/mcp",
    "POST",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { Origin: ALLOWED_ORIGIN },
  );
  const toolsHttps = mcpHttps.json && mcpHttps.json.result && mcpHttps.json.result.tools;
  checkTransport(
    "mcp-https",
    mcpHttps.status === 200 && Array.isArray(toolsHttps) && toolsHttps.length === EXPECTED_TOOLS,
    "status=" + mcpHttps.status + " tools=" + (Array.isArray(toolsHttps) ? toolsHttps.length : "bad"),
  );

  // 5. MCP over newline JSON-RPC on the Unix socket.
  const mcpUds = await udsMcp("tools/list", {});
  const toolsUds = mcpUds.ok && mcpUds.json && mcpUds.json.result && mcpUds.json.result.tools;
  checkTransport(
    "mcp-uds",
    !!toolsUds && toolsUds.length === EXPECTED_TOOLS,
    "socket=" + UDS_MCP + " tools=" + (Array.isArray(toolsUds) ? toolsUds.length : mcpUds.error),
  );

  // 6. OpenAI HTTP non-stream.
  const httpChat = await httpJson("/v1/chat/completions", "POST", chatBody(false));
  const httpShape = nonStreamShape(httpChat.json);
  checkTransport(
    "openai-http",
    httpChat.status === 200 && httpShape.length === 0,
    "status=" + httpChat.status + " " + summarizeShape(httpShape, "shape"),
  );

  // 7. OpenAI UDS non-stream.
  const udsChat = await udsHttp("/v1/chat/completions", "POST", chatBody(false));
  const udsShape = nonStreamShape(udsChat.json);
  checkTransport(
    "openai-uds",
    udsChat.status === 200 && udsShape.length === 0,
    "socket=" + UDS_OPENAI + " status=" + udsChat.status + " " + summarizeShape(udsShape, "shape"),
  );

  // 8. OpenAI HTTPS through Caddy.
  const httpsChat = await httpsJson("/v1/chat/completions", "POST", chatBody(false));
  const httpsShape = nonStreamShape(httpsChat.json);
  checkTransport(
    "openai-https",
    httpsChat.status === 200 && httpsShape.length === 0,
    "status=" + httpsChat.status + " " + summarizeShape(httpsShape, "shape"),
  );

  // 9. SSE streaming.
  const sseRes = await httpJson(
    "/v1/chat/completions",
    "POST",
    chatBody(true),
    { Accept: "text/event-stream" },
  );
  const sse = parseSse(sseRes.text || "");
  const sseErrors = streamShape(sse);
  const sseType = String(sseRes.headers["content-type"] || "");
  checkTransport(
    "sse",
    sseRes.status === 200 &&
      sseType.includes("text/event-stream") &&
      sseErrors.length === 0 &&
      !sseRes.text.includes("\uFFFD"),
    "status=" + sseRes.status + " type=" + sseType + " chunks=" + sse.events.length + " " + summarizeShape(sseErrors, "shape"),
  );

  // 10. gRPC unary over HTTP/2.
  let grpc = { grpcStatus: -1, responses: [] };
  let grpcError = "";
  try {
    grpc = await grpcCall({ model: MODEL, messages: chatBody(false).messages, stream: false, temperature: 0 });
  } catch (err) {
    grpcError = err.message;
  }
  const grpcText = grpc.responses.map((r) => r.content || "").join("");
  checkTransport(
    "grpc",
    grpc.grpcStatus === 0 && grpcText.length > 0 && !grpcText.includes("\uFFFD"),
    "port=" + PORTS.grpc + " status=" + grpc.grpcStatus + (grpcError ? " error=" + grpcError : "") + " chars=" + grpcText.length,
  );

  // 11. STDIO line protocol.
  const stdio = await stdioCall(chatBody(false));
  const stdioObj = stdio.obj && stdio.obj.response;
  const stdioText = stdioObj && stdioObj.choices && stdioObj.choices[0] && stdioObj.choices[0].message
    ? stdioObj.choices[0].message.content || ""
    : "";
  checkTransport(
    "stdio",
    stdio.ok && stdioObj && stdioObj.object === "chat.completion" && stdioText.length > 0 && !stdioText.includes("\uFFFD"),
    "ok=" + stdio.ok + (stdio.error ? " error=" + stdio.error : "") + " chars=" + stdioText.length,
  );

  // 12. WebSocket MCP frame.
  const ws = await wsMcp(ALLOWED_ORIGIN, "get_working_dir", {});
  const wsText = ws.ok && ws.json && ws.json.type === "mcp_result" ? mcpText({ json: { result: ws.json } }) : "";
  checkTransport(
    "ws",
    ws.ok && ws.json && ws.json.type === "mcp_result" && wsText.length > 0,
    "type=" + (ws.json && ws.json.type) + " workdir=" + JSON.stringify(wsText) + (ws.error ? " error=" + ws.error : ""),
  );

  // 13. Origin allow/deny around the same tool call. Every explicit Caddy
  // host from .env must be allowed; a random external origin must not.
  const caddyOrigins = [
    "api.zombiecoder.my.id",
    "ocr.zombiecoder.my.id",
    "screen.zombiecoder.my.id",
    "tts.zombiecoder.my.id",
    "ads.zombiecoder.my.id",
    "public.zombiecoder.my.id",
    "combined.zombiecoder.my.id",
    "adapter.zombiecoder.my.id",
  ].map((host) => "https://" + host);
  const originStatuses = [];
  for (const origin of caddyOrigins) {
    const res = await mcpToolHttp(origin, "get_working_dir", {});
    originStatuses.push(res.status);
  }
  const allowedCount = originStatuses.filter((status) => status === 200).length;
  const originDenied = await mcpToolHttp(DENIED_ORIGIN, "get_working_dir", {});
  checkTransport(
    "origins",
    allowedCount === caddyOrigins.length && originDenied.status === 401,
    "allow=" + allowedCount + "/" + caddyOrigins.length + " deny=" + originDenied.status,
  );

  // Format summary: the three non-stream transports must have identical shape.
  const shapeErrors = [].concat(httpShape, udsShape, httpsShape);
  shapeErrors.length === 0
    ? pass("format-nonstream", "object/choices/usage on http,uds,https")
    : fail("format-nonstream", shapeErrors.join("; "));

  sseErrors.length === 0 && sse.done
    ? pass("format-stream", "chunks=" + sse.events.length + " done=yes")
    : fail("format-stream", summarizeShape(sseErrors, "shape"));

  // Bengali normalizer: both spellings of জয়নাল must land on the same
  // canonical NFC sequence (decomposed, because U+09DF is a composition
  // exclusion), stay idempotent, and never lose ZWNJ/ZWJ or astral chars.
  const normErrors = [];
  const canon = BENGALI.canonical;
  if (normalizeText(BENGALI.decomposed) !== canon) normErrors.push("decomposed drifted");
  if (normalizeText(BENGALI.composed) !== canon) normErrors.push("precomposed not canonicalized");
  if (normalizeText(canon) !== canon) normErrors.push("normalizer not idempotent");
  if (normalizeText(normalizeText(BENGALI.composed)) !== canon) normErrors.push("second pass drifted");
  if (normalizeText(BENGALI.rraComposed) !== BENGALI.rraDecomposed) normErrors.push("RRA not canonicalized");
  if (normalizeText(BENGALI.rhaComposed) !== BENGALI.rhaDecomposed) normErrors.push("RHA not canonicalized");
  if (normalizeText(BENGALI.zwnj) !== BENGALI.zwnj) normErrors.push("ZWNJ lost");
  if (normalizeText(BENGALI.zwj) !== BENGALI.zwj) normErrors.push("ZWJ between Bengali lost");
  if (normalizeText(BENGALI.zwsp) !== "\u0995\u09B7") normErrors.push("ZWSP not stripped");
  if (normalizeText("abc\u200D") !== "abc") normErrors.push("latin ZWJ not stripped");
  if (normalizeText(BENGALI.astral) !== BENGALI.astral) normErrors.push("astral char changed");
  if (Buffer.from(normalizeText(BENGALI.composed), "utf8").toString("utf8") !== canon) {
    normErrors.push("normalized bytes do not round-trip");
  }
  normErrors.length === 0
    ? pass("bengali-normalizer", "NFC(ZWNJ+ZWJ)+nukta+astral")
    : fail("bengali-normalizer", normErrors.join("; "));

  // Bengali bytes through the file tools: write once over HTTP, read back
  // over HTTP and UDS, compare SHA-256 with the original UTF-8 bytes.
  const token = envSecret("MCP_ADMIN_TOKEN") || envSecret("ADMIN_API_KEY");
  const authHeaders = token ? { Authorization: "Bearer " + token } : {};
  const bengaliText = [
    BENGALI.composed,
    BENGALI.decomposed,
    BENGALI.zwnj,
    BENGALI.zwj,
    BENGALI.astral,
    "বাংলা: ক্\u200Cষ, জয়নাল, ড়, ঢ়",
  ].join(" ");
  const target = path.join("/tmp/opencode", "bengali-" + process.pid + ".txt");
  const writeRes = await mcpToolHttp(ALLOWED_ORIGIN, "write_file", { path: target, content: bengaliText }, authHeaders);
  const expected = crypto.createHash("sha256").update(Buffer.from(bengaliText, "utf8")).digest("hex");
  const httpRead = await mcpToolHttp(ALLOWED_ORIGIN, "read_file", { path: target });
  const udsRead = await udsMcp("tools/call", { name: "read_file", arguments: { path: target } });
  const httpText = mcpText(httpRead);
  const udsText = udsRead.ok && udsRead.json && udsRead.json.result
    ? (udsRead.json.result.content || []).map((c) => c.text || "").join("")
    : "";
  const httpHash = crypto.createHash("sha256").update(Buffer.from(httpText, "utf8")).digest("hex");
  const udsHash = crypto.createHash("sha256").update(Buffer.from(udsText, "utf8")).digest("hex");
  const byteErrors = [].concat(badBytes(httpText, "http read"), badBytes(udsText, "uds read"));
  if (writeRes.status !== 200) byteErrors.push("write status=" + writeRes.status);
  if (httpHash !== expected) byteErrors.push("http hash mismatch");
  if (udsHash !== expected) byteErrors.push("uds hash mismatch");
  byteErrors.length === 0
    ? pass("bengali-bytes", "sha256=" + expected.slice(0, 16) + " http+uds")
    : fail("bengali-bytes", byteErrors.join("; "));
  await mcpToolHttp(ALLOWED_ORIGIN, "delete_file", { path: target }, authHeaders);

  if (failures.length) {
    console.log("RESULT: ALL TRANSPORTS FAIL " + failures.join(","));
    process.exitCode = 1;
    return;
  }
  console.log("RESULT: ALL TRANSPORTS PASS count=" + transportChecks.length + " model=" + MODEL);
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("CHECK_ERROR " + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
