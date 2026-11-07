#!/usr/bin/env node
"use strict";
/*
 * Transport contract suite.
 * Proves tool-call parsing (streaming + non-streaming) on HTTP, HTTPS,
 * OpenAI-over-UDS, OpenAI-over-STDIO and gRPC, plus normalizer fixtures.
 * The server under test is an isolated api.js instance with temp dirs.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const http2 = require("http2");
const net = require("net");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(os.tmpdir(), "opencode", "transport-" + process.pid);
const MODEL = process.env.TRANSPORT_TEST_MODEL || "openai/gpt-oss-120b";
const END_MARKER = "[" + "DONE" + "]";
const TIMEOUT = 45000;

const results = [];
function mark(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}

const TIME_TOOL = {
  type: "function",
  function: {
    name: "get_time",
    description: "Return current time for a timezone",
    parameters: {
      type: "object",
      properties: { timezone: { type: "string" } },
      required: ["timezone"],
    },
  },
};

function chatBody(stream) {
  return {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: "Call get_time with timezone Asia/Dhaka. Do not answer in text.",
      },
    ],
    tools: [TIME_TOOL],
    tool_choice: "required",
    stream: !!stream,
    temperature: 0,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server, 0, "127.0.0.1");
  await close(server);
  return port;
}

function readDotEnv() {
  const out = {};
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function requestText(opts) {
  const body = opts.body;
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const lib = opts.protocol === "https" ? https : http;
    const req = lib.request(
      {
        hostname: opts.host || "127.0.0.1",
        port: opts.port,
        socketPath: opts.socketPath,
        path: opts.path,
        method: opts.method || "POST",
        rejectUnauthorized: false,
        timeout: opts.timeout || TIMEOUT,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout " + opts.path));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSse(text) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === END_MARKER) {
      frames.push({ done: true });
      continue;
    }
    try {
      frames.push({ json: JSON.parse(data) });
    } catch (_) {
      frames.push({ raw: data });
    }
  }
  return frames;
}

function toolCallOf(json) {
  const choice = json && json.choices && json.choices[0];
  const calls = (choice && choice.message && choice.message.tool_calls) || [];
  const first = calls[0] || {};
  const fn = first.function || {};
  let args = fn.arguments;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (_) {}
  }
  return { name: fn.name, args: args || {}, finish: choice && choice.finish_reason };
}

function assertToolResponse(label, json) {
  const got = toolCallOf(json);
  const ok = got.name === "get_time" && got.args && got.args.timezone === "Asia/Dhaka";
  mark(label, ok, "name=" + got.name + " args=" + JSON.stringify(got.args) + " finish=" + got.finish);
  return ok;
}

function assertToolStream(label, text) {
  const frames = parseSse(text);
  let finish = null;
  let name = null;
  let args = "";
  let sawDone = false;
  let roleChunks = 0;
  for (const frame of frames) {
    if (frame.done) {
      sawDone = true;
      continue;
    }
    if (!frame.json) continue;
    const choice = frame.json.choices && frame.json.choices[0];
    if (!choice) continue;
    if (choice.delta && choice.delta.role) roleChunks++;
    if (choice.delta && Array.isArray(choice.delta.tool_calls)) {
      for (const tc of choice.delta.tool_calls) {
        if (tc.function && tc.function.name) name = tc.function.name;
        if (tc.function && typeof tc.function.arguments === "string") {
          args += tc.function.arguments;
        } else if (tc.function && tc.function.arguments) {
          args = JSON.stringify(tc.function.arguments);
        }
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(args);
  } catch (_) {}
  const ok =
    sawDone &&
    finish === "tool_calls" &&
    name === "get_time" &&
    parsed &&
    parsed.timezone === "Asia/Dhaka";
  mark(
    label,
    ok,
    "finish=" + finish + " name=" + name + " args=" + args + " done=" + sawDone,
  );
  return ok;
}

function runNormalizerTests() {
  const { createStreamNormalizer } = require(path.join(ROOT, "normalizer"));
  const norm = createStreamNormalizer({ model: "fixture-model", provider: "fixture" });

  const first = norm.normalize({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_fixture",
              type: "function",
              function: { name: "get_time", arguments: "" },
            },
          ],
        },
      },
    ],
  });
  const middle = norm.normalize({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"timezone":' } }] } }],
  });
  const last = norm.normalize({
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: '"Asia/Dhaka"}' } }] },
        finish_reason: "stop",
      },
    ],
  });

  let parsed = null;
  const call =
    last && last.choices[0].delta.tool_calls && last.choices[0].delta.tool_calls[0];
  if (call && call.function) {
    try {
      parsed = JSON.parse(call.function.arguments);
    } catch (_) {}
  }
  mark(
    "normalizer-stream-toolcall",
    !!first &&
      first.choices[0].delta.role === "assistant" &&
      middle === null &&
      last &&
      last.choices[0].finish_reason === "tool_calls" &&
      parsed &&
      parsed.timezone === "Asia/Dhaka",
    "finish=" + (last && last.choices[0].finish_reason) + " roleInLast=" + !!(last && last.choices[0].delta.role),
  );

  const objectNorm = createStreamNormalizer({ model: "fixture-model", provider: "fixture" });
  const objectChunk = objectNorm.normalize({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_obj", function: { name: "get_time", arguments: { timezone: "Asia/Dhaka" } } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const objectCall = objectChunk && objectChunk.choices[0].delta.tool_calls[0];
  mark(
    "normalizer-object-arguments",
    !!objectCall &&
      objectCall.function.name === "get_time" &&
      JSON.parse(objectCall.function.arguments).timezone === "Asia/Dhaka",
    "args=" + (objectCall && objectCall.function.arguments),
  );

  const roleNorm = createStreamNormalizer({ model: "fixture-model", provider: "fixture" });
  const a = roleNorm.normalize({ choices: [{ index: 0, delta: { content: "he" } }] });
  const b = roleNorm.normalize({ choices: [{ index: 0, delta: { content: "llo" } }] });
  const roleCount = [a, b].filter((c) => c && c.choices[0].delta.role === "assistant").length;
  mark("normalizer-single-role", roleCount === 1, "roleChunks=" + roleCount);
}

function startStdio(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "transport", "stdio-openai.js")], {
    env: env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const items = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        obj = { raw: line };
      }
      items.push(obj);
      for (const waiter of waiters.slice()) {
        if (waiter.pred(obj)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(obj);
        }
      }
    }
  });

  return {
    child,
    items,
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    wait(pred, ms) {
      const found = items.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { pred: pred };
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error("stdio timeout; stderr=" + stderr.slice(-300)));
        }, ms || TIMEOUT);
        waiter.resolve = (obj) => {
          clearTimeout(timer);
          resolve(obj);
        };
        waiters.push(waiter);
      });
    },
    stop() {
      try {
        child.stdin.end();
      } catch (_) {}
      try {
        child.kill("SIGTERM");
      } catch (_) {}
    },
  };
}

function grpcCall(port, request, timeoutMs) {
  const { encodeChatRequest, decodeChatResponse, frame, unframe } = require(path.join(
    ROOT,
    "transport",
    "protobuf",
  ));
  return new Promise((resolve, reject) => {
    const client = http2.connect("http://127.0.0.1:" + port);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("grpc timeout"));
    }, timeoutMs || TIMEOUT);
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
      if (headers["grpc-message"]) grpcMessage = headers["grpc-message"];
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
      resolve({ responses, grpcStatus, grpcMessage });
    });
    req.end(frame(Buffer.from(encodeChatRequest(request))));
  });
}

function prepareTempEnv() {
  for (const dir of ["data", "logs", "cache", "locks"]) {
    fs.mkdirSync(path.join(TMP, dir), { recursive: true });
  }
  const source = path.join(ROOT, "data", "models.db");
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(TMP, "data", "models.db"));
  }
}

function waitHealth(port, child, output) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 35000;
    const tick = async () => {
      if (child.exitCode !== null) {
        reject(new Error("api.js exited code=" + child.exitCode + "\n" + output.slice(-2000)));
        return;
      }
      try {
        const res = await requestText({ port: port, path: "/health", method: "GET" });
        if (res.status === 200) {
          const json = JSON.parse(res.text);
          if (json.healthy === true) {
            resolve(json);
            return;
          }
        }
      } catch (_) {}
      if (Date.now() > deadline) {
        reject(new Error("api.js did not become healthy\n" + output.slice(-2000)));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

function spawnServer(ports) {
  const env = Object.assign({}, process.env, readDotEnv(), {
    PORT: String(ports.api),
    BIND_HOST: "127.0.0.1",
    UDS_PORT: String(ports.mcp),
    UDS: path.join(TMP, "mcp.sock"),
    UDS_OPENAI: "1",
    GRPC_PORT: String(ports.grpc),
    HTTPS_PORT: String(ports.https),
    HTTPS_CERT_PATH: path.join(TMP, "cert.pem"),
    HTTPS_KEY_PATH: path.join(TMP, "key.pem"),
    DATA_DIR: path.join(TMP, "data"),
    LOG_DIR: path.join(TMP, "logs"),
    CACHE_DIR: path.join(TMP, "cache"),
    LOCK_DIR: path.join(TMP, "locks"),
    DB_SQLITE_PATH: path.join(TMP, "data", "models.db"),
    WATCHDOG_INTERVAL: "600000",
  });
  let output = "";
  const child = spawn(process.execPath, [path.join(ROOT, "api.js")], {
    cwd: TMP,
    env: env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (output += d.toString()));
  child.stderr.on("data", (d) => (output += d.toString()));
  return { child, output: () => output };
}

function grpcRequest(stream) {
  const body = chatBody(stream);
  return {
    model: body.model,
    messages: body.messages,
    stream: !!stream,
    temperature: 0,
    tool_choice: "required",
    tools: body.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  };
}

function grpcToolResult(responses) {
  let finish = "";
  let name = "";
  let args = "";
  for (const response of responses) {
    if (response.finish_reason) finish = response.finish_reason;
    for (const call of response.tool_calls || []) {
      if (call.function && call.function.name) name = call.function.name;
      if (call.function && call.function.arguments) args += call.function.arguments;
    }
  }
  let parsed = null;
  try {
    parsed = JSON.parse(args);
  } catch (_) {}
  return { finish, name, args, parsed };
}

async function main() {
  runNormalizerTests();
  prepareTempEnv();

  let certOk = true;
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", path.join(TMP, "key.pem"),
        "-out", path.join(TMP, "cert.pem"),
        "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "pipe" },
    );
  } catch (err) {
    certOk = false;
    mark("https-cert", false, "openssl failed: " + err.message);
  }

  const ports = {
    api: await freePort(),
    mcp: await freePort(),
    grpc: await freePort(),
    https: await freePort(),
  };
  const udsPath = path.join(TMP, "mcp.sock");
  const server = spawnServer(ports);

  try {
    const health = await waitHealth(ports.api, server.child, server.output());
    mark("server-health", health.healthy === true, "port=" + ports.api);
    mark("uds-socket-exists", fs.existsSync(udsPath), udsPath);

    try {
      const res = await requestText({
        port: ports.api,
        path: "/v1/chat/completions",
        body: chatBody(false),
      });
      mark("http-nonstream-status", res.status === 200, "status=" + res.status);
      assertToolResponse("http-nonstream-toolcall", JSON.parse(res.text));

      const streamRes = await requestText({
        port: ports.api,
        path: "/v1/chat/completions",
        body: chatBody(true),
      });
      mark("http-stream-status", streamRes.status === 200, "status=" + streamRes.status);
      assertToolStream("http-stream-toolcall", streamRes.text);
    } catch (err) {
      mark("http", false, err.message);
    }

    try {
      const res = await requestText({
        socketPath: udsPath,
        path: "/v1/chat/completions",
        body: chatBody(false),
      });
      mark("uds-nonstream-status", res.status === 200, "status=" + res.status);
      assertToolResponse("uds-nonstream-toolcall", JSON.parse(res.text));

      const streamRes = await requestText({
        socketPath: udsPath,
        path: "/v1/chat/completions",
        body: chatBody(true),
      });
      mark("uds-stream-status", streamRes.status === 200, "status=" + streamRes.status);
      assertToolStream("uds-stream-toolcall", streamRes.text);
    } catch (err) {
      mark("uds", false, err.message);
    }

    const stdio = startStdio(
      Object.assign({}, process.env, { UDS: udsPath }),
    );
    try {
      stdio.send(chatBody(false));
      const responseEvent = await stdio.wait((o) => o.response);
      assertToolResponse("stdio-nonstream-toolcall", responseEvent.response);

      const startIndex = stdio.items.length;
      stdio.send(chatBody(true));
      await stdio.wait((o) => o.done);
      const slice = stdio.items.slice(startIndex);
      const chunks = slice.filter((o) => o.chunk).map((o) => o.chunk);
      const sawDone = slice.some((o) => o.done);
      const text =
        chunks.map((c) => "data: " + JSON.stringify(c)).join("\n") +
        (sawDone ? "\ndata: " + END_MARKER : "");
      assertToolStream("stdio-stream-toolcall", text);
    } catch (err) {
      mark("stdio", false, err.message);
    } finally {
      stdio.stop();
    }

    try {
      const unary = await grpcCall(ports.grpc, grpcRequest(false));
      const got = grpcToolResult(unary.responses);
      mark(
        "grpc-nonstream-toolcall",
        unary.grpcStatus === 0 && got.name === "get_time" && got.parsed && got.parsed.timezone === "Asia/Dhaka",
        "status=" + unary.grpcStatus + " name=" + got.name + " args=" + got.args,
      );

      const streaming = await grpcCall(ports.grpc, grpcRequest(true));
      const streamed = grpcToolResult(streaming.responses);
      mark(
        "grpc-stream-toolcall",
        streaming.grpcStatus === 0 &&
          streamed.finish === "tool_calls" &&
          streamed.name === "get_time" &&
          streamed.parsed &&
          streamed.parsed.timezone === "Asia/Dhaka",
        "status=" + streaming.grpcStatus + " finish=" + streamed.finish + " name=" + streamed.name,
      );
    } catch (err) {
      mark("grpc", false, err.message);
    }

    if (certOk) {
      try {
        const res = await requestText({
          protocol: "https",
          port: ports.https,
          path: "/v1/chat/completions",
          body: chatBody(false),
        });
        mark("https-nonstream-status", res.status === 200, "status=" + res.status);
        assertToolResponse("https-nonstream-toolcall", JSON.parse(res.text));
      } catch (err) {
        mark("https", false, err.message);
      }
    } else {
      mark("https", false, "no certificate");
    }
  } finally {
    try {
      server.child.kill("SIGTERM");
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (server.child.exitCode === null) {
      try {
        server.child.kill("SIGKILL");
      } catch (_) {}
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("RESULT: TRANSPORTS FAIL (" + failed.map((r) => r.name).join(", ") + ")");
    process.exitCode = 1;
    return;
  }
  console.log("RESULT: ALL TRANSPORTS PASS (http, https, uds, stdio, grpc, normalizer)");
}

main().catch((err) => {
  console.error("ERROR: " + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});
