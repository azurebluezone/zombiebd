#!/usr/bin/env node
// =============================================================================
// TEST: "should a custom_ test provider exist?" + local-model tool cap
//       + Universal Tool-Call Adapter ("external tools/tool.js") integration
// =============================================================================
// Method (evidence-based, no assumptions):
//   1) STATIC  — assert against the real source lines read from api.js
//   2) DYNAMIC — extract the real block from api.js and eval exactly that code
//                (not a copy)
//   3) PART C  — verify adapter conversion with six official-doc fixtures
//   4) PART D  — adapter wiring into normalizeResponse (static + dynamic)
//
// Run: node tests/local-tool-cap.test.js
// Exit code 0 = every assertion passed.
// =============================================================================
const fs = require("fs");
const path = require("path");
const { makeAliasResolver } = require("../tools/model-alias.js");

const SRC = path.resolve(__dirname, "..", "api.js");
const src = fs.readFileSync(SRC, "utf8");
const lines = src.split("\n");

let pass = 0, fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) { pass++; rows.push(["PASS", name, detail || ""]); }
  else { fail++; rows.push(["FAIL", name, detail || ""]); }
}
function fact(name, detail) { rows.push(["INFO", name, detail || ""]); }

// ─────────────────────────────────────────────────────────────
// PART A — STATIC: prove which line in api.js does what
// ─────────────────────────────────────────────────────────────

// A1. Is the custom_ regex test actually used in api.js?
const customRegexLine = lines.findIndex((l) => /\/\^custom_\/\.test\(agentProviderId\)/.test(l));
assert(
  "A1  api.js uses /^custom_/.test(agentProviderId)",
  customRegexLine > 0,
  "line " + (customRegexLine + 1)
);

// A2. A custom_N provider is really created (loadCustomProviders).
const customLoaderLine = lines.findIndex((l) => /const providerId = "custom_" \+ num;/.test(l));
const loaderCallLine = lines.findIndex((l) => /^loadCustomProviders\(\);/.test(l));
assert(
  "A2  CUSTOM_PROVIDER_N_* env creates a custom_N provider",
  customLoaderLine > 0 && loaderCallLine > customLoaderLine,
  "loader line " + (customLoaderLine + 1) + " -> call line " + (loaderCallLine + 1)
);

// A3. With exactOnly=true, resolveProvider returns null when the name misses.
const exactOnlyNullLine = lines.findIndex((l) => /if \(exactOnly\) return null;/.test(l));
assert(
  "A3  resolveProvider(model, true) returns null on a miss (the key gap starts here)",
  exactOnlyNullLine > 0,
  "line " + (exactOnlyNullLine + 1)
);

// A4. How many times is MAX_TOOLS_LIMIT redefined (drift risk)?
const maxToolsLines = lines
  .map((l, i) => (/const MAX_TOOLS_LIMIT\s*=/.test(l) ? i + 1 : 0))
  .filter(Boolean);
fact("A4  MAX_TOOLS_LIMIT is redefined " + maxToolsLines.length + " time(s)", "lines: " + maxToolsLines.join(", "));
assert(
  "A4  local cap 5 / cloud cap 15 is correct",
  /const MAX_TOOLS_LIMIT = isLocalAgent \? 5 : 15;/.test(src),
  "line " + (maxToolsLines[maxToolsLines.length - 1])
);

// A10. The tool-cap local heuristic no longer uses a hardcoded model-name list,
//   only config.local plus /^custom_/ (provider id).
//   (Rule: "No hardcoded model names anywhere".)
const modelNameRegex = /\/\^\(qwen\|deepseek\|llama\|mistral\)\//.test(src);
assert(
  "A10 isLocalAgent has no hardcoded model-name list",
  !modelNameRegex,
  "grep /^(qwen|deepseek|llama|mistral)/ -> " + (modelNameRegex ? "STILL PRESENT" : "0"),
);

// A5. How many MCP_TOOLS entries (the TOC claims 10)?
const mcpStart = lines.findIndex((l) => /^const MCP_TOOLS = \{$/.test(l));
let mcpEnd = mcpStart;
while (mcpEnd < lines.length && lines[mcpEnd] !== "};") mcpEnd++;
const mcpKeys = lines
  .slice(mcpStart, mcpEnd)
  .map((l) => { const m = l.match(/^  ([a-z_]+): \{$/); return m ? m[1] : null; })
  .filter(Boolean);
const tocClaim = (lines.find((l) => /Total: .*MCP tools/.test(l)) || "").trim();
fact("A5  actual MCP_TOOLS count = " + mcpKeys.length, "TOC claim: " + tocClaim);
assert("A5  MCP_TOOLS >= 10 (matches the TOC claim)", mcpKeys.length >= 10, "actual: " + mcpKeys.length);

// A6. Timeouts live in provider/transport.js (request building moved to the
//   adapter layer): non-stream 60s default + cfg override, stream 300s so a
//   local CPU model gets a longer budget on the stream path.
const transportSrc = fs.readFileSync(path.resolve(__dirname, "..", "provider", "transport.js"), "utf8");
const tNonStream = /timeout: cfg\.timeout \|\| DEFAULT_TIMEOUT/.test(transportSrc);
const tStream = /cfg\.streamTimeout \|\| 300000/.test(transportSrc);
assert(
  "A6  transport: non-stream cfg.timeout||60s, stream cfg.streamTimeout||300s",
  tNonStream && tStream,
  "provider/transport.js — non-stream=" + tNonStream + ", stream=" + tStream,
);

// A7. api.js no longer holds outbound request code: the http2 client, proxy and
//   response-stream helpers were removed (proxy removal; request construction
//   is provider/transport.js's single responsibility).
const noOldTransport = !/http2Request|proxyHttpRequest|getResponseStream|http2GetSession/.test(src);
assert(
  "A7  api.js has no http2-client/proxy/outbound-request code (that lives in provider/)",
  noOldTransport,
  "grep http2Request|proxyHttpRequest|getResponseStream|http2GetSession -> " +
    (noOldTransport ? "0" : "STILL PRESENT"),
);

// A8. OpenCode-specific headers live only in the adapter, not in the server
//   (operator rule: the server must not carry OpenCode-only code).
const ocAdapterSrc = fs.readFileSync(path.resolve(__dirname, "..", "provider", "opencode.js"), "utf8");
const headersInAdapter = /"opencode\/latest\/1\.3\.15\/cli"/.test(ocAdapterSrc) && /x-opencode-session/.test(ocAdapterSrc);
const headersNotInServer = !/x-opencode/.test(src);
assert(
  "A8  x-opencode-* + CLI UA only in provider/opencode.js, not in api.js",
  headersInAdapter && headersNotInServer,
  "adapter=" + headersInAdapter + ", server-clean=" + headersNotInServer,
);

// A9. Local provider priority defaults to 10 (lowest precedence).
const customPriority = (lines.find((l) => /CUSTOM_PROVIDER_" \+ num \+ "_PRIORITY/.test(l)) || "").trim();
fact("A9  custom_N default priority: " + (customPriority.includes('"10"') ? "10 (lowest precedence)" : "?"), "line 852-855");

// ─────────────────────────────────────────────────────────────
// PART B — DYNAMIC: run against the real block from api.js
// ─────────────────────────────────────────────────────────────
const START_MARK = "// LOCAL MODEL TOOL LIMIT:";
const SLICE_MARK = "toolsForStream = toolsForStream.slice(0, MAX_TOOLS_LIMIT);";
const sIdx = src.indexOf(START_MARK);
const slIdx = src.indexOf(SLICE_MARK);
if (sIdx < 0 || slIdx < 0) { console.error(" markers not found"); process.exit(2); }
// Block = START_MARK through the end of the slice line; the cap logic is the
// whole block. (The old rule stopped at the first `}` after the slice, but
// international code now sits there and broke the eval. The slice line is the
// real boundary.)
const sliceLineEnd = slIdx + SLICE_MARK.length;
const block = src.slice(sIdx, sliceLineEnd);
assert("B0  real block extracted from api.js", block.length > 200, block.split("\n").length + " lines");

// ─── The real resolveProvider and its helpers are extracted from api.js ───
// (The old stub was a friendly shadow copy of production logic. Now the test
//  runs the real code, not a copy.)
function extractFn(name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("extractFn: not found in api.js: " + name);
  const open = src.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error("extractFn: unbalanced braces for " + name);
  return src.slice(start, end);
}
// providerPriority is a helper of resolveProvider; extract it in the same
// sandbox or the real sorter throws ReferenceError.
const rpSrc = ["providerPriority", "resolveProvider", "getModelName", "getApiModelName"]
  .map(extractFn)
  .join("\n");

function runBlock(resolveProvider, agentModel, toolsArg) {
  const agent = { id: "probe", model: agentModel };
  const logs = [];
  const log = (lvl, ev, data) => logs.push({ lvl, ev, data });
  const MCP_TOOLS = {};
  for (const k of mcpKeys) MCP_TOOLS[k] = { description: k, params: {}, required: [] };
  const tools = toolsArg;
  const factory = new Function(
    "resolveProvider", "agent", "log", "tools", "MCP_TOOLS",
    "const agentProviderInfo = resolveProvider(agent.model, true);\n" +
    "const agentProviderId = (agentProviderInfo && agentProviderInfo.providerId) || '';\n" +
    "const isLocalAgent = !!(agentProviderInfo && agentProviderInfo.config && agentProviderInfo.config.local) || /^custom_/.test(agentProviderId);\n" +
    block + "\nreturn { isLocalAgent, MAX_TOOLS_LIMIT, toolsForStream, agentProviderId };"
  );
  return { ...factory(resolveProvider, agent, log, tools, MCP_TOOLS), logs };
}

const PROVIDERS = {
  opencode: { name: "OpenCode", priority: 1, models: ["gpt-4o-mini", "deepseek-r1-distill"], config: {} },
  ollama: { name: "Ollama", priority: 5, local: true, models: ["qwen2:0.5b"] },
  custom_2: { name: "Custom-2", priority: 10, custom: true, models: ["phi3:mini"] },
};
// Run the real resolveProvider with the test PROVIDERS as PROVIDER_CONFIG.
// applyModelAlias is the production hook (MODEL_ALIASES), so the resolver
// under test is the real one.
const realResolveProvider = new Function(
  "PROVIDER_CONFIG",
  "DISABLED_MODELS",
  "applyModelAlias",
  rpSrc + "\nreturn resolveProvider;",
)(PROVIDERS, new Set(), makeAliasResolver(process.env.MODEL_ALIASES || ""));
const rp = (m, e) => realResolveProvider(m, e);

// B1. custom_ provider = local -> 5 tools.
const r1 = runBlock(rp, "phi3:mini");
assert("B1  custom_2 provider -> isLocalAgent=true, cap=5", r1.isLocalAgent === true && r1.MAX_TOOLS_LIMIT === 5,
  "providerId=" + r1.agentProviderId + ", cap=" + r1.MAX_TOOLS_LIMIT);

// B2. ollama (local:true) registered model -> 5 tools.
const r2 = runBlock(rp, "qwen2:0.5b");
assert("B2  ollama(local:true) registered model -> cap=5", r2.isLocalAgent === true && r2.MAX_TOOLS_LIMIT === 5,
  "providerId=" + r2.agentProviderId + ", cap=" + r2.MAX_TOOLS_LIMIT);

// B3. Cloud model -> 15 tools.
const r3 = runBlock(rp, "gpt-4o-mini");
assert("B3  cloud model -> isLocalAgent=false, cap=15", r3.isLocalAgent === false && r3.MAX_TOOLS_LIMIT === 15,
  "providerId=" + r3.agentProviderId + ", cap=" + r3.MAX_TOOLS_LIMIT);

// B4. GAP-1: a local model whose name and provider both miss the regex.
const r4 = runBlock(rp, "gemma4:31b"); // pulled in ollama but missing from the models list
assert(
  "B4  GAP: unregistered local model -> null -> isLocalAgent=FALSE -> 15 tools like cloud",
  r4.isLocalAgent === false && r4.MAX_TOOLS_LIMIT === 15 && r4.agentProviderId === "",
  "resolveProvider(exactOnly) null -> /^custom_/.test('') = false"
);

// B5. FIX: no model-name list, so the cloud deepseek-r1-distill is no longer
//     mistaken for local (the old /^(qwen|deepseek|llama|mistral)/ matched it
//     and forced cap=5).
const r5 = runBlock(rp, "deepseek-r1-distill");
assert("B5  cloud deepseek-r1-distill -> isLocalAgent=false, cap=15 (no name regex)", r5.isLocalAgent === false && r5.MAX_TOOLS_LIMIT === 15,
  "providerId=" + r5.agentProviderId + " (opencode cloud)");

// B6. Which five tools does a local model get?
const r6 = runBlock(rp, "qwen2:0.5b");
const got5 = (r6.toolsForStream || []).map((t) => t.function.name);
const expect5 = mcpKeys.slice(0, 5);
assert("B6  local model gets exactly the first 5 tools: " + got5.join(", "),
  JSON.stringify(got5) === JSON.stringify(expect5), "selection = slice(0,5), no priority");
const lost = mcpKeys.slice(5);
fact("B6  dropped from the local model (" + lost.length + "): " + lost.join(", "), "");

// B7. No "power" tool on the local path — grep/glob/exec/terminal/db_query.
const powerTools = ["grep", "glob", "exec", "terminal", "db_query", "agent_mission"];
const lostPower = powerTools.filter((t) => !got5.includes(t));
assert("B7  none of the " + powerTools.length + " power tools appear in the local 5", lostPower.length === powerTools.length,
  "dropped: " + lostPower.join(", "));

// B8. What does the cloud 15 get (first 15)?
const r8 = runBlock(rp, "gpt-4o-mini");
const got15 = (r8.toolsForStream || []).map((t) => t.function.name);
const pos = (k) => mcpKeys.indexOf(k) + 1;
fact("B8  position by tool order: terminal #" + pos("terminal") + ", grep #" + pos("grep") + ", glob #" + pos("glob") + ", exec #" + pos("exec"), "outside the cap of 15 = never sent");
assert("B8  cloud=15 gets terminal, but grep/glob/exec (beyond 15) never reach the model",
  got15.length === 15 && got15.includes("terminal") && !got15.includes("grep") && !got15.includes("exec"),
  "count=" + got15.length + ", grep@" + pos("grep") + " exec@" + pos("exec"));

// B9. The real question about a custom_ test provider: is it "test-only"?
const isTestOnly = /if \(!url\) \{[^}]*Skipped: no URL set/.test(src);
assert("B9  custom_ provider is not test-only — any URL loads it as a production provider",
  isTestOnly === true && loaderCallLine > 0, "line " + (customLoaderLine + 1) + " + startup call");
fact("B9  that is: it is not a mutex/fixture, it is the main key to local-model routing", "");

// ─────────────────────────────────────────────────────────────
// PART C — Universal Tool-Call Adapter ("external tools/tool.js")
//   Six official-doc fixtures (Groq / Gemini / Ollama / OpenAI Responses /
//   llama.cpp / Anthropic / Bedrock) verify adapter conversion. No guesses:
//   every fixture is a JSON copy from the docs.
// ─────────────────────────────────────────────────────────────
const ADAPTER_PATH = path.resolve(__dirname, "..", "external tools", "tool.js");
let ADAPTER = null;
try { ADAPTER = require(ADAPTER_PATH); } catch (e) { }
assert("C0  external tools/tool.js loads", !!ADAPTER,
  ADAPTER ? Object.keys(ADAPTER).length + " exports" : "load fail");

if (ADAPTER) {
  const chatTools = [{ type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"], additionalProperties: false } } }];

  // C1 — Groq Tool Use doc: standard chat tool_calls [doc 1]
  const groqRaw = { choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "call_abc123", type: "function", function: { name: "get_weather", arguments: "{\"location\":\"San Francisco, CA\"}" } }] }, finish_reason: "tool_calls" }] };
  const c1 = ADAPTER.parseToolCalls(groqRaw);
  assert("C1  [Groq doc] chat tool_calls -> canonical", c1.length === 1 && c1[0].id === "call_abc123" && JSON.parse(c1[0].function.arguments).location === "San Francisco, CA");

  // C2 — Ollama doc: arguments OBJECT, no id [doc 4]
  const ollamaRaw = { message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { index: 0, name: "get_temperature", arguments: { city: "New York" } } }] } };
  const c2 = ADAPTER.parseToolCalls(ollamaRaw);
  assert("C2  [Ollama doc] object args -> JSON string + synthesized id", c2.length === 1 && typeof c2[0].function.arguments === "string" && JSON.parse(c2[0].function.arguments).city === "New York" && !!c2[0].id);

  // C3 — Ollama doc: tool result message -> tool_name [doc 4]
  const om = ADAPTER.toProviderMessages([{ role: "tool", tool_call_id: "call_1", content: "22°C" }], "ollama");
  assert("C3  [Ollama doc] result message -> {role:'tool', tool_name}", om[0].role === "tool" && om[0].tool_name === "call_1");

  // C4 — Gemini doc: parts[].functionCall {name, args:OBJECT} [doc 3]
  const gemRaw = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_light_values", args: { brightness: 25, color_temp: "warm" } } }] }, finishReason: "STOP" }] };
  const c4 = ADAPTER.parseToolCalls(gemRaw);
  assert("C4  [Gemini doc] functionCall part -> tool_calls", c4.length === 1 && c4[0].function.name === "set_light_values" && JSON.parse(c4[0].function.arguments).brightness === 25);

  // C5 — Gemini doc: outbound functionDeclarations + schema sanitize [doc 3]
  const gt = ADAPTER.toProviderTools(chatTools, "gemini");
  assert("C5  [Gemini doc] tools -> functionDeclarations, additionalProperties stripped",
    Array.isArray(gt) && gt[0].functionDeclarations[0].name === "get_weather" &&
    gt[0].functionDeclarations[0].parameters.additionalProperties === undefined);

  // C6 — Gemini doc: history — assistant->model functionCall, tool->user functionResponse [doc 3]
  const gh = ADAPTER.toProviderMessages([
    { role: "user", content: "lights?" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_9", type: "function", function: { name: "set_light_values", arguments: "{\"brightness\":25}" } }] },
    { role: "tool", tool_call_id: "call_9", content: "{\"ok\":true}" },
  ], "gemini");
  assert("C6  [Gemini doc] history -> functionCall + functionResponse parts",
    gh[1].role === "model" && gh[1].parts[0].functionCall.name === "set_light_values" &&
    gh[2].role === "user" && gh[2].parts[0].functionResponse.name === "set_light_values" &&
    gh[2].parts[0].functionResponse.response.ok === true);

  // C7 — OpenAI Responses doc: FLAT tools + output[] function_call [doc 5]
  const respRaw = { id: "resp_1", output: [{ id: "fc_123", call_id: "call_12345xyz", type: "function_call", name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" }] };
  const c7 = ADAPTER.parseToolCalls(respRaw);
  const rt = ADAPTER.toProviderTools(chatTools, "responses");
  assert("C7  [OpenAI Responses doc] output[] -> tool_calls + FLAT tools",
    c7.length === 1 && c7[0].id === "call_12345xyz" && JSON.parse(c7[0].function.arguments).sign === "Taurus" &&
    rt[0].type === "function" && rt[0].name === "get_weather" && !rt[0].function);

  // C8 — llama.cpp doc: text-embedded call + allow-list [doc 6]
  const c8 = ADAPTER.extractTextToolCalls('```tool_call\n{"name":"python","arguments":{"code":"print(1)"}}\n```', ["python"]);
  const c8b = ADAPTER.extractTextToolCalls('{"name":"evil_tool","arguments":{}}', ["python"]);
  assert("C8  [llama.cpp doc] text -> tool_calls; unknown name rejected", c8.length === 1 && JSON.parse(c8[0].function.arguments).code === "print(1)" && c8b.length === 0);

  // C9 — Anthropic tool_use -> OpenAI shape (the old path sent the raw block and object arguments)
  const c9 = ADAPTER.parseToolCalls({ content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }], stop_reason: "tool_use" });
  assert("C9  [Anthropic] tool_use -> {id, function:{name, arguments:STRING}}",
    c9.length === 1 && c9[0].id === "toolu_1" && typeof c9[0].function.arguments === "string" && JSON.parse(c9[0].function.arguments).location === "Paris");

  // C10 — Bedrock Converse toolUse [doc 8]
  const c10 = ADAPTER.parseToolCalls({ output: { message: { content: [{ toolUse: { toolUseId: "ts_1", name: "get_weather", input: { location: "Rome" } } }] } }, stopReason: "tool_use" });
  assert("C10 [Bedrock] toolUse -> tool_calls", c10.length === 1 && c10[0].id === "ts_1");

  // C11 — no call -> [] (no false positive)
  assert("C11 plain text -> [] (no false positive)", ADAPTER.parseToolCalls({ choices: [{ message: { content: "hello world" } }] }).length === 0);
}

// ─────────────────────────────────────────────────────────────
// PART D — adapter wiring into the normalizer (api.js)
//   STATIC: where it is wired; DYNAMIC: extract the real normalizeResponse
//   from api.js, eval it, then feed fixtures.
// ─────────────────────────────────────────────────────────────
assert("D1  api.js requires external tools/tool.js",
  src.includes('require("./external tools/tool.js")'));

// D2. Gemini outbound functionDeclarations now live in the adapter; api.js has
//   no gemini branch, so both paths (non-stream/stream) use the same code.
const geminiAdapterSrc = fs.readFileSync(path.resolve(__dirname, "..", "provider", "gemini.js"), "utf8");
const gemOutboundInServer = src.split('TOOLADAPTER.toProviderTools(tools, "gemini")').length - 1;
const gemOutboundInAdapter = /return \[\{ functionDeclarations: decls \}\]/.test(geminiAdapterSrc);
assert("D2  Gemini outbound functionDeclarations -> adapter (0 branches in api.js)",
  gemOutboundInServer === 0 && gemOutboundInAdapter,
  "server=" + gemOutboundInServer + " branch(es), adapter=" + gemOutboundInAdapter);

// D3. Gemini stream accumulates functionCall and resolves tool_calls (adapter).
const geminiStreamAccumulates =
  geminiAdapterSrc.includes("const calls = [];") &&
  geminiAdapterSrc.includes("if (Array.isArray(d.tool_calls))") &&
  geminiAdapterSrc.includes("calls[i].function.arguments +=") &&
  geminiAdapterSrc.includes("tool_calls: calls.length ? calls : null");
assert("D3  Gemini stream accumulates functionCall + resolves tool_calls",
  geminiStreamAccumulates,
  "provider/gemini.js");

// D4. OpenAI stream tool_call fragment accumulator (api.js) plus flat->nested
//   id synthesis (provider/index.js).
const registrySrc = fs.readFileSync(path.resolve(__dirname, "..", "provider", "index.js"), "utf8");
assert("D4  stream fragment accumulator (api.js) + flat->nested id synth (provider/index.js)",
  src.includes("accToolCalls") && registrySrc.includes("call_stream_"),
  "server-acc=" + src.includes("accToolCalls") + ", registry-id=" + registrySrc.includes("call_stream_"));

// D5. Both call sites (callModel + callModelStream) pass tools through the same
//   gate: toolRegister.prepare x2 (DB-driven capability gate, no hardcoded names).
const prepareCount = src.split("toolRegister.prepare(providerId").length - 1;
assert("D5  both call sites pass tools (toolRegister.prepare x2)",
  prepareCount === 2, prepareCount + " site(s)");

// D6 — extract the real normalizeResponse block from api.js (not a copy).
const nrStart = src.indexOf("function normalizeResponse(raw, modelHint) {");
const bannerIdx = nrStart > 0 ? src.indexOf("MODEL CALL", nrStart) : -1;
let nrBlock = "";
if (nrStart > 0 && bannerIdx > 0) nrBlock = src.slice(nrStart, src.lastIndexOf("\n", src.lastIndexOf("\n", bannerIdx)));
assert("D6  normalizeResponse block extracted", nrBlock.length > 2000, nrBlock.length + " chars");

let normalizeResponse = null;
if (nrBlock) {
  try {
    normalizeResponse = new Function("log", "maskModelName", "TOOLADAPTER",
      nrBlock + "\nreturn normalizeResponse;")(() => {}, (m) => m, ADAPTER);
  } catch (e) { fact("D6  eval error", e.message); }
}
assert("D6b normalizeResponse evaluated", typeof normalizeResponse === "function");

if (typeof normalizeResponse === "function" && ADAPTER) {
  // D7 — Gemini + functionCall -> tool_calls (the old path returned no text at all)
  const n7 = normalizeResponse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "set_light_values", args: { brightness: 25, color_temp: "warm" } } }] }, finishReason: "STOP" }] }, "gemini-flash");
  const m7 = n7.choices[0];
  assert("D7  normalizeResponse(gemini+functionCall) -> finish=tool_calls + parsed args",
    m7.finish_reason === "tool_calls" && m7.message.tool_calls && m7.message.tool_calls.length === 1 &&
    JSON.parse(m7.message.tool_calls[0].function.arguments).color_temp === "warm" &&
    n7.toolCallsFrom === "universal-adapter",
    "originalFormat=" + n7.originalFormat);

  // D8 — Responses API output[] (the old path reported HAQ_MAWLA_UNKNOWN_FORMAT)
  const n8 = normalizeResponse({ id: "resp_1", output: [{ call_id: "call_12345xyz", type: "function_call", name: "get_horoscope", arguments: "{\"sign\":\"Taurus\"}" }] }, "gpt-oss-120b");
  assert("D8  normalizeResponse(responses output[]) -> tool_calls",
    n8.choices[0].message.tool_calls && n8.choices[0].message.tool_calls[0].id === "call_12345xyz",
    "originalFormat=" + n8.originalFormat);

  // D9 — Anthropic: arguments STRING (the old path sent a raw input object)
  const n9 = normalizeResponse({ content: [{ type: "text", text: "I am using a tool" }, { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "Paris" } }], stop_reason: "tool_use" }, "claude-x");
  const t9 = n9.choices[0].message.tool_calls;
  assert("D9  normalizeResponse(anthropic tool_use) -> string arguments + content kept",
    t9 && typeof t9[0].function.arguments === "string" && n9.choices[0].message.content.includes("I am using a tool"));

  // D10 — Gemini TEXT-ONLY regression: the previous path stays intact.
  const n10 = normalizeResponse({ candidates: [{ content: { role: "model", parts: [{ text: "Hello there!" }] }, finishReason: "STOP" }] }, "gemini-flash");
  assert("D10 gemini text-only -> content kept, no tool_calls",
    n10.choices[0].message.content === "Hello there!" && !n10.choices[0].message.tool_calls && n10.choices[0].finish_reason === "stop");

  // D11 — unknown plain object -> previous fallback kept (no crash)
  const n11 = normalizeResponse({ foo: 1 }, "mystery-model");
  assert("D11 unknown format -> unknown_external fallback kept",
    n11.originalFormat === "unknown_external" && n11.choices[0].message.role === "assistant");

  // D12 — OpenAI-based path: object arguments (Ollama quirk) -> string
  const n12 = normalizeResponse({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "f", arguments: { a: 1 } } }] }, finish_reason: "tool_calls" }] }, "m");
  assert("D12 choices-path: object arguments -> JSON string (normalizeChatToolCalls)",
    typeof n12.choices[0].message.tool_calls[0].function.arguments === "string" &&
    JSON.parse(n12.choices[0].message.tool_calls[0].function.arguments).a === 1);

  // D13 — without tools the OpenAI path has no tool_calls key (not an empty array)
  const n13 = normalizeResponse({ choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }, "m");
  assert("D13 plain chat -> tool_calls key absent", !("tool_calls" in n13.choices[0].message));
}

// D14 — the proxy /v1/chat/completions forwards tool_calls in the final
//   response. This block used to hardcode finish_reason:"stop" and drop
//   tool_calls; it was caught live, so it now has a static regression guard.
const proxyForwardsTools =
  src.includes("proxyToolCalls") &&
  src.includes('finish_reason: proxyToolCalls.length ? "tool_calls" : "stop"');
assert("D14 proxy response forwards tool_calls + dynamic finish_reason", proxyForwardsTools);

// D15 — the header TOOLS AVAILABLE list is dynamic (derived from the registry,
//   not a hardcoded list, so adding a tool updates the header by itself).
const dynamicHeader =
  !src.includes("- TOOLS AVAILABLE:") &&
  !src.includes("- TOOLS AVAILABLE: read_file, write_file, list_directory") &&
  src.includes("tools are available in the function definitions");
assert(
  "D15 agent header has no prose tool list; schemas live only in the tools argument",
  dynamicHeader,
  "no hardcoded or registry prose list",
);

// D16 — append_syllabus exists in the tool registry and in dispatch (fixes the
//   doc-audit mismatch where header rule 5 asked for a tool that did not exist).
const hasAppendEntry =
  /append_syllabus:\s*\{[\s\S]{0,1500}required:\s*\["topic",\s*"summary"\]/.test(src);
const hasAppendCase = src.includes('case "append_syllabus":');
assert(
  "D16 append_syllabus: MCP_TOOLS entry + executeMcpTool case exist",
  hasAppendEntry && hasAppendCase,
  "entry=" + hasAppendEntry + ", case=" + hasAppendCase,
);

// D17 — append_syllabus case behaviour (extract+eval like D6, stub writeSyllabus):
//   a keyPoints string is split; a missing required field never calls writeSyllabus.
{
  const cs = src.indexOf('case "append_syllabus":');
  const ce = src.indexOf('case "list_directory": {', cs);
  let blockOk = false, a = "", b = "";
  if (cs >= 0 && ce > cs) {
    const block = src.slice(src.indexOf(":", cs) + 1, ce).trim(); // "{ ... }"
    const fn = new Function(
      "args", "writeSyllabus", "mcpWorkingDir", "log",
      "return (function run(args, writeSyllabus, mcpWorkingDir, log) " + block +
        ")(args, writeSyllabus, mcpWorkingDir, log);",
    );
    let cap = null;
    const outA = fn(
      { topic: "T1", summary: "S1", source: "Web Search", keyPoints: "a, b\nc" },
      (dir, topic, entry) => { cap = { dir, topic, entry }; return true; },
      "/wd", () => {},
    );
    a = (cap && cap.topic === "T1" && Array.isArray(cap.entry.keyPoints) &&
         cap.entry.keyPoints.join("|") === "a|b|c" && /appended: T1/.test(outA.content[0].text))
      ? "ok" : JSON.stringify(cap) + "|" + outA.content[0].text;
    let called = false;
    const outB = fn(
      { topic: "T2" },
      () => { called = true; return true; },
      "/wd", () => {},
    );
    b = (!called && /required/.test(outB.content[0].text)) ? "ok" : "called=" + called;
    blockOk = a === "ok" && b === "ok";
  }
  assert(
    "D17 append_syllabus: keyPoints split + required-guard (stubbed eval)",
    blockOk,
    "keypoints=" + a + ", guard=" + b,
  );
}

// ─────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════");
console.log("  TEST: local tool cap + custom_ provider existence");
console.log("  source: " + SRC);
console.log("══════════════════════════════════════════════════════════");
for (const [st, name, detail] of rows) {
  const tag = st === "PASS" ? "  PASS " : st === "FAIL" ? "  FAIL " : "  INFO ";
  console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
}
console.log("────────────────────────────────────────────────────────────");
console.log("  RESULT: " + pass + " passed, " + fail + " failed, " + rows.filter(r => r[0] === "INFO").length + " facts");
console.log("══════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
