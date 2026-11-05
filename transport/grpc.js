"use strict";
/*
 * Minimal gRPC transport: HTTP/2 cleartext, one frame per message.
 * Service: zombie.v1.ChatService/Chat  (unary and server streaming)
 * The handler forwards to the same OpenAI endpoint as every other
 * transport, so routing, fallback and tool parsing stay in one place.
 */

const http = require("http");
const http2 = require("http2");
const {
  encodeChatResponse,
  decodeChatRequest,
  frame,
  unframe,
} = require("./protobuf");

const CHAT_PATH = "/zombie.v1.ChatService/Chat";
const CONTENT_TYPE = "application/grpc";

function toOpenAIPayload(req) {
  const body = {
    model: req.model,
    messages: req.messages || [],
    stream: !!req.stream,
    temperature: req.temperature || 0,
  };
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (Array.isArray(req.tools) && req.tools.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
  return body;
}

function chunkToResponse(chunk, fallbackModel) {
  const choice = chunk.choices && chunk.choices[0];
  const delta = (choice && choice.delta) || {};
  const calls = (delta.tool_calls || []).map((c) => ({
    id: c.id || "",
    function: {
      name: (c.function && c.function.name) || "",
      arguments: (c.function && c.function.arguments) || "",
    },
  }));
  return {
    id: chunk.id || "",
    model: chunk.model || fallbackModel || "",
    content: delta.content || "",
    finish_reason: (choice && choice.finish_reason) || "",
    tool_calls: calls,
  };
}

function postJson(upstream, payload, onSseLine) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: upstream.path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: payload.stream ? "text/event-stream" : "application/json",
        },
      },
      (res) => {
        let raw = "";
        let pending = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (!onSseLine) return;
          pending += chunk;
          let cut;
          while ((cut = pending.indexOf("\n")) !== -1) {
            onSseLine(pending.slice(0, cut));
            pending = pending.slice(cut + 1);
          }
        });
        res.on("end", () => {
          if (onSseLine) {
            if (pending) onSseLine(pending);
            resolve({ status: res.statusCode });
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            reject(new Error("invalid upstream JSON: " + raw.slice(0, 200)));
            return;
          }
          if (res.statusCode >= 400) {
            reject(new Error((parsed.error && parsed.error.message) || "upstream " + res.statusCode));
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function parseUpstream(value) {
  const url = new URL(value || "http://127.0.0.1:5050");
  return {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: "/v1/chat/completions",
  };
}

function createGrpcServer(options) {
  const opts = options || {};
  const upstream = parseUpstream(opts.upstream);
  const server = http2.createServer();

  server.on("stream", (stream, headers) => {
    const fail = (code, message) => {
      if (stream.headersSent) return stream.end();
      stream.respond({
        ":status": 200,
        "content-type": CONTENT_TYPE,
        "grpc-status": String(code),
        "grpc-message": encodeURIComponent(message || ""),
      });
      stream.end();
    };

    if (headers[":method"] !== "POST") return fail(12, "method not allowed");
    if (headers[":path"] !== CHAT_PATH) return fail(12, "unknown method " + headers[":path"]);

    const parts = [];
    stream.on("data", (c) => parts.push(c));
    stream.on("error", () => {});
    stream.on("end", async () => {
      let request;
      try {
        request = decodeChatRequest(unframe(Buffer.concat(parts)).payload);
      } catch (err) {
        return fail(3, "bad request: " + err.message);
      }

      let responded = false;
      let trailers = { "grpc-status": "0" };
      const send = (response) => {
        if (!responded) {
          responded = true;
          stream.respond({ ":status": 200, "content-type": CONTENT_TYPE }, { waitForTrailers: true });
          stream.on("wantTrailers", () => {
            try {
              stream.sendTrailers(trailers);
            } catch (_) {}
          });
        }
        stream.write(frame(Buffer.from(encodeChatResponse(response))));
      };

      try {
        if (!request.stream) {
          const result = await postJson(upstream, toOpenAIPayload(request));
          const body = result.body || {};
          const choice = (body.choices && body.choices[0]) || {};
          const message = choice.message || {};
          send({
            id: body.id || "",
            model: body.model || request.model,
            content: message.content || "",
            finish_reason: choice.finish_reason || "stop",
            tool_calls: (message.tool_calls || []).map((c) => ({
              id: c.id || "",
              function: {
                name: (c.function && c.function.name) || "",
                arguments: (c.function && c.function.arguments) || "",
              },
            })),
          });
          stream.end();
          return;
        }

        const endMarker = "[" + "DONE" + "]";
        const onLine = (line) => {
          const text = line.trim();
          if (!text.startsWith("data:")) return;
          const data = text.slice(5).trim();
          if (!data || data === endMarker) return;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch (_) {
            return;
          }
          const response = chunkToResponse(chunk, request.model);
          if (response.content || response.finish_reason || response.tool_calls.length) send(response);
        };
        const result = await postJson(upstream, toOpenAIPayload(request), onLine);
        if (!responded) {
          if (result.status >= 400) throw new Error("upstream status " + result.status);
          send({ id: "", model: request.model, content: "", finish_reason: "stop", tool_calls: [] });
        }
        stream.end();
      } catch (err) {
        if (!responded) return fail(13, err.message);
        trailers = { "grpc-status": "13", "grpc-message": encodeURIComponent(err.message) };
        stream.end();
      }
    });
  });

  return {
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(opts.port || 0, opts.host || "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createGrpcServer, CHAT_PATH };
