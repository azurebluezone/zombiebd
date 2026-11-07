"use strict";
/*
 * E2E: reset the live gateway, map every agent to one live model, call each
 * agent over all six inbound transports, then run a create-bug/fix-bug task
 * inside the client workspace. Evidence comes from server logs and real
 * command output; a transport response is not proof that a tool ran.
 *
 * Run: node tests/agent-transport-e2e.js [--no-reset]
 * Gate: node tests/agent-transport-e2e-verify.js
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const http2 = require("http2");
const crypto = require("crypto");
const { spawn, execFileSync, spawnSync } = require("child_process");
const pb = require("../transport/protobuf.js");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "logs", "e2e");
const WORK_DIR = process.env.E2E_WORK_DIR || "/home/sahon/Videos/test";
const AGENT_IDS = [
  "security-hero",
  "perf-wizard",
  "doc-king",
  "qa-tyrant",
  "team-heart",
  "customer-experience-specialist",
  "ecommerce-operations-analyst",
  "bug-hunter",
  "code-guru",
];
const TRANSPORTS = ["http", "https", "uds", "stdio", "grpc", "websocket"];
const MATRIX_MODEL = process.env.E2E_MATRIX_MODEL || "gemini-2.5-flash-lite";
const TASK_MODEL = process.env.E2E_TASK_MODEL || "gemini-2.5-flash-lite";
const MATRIX_PROMPT = "Reply with exactly: OK";
const GAP_MS = Number(process.env.E2E_GAP_MS || 4500);
const MAX_ATTEMPTS = 5;
const NO_RESET = process.argv.includes("--no-reset");

const state = {
  startedAt: new Date().toISOString(),
  workDir: WORK_DIR,
  matrixModel: MATRIX_MODEL,
  taskModel: TASK_MODEL,
  reset: null,
  mapping: null,
  matrix: [],
  bug: null,
  evidence: null,
  error: null,
};

function envFile() {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    const key = s.slice(0, i).trim();
    let val = s.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const ENV = Object.assign({}, envFile(), process.env);
const ADMIN_KEY =
  ENV.ADMIN_API_KEY || ENV.MCP_ADMIN_TOKEN || ENV.ADMIN_TOKEN || "";
const PORT = Number(ENV.PORT || 5050);
const UDS = String(ENV.UDS || "/tmp/zombiecoder/mcp.sock")
  .split(",")[0]
  .trim();
const HTTPS_PORT = Number(ENV.CADDY_HTTPS_PORT || 443);
const GRPC_PORT = Number(ENV.GRPC_PORT || 5052);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function log(msg) {
  console.log("[e2e] " + msg);
}
function isRateLimit(text) {
  return /rate.?limit|429|too many requests/i.test(String(text || ""));
}
function isFallbackContent(text) {
  const s = String(text == null ? "" : text).trim();
  return s.length === 0 || /^no response$/i.test(s);
}
function retryMs(text) {
  const m = String(text || "").match(/retry in\s+(\d+)\s*s/i);
  return (m ? Number(m[1]) * 1000 : 5000) + 1500;
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}
function readProcCwd(pid) {
  try {
    return fs.readlinkSync("/proc/" + pid + "/cwd");
  } catch (_) {
    return "";
  }
}
function findServerPid() {
  const pidFile = path.join(OUT_DIR, "server.pid");
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (pid && isAlive(pid) && readProcCwd(pid) === ROOT) return pid;
  }
  let raw = "";
  try {
    raw = execFileSync("pgrep", ["-f", "node start.js --start-all -s"], {
      encoding: "utf8",
    });
  } catch (_) {
    return null;
  }
  for (const pid of raw
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter(Boolean)) {
    if (readProcCwd(pid) === ROOT) return pid;
  }
  return null;
}
function latestServerLog() {
  const files = fs
    .readdirSync(path.join(ROOT, "logs"))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  return files.length ? path.join(ROOT, "logs", files[files.length - 1]) : null;
}
function httpJson(opts) {
  return new Promise((resolve, reject) => {
    const lib = opts.protocol === "https" ? https : http;
    const reqOpts = {
      method: opts.method || "GET",
      headers: opts.headers || {},
      timeout: opts.timeoutMs || 90000,
    };
    if (opts.socketPath) {
      reqOpts.socketPath = opts.socketPath;
      reqOpts.path = opts.path;
      reqOpts.host = "localhost";
    } else {
      reqOpts.hostname = opts.host;
      reqOpts.port = opts.port;
      reqOpts.path = opts.path;
    }
    if (opts.protocol === "https") reqOpts.rejectUnauthorized = false;
    const req = lib.request(reqOpts, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, raw }),
      );
    });
    req.on("timeout", () =>
      req.destroy(new Error("request timeout after " + reqOpts.timeout + "ms")),
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
function admin(method, urlPath, body) {
  const payload = body ? JSON.stringify(body) : "";
  return httpJson({
    host: "127.0.0.1",
    port: PORT,
    path: urlPath,
    method,
    headers: Object.assign(
      { "x-api-key": ADMIN_KEY },
      payload
        ? {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          }
        : {},
    ),
    body: payload,
  }).then((r) => {
    let parsed = null;
    try {
      parsed = JSON.parse(r.raw);
    } catch (_) {
      parsed = { raw: r.raw.slice(0, 400) };
    }
    if (r.status < 200 || r.status >= 300) {
      throw new Error(
        "admin " + method + " " + urlPath + " -> " + r.status + " " +
          JSON.stringify(parsed).slice(0, 300),
      );
    }
    return parsed;
  });
}
function parseOpenAI(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch (_) {
    return { ok: false, error: "non-JSON response: " + raw.slice(0, 200) };
  }
  if (d.error) {
    return { ok: false, error: String(d.error.message || JSON.stringify(d.error)) };
  }
  const content = d.choices?.[0]?.message?.content;
  return {
    ok: typeof content === "string" && !isFallbackContent(content),
    content: typeof content === "string" ? content : "",
    agent: d.agent?.id || null,
    status: d.agent ? 200 : 200,
    usage: d.usage || null,
  };
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const r = await httpJson({
        host: "127.0.0.1",
        port: PORT,
        path: "/health",
        method: "GET",
        timeoutMs: 3000,
      });
      if (r.status === 200) {
        const d = JSON.parse(r.raw);
        if (d.agents === AGENT_IDS.length) {
          return { ok: true, status: r.status, body: d };
        }
        last = "agents=" + d.agents;
      } else {
        last = "status=" + r.status;
      }
    } catch (e) {
      last = e.message;
    }
    await sleep(500);
  }
  return { ok: false, error: "health timeout: " + last };
}

async function resetGateway() {
  const result = {
    performed: false,
    at: new Date().toISOString(),
    old_pid: null,
    new_pid: null,
    forced: false,
    health: null,
    log_file: null,
    log_offset: 0,
  };
  if (NO_RESET) {
    result.skipped = true;
    log("reset skipped (--no-reset)");
    return result;
  }
  const pid = findServerPid();
  if (!pid) throw new Error("could not find the live start.js server for " + ROOT);
  result.old_pid = pid;
  result.log_file = latestServerLog();
  result.log_offset = result.log_file ? fs.statSync(result.log_file).size : 0;
  log("resetting server pid=" + pid + " log=" + result.log_file +
      " offset=" + result.log_offset);

  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 25000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(250);
  if (isAlive(pid)) {
    result.forced = true;
    process.kill(pid, "SIGKILL");
    while (isAlive(pid) && Date.now() < deadline) await sleep(250);
  }
  if (isAlive(pid)) throw new Error("server pid " + pid + " did not exit");

  if (fs.existsSync(UDS)) {
    try {
      fs.unlinkSync(UDS);
    } catch (_) {}
  }
  const outFile = path.join(OUT_DIR, "server-restart.out");
  const fd = fs.openSync(outFile, "a");
  const child = spawn(process.execPath, ["start.js", "--start-all", "-s"], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  result.new_pid = child.pid;
  result.performed = true;
  fs.writeFileSync(path.join(OUT_DIR, "server.pid"), String(child.pid) + "\n");
  const health = await waitForHealth(120000);
  result.health = health;
  if (!health.ok) {
    let tail = "";
    try {
      tail = fs.readFileSync(outFile, "utf8").slice(-2000);
    } catch (_) {}
    throw new Error("new server did not become healthy: " + JSON.stringify(health) +
      " tail=" + tail.slice(-600));
  }
  log("reset ok old=" + pid + " new=" + child.pid + " agents=" + health.body.agents);
  return result;
}

function openAIBody(agentId, prompt, opts) {
  const o = opts || {};
  return JSON.stringify({
    model: "agent/" + agentId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: o.maxTokens || 64,
    temperature: 0,
    stream: false,
    ...(o.tools ? { tools: o.tools } : {}),
  });
}
function headersFor(body, opts) {
  const h = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  };
  if (opts && opts.workDir) h["x-working-dir"] = opts.workDir;
  return h;
}

async function callHttp(agentId, prompt, opts) {
  const o = opts || {};
  const body = openAIBody(agentId, prompt, o);
  const t0 = Date.now();
  const r = await httpJson({
    host: "127.0.0.1",
    port: PORT,
    path: "/v1/chat/completions",
    method: "POST",
    headers: headersFor(body, o),
    body,
    timeoutMs: o.timeoutMs || 120000,
  });
  return Object.assign(parseOpenAI(r.raw), {
    http_status: r.status,
    elapsed_ms: Date.now() - t0,
  });
}

async function callHttps(agentId, prompt, opts) {
  const o = opts || {};
  const body = openAIBody(agentId, prompt, o);
  const t0 = Date.now();
  const r = await httpJson({
    protocol: "https",
    host: "localhost",
    port: HTTPS_PORT,
    path: "/v1/chat/completions",
    method: "POST",
    headers: headersFor(body, o),
    body,
    timeoutMs: o.timeoutMs || 120000,
  });
  return Object.assign(parseOpenAI(r.raw), {
    http_status: r.status,
    elapsed_ms: Date.now() - t0,
  });
}

async function callUds(agentId, prompt, opts) {
  const o = opts || {};
  const body = openAIBody(agentId, prompt, o);
  const t0 = Date.now();
  const r = await httpJson({
    socketPath: UDS,
    path: "/v1/chat/completions",
    method: "POST",
    headers: headersFor(body, o),
    body,
    timeoutMs: o.timeoutMs || 120000,
  });
  return Object.assign(parseOpenAI(r.raw), {
    http_status: r.status,
    elapsed_ms: Date.now() - t0,
  });
}

function callStdio(agentId, prompt, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["transport/stdio-openai.js"], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        OPENAI_UDS_PATH: "",
        UDS: "",
        OPENAI_BASE_URL: "http://127.0.0.1:" + PORT,
      }),
    });
    let buf = "";
    let settled = false;
    const t0 = Date.now();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch (_) {}
      resolve(Object.assign({ elapsed_ms: Date.now() - t0 }, r));
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "stdio timeout" }),
      o.timeoutMs || 120000,
    );
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_) {
          continue;
        }
        if (msg.response && msg.response.error) {
          finish({
            ok: false,
            error: String(
              msg.response.error.message || JSON.stringify(msg.response.error),
            ),
          });
        } else if (msg.response) {
          const d = msg.response;
          const content = d.choices?.[0]?.message?.content || "";
          finish({
            ok: typeof content === "string" && !isFallbackContent(content),
            content: typeof content === "string" ? content : "",
            agent: d.agent?.id || null,
          });
        } else if (msg.error) {
          finish({ ok: false, error: String(msg.error.message || JSON.stringify(msg.error)) });
        }
      }
    });
    const payload = {
      model: "agent/" + agentId,
      messages: [{ role: "user", content: prompt }],
      max_tokens: o.maxTokens || 64,
      stream: false,
    };
    child.stdin.write(JSON.stringify(payload) + "\n");
  });
}

function callGrpc(agentId, prompt, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    const client = http2.connect("http://127.0.0.1:" + GRPC_PORT);
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch (_) {}
      resolve(Object.assign({ elapsed_ms: Date.now() - t0 }, r));
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "grpc timeout" }),
      o.timeoutMs || 120000,
    );
    const req = client.request({
      ":method": "POST",
      ":path": "/zombie.v1.ChatService/Chat",
      "content-type": "application/grpc",
      te: "trailers",
    });
    let raw = Buffer.alloc(0);
    let headers = {};
    let trailers = {};
    req.on("response", (h) => (headers = h));
    req.on("trailers", (t) => (trailers = t));
    req.on("data", (c) => (raw = Buffer.concat([raw, c])));
    req.on("end", () => {
      const status = trailers["grpc-status"] ?? headers["grpc-status"];
      if (String(status) !== "0") {
        const msg =
          trailers["grpc-message"] || headers["grpc-message"] || "grpc failure";
        finish({ ok: false, error: decodeURIComponent(String(msg)) });
        return;
      }
      try {
        const { payload } = pb.unframe(raw);
        const d = pb.decodeChatResponse(payload);
        finish({
          ok: typeof d.content === "string" && !isFallbackContent(d.content),
          content: d.content || "",
          agent: null,
          finish_reason: d.finish_reason,
        });
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
    });
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.end(
      pb.frame(
        pb.encodeChatRequest({
          model: "agent/" + agentId,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          temperature: 0,
        }),
      ),
    );
  });
}

function callWs(agentId, prompt, opts) {
  const o = opts || {};
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return new Promise((resolve) => {
    const t0 = Date.now();
    const frames = [];
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch (_) {}
      resolve(Object.assign({ elapsed_ms: Date.now() - t0, frames }, r));
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "ws timeout" }),
      o.timeoutMs || 120000,
    );
    const socket = new WebSocket("wss://localhost/ws");
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "chat",
          id: "e2e-" + crypto.randomUUID(),
          message: prompt,
          agent_id: agentId,
          model: "agent/" + agentId,
          session_id: "e2e-" + crypto.randomUUID(),
        }),
      );
    };
    socket.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch (_) {
        return;
      }
      frames.push(msg.type);
      if (msg.type === "response_done") {
        const content = msg.data?.content || "";
        finish({
          ok: typeof content === "string" && !isFallbackContent(content),
          content: typeof content === "string" ? content : "",
          error:
            typeof content === "string" && isFallbackContent(content)
              ? "agent returned fallback: " + JSON.stringify(String(content))
              : null,
          agent: msg.usage?.agent_id || null,
          usage: msg.usage || null,
          verification: msg.verification || null,
        });
      } else if (msg.type === "error") {
        finish({ ok: false, error: String(msg.error || JSON.stringify(msg)) });
      }
    };
    socket.onerror = (e) =>
      finish({ ok: false, error: e.message || "ws connect error" });
  });
}

const CALLERS = {
  http: callHttp,
  https: callHttps,
  uds: callUds,
  stdio: callStdio,
  grpc: callGrpc,
  websocket: callWs,
};

const paceState = { last: 0 };
async function pace() {
  const wait = Math.max(0, paceState.last + GAP_MS - Date.now());
  if (wait) await sleep(wait);
  paceState.last = Date.now();
}
async function withRetry(label, fn) {
  let last = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await pace();
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (r.ok) return Object.assign({}, r, { attempts: attempt });
    last = r.error || "empty response";
    if (!isRateLimit(last) || attempt === MAX_ATTEMPTS) {
      return Object.assign({}, r, { ok: false, attempts: attempt, error: last });
    }
    const wait = retryMs(last);
    log("  retry " + label + " attempt=" + attempt + " wait=" + wait + "ms (" + last.slice(0, 120) + ")");
    await sleep(wait);
  }
  return { ok: false, attempts: MAX_ATTEMPTS, error: last };
}

function snapshotAgents() {
  return admin("GET", "/api/admin/agents").then((d) => d.agents || []);
}
async function mapAllAgents(model) {
  const before = await snapshotAgents();
  for (const a of before) {
    await admin("POST", "/api/admin/agents", { id: a.id, model });
  }
  await sleep(300);
  const after = await snapshotAgents();
  const all = after.length === AGENT_IDS.length &&
    after.every((a) => a.model === model && AGENT_IDS.includes(a.id));
  return { model, before, after, all_mapped: all };
}
async function restoreAgents(original) {
  for (const a of original) {
    await admin("POST", "/api/admin/agents", { id: a.id, model: a.model });
  }
  await sleep(300);
  const after = await snapshotAgents();
  return {
    after,
    restored: original.every((o) => after.some((a) => a.id === o.id && a.model === o.model)),
  };
}

function runPython(rel) {
  const r = spawnSync("python3", [rel], {
    cwd: WORK_DIR,
    encoding: "utf8",
    timeout: 30000,
  });
  return {
    exit: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
  };
}
function readWorkFile(rel) {
  try {
    return fs.readFileSync(path.join(WORK_DIR, rel), "utf8");
  } catch (_) {
    return null;
  }
}

const TASK_TOOLS = {
  write: {
    type: "function",
    function: {
      name: "write_file",
      description: "Write text content to a file path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  read: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  exec: {
    type: "function",
    function: {
      name: "exec",
      description: "Run a shell command and return stdout, stderr, exit code",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
};

const CREATOR_PROMPT = [
  "You are working inside " + WORK_DIR + ".",
  "Use write_file to create workspace/calculator.py.",
  "The file must contain an intentional bug: add(a, b) returns a - b instead of a + b.",
  "Include exactly this self-test at the bottom:",
  'if __name__ == "__main__":',
  "    result = add(2, 3)",
  "    print(result)",
  '    assert result == 5, "expected 5"',
  "Then use exec to run: python3 workspace/calculator.py",
  "Report the command output and exit code. Do NOT fix the bug; the next agent will.",
].join("\n");

const SOLVER_PROMPT = [
  "You are working inside " + WORK_DIR + ".",
  "workspace/calculator.py is broken: python3 workspace/calculator.py exits non-zero.",
  "Use read_file to read it, fix the defect with write_file, then use exec to run:",
  "python3 workspace/calculator.py",
  "The program must print exactly 5 and exit 0. Report the final command output.",
].join("\n");

async function runBugTask() {
  const dir = path.join(WORK_DIR, "workspace");
  const file = path.join(dir, "calculator.py");
  const out = {
    dir,
    creator: { agent: "code-guru", attempts: [] },
    solver: { agent: "bug-hunter", attempts: [] },
    run_before: null,
    run_after: null,
    fixed: false,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await pace();
    const r = await withRetry("creator", () =>
      callHttp("code-guru", CREATOR_PROMPT, {
        workDir: WORK_DIR,
        maxTokens: 900,
        tools: [TASK_TOOLS.write, TASK_TOOLS.exec],
      }),
    );
    const body = readWorkFile("workspace/calculator.py");
    const run = body ? runPython("workspace/calculator.py") : null;
    const wrote = !!body;
    const buggy = !!run && run.exit !== 0;
    out.creator.attempts.push({
      attempt,
      ok: !!r.ok,
      content: String(r.content || "").slice(0, 4000),
      error: r.error || null,
      attempts: r.attempts,
      wrote,
      run,
    });
    log(
      "creator attempt=" + attempt + " ok=" + r.ok + " wrote=" + wrote +
        " exit=" + (run ? run.exit : "n/a"),
    );
    if (wrote && buggy) break;
  }

  const bodyBefore = readWorkFile("workspace/calculator.py");
  out.run_before = bodyBefore ? runPython("workspace/calculator.py") : null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    await pace();
    const r = await withRetry("solver", () =>
      callHttp("bug-hunter", SOLVER_PROMPT, {
        workDir: WORK_DIR,
        maxTokens: 900,
        tools: [TASK_TOOLS.read, TASK_TOOLS.write, TASK_TOOLS.exec],
      }),
    );
    const run = runPython("workspace/calculator.py");
    const fixed = run.exit === 0 && run.stdout.trim() === "5";
    out.solver.attempts.push({
      attempt,
      ok: !!r.ok,
      content: String(r.content || "").slice(0, 4000),
      error: r.error || null,
      attempts: r.attempts,
      run,
    });
    log("solver attempt=" + attempt + " ok=" + r.ok + " run=" + JSON.stringify(run));
    if (fixed) break;
  }

  out.file_before = bodyBefore;
  out.file_after = readWorkFile("workspace/calculator.py");
  out.run_after = out.file_after ? runPython("workspace/calculator.py") : null;
  out.fixed = !!(
    out.run_before &&
    out.run_before.exit !== 0 &&
    out.run_after &&
    out.run_after.exit === 0 &&
    out.run_after.stdout.trim() === "5"
  );
  return out;
}

function collectLogWindow(reset) {
  const parts = [];
  if (!reset || !reset.log_file) return "";
  const resetTime = reset.at ? Date.parse(reset.at) : 0;
  const files = fs
    .readdirSync(path.join(ROOT, "logs"))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort();
  for (const f of files) {
    const full = path.join(ROOT, "logs", f);
    const st = fs.statSync(full);
    if (st.mtimeMs + 1000 < resetTime) continue;
    const text = fs.readFileSync(full, "utf8");
    if (full === reset.log_file) parts.push(text.slice(reset.log_offset));
    else parts.push(text);
  }
  return parts.join("");
}

function parseEvents(windowText) {
  const events = [];
  for (const line of windowText.split(/\r?\n/)) {
    const m = line.match(/\[[^\]]+\]\s+\[(\w+)\]\s+\[([A-Z0-9_]+)\]\s+(.*)$/);
    if (!m) continue;
    const name = m[2];
    if (
      !/^(SINGLE_AGENT_|MCP_CALL|CHAT_WORKDIR|TOOL_LOOP|HANDLE_MESSAGE_COMPLETE|GRPC_|WS_|SERVER_|START_)/.test(
        name,
      )
    ) {
      continue;
    }
    let data = null;
    try {
      data = JSON.parse(m[3]);
    } catch (_) {
      data = m[3].slice(0, 300);
    }
    events.push({ level: m[1], name, data });
  }
  return events;
}

function summarizeEvents(events) {
  const s = {
    single_agent_start: 0,
    single_agent_complete: 0,
    single_agent_fail: 0,
    mcp_write_file: 0,
    mcp_read_file: 0,
    mcp_exec: 0,
    chat_workdir: 0,
    tool_loop_no_calls: 0,
    handle_message_complete: 0,
  };
  for (const e of events) {
    if (e.name === "SINGLE_AGENT_START") s.single_agent_start++;
    if (e.name === "SINGLE_AGENT_COMPLETE") s.single_agent_complete++;
    if (e.name === "SINGLE_AGENT_FAIL") s.single_agent_fail++;
    if (e.name === "CHAT_WORKDIR") s.chat_workdir++;
    if (e.name === "TOOL_LOOP_NO_TOOL_CALLS") s.tool_loop_no_calls++;
    if (e.name === "HANDLE_MESSAGE_COMPLETE") s.handle_message_complete++;
    if (e.name === "MCP_CALL" && e.data) {
      if (e.data.tool === "write_file") s.mcp_write_file++;
      if (e.data.tool === "read_file") s.mcp_read_file++;
      if (e.data.tool === "exec") s.mcp_exec++;
    }
  }
  return s;
}

function buildReport(results) {
  const failed = results.matrix.filter((m) => !m.ok);
  const byTransport = {};
  for (const t of TRANSPORTS) {
    const rows = results.matrix.filter((m) => m.transport === t);
    byTransport[t] = {
      total: rows.length,
      passed: rows.filter((m) => m.ok).length,
      failed: rows.filter((m) => !m.ok).length,
      avg_ms: Math.round(
        rows.reduce((a, m) => a + (m.elapsed_ms || 0), 0) / (rows.length || 1),
      ),
    };
  }
  const lines = [];
  lines.push("# Agent transport E2E proof");
  lines.push("");
  lines.push("- Started: " + results.startedAt);
  lines.push("- Finished: " + results.finishedAt);
  lines.push("- Workspace: `" + results.workDir + "`");
  lines.push("- Server: pid `" + (results.reset.new_pid || "n/a") +
    "` (old pid `" + (results.reset.old_pid || "n/a") + "`)");
  lines.push("- Health: " + (results.reset.health && results.reset.health.ok ? "healthy, agents=" + results.reset.health.body.agents : "FAILED"));
  lines.push("- Matrix model: `" + results.matrixModel + "`");
  lines.push("- Task model: `" + results.taskModel + "`");
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| transport | calls | pass | fail | avg ms |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const t of TRANSPORTS) {
    const b = byTransport[t];
    lines.push("| " + t + " | " + b.total + " | " + b.passed + " | " + b.failed + " | " + b.avg_ms + " |");
  }
  lines.push("");
  lines.push("Total: " + results.matrix.length + " calls, " +
    (results.matrix.length - failed.length) + " passed, " + failed.length + " failed.");
  lines.push("");
  if (failed.length) {
    lines.push("### Failed calls");
    for (const f of failed) {
      lines.push("- `" + f.transport + " / " + f.agent + "`: " + (f.error || "empty content"));
    }
    lines.push("");
  }
  lines.push("## Bug create/fix task");
  lines.push("");
  lines.push("- Creator: `" + results.bug.creator.agent + "`");
  lines.push("- Solver: `" + results.bug.solver.agent + "`");
  lines.push("- Before: exit=" + (results.bug.run_before ? results.bug.run_before.exit : "n/a") +
    ", stdout=" + JSON.stringify(results.bug.run_before ? results.bug.run_before.stdout : null));
  lines.push("- After: exit=" + (results.bug.run_after ? results.bug.run_after.exit : "n/a") +
    ", stdout=" + JSON.stringify(results.bug.run_after ? results.bug.run_after.stdout : null));
  lines.push("- Fixed: " + (results.bug.fixed ? "yes" : "no"));
  lines.push("");
  lines.push("### Final calculator.py");
  lines.push("```python");
  lines.push((results.bug.file_after || "").slice(0, 4000));
  lines.push("```");
  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  lines.push("- Server window: `logs/e2e/server-window.log`");
  lines.push("- Agent events: `logs/e2e/agent-events.log`");
  lines.push("- Result JSON: `logs/e2e/e2e-results.json`");
  lines.push("- Event counts: `" + JSON.stringify(results.evidence.counts) + "`");
  lines.push("");
  lines.push("## Gate");
  lines.push("");
  lines.push("```");
  lines.push("node tests/agent-transport-e2e-verify.js");
  lines.push("```");
  lines.push("");
  return lines.join("\n") + "\n";
}

async function main() {
  ensureDir(OUT_DIR);
  ensureDir(WORK_DIR);
  if (!ADMIN_KEY) throw new Error("ADMIN_API_KEY missing from .env");
  if (!fs.existsSync(UDS)) log("warning: UDS path does not exist yet: " + UDS);
  log("workspace=" + WORK_DIR + " matrixModel=" + MATRIX_MODEL +
      " taskModel=" + TASK_MODEL);

  const originalFile = path.join(OUT_DIR, "original-models.json");
  const original = fs.existsSync(originalFile)
    ? JSON.parse(fs.readFileSync(originalFile, "utf8")).agents
    : null;

  state.reset = await resetGateway();

  const families = await snapshotAgents();
  writeJson(path.join(OUT_DIR, "agents-at-start.json"), { agents: families });
  if (!original) {
    writeJson(originalFile, { agents: families });
    log("saved original model snapshot (" + families.length + " agents)");
  }

  state.mapping = await mapAllAgents(MATRIX_MODEL);
  writeJson(path.join(OUT_DIR, "agents-mapped.json"), {
    model: MATRIX_MODEL,
    agents: state.mapping.after,
  });
  log("mapped=" + state.mapping.all_mapped + " model=" + MATRIX_MODEL);
  if (!state.mapping.all_mapped) {
    throw new Error("model mapping did not apply to all " + AGENT_IDS.length + " agents");
  }

  log("matrix: " + AGENT_IDS.length + " agents x " + TRANSPORTS.length + " transports");
  for (const transport of TRANSPORTS) {
    for (const agent of AGENT_IDS) {
      const r = await withRetry(transport + "/" + agent, () =>
        CALLERS[transport](agent, MATRIX_PROMPT, {
          maxTokens: 16,
          workDir: transport === "http" || transport === "https" || transport === "uds"
            ? WORK_DIR
            : undefined,
        }),
      );
      const content = String(r.content || "");
      const ok = !!r.ok && !isFallbackContent(content) &&
        (!r.agent || r.agent === agent);
      state.matrix.push({
        transport,
        agent,
        ok,
        content: content.slice(0, 200),
        elapsed_ms: r.elapsed_ms || null,
        attempts: r.attempts || null,
        error: r.error || null,
        agent_echo: r.agent || null,
      });
      log(
        "[" + transport + "] " + agent + " " + (ok ? "PASS" : "FAIL") +
          " " + (ok ? JSON.stringify(content.slice(0, 24)) : String(r.error || "empty").slice(0, 120)),
      );
    }
  }

  const matrixPassed = state.matrix.filter((m) => m.ok).length;
  log("matrix done: " + matrixPassed + "/" + state.matrix.length);

  const taskMapping = {};
  for (const id of ["code-guru", "bug-hunter"]) {
    await admin("POST", "/api/admin/agents", { id, model: TASK_MODEL });
    taskMapping[id] = TASK_MODEL;
  }
  await sleep(300);
  const taskAgents = await snapshotAgents();
  state.mapping.task = {
    model: TASK_MODEL,
    agents: taskAgents.filter((a) => taskMapping[a.id]),
  };
  log("task mapping: code-guru, bug-hunter -> " + TASK_MODEL);

  try {
    state.bug = await runBugTask();
  } finally {
    if (original) {
      const restored = await restoreAgents(original);
      state.mapping.restore = restored;
      log("restored original models=" + restored.restored);
    }
  }

  state.evidence = { log_file: state.reset.log_file, offset: state.reset.log_offset };
  const windowText = collectLogWindow(state.reset);
  const windowFile = path.join(OUT_DIR, "server-window.log");
  fs.writeFileSync(windowFile, windowText);
  const events = parseEvents(windowText);
  const eventsFile = path.join(OUT_DIR, "agent-events.log");
  fs.writeFileSync(
    eventsFile,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  state.evidence.counts = summarizeEvents(events);
  state.evidence.window_bytes = Buffer.byteLength(windowText);
  state.evidence.event_count = events.length;
  state.evidence.server_window_path = windowFile;
  state.evidence.agent_events_path = eventsFile;
  state.evidence.has_write_file = events.some(
    (e) => e.name === "MCP_CALL" && e.data && e.data.tool === "write_file",
  );
  state.evidence.has_exec = events.some(
    (e) => e.name === "MCP_CALL" && e.data && e.data.tool === "exec",
  );
  state.evidence.has_read_file = events.some(
    (e) => e.name === "MCP_CALL" && e.data && e.data.tool === "read_file",
  );
  state.evidence.creator_start = events.some(
    (e) => e.name === "SINGLE_AGENT_START" && e.data && e.data.agent === "code-guru",
  );
  state.evidence.solver_start = events.some(
    (e) => e.name === "SINGLE_AGENT_START" && e.data && e.data.agent === "bug-hunter",
  );

  state.finishedAt = new Date().toISOString();
  const resultsFile = path.join(OUT_DIR, "e2e-results.json");
  writeJson(resultsFile, state);
  const report = buildReport(state);
  fs.writeFileSync(path.join(WORK_DIR, "E2E-REPORT.md"), report);
  fs.writeFileSync(path.join(WORK_DIR, "E2E-RESULTS.json"), JSON.stringify(state, null, 2) + "\n");
  fs.writeFileSync(path.join(ROOT, "docs", "E2E-REPORT-2026-11-06.md"), report);
  fs.writeFileSync(
    path.join(ROOT, "docs", "E2E-RESULTS-2026-11-06.json"),
    JSON.stringify(state, null, 2) + "\n",
  );

  const pass =
    state.matrix.length === AGENT_IDS.length * TRANSPORTS.length &&
    state.matrix.every((m) => m.ok) &&
    state.bug &&
    state.bug.fixed &&
    state.mapping.all_mapped;
  log(
    "result: " + (pass ? "PASS" : "FAIL") + " calls=" + state.matrix.length +
      " bug_fixed=" + (state.bug ? state.bug.fixed : "n/a") +
      " events=" + state.evidence.event_count,
  );
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  state.error = e && e.stack ? e.stack : String(e);
  state.finishedAt = new Date().toISOString();
  try {
    ensureDir(OUT_DIR);
    writeJson(path.join(OUT_DIR, "e2e-results.json"), state);
    fs.writeFileSync(
      path.join(WORK_DIR, "E2E-RESULTS.json"),
      JSON.stringify(state, null, 2) + "\n",
    );
  } catch (_) {}
  console.error("[e2e] FATAL: " + (e && e.message ? e.message : e));
  process.exit(1);
});
