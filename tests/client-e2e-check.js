#!/usr/bin/env node
"use strict";
/**
 * tests/client-e2e-check.js — runbook row 16 (Phase B).
 *
 * Real clients, not HTTP-only probes:
 *   1. Chromium (CDP, zero HTTP to the browser) opens the actual chat UI,
 *      attaches a text file through the real file input, sends a message,
 *      and renders the provider answer. A PNG screenshot is saved as evidence.
 *   2. The real OpenCode CLI runs against the same isolated gateway and
 *      completes a short marker task. The gateway uses a local stub provider,
 *      so this check needs no cloud model or network.
 *
 * Run: node tests/client-e2e-check.js
 * Exit 0 + CLIENT_E2E_OK only when every assertion passes.
 */
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "client-e2e-" + process.pid);
// This host has a snap shim named chromium-browser that exits immediately.
// Prefer a real binary: explicit CHROME_BIN, then Chromium/Chrome, then the
// Playwright headless shell that ships with the local browser tooling.
function usableChrome() {
  const explicit = process.env.CHROME_BIN;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = ["chromium", "google-chrome", "google-chrome-stable", "chromium-browser"];
  for (const name of names) {
    try {
      const p = require("child_process").execFileSync("sh", ["-c", "command -v " + name], { encoding: "utf8" }).trim();
      if (!p) continue;
      const probe = require("child_process").spawnSync(p, ["--version"], { encoding: "utf8", timeout: 5000 });
      if (probe.status === 0 && /chrom/i.test(String(probe.stdout))) return p;
    } catch (_) {}
  }
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    for (const name of fs.readdirSync(cache).filter((n) => n.startsWith("chromium_headless_shell-")).sort().reverse()) {
      const p = path.join(cache, name, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return "";
}
const chrome = usableChrome();
if (chrome) process.env.CHROME_BIN = chrome;
const { CDPipe } = require(path.join(ROOT, "cdp-pipe.js"));
const OPENCODE =
  process.env.OPENCODE_CLI ||
  path.join(process.env.HOME || "", ".local", "node", "bin", "opencode");
const MARKER = "CLIENT_E2E_BROWSER_OK";
const ATTACH_TEXT = "CLIENT_E2E_ATTACHMENT_BYTES\n";
const EDITOR_MARKER = "CLIENT_E2E_EDITOR_OK";

let pass = 0;
let fail = 0;
function ok(name, detail) { pass++; console.log("PASS " + name + (detail ? " :: " + detail : "")); }
function bad(name, detail) { fail++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
function check(name, cond, detail) { cond ? ok(name, detail) : bad(name, detail); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function request(port, pathname, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? null : Buffer.from(opts.body);
    const req = http.request({
      host: "127.0.0.1", port, path: pathname, method: opts.method || "GET",
      headers: Object.assign({}, payload ? { "content-length": payload.length } : {}, opts.headers || {}),
      timeout: opts.timeout || 30000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString("utf8")); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text: body.toString("utf8"), json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(payload || undefined);
  });
}

function startStub() {
  const state = { hits: 0, last: null };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.hits++;
      try { state.last = JSON.parse(raw); } catch (_) { state.last = raw; }
      const body = state.last || {};
      const reply = JSON.stringify(body.messages || []).includes("CLIENT_E2E_EDITOR") ? EDITOR_MARKER : MARKER;
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write("data: " + JSON.stringify({ id: "chatcmpl-client-e2e-" + state.hits, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ id: "chatcmpl-client-e2e-" + state.hits, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "stub", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const payload = {
        id: "chatcmpl-client-e2e-" + state.hits,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "stub",
        choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const text = JSON.stringify(payload);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

async function waitHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/health", { timeout: 2000 });
      if (res.status === 200 && res.json && res.json.healthy === true) return res.json;
    } catch (_) {}
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
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error.message; }
    await sleep(200);
  }
  throw new Error("timeout waiting for " + label + (last ? " (last=" + String(last).slice(0, 200) + ")" : ""));
}

function run(cmd, args, options) {
  const opts = options || {};
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || ROOT, env: opts.env || process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
    }, opts.timeout || 90000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "admin"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "project"), { recursive: true });

  // Static contract: the browser path must be the shipped UI, not a fixture.
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  check("UI has a real file input", /id="fileUpload"/.test(html) && /type="file"/.test(html));
  check("UI posts attachments to /api/chat/upload", html.includes("/api/chat/upload"));
  check("UI sends attachment ids to chat", html.includes("attachments: attachments || []"));

  const stub = await startStub();
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    PORT: String(port), GRPC: "0", GRPC_PORT: String(await freePort()),
    HTTPS_PORT: String(await freePort()), UDS_PORT: String(await freePort()),
    APP_ROOT: TMP, DATA_DIR: path.join(TMP, "data"), LOG_DIR: path.join(TMP, "logs"),
    DB_SQLITE_PATH: path.join(TMP, "models.db"), DB_BOOTSTRAP: "1",
    UDS: path.join(TMP, "mcp.sock"), UDS_OPENAI: "0", ADMIN_DIR: path.join(TMP, "admin"),
    INSTANCE_ID: "client-e2e-" + Date.now(), AGENT_MODEL: "stub-vision", ADMIN_TOKEN: "client-e2e-admin",
    ADMIN_ALLOW_UNAUTHENTICATED: "false", OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1", GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9", OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0", MAX_BODY_SIZE: "10485760",
    CUSTOM_PROVIDER_1_URL: "http://127.0.0.1:" + stub.port + "/v1",
    CUSTOM_PROVIDER_1_NAME: "StubClient", CUSTOM_PROVIDER_1_MODELS: "stub-vision",
    CUSTOM_PROVIDER_1_MEDIA: "true",
  });
  const gateway = spawn(process.execPath, [path.join(ROOT, "api.js")], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let gatewayLog = "";
  gateway.stdout.on("data", (chunk) => (gatewayLog += chunk.toString()));
  gateway.stderr.on("data", (chunk) => (gatewayLog += chunk.toString()));
  const cdp = new CDPipe({ viewport: { width: 1280, height: 900 } });

  try {
    const health = await waitHealth(port, 45000);
    if (!health) {
      bad("isolated gateway healthy", gatewayLog.slice(-2500));
      throw new Error("gateway did not start");
    }
    ok("isolated gateway healthy", "models=" + health.models + " agents=" + health.agents);

    await cdp.start();
    const page = await cdp.ensurePage({ keepOpen: true });
    const config = { serverUrl: "http://127.0.0.1:" + port, stream: false, autoSave: false, theme: "dark", lang: "en", temperature: 0.1, maxTokens: 256, udsPath: path.join(TMP, "mcp.sock") };
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "try{localStorage.setItem(\"mb_config\"," + JSON.stringify(JSON.stringify(config)) + ");}catch(e){}",
    }, page.sessionId);
    await cdp.navigate(page, "http://127.0.0.1:" + port + "/", 30000);
    await waitFor(async () => await cdp.eval("document.getElementById(\"agentSelect\") && document.getElementById(\"agentSelect\").options.length > 1", page.sessionId), 20000, "agents");
    const status = await cdp.eval("document.getElementById(\"statusText\") ? document.getElementById(\"statusText\").textContent : document.body.innerText.slice(0,200)", page.sessionId);
    const agentCount = await cdp.eval("document.getElementById(\"agentSelect\").options.length", page.sessionId);
    check("Chromium loaded the real UI and agent catalog", agentCount > 1, "agents=" + agentCount + " status=" + String(status).slice(0, 80));

    const fileBytes = Array.from(Buffer.from(ATTACH_TEXT, "utf8"));
    const uploadExpr = "(function(){const f=new File([new Uint8Array(" + JSON.stringify(fileBytes) + ")],\"client-e2e.txt\",{type:\"text/plain\"});const dt=new DataTransfer();dt.items.add(f);const input=document.getElementById(\"fileUpload\");input.files=dt.files;input.dispatchEvent(new Event(\"change\",{bubbles:true}));return input.files.length;})()";
    const fileCount = await cdp.eval(uploadExpr, page.sessionId);
    check("real file input accepted a File", fileCount === 1, "files=" + fileCount);
    await waitFor(async () => await cdp.eval("document.getElementById(\"filePreview\").style.display !== \"none\" && !/uploading|failed/i.test(document.getElementById(\"fileName\").textContent)", page.sessionId), 15000, "upload preview");
    const preview = await cdp.eval("document.getElementById(\"fileName\").textContent", page.sessionId);
    check("UI shows the uploaded filename and size", /client-e2e\.txt/.test(String(preview)) && /KB/.test(String(preview)), String(preview));
    const uploadFiles = fs.readdirSync(path.join(TMP, ".zombie", "uploads")).filter((name) => name.endsWith(".json"));
    check("gateway persisted the uploaded file", uploadFiles.length === 1, uploadFiles.join(","));
    const uploadRecord = JSON.parse(fs.readFileSync(path.join(TMP, ".zombie", "uploads", uploadFiles[0]), "utf8"));
    check("upload record has the real bytes and MIME type", uploadRecord.name === "client-e2e.txt" && uploadRecord.mime === "text/plain" && uploadRecord.bytes === Buffer.byteLength(ATTACH_TEXT), "bytes=" + uploadRecord.bytes);
    const storedBytes = fs.readFileSync(path.join(TMP, ".zombie", "uploads", uploadRecord.id + uploadRecord.ext));
    check("stored upload bytes match the browser File", storedBytes.equals(Buffer.from(ATTACH_TEXT, "utf8")), "stored=" + storedBytes.length);

    await cdp.eval("document.getElementById(\"agentSelect\").value=\"single:code-guru\"; document.getElementById(\"chatInput\").value=\"CLIENT_E2E_BROWSER_TASK\"; document.getElementById(\"chatInput\").dispatchEvent(new Event(\"input\",{bubbles:true})); document.getElementById(\"sendBtn\").click(); true", page.sessionId);
    await waitFor(async () => await cdp.eval("document.body.innerText.includes(" + JSON.stringify(MARKER) + ")", page.sessionId), 30000, "provider answer");
    ok("Chromium rendered the provider answer", MARKER);
    const bodyText = await cdp.eval("document.body.innerText", page.sessionId);
    check("chat transcript contains the user task", bodyText.includes("CLIENT_E2E_BROWSER_TASK"));
    check("chat transcript names the attachment", bodyText.includes("client-e2e.txt"));

    check("stub provider received the chat task", !!stub.state.last && JSON.stringify(stub.state.last).includes("CLIENT_E2E_BROWSER_TASK"), "hits=" + stub.state.hits);
    check("stub provider received the attached bytes", !!stub.state.last && JSON.stringify(stub.state.last).includes("CLIENT_E2E_ATTACHMENT_BYTES"));

    const shot = await cdp.captureScreenshot(page, { fullPage: true });
    const evidenceDir = path.join(TMP, "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    const shotPath = path.join(evidenceDir, "browser-chat-upload.png");
    fs.copyFileSync(shot.path, shotPath);
    check("Chromium screenshot saved", fs.statSync(shotPath).size > 10000, shotPath + " bytes=" + fs.statSync(shotPath).size);
    console.log("EVIDENCE screenshot=" + shotPath);

    // ── Real OpenCode CLI against the same isolated gateway ──
    check("OpenCode CLI exists", fs.existsSync(OPENCODE), OPENCODE);
    const providerConfig = { "zombie-local": { npm: "@ai-sdk/openai-compatible", name: "Zombie Local", options: { baseURL: "http://127.0.0.1:" + port + "/v1" }, models: { "stub-vision": { name: "Stub Vision" } } } };
    const projectConfig = {
      "$schema": "https://opencode.ai/config.json",
      provider: providerConfig,
      mcp: { servers: { "zc-gateway": { type: "remote", url: "http://127.0.0.1:" + port + "/mcp", headers: { Authorization: "Bearer client-e2e-admin" } } } },
    };
    const projectDir = path.join(TMP, "project");
    fs.writeFileSync(path.join(projectDir, "opencode.json"), JSON.stringify(projectConfig, null, 2));
    const editor = await run(OPENCODE, ["--standalone", "--print-logs", "run", "--agent", "build", "--model", "zombie-local/stub-vision", "--format", "json", "Reply with exactly: " + EDITOR_MARKER], { cwd: projectDir, timeout: 90000, env: Object.assign({}, process.env, { PWD: projectDir, OLDPWD: projectDir, OPENCODE_DISABLE_AUTOUPDATE: "1" }) });
    check("OpenCode CLI exited 0", editor.code === 0, "code=" + editor.code + " signal=" + editor.signal + " err=" + editor.stderr.slice(-200).replace(/\s+/g, " "));
    check("OpenCode CLI rendered the marker", editor.stdout.includes(EDITOR_MARKER), editor.stdout.slice(-300).replace(/\s+/g, " "));
    check("OpenCode task reached the gateway stub", stub.state.hits >= 3, "hits=" + stub.state.hits);
    check("OpenCode connected to the gateway MCP server", /mcp connected[^\n]*server=zc-gateway/.test(editor.stderr), "tools=" + ((editor.stderr.match(/server=zc-gateway tools=(\d+)/) || [])[1] || "?"));
    const mcpLine = (editor.stderr.match(/message="mcp connected"[^\n]*server=zc-gateway[^\n]*tools=\d+/) || [""])[0];
    console.log("EVIDENCE opencode_exit=" + editor.code + " " + mcpLine.slice(0, 180));
  } catch (error) {
    try {
      const body = await cdp.eval("document.body.innerText", cdp.page && cdp.page.sessionId);
      console.log("DEBUG page_tail=" + String(body).slice(-1200).replace(/\s+/g, " "));
    } catch (_) {}
    console.log("DEBUG stub_hits=" + stub.state.hits + " last=" + JSON.stringify(stub.state.last).slice(0, 1200));
    console.log("DEBUG gateway_tail=" + gatewayLog.slice(-1800).replace(/\s+/g, " "));
    bad("client E2E execution", error && error.stack || String(error));
  } finally {
    try { cdp.stop(); } catch (_) {}
    await stopChild(gateway);
    stub.server.close();
  }

  if (fail > 0) {
    console.log("CLIENT_E2E_FAIL pass=" + pass + " fail=" + fail);
    process.exit(1);
  }
  console.log("CLIENT_E2E_OK pass=" + pass + " fail=0");
})().catch((error) => {
  console.error("CLIENT_E2E_ERROR " + (error && error.stack || error));
  process.exit(2);
});
