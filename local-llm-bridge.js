#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");

// ── Config ────────────────────────────────────────────────────
const HOME = os.homedir();
const MODEL_DIR = path.join(HOME, ".local", "share", "models");
const LLAMA_DIR = path.join(HOME, ".local", "share", "llama.cpp");

function scanGgufRoots() {
  const roots = [MODEL_DIR, path.join(HOME, ".cache", "huggingface", "hub")];
  const found = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.endsWith(".gguf")) {
          let mtime = 0;
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch (_) {}
          found.push({ path: full, mtime });
        }
      }
    }
  }
  return found;
}

function detectGguf() {
  if (process.env.BRIDGE_GGUF && fs.existsSync(process.env.BRIDGE_GGUF)) {
    return process.env.BRIDGE_GGUF;
  }
  const cands = scanGgufRoots();
  if (!cands.length) return null;
  const hint = process.env.BRIDGE_GGUF_HINT;
  if (hint) {
    const hit = cands.filter((c) => c.path.includes(hint));
    if (hit.length) {
      hit.sort((a, b) => b.mtime - a.mtime);
      return hit[0].path;
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0].path;
}

function findLlamaServer() {
  if (process.env.LLAMA_SERVER_BIN && fs.existsSync(process.env.LLAMA_SERVER_BIN)) {
    return process.env.LLAMA_SERVER_BIN;
  }
  let found = null;
  try {
    const stack = [LLAMA_DIR];
    while (stack.length) {
      const dir = stack.pop();
      let ents = [];
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const e of ents) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name === "llama-server") {
          found = full;
          break;
        }
      }
      if (found) break;
    }
  } catch (_) {}
  if (found) return found;
  try {
    return (
      execSync("command -v llama-server", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim() || null
    );
  } catch (_) {
    return null;
  }
}

const CFG = {
  backend: (process.env.BRIDGE_BACKEND || "ollama").toLowerCase(),
  llamaBin: findLlamaServer(),
  gguf: detectGguf(),
  model: process.env.BRIDGE_MODEL || "ollama-local",
  port: parseInt(process.env.BRIDGE_PORT || "11437", 10),
  socket: process.env.BRIDGE_SOCKET || "/tmp/local-llm.sock",
  internalPort: parseInt(process.env.BRIDGE_INTERNAL_PORT || "11434", 10),
  upstreamModel:
    process.env.BRIDGE_UPSTREAM_MODEL || process.env.BRIDGE_MODEL || "ollama-local",
  ollamaUrl: process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434",
  ctx: parseInt(process.env.BRIDGE_CTX || "512", 10),
  // TIMEOUT_FIX: this key was missing while upstreamChat()/chatStream()
  // already read `timeout: CFG.timeoutMs`. Undefined made every outbound
  // request carry `timeout: undefined`, which Node 24 does NOT read as
  // "no timeout" — it falls back to 5s, so any prompt big enough to make the
  // model think longer than 5s died with "upstream_timeout". Evidence:
  //   200-word prompt → timeout: undefined = 5010ms ERROR
  //                     timeout: 200000    =  546ms OK
  // BRIDGE_TIMEOUT_MS was already in .env but nothing read it.
  // NOTE: ctx above is ONLY used by spawnLlamaServer(); with BRIDGE_BACKEND=
  // ollama the real window is whatever Ollama itself allows, not this number.
  timeoutMs: parseInt(process.env.BRIDGE_TIMEOUT_MS || "120000", 10),
  threads: parseInt(process.env.BRIDGE_THREADS || String(os.cpus().length), 10),
  // socket permission — default owner rw only (0o600); override via env
  socketMode: parseInt(process.env.BRIDGE_SOCKET_MODE || "600", 8),
};

const UPSTREAM_BASE =
  CFG.backend === "ollama"
    ? CFG.ollamaUrl.replace(/\/$/, "")
    : "http://127.0.0.1:" + CFG.internalPort;

let child = null;
let shuttingDown = false;

// Installed models are discovered from the backend, never guessed. A stale
// BRIDGE_MODEL/BRIDGE_UPSTREAM_MODEL used to make every request fail with an
// upstream 404 even though a perfectly good model was installed.
const MODEL_STATE = {
  configured: CFG.upstreamModel,
  installed: [],
  selected: CFG.upstreamModel,
  source: "configured",
  error: "",
};

function fetchJson(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs || 3000 }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, status: res.statusCode, error: "HTTP " + res.statusCode, body: buf });
          return;
        }
        try {
          resolve({ ok: true, status: res.statusCode, json: JSON.parse(buf), body: buf });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, error: "invalid json: " + e.message, body: buf });
        }
      });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, error: e.message, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout", body: "" });
    });
  });
}

async function refreshModelState() {
  if (CFG.backend !== "ollama") {
    MODEL_STATE.selected = CFG.upstreamModel;
    MODEL_STATE.source = "backend:" + CFG.backend;
    return MODEL_STATE;
  }
  const base = CFG.ollamaUrl.replace(/\/$/, "");
  const result = await fetchJson(base + "/api/tags", 3000);
  if (!result.ok) {
    MODEL_STATE.error = result.error;
    log("WARN", "MODEL_DISCOVERY_FAIL", { url: base + "/api/tags", error: result.error });
    return MODEL_STATE;
  }
  const names = (result.json.models || [])
    .map((m) => m && m.name)
    .filter((n) => typeof n === "string" && n.length > 0);
  MODEL_STATE.installed = names;
  MODEL_STATE.error = "";
  const wanted = CFG.upstreamModel;
  if (names.includes(wanted)) {
    MODEL_STATE.selected = wanted;
    MODEL_STATE.source = "configured";
  } else if (names.includes(CFG.model)) {
    MODEL_STATE.selected = CFG.model;
    MODEL_STATE.source = "configured-alias";
  } else if (names.length > 0) {
    MODEL_STATE.selected = names[0];
    MODEL_STATE.source = "autoselect";
  } else {
    MODEL_STATE.selected = wanted;
    MODEL_STATE.source = "none-installed";
  }
  CFG.upstreamModel = MODEL_STATE.selected || CFG.upstreamModel;
  CFG.model = MODEL_STATE.selected || CFG.model;
  log("INFO", "MODEL_STATE", {
    configured: MODEL_STATE.configured,
    selected: MODEL_STATE.selected,
    source: MODEL_STATE.source,
    installed: names,
  });
  return MODEL_STATE;
}

function resolveRequestModel(requested) {
  const want = typeof requested === "string" ? requested.trim() : "";
  if (!want) return CFG.upstreamModel;
  if (CFG.backend !== "ollama") return want;
  if (MODEL_STATE.installed.includes(want)) return want;
  // Agent fallbacks such as "llama-local" are aliases, not Ollama tags. The
  // bridge is the compatibility layer: map any unknown alias to the installed
  // model instead of forwarding a name the backend cannot serve.
  return CFG.upstreamModel;
}

// ── Logging ───────────────────────────────────────────────────
function log(level, msg, extra) {
  const t = new Date().toISOString().slice(11, 19);
  const ex = extra ? " " + JSON.stringify(extra) : "";
  console.log(t + " [bridge:" + level + "] " + msg + ex);
}

// ── Think-tag Handling ────────────────────────────────────────
const THINK_OPEN = ["<|think|>", "<think>", "<reasoning>"];
const THINK_CLOSE = ["</|think|>", "</think>", "</reasoning>", "<|/think|>"];
const ALL_MARKERS = THINK_OPEN.concat(THINK_CLOSE);

function stripThink(text) {
  if (!text) return { content: text || "", stripped: "" };
  let out = text;
  let stripped = "";
  for (const open of THINK_OPEN) {
    for (;;) {
      const idx = out.indexOf(open);
      if (idx === -1) break;
      let end = -1;
      for (const close of THINK_CLOSE) {
        const c = out.indexOf(close, idx + open.length);
        if (c !== -1 && (end === -1 || c < end)) end = c + close.length;
      }
      if (end === -1) end = idx + open.length;
      stripped += out.slice(idx, end) + "\n";
      out = out.slice(0, idx) + out.slice(end);
    }
  }
  return { content: out.replace(/^[ \t\r\n]+/, ""), stripped: stripped.trim() };
}

function makeThinkFilter() {
  let inThink = false;
  let pending = "";

  function partialMarkerHold(s) {
    let hold = 0;
    for (const m of ALL_MARKERS) {
      for (let k = m.length - 1; k > hold && k <= s.length; k--) {
        if (s.length >= k && s.slice(s.length - k) === m.slice(0, k)) {
          hold = k;
          break;
        }
      }
    }
    return hold;
  }

  return {
    push(delta) {
      pending += delta;
      let emit = "";
      for (;;) {
        if (inThink) {
          let best = -1;
          let bestLen = 0;
          for (const c of THINK_CLOSE) {
            const i = pending.indexOf(c);
            if (i !== -1 && (best === -1 || i < best)) {
              best = i;
              bestLen = c.length;
            }
          }
          if (best === -1) return emit;
          pending = pending.slice(best + bestLen);
          inThink = false;
          continue;
        }
        let openIdx = -1;
        let openLen = 0;
        for (const o of THINK_OPEN) {
          const i = pending.indexOf(o);
          if (i !== -1 && (openIdx === -1 || i < openIdx)) {
            openIdx = i;
            openLen = o.length;
          }
        }
        if (openIdx === -1) {
          const hold = partialMarkerHold(pending);
          const safeLen = pending.length - hold;
          emit += pending.slice(0, safeLen);
          pending = pending.slice(safeLen);
          return emit;
        }
        emit += pending.slice(0, openIdx);
        pending = pending.slice(openIdx + openLen);
        inThink = true;
      }
    },
    flush() {
      const out = pending;
      pending = "";
      return out;
    },
  };
}

// ── Tool Call Parsing ──────────────────────────────────────────
function randId() {
  return "call_" + crypto.randomBytes(8).toString("hex");
}

function safeJsonString(v) {
  if (v == null) return "{}";
  if (typeof v === "string") {
    try {
      JSON.parse(v);
      return v;
    } catch (_) {
      return JSON.stringify({ _: v });
    }
  }
  return JSON.stringify(v);
}

function parseToolCalls(text) {
  if (!text || typeof text !== "string") return null;
  const calls = [];

  const block = text.match(/<function_calls>[\s\S]*?<\/function_calls>/);
  if (block) {
    const invokes = block[0].matchAll(/<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g);
    for (const inv of invokes) {
      const args = {};
      const params = inv[2].matchAll(/<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g);
      for (const p of params) {
        let val = p[2].trim();
        try {
          val = JSON.parse(val);
        } catch (_) {}
        args[p[1]] = val;
      }
      calls.push({
        id: randId(),
        type: "function",
        function: { name: inv[1], arguments: safeJsonString(args) },
      });
    }
  }

  if (!calls.length) {
    const fn = text.match(/<<function:([A-Za-z0-9_.:-]+)>>\s*(\{[\s\S]*?\})/);
    if (fn) {
      calls.push({
        id: randId(),
        type: "function",
        function: { name: fn[1], arguments: safeJsonString(fn[2]) },
      });
    }
  }

  if (!calls.length) {
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const bare = !fenced && text.trim().startsWith("{") ? [text.trim()] : null;
    const cand = fenced ? fenced[1] : bare ? bare[0] : null;
    if (cand && /"name"\s*:/.test(cand) && /"arguments"\s*:/.test(cand)) {
      try {
        const obj = JSON.parse(cand);
        if (obj && obj.name) {
          calls.push({
            id: randId(),
            type: "function",
            function: { name: String(obj.name), arguments: safeJsonString(obj.arguments) },
          });
        }
      } catch (_) {}
    }
  }

  return calls.length ? calls : null;
}

function stripToolText(text) {
  if (!text) return text;
  let out = text;
  out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/, "");
  out = out.replace(/```(?:json)?\s*\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}\s*```/, "");
  out = out.replace(/<<function:[^>]+>>\s*\{[\s\S]*?\}/, "");
  const naked = out.trim();
  if (naked.startsWith("{") && naked.endsWith("}")) {
    try {
      const o = JSON.parse(naked);
      if (o && o.name && o.arguments) return "";
    } catch (_) {}
  }
  return out.replace(/[ \t]+$/gm, "").trim();
}

function extractJson(text) {
  if (!text) return text;
  const t = text.replace(/```(?:json)?/g, "").trim();
  for (const open of ["{", "["]) {
    const start = t.indexOf(open);
    if (start === -1) continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const ch = t[i];
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return t.slice(start, i + 1);
      }
    }
  }
  return text;
}

// ── Network & Upstream Communication ─────────────────────────
function upstreamChat(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const targetUrl = new URL(UPSTREAM_BASE + "/v1/chat/completions");

    const req = http.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 5050,
        path: targetUrl.pathname,
        method: "POST",
        timeout: CFG.timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("upstream_timeout")));
    req.on("error", (e) =>
      resolve({
        status: 599,
        body: JSON.stringify({ error: { message: "upstream: " + e.message } }),
      })
    );
    req.write(body);
    req.end();
  });
}

function upstreamHealth() {
  return new Promise((resolve) => {
    const targetUrl = new URL(UPSTREAM_BASE + (CFG.backend === "ollama" ? "/api/tags" : "/health"));
    const req = http.get(targetUrl, { timeout: 3000 }, (res) => {
      let buf = "";
      res.on("data", (d) => (buf += d));
      res.on("end", () => resolve({ ok: res.statusCode === 200, body: buf }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, body: "" });
    });
  });
}

function spawnLlamaServer() {
  if (CFG.backend !== "llama") return;
  if (!CFG.llamaBin || !CFG.gguf || !fs.existsSync(CFG.gguf)) return;

  const args = [
    "-m", CFG.gguf,
    "-c", String(CFG.ctx),
    "-t", String(CFG.threads),
    "--host", "127.0.0.1",
    "--port", String(CFG.internalPort),
    "--alias", CFG.model,
    "--jinja",
    "--no-webui",
  ];

  child = spawn(CFG.llamaBin, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.on("exit", () => {
    child = null;
    if (!shuttingDown) setTimeout(spawnLlamaServer, 3000);
  });
}

async function waitUpstreamReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const h = await upstreamHealth();
    if (h.ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// ── HTTP Utility Helpers ─────────────────────────────────────
// CORS hardening — reflect only allowed origins; default = loopback only.
//    BRIDGE_ALLOWED_ORIGINS="*" restores the old any-origin behavior.
function allowedOrigin(req) {
  const src = req.headers.origin;
  if (!src) return ""; // non-browser request — no CORS needed
  const cfg = (process.env.BRIDGE_ALLOWED_ORIGINS || "").trim();
  if (cfg === "*") return "*";
  const list = cfg.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("*")) return "*";
  if (list.some((o) => src === o || src.startsWith(o + "/") || src.startsWith(o + ":"))) {
    return src;
  }
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(src);
  return list.length === 0 && isLoopback ? src : "";
}

function cors(req, res) {
  const origin = allowedOrigin(req);
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function openaiError(req, res, status, message, type) {
  const payload = JSON.stringify({
    error: { message: message, type: type || "bridge_error", code: null },
  });
  if (!res.headersSent) {
    const origin = req && req.headers ? allowedOrigin(req) : "";
    const writeHeadOptions = { "Content-Type": "application/json" };
    if (origin) writeHeadOptions["Access-Control-Allow-Origin"] = origin;
    res.writeHead(status, writeHeadOptions);
  }
  res.end(payload);
}

function readBody(req, max = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > max) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function buildPayload(body, stream) {
  const p = {
    model: resolveRequestModel(body.model),
    messages: body.messages,
    stream: !!stream,
    temperature: typeof body.temperature === "number" ? body.temperature : 0.7,
  };
  if (typeof body.max_tokens === "number") p.max_tokens = body.max_tokens;
  if (body.stop) p.stop = body.stop;
  if (body.response_format) p.response_format = body.response_format;
  if (Array.isArray(body.tools) && body.tools.length) p.tools = body.tools;
  if (body.tool_choice) p.tool_choice = body.tool_choice;
  return p;
}

function toolHintSystem(tools) {
  const fns = (tools || []).map((t) => t && t.function).filter((f) => f && f.name);
  const spec = JSON.stringify(fns);
  let example = '{"name":"tool","arguments":{}}';
  const first = fns[0];
  if (first) {
    const props = (first.parameters && first.parameters.properties) || {};
    const keys = Object.keys(props).slice(0, 3);
    const args = {};
    for (const k of keys) args[k] = "example";
    example = JSON.stringify({ name: first.name, arguments: args });
  }
  return (
    "Available tools (JSON):\n" +
    spec +
    "\n\nTo use a tool, reply with ONLY this exact shape:\n```json\n" +
    example +
    "\n```"
  );
}

function normalizeUpstream(parsed) {
  const choice = (parsed.choices && parsed.choices[0]) || {};
  const m = choice.message || {};
  let content = typeof m.content === "string" ? m.content : "";
  let reasoning = typeof m.reasoning_content === "string" ? m.reasoning_content : "";
  let toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : null;

  const st = stripThink(content);
  content = st.content;
  if (st.stripped) reasoning = (reasoning ? reasoning + "\n" : "") + st.stripped;

  if (!toolCalls) {
    toolCalls = parseToolCalls(content);
    if (toolCalls) content = stripToolText(content);
  }

  return {
    content: content,
    reasoning: reasoning.trim(),
    toolCalls: toolCalls,
    finish: choice.finish_reason || "stop",
  };
}

// ── Handlers (Non-Stream & Stream) ───────────────────────────
async function chatNonStream(body, transport) {
  const t0 = Date.now();
  const wantModel = resolveRequestModel(body.model);
  const hadTools = Array.isArray(body.tools) && body.tools.length > 0;
  const payload0 = buildPayload(body, false);

  let up = await upstreamChat(payload0);
  let payloadUsed = payload0;

  if (up.status !== 200 && hadTools) {
    const p2 = buildPayload({ ...body, tools: undefined, tool_choice: undefined }, false);
    p2.messages = [{ role: "system", content: toolHintSystem(body.tools) }].concat(body.messages);
    payloadUsed = p2;
    up = await upstreamChat(p2);
  }

  if (up.status !== 200) {
    let msg = "upstream HTTP " + up.status;
    try {
      const e = JSON.parse(up.body);
      if (e && e.error && e.error.message) msg = e.error.message;
    } catch (_) {}
    return { ok: false, status: up.status >= 400 && up.status < 600 ? up.status : 502, message: msg, type: "upstream_error" };
  }

  let parsed;
  try {
    parsed = JSON.parse(up.body);
  } catch (_) {
    return { ok: false, status: 502, message: "upstream returned non-JSON", type: "upstream_error" };
  }

  let norm = normalizeUpstream(parsed);

  if (!norm.content && !norm.toolCalls && hadTools) {
    const p2 = buildPayload({ ...body, tools: undefined, tool_choice: undefined }, false);
    payloadUsed = p2;
    const up2 = await upstreamChat(p2);
    if (up2.status === 200) {
      try {
        const p = JSON.parse(up2.body);
        const n2 = normalizeUpstream(p);
        if (n2.content || n2.toolCalls) {
          parsed = p;
          norm = n2;
        }
      } catch (_) {}
    }
  }

  if (body.response_format && body.response_format.type === "json_object" && norm.content) {
    norm.content = extractJson(norm.content);
  } else if (norm.content && /```json[\s\S]*```/.test(norm.content)) {
    const ex = extractJson(norm.content);
    if (ex !== norm.content) norm.content = ex;
  }

  const message = { role: "assistant", content: norm.toolCalls ? norm.content || "" : norm.content };
  if (norm.reasoning) message.reasoning_content = norm.reasoning;
  if (norm.toolCalls) message.tool_calls = norm.toolCalls;

  let usage = parsed.usage;
  if (!usage || typeof usage.total_tokens !== "number") {
    const promptChars = JSON.stringify(payloadUsed.messages).length;
    const outChars = norm.content.length + norm.reasoning.length;
    usage = {
      prompt_tokens: Math.ceil(promptChars / 4),
      completion_tokens: Math.ceil(outChars / 4),
      total_tokens: Math.ceil(promptChars / 4) + Math.ceil(outChars / 4),
      estimated: true,
    };
  }

  const response = {
    id: parsed.id || "chatcmpl-bridge-" + crypto.randomBytes(8).toString("hex"),
    object: "chat.completion",
    created: parsed.created || Math.floor(Date.now() / 1000),
    model: wantModel,
    choices: [
      {
        index: 0,
        message: message,
        finish_reason: norm.toolCalls ? "tool_calls" : norm.finish || "stop",
      },
    ],
    usage: usage,
  };

  log("INFO", "CHAT_OK", { transport, ms: Date.now() - t0, model: wantModel });
  return { ok: true, response: response };
}

async function chatStream(body, req, res, transport) {
  const t0 = Date.now();
  const wantModel = resolveRequestModel(body.model);
  const payload = buildPayload(body, true);
  const bodyStr = JSON.stringify(payload);
  const stamp = "chatcmpl-bridge-" + crypto.randomBytes(8).toString("hex");
  const now = Math.floor(Date.now() / 1000);

  const targetUrl = new URL(UPSTREAM_BASE + "/v1/chat/completions");

  const upReq = http.request(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 443,
      path: targetUrl.pathname,
      method: "POST",
      timeout: CFG.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    },
    (upRes) => {
      if (upRes.statusCode !== 200) {
        let buf = "";
        upRes.on("data", (d) => (buf += d));
        upRes.on("end", () => {
          let msg = "upstream HTTP " + upRes.statusCode;
          try {
            const e = JSON.parse(buf);
            if (e && e.error && e.error.message) msg = e.error.message;
          } catch (_) {}
          openaiError(req, res, upRes.statusCode >= 400 && upRes.statusCode < 600 ? upRes.statusCode : 502, msg, "upstream_error");
        });
        return;
      }

      cors(req, res);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const filter = makeThinkFilter();
      let sawDone = false;
      let buf = "";

      const finish = () => {
        if (!sawDone) {
          try {
            res.write("data: [DONE]\n\n");
          } catch (_) {}
        }
        try {
          res.end();
        } catch (_) {}
        log("INFO", "CHAT_STREAM_OK", { transport, ms: Date.now() - t0 });
      };

      upRes.setEncoding("utf8");
      upRes.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(":") || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            sawDone = true;
            try {
              res.write("data: [DONE]\n\n");
            } catch (_) {}
            continue;
          }
          let obj;
          try {
            obj = JSON.parse(data);
          } catch (_) {
            continue;
          }
          obj.id = obj.id || stamp;
          obj.created = obj.created || now;
          obj.model = obj.model || wantModel;
          if (obj.choices && obj.choices[0] && obj.choices[0].delta) {
            const d = obj.choices[0].delta;
            if (typeof d.content === "string" && d.content.length) {
              const out = filter.push(d.content);
              const hasOther = !!d.role || (Array.isArray(d.tool_calls) && d.tool_calls.length);
              if (!out && !hasOther) continue;
              d.content = out;
            }
          }
          try {
            res.write("data: " + JSON.stringify(obj) + "\n\n");
          } catch (_) {}
        }
      });
      upRes.on("end", finish);
      upRes.on("error", finish);
    }
  );

  upReq.on("timeout", () => upReq.destroy(new Error("upstream_timeout")));
  upReq.on("error", (e) => openaiError(req, res, 502, "upstream: " + e.message, "upstream_error"));
  req.on("aborted", () => {
    try {
      upReq.destroy();
    } catch (_) {}
  });
  upReq.write(bodyStr);
  upReq.end();
}

// ── Main HTTP Request Handler ─────────────────────────────────
async function handler(req, res) {
  const isUDS = !!(req.socket && req.socket._isBridgeUDS);
  const transport = isUDS ? "uds" : "tcp";
  const url = (req.url || "/").split("?")[0];

  if (req.method === "OPTIONS") {
    cors(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    if (CFG.backend === "ollama" && MODEL_STATE.installed.length === 0) {
      await refreshModelState();
    }
    const h = await upstreamHealth();
    cors(req, res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: h.ok ? "ok" : "degraded",
        bridge: "local-llm-bridge",
        backend: CFG.backend,
        model: CFG.model,
        configured_model: MODEL_STATE.configured,
        model_source: MODEL_STATE.source,
        installed_models: MODEL_STATE.installed,
        model_error: MODEL_STATE.error || undefined,
        upstream: { base: UPSTREAM_BASE, ready: h.ok },
        transports: { unix_socket: CFG.socket, tcp: "127.0.0.1:" + CFG.port },
      })
    );
    return;
  }

  if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
    const ids = MODEL_STATE.installed.length
      ? MODEL_STATE.installed.slice()
      : [CFG.model];
    if (!ids.includes(CFG.model)) ids.unshift(CFG.model);
    cors(req, res);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "local-llm-bridge",
          permission: [],
          root: CFG.gguf ? path.basename(CFG.gguf) : id,
          parent: null,
        })),
      })
    );
    return;
  }

  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      log("WARN", "READ_BODY_FAIL", { error: e.message });
      openaiError(req, res, 400, "failed to read request body", "invalid_request_error");
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (_) {
      log("WARN", "JSON_PARSE_FAIL", { bodyHead: raw.slice(0, 100) });
      openaiError(req, res, 400, "invalid JSON payload", "invalid_request_error");
      return;
    }

    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      openaiError(req, res, 400, "'messages' must be a non-empty array", "invalid_request_error");
      return;
    }

    if (body.stream) {
      await chatStream(body, req, res, transport);
    } else {
      const resData = await chatNonStream(body, transport);
      if (!resData.ok) {
        openaiError(req, res, resData.status, resData.message, resData.type);
        return;
      }
      cors(req, res);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resData.response));
    }
    return;
  }

  openaiError(req, res, 404, "route not found: " + req.method + " " + url, "invalid_request_error");
}

// ── Application Lifecycle ─────────────────────────────────────
function cleanupSocket() {
  if (CFG.socket && fs.existsSync(CFG.socket)) {
    try {
      fs.unlinkSync(CFG.socket);
    } catch (_) {}
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  cleanupSocket();
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log("ERROR", "UNCAUGHT_EXCEPTION", { error: err.message });
});

async function main() {
  log("INFO", "STARTING local-llm-bridge", {
    backend: CFG.backend,
    model: CFG.model,
    port: CFG.port,
    socket: CFG.socket,
  });

  if (CFG.backend === "llama") {
    spawnLlamaServer();
    await waitUpstreamReady(30000);
  } else {
    await refreshModelState();
  }

  const tcpServer = http.createServer(handler);
  tcpServer.listen(CFG.port, "127.0.0.1", () => {
    log("INFO", "TCP_SERVER_LISTENING", { host: "127.0.0.1", port: CFG.port });
  });

  cleanupSocket();
  const udsServer = http.createServer(handler);
  udsServer.on("connection", (socket) => {
    socket._isBridgeUDS = true;
  });
  udsServer.listen(CFG.socket, () => {
    try {
      fs.chmodSync(CFG.socket, CFG.socketMode);
    } catch (_) {}
    log("INFO", "UDS_SERVER_LISTENING", { socket: CFG.socket });
  });
}

main().catch((err) => {
  log("ERROR", "FATAL_MAIN", { error: err.message });
  shutdown();
});