#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: P0-01 tool budget
//
// Proves the acceptance contract, not a copy of it:
//   1. lib/tool-budget.js is the only resolver; api.js/provider define no limits
//   2. 155 tools -> global limit 24 and a provider ceiling of 5
//   3. pinned tts__tts_speak survives even when it sits at index 37
//   4. output bytes <= 12000 and estPrefillMs <= min(timeout/2, 45000)
//   5. provider/tools.prepare honors the effective provider max
//
// Run: node tests/tool-budget-check.js
// Exit 0 + TOOL_BUDGET_OK only when every assertion passes.
// =============================================================================

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const apiSrc = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
const toolBudget = require(path.join(ROOT, "lib", "tool-budget.js"));
const toolRegister = require(path.join(ROOT, "provider", "tools.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " :: " + detail : ""));
  } else {
    fail += 1;
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

function withEnv(values, fn) {
  const saved = {};
  for (const key of Object.keys(values)) saved[key] = process.env[key];
  for (const key of Object.keys(values)) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function readProviderSources() {
  const dir = path.join(ROOT, "provider");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => ({
      file: "provider/" + entry.name,
      src: fs.readFileSync(path.join(dir, entry.name), "utf8"),
    }));
}

const providerSources = readProviderSources();
const allSources = [{ file: "api.js", src: apiSrc }, ...providerSources];

// ─── 1. One resolver, no inline caps ─────────────────────────────────────
const banned = [
  ["MAX_TOOLS_LIMIT", /MAX_TOOLS_LIMIT/],
  ["Math.min(25", /Math\.min\(\s*25\b/],
  ["maxTools: 15", /maxTools:\s*15\b/],
  ["maxTools: ... || 5", /maxTools:[^\n]*\|\|\s*5\b/],
];
for (const [label, pattern] of banned) {
  const hits = allSources.filter((item) => pattern.test(item.src)).map((item) => item.file);
  check("no " + label + " in api.js/provider", hits.length === 0, hits.join(", ") || "0 files");
}

let resolverFiles = [];
for (const item of [
  { file: "api.js", src: apiSrc },
  ...providerSources,
  { file: "lib/tool-budget.js", src: fs.readFileSync(path.join(ROOT, "lib", "tool-budget.js"), "utf8") },
]) {
  if (/function\s+resolveToolBudget\s*\(/.test(item.src)) resolverFiles.push(item.file);
}
check(
  "only lib/tool-budget.js defines resolveToolBudget",
  resolverFiles.length === 1 && resolverFiles[0] === "lib/tool-budget.js",
  resolverFiles.join(", "),
);
check("api.js requires lib/tool-budget.js", /require\("\.\/lib\/tool-budget\.js"\)/.test(apiSrc));
check(
  "provider/tools.js requires lib/tool-budget.js",
  /require\("\.\.\/lib\/tool-budget\.js"\)/.test(
    fs.readFileSync(path.join(ROOT, "provider", "tools.js"), "utf8"),
  ),
);

const budgetCalls = (apiSrc.match(/toolBudget\.resolveToolBudget\(/g) || []).length;
check("api.js calls resolveToolBudget exactly twice (chat + stream)", budgetCalls === 2, String(budgetCalls));
check("api.js boots with validateConfig + CONFIG_FATAL", /toolBudget\.validateConfig\(\)/.test(apiSrc) && /CONFIG_FATAL/.test(apiSrc));
check(
  "api.js has no tool slice on the model path",
  !/tools\s*=\s*tools\.slice\(0,/.test(apiSrc) && !/toolsForStream\s*=\s*toolsForStream\.slice\(0,/.test(apiSrc),
);
check(
  "provider/capabilities.js has no provider maxTools ceiling",
  /maxTools:\s*Infinity/.test(
    fs.readFileSync(path.join(ROOT, "provider", "capabilities.js"), "utf8"),
  ),
);

// ─── 2. Synthetic 155 tools: limit 24, pinned survives ───────────────────
function tinyTool(name, index) {
  return {
    type: "function",
    function: {
      name,
      description: "synthetic tool " + index,
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: [],
      },
    },
  };
}

function buildSynthetic155() {
  const names = [];
  for (let i = 0; i < 155; i += 1) names.push("tool_" + String(i).padStart(3, "0"));
  names[37] = "tts__tts_speak";
  names[80] = "ocr__ocr_image";
  return names.map(tinyTool);
}

const synthetic = buildSynthetic155();
const cloud = withEnv({ MCP_TOOL_BUDGET_MAX: "24" }, () =>
  toolBudget.resolveToolBudget({ tools: synthetic, timeoutMs: 60000 }),
);
const cloudNames = cloud.tools.map((tool) => tool.function.name);
check("155 tools -> limit 24", cloud.limit === 24, "limit=" + cloud.limit);
check(
  "155 tools -> at most 24 selected",
  cloud.tools.length <= 24 && cloud.tools.length > 0,
  "selected=" + cloud.tools.length,
);
// With a longer timeout the prefill budget allows the full count ceiling.
const cloud300 = withEnv({ MCP_TOOL_BUDGET_MAX: "24" }, () =>
  toolBudget.resolveToolBudget({ tools: synthetic, timeoutMs: 300000 }),
);
check("155 tools -> full 24 selected at 300s", cloud300.tools.length === 24, "selected=" + cloud300.tools.length);
check("pinned tts__tts_speak survives trim", cloudNames.includes("tts__tts_speak"));
check("pinned ocr__ocr_image survives trim", cloudNames.includes("ocr__ocr_image"));
check("cloud bytes <= 12000", cloud.bytes <= 12000, "bytes=" + cloud.bytes);
check("cloud estPrefillMs <= timeout/2", cloud.estPrefillMs <= 30000, "ms=" + cloud.estPrefillMs);

const capped = withEnv({ MCP_TOOL_BUDGET_MAX: "24" }, () =>
  toolBudget.resolveToolBudget({
    tools: synthetic,
    providerMax: toolBudget.providerMaxOf({ capabilities: { maxTools: 5 } }),
    timeoutMs: 60000,
  }),
);
const cappedNames = capped.tools.map((tool) => tool.function.name);
check("provider max 5 is respected", capped.limit === 5, "limit=" + capped.limit);
check("provider max sends 5 tools", capped.tools.length === 5, "selected=" + capped.tools.length);
check("provider max keeps tts__tts_speak", cappedNames.includes("tts__tts_speak"));

// Intent ranking + deterministic tie-break (pins disabled for this probe).
const ranked = withEnv({ MCP_TOOL_BUDGET_PIN: "" }, () =>
  toolBudget.resolveToolBudget({
    tools: [tinyTool("zzz_tool", 0), tinyTool("tts__tts_speak", 1), tinyTool("aaa_tool", 2)],
    intent: "tts speak audio",
    timeoutMs: 60000,
  }),
);
check(
  "intent ranks tts__tts_speak first",
  ranked.tools.length > 0 && ranked.tools[0].function.name === "tts__tts_speak",
  ranked.tools.map((tool) => tool.function.name).join(","),
);

// ─── 3. Real catalog bytes/prefill ───────────────────────────────────────
function extractMcpTools(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^const MCP_TOOLS = \{$/.test(line));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end] !== "};") end += 1;
  if (end >= lines.length) return null;
  const literal = lines.slice(start, end + 1).join("\n");
  return new Function(literal + "\nreturn MCP_TOOLS;")();
}

const mcpTools = extractMcpTools(apiSrc);
check("static MCP_TOOLS extracted from api.js", !!mcpTools && Object.keys(mcpTools).length >= 20);

if (mcpTools) {
  const realTools = Object.entries(mcpTools).map(([name, def]) => ({
    type: "function",
    function: {
      name,
      description: def.description || name,
      parameters: {
        type: "object",
        properties: def.params || {},
        required: def.required || [],
      },
    },
  }));
  const real60 = withEnv({ MCP_TOOL_BUDGET_MAX: "24" }, () =>
    toolBudget.resolveToolBudget({ tools: realTools, timeoutMs: 60000 }),
  );
  check("real catalog bytes <= 12000", real60.bytes <= 12000, "bytes=" + real60.bytes);
  check(
    "real catalog estPrefillMs <= min(timeout/2, 45000)",
    real60.estPrefillMs <= Math.min(30000, 45000),
    "ms=" + real60.estPrefillMs,
  );
  check("real catalog limit is 24", real60.limit === 24, "limit=" + real60.limit);

  const real300 = withEnv({ MCP_TOOL_BUDGET_MAX: "24" }, () =>
    toolBudget.resolveToolBudget({ tools: realTools, timeoutMs: 300000 }),
  );
  check("300s timeout bytes <= 12000", real300.bytes <= 12000, "bytes=" + real300.bytes);
  check("300s timeout prefill <= 45000", real300.estPrefillMs <= 45000, "ms=" + real300.estPrefillMs);
}

// ─── 4. provider/tools.prepare honors the effective max ──────────────────
toolRegister.setDatabase({
  prepare: () => ({ get: () => ({ supports_tools: null }) }),
});
const preparedCapped = toolRegister.prepare("capped", "m", synthetic, {
  capabilities: { maxTools: 5 },
});
const preparedCloud = toolRegister.prepare("opencode", "m", synthetic, {});
toolRegister.setDatabase(null);

check(
  "prepare(capped) caps at 5 and keeps tts",
  preparedCapped.length === 5 &&
    preparedCapped.some((tool) => tool.function.name === "tts__tts_speak"),
  "count=" + preparedCapped.length,
);
check(
  "prepare(cloud) caps at 24 and keeps tts",
  preparedCloud.length === 24 &&
    preparedCloud.some((tool) => tool.function.name === "tts__tts_speak"),
  "count=" + preparedCloud.length,
);

// ─── 5. Config defaults + boot gate ──────────────────────────────────────
const defaults = withEnv(
  {
    MCP_TOOL_BUDGET_MAX: undefined,
    MCP_TOOL_BUDGET_PIN: undefined,
    MCP_TOOL_BUDGET_STRATEGY: undefined,
    MCP_TOOL_BUDGET_MAX_BYTES: undefined,
    MCP_TOOL_BUDGET_MAX_PREFILL_MS: undefined,
    MCP_TOOL_PREFILL_TOKENS_PER_SEC: undefined,
  },
  () => toolBudget.validateConfig(),
);
check("default config is valid", defaults.ok, defaults.errors.join("; "));
check("default max is 24", defaults.config.max === 24, String(defaults.config.max));
check("default pin has tts__tts_speak", defaults.config.pinned.includes("tts__tts_speak"));

const invalid = withEnv(
  { MCP_TOOL_BUDGET_MAX: "1", MCP_TOOL_BUDGET_PIN: "tts__tts_speak,ocr__ocr_image" },
  () => toolBudget.validateConfig(),
);
check("pinned > limit is a boot error", !invalid.ok, invalid.errors.join("; "));

// ─── Summary ─────────────────────────────────────────────────────────────
console.log("");
console.log("checks: " + (pass + fail) + " pass=" + pass + " fail=" + fail);
if (fail > 0) {
  console.error("TOOL_BUDGET_FAIL");
  for (const item of failures) console.error(" - " + item);
  process.exit(1);
}
console.log("TOOL_BUDGET_OK");
