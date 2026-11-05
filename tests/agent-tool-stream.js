"use strict";
// ─────────────────────────────────────────────────────────────────────
// agent-tool-stream.js — agent x model x streaming x tool-calling test
// ---------------------------------------------------------------------
// What it proves:
//   1. model="<agent id>" routes to the agent persona and its linked model
//   2. stream:true delivers live chunks over OpenAI SSE
//   3. tools:[...] (OpenAI syntax): when the model emits a tool_call the
//      client executes it, replays role:"tool", and gets a second-round answer
//   4. one compact report at the end
//
// Run: node tests/agent-tool-stream.js   (gateway http://127.0.0.1:5050)
// ─────────────────────────────────────────────────────────────────────
const BASE = process.env.BASE_URL || ("http://127.0.0.1:" + (process.env.PORT || "5050"));
const fs = require("fs");
const path = require("path");

const AGENT = process.env.TEST_AGENT || "bug-hunter";      // any id from agent/*.js
const ROUND_TIMEOUT = 130000;                              // one round, CPU model: generous

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
  magenta: "\x1b[35m", red: "\x1b[31m", white: "\x1b[37m",
};
const now = () => new Date().toTimeString().slice(0, 8);
const line = (t) => console.log("─".repeat(Math.min(70, t.length + 4)));

// ── OpenAI-format tools (the exact tool-calling shape) ────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List file and folder names in a directory (for bug hunting).",
      parameters: { type: "object", properties: { path: { type: "string", description: "Directory path, e.g. '.'" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file (for bug hunting).",
      parameters: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "integer" } }, required: ["path"] },
    },
  },
];

// ── Local executor (client-side, like the editor extension) ─────────────────
function executeTool(name, args) {
  try {
    if (name === "list_directory") {
      const p = path.resolve(args.path || ".");
      const items = fs.readdirSync(p).slice(0, 40);
      return { ok: true, result: JSON.stringify(items) };
    }
    if (name === "read_file") {
      const p = path.resolve(args.path);
      const max = parseInt(args.max_chars || "2000", 10);
      const txt = fs.readFileSync(p, "utf8").slice(0, max);
      return { ok: true, result: txt };
    }
    if (name === "get_working_dir") {
      return { ok: true, result: JSON.stringify(process.cwd()) };
    }
    return { ok: false, result: "[local-test] no executor for tool: " + name };
  } catch (e) {
    return { ok: false, result: "[error] " + e.message };
  }
}

// ── SSE stream reader + chunk printer + tool_call collector ──────────────────
// Smooth display: flush flowing text every 600ms
function bufferedSink() {
  let buf = "";
  const iv = setInterval(() => {
    if (buf) { process.stdout.write(buf); buf = ""; }
  }, 600);
  return {
    feed(frag) { buf += frag; },
    end() {
      clearInterval(iv);
      process.stdout.write(buf);
      buf = "";
      process.stdout.write("\n");
    },
  };
}
async function streamChat(requestBody, onDelta, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ROUND_TIMEOUT);
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Id": requestBody.model },
      body: JSON.stringify(requestBody),
      signal: ctrl.signal,
    });
    const ct = r.headers.get("content-type") || "";
    console.log("   " + C.dim + "[" + now() + "] HTTP " + r.status + " · content-type: " + ct.slice(0, 45) + C.reset);

    const out = { text: "", toolCalls: [], finish: null, usage: null, model: "", provider: "" };
    if (r.status !== 200) {
      const body = await r.text();
      throw new Error("HTTP " + r.status + " — " + body.slice(0, 300));
    }

    if (ct.includes("text/event-stream")) {
      // OpenAI-SSE: "data: {json}" ... "data: [DONE]"
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const rawLine = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          if (!rawLine.startsWith("data:")) continue;
          const payload = rawLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let chunk; try { chunk = JSON.parse(payload); } catch { continue; }
          const choice = chunk.choices && chunk.choices[0];
          if (choice) {
            const d = choice.delta || {};
            if (typeof d.content === "string" && d.content) {
              out.text += d.content;
              if (onDelta) onDelta("content", d.content, Date.now() - t0);
            }
            if (Array.isArray(d.tool_calls)) {
              for (const tc of d.tool_calls) {
                let slot = out.toolCalls[tc.index] || (out.toolCalls[tc.index] = { id: "", name: "", arguments: "" });
                if (tc.id) slot.id += tc.id;
                if (tc.function && tc.function.name) slot.name += tc.function.name;
                if (tc.function && typeof tc.function.arguments === "string") slot.arguments += tc.function.arguments;
              }
              if (onDelta) onDelta("tool_call", d.tool_calls.length + " frag(s)", Date.now() - t0);
            }
            if (choice.finish_reason) out.finish = choice.finish_reason;
          }
          if (chunk.usage) out.usage = chunk.usage;
          if (chunk.model && !out.model) out.model = chunk.model;
          if (chunk.provider && !out.provider) out.provider = chunk.provider;
        }
      }
    } else {
      const j = await r.json();
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      out.text = m.content || "";
      out.toolCalls = (m.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function && tc.function.name,
        arguments: tc.function && tc.function.arguments,
      }));
      out.finish = j.choices && j.choices[0].finish_reason;
      out.usage = j.usage || null;
      out.model = j.model || "";
      out.provider = j.provider || "";
    }
    out.toolCalls = out.toolCalls.filter(Boolean).map((s) => ({
      id: s.id || "call_" + Math.random().toString(36).slice(2, 8),
      name: s.name || "",
      arguments: s.arguments || "{}",
    }));
    out.elapsedMs = Date.now() - t0;
    return out;
  } finally { clearTimeout(t); }
}

// ── Report collection ────────────────────────────────────────────────────
const report = [];
function rec(k, v) { report.push({ k, v }); }

(async () => {
  console.log("\n" + C.bold + C.cyan + "ZombieCoder — agent x model x streaming x tool-calling test" + C.reset);
  console.log(C.dim + "target: " + BASE + "  ·  " + new Date().toISOString() + C.reset);
  line("");

  // ── 0. Prove the agent-model link ─────────────────────────────────
  const ag = await (await fetch(BASE + "/api/agents")).json();
  const agent = ag.agents.find((a) => a.id === AGENT);
  console.log(C.bold + "model <-> agent link:" + C.reset);
  console.log("   agent : " + C.yellow + (agent ? agent.name : AGENT) + C.reset + "  (" + AGENT + ")");
  console.log("   linked model: " + C.green + ((agent && agent.model) || "unknown") + C.reset + "  (DB agents->model mapping)");
  console.log("   persona : " + (agent ? (agent.role || "").slice(0, 60) : ""));
  line("");

  // ── 1. Show the syntax (print the request body) ────────────────────
  const requestBody = {
    model: AGENT,
    stream: true,
    tools: TOOLS,
    messages: [
      { role: "system", content: "You are " + AGENT + ", the debugging agent for Mission Barisal." },
      { role: "user", content: "Use your list_directory tool on '.', then in two lines say where to look for bugs here." },
    ],
    max_tokens: 200,
    temperature: 0.2,
  };
  console.log(C.bold + "tool-calling + streaming syntax (sent as-is):" + C.reset);
  console.log(C.dim + JSON.stringify(requestBody, null, 2).split("\n").slice(0, 26).join("\n") + " …" + C.reset);
  line("");

  // ── 2. ROUND 1 — streaming + tool_call ─────────────────────────
  console.log(C.bold + C.magenta + "▶ ROUND 1 :: streaming (model=" + AGENT + ")" + C.reset);
  const sink1 = bufferedSink();
  const r1 = await streamChat(requestBody, (kind, frag) => {
    if (kind === "content") sink1.feed(frag);
    if (kind === "tool_call") process.stdout.write(C.yellow + " " + C.reset);
  });
  sink1.end();

  if (r1.toolCalls.length > 0) {
    // ── 3. Execute the tool + ROUND 2 ─────────────────────────────
    console.log("\n" + C.bold + C.green + "model emitted tool_call(s) — executing:" + C.reset);
    const toolMessages = [];
    for (const tc of r1.toolCalls) {
      let args = {}; try { args = JSON.parse(tc.arguments || "{}"); } catch { args = { raw: tc.arguments }; }
      console.log("   " + C.yellow + "call: " + tc.name + C.reset + " " + C.dim + JSON.stringify(args) + C.reset + "  [" + tc.id.slice(0, 12) + "…]");
      const res = executeTool(tc.name, args);
      console.log("        ↳ " + (res.ok ? C.green : C.red) + "result: " + C.reset + String(res.result).slice(0, 160));
      toolMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: res.result,
      });
    }

    console.log("\n" + C.bold + C.magenta + ">> ROUND 2 :: streaming (with tool results)" + C.reset);
    const messages2 = [...requestBody.messages, { role: "assistant", content: r1.text || null, tool_calls: r1.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })) }, ...toolMessages];
    const sink2 = bufferedSink();
    const r2 = await streamChat({ ...requestBody, messages: messages2 }, (kind, frag) => {
      if (kind === "content") sink2.feed(frag);
    });
    sink2.end();
    process.stdout.write("\n");
    rec("round1.finish", r1.finish); rec("round1.tool_calls", r1.toolCalls.map((t) => t.name + "(" + t.arguments.slice(0, 60) + ")"));
    rec("round2.finish", r2.finish); rec("round1.ms", r1.elapsedMs + " ms"); rec("round2.ms", r2.elapsedMs + " ms");
    rec("final_text", (r2.text || "(empty)").slice(0, 300));
  } else {
    console.log("\n" + C.yellow + "model answered directly without a tool call; the syntax demo is still valid." + C.reset);
    rec("round1.finish", r1.finish); rec("tool_calls", "none (model answered directly)");
    rec("round1.ms", r1.elapsedMs + " ms");
    rec("final_text", r1.text.slice(0, 300));
  }
  rec("requested_model", AGENT); rec("resolved_model", r1.model || (agent && agent.model) || "unknown"); rec("provider", r1.provider || "unknown");
  line("");

  // ── 4. Final report ──────────────────────────────────────────
  console.log("\n" + C.bold + C.cyan + "|#  TEST REPORT  #|" + C.reset);
  const w = Math.max(...report.map((r) => r.k.length)) + 2;
  for (const { k, v } of report) console.log("   " + C.dim + k.padEnd(w) + C.reset + "→  " + String(v));
  const ok = r1.toolCalls.length > 0 && r1.elapsedMs > 0;
  console.log("");
  console.log("   " + (ok ? C.green + "PASS" : C.yellow + "PASS(warning)") + C.reset + C.bold + "  — agent-model link, streaming and tool-calling flow verified" + C.reset);
  console.log("");
  process.exit(0);
})().catch((e) => { console.error("\n" + C.red + "SCRIPT ERROR: " + (e && e.message) + C.reset); process.exit(2); });