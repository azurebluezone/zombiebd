#!/usr/bin/env node
"use strict";

/**
 * tests/chat-upload-check.js
 *
 * Proves the bounded chat-attachment path end to end:
 *   1. modules/chat-upload.js stores txt/png/mp3 under .zombie/uploads,
 *      dedupes identical bytes, and rejects exe/oversize with stable codes.
 *   2. buildAttachmentParts produces text, image_url and input_audio parts.
 *   3. normalizeMessages keeps media for a media-capable provider and
 *      flattens it to explicit text for a text-only provider.
 *   4. An isolated live gateway accepts real uploads over HTTP, rejects
 *      exe/oversize, and a real chat call reaches a local stub provider with
 *      image_url/input_audio parts (or flattened text).
 *   5. Mission mode rejects photo/audio with ATTACHMENT_SINGLE_AGENT_ONLY.
 *   6. public/index.html uploads on attach and sends attachment ids.
 *
 * Prints CHAT_UPLOAD_OK only when every check passes.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join("/tmp/opencode", "chat-upload-" + process.pid);

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
  "base64",
);
const MP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
const TXT = Buffer.from("chat upload attachment fixture\n", "utf8");
const EXE = Buffer.from("MZ-not-a-real-executable", "utf8");

let passed = 0;
let failed = 0;

function pass(name, detail) {
  passed += 1;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failed += 1;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

function expect(name, fn) {
  try {
    fn();
    pass(name);
  } catch (error) {
    fail(name, error && error.message ? error.message : String(error));
  }
}

async function expectAsync(name, fn) {
  try {
    await fn();
    pass(name);
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
        timeout: options.timeout || 30000,
        headers: Object.assign(
          payload
            ? { "content-length": payload.length }
            : {},
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

function upload(port, data, mime, name) {
  return httpRequest({
    port,
    path: "/api/chat/upload",
    method: "POST",
    headers: {
      "content-type": mime,
      "x-file-name": encodeURIComponent(name),
    },
    body: data,
  });
}

function startStub() {
  const state = { last: null, hits: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.hits += 1;
      try {
        state.last = JSON.parse(raw);
      } catch (_) {
        state.last = raw;
      }
      const payload = {
        id: "chatcmpl-stub-" + state.hits,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "stub",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "stub-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const text = JSON.stringify(payload);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(text),
      });
      res.end(text);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, state, port: server.address().port }),
    );
  });
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

function lastUser(messages) {
  return (messages || []).filter((m) => m && m.role === "user").pop() || null;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const chatUpload = require(path.join(ROOT, "modules", "chat-upload.js"));
  const provider = require(path.join(ROOT, "provider", "index.js"));
  const env = require(path.join(ROOT, "lib", "env.js"));

  // ── 1. Module: storage, dedupe, validation ─────────────────
  const moduleRoot = path.join(TMP, "module-root");
  let txtSaved = null;
  let pngSaved = null;
  let mp3Saved = null;

  await expectAsync("module stores a document under .zombie/uploads", () => {
    txtSaved = chatUpload.saveUpload({
      root: moduleRoot,
      data: TXT,
      mime: "text/plain",
      name: "../unsafe/name.txt",
      maxBytes: 4096,
    });
    assert.strictEqual(txtSaved.kind, "document");
    assert.match(txtSaved.id, /^[a-f0-9]{64}$/);
    assert.strictEqual(txtSaved.name, "name.txt");
    assert.ok(fs.existsSync(txtSaved.path), "file missing: " + txtSaved.path);
    assert.ok(
      fs.existsSync(
        path.join(moduleRoot, ".zombie", "uploads", txtSaved.id + ".json"),
      ),
      "sidecar missing",
    );
    return txtSaved.path;
  });

  await expectAsync("identical bytes dedupe to one file", () => {
    const again = chatUpload.saveUpload({
      root: moduleRoot,
      data: TXT,
      mime: "text/plain",
      name: "copy.txt",
      maxBytes: 4096,
    });
    assert.strictEqual(again.id, txtSaved.id);
    assert.strictEqual(again.deduped, true);
  });

  await expectAsync("module stores png and mp3 by kind", () => {
    pngSaved = chatUpload.saveUpload({
      root: moduleRoot,
      data: PNG,
      mime: "image/png",
      name: "pixel.png",
      maxBytes: 4096,
    });
    mp3Saved = chatUpload.saveUpload({
      root: moduleRoot,
      data: MP3,
      mime: "audio/mpeg",
      name: "voice.mp3",
      maxBytes: 4096,
    });
    assert.strictEqual(pngSaved.kind, "image");
    assert.strictEqual(mp3Saved.kind, "audio");
  });

  await expectAsync("module rejects exe and oversize with stable codes", () => {
    assert.throws(
      () =>
        chatUpload.saveUpload({
          root: moduleRoot,
          data: EXE,
          mime: "application/x-msdownload",
          name: "bad.exe",
          maxBytes: 4096,
        }),
      (error) => error.code === "ATTACHMENT_TYPE" && error.status === 415,
    );
    assert.throws(
      () =>
        chatUpload.saveUpload({
          root: moduleRoot,
          data: Buffer.alloc(64, 1),
          mime: "image/png",
          name: "big.png",
          maxBytes: 16,
        }),
      (error) => error.code === "ATTACHMENT_TOO_LARGE" && error.status === 413,
    );
  });

  await expectAsync("buildAttachmentParts returns text/image/audio", () => {
    const parts = chatUpload.buildAttachmentParts([
      chatUpload.loadUpload(moduleRoot, txtSaved.id),
      chatUpload.loadUpload(moduleRoot, pngSaved.id),
      chatUpload.loadUpload(moduleRoot, mp3Saved.id),
    ]);
    assert.deepStrictEqual(
      parts.map((part) => part.type),
      ["text", "image_url", "input_audio"],
    );
    assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
    assert.strictEqual(parts[2].input_audio.format, "mp3");
  });

  await expectAsync("missionText accepts text and rejects photo/audio", () => {
    const text = chatUpload.missionText([
      chatUpload.loadUpload(moduleRoot, txtSaved.id),
    ]);
    assert.match(text, /Attachment: name\.txt/);
    assert.throws(
      () =>
        chatUpload.missionText([
          chatUpload.loadUpload(moduleRoot, pngSaved.id),
        ]),
      (error) => error.code === "ATTACHMENT_SINGLE_AGENT_ONLY",
    );
  });

  // ── 2. Provider boundary normalization ─────────────────────
  const mediaMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "input_audio", input_audio: { data: "AAA", format: "mp3" } },
      ],
    },
  ];

  await expectAsync("normalizeMessages keeps media for a capable provider", () => {
    const out = provider.normalizeMessages(mediaMessages, true);
    assert.ok(Array.isArray(out[0].content), "content was flattened");
    assert.deepStrictEqual(
      out[0].content.map((part) => part.type),
      ["text", "image_url", "input_audio"],
    );
  });

  await expectAsync("normalizeMessages flattens media for a text provider", () => {
    const out = provider.normalizeMessages(mediaMessages, false);
    assert.strictEqual(typeof out[0].content, "string");
    assert.match(out[0].content, /describe/);
    assert.match(out[0].content, /\[attachment omitted: provider has no media support \(image_url\)\]/);
    assert.match(out[0].content, /\[attachment omitted: provider has no media support \(input_audio\)\]/);
  });

  await expectAsync("ATTACHMENT_MAX_BYTES is a real size-budget key", () => {
    assert.strictEqual(env.DEFAULTS.ATTACHMENT_MAX_BYTES, "10485760");
    const sizeBudget = require(path.join(ROOT, "lib", "size-budget.js"));
    assert.strictEqual(sizeBudget.limit("ATTACHMENT_MAX_BYTES"), 10485760);
  });

  // ── 3. Live isolated gateway ───────────────────────────────
  const vision = await startStub();
  const textOnly = await startStub();
  const port = await freePort();
  const grpcPort = await freePort();
  const httpsPort = await freePort();
  const udsPort = await freePort();
  const dataDir = path.join(TMP, "data");
  const logDir = path.join(TMP, "logs");
  const adminDir = path.join(TMP, "admin");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(adminDir, { recursive: true });

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
    INSTANCE_ID: "chat-upload-" + Date.now(),
    ADMIN_TOKEN: "chat-upload-token",
    ADMIN_ALLOW_UNAUTHENTICATED: "false",
    OPENCODE_ENABLED: "false",
    GROQ_BASE: "http://127.0.0.1:9/v1",
    GEMINI_BASE: "http://127.0.0.1:9",
    OLLAMA_BASE: "http://127.0.0.1:9",
    OLLAMA_CLOUD_BASE: "http://127.0.0.1:9",
    BRIDGE_ENABLED: "0",
    ATTACHMENT_MAX_BYTES: "4096",
    MAX_BODY_SIZE: "10485760",
    CUSTOM_PROVIDER_1_URL: "http://127.0.0.1:" + vision.port + "/v1",
    CUSTOM_PROVIDER_1_NAME: "StubVision",
    CUSTOM_PROVIDER_1_MODELS: "stub-vision",
    CUSTOM_PROVIDER_1_MEDIA: "true",
    CUSTOM_PROVIDER_2_URL: "http://127.0.0.1:" + textOnly.port + "/v1",
    CUSTOM_PROVIDER_2_NAME: "StubText",
    CUSTOM_PROVIDER_2_MODELS: "stub-text",
    CUSTOM_PROVIDER_2_MEDIA: "false",
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

    let livePng = null;
    let liveTxt = null;
    let liveMp3 = null;

    await expectAsync("live upload accepts png and writes .zombie/uploads", async () => {
      const res = await upload(port, PNG, "image/png", "pixel.png");
      assert.strictEqual(res.status, 201, res.text.slice(0, 300));
      assert.match(res.json.id, /^[a-f0-9]{64}$/);
      assert.strictEqual(res.json.kind, "image");
      assert.ok(
        fs.existsSync(
          path.join(TMP, ".zombie", "uploads", res.json.id + ".png"),
        ),
        "stored png missing",
      );
      livePng = res.json;
    });

    await expectAsync("live upload accepts txt and mp3", async () => {
      const txt = await upload(port, TXT, "text/plain", "note.txt");
      assert.strictEqual(txt.status, 201, txt.text.slice(0, 300));
      assert.strictEqual(txt.json.kind, "document");
      liveTxt = txt.json;
      const mp3 = await upload(port, MP3, "audio/mpeg", "voice.mp3");
      assert.strictEqual(mp3.status, 201, mp3.text.slice(0, 300));
      assert.strictEqual(mp3.json.kind, "audio");
      liveMp3 = mp3.json;
    });

    await expectAsync("live upload dedupes identical bytes", async () => {
      const again = await upload(port, PNG, "image/png", "copy.png");
      assert.strictEqual(again.status, 201);
      assert.strictEqual(again.json.id, livePng.id);
      assert.strictEqual(again.json.deduped, true);
    });

    await expectAsync("live upload rejects exe with 415", async () => {
      const res = await upload(port, EXE, "application/x-msdownload", "bad.exe");
      assert.strictEqual(res.status, 415, res.text.slice(0, 300));
      assert.strictEqual(res.json.error, "ATTACHMENT_TYPE");
    });

    await expectAsync("live upload rejects oversize with 413", async () => {
      const res = await upload(
        port,
        Buffer.alloc(5000, 7),
        "image/png",
        "big.png",
      );
      assert.strictEqual(res.status, 413, res.text.slice(0, 300));
      assert.strictEqual(res.json.error, "ATTACHMENT_TOO_LARGE");
    });

    await expectAsync("media provider receives image_url and input_audio", async () => {
      const res = await httpRequest({
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stub-vision",
          messages: [{ role: "user", content: "describe the attachment" }],
          attachments: [livePng.id, liveMp3.id],
          stream: false,
        }),
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      const sent = lastUser(vision.state.last && vision.state.last.messages);
      assert.ok(sent, "stub received no user message");
      assert.ok(Array.isArray(sent.content), "content was not multipart");
      const types = sent.content.map((part) => part.type);
      assert.ok(types.includes("image_url"), "no image_url: " + types.join(","));
      assert.ok(types.includes("input_audio"), "no input_audio: " + types.join(","));
    });

    await expectAsync("text-only provider receives flattened text", async () => {
      const res = await httpRequest({
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "stub-text",
          messages: [{ role: "user", content: "describe the attachment" }],
          attachments: [livePng.id, liveMp3.id],
          stream: false,
        }),
      });
      assert.strictEqual(res.status, 200, res.text.slice(0, 400));
      const sent = lastUser(textOnly.state.last && textOnly.state.last.messages);
      assert.ok(sent, "stub received no user message");
      assert.strictEqual(typeof sent.content, "string");
      assert.match(sent.content, /attachment omitted: provider has no media support \(image_url\)/);
      assert.match(sent.content, /attachment omitted: provider has no media support \(input_audio\)/);
    });

    await expectAsync("mission rejects photo/audio with ATTACHMENT_SINGLE_AGENT_ONLY", async () => {
      const res = await httpRequest({
        port,
        path: "/api/mission",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input: "summarize the attachment",
          attachments: [livePng.id],
          session_id: "chat-upload-mission-" + Date.now(),
        }),
      });
      assert.strictEqual(res.status, 400, res.text.slice(0, 300));
      assert.strictEqual(res.json.error, "ATTACHMENT_SINGLE_AGENT_ONLY");
    });

    await expectAsync("mission accepts a text document (module path)", () => {
      const uploads = chatUpload.resolveAttachments(TMP, [liveTxt.id]);
      const text = chatUpload.missionText(uploads);
      assert.match(text, /Attachment: note\.txt/);
      assert.match(text, /chat upload attachment fixture/);
    });
  } finally {
    await stopChild(child);
    vision.server.close();
    textOnly.server.close();
  }

  // ── 4. UI wiring ───────────────────────────────────────────
  await expectAsync("web UI uploads on attach and sends attachment ids", () => {
    const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
    assert.match(html, /fetch\(config\.serverUrl \+ '\/api\/chat\/upload'/);
    assert.match(html, /'X-File-Name': encodeURIComponent\(file\.name\)/);
    assert.match(html, /let pendingAttachments = \[\]/);
    assert.match(html, /attachments: attachments \|\| \[\]/);
    assert.match(html, /callAgent\(chat, display, attachments\)/);
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.error("\nCHAT_UPLOAD_FAIL");
    process.exit(1);
  }
  console.log("\nCHAT_UPLOAD_OK");
}

main().catch((error) => {
  console.error("CHAT_UPLOAD_FAIL " + (error && error.message ? error.message : error));
  process.exit(1);
});
