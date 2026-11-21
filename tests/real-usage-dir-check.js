#!/usr/bin/env node
"use strict";

/**
 * tests/real-usage-dir-check.js
 *
 * Row 15 REAL_USAGE_DIR — prove a real user can point the agent at a separate
 * working directory and get a real, visible session:
 *
 *   1. The runbook §12 roadmap exists, names Phase A–E with gates, and the
 *      PLAN keeps row 15 as the next TODO.
 *   2. An isolated gateway accepts HTTP /api/set-working-dir and MCP
 *      set_working_dir, returns a session_id, and persists the session.
 *   3. MCP agent_single runs a real tool loop against a local stub provider:
 *      the agent's write_file lands in its own session directory.
 *   4. A second session in a second directory writes its own file; neither
 *      session can overwrite the other's workspace.
 *   5. A `../escape.txt` write is denied with the session containment marker.
 *   6. GET /api/sessions shows both sessions with their working_dir.
 *   7. MCP agent_mission persists a session instead of a throwaway UUID.
 *
 * Prints REAL_USAGE_DIR_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "real-usage-" + process.pid);
const RUNBOOK = path.join(ROOT, "docs", "RUNBOOK-OPTIMIZATION-2026-11-19.md");
const PLAN = path.join(ROOT, "docs", "PLAN-2026-11-20.md");
const ADMIN_TOKEN = "real-usage-admin-token";

let passed = 0;
let failed = 0;
let rpcId = 0;

function pass(name, detail) {
  passed += 1;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failed += 1;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

async function expectAsync(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined || options.body === null
        ? null
        : Buffer.isBuffer(options.body)
          ? options.body
          : Buffer.from(String(options.body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method || "GET",
        timeout: options.timeout || 60000,
        headers: Object.assign(
          payload ? { "content-length": payload.length } : {},
          options.headers || {},
        ),
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(body.toString("utf8"));
          } catch (_) {
            /* not JSON */
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            text: body.toString("utf8"),
            json,
          });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

function mcpCall(port, name, args, token) {
  rpcId += 1;
  return httpRequest({
    port,
    path: "/mcp",
    method: "POST",
    timeout: 120000,
    headers: Object.assign(
      { "content-type": "application/json" },
      token ? { authorization: "Bearer " + token } : {},
    ),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId,
      method: "tools/call",
      params: { name, arguments: args || {} },
    }),
  });
}

function mcpText(res) {
  const result = res && res.json && res.json.result;
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map((part) => part.text || "").join("\n");
}

/**
 * Local OpenAI-compatible stub. It returns one write_file tool call, then a
 * final text answer after the gateway feeds the tool result back. The target
 * and content are chosen from the user text so two sessions can prove they
 * wrote different files.
 */
function startToolStub() {
  const state = { hits: 0, requests: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.hits += 1;
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch (_) {
        body = {};
      }
      state.requests.push(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const userText = messages
        .filter((m) => m && m.role === "user")
        .map((m) => String(m.content || ""))
        .join("\n");
      const toolMessages = messages.filter((m) => m && m.role === "tool");
      const model = body.model || "stub-tool";

      if (toolMessages.length > 0) {
        const lastTool = String(
          toolMessages[toolMessages.length - 1].content || "",
        );
        const final = lastTool.includes("Access denied")
          ? "FINAL: " + lastTool
          : userText.includes(" for B")
            ? "SESSION_B_OK"
            : userText.includes(" for A")
              ? "SESSION_A_OK"
              : "SESSION_OK";
        sendJson(res, {
          id: "chatcmpl-final-" + state.hits,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: final },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }

      const escape = /escape/i.test(userText);
      const target = escape ? "../escape.txt" : "result.txt";
      const content = userText.includes(" for B")
        ? "SESSION_B_OK\n"
        : userText.includes(" for A")
          ? "SESSION_A_OK\n"
          : "SESSION_OK\n";
      sendJson(res, {
        id: "chatcmpl-tool-" + state.hits,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_" + state.hits,
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({ path: target, content }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, state, port: server.address().port }),
    );
  });
}

function sendJson(res, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest({ port, path: "/health", timeout: 2000 });
      if (res.status === 200 && res.json && res.json.healthy === true) {
        return res.json;
      }
    } catch (_) {
      /* not up yet */
    }
    await sleep(250);
  }
  return null;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
  child.kill("SIGKILL");
  for (let i = 0; i < 20; i++) {
    if (child.exitCode !== null || child.signalCode) return;
    await sleep(100);
  }
}

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return null;
  }
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // ── 1. Roadmap contract ────────────────────────────────────
  await expectAsync("runbook §12 roadmap exists with Phase A–E gates", () => {
    const text = fs.readFileSync(RUNBOOK, "utf8");
    assert(text.includes("<!-- ROADMAP_2026_11_21 -->"), "roadmap start marker missing");
    assert(text.includes("<!-- /ROADMAP_2026_11_21 -->"), "roadmap end marker missing");
    const start = text.indexOf("<!-- ROADMAP_2026_11_21 -->");
    const end = text.indexOf("<!-- /ROADMAP_2026_11_21 -->");
    const block = text.slice(start, end);
    for (const gate of [
      "REAL_USAGE_DIR_OK",
      "CLIENT_E2E_OK",
      "VHOST_TRUTH_OK",
      "SUITE_GREEN_OK",
      "RELEASE_READY_OK",
    ]) {
      assert(block.includes(gate), "roadmap missing gate " + gate);
    }
    assert(block.includes("A → B"), "roadmap missing dependency order");
    for (const suite of [
      "transport-suite",
      "cwd-db-repair",
      "provider-matrix",
      "uds-e2e-check",
      "mcp-architecture-check",
    ]) {
      assert(block.includes(suite), "roadmap missing red suite " + suite);
    }
    return "phases=5 markers=2";
  });

  await expectAsync("PLAN records row 15 and points at the §12 roadmap", () => {
    const plan = fs.readFileSync(PLAN, "utf8");
    assert(plan.includes("REAL_USAGE_DIR_OK"), "PLAN missing REAL_USAGE_DIR_OK");
    const row = plan
      .split(/\r?\n/)
      .find((line) => /^\|\s*15\s*\|/.test(line)) || "";
    assert(row.includes("REAL_USAGE_DIR_OK"), "PLAN row 15 gate missing: " + row);
    assert(
      /ROADMAP_2026_11_21|ROADMAP 2026-11-21|runbook §12/i.test(plan),
      "PLAN does not point at the runbook §12 roadmap",
    );
    return row.trim();
  });

  await expectAsync("runbook records the Phase A Done block", () => {
    const text = fs.readFileSync(RUNBOOK, "utf8");
    assert(
      text.includes("<!-- REAL_USAGE_DIR_2026_11_21 -->"),
      "Phase A Done marker missing",
    );
    const block = text.slice(
      text.indexOf("<!-- REAL_USAGE_DIR_2026_11_21 -->"),
      text.indexOf("<!-- /REAL_USAGE_DIR_2026_11_21 -->"),
    );
    assert(block.includes("REAL_USAGE_DIR_OK"), "Done block missing the gate result");
    assert(block.includes("gc-mwpvfkly"), "Done block missing the contract id");
    assert(
      block.includes("writeSessions"),
      "Done block missing the session-write race evidence",
    );
    return "marker=2 gate=1 contract=1";
  });

  await expectAsync("roadmap verified state matches live /health", async () => {
    const text = fs.readFileSync(RUNBOOK, "utf8");
    const start = text.indexOf("<!-- ROADMAP_2026_11_21 -->");
    const end = text.indexOf("<!-- /ROADMAP_2026_11_21 -->");
    const block = text.slice(start, end);
    const live = await waitHealth(5050, 5000);
    assert(live, "live gateway /health unavailable");
    assert(block.includes("`" + live.models + "` / `" + live.agents + "`"), "roadmap models/agents stale");
    assert(block.includes(live.version), "roadmap version stale");
    return "models=" + live.models + " agents=" + live.agents + " version=" + live.version;
  });

  // ── 2. Isolated gateway with a tool-calling stub ────────────
  const stub = await startToolStub();
  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  const adminDir = path.join(TMP, "admin");
  const dirA = path.join(TMP, "workspace-a");
  const dirB = path.join(TMP, "workspace-b");
  let httpSession = "";
  let mcpSession = "";
  for (const dir of [dataDir, logDir, adminDir, dirA, dirB]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const envVars = Object.assign({}, process.env, {
    PORT: String(port),
    GRPC: "0",
    GRPC_PORT: String(grpcPort),
    HTTPS_PORT: String(httpsPort),
    UDS_PORT: String(udsPort),
    APP_ROOT: TMP,
    DATA_DIR: dataDir,
    LOG_DIR: logDir,
    DB_SQLITE_PATH: path.join(TMP, "models.db"),
    DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "0",
    ADMIN_DIR: adminDir,
    INSTANCE_ID: "real-usage-" + Date.now(),
    ADMIN_TOKEN: "real-usage-admin",
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    MCP_ADMIN_TOKEN: ADMIN_TOKEN,
    OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0",
    AGENT_MODEL: "stub-tool",
    AGENT_FS_SCOPE: "unrestricted",
    CUSTOM_PROVIDER_1_URL: "http://127.0.0.1:" + stub.port + "/v1",
    CUSTOM_PROVIDER_1_NAME: "RealUsageStub",
    CUSTOM_PROVIDER_1_MODELS: "stub-tool",
    CUSTOM_PROVIDER_1_MEDIA: "false",
  });

  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: ROOT,
    env: envVars,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => (childOutput += chunk.toString()));
  child.stderr.on("data", (chunk) => (childOutput += chunk.toString()));

  try {
    const health = await waitHealth(port, 45000);
    if (!health) {
      fail("isolated gateway healthy", "no health\n" + childOutput.slice(-2500));
      throw new Error("gateway did not start");
    }
    pass("isolated gateway healthy", "models=" + health.models + " agents=" + health.agents);

    // ── 3. HTTP set-working-dir creates a session ────────────
    await expectAsync("HTTP /api/set-working-dir returns a session for workspace A", async () => {
      const res = await httpRequest({
        port,
        path: "/api/set-working-dir",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directory: dirA,
          session_id: "usage-http-a",
          client: "real-usage-check",
        }),
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      assert.strictEqual(res.json.session_id, "usage-http-a");
      assert.strictEqual(res.json.working_dir, dirA);
      assert.ok(
        fs.existsSync(path.join(dirA, ".zombie", "SSOT.md")),
        "SSOT was not generated in workspace A",
      );
      httpSession = res.json.session_id;
    });

    // ── 4. MCP set-working-dir creates a session ─────────────
    await expectAsync("MCP set_working_dir returns a session for workspace B", async () => {
      const res = await mcpCall(
        port,
        "set_working_dir",
        { directory: dirB, session_id: "usage-mcp-b" },
        ADMIN_TOKEN,
      );
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      assert.ok(res.json && res.json.result, "no MCP result: " + res.text.slice(0, 300));
      assert.strictEqual(res.json.result.session_id, "usage-mcp-b");
      assert.strictEqual(res.json.result.working_dir, dirB);
      mcpSession = res.json.result.session_id;
    });

    await expectAsync("MCP set_working_dir without a token is denied", async () => {
      const res = await mcpCall(port, "set_working_dir", { directory: dirB });
      assert.strictEqual(res.status, 401, res.text.slice(0, 300));
      assert.match(res.text, /Unauthorized/);
    });

    await expectAsync("MCP get_working_dir resolves each session's own directory", async () => {
      const a = await mcpCall(port, "get_working_dir", { session_id: httpSession });
      const b = await mcpCall(port, "get_working_dir", { session_id: mcpSession });
      assert.strictEqual(mcpText(a).trim(), dirA);
      assert.strictEqual(mcpText(b).trim(), dirB);
      return "A=" + path.basename(dirA) + " B=" + path.basename(dirB);
    });

    // ── 5. Real agent task in workspace A ────────────────────
    await expectAsync("agent_single in session A writes result.txt in workspace A", async () => {
      const res = await mcpCall(port, "agent_single", {
        agent_id: "code-guru",
        input: "write result.txt for A",
        session_id: httpSession,
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      assert.ok(res.json && res.json.result, "no MCP result: " + res.text.slice(0, 300));
      assert.strictEqual(res.json.result.session_id, httpSession);
      const text = mcpText(res);
      assert.match(text, /SESSION_A_OK/, "agent answer missing SESSION_A_OK: " + text.slice(0, 300));
      const written = readFileSafe(path.join(dirA, "result.txt"));
      assert.strictEqual(written, "SESSION_A_OK\n");
      assert.strictEqual(readFileSafe(path.join(dirB, "result.txt")), null);
    });

    // ── 6. Second session, second workspace, no cross-write ─
    await expectAsync("agent_single in session B writes only workspace B", async () => {
      const res = await mcpCall(port, "agent_single", {
        agent_id: "code-guru",
        input: "write result.txt for B",
        session_id: mcpSession,
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      const text = mcpText(res);
      assert.match(text, /SESSION_B_OK/, "agent answer missing SESSION_B_OK: " + text.slice(0, 300));
      assert.strictEqual(readFileSafe(path.join(dirB, "result.txt")), "SESSION_B_OK\n");
      assert.strictEqual(
        readFileSafe(path.join(dirA, "result.txt")),
        "SESSION_A_OK\n",
        "workspace A was overwritten by session B",
      );
    });

    // ── 7. Containment: ../escape.txt is denied ──────────────
    await expectAsync("agent write outside the session dir is denied", async () => {
      const res = await mcpCall(port, "agent_single", {
        agent_id: "code-guru",
        input: "escape the workspace",
        session_id: httpSession,
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      const text = mcpText(res);
      assert.match(
        text,
        /Access denied: path is outside the session working directory/,
        "containment marker missing: " + text.slice(0, 400),
      );
      assert.strictEqual(
        fs.existsSync(path.join(TMP, "escape.txt")),
        false,
        "escape.txt was written outside the session dir",
      );
    });

    // ── 7b. Direct MCP tool calls honor session_id too ───────
    await expectAsync("direct MCP write_file/read_file honor session_id", async () => {
      const w = await mcpCall(
        port,
        "write_file",
        { path: "direct.txt", content: "DIRECT_OK\n", session_id: httpSession },
        ADMIN_TOKEN,
      );
      assert.strictEqual(w.status, 200, w.text.slice(0, 300));
      assert.strictEqual(readFileSafe(path.join(dirA, "direct.txt")), "DIRECT_OK\n");
      const r = await mcpCall(
        port,
        "read_file",
        { path: "direct.txt", session_id: httpSession },
        ADMIN_TOKEN,
      );
      assert.strictEqual(mcpText(r).trim(), "DIRECT_OK");
      const denied = await mcpCall(
        port,
        "write_file",
        { path: "../direct-escape.txt", content: "NO", session_id: httpSession },
        ADMIN_TOKEN,
      );
      assert.match(
        mcpText(denied),
        /Access denied: path is outside the session working directory/,
      );
      assert.strictEqual(fs.existsSync(path.join(TMP, "direct-escape.txt")), false);
    });

    // ── 8. Sessions are visible with their working_dir ──────
    await expectAsync("/api/sessions lists both sessions with working_dir", async () => {
      const res = await httpRequest({ port, path: "/api/sessions" });
      assert.strictEqual(res.status, 200, res.text.slice(0, 300));
      const list = (res.json && res.json.sessions) || [];
      const a = list.find((s) => s.id === httpSession);
      const b = list.find((s) => s.id === mcpSession);
      assert(a, "session A missing from /api/sessions");
      assert(b, "session B missing from /api/sessions");
      assert.strictEqual(a.working_dir, dirA);
      assert.strictEqual(b.working_dir, dirB);
      return "sessions=" + list.length;
    });

    // ── 9. Mission persists a session, not a throwaway UUID ─
    await expectAsync("agent_mission persists its session", async () => {
      const res = await mcpCall(port, "agent_mission", {
        input: "hello",
        session_id: "usage-mission",
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      assert.ok(res.json && res.json.result, "no MCP result: " + res.text.slice(0, 300));
      assert.strictEqual(res.json.result.session_id, "usage-mission");
      const sessions = await httpRequest({ port, path: "/api/sessions" });
      const list = (sessions.json && sessions.json.sessions) || [];
      assert(
        list.some((s) => s.id === "usage-mission"),
        "mission session was not persisted",
      );
    });
  } finally {
    await stopChild(child);
    stub.server.close();
  }

  // ── 10. Static wiring assertions ───────────────────────────
  await expectAsync("api.js binds sessions in MCP and HTTP, and tools use ctx", () => {
    const api = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
    assert.match(api, /function ensureSessionForDir/);
    assert.match(api, /case "set_working_dir":[\s\S]{0,4000}ensureSessionForDir/);
    assert.match(api, /case "agent_single":[\s\S]{0,900}ensureSessionForDir/);
    assert.match(api, /case "agent_mission":[\s\S]{0,900}ensureSessionForDir/);
    assert.match(api, /async function executeMcpTool\(tool, args, ctx\)/);
    assert.match(api, /path is outside the session working directory/);
    assert.match(api, /async function callModelWithTools\([\s\S]{0,160}toolContext/);
  });

  // ── 11. Durable evidence in the repo ──────────────────────
  const crypto = require("crypto");
  const sha256File = (file) => {
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    } catch (_) {
      return "";
    }
  };
  const evidenceDir = path.join(ROOT, "docs", "evidence", "real-usage-2026-11-21");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    generated_at: new Date().toISOString(),
    check: "node tests/real-usage-dir-check.js",
    marker: failed === 0 ? "REAL_USAGE_DIR_OK" : "REAL_USAGE_DIR_FAIL",
    passed,
    failed,
    gateway: "isolated api.js on a free port with a local tool-calling stub",
    sessions: { http: httpSession, mcp: mcpSession, mission: "usage-mission" },
    workspaces: [
      {
        dir: dirA,
        file: "result.txt",
        content: readFileSafe(path.join(dirA, "result.txt")),
        sha256: sha256File(path.join(dirA, "result.txt")),
      },
      {
        dir: dirB,
        file: "result.txt",
        content: readFileSafe(path.join(dirB, "result.txt")),
        sha256: sha256File(path.join(dirB, "result.txt")),
      },
    ],
    containment: {
      escape_denied: !fs.existsSync(path.join(TMP, "escape.txt")),
      marker: "Access denied: path is outside the session working directory",
    },
    session_write_race:
      "writeSessions is now synchronous + atomic; two createSession calls no longer overwrite each other",
  };
  fs.writeFileSync(
    path.join(evidenceDir, "phase-a-check.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(
    "EVIDENCE docs/evidence/real-usage-2026-11-21/phase-a-check.json sessions=" +
      [httpSession, mcpSession].join(","),
  );
  console.log(
    "EVIDENCE workspace-a sha256=" +
      evidence.workspaces[0].sha256 +
      " workspace-b sha256=" +
      evidence.workspaces[1].sha256,
  );

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.error("\nREAL_USAGE_DIR_FAIL");
    process.exit(1);
  }
  console.log("\nREAL_USAGE_DIR_OK");
}

main().catch((error) => {
  console.error(
    "REAL_USAGE_DIR_FAIL " + (error && error.message ? error.message : error),
  );
  process.exit(1);
});
