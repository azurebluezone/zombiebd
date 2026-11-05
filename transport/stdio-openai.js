#!/usr/bin/env node
"use strict";
/*
 * OpenAI-over-STDIO bridge.
 * stdin:  one JSON chat-completion request per line.
 * stdout: one JSON line per event:
 *   {"chunk":{...}}                       streamed chat.completion.chunk
 *   {"response":{...}}                    non-streamed chat.completion
 *   {"done":true,"finish_reason":"..."}   stream finished
 *   {"error":{...}}                       request failed
 * Target: OPENAI_UDS_PATH (preferred) or OPENAI_BASE_URL
 * (default http://127.0.0.1:5050). Zero dependencies.
 */

const http = require("http");
const readline = require("readline");

const UDS_PATH = process.env.OPENAI_UDS_PATH || "";
const BASE_URL = process.env.OPENAI_BASE_URL || "http://127.0.0.1:5050";
const API_KEY = process.env.OPENAI_API_KEY || "";

function writeLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function target() {
  if (UDS_PATH) return { socketPath: UDS_PATH, path: "/v1/chat/completions" };
  const url = new URL(BASE_URL);
  const prefix = url.pathname === "/" ? "" : url.pathname;
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: prefix + "/v1/chat/completions",
  };
}

function send(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const opts = Object.assign({ method: "POST" }, target(), {
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Accept: payload.stream ? "text/event-stream" : "application/json",
        ...(API_KEY ? { Authorization: "Bearer " + API_KEY } : {}),
      },
    });
    const req = http.request(opts, (res) => {
      let raw = "";
      let pending = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (!payload.stream) {
          raw += chunk;
          return;
        }
        pending += chunk;
        let cut;
        while ((cut = pending.indexOf("\n")) !== -1) {
          emitSseLine(pending.slice(0, cut));
          pending = pending.slice(cut + 1);
        }
      });
      res.on("end", () => {
        if (!payload.stream) {
          try {
            writeLine({ response: JSON.parse(raw) });
            resolve();
          } catch (err) {
            reject(new Error("invalid JSON response: " + raw.slice(0, 200)));
          }
          return;
        }
        if (pending) emitSseLine(pending);
        resolve();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const END_MARKER = "[" + "DONE" + "]";
let currentFinish = null;

function emitSseLine(line) {
  const text = line.trim();
  if (!text.startsWith("data:")) return;
  const data = text.slice(5).trim();
  if (!data) return;
  if (data === END_MARKER) {
    writeLine({ done: true, finish_reason: currentFinish || "stop" });
    currentFinish = null;
    return;
  }
  try {
    const chunk = JSON.parse(data);
    const choice = chunk.choices && chunk.choices[0];
    if (choice && choice.finish_reason) currentFinish = choice.finish_reason;
    writeLine({ chunk });
  } catch (_) {
    writeLine({ error: { message: "invalid SSE payload", payload: data.slice(0, 120) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  queue = queue.then(async () => {
    currentFinish = null;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      writeLine({ error: { message: "invalid JSON request: " + err.message } });
      return;
    }
    try {
      await send(payload);
    } catch (err) {
      writeLine({ error: { message: err.message } });
    }
  });
});

rl.on("close", () => {
  queue.then(() => process.exit(0));
});
