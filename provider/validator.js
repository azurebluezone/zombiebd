"use strict";
// ─── provider/validator.js — boundary adapter ─────────────────────────
// provider/index.js calls this for every payload that leaves or enters the
// server:
//   • request  → #/$defs/chatRequest
//   • response → #/$defs/chatCompletion      (non-stream)
//   • stream   → #/$defs/chatCompletionChunk (each normalized frame)
//
// The checks themselves live in schema-compile.js, which compiles
// provider/schema.json once. This file only owns the ops switch: a build that
// cannot compile the schema must NOT become permissive, so compile failures
// are reported as validation failures by the compiler.
//
// Ops escape hatch: BOUNDARY_VALIDATE=0 disables the checks explicitly.

const compiler = require("./schema-compile.js");

const ENABLED = process.env.BOUNDARY_VALIDATE !== "0";

function validate(instance, refPath) {
  if (!ENABLED) return { valid: true, errors: [], disabled: true };
  return compiler.validate(refPath, instance);
}

module.exports = {
  validateRequest: function (req) {
    return validate(req, "#/$defs/chatRequest");
  },
  validateResponse: function (res) {
    return validate(res, "#/$defs/chatCompletion");
  },
  validateDelta: function (chunk) {
    return validate(chunk, "#/$defs/chatCompletionChunk");
  },
  assertRequest: function (req) {
    return compiler.assert("#/$defs/chatRequest", req);
  },
  assertResponse: function (res) {
    return compiler.assert("#/$defs/chatCompletion", res);
  },
  enabled: function () {
    return ENABLED;
  },
  ready: function () {
    return compiler.ready();
  },
  schemaError: compiler.compileError(),
  validate: validate,
};
