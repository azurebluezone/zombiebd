#!/usr/bin/env node
"use strict";

/*
 * Session reuse gate.
 *
 * Proves the rule the gateway implements in api.js:
 *   resolveClientIdentity()  api.js:4261  → body client_id, header, auth hash, ip
 *   createSession()          api.js:5846  → reuse key = clientId + ":" + editor
 *   chat route               api.js:16026 → session_id from body or create/reuse
 *   response builder         api.js:17110 → session_id + conversation_id
 *
 * Four real HTTP calls, no mocks:
 *   1. client A creates a session
 *   2. client A again reuses the identical session_id and conversation_id
 *   3. client A with a different editor gets a new session
 *   4. client B gets a new session
 *
 * The probe sessions are real gateway sessions; they expire with the normal
 * SESSION_TTL (24h by default) and are named with this run id so they are
 * easy to spot. Nothing is deleted behind the server's back.
 */

const http = require("http");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 5050);
const MODEL = process.env.SESSION_PROBE_MODEL || "lfm3:1.7b";
const REQUEST_TIMEOUT_MS = 25000;
const DEADLINE_MS = 100000;
const STARTED = Date.now();
const RUN = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);

function request(method, pathname, body) {
  return new Promise(function (resolve) {
    const payload = body == null ? null : JSON.stringify(body);
    const headers = { Accept: "application/json" };
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const startedAt = Date.now();
    const req = http.request(
      { host: HOST, port: PORT, path: pathname, method: method, headers: headers },
      function (res) {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", function (chunk) {
          text += chunk;
        });
        res.on("end", function () {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            json = null;
          }
          resolve({
            status: res.statusCode,
            json: json,
            text: text,
            elapsed: Date.now() - startedAt,
          });
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, function () {
      req.destroy(new Error("timeout after " + REQUEST_TIMEOUT_MS + "ms"));
    });
    req.on("error", function (err) {
      resolve({
        status: 0,
        json: null,
        text: "",
        elapsed: Date.now() - startedAt,
        error: err.message,
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function chat(clientId, editor) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
    client_id: clientId,
  };
  if (editor) body.editor = editor;
  return request("POST", "/v1/chat/completions", body);
}

function ids(res) {
  const j = res.json || {};
  return {
    session: j.session_id || "",
    conversation: j.conversation_id || "",
  };
}

function describe(res) {
  if (res.status !== 200) {
    const err =
      res.json && res.json.error && res.json.error.message
        ? String(res.json.error.message).slice(0, 100)
        : res.error || res.text.slice(0, 100);
    return "HTTP " + res.status + (err ? ": " + err : "");
  }
  const i = ids(res);
  return (
    "HTTP 200 session=" +
    (i.session ? i.session.slice(0, 8) : "missing") +
    " conversation=" +
    (i.conversation ? i.conversation.slice(0, 8) : "missing") +
    " " +
    res.elapsed +
    "ms"
  );
}

function outOfTime() {
  return Date.now() - STARTED > DEADLINE_MS;
}

function fail(message) {
  console.error("SESSION_REUSE_FAIL: " + message);
  process.exitCode = 1;
}

async function main() {
  console.log("=== session reuse gate " + RUN + " ===");
  console.log("base=http://" + HOST + ":" + PORT + " model=" + MODEL);
  console.log("");

  const clientA = "session-probe-a-" + RUN;
  const clientB = "session-probe-b-" + RUN;
  const editorB = "session-probe-editor-" + RUN;

  // 1. Create
  const first = await chat(clientA);
  console.log("1 create       client=A " + describe(first));
  if (first.status !== 200) return fail("create call did not return 200");
  const firstIds = ids(first);
  if (!firstIds.session || !firstIds.conversation) {
    return fail("create response is missing session_id or conversation_id");
  }
  if (firstIds.session !== firstIds.conversation) {
    return fail("new session_id and conversation_id must match");
  }

  // 2. Reuse by same client + default editor
  if (outOfTime()) return fail("deadline exceeded before reuse call");
  const second = await chat(clientA);
  console.log("2 reuse        client=A " + describe(second));
  if (second.status !== 200) return fail("reuse call did not return 200");
  const secondIds = ids(second);
  if (secondIds.session !== firstIds.session) {
    return fail(
      "same client+editor must reuse session_id (" +
        secondIds.session +
        " != " +
        firstIds.session +
        ")",
    );
  }
  if (secondIds.conversation !== firstIds.conversation) {
    return fail("same session must keep the same conversation_id");
  }

  // 3. New session when the editor changes
  if (outOfTime()) return fail("deadline exceeded before editor call");
  const third = await chat(clientA, editorB);
  console.log("3 editor diff  client=A " + describe(third));
  if (third.status !== 200) return fail("editor call did not return 200");
  const thirdIds = ids(third);
  if (!thirdIds.session) return fail("editor response has no session_id");
  if (thirdIds.session === firstIds.session) {
    return fail("a different editor must create a different session_id");
  }

  // 4. New session when the client changes
  if (outOfTime()) return fail("deadline exceeded before client call");
  const fourth = await chat(clientB);
  console.log("4 client diff  client=B " + describe(fourth));
  if (fourth.status !== 200) return fail("client call did not return 200");
  const fourthIds = ids(fourth);
  if (!fourthIds.session) return fail("client response has no session_id");
  if (fourthIds.session === firstIds.session) {
    return fail("a different client must create a different session_id");
  }

  // 5. The created session is readable through the session API
  const lookup = await request(
    "GET",
    "/api/sessions/" + encodeURIComponent(firstIds.session),
    null,
  );
  const found =
    lookup.status === 200 &&
    lookup.json &&
    lookup.json.session &&
    lookup.json.session.id === firstIds.session;
  console.log(
    "5 lookup       GET /api/sessions/" +
      firstIds.session.slice(0, 8) +
      " " +
      (found ? "200 id matches" : "HTTP " + lookup.status + " mismatch"),
  );
  if (!found) return fail("created session is not readable via /api/sessions");

  console.log("");
  console.log("rule: reuse key = client_id + ':' + editor (api.js:5849)");
  console.log("probe sessions: " + clientA + ":" + "hermes, " + editorB + ", " + clientB);
  console.log("SESSION_REUSE_OK");
}

main().catch(function (err) {
  fail(err && err.stack ? err.stack : String(err));
});
