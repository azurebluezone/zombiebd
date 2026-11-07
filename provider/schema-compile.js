"use strict";
// ─── provider/schema-compile.js — compile-time contract checker ────────
// provider/schema.json is compiled ONCE at require time into plain closures.
// Nothing here walks the schema on the hot path or resolves a $ref per call.
//
// The rule that makes this a compiler instead of a walker: a keyword this
// file cannot enforce aborts compilation. An ignored keyword is a hole, and a
// hole in the boundary is exactly how a malformed provider payload reaches
// api.js. A failed compilation is NOT treated as "validation disabled" —
// every check then returns invalid, so the boundary fails closed.
//
// Anti-Dote mapping (same codes api.js uses):
//   request violation  -> ANTIDOTE_INVALID_REQUEST      (400)
//   response violation -> ANTIDOTE_VERIFICATION_FAILED  (500)
//
// Ops escape hatch: BOUNDARY_VALIDATE=0 in provider/validator.js is the only
// way to disable checks, and it is explicit. A broken schema never disables
// them.

const fs = require("fs");
const path = require("path");

const SCHEMA_PATH = path.join(__dirname, "schema.json");

// Keywords that carry no assertion and therefore need no compiled check.
const ANNOTATIONS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const KEYWORDS = new Set([
  "$defs",
  "$ref",
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "items",
  "minLength",
  "minimum",
  "minItems",
  "additionalProperties",
]);

const TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

class SchemaCompileError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaCompileError";
    this.code = "SCHEMA_COMPILE_FAILED";
  }
}

class AntidoteSchemaError extends Error {
  constructor(kind, details = {}) {
    const def =
      kind === "request"
        ? {
            code: "ANTIDOTE_INVALID_REQUEST",
            statusCode: 400,
            message: "Request violates the provider contract",
          }
        : {
            code: "ANTIDOTE_VERIFICATION_FAILED",
            statusCode: 500,
            message: "Provider output violates the normalized contract",
          };
    const where = details.contract || "unknown contract";
    const why = Array.isArray(details.errors) ? details.errors.join("; ") : "";
    super(def.message + " — " + where + (why ? ": " + why : ""));
    this.name = "AntidoteSchemaError";
    this.code = def.code;
    this.statusCode = def.statusCode;
    this.contract = where;
    this.details = details;
  }
}

function escapePointer(key) {
  return String(key).replace(/~/g, "~0").replace(/\//g, "~1");
}

function typeOk(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sameValue(a, b) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return a === b;
}

function pointerValue(root, ref, at) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new SchemaCompileError(
      at + ": only local \"#/\" $ref is supported, got " + JSON.stringify(ref),
    );
  }
  let current = root;
  for (const rawPart of ref.slice(2).split("/")) {
    const key = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, key)
    ) {
      throw new SchemaCompileError(at + ": dangling $ref " + ref);
    }
    current = current[key];
  }
  return current;
}

function compileSchema(root) {
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new SchemaCompileError("schema root must be an object");
  }
  for (const key of Object.keys(root)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
      throw new SchemaCompileError(
        "#: unsupported keyword \"" + key + "\" — fix the schema or teach schema-compile.js",
      );
    }
  }

  const cache = new Map();
  const pending = new Set();

  function checkerForRef(ref, at) {
    if (cache.has(ref)) return cache.get(ref);
    if (pending.has(ref)) {
      throw new SchemaCompileError(at + ": cyclic $ref " + ref);
    }
    pending.add(ref);
    const node = pointerValue(root, ref, at);
    const checker = compileNode(node, ref, at);
    pending.delete(ref);
    cache.set(ref, checker);
    return checker;
  }

  function compileNode(node, pointer, at) {
    if (node === true) return function () { return true; };
    if (node === false) {
      return function (value, valuePath, errors) {
        errors.push(valuePath + ": schema false rejects any value");
        return false;
      };
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new SchemaCompileError(at + ": schema node must be an object or boolean");
    }

    for (const key of Object.keys(node)) {
      if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) {
        throw new SchemaCompileError(
          at + ": unsupported keyword \"" + key + "\" — fix the schema or teach schema-compile.js",
        );
      }
    }

    if (node.$ref !== undefined) {
      const siblings = Object.keys(node).filter(
        (key) => key !== "$ref" && !ANNOTATIONS.has(key),
      );
      if (siblings.length) {
        throw new SchemaCompileError(
          at + ": $ref siblings are not compiled (" + siblings.join(",") + ")",
        );
      }
      return checkerForRef(node.$ref, at);
    }

    let types = null;
    if (node.type !== undefined) {
      types = Array.isArray(node.type) ? node.type.slice() : [node.type];
      if (!types.length) {
        throw new SchemaCompileError(at + ": type array must not be empty");
      }
      for (const type of types) {
        if (!TYPES.has(type)) {
          throw new SchemaCompileError(at + ": unknown type \"" + type + "\"");
        }
      }
    }

    for (const keyword of ["minLength", "minimum", "minItems"]) {
      if (node[keyword] === undefined) continue;
      if (typeof node[keyword] !== "number" || !Number.isFinite(node[keyword]) || node[keyword] < 0) {
        throw new SchemaCompileError(at + ": " + keyword + " must be a non-negative number");
      }
    }

    if (node.enum !== undefined) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        throw new SchemaCompileError(at + ": enum must be a non-empty array");
      }
    }

    let required = null;
    if (node.required !== undefined) {
      if (
        !Array.isArray(node.required) ||
        node.required.some((key) => typeof key !== "string")
      ) {
        throw new SchemaCompileError(at + ": required must be an array of strings");
      }
      required = node.required.slice();
    }

    const properties = Object.create(null);
    if (node.properties !== undefined) {
      if (
        !node.properties ||
        typeof node.properties !== "object" ||
        Array.isArray(node.properties)
      ) {
        throw new SchemaCompileError(at + ": properties must be an object");
      }
      for (const [key, sub] of Object.entries(node.properties)) {
        properties[key] = compileNode(
          sub,
          pointer + "/properties/" + escapePointer(key),
          at + ".properties." + key,
        );
      }
    }

    let items = null;
    if (node.items !== undefined) {
      if (Array.isArray(node.items)) {
        throw new SchemaCompileError(at + ": tuple items are not supported");
      }
      items = compileNode(node.items, pointer + "/items", at + ".items");
    }

    let additional = null;
    if (node.additionalProperties !== undefined) {
      if (node.additionalProperties === false) additional = false;
      else if (node.additionalProperties === true) additional = true;
      else {
        additional = compileNode(
          node.additionalProperties,
          pointer + "/additionalProperties",
          at + ".additionalProperties",
        );
      }
    }

    const hasConst = node.const !== undefined;
    const constValue = node.const;
    const enumValues = node.enum;

    return function check(value, valuePath, errors) {
      const start = errors.length;

      if (types && !types.some((type) => typeOk(value, type))) {
        errors.push(
          valuePath +
            ": expected " +
            JSON.stringify(types.length === 1 ? types[0] : types) +
            ", got " +
            typeName(value),
        );
        return false;
      }

      if (hasConst && !sameValue(value, constValue)) {
        errors.push(
          valuePath + ": const mismatch, expected " + JSON.stringify(constValue),
        );
      }
      if (enumValues && !enumValues.some((allowed) => sameValue(value, allowed))) {
        errors.push(
          valuePath +
            ": " +
            JSON.stringify(value) +
            " is not one of " +
            JSON.stringify(enumValues),
        );
      }

      if (typeof value === "string") {
        if (node.minLength !== undefined && value.length < node.minLength) {
          errors.push(
            valuePath + ": minLength " + node.minLength + " violated (got " + value.length + ")",
          );
        }
        return errors.length === start;
      }

      if (typeof value === "number") {
        if (node.minimum !== undefined && value < node.minimum) {
          errors.push(valuePath + ": minimum " + node.minimum + " violated");
        }
        return errors.length === start;
      }

      if (Array.isArray(value)) {
        if (node.minItems !== undefined && value.length < node.minItems) {
          errors.push(
            valuePath + ": minItems " + node.minItems + " violated (got " + value.length + ")",
          );
        }
        if (items) {
          value.forEach(function (entry, index) {
            items(entry, valuePath + "[" + index + "]", errors);
          });
        }
        return errors.length === start;
      }

      if (value !== null && typeof value === "object") {
        if (required) {
          for (const key of required) {
            if (
              !Object.prototype.hasOwnProperty.call(value, key) ||
              value[key] === undefined
            ) {
              errors.push(valuePath + ': missing required "' + key + '"');
            }
          }
        }
        for (const key of Object.keys(properties)) {
          if (value[key] === undefined) continue; // absent optional property
          properties[key](value[key], valuePath + "." + key, errors);
        }
        if (additional === false) {
          for (const key of Object.keys(value)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
              errors.push(valuePath + ': additional property "' + key + '" not allowed');
            }
          }
        } else if (additional && additional !== true) {
          for (const key of Object.keys(value)) {
            if (!Object.prototype.hasOwnProperty.call(properties, key)) {
              additional(value[key], valuePath + "." + key, errors);
            }
          }
        }
        return errors.length === start;
      }

      return errors.length === start;
    };
  }

  const defs = root.$defs && typeof root.$defs === "object" ? root.$defs : {};
  for (const name of Object.keys(defs)) {
    checkerForRef("#/$defs/" + escapePointer(name), "#/$defs/" + name);
  }
  return cache;
}

function codeFor(ref) {
  return ref === "#/$defs/chatRequest"
    ? "ANTIDOTE_INVALID_REQUEST"
    : "ANTIDOTE_VERIFICATION_FAILED";
}

let CHECKERS = null;
let COMPILE_ERROR = null;
let DEFS = 0;

try {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));
  CHECKERS = compileSchema(schema);
  DEFS = Object.keys(schema.$defs || {}).length;
  for (const requiredRef of [
    "#/$defs/chatRequest",
    "#/$defs/chatCompletion",
    "#/$defs/chatCompletionChunk",
  ]) {
    if (!CHECKERS.has(requiredRef)) {
      throw new SchemaCompileError("schema.json is missing required contract " + requiredRef);
    }
  }
} catch (error) {
  COMPILE_ERROR = (error && error.message) || String(error);
  CHECKERS = null;
}

function ready() {
  return COMPILE_ERROR === null && CHECKERS !== null;
}

function compileError() {
  return COMPILE_ERROR;
}

function validate(ref, value) {
  if (!ready()) {
    return {
      valid: false,
      errors: ["schema_compile_failed: " + COMPILE_ERROR],
      compiled: false,
      code: codeFor(ref),
    };
  }
  const checker = CHECKERS.get(ref);
  if (!checker) {
    return {
      valid: false,
      errors: ["unknown contract " + ref],
      compiled: true,
      code: codeFor(ref),
    };
  }
  const errors = [];
  checker(value, "$", errors);
  return {
    valid: errors.length === 0,
    errors,
    compiled: true,
    code: codeFor(ref),
  };
}

function assert(ref, value) {
  const result = validate(ref, value);
  if (!result.valid) {
    throw new AntidoteSchemaError(
      ref === "#/$defs/chatRequest" ? "request" : "response",
      { contract: ref, errors: result.errors },
    );
  }
  return value;
}

module.exports = {
  SCHEMA_PATH,
  SchemaCompileError,
  AntidoteSchemaError,
  compileSchema,
  compileError,
  ready,
  validate,
  assert,
  defs: function () {
    return DEFS;
  },
};

if (require.main === module) {
  if (!ready()) {
    console.log("schema=" + SCHEMA_PATH);
    console.log("RESULT: SCHEMA COMPILE FAIL " + COMPILE_ERROR);
    process.exitCode = 1;
  } else {
    console.log("schema=" + SCHEMA_PATH);
    console.log("defs=" + DEFS + " compiled=" + CHECKERS.size);
    console.log("RESULT: SCHEMA COMPILE PASS defs=" + DEFS + " compiled=" + CHECKERS.size);
  }
}
