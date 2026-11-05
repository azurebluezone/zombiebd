"use strict";
/*
 * Zero-dependency protobuf codec for the zombie.v1 Chat service.
 * Only the wire types this service needs: varint, 64-bit, length-delimited.
 */

const WIRE = { VARINT: 0, FIXED64: 1, LEN: 2, FIXED32: 5 };

function varint(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n < 0) n = 0;
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint(field * 8 + wire);
}

function bytesField(field, buf) {
  if (!buf || !buf.length) return Buffer.alloc(0);
  return Buffer.concat([tag(field, WIRE.LEN), varint(buf.length), buf]);
}

function stringField(field, value) {
  if (value === undefined || value === null || value === "") return Buffer.alloc(0);
  return bytesField(field, Buffer.from(String(value), "utf8"));
}

function messageField(field, buf) {
  return bytesField(field, buf);
}

function boolField(field, value) {
  if (!value) return Buffer.alloc(0);
  return Buffer.concat([tag(field, WIRE.VARINT), Buffer.from([1])]);
}

function doubleField(field, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return Buffer.alloc(0);
  const body = Buffer.alloc(8);
  body.writeDoubleLE(n, 0);
  return Buffer.concat([tag(field, WIRE.FIXED64), body]);
}

function encodeMessage(msg) {
  const m = msg || {};
  return Buffer.concat([stringField(1, m.role), stringField(2, m.content)]);
}

function encodeTool(tool) {
  const t = tool || {};
  const fn = t.function || t;
  const params =
    typeof fn.parameters === "string" ? fn.parameters : JSON.stringify(fn.parameters || {});
  return Buffer.concat([
    stringField(1, fn.name || ""),
    stringField(2, fn.description || ""),
    stringField(3, params),
  ]);
}

function encodeChatRequest(req) {
  const r = req || {};
  const parts = [stringField(1, r.model)];
  for (const m of r.messages || []) parts.push(messageField(2, encodeMessage(m)));
  parts.push(boolField(3, r.stream));
  parts.push(doubleField(4, r.temperature));
  parts.push(stringField(5, r.tool_choice));
  for (const t of r.tools || []) parts.push(messageField(6, encodeTool(t)));
  return Buffer.concat(parts);
}

function encodeToolCall(call) {
  const c = call || {};
  const fn = c.function || {};
  return Buffer.concat([
    stringField(1, c.id || ""),
    stringField(2, fn.name || c.name || ""),
    stringField(3, fn.arguments || c.arguments || ""),
  ]);
}

function encodeChatResponse(res) {
  const r = res || {};
  const parts = [
    stringField(1, r.id),
    stringField(2, r.model),
    stringField(3, r.content),
    stringField(4, r.finish_reason),
  ];
  for (const c of r.tool_calls || []) parts.push(messageField(5, encodeToolCall(c)));
  return Buffer.concat(parts);
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  done() {
    return this.pos >= this.buf.length;
  }
  varint() {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 49) break;
    }
    throw new Error("truncated varint");
  }
  bytes() {
    const len = this.varint();
    if (this.pos + len > this.buf.length) throw new Error("truncated field");
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  fixed64() {
    if (this.pos + 8 > this.buf.length) throw new Error("truncated fixed64");
    const out = this.buf.subarray(this.pos, this.pos + 8);
    this.pos += 8;
    return out;
  }
  skip(wire) {
    if (wire === WIRE.VARINT) this.varint();
    else if (wire === WIRE.FIXED64) this.pos += 8;
    else if (wire === WIRE.LEN) this.pos += this.varint();
    else if (wire === WIRE.FIXED32) this.pos += 4;
    else throw new Error("unsupported wire type " + wire);
    if (this.pos > this.buf.length) throw new Error("truncated skip");
  }
}

function decodeMessage(buf) {
  const r = new Reader(buf);
  const out = { role: "", content: "" };
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1 && wire === WIRE.LEN) out.role = r.bytes().toString("utf8");
    else if (field === 2 && wire === WIRE.LEN) out.content = r.bytes().toString("utf8");
    else r.skip(wire);
  }
  return out;
}

function decodeTool(buf) {
  const r = new Reader(buf);
  const out = { name: "", description: "", parameters: {} };
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1 && wire === WIRE.LEN) out.name = r.bytes().toString("utf8");
    else if (field === 2 && wire === WIRE.LEN) out.description = r.bytes().toString("utf8");
    else if (field === 3 && wire === WIRE.LEN) {
      const raw = r.bytes().toString("utf8");
      try {
        out.parameters = JSON.parse(raw);
      } catch (_) {
        out.parameters = {};
      }
    } else r.skip(wire);
  }
  return out;
}

function decodeChatRequest(buf) {
  const r = new Reader(buf);
  const out = { model: "", messages: [], stream: false, temperature: 0, tool_choice: "", tools: [] };
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1 && wire === WIRE.LEN) out.model = r.bytes().toString("utf8");
    else if (field === 2 && wire === WIRE.LEN) out.messages.push(decodeMessage(r.bytes()));
    else if (field === 3 && wire === WIRE.VARINT) out.stream = r.varint() !== 0;
    else if (field === 4 && wire === WIRE.FIXED64) out.temperature = r.fixed64().readDoubleLE(0);
    else if (field === 5 && wire === WIRE.LEN) out.tool_choice = r.bytes().toString("utf8");
    else if (field === 6 && wire === WIRE.LEN) out.tools.push(decodeTool(r.bytes()));
    else r.skip(wire);
  }
  return out;
}

function decodeToolCall(buf) {
  const r = new Reader(buf);
  const out = { id: "", function: { name: "", arguments: "" } };
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1 && wire === WIRE.LEN) out.id = r.bytes().toString("utf8");
    else if (field === 2 && wire === WIRE.LEN) out.function.name = r.bytes().toString("utf8");
    else if (field === 3 && wire === WIRE.LEN) out.function.arguments = r.bytes().toString("utf8");
    else r.skip(wire);
  }
  return out;
}

function decodeChatResponse(buf) {
  const r = new Reader(buf);
  const out = { id: "", model: "", content: "", finish_reason: "", tool_calls: [] };
  while (!r.done()) {
    const key = r.varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 1 && wire === WIRE.LEN) out.id = r.bytes().toString("utf8");
    else if (field === 2 && wire === WIRE.LEN) out.model = r.bytes().toString("utf8");
    else if (field === 3 && wire === WIRE.LEN) out.content = r.bytes().toString("utf8");
    else if (field === 4 && wire === WIRE.LEN) out.finish_reason = r.bytes().toString("utf8");
    else if (field === 5 && wire === WIRE.LEN) out.tool_calls.push(decodeToolCall(r.bytes()));
    else r.skip(wire);
  }
  return out;
}

function frame(payload, compressed) {
  const head = Buffer.alloc(5);
  head[0] = compressed ? 1 : 0;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function unframe(buf) {
  if (buf.length < 5) throw new Error("short gRPC frame");
  const compressed = buf[0] === 1;
  const len = buf.readUInt32BE(1);
  if (buf.length < 5 + len) throw new Error("truncated gRPC frame");
  return { compressed, payload: buf.subarray(5, 5 + len), rest: buf.subarray(5 + len) };
}

module.exports = {
  encodeChatRequest,
  decodeChatRequest,
  encodeChatResponse,
  decodeChatResponse,
  frame,
  unframe,
};
