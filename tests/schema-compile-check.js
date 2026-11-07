#!/usr/bin/env node
"use strict";

/*
 * Gate for provider/schema-compile.js and the boundary that uses it.
 *
 * Proves four things with real runs:
 *   1. provider/schema.json compiles and every contract ref resolves.
 *   2. malformed provider output is rejected — including the shapes the old
 *      walker let through (null, wrong scalar type, missing required, extra
 *      nested properties).
 *   3. a schema the compiler cannot enforce fails compilation, and a failed
 *      compilation makes validation fail closed in a fresh process.
 *   4. .env / .env.example carry no stale or dead comments, and .env still
 *      parses with the same critical keys.
 *
 * With SCHEMA_CHECK_LIVE=1 the gate also asks the real Gemini provider for a
 * completion, validates the normalized response, and mutates it to prove the
 * boundary rejects what it accepted before. No stub sits in the provider path.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { loadEnv, parseEnvFile } = require("../lib/env.js");
const compiler = require("../provider/schema-compile.js");
const validator = require("../provider/validator.js");

const ROOT = path.resolve(__dirname, "..");
const LIVE = process.env.SCHEMA_CHECK_LIVE === "1";

let failures = 0;
let passed = 0;

function pass(name, detail) {
  passed++;
  console.log("PASS " + name + (detail ? " — " + detail : ""));
}

function fail(name, detail) {
  failures++;
  console.log("FAIL " + name + (detail ? " — " + detail : ""));
}

function expect(name, condition, detail) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

// ─── 1. Compiler is ready ─────────────────────────────────────────────
expect("schema compiles at load", compiler.ready(), compiler.compileError() || "");
expect("validator reports ready", validator.ready() === true);
expect("no schema load error", validator.schemaError === null);

// ─── 2. Accept real contract shapes ───────────────────────────────────
const completion = {
  id: "chatcmpl-check",
  object: "chat.completion",
  created: 1,
  model: "gemini-lite",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "SCHEMA-OK" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const completionNulls = {
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: null },
      finish_reason: null,
    },
  ],
  usage: null,
};

const request = {
  model: "gemini-lite",
  messages: [{ role: "user", content: "hi" }],
  stream: false,
};

const delta = {
  object: "chat.completion.chunk",
  choices: [
    { index: 0, delta: { role: "assistant", content: "h" }, finish_reason: null },
  ],
};

const accepts = [
  ["chatCompletion", "#/$defs/chatCompletion", completion],
  ["chatCompletion with null content/usage", "#/$defs/chatCompletion", completionNulls],
  ["chatRequest", "#/$defs/chatRequest", request],
  ["chatCompletionChunk", "#/$defs/chatCompletionChunk", delta],
];

for (const [name, ref, value] of accepts) {
  const result = compiler.validate(ref, value);
  expect("accept " + name, result.valid, result.errors.join("; "));
}

// ─── 3. Reject malformed responses ────────────────────────────────────
const rejects = [
  ["choices:null", "#/$defs/chatCompletion", { choices: null }, 'expected "array", got null'],
  ["missing choices", "#/$defs/chatCompletion", {}, 'missing required "choices"'],
  ["empty choices", "#/$defs/chatCompletion", { choices: [] }, "minItems 1 violated"],
  [
    "message without role",
    "#/$defs/chatCompletion",
    { choices: [{ index: 0, message: { content: "x" } }] },
    'missing required "role"',
  ],
  [
    "unknown role",
    "#/$defs/chatCompletion",
    { choices: [{ index: 0, message: { role: "robot" } }] },
    '"robot" is not one of',
  ],
  [
    "content wrong type",
    "#/$defs/chatCompletion",
    { choices: [{ index: 0, message: { role: "assistant", content: 42 } }] },
    'expected ["string","null"], got number',
  ],
  ["usage wrong type", "#/$defs/chatCompletion", { choices: [{ index: 0, message: { role: "assistant" } }], usage: "x" }, 'expected ["object","null"], got string'],
  [
    "unknown finish_reason",
    "#/$defs/chatCompletion",
    { choices: [{ index: 0, message: { role: "assistant" }, finish_reason: "done" }] },
    '"done" is not one of',
  ],
  [
    "tool arguments not a string",
    "#/$defs/chatCompletion",
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              { id: "c1", type: "function", function: { name: "f", arguments: { a: 1 } } },
            ],
          },
        },
      ],
    },
    'expected "string", got object',
  ],
  [
    "tool function extra property",
    "#/$defs/chatCompletion",
    {
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: "{}", extra: true },
              },
            ],
          },
        },
      ],
    },
    'additional property "extra" not allowed',
  ],
  ["request empty model", "#/$defs/chatRequest", { model: "", messages: [] }, "minLength 1 violated"],
  [
    "request messages not an array",
    "#/$defs/chatRequest",
    { model: "gemini-lite", messages: "nope" },
    'expected "array", got string',
  ],
  [
    "delta without delta object",
    "#/$defs/chatCompletionChunk",
    { choices: [{ index: 0 }] },
    'missing required "delta"',
  ],
];

for (const [name, ref, value, want] of rejects) {
  const result = compiler.validate(ref, value);
  const text = result.errors.join("; ");
  expect(
    "reject " + name,
    result.valid === false && text.includes(want),
    result.valid ? "accepted invalid payload" : text,
  );
}

// ─── 4. Unenforceable schema fails compilation ────────────────────────
const compileRejects = [
  [
    "unsupported keyword",
    { $defs: { a: { type: "object", oneOf: [] } } },
    'unsupported keyword "oneOf"',
  ],
  [
    "dangling $ref",
    { $defs: { a: { $ref: "#/$defs/missing" } } },
    "dangling $ref",
  ],
  ["unknown type", { $defs: { a: { type: "date" } } }, 'unknown type "date"'],
  [
    "$ref siblings",
    { $defs: { a: { $ref: "#/$defs/b", minLength: 1 }, b: { type: "string" } } },
    "$ref siblings are not compiled",
  ],
];

for (const [name, schema, want] of compileRejects) {
  try {
    compiler.compileSchema(schema);
    fail("compile rejects " + name, "compilation succeeded");
  } catch (error) {
    expect(
      "compile rejects " + name,
      error instanceof compiler.SchemaCompileError && String(error.message).includes(want),
      error.message,
    );
  }
}

// A failed compile must fail closed in a fresh process, not become permissive.
const failClosedDir = fs.mkdtempSync(path.join("/tmp/opencode", "schema-fail-"));
fs.copyFileSync(
  path.join(__dirname, "..", "provider", "schema-compile.js"),
  path.join(failClosedDir, "schema-compile.js"),
);
fs.writeFileSync(
  path.join(failClosedDir, "schema.json"),
  JSON.stringify({
    $defs: {
      chatRequest: {},
      chatCompletion: { type: "object", oneOf: [] },
      chatCompletionChunk: {},
    },
  }),
);
const failClosed = JSON.parse(
  execFileSync(
    process.execPath,
    [
      "-e",
      'const c=require(process.argv[1]);process.stdout.write(JSON.stringify({ready:c.ready(),valid:c.validate("#/$defs/chatCompletion",{}).valid,error:c.compileError()}))',
      path.join(failClosedDir, "schema-compile.js"),
    ],
    { encoding: "utf8", timeout: 15000 },
  ),
);
expect(
  "compile failure fails closed",
  failClosed.ready === false && failClosed.valid === false && !!failClosed.error,
  "ready=" + failClosed.ready + " valid=" + failClosed.valid,
);

// ─── 5. Environment files are clean and still parse ───────────────────
const envText = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
const envLines = envText.split(/\r?\n/);
const envComments = envLines.filter(
  (line) => /^\s*#/.test(line) && !/^\s*#\s*─/.test(line),
);
expect(
  ".env has no non-banner comments",
  envComments.length === 0,
  envComments.slice(0, 3).join(" | "),
);
expect(
  ".env has no dead commented keys",
  !/^\s*#\s*[A-Za-z_][A-Za-z0-9_]*\s*=/m.test(envText),
);

const exampleText = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const exampleLines = exampleText.split(/\r?\n/);
const inlineComments = exampleLines.filter(
  (line) => !/^\s*#/.test(line) && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=.*\s#/.test(line),
);
expect(
  ".env.example has no inline comments on values",
  inlineComments.length === 0,
  inlineComments.slice(0, 2).join(" | "),
);
expect(
  ".env.example has no dead INSTANCE_ID or GGUF keys",
  !/^\s*#\s*INSTANCE_ID\s*=/m.test(exampleText) &&
    !/^\s*#\s*BRIDGE_GGUF\s*=/m.test(exampleText),
);
expect(".env.example keeps AGENT_MODEL", /^AGENT_MODEL=/m.test(exampleText));
expect(
  ".env.example turns Anti-Dote and boundary validation on",
  /^ANTIDOTE_ENABLED=true$/m.test(exampleText) &&
    /^BOUNDARY_VALIDATE=true$/m.test(exampleText),
);

const fileVars = parseEnvFile(envText);
const loaded = loadEnv({ root: ROOT, fileVars });
for (const key of [
  "PORT",
  "APP_URL",
  "AGENT_MODEL",
  "ANTIDOTE_ENABLED",
  "BOUNDARY_VALIDATE",
  "GEMINI_MODELS",
  "DATA_DIR",
  "DB_SQLITE_PATH",
]) {
  expect(".env keeps " + key, Object.prototype.hasOwnProperty.call(fileVars, key));
}
expect(
  ".env still resolves AGENT_MODEL",
  loaded.values.AGENT_MODEL === "gemini-lite",
  "got " + JSON.stringify(loaded.values.AGENT_MODEL),
);

// ─── 6. Real provider response through the same boundary ──────────────
function geminiApiModel() {
  for (const pair of String(fileVars.GEMINI_MODELS || "").split(",")) {
    const cut = pair.indexOf(":");
    if (cut === -1) {
      if (pair.trim() === "gemini-lite") return pair.trim();
      continue;
    }
    if (pair.slice(0, cut).trim() === "gemini-lite") {
      return pair.slice(cut + 1).trim();
    }
  }
  return "";
}

async function liveCheck() {
  if (!LIVE) {
    console.log("SKIP live provider response (SCHEMA_CHECK_LIVE is not 1)");
    return "skipped";
  }
  for (const [key, value] of Object.entries(fileVars)) process.env[key] = value;
  const apiModel = geminiApiModel();
  if (!apiModel) throw new Error("gemini-lite is not in GEMINI_MODELS");

  const provider = require("../provider/index.js");
  const response = await provider.chat({
    providerId: "gemini",
    model: "gemini-lite",
    apiModel,
    messages: [{ role: "user", content: "Reply with exactly: SCHEMA-OK" }],
    max_tokens: 32,
    temperature: 0,
  });
  if (!response.ok) {
    throw new Error("provider.chat failed: " + (response.error || "unknown"));
  }
  const accepted = validator.validateResponse(response.normalized);
  if (!accepted.valid) {
    throw new Error("real response rejected: " + accepted.errors.join("; "));
  }
  const missingChoices = Object.assign({}, response.normalized);
  delete missingChoices.choices;
  const mutatedNull = Object.assign({}, response.normalized, { choices: null });
  const rejectedNull = validator.validateResponse(mutatedNull);
  const rejectedMissing = validator.validateResponse(missingChoices);
  if (rejectedNull.valid || rejectedMissing.valid) {
    throw new Error("mutated real response was accepted by the boundary");
  }
  pass(
    "live provider response validated",
    "reply=" +
      String(response.content || "").slice(0, 24).replace(/\s+/g, " ") +
      " model=" +
      response.model,
  );
  return "validated";
}

(async () => {
  let live = "unknown";
  try {
    live = await liveCheck();
  } catch (error) {
    fail("live provider response", error.message);
    live = "failed";
  }

  if (failures) {
    console.log("RESULT: SCHEMA COMPILE FAIL failures=" + failures + " passed=" + passed);
    process.exitCode = 1;
    return;
  }
  console.log(
    "RESULT: SCHEMA COMPILE PASS defs=" +
      compiler.defs() +
      " accept=" +
      accepts.length +
      " reject=" +
      rejects.length +
      " compile_reject=" +
      compileRejects.length +
      " env=.env,.env.example live=" +
      live,
  );
})();
