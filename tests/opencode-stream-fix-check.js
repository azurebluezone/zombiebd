#!/usr/bin/env node
"use strict";
/**
 * OpenCode / OpenAI-compatible stream regression gate.
 *
 * Reported failure: Invalid opencode/openai-compatible-chat stream event
 * Underlying cause: SchemaError: Expected a valid JSON string
 *
 * Proves against the live gateway:
 *   1. every SSE data payload is valid JSON in OpenAI chunk shape
 *   2. reasoning_content is never copied into content
 *   3. a real tool-call stream keeps index/id/type/function and tool_calls finish
 *   4. /api/mission sends response_done and closes instead of hanging
 *   5. the real OpenCode CLI against zombie-local exits 0 with clean output
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let ENV = {};
try {
  ENV = require("../lib/env.js").loadEnv({ root: ROOT });
} catch (_) {}

const PORT = Number(process.env.PORT || (ENV.ports && ENV.ports.api) || 5050);
const HOST = "127.0.0.1";
const CLI = process.env.OPENCODE_CLI || path.join(
  process.env.HOME || "",
  ".config/ai.opencode.desktop/cli/2.3.0-x64/opencode-cli",
);

let failures = 0;
function pass(name, detail) { console.log("PASS " + name + (detail ? " :: " + detail : "")); }
function fail(name, detail) { failures++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
function assert(name, ok, detail) { ok ? pass(name, detail) : fail(name, detail); }

function postSse(pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const startedAt = Date.now();
    let lastEventAt = 0;
    const events = [];
    const req = http.request({
      host: HOST, port: PORT, path: pathname, method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        origin: "http://localhost:" + PORT,
      },
    }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        let match = buffer.match(/\r?\n\r?\n/);
        while (match && match.index !== undefined) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          for (const line of block.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            events.push(data);
            lastEventAt = Date.now();
          }
          match = buffer.match(/\r?\n\r?\n/);
        }
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          events,
          lastEventAt,
          closedAt: Date.now(),
          elapsed: Date.now() - startedAt,
        });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout after " + timeoutMs + "ms")));
    req.end(payload);
  });
}

function parseEvents(events) {
  const parsed = [];
  for (const raw of events) {
    if (raw === "[DONE]") { parsed.push({ done: true }); continue; }
    try { parsed.push({ value: JSON.parse(raw), raw }); }
    catch (e) { parsed.push({ invalid: raw, error: e.message }); }
  }
  return parsed;
}

function validateOpenAiChunk(obj, label, errors) {
  if (!obj || typeof obj !== "object") { errors.push(label + ": not an object"); return; }
  if (obj.object !== "chat.completion.chunk") errors.push(label + ": object=" + obj.object);
  if (!Array.isArray(obj.choices)) { errors.push(label + ": choices is not an array"); return; }
  for (const [i, choice] of obj.choices.entries()) {
    const where = label + ".choices[" + i + "]";
    if (typeof choice.index !== "number") errors.push(where + ": index missing");
    if (!choice.delta || typeof choice.delta !== "object") { errors.push(where + ": delta missing"); continue; }
    const d = choice.delta;
    for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
      if (d[key] !== undefined && d[key] !== null && typeof d[key] !== "string") {
        errors.push(where + "." + key + " is not a string");
      }
    }
    if (d.tool_calls !== undefined) {
      if (!Array.isArray(d.tool_calls)) { errors.push(where + ": tool_calls not array"); continue; }
      for (const [j, tc] of d.tool_calls.entries()) {
        const tw = where + ".tool_calls[" + j + "]";
        if (typeof tc.index !== "number") errors.push(tw + ": index missing");
        if (typeof tc.id !== "string" || !tc.id) errors.push(tw + ": id missing");
        if (tc.type !== "function") errors.push(tw + ": type=" + tc.type);
        if (!tc.function || typeof tc.function !== "object") errors.push(tw + ": function missing");
        else {
          if (typeof tc.function.name !== "string" || !tc.function.name) errors.push(tw + ": name missing");
          if (typeof tc.function.arguments !== "string") errors.push(tw + ": arguments not a string");
        }
      }
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined && typeof choice.finish_reason !== "string") {
      errors.push(where + ": finish_reason invalid");
    }
  }
}

(async () => {
  console.log("=== live gateway " + HOST + ":" + PORT + " ===");

  // 1. Reasoning channel must stay separate from content.
  const reasoningRes = await postSse("/v1/chat/completions", {
    model: "openai/gpt-oss-20b",
    stream: true,
    temperature: 0,
    max_tokens: 256,
    messages: [{ role: "user", content: "Think briefly, then reply with exactly: REASON_OK" }],
  }, 120000);
  const rParsed = parseEvents(reasoningRes.events);
  const rInvalid = rParsed.filter((p) => p.invalid);
  const rChunks = rParsed.filter((p) => p.value && !p.value.done).map((p) => p.value);
  const rSchema = [];
  for (const [i, c] of rChunks.entries()) validateOpenAiChunk(c, "reasoning[" + i + "]", rSchema);
  const rDeltas = rChunks.map((c) => (c.choices && c.choices[0] && c.choices[0].delta) || {});
  const rContent = rDeltas.map((d) => d.content || "").join("");
  const rReasoning = rDeltas.map((d) => d.reasoning_content || d.reasoning || "").join("");
  const dup = rDeltas.filter((d) => d.content && d.reasoning_content && d.content === d.reasoning_content);
  assert("reasoning: http 200", reasoningRes.status === 200, "status=" + reasoningRes.status);
  assert("reasoning: every payload is valid JSON", rInvalid.length === 0, "invalid=" + rInvalid.length);
  assert("reasoning: OpenAI chunk schema valid", rSchema.length === 0, rSchema.slice(0, 2).join(" | "));
  assert("reasoning: reasoning_content present", rReasoning.length > 0, "reasoning_chars=" + rReasoning.length);
  assert("reasoning: not duplicated into content", dup.length === 0, "duplicate_chunks=" + dup.length);
  assert("reasoning: content is answer only", rContent.length > 0 && rContent !== rReasoning, "content_chars=" + rContent.length);
  assert("reasoning: marker present", rContent.includes("REASON_OK"), JSON.stringify(rContent.slice(0, 80)));
  assert("reasoning: DONE present", rParsed.some((p) => p.done), "events=" + rParsed.length);
  // 2. Real streaming tool call.
  const toolRes = await postSse("/v1/chat/completions", {
    model: "bug-hunter",
    stream: true,
    temperature: 0,
    max_tokens: 160,
    messages: [{ role: "user", content: "Call the list_directory tool on . now. Do not answer without calling it." }],
    tools: [{
      type: "function",
      function: {
        name: "list_directory",
        description: "List directory entries",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    }],
  }, 300000);
  const tParsed = parseEvents(toolRes.events);
  const tInvalid = tParsed.filter((p) => p.invalid);
  const tChunks = tParsed.filter((p) => p.value && !p.value.done).map((p) => p.value);
  const tSchema = [];
  for (const [i, c] of tChunks.entries()) validateOpenAiChunk(c, "tool[" + i + "]", tSchema);
  const tCalls = tChunks.flatMap((c) => (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls) || []);
  const tFinish = tChunks.map((c) => c.choices && c.choices[0] && c.choices[0].finish_reason).filter(Boolean);
  const tContent = tChunks.map((c) => (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || "").join("");
  assert("tool: http 200", toolRes.status === 200, "status=" + toolRes.status);
  assert("tool: every payload is valid JSON", tInvalid.length === 0, "invalid=" + tInvalid.length);
  assert("tool: OpenAI chunk schema valid", tSchema.length === 0, tSchema.slice(0, 2).join(" | "));
  assert("tool: tool calls executed server-side", tCalls.length === 0, "dangling_calls=" + tCalls.length);
  assert("tool: final finish_reason=stop", tFinish.includes("stop") && !tFinish.includes("tool_calls"), "finish=" + tFinish.join(","));
  assert("tool: answer carries directory data", /api\.js|agent|modules|\.env/.test(tContent), JSON.stringify(tContent.slice(0, 120)));
  assert("tool: DONE present", tParsed.some((p) => p.done), "events=" + tParsed.length);
  // 3. Mission SSE must close after response_done.
  const missionRes = await postSse("/api/mission", {
    input: "Reply with exactly: MISSION_CLOSE_OK",
    session_id: "opencode-stream-fix-" + Date.now(),
    editor: "opencode-stream-fix",
  }, 90000);
  const mParsed = parseEvents(missionRes.events);
  const mInvalid = mParsed.filter((p) => p.invalid);
  const done = mParsed.find((p) => p.value && p.value.type === "response_done");
  assert("mission: http 200", missionRes.status === 200, "status=" + missionRes.status);
  assert("mission: every payload is valid JSON", mInvalid.length === 0, "invalid=" + mInvalid.length);
  assert("mission: response_done present", !!done, "events=" + mParsed.length);
  assert("mission: answer present", !!done && typeof done.value.data.content === "string" && done.value.data.content.includes("MISSION_CLOSE_OK"), done ? JSON.stringify(done.value.data.content.slice(0, 80)) : "none");
  const closeLag = missionRes.lastEventAt ? missionRes.closedAt - missionRes.lastEventAt : -1;
  assert("mission: closes after response_done", closeLag >= 0 && closeLag < 10000, "close_lag_ms=" + closeLag + " total_ms=" + missionRes.elapsed);
  // 4. Real OpenCode CLI against the local provider.
  assert("opencode: CLI exists", fs.existsSync(CLI), CLI);
  const cliRun = await new Promise((resolve) => {
    if (!fs.existsSync(CLI)) { resolve({ code: -1, out: "", err: "missing" }); return; }
    const child = spawn(CLI, ["run", "--model", "zombie-local/code-guru", "--format", "json", "Reply with exactly: OC_STREAM_OK"], { cwd: ROOT, env: process.env });
    let out = "", err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }); });
  });
  const cliParts = [];
  for (const line of cliRun.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { cliParts.push(JSON.parse(line)); } catch (_) {}
  }
  const textParts = cliParts.filter((p) => p.type === "text" && p.part && p.part.text).map((p) => p.part.text);
  const reasoningParts = cliParts.filter((p) => p.type === "reasoning" && p.part && p.part.text).map((p) => p.part.text);
  const cliText = textParts.join("\n");
  const cliHasInvalid = /Invalid\s+opencode\/openai-compatible-chat\s+stream event/i.test(cliRun.out + "\n" + cliRun.err);
  assert("opencode: CLI exit 0", cliRun.code === 0, "exit=" + cliRun.code + " err=" + cliRun.err.slice(0, 120));
  assert("opencode: marker in text output", cliText.includes("OC_STREAM_OK"), JSON.stringify(cliText.slice(0, 120)));
  assert("opencode: no Invalid stream event", !cliHasInvalid, cliHasInvalid ? "found" : "clean");
  if (reasoningParts.length) {
    const reasoning = reasoningParts.join("");
    const leaked = textParts.some((t) => t.startsWith(reasoning.slice(0, 60)));
    assert("opencode: reasoning stays separate", !leaked, "reasoning_parts=" + reasoningParts.length + " text_parts=" + textParts.length);
  } else {
    pass("opencode: no separate reasoning part emitted (schema proven above)");
  }

  if (failures) {
    console.log("RESULT: OPENCODE STREAM FIX FAIL failures=" + failures);
    process.exit(1);
  }
  console.log("OPENCODE_STREAM_FIX_OK");
})().catch((e) => {
  console.error("RESULT: OPENCODE STREAM FIX ERROR " + (e && e.message));
  process.exit(2);
});
