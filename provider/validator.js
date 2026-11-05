"use strict";
// ─── provider/validator.js — boundary validator (zero-dependency) ──────
// Connects provider/schema.json to the runtime as a REJECT-AT-BOUNDARY
// validator. provider/index.js checks every payload BEFORE it leaves or
// enters the server:
//   • request   → #/$defs/chatRequest
//   • response  → #/$defs/chatCompletion   (non-stream)
//   • stream    → #/$defs/chatCompletionChunk (each normalized frame)
//
// Implementation note: minimal draft-2020-12 subset covering exactly the
// keywords provider/schema.json uses — $ref, type (+ arrays), const, enum,
// required, properties, items, minLength, minimum, minItems,
// additionalProperties. Zero dependencies by project rule.
//
// Ops escape hatch: BOUNDARY_VALIDATE=0 disables the checks at runtime.

const fs = require("fs");
const path = require("path");

let SCHEMA = null;
let LOAD_ERROR = null;
try {
  SCHEMA = JSON.parse(
    fs.readFileSync(path.join(__dirname, "schema.json"), "utf8"),
  );
} catch (e) {
  LOAD_ERROR = "schema.json failed to load: " + e.message;
}

const ENABLED = process.env.BOUNDARY_VALIDATE !== "0";

// ─── $ref resolution (only local "#/$defs/..." pointers are supported) ─
function resolveSub(raw, root) {
  if (typeof raw === "string") {
    if (!raw.startsWith("#/")) return { error: "unsupported $ref " + raw };
    let cur = root;
    for (const part of raw.slice(2).split("/")) {
      if (cur == null) return { error: "bad $ref " + raw };
      cur = cur[part];
    }
    return { schema: cur };
  }
  if (raw && typeof raw === "object" && typeof raw.$ref === "string") {
    return resolveSub(raw.$ref, root);
  }
  return { schema: raw };
}

function typeOk(value, t) {
  switch (t) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}

const typeName = (v) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

function walk(instance, raw, root, errors, at) {
  if (instance === undefined || instance === null) return;

  const { schema, error } = resolveSub(raw, root);
  if (error) { errors.push(at + ": " + error); return; }
  if (schema === true) return;
  if (schema === false) { errors.push(at + ": schema false rejects any value"); return; }
  if (!schema || typeof schema !== "object") return;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(instance, t))) {
      errors.push(
        at + ": expected " + JSON.stringify(schema.type) + ", got " + typeName(instance),
      );
      return;
    }
  }
  if (schema.const !== undefined && instance !== schema.const) {
    errors.push(at + ": const mismatch, expected " + JSON.stringify(schema.const));
  }
  if (schema.enum !== undefined && !schema.enum.includes(instance)) {
    errors.push(at + ": value not in enum " + JSON.stringify(schema.enum));
  }

  if (typeof instance === "string") {
    if (schema.minLength !== undefined && instance.length < schema.minLength) {
      errors.push(at + ': minLength ' + schema.minLength + ' violated');
    }
    return;
  }
  if (typeof instance === "number") {
    if (schema.minimum !== undefined && instance < schema.minimum) {
      errors.push(at + ": minimum " + schema.minimum + " violated");
    }
    return;
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      errors.push(at + ': minItems ' + schema.minItems + " violated (got " + instance.length + ")");
    }
    if (schema.items) {
      instance.forEach(function (it, i) {
        walk(it, schema.items, root, errors, at + "[" + i + "]");
      });
    }
    return;
  }
  if (typeof instance === "object") {
    const props = schema.properties || {};
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in instance)) errors.push(at + ': missing required "' + key + '"');
      }
    }
    for (const key of Object.keys(props)) {
      if (instance[key] === undefined) continue; // absent optional property
      walk(instance[key], props[key], root, errors, at + "." + key);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(instance)) {
        if (!props[key]) errors.push(at + ': additional property "' + key + '" not allowed');
      }
    }
  }
}

function validate(instance, refPath) {
  if (!ENABLED || !SCHEMA) return { valid: true, errors: [], disabled: true };
  const errors = [];
  walk(instance, refPath, SCHEMA, errors, "$");
  return { valid: errors.length === 0, errors: errors };
}

module.exports = {
  validateRequest: function (req) { return validate(req, "#/$defs/chatRequest"); },
  validateResponse: function (res) { return validate(res, "#/$defs/chatCompletion"); },
  validateDelta: function (chunk) { return validate(chunk, "#/$defs/chatCompletionChunk"); },
  enabled: function () { return ENABLED && !!SCHEMA && !LOAD_ERROR; },
  schemaError: LOAD_ERROR,
  validate: validate,
};