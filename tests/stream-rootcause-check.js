#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: OpenCode stream root-cause evidence check (contract gc-mwpwzr5a)
// =============================================================================
// Read-only proof of three facts, plus one live gateway probe:
//   1. OpenCode recorded a provider.invalid-output error with HTTP 200 whose
//      response body is not valid JSON: a truncated chunk payload with a
//      second `data:` frame concatenated onto it.
//   2. Gateway /v1/models does not expose the failing OpenCode model and does
//      expose the internal agent id code-guru.
//   3. A live SSE response for code-guru has only valid JSON data frames and
//      returns the STREAM_GATEWAY_OK marker.
//
// Evidence: docs/evidence/stream-debug-2026-11-21/root-cause.json
// Run: node tests/stream-rootcause-check.js
// Exit 0 + STREAM_ROOT_CAUSE_OK only when every assertion passes.
// =============================================================================

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { DatabaseSync } = require("node:sqlite");

const NL = String.fromCharCode(10);
const ROOT = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(ROOT, "docs", "evidence", "stream-debug-2026-11-21");
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, "root-cause.json");
const DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
const HOST = "127.0.0.1";
const PORT = 5050;
const FAILING_MODEL = "deepseek-v4.1-flash-free";
const AGENT_ID = "code-guru";
const MARKER = "STREAM_GATEWAY_OK";

const checks = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ok(name, detail) {
  checks.push({ name: name, status: "PASS", detail: detail || "" });
  console.log("PASS  " + name + (detail ? "  [" + detail + "]" : ""));
}

function request(method, pathname, payload, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers = { accept: "application/json" };
    if (body !== null) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: method, headers: headers, timeout: timeoutMs || 10000 },
      function (res) {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) { text += chunk; });
        res.on("end", function () { resolve({ status: res.statusCode, text: text }); });
      }
    );
    req.on("timeout", function () { req.destroy(new Error("timeout after " + (timeoutMs || 10000) + "ms")); });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function parseJsonBody(text, label) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(label + " is not valid JSON: " + err.message);
  }
}

async function main() {
  // --- 1. Read-only DB evidence -------------------------------------------
  assert(fs.existsSync(DB_PATH), "OpenCode DB not found at " + DB_PATH);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let totalInvalid;
  let candidates;
  try {
    totalInvalid = db
      .prepare("select count(*) as c from session_message where json_extract(data,'$.error.type')='provider.invalid-output'")
      .get().c;
    candidates = db
      .prepare(
        "select id, session_id, time_created, data from session_message" +
          " where json_extract(data,'$.error.type')='provider.invalid-output'" +
          " and length(coalesce(json_extract(data,'$.error.response.body'),''))>0" +
          " order by time_created desc limit 50"
      )
      .all();
  } finally {
    db.close();
  }

  assert(candidates.length > 0, "no provider.invalid-output row with a response body");
  const parsed = candidates.map(function (row) {
    return { id: row.id, sessionId: row.session_id, timeCreated: row.time_created, data: JSON.parse(row.data) };
  });

  const latest = parsed[0];
  const err = latest.data.error || {};
  assert(err.type === "provider.invalid-output", "latest row error.type is " + err.type);
  assert(err.status === 200, "expected error.status 200, got " + err.status);
  ok("db.error.status", "200");

  const body = err.response && err.response.body;
  assert(typeof body === "string" && body.length > 0, "latest error body is empty");
  let bodyIsJson = true;
  try { JSON.parse(body); } catch (parseErr) { bodyIsJson = false; }
  assert(!bodyIsJson, "response body is valid JSON; expected a malformed concatenation");
  ok("db.body.malformed", body.length + " bytes, invalid JSON");

  const dataIndex = body.indexOf("data:");
  assert(dataIndex > 0, "no concatenated data: segment inside the body");
  const prefix = body.slice(0, dataIndex);
  let prefixIsJson = true;
  try { JSON.parse(prefix); } catch (prefixErr) { prefixIsJson = false; }
  assert(!prefixIsJson, "prefix before data: is valid JSON; expected a truncated fragment");
  const afterData = body.slice(dataIndex + 5).trim();
  assert(afterData.charAt(0) === "{", "segment after data: is not a JSON object");
  ok("db.concat-prefix", dataIndex + " bytes before data: are invalid JSON");

  const providerRow =
    parsed.find(function (row) { return row.data.model && row.data.model.providerID; }) ||
    parsed.find(function (row) { return row.data.error && row.data.error.providerID; });
  assert(providerRow, "no provider id recorded on invalid-output rows");
  const providerId = providerRow.data.model
    ? providerRow.data.model.providerID
    : providerRow.data.error.providerID;
  assert(providerId === "opencode", "expected provider opencode, got " + providerId);
  ok("db.provider", providerId + " (" + totalInvalid + " invalid-output rows)");

  // --- 2. Gateway model catalog -------------------------------------------
  const modelsRes = await request("GET", "/v1/models", undefined, 8000);
  assert(modelsRes.status === 200, "GET /v1/models returned HTTP " + modelsRes.status);
  const models = parseJsonBody(modelsRes.text, "/v1/models");
  const ids = (models.data || []).map(function (model) { return model.id; });
  assert(!ids.includes(FAILING_MODEL), "gateway still exposes failing model " + FAILING_MODEL);
  assert(ids.includes(AGENT_ID), "gateway does not expose " + AGENT_ID);
  ok("gateway.models", ids.length + " models, " + FAILING_MODEL + " absent, " + AGENT_ID + " present");

  // --- 3. Live SSE probe ---------------------------------------------------
  const probe = {
    model: AGENT_ID,
    stream: true,
    max_tokens: 64,
    temperature: 0,
    messages: [{ role: "user", content: "Reply with exactly: " + MARKER }],
  };
  const sseRes = await request("POST", "/v1/chat/completions", probe, 45000);
  assert(sseRes.status === 200, "POST returned HTTP " + sseRes.status);
  const payloads = sseRes.text
    .split(NL)
    .filter(function (line) { return line.indexOf("data:") === 0; })
    .map(function (line) { return line.slice(5).trim(); });
  const frames = payloads.filter(function (p) { return p.charAt(0) === "{"; });
  const done = "[" + "DONE]";
  assert(payloads.indexOf(done) !== -1, "SSE has no done terminator");
  assert(frames.length >= 2, "expected 2+ JSON frames, got " + frames.length);
  let invalidPayloads = 0;
  let content = "";
  for (const frame of frames) {
    try {
      const chunk = JSON.parse(frame);
      const choice = chunk.choices && chunk.choices[0];
      const delta = choice && choice.delta;
      if (delta && typeof delta.content === "string") content += delta.content;
    } catch (frameErr) {
      invalidPayloads += 1;
    }
  }
  assert(invalidPayloads === 0, invalidPayloads + " SSE frames are not valid JSON");
  assert(content.indexOf(MARKER) !== -1, "marker " + MARKER + " missing");
  ok("gateway.sse", frames.length + " valid frames, invalid=0, marker present");

  // --- 4. Evidence --------------------------------------------------------
  const evidence = {
    check: "stream-rootcause-check",
    contract: "gc-mwpwzr5a",
    checked_at: new Date().toISOString(),
    verdict: "PASS",
    db: {
      path: DB_PATH,
      read_only: true,
      invalid_output_rows: totalInvalid,
      message_id: latest.id,
      session_id: latest.sessionId,
      time_created: new Date(latest.timeCreated).toISOString(),
      provider: providerId,
      status: err.status,
      body_length: body.length,
      body_is_valid_json: bodyIsJson,
      concatenated_data_index: dataIndex,
      prefix_is_valid_json: prefixIsJson,
      body_excerpt: body.slice(0, 240),
    },
    gateway: {
      base: "http://" + HOST + ":" + PORT,
      model_count: ids.length,
      failing_model_absent: !ids.includes(FAILING_MODEL),
      agent_id_present: ids.includes(AGENT_ID),
      sse_data_frames: frames.length,
      sse_invalid_frames: invalidPayloads,
      assembled_content: content,
      sse_marker_present: content.indexOf(MARKER) !== -1,
    },
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(evidence, null, 2) + NL);
  ok("evidence.written", path.relative(ROOT, EVIDENCE_FILE));
  console.log("STREAM_ROOT_CAUSE_OK");
}

main().catch(function (err) {
  console.error("STREAM_ROOT_CAUSE_FAIL: " + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});

