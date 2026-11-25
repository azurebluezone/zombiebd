# api.js গভীর অডিট — ডুপ্লিকেট, মডিউল, ট্রান্সপোর্ট, পার্সোনা, কম্পাইলার ও সিলেবাস

**তারিখ:** ২০২৬-১১-২৩
**স্কোপ:** এই চেকআউটের সোর্স (`/home/sahon/Documents/zombiebd-main`) — `api.js` (১৯,৭২৭ লাইন), `modules/`, `provider/`, `transport/`, `lib/`, `agent/`, `universal-adapter/`, `external mcp/` এবং সংশ্লিষ্ট ডকুমেন্ট।
**পদ্ধতি:** স্ট্যাটিক কোড-রিডিং + `node --check` + দুটি চালুযোগ্য টেস্ট + ক্রস-ফাইল `require`/কল-গ্রাফ স্ক্যান।
**সীমাবদ্ধতা (লুকানো হয়নি):** `.env`, `data/models.db`, `external mcp/servers.json` এই চেকআউটে নেই। তাই README-এর “১০১ টুল” বা GUIDEBOOK-এর “১৫৫ টুল” **লাইভ যাচাই করা যায়নি**। নিচের টুল-সংখ্যা স্ট্যাটিক রেজিস্ট্রি থেকে গণনা করা। কোনো লাইভ সার্ভার চালু করা হয়নি।

---

## ০. যে প্রমাণের উপর এই রিপোর্ট দাঁড়িয়ে

```bash
wc -l api.js                         # 19727
node --check api.js                  # exit 0 (API_SYNTAX_OK)
node tests/surface-policy-check.js   # 10 passed, 0 failed — SURFACE_POLICY_OK
node tests/modules-runtime-check.js  # MODULES_RUNTIME_OK
```

যেগুলো **ব্যর্থ** হয়েছে বা চালানো যায়নি:

- `node tests/docs-current-check.js` → `ENOENT: identity.json` (টেস্টটি প্রজেক্ট-ফাইলের উপর নির্ভরশীল, ফাইলটি নেই)।
- `node tests/api-line-audit-check.js` → `fatal: not a git repository` (টেস্টটি `git show HEAD:api.js` চায়; এই ফোল্ডারে `.git` নেই)।
- লাইভ `tools/list` / provider call — `.env` ও DB ছাড়া সম্ভব নয়।

> নিয়ম: নিচের প্রতিটি দাবির পাশে `ফাইল:লাইন` আছে। কোনো দাবি শুধু অনুমান হলে সেটি আলাদাভাবে **“অনুমান”** লেখা হয়েছে।

---

## ১. এক নজরে সবচেয়ে বড় সমস্যা

| # | তীব্রতা | সমস্যা | প্রমাণ | প্রভাব |
|---|---|---|---|---|
| F1 | **P0** | `/api/mission` আসলে মিশন ইঞ্জিন চালায় না; `multiAgent:true` ফ্ল্যাগ কোনো কোড পড়ে না | `api.js:19243-19251`, `api.js:9313`, `api.js:8782`, `api.js:11006` | HTTP “mission” = এক এজেন্ট; MCP “mission” = সব এজেন্ট। একই নাম, দুই আচরণ |
| F2 | **P0** | ট্রান্সপোর্টভেদে ভেরিফিকেশন পাইপলাইন আলাদা | `api.js:16469` (v1), `api.js:19131-19334` (handleMessage), `api.js:11006` (MCP mission) | একই প্রশ্নে এক ট্রান্সপোর্টে type-safety/cross-verify/compiler চলে, অন্যটিতে চলে না |
| F3 | **P0** | কম্পাইলার ভেরিফিকেশন স্বয়ংক্রিয় নয়; `write_file` সবসময় “Written” বলে | `api.js:10646-10700`, `modules/compiler.js:53-85`, `api.js:19304` | ভাঙা JS লিখেও success; মডেল “done” বলতে পারে |
| F4 | **P0** | একই concern-এর ২–৩টি implementation: normalizer, verify, intent, memory, session | `api.js:6350`, `normalizer/index.js:1`; `api.js:12336`, `modules/verify.js:26`; ইত্যাদি | কোনটা সত্য বোঝা যায় না; আচরণ drift |
| F5 | **P0** | ডিফল্টে external MCP নেই, কিন্তু pinned tool `tts__tts_speak`, `ocr__ocr_image` | `lib/tool-budget.js:20`, `external-mcp.js:69`, `external mcp/servers.example.json` | এজেন্ট TTS/OCR দেখেই না; “অডিও বানাও” কাজ করে না |
| F6 | **P1** | `agent_personas` টুল শুধু universal-adapter-এ, hardcoded ৬ এজেন্ট; main-এ ৯ | `universal-adapter/registry.js:325-360`, `universal-adapter/personas.js:37-46`, `agent/*.js` | persona-র দুই সত্য; টুলটি main `/mcp`-এ নেই |
| F7 | **P1** | টুল-সংখ্যা ডকুমেন্টে ৩৬/১০১/১৫৫; স্ট্যাটিকে ২৯ core | `tools/tools-manifest.js:31`, `README.md:118`, `docs/EDGE-RUNTIME-SPEC.md:53`, `api.js:9785` | ডকুমেন্ট বিশ্বাসযোগ্যতা হারায়; gate মিথ্যা PASS হতে পারে |
| F8 | **P1** | `shutdown()` HTTPS/gRPC/h2c বন্ধ করে না; UDS close async, তারপরই `process.exit(0)` | `api.js:19622-19686`, `api.js:18378-18402` | stale UDS socket, অসম্পূর্ণ flush, non-graceful stop |
| F9 | **P1** | WebSocket `auth` ফ্রেম কিছুই enforce করে না | `api.js:17867-17892`, `api.js:17899-17921` | auth ভুল হলেও `chat`/`question` চলবে |
| F10 | **P1** | TCP sniffer ২৪ বাইট পূর্ণ না হলে socket আটকে থাকে | `api.js:13369-13410` | ছোট HTTP request (যেমন `GET / HTTP/1.0\r\n\r\n`) hang |
| F11 | **P1** | স্ট্রিমিং proxy fallback করে না (`if (stream) break`) | `api.js:15993-16018` | streaming-এ প্রথম provider ব্যর্থ হলে বাকিরা try হয় না |
| F12 | **P1** | alias করা মডেলের fallback ভাঙা | `api.js:3097`, `api.js:3187-3213` | `zombie-mini` alias-এ primary fail → fallback খালি |
| F13 | **P2** | `verifyGoalOutput` ভুল হলে আসল উত্তর মুছে canned বাংলা বার্তা বসায় | `api.js:9645-9654`, `api.js:12336-12435` | সঠিক ছোট উত্তর (“yes”) হারিয়ে যায়; শুধু non-stream-এ |
| F14 | **P2** | সিলেবাসে দুই writer, দুই ফরম্যাট, দুর্বল dedupe | `api.js:3678-3723`, `modules/syllabus.js:261-330` | একই lesson বারবার; plugin entry miss |
| F15 | **P2** | চাঙ্কড oversized body → 413 নয়, 400 “Invalid JSON” | `api.js:12769-12790`, `api.js:15135-15143` | client ভুল message পায় |

---

## ২. `api.js`-এর নেভিগেশন বনাম বাস্তবতা

`api.js:8-95`-এ একটি “Navigation Table of Contents” আছে। এটি এখন **ঐতিহাসিক**:

| TOC দাবি | TOC লাইন | বাস্তব লাইন | পার্থক্য |
|---|---:|---:|---|
| `POST /v1/chat/completions` | `api.js:76` → 9200 | `api.js:15132` | +৫৯৩২ |
| `GET /v1/models` | `api.js:59` → 8108 | `api.js:13900` | +৫৭৯২ |
| `POST /api/mission` | `api.js:77` → 9956 | `api.js:16915` | +৬৯৫৯ |
| `POST /api/input` | `api.js:81` → 10351 | `api.js:17433` | +৭০৮২ |
| WebSocket | `api.js:82` → 10401 | `api.js:17758` | +৭৩৫৭ |
| `handleMessage()` | `api.js:88` → 11770 | `api.js:19131` | +৭৩৬১ |
| `shutdown()` | `api.js:89` → 11987 | `api.js:19622` | +৭৬৩৫ |
| “Total: ~19100 lines” | `api.js:93` | `wc -l` = **19727** | +৬২৭ |

**কেন এমন:** ফাইলটি দ্রুত বাড়েছে, কিন্তু TOC ম্যানুয়ালি লেখা; রুট যোগ হলে TOC আপডেট হয়নি। কোডে মন্তব্যে বারবার “2026-08/10/11” তারিখভিত্তিক patch আছে (যেমন `api.js:1255`, `api.js:4746`, `api.js:17764`) — অর্থাৎ এটি দীর্ঘদিনের accretive growth।

**হওয়া উচিত:** TOC জেনারেট হবে (`grep -n` দিয়ে) বা থাকবে না। রুট-টেবিল এক জায়গায় ডেটা হিসেবে থাকবে, হ্যান্ডলার আলাদা।

**না করলে:** নতুন ডেভেলপার ভুল লাইনে যায়; রিভিউ ভুল জায়গায় ফোকাস করে; ডকুমেন্ট ও কোডের দূরত্ব বাড়ে।

**সমাধান:** `scripts/gen-api-toc.js` — `^function`, `url ===`, `case "` প্যাটার্ন পড়ে TOC তৈরি করবে; CI-তে `tests/docs-current-check.js`-এর সাথে mismatch gate।

---

## ৩. ডুপ্লিকেট: নাম আলাদা, দায়িত্ব এক

শীর্ষ-স্তরের `function` নামের মধ্যে **হুবহু ডুপ্লিকেট নেই** (২৬৬টি ডিক্লারেশন, সব ইউনিক)। কিন্তু **আচরণ/দায়িত্বের ডুপ্লিকেট** আছে — এটাই আসল সমস্যা।

### ৩.১ রেসপন্স নরমালাইজার — দুইটি

| দিক | `api.js` | `normalizer/index.js` |
|---|---|---|
| ফাংশন | `normalizeResponse()` `api.js:6350-6637` (২৮৭ লাইন) | `normalize()` `normalizer/index.js:1-541` |
| কে ব্যবহার করে | `/api/normalize` `api.js:14571`, R2T `api.js:19407`, `executeR2tRequest` `api.js:19515` | provider adapters: `provider/openai.js:22`, `provider/ollama.js:30`, `provider/gemini.js:26`, `provider/groq.js:21`, `provider/opencode.js:9` |
| ডায়ালেক্ট | Gemini, Anthropic, Bedrock, Responses, llama.cpp text fallback | openai/groq/ollama/gemini + structural detect |
| টুল parsing | `TOOLADAPTER.parseToolCalls` `api.js:6336-6348` | নিজস্ব `asArgString`/`asArgObject` |

**কেন এমন:** `api.js:6314`-এ মন্তব্য “HAQ MAWLA NORMALIZER”; পরে provider layer আলাদা করে `normalizer/` তৈরি হয় (`api.js:166-170`), কিন্তু `api.js`-এর পুরোনো normalizer মুছে ফেলা হয়নি। ADR-001: `docs/ADR-001-APIJS-COMPOSITION-ROOT.md:130-137` দাবি করে সব কিছু মডিউলে সরানো হয়েছে, কিন্তু `normalizeResponse` এখনো api.js-এ।

**হওয়া উচিত:** একটাই normalizer। `api.js` শুধু `normalizer.normalize()` import করবে; R2T ও `/api/normalize`-ও সেটাই ব্যবহার করবে। Anthropic/Bedrock support দরকার হলে `normalizer/index.js`-এ যোগ হবে, api.js-এ নয়।

**না করলে:** একই provider response দুই পথে দুই shape পায়; একটি path-এ tool_calls ঠিক, অন্যটিতে ভুল; bug দুই জায়গায় fix করতে হয়।

**সমাধান:** `api.js:6350-6637` → সরাসরি `normalizer/index.js`-এর `normalize(raw, {modelHint})`; পার্থক্য থাকলে adapter-এ feature flag; `tests/transport-suite.js:223` ও `tests/provider-independence-check.js:21` আগে থেকেই module normalizer টেস্ট করে — সেই টেস্টই gate হবে।

---

### ৩.২ টুল-এক্সিকিউশন লুপ — দুইটি, আচরণ আলাদা

| দিক | non-stream | stream |
|---|---|---|
| ফাংশন | `callModelWithTools()` `api.js:7280-7455` | `callModelStreamWithTools()` `api.js:7457-7627` |
| `MAX_ROUNDS` | 5 (`api.js:7291`) | 5 (`api.js:7490`) — ডুপ্লিকেট hardcode |
| টেক্সট-মার্কার tool call fallback | **আছে** `api.js:7343-7366` (`extractToolCalls`) | **নেই** |
| tool error shape | `{content:[{type:"text"}]}` `api.js:7392-7403` | plain string `api.js:7559-7564` |
| reasoning_content | assistant message-এ যোগ `api.js:7376-7386` | যোগ `api.js:7545-7550` |
| শেষে force-final | `callModel(..., undefined, undefined,...)` `api.js:7430` | `callModelStream(... undefined, undefined)` `api.js:7593` |

**কেন এমন:** স্ট্রিমিং টুইনটি পরে কপি করে লেখা হয়েছে (`api.js:7453` মন্তব্য: “Streaming twin of callModelWithTools”)। কপি করার সময় sanitizer ধাপটি বাদ পড়েছে।

**সমস্যা:** ছোট/local মডেল (ollama, llama.cpp) যখন native `tool_calls` না দিয়ে টেক্সটে `[TOOL:...]`/marker লেখে, তখন non-stream পাথে টুল চলে, stream পাথে চলে না। ব্যবহারকারী একই মডেল থেকে ভিন্ন ফল পায়।

**হওয়া উচিত:** একটি `runToolLoop({stream:boolean})` ফাংশন; ভেতরে `callModel`/`callModelStream` শুধু transport callback হিসেবে পার্থক্য করবে। sanitizer, budget, error shape, final-answer — সব এক।

**সমাধান (স্কেচ):**

```js
async function runToolLoop(opts) {
  const { model, messages, tools, toolContext, stream, onChunk } = opts;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = stream
      ? await callModelStream(...)
      : await callModel(...);
    const tcs = normalizeToolCalls(res, tools); // sanitizer এখানে, দুই path-এ
    ...
  }
}
```

Gate: `tests/tool-budget-check.js` + নতুন `tests/tool-loop-parity-check.js` — একই synthetic text-marker fixture দুই path-এ একই tool call দিতে হবে।

---

### ৩.৩ আউটপুট ভেরিফিকেশন — তিনটি

| ফাংশন | লাইন | কে ডাকে | কী দেখে |
|---|---|---|---|
| `verifyGoalOutput()` | `api.js:12336-12435` | `executeMission:9127`, `executeSingleAgent:9646` | empty/thinking/identity leak/don’t-know |
| `crossVerifySingleAgent()` | `api.js:18965-19079` | শুধু `handleMessage:19294` | contradiction/evidence/reference/length/code-safety |
| `verifyOutput()` (module) | `modules/verify.js:26-75` | শুধু `tests/modules-runtime-check.js:200-218` | non-empty/alignment/evidence/compiler |
| `verifyContract()` (module) | `modules/verify.js:78-347` | `anti-dote.js` monitor; `api.js:147` alias | execution chain score |

**কেন এমন:** antiDote chain `modules/goals.js`+`modules/verify.js`-এ সরানো হয়েছে (ADR-001:134-137), কিন্তু `api.js`-এর পুরোনো `verifyGoalOutput`/`crossVerifySingleAgent` রয়ে গেছে। `modules/verify.verifyOutput` শুধু টেস্টে ব্যবহৃত — মানে production-এ সেটি মৃত।

**সমস্যা:** একই উত্তরে এক ভেরিফায়ার PASS, আরেকটি FAIL বলতে পারে। `verifyGoalOutput` `userInput` প্যারামিটার নেয় কিন্তু শরীরে ব্যবহারই করে না (`api.js:12336-12435`) — “input-এর সাথে মিল” যাচাই করে না। `crossVerifySingleAgent` “goal achieved” মানে `content.length > 10` (`api.js:19032-19044`) — এটি content quality নয়, শুধু length।

**হওয়া উচিত:** একটাই `verifyOutput({input, output, intent, evidence, compiler})`; প্রতিটি surface একই ফল পাবে। `verifyContract` শুধু mission-chain-এর জন্য আলাদা থাকবে, কিন্তু তার ফলও একই `verification` অবজেক্টে যাবে।

**সমাধান:** `modules/verify.js`-এর `verifyOutput`-কে একমাত্র ভেরিফায়ার করুন; `verifyGoalOutput` মুছুন; `crossVerifySingleAgent`-এর checks `verifyOutput`-এ merge করুন; `verifyGoalOutput`-এর canned message সরিয়ে `blocked` metadata দিন, উত্তর প্রতিস্থাপন নয়।

---

### ৩.৪ ইন্টেন্ট ক্লাসিফায়ার — দুইটি

- `api.js:7702` — `classifyInput()` (regex/keyword, mission routing-এ ব্যবহৃত `api.js:8819`, `api.js:9423`)
- `modules/intent.js:136` — `classifyIntent()` (label/mode/confidence, শুধু `modules/chat-interpreter.js:99`)

`api.js` `intentModule` থেকে শুধু `PROMPTS` নেয় (`api.js:763-766`)। অর্থাৎ module-এর classifier main path-এ নেই।

**কেন এমন:** prompt template গুলো module-এ সরানো হয়েছে, কিন্তু classifier-এর inline implementation রয়ে গেছে (ADR-001:135 দাবি করে “3 prompt templates” সরেছে — সত্য; classifier সরেছে বলে দাবি করে না, কিন্তু একই concern-এর দ্বিতীয় সত্য থাকল)।

**সমস্যা:** একই ইনপুটে chat interpreter এক label দেয়, mission router আরেক label; syllabus-এ লেখা intent আর 실제 routing মেলে না।

**সমাধান:** `classifyInput` সরিয়ে `modules/intent.classifyIntent` ব্যবহার; `classifyInput`-এর special cases (`greeting`, `debug_request`) module-এ data-driven rule হিসেবে যোগ করুন; একই fixture দুই পাথে টেস্ট করুন।

---

### ৩.৫ মেমোরি — তিনটি স্টোর

| স্টোর | লাইন | ফাইল/টেবিল | কে লেখে |
|---|---|---|---|
| Per-agent memory | `api.js:6142-6159` | `DATA_DIR/<session>/<agent>.json` | `api.js:8030-8031`, `9529-9530`, `9610-9611`, `16397-16399` |
| Global session memory | `api.js:6215-6230` | `DATA_DIR/mem-<session>.json` | `api.js:9085-9086`, `9531-9532`, `9612-9613`, `16400-16401` |
| Project memory (SQLite) | `api.js:3726-3742`, `modules/project-memory.js` | `project_memory` টেবিল | `archiveSession:3813`, `getProjectMemoryStore` |

`saveAgentMemory` আর `saveMemory`-এর শরীর প্রায় হুবহু (Jaccard ০.৬৭ — স্ক্রিপ্ট গণনা); শুধু ফাইল path আলাদা।

**কেন এমন:** আগে JSON-only memory ছিল; পরে per-agent ও SQLite যোগ হয়েছে, পুরোনো path রাখা হয়েছে (backward compatibility)।

**সমস্যা:** একই turn দুইবার ডিস্কে লেখা; memory ফুলে যায়; restart-এ কোনটা read হবে তা caller-ভেদে আলাদা; purge/retention দুই জায়গায় করতে হয়।

**হওয়া উচিত:** একটাই memory API: `readMemory(session, agent?)` / `appendTurn(...)`; storage adapter JSON বা SQLite হবে config-ভিত্তিক, caller জানবে না।

**সমাধান:** `saveMemory` ও `saveAgentMemory`-কে একটি `appendMemory({sessionId, agentId, role, content})`-এ merge; per-agent ফাইল রাখতে হলে সেটি `agentId` ফিল্ডসহ একই SQLite টেবিলে; retention এক জায়গায়।

---

### ৩.৬ সেশন — `api.js` বনাম `modules/sessions.js`

- `api.js`: `SESSIONS_FILE = DATA_DIR/sessions.json` (`api.js:5774`), `createSession` (`:5872`), `getSession` (`:6009`), সব সেশন RAM-এ (`activeSessions`), TTL ২৪ঘণ্টা (`api.js:293`)।
- `modules/sessions.js`: `SessionStore` — সর্বোচ্চ ১০ resident, JSONL archive, LRU eviction (`modules/sessions.js:4-16`, `:44-232`)। **api.js এটি import করে না**; শুধু `tests/modules-runtime-check.js`।

**কেন এমন:** module-টি ভবিষ্যৎ replacement হিসেবে লেখা হয়েছে, কিন্তু wire করা হয়নি (ADR-001: “modules/sessions.js — only tests import” — সত্য)।

**সমস্যা:** সেশন সংখ্যা বাড়লে `sessions.json` পুরোটা RAM-এ; crash-এ in-flight write হারায়; archive format দুই রকম।

**সমাধান:** `SessionStore`-কে inject করুন; `createSession/getSession/updateSession` wrapper হবে module-এর উপর; JSON migration one-shot; TTL/eviction এক জায়গায়।

---

### ৩.৭ কনফিগ — `modules/config.js` সম্পূর্ণ অনাথ

- `lib/env.js:165-200` — আসল `.env` loader; `api.js:255-267` এটাই ব্যবহার করে।
- `modules/config.js:139-147` — শুধু `resolveSetting/requireSetting/resolveInt/resolvePort/resolveBool/resolveJson` export; **কোনো importer নেই**।
- `tests/env-loader-check.js:58` স্পষ্টভাবে assert করে: “api.js has no modules/config.js env loader”।

ADR-001:134 দাবি: “config | inline .env loader | `loadEnvFile` / `parseEnv`” — কিন্তু `modules/config.js`-এ `loadEnvFile` বা `parseEnv` **নেই**। এটি ডকুমেন্টের ভুল দাবি, অথবা ভিন্ন ব্রাঞ্চের কোড।

**সিদ্ধান্ত:** module-টি রাখলে `lib/env.js`-এর resolver হিসেবে ব্যবহার করুন (DB→env lookup), অথবা মুছে দিন। “দুটি সত্য” রাখা যাবে না।

---

### ৩.৮ পার্সোনা — main বনাম universal-adapter

- main: `agent/*.js` (৯টি ফাইল) → `agent/index.js:54-125` `loadAgentFiles()` → DB `agents` টেবিল (`api.js:4413-4460`) → `modules/agents.loadAgents` (`modules/agents.js:300-410`)।
- universal-adapter: `universal-adapter/personas.js:37-46` hardcoded **৬** এজেন্ট (`code-guru`, `bug-hunter`, `security-hero`, `perf-wizard`, `doc-king`, `qa-tyrant`)।
- `agent_personas` টুল শুধু adapter registry-তে: `universal-adapter/registry.js:325-360`। main `MCP_TOOLS`-এ এটি নেই (`api.js:9785-10130`)।

**সমস্যা:** main-এ ৯ এজেন্ট (অতিরিক্ত: `team-heart`, `customer-experience-specialist`, `ecommerce-operations-analyst`), adapter-এ ৬। যে ক্লায়েন্ট adapter-এ যায় সে ভুল roster দেখে। `personas.js:8-13` যে সোর্স বলে (`docs/No Evidence.md`, `docs/SSOT Principles.md`, `docs/identity`) — এই তিনটি ফাইল **এই চেকআউটে নেই** (`ls docs`-এর আউটপুট দেখুন)।

**হওয়া উচিত:** `agent_personas` main-এর একমাত্র roster থেকে পড়বে; adapter সেটি proxy করবে অথবা টুলটি সরিয়ে দেওয়া হবে। persona-র সাথে `source`, `updated_at`, `sha256` যাবে, যাতে DB/file drift ধরা পড়ে।

---

### ৩.৯ টুল ক্যাটালগ — main বনাম adapter

`universal-adapter/registry.js:92-320` নিজে `adapter_status`, `system_info`, `list_directory`, `read_file`, `write_file`, `delete_file`, `glob`, `grep`, `hash_text`, `agent_personas` — এই ১০টি টুল ডিফাইন করে। main-এও `list_directory/read_file/write_file/delete_file/glob/grep/system_info` আছে (`api.js:9786-10090`)। একই নাম, ভিন্ন sandbox:

- main: `isPathSafe` ডিফল্ট `AGENT_FS_SCOPE=unrestricted` (`api.js:10500-10533`)।
- adapter: `ROOTS` ডিফল্ট `universal-adapter/` (`universal-adapter/registry.js:57-62`)।

**সমস্যা:** একই `read_file` টুল দুই সার্ভারে দুই scope; ক্লায়েন্ট কোনটায় যুক্ত তা বুঝে না। `main-sync` (`universal-adapter/main-sync.js:1-30`) main-এর টুল mirror করে, ফলে একই নামের shadowing/recursion ঝুঁকি।

**হওয়া উচিত:** নাম conflict থাকলে prefix (`adapter__read_file`) বা একটাই implementation; adapter শুধু proxy করবে, নিজের file tool রাখবে না।

---

## ৪. মডিউল ব্যবহার অডিট (কোনটা সত্যিই যুক্ত)

| মডিউল | api.js-এ import | বাস্তবে ব্যবহৃত | অবস্থা |
|---|---|---|---|
| `modules/goals.js` | `api.js:137`, alias `143-146` | `typeSafetyCheck:19197-19213`, `anti-dote` | ✅ সক্রিয় |
| `modules/verify.js` | `api.js:138`, alias `147` | alias `antiDoteVerifyOutput` **কোথাও call হয় না**; `verifyContract` শুধু anti-dote monitor-এ | ⚠️ আধা-মৃত |
| `modules/anti-dote.js` | `api.js:139` | `antiDoteMonitor:8779`, `11006`, `11047`, `15612`, `15697` | ✅ সক্রিয় |
| `modules/compiler.js` | `api.js:140` | `containsCodeBlock:19047`, `hasDangerousPatterns:19048`, `analyzeContent:19304`; `compileFiles` **শুধু টেস্টে** | ⚠️ আসল compile বাদ |
| `modules/agents.js` | `api.js:141` | `loadAgents:4350`, `defaultAgentId` বহু জায়গায়, `syncAgentPersonas:18132` | ✅ সক্রিয় |
| `modules/watchdog.js` | `api.js:142` | `Watchdog:18194` | ✅ সক্রিয় |
| `modules/mcp-protocol.js` | `api.js:148` | `sessionIdFor`, `buildInitializeResult` (`handleMCP`) | ✅ সক্রিয় |
| `modules/context.js` | `api.js:149` | `buildPromptContext:9223` | ✅ একবার |
| `modules/system-prompt.js` | `api.js:151` | `buildSystemPrompt/fitPrompt` | ✅ সক্রিয় |
| `modules/provider-models.js` | `api.js:152` | merge/reconcile (`1620`, `1686`, `2494`, `2812`) | ✅ সক্রিয় |
| `modules/surface-policy.js` | `api.js:153` | শুধু `PRIVILEGED_TOOLS:4761`; `WEB_CHAT_TOOLS` main-এ নেই | ⚠️ আধা |
| `modules/chat-interpreter.js` | `api.js:154` | `interpretChat:15224` | ✅ সক্রিয় |
| `modules/chat-upload.js` | `api.js:155` | attachment resolve/build | ✅ সক্রিয় |
| `modules/project-memory.js` | `api.js:156` | `createProjectMemory:3731` | ✅ সক্রিয় |
| `modules/system-identity.js` | `api.js:163` | identity headers/metadata | ✅ সক্রিয় |
| `modules/intent.js` | `api.js:763` | শুধু `PROMPTS` (`764-766`) | ⚠️ classifier বাদ |
| `modules/syllabus.js` | `api.js:3624` | wrapper `autoSyllabus/readProjectSyllabus/writeSyllabus` | ✅ সক্রিয় |
| `modules/workspace.js` | `api.js:3625` | workspace paths | ✅ সক্রিয় |
| `modules/workspace-adapter.js` | `api.js:3626` | `registerWorkspace` | ✅ সক্রিয় |
| `modules/config.js` | **নেই** | **কোথাও নেই** | ❌ অনাথ |
| `modules/sessions.js` | **নেই** | শুধু টেস্ট | ❌ অনাথ |
| `modules/data-prune.js` | **নেই** | `start.js`/`scripts/prune-data.js` | ⚠️ অন্য প্রসেস |
| `modules/skill-db.js` | **নেই** | — | ❌ অনাথ |
| `modules/skill-parser.js` | **নেই** | — | ❌ অনাথ |
| `modules/edge-proxy.js` | **নেই** | `start.js`/`scripts/caddy-render.js` | ✅ অন্য প্রসেস |
| `modules/retention.js` | **নেই** | `start.js` | ✅ অন্য প্রসেস |
| `modules/surface-policy.js` | হ্যাঁ | উপরে দেখুন | ⚠️ |

**সিদ্ধান্ত:** “১৮টি মডিউল আছে” মানে “১৮টি যুক্ত” নয়। প্রতিটির একটি decision থাকতে হবে: **wire / move-to-another-process / delete**। ADR-001:130-142-এর “All seven modules are imported and the matching implementations moved out” — এটি আংশিক সত্য; `modules/config.js` import-ই হয় না, `normalizeResponse`/`classifyInput`/`verifyGoalOutput` এখনো api.js-এ।

---

## ৫. কে কার সাথে কথা বলে (call graph)

### ৫.১ উচ্চ-স্তরের প্রবাহ

```
HTTP /v1/chat/completions (agent id)
  └─ executeSingleAgent (api.js:16469)
       ├─ usableAgentModel → resolveProvider
       ├─ buildAgentSystemPrompt / buildCompactSystemPrompt
       ├─ callModelStreamWithTools (api.js:16327)
       │    └─ callModelStream (api.js:6671)
       │         └─ providerRegistry.chatStream (provider/index.js:349)
       │              └─ adapter.chatStream (openai/ollama/gemini/groq/llamacpp)
       │                   └─ provider/transport.js stream()
       └─ learnToSyllabus + archiveSession + verifyGoalOutput (stream নয়)

HTTP /v1/chat/completions (direct model)
  └─ proxyChatCompletion (api.js:15996)
       └─ callModel / callModelStream (tools client-এর, server execute করে না)

POST /api/mission (api.js:16915)
  └─ handleMessage (api.js:17008)
       ├─ injectContext (api.js:18735)
       ├─ typeSafetyCheck (api.js:19197)
       ├─ goalSettingCheck (api.js:19221)  ← ফল ব্যবহার হয় না
       ├─ executeSingleAgent (api.js:19243)  ← mission নয়!
       ├─ crossVerifySingleAgent (api.js:19294)
       └─ compilerModule.analyzeContent (api.js:19304)

POST /api/input (api.js:17433)
  └─ handleMessage (api.js:17462)  ← একই পাইপলাইন

POST /mcp agent_mission (api.js:11006)
  └─ antiDoteMonitor(executeMission, ...)
       └─ executeMission (api.js:8782)
            ├─ phase1_initialResponse (api.js:7936)
            ├─ phase2_intentCrossVerify (api.js:8076)
            └─ phase3_combinedOutput (api.js:8475)

POST /mcp agent_single (api.js:11047)
  └─ antiDoteMonitor(executeSingleAgent, ...)

UDS / WS (api.js:18233 / 17920)
  └─ handleMessage (api.js:19131)  ← /api/mission-এর মতো
```

### ৫.২ সারফেস-ভিত্তিক পাইপলাইন (এটাই F2)

| সারফেস | type-safety | goal-setting | mission engine | cross-verify | compiler | verifyGoalOutput |
|---|---|---|---|---|---|---|
| `/v1/chat/completions` agent | ❌ | ❌ | ❌ (single agent) | ❌ | ❌ | শুধু non-stream (`:9646`) |
| `/v1/chat/completions` direct | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `/api/mission` | ✅ `:19197` | ✅ `:19221` | ❌ `:19243` | ✅ `:19294` | ✅ `:19304` | ✅ non-stream |
| `/api/input` | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| MCP `agent_mission` | ❌ (antiDoteMonitor) | ❌ | ✅ `executeMission` | ❌ | ❌ | ✅ `:9127` |
| MCP `agent_single` | ❌ (antiDoteMonitor) | ❌ | ❌ | ❌ | ❌ | ✅ `:9646` |
| UDS / WS | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |

**কেন এমন:** প্রতিটি এন্ট্রি পয়েন্ট আলাদা সময়ে লেখা; “Unified Socket Architecture” মন্তব্য (`api.js:19124-19130`) দাবি করে সব ট্রান্সপোর্ট একই পথে যায়, কিন্তু `/v1/chat/completions` এখনো সরাসরি `executeSingleAgent` ডাকে (`api.js:16469`), `handleMessage`-এর মধ্য দিয়ে যায় না।

**সমস্যা:** একই প্রশ্ন /v1-এ গেলে type-safety/compiler হয় না; /api/mission-এ গেলে হয়। “Mission” নামের দুই অর্থ। ডিবাগ করা কঠিন।

**হওয়া উচিত:** একটি `dispatchRequest(transport, request)` থাকবে; সব এন্ট্রি সেটাই ডাকবে। `mission` মানে `executeMission`; `chat` মানে `executeSingleAgent`. ভেরিফিকেশন pipeline request-এর `mode`-এ নির্ভর করবে, transport-এ নয়।

**সমাধান (ধাপ):**
1. `/v1/chat/completions`-এর agent branch-কে `handleMessage`-এ পাঠান (response format adapter দিয়ে)।
2. `handleMessage`-এর `case "mission"`-এ `executeMission` ডাকুন; `combined`→`content` adapter লিখুন।
3. `multiAgent` ফ্ল্যাগ মুছুন বা বাস্তবে ব্যবহার করুন।
4. `tests/transport-parity-check.js`: একই ইনপুট চার ট্রান্সপোর্টে পাঠিয়ে `verification` ফিল্ড এক হতে হবে।

---

## ৬. ডকুমেন্টে কী বলা আছে বনাম কোড

| # | ডকুমেন্টের দাবি | প্রমাণ | কোডে বাস্তব | বিচার |
|---|---|---|---|---|
| D1 | api.js ১৯,৮০৪ লাইন | `docs/ADR-001-APIJS-COMPOSITION-ROOT.md:23` | ১৯,৭২৭ | পুরোনো সংখ্যা |
| D2 | সব module সরানো, api.js ১৮,৮০৭ | `docs/ADR-001...:130-144` | ১৯,৭২৭; `normalizeResponse`/`classifyInput`/`verifyGoalOutput` এখনো api.js-এ | দাবি অতিরঞ্জিত |
| D3 | config module-এ `loadEnvFile`/`parseEnv` | `docs/ADR-001...:134` | `modules/config.js:139-147`-এ তা নেই; `lib/env.js:165` আসল loader | ভুল রেফারেন্স |
| D4 | web-chat টুল: `web_search`, `get_time`, `calculate` | `docs/SURFACE-POLICY.md:10,25`; `modules/surface-policy.js:37` | `MCP_TOOLS`-এ `get_time`/`calculate` নেই (`api.js:9785-10130`) | allowlist-এর ২টি টুল অস্তিত্বহীন |
| D5 | tools = ১০১ | `README.md:118,192` | স্ট্যাটিক core ২৯ (২৮ + `remote_mcp_call`); external `servers.json` নেই | env-ভেদে বদলায়; ডকুমেন্টে একক সংখ্যা ভুল |
| D6 | tools = ১৫৫ | `docs/EDGE-RUNTIME-SPEC.md:53`; `docs/GUIDEBOOK...:69` | উপরের মতো; `external mcp/servers.json` নেই | অবাস্তব |
| D7 | documented contract = ৩৬ | `tools/tools-manifest.js:31` | ২৯ core + ১১ shipped (ocr ৪ + tts ৩ + screen ৪) = ৪০; ৩টি server থাকলে | `docs_match` মিথ্যা |
| D8 | TTS ৪টি টুল | `docs/GUIDEBOOK...:69` | `external mcp/tts-mcp.js:71,85,96` = ৩টি | গণনা ভুল |
| D9 | ক্যাটালগ ২৫-এ কাটা, `api.js:4922` | `docs/GUIDEBOOK...:15,25` | এখন lazy catalog + `lib/tool-budget.js`; 4922 লাইনে ভিন্ন কোড | পুরোনো |
| D10 | ৪টি transport | `api.js:93` | HTTP/1.1, h2c, HTTPS, UDS, TCP fallback, WS, gRPC — ৭+ | পুরোনো |
| D11 | persona সোর্স: `docs/No Evidence.md` ইত্যাদি | `universal-adapter/personas.js:8-13` | `docs/`-এ সেই ফাইল নেই | ভাঙা রেফারেন্স |
| D12 | surface-policy টেস্ট টুল আছে | `tests/surface-policy-check.js:71-74,115-125` | `{name:"get_time"}` synthetic; `MCP_TOOLS`-এ নেই | false green |

### ৬.১ “৩৬” কীভাবে ভাঙে

`tools/tools-manifest.js:31` বলে `CORE_TOOL_COUNT = 36`; মন্তব্যে `26 core + 10 external`। কিন্তু:

- `MCP_TOOLS` স্ট্যাটিক key: **২৮** (`api.js:9785-10130`), তারপর `remote_mcp_call` যোগ হয় `api.js:10191` → **২৯**।
- shipped external: `ocr` ৪ + `tts` ৩ + `screen-recorder` ৪ = **১১** (`external mcp/ocr-mcp.js:286,331,353,374`; `tts-mcp.js:71,85,96`; `screen-recorder-mcp.js:65,88,123,137`)।
- ২৯ + ১১ = **৪০**, ৩৬ নয়।
- `external mcp/servers.json` নেই (শুধু `servers.example.json`), তাই ডিফল্ট boot-এ external কিছুই merge হয় না → **২৯**।

**সিদ্ধান্ত:** `CORE_TOOL_COUNT` কে hardcoded ৩৬ না রেখে runtime গণনা করুন; অথবা ডকুমেন্টে “default 29, with servers.json 40” লিখুন। CI-তে `docs-current-check` আসল `tools/list`-এর সাথে মেলাবে।

---

## ৭. লাইন-ধরে লজিক রিভিউ (F1–F20)

### F1 — `/api/mission` মিশন নয়, এক এজেন্ট

**অবস্থান:** `api.js:16915-17040`, `api.js:19243-19251`, `api.js:9313`, `api.js:8782`, `api.js:11006`।

**এখন কী হয়:** `/api/mission` → `handleMessage({type:"mission"})` → `case "mission"` → `executeSingleAgent(agentId, messages, {...params, multiAgent:true})`। `executeSingleAgent`-এর শরীরে `multiAgent` কোথাও পড়া হয় না (grep: `multiAgent` শুধু `api.js:17025`, `17129`, `19250` — তিনটিই route/flag, function body-তে নয়)। অথচ MCP `agent_mission` → `antiDoteMonitor(executeMission, ...)` (`api.js:11006`) → সত্যিকারের `executeMission` (`api.js:8782`), যেখানে phase1/2/3 চলে।

**কেন এমন:** “Unified Socket Architecture” নামে `/api/mission`-কে `handleMessage`-এ যুক্ত করা হয়েছে (`api.js:16996-17026`), কিন্তু `handleMessage`-এর mission case-এ `executeMission` বসানো হয়নি; flag দিয়ে “multi-agent” বোঝানো হয়েছে।

**হওয়া উচিত:** `case "mission"` → `executeMission(userInput, context, sessionId, onProgress, tools)`; ফল `{combined}`-কে `{content: combined}`-এ map করা। `multiAgent` flag বাদ।

**না করলে:** HTTP ব্যবহারকারী “mission” ডেকে এক এজেন্টের উত্তর পান; MCP ব্যবহারকারী পান সব এজেন্টের। একই API-তে দুই আচরণ — বাস্তবে productivity কমে, কারণ mission-এর cross-verification হয় না।

**সমাধান:** উপরের call graph-এর ধাপ ২; `executeMission`-এর return shape adapter; `tests/mission-parity-check.js` — HTTP ও MCP mission-এ `agents.length` ও `verification.rounds` তুলনা।

---

### F2 — ট্রান্সপোর্টভেদে ভেরিফিকেশন আলাদা

**অবস্থান:** `api.js:16469` (v1 agent), `api.js:19131-19334` (handleMessage), `api.js:11006` (MCP mission), `api.js:19221` (goal unused)।

**এখন কী হয়:** `/v1/chat/completions` agent branch সরাসরি `executeSingleAgent` ডাকে → `typeSafetyCheck`, `crossVerifySingleAgent`, `compilerModule.analyzeContent` কেউ চলে না। `/api/mission` ও `/api/input` `handleMessage` দিয়ে যায় → সব চলে। MCP `agent_mission` শুধু antiDoteMonitor চালায় → crossVerify/compiler নেই।

**কেন এমন:** প্রতিটি এন্ট্রি আলাদা সময়ে লেখা; “unified” মন্তব্য (`api.js:19124-19130`) শুধু handleMessage-এর জন্য সত্য।

**হওয়া উচিত:** verification policy request mode-এর সাথে বাঁধা, transport-এর সাথে নয়। `mode: chat|mission` → `requiredChecks` তালিকা।

**না করলে:** একই কোড-উত্তর /v1-এ “compiler checked: false” হয়, /api/mission-এ “true”। ব্যবহারকারী কোনোটায় ভরসা করবে বুঝতে পারে না।

**সমাধান:** §৫.২-এর ম্যাট্রিক্সকে কোডে এক `pipeline.js`-এ লিখুন; প্রতিটি transport শুধু `dispatch({mode, messages, tools})` ডাকবে।

---

### F3 — কম্পাইলার ভেরিফিকেশন আসলে কম্পাইল করে না

**অবস্থান:** `modules/compiler.js:53-85` (`compileFiles`, আসল `node --check`/`JSON.parse`), `modules/compiler.js:87-135` (`analyzeContent`, regex/bracket heuristic), `api.js:19304` (analyzeContent ডাকা হয়), `api.js:10646-10700` (`write_file`)।

**এখন কী হয়:** `handleMessage` শেষে `analyzeContent` চলে — এটি শুধু কোড-ব্লকের bracket/indent গোনে (`modules/compiler.js:150-240`)। `compileFiles` কেউ production-এ ডাকে না; শুধু `tests/modules-runtime-check.js:232` ডাকে। `write_file` ফাইল লিখে সাথে সাথে “Written … bytes” ফেরত দেয় — কোনো syntax check নেই।

**কেন এমন:** `compileFiles` পরে যোগ হয়েছে (মডিউল extraction-এর সময়), কিন্তু request pipeline-এ wire করা হয়নি; `analyzeContent` পুরোনো heuristic।

**হওয়া উচিত:** যেকোনো `.js/.cjs/.mjs/.json` লেখার পর বাধ্যতামূলক `compileFiles([rel], {cwd: workDir})`; ব্যর্থ হলে tool result-এ `COMPILE_FAILED` + stderr, আর model-কে repair round-এ ফেরত। শেষ উত্তরে “done” বলার আগে `BUILD_OK`/`COMPILE_OK`/exit 0 প্রমাণ ছাড়া success claim নিষিদ্ধ।

**না করলে:** ভাঙা কোড লিখেও এজেন্ট “সম্পন্ন” বলে; ব্যবহারকারী পরে build-এ ব্যর্থ হন; “compiler checked” মিথ্যা সবুজ।

**সমাধান (স্কেচ):**

```js
// api.js write_file case-এর fs.writeFileSync-এর পরে
const ext = path.extname(p).toLowerCase();
if ([".js", ".cjs", ".mjs", ".json"].includes(ext)) {
  const rel = path.relative(workDir, p);
  const check = compilerModule.compileFiles([rel], { cwd: workDir, timeoutMs: 10000 });
  if (!check.passed) {
    return {
      content: [{ type: "text", text:
        "COMPILE_FAILED\n" + check.results[0].error +
        "\nFix the file and retry; do not claim completion." }],
      isError: true,
    };
  }
}
```

এরপর `callModelWithTools`/`callModelStreamWithTools`-এর loop-এ `isError`tool result থাকলে final answer-এ success নিষিদ্ধ; `verifyOutput`-এর `compiler` চেক বাধ্যতামূলক।

**Gate:** `tests/compiler-gate-check.js` — (a) ভালো JS → OK, (b) ভাঙা JS → `COMPILE_FAILED`, (c) repair round-এ ঠিক হলে final OK, (d) ৫ round-এ না হলে honest failure।

---

### F4 — `verifyGoalOutput` আসল উত্তর মুছে ফেলে

**অবস্থান:** `api.js:12336-12435`, `api.js:9645-9654`।

**এখন কী হয়:** non-stream single-agent path-এ `verifyGoalOutput` fail করলে `response.content = singleGoalCheck.message` — অর্থাৎ আসল উত্তর মুছে canned বাংলা বার্তা বসে। `userInput` প্যারামিটার নেওয়া হয় কিন্তু ব্যবহার হয় না। শুধু non-stream-এ চলে (`api.js:9646`), streaming-এ নয়।

**কেন এমন:** “Type Safety Before Output” ধারণা থেকে লেখা (`api.js:12329-12335`), কিন্তু fail-এ উত্তর প্রতিস্থাপন করা product decision নয় — safety decision-এর সাথে mismatch।

**হওয়া উচিত:** fail হলে উত্তর ব্লক না করে `verification.blocked=true` + কারণ দিন; ব্যবহারকারী আসল উত্তর + সতর্কতা দেখুক। অথবা সত্যিই block করতে হলে সব path-এ একইভাবে, এবং শুধু safety-critical ক্ষেত্রে (identity leak)।

**না করলে:** “yes”/“CWD-OK” 같은 সঠিক ছোট উত্তরও `length`/pattern-এ আটকে যায়; user ভাবে এজেন্ট অক্ষম।

**সমাধান:** `verifyGoalOutput` মুছে `modules/verify.verifyOutput` ব্যবহার; `message` নয়, `reasons[]` রিটার্ন; UI/CLI `warning` হিসেবে দেখাক।

---

### F5 — pinned tool নেই, তাই TTS/OCR হারিয়ে যায়

**অবস্থান:** `lib/tool-budget.js:18-22` (`MCP_TOOL_BUDGET_PIN: "tts__tts_speak,ocr__ocr_image"`), `api.js:5051-5061` (`lazyToolCatalog`), `external-mcp.js:64-75` (`servers.json` না থাকলে ০ server), `external mcp/servers.example.json`।

**এখন কী হয়:** `MCP_TOOL_LAZY=1` ডিফল্ট (`api.js:15191`), তাই মডেল পায় `tool_search` + pinned tools। কিন্তু pinned নাম `MCP_TOOLS`-এ না থাকলে `lazyToolCatalog` সেটি skip করে (`api.js:5055-5057`)। `external mcp/servers.json` নেই, তাই `tts__*`/`ocr__*` কখনো merge হয় না (`externalMcp.loadAll()` → `no config` `external-mcp.js:69`)। ফল: মডেল শুধু `tool_search` পায়; TTS/OCR `tool_search`-এও নেই।

**কেন এমন:** server list example হিসেবে রাখা হয়েছে, installer `servers.json` কপি করে না; pin default-এ থেকে গেছে।

**হওয়া উচিত:** boot-এ pinned tool `MCP_TOOLS`-এ আছে কিনা যাচাই; না থাকলে (a) `CONFIG_FATAL`, অথবা (b) pin ignore + `PIN_TOOL_MISSING` warn, কিন্তু user-visible `capabilities`-এ TTS নেই বলে জানানো। `servers.json` না থাকলে `servers.example.json` থেকে auto-seed (opt-in) বা installer step।

**না করলে:** ব্যবহারকারী “অডিও বানাও” বললে এজেন্ট টুলই দেখে না — GUIDEBOOK-এর অভিযোগের মূল কারণ (`docs/GUIDEBOOK...:25`)। productivity সরাসরি কমে।

**সমাধান:** `lib/tool-budget.validateConfig()`-এ pinned exist check যোগ; `external-mcp.loadAll()`-এ missing config হলে example থেকে in-memory load (file write নয়) অথবা startup warning + `/api/tools/manifest`-এ `pinned_missing`.

---

### F6 — persona টুল main-এ নেই, adapter-এ hardcoded

**অবস্থান:** `universal-adapter/registry.js:325-360`, `universal-adapter/personas.js:37-46`, `agent/index.js:54-125`, `modules/agents.js:300-410`।

**এখন কী হয়:** main `/mcp`-এ `agent_personas` নেই; universal-adapter-এ আছে, কিন্তু ৬ এজেন্ট hardcoded, main-এ ৯। `personas.js:8-13` যে ডকুমেন্ট সোর্স বলে তা নেই।

**কেন এমন:** adapter আলাদা প্রোডাক্ট হিসেবে লেখা হয় (personas.js মন্তব্য), পরে main-এর agent/*.js source of truth হয়; adapter sync হয়নি।

**হওয়া উচিত:** `agent_personas` main-এ read-only টুল; DB/agent files থেকে পড়বে; adapter সেটি proxy করবে। persona-তে `sha256`, `source`, `updated_at`, `enabled` থাকবে।

**না করলে:** ক্লায়েন্ট ভুল roster/ভুল persona দেখে; persona edit দুই জায়গায় করতে হয়; prompt injection-এর মতো পুরোনো persona চলতে পারে।

**সমাধান:** §৮ দেখুন।

---

### F7 — ডকুমেন্টের টুল-সংখ্যা তিন রকম

**অবস্থান:** `README.md:118` (১০১), `docs/EDGE-RUNTIME-SPEC.md:53` (১৫৫), `tools/tools-manifest.js:31` (৩৬), `api.js:9785` (২৯)।

**কেন এমন:** বিভিন্ন সময়ে বিভিন্ন env দিয়ে মাপা হয়েছে; কেউ `CORE_TOOL_COUNT` আপডেট করেনি।

**হওয়া উচিত:** ডকুমেন্টে একটাই সূত্র: `tools/tools-manifest.js`-এর runtime manifest; CI `tests/docs-current-check.js` সেটাই পড়বে।

**না করলে:** release gate ভুল সংখ্যায় PASS/FAIL; নতুন ডেভেলপার বিভ্রান্ত।

**সমাধান:** `CORE_TOOL_COUNT` সরিয়ে `manifest(Object.keys(MCP_TOOLS))` runtime; README-তে “see /api/tools/manifest”।

---

### F8 — shutdown অসম্পূর্ণ

**অবস্থান:** `api.js:19622-19686`, `api.js:18378-18402`, `api.js:18022-18084`, `transport/uds-gateway.js:200-230`।

**এখন কী হয়:** `shutdown()` শুধু `tcpServer`, `udsGateway`, `udsServer`, `openaiUdsServer`, SSE বন্ধ করে; `httpsServer`, `grpcServer`, `h2cServer`, watchdog timer বন্ধ করে না। `udsGateway.close()` async, কিন্তু তারপরই `process.exit(0)` — promise resolve হওয়ার সুযোগ নেই; `if (!udsGateway)` cleanup branch-ও চলবে না।

**কেন এমন:** shutdown ধীরে ধীরে বেড়েছে; নতুন transport যোগ হলে cleanup যোগ হয়নি।

**হওয়া উচিত:** এক `async shutdown()`; `Promise.allSettled([...])`; watchdog.stop(); external MCP kill; flush; তারপর exit। দ্বিতীয় SIGTERM-এ জোর করে exit।

**না করলে:** stale UDS socket (পরের boot-এ `preparePath` stale unlink করে, তাই recover হয় — কিন্তু তবু unclean); buffered session/memory হারাতে পারে; gRPC/HTTPS client হঠাৎ কাটে।

**সমাধান:**

```js
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([
    closeNet(tcpServer), closeNet(httpsServer), closeNet(h2cServer),
    grpcServer?.close?.(), udsGateway?.close?.(),
    openaiUdsServer?.close?.(),
  ]);
  watchdog?.stop?.();
  externalMcp.killAllStdio?.();
  flushAllMemory(); flushAllSessions(); flushClientsSync();
  process.exit(0);
}
```

---

### F9 — WebSocket auth কার্যকর নয়

**অবস্থান:** `api.js:17867-17892` (`auth` case), `api.js:17899-17921` (`chat` case)।

**এখন কী হয়:** `auth` ফ্রেমে `wsAuthenticated` লোকাল ভেরিয়েবল; সেটি socket-এ সংরক্ষণ হয় না। `chat`/`question` case কোনো auth flag দেখে না — সরাসরি `handleMessage` ডাকে।

**কেন এমন:** auth পরে যোগ হয়েছে, কিন্তু chat path আগের মতোই আছে; origin gate (`api.js:17758-17780`) একমাত্র বাধা।

**হওয়া উচিত:** `socket.__authed = true` সেট; `chat`/`mcp`-এ চেক; না হলে `auth_error` + close।

**না করলে:** যে পেজ origin allowlist-এ আছে (নিজের web UI) সে auth ছাড়াই chat চালাতে পারে — কম ঝুঁকি, কিন্তু “auth আছে” মিথ্যা।

**সমাধান:** handshake-এ একটি `auth` state; `chat`-এ `if (!socket.__authed) { send error; return; }`।

---

### F10 — TCP sniffer ২৪ বাইটের কম request-এ hang

**অবস্থান:** `api.js:13369-13410`।

**এখন কী হয়:** `onReadable` ততক্ষণ অপেক্ষা করে যতক্ষণ `buffer.length < 24`; HTTP/1.1 request যা ২৪ বাইটের কম (যেমন `GET / HTTP/1.0\r\n\r\n` = ১৮ বাইট) কখনো `server`-এ যায় না — client hang।

**কেন এমন:** HTTP/2 preface (২৪ বাইট) detect করতে ২৪ বাইট লাগে; কিন্তু HTTP/1.1-এর জন্য prefix check কম হলেও চলে।

**হওয়া উচিত:** প্রথম লাইনে `\r\n` পেলে সাথে সাথে HTTP/1.1 হিসেবে forward; preface-এর জন্য ২৪ বাইট লাগলে `PRI ` prefix দেখেই h2c-এ পাঠান।

**সমাধান:** `if (buffer.slice(0,4).toString()==="PRI ")` → h2c; `else if (buffer.includes("\r\n"))` → server; নাহলে আরও data-র জন্য অপেক্ষা (timeout সহ)।

---

### F11 — streaming proxy fallback বন্ধ

**অবস্থান:** `api.js:15993-16018`।

**এখন কী হয়:** `keyedProviders` লুপে প্রথম provider fail করলে `if (stream) break;` — তাই দ্বিতীয় provider try হয় না। non-stream-এ সব try হয়।

**কেন এমন:** স্ট্রিমিংয়ে একবার chunk গেলে fallback করা কঠিন; কিন্তু `sseStarted` false থাকলে (প্রথম chunk-এর আগে) নিরাপদে fallback করা যায় — কোড সেই কন্ডিশনই রাখে (`api.js:15978-15992`), তবু break।

**হওয়া উচিত:** `if (stream && sseStarted) break;` — প্রথম chunk-এর আগে fallback চলবে।

**না করলে:** প্রথম provider down হলে streaming request সাথে সাথে fail; non-stream একই মডেলে কাজ করে — transport-ভেদে reliability আলাদা।

---

### F12 — alias মডেলে fallback ভাঙা

**অবস্থান:** `api.js:3097` (`resolveProvider` alias প্রয়োগ করে), `api.js:3187-3213` (`resolveAllProviders` করে না)।

**এখন কী হয়:** `resolveProvider("zombie-mini")` → alias → `llama-local` → provider পাওয়া যায়। কিন্তু `findNextProvider("zombie-mini", ...)` → `resolveAllProviders("zombie-mini")` → provider lists-এ `zombie-mini` নেই → `[]` → fallback নেই।

**কেন এমন:** alias শুধু primary resolver-এ যোগ করা হয়েছে; fallback enumerator আপডেট হয়নি।

**হওয়া উচিত:** `resolveAllProviders`-এর শুরুতে `model = applyModelAlias(model)`।

**না করলে:** alias ব্যবহারকারী primary fail হলে কোনো fallback পায় না; error “no provider” — বিভ্রান্তিকর।

---

### F13 — oversize chunked body → 400, 413 নয়

**অবস্থান:** `api.js:12769-12790` (`readBody`), `api.js:13486-13495` (Content-Length precheck), `api.js:15135-15143` (JSON parse error)।

**এখন কী হয়:** Content-Length থাকলে 413 হয়। Chunked/unknown length হলে `readBody` cap ছাড়িয়ে গেলে `""` resolve করে; caller `JSON.parse("")` → 400 “Invalid JSON”।

**হওয়া উচিত:** `readBody` `{ok:false, tooLarge:true}` রিটার্ন করবে; caller 413 দেবে।

**না করলে:** client ভাবে JSON ভুল, আসলে body বড় — debugging বিভ্রান্তিকর।

---

### F14 — `init()` ব্যর্থ হলে process বেঁচে থাকে, listener ছাড়া

**অবস্থান:** `api.js:18160` (throw), `api.js:19366` (`init();` no catch), `api.js:19705-19713` (unhandledRejection “continue”)।

**এখন কী হয়:** agent না থাকলে `init()` reject করে; `unhandledRejection` handler শুধু log করে, process চালু রাখে। `tcpServer.listen` পর্যন্ত পৌঁছায় না — process “চলছে” কিন্তু কোনো HTTP listener নেই।

**হওয়া উচিত:** `init().catch(err => { log FATAL; process.exit(78); })`; boot failure-এ fail-fast।

**না করলে:** supervisor ভাবে service up; আসলে down — সবচেয়ে খারাপ observability।

---

### F15 — সিলেবাসে দুই writer, দুর্বল dedupe

**অবস্থান:** `api.js:3678-3723` (`writeSyllabus`/`learnToSyllabus`), `modules/syllabus.js:261-330` (`recordLearning`/`appendSyllabusEntry`)।

**এখন কী হয়:** `learnToSyllabus` `existing.includes("### " + topic)` দিয়ে dedupe করে (`api.js:3703`); `recordLearning` কোনো dedupe ছাড়া append করে (`modules/syllabus.js:261-290`); `appendSyllabusEntry` শক্তিশালী dedupe/fingerprint রাখে (`modules/syllabus.js:330-395`) কিন্তু api.js তা ডাকে না। `updateLatestLearnings` ফাইল দুবার লেখে (`appendFileSync` তারপর `writeFileSync` — `modules/syllabus.js:276-327`) — concurrent agent-এ race।

**কেন এমন:** plugin-এর syllabus format ও server-এর format আলাদা সময়ে তৈরি; `appendSyllabusEntry` নতুন, wire হয়নি।

**হওয়া উচিত:** এক writer: `appendSyllabusEntry`; `recordLearning` মুছুন বা wrapper করুন; `updateLatestLearnings` এক atomic write-এ; learning শুধু verified আউটপুটে।

**না করলে:** একই lesson বারবার, ফাইল ফুলে যায়; plugin entry duplicate; দুই agent সমান্তরালে লিখলে একটি হারায়।

---

### F16 — মেমোরি ডুপ্লিকেট (বিস্তারিত §৩.৫)

**অবস্থান:** `api.js:6142`, `api.js:6215`, `api.js:3726`।
**সমস্যা:** এক turn দুই ফাইলে; retention/purge দুই জায়গায়; restart-এ read path ভিন্ন।
**সমাধান:** `appendMemory` এক API; storage adapter।

---

### F17 — normalizer ডুপ্লিকেট (বিস্তারিত §৩.১)

**অবস্থান:** `api.js:6350`, `normalizer/index.js:1`।
**সমস্যা:** একই response দুই shape; tool_calls পার্থক্য।
**সমাধান:** এক normalizer; api.js-এর পুরোনো ফাংশন মুছুন।

---

### F18 — টুল লুপ ডুপ্লিকেট (বিস্তারিত §৩.২)

**অবস্থান:** `api.js:7280`, `api.js:7457`।
**সমস্যা:** stream path-এ `extractToolCalls` নেই (`api.js:7343-7366` vs stream) — local model-এর text tool call হারায়।
**সমাধান:** এক `runToolLoop`।

---

### F19 — verify/intent ডুপ্লিকেট (বিস্তারিত §৩.৩, §৩.৪)

**অবস্থান:** `api.js:12336`, `api.js:18965`, `modules/verify.js:26`; `api.js:7702`, `modules/intent.js:136`।
**সমস্যা:** ভিন্ন ফল, ভিন্ন label; production-এ module verify মৃত।
**সমাধান:** এক verify, এক classify।

---

### F20 — টেস্টের false green ও fragility

**অবস্থান:** `tests/surface-policy-check.js:71-74,115-125`, `tests/docs-current-check.js` (identity.json), `tests/api-line-audit-check.js:34` (git)।

**এখন কী হয়:** surface test synthetic `get_time` দিয়ে PASS, যদিও টুলটি নেই। `docs-current-check` ও `api-line-audit-check` পরিবেশ-নির্ভর ফাইলে fail করে।

**হওয়া উচিত:** টেস্ট আসল `MCP_TOOLS`/runtime manifest পড়বে; fixture ছাড়া টেস্ট skip নয়, fail-fast; git-নির্ভর টেস্টে skip guard।

**না করলে:** CI সবুজ, production-এ টুল নেই — ঠিক যা F5-এ হয়েছে।

---

## ৮. এজেন্ট পার্সোনা টুল — কীভাবে সঠিক করবেন

### ৮.১ বর্তমান অবস্থা

- main: `agent/*.js` → `loadAgentFiles` (`agent/index.js:54-125`) → DB (`api.js:4413`) → `modules/agents.loadAgents` (`modules/agents.js:300-410`)।
- tool: `agent_personas` শুধু `universal-adapter/registry.js:325-360`; ৬ hardcoded।
- validation: persona খালি হলে agent drop (`agent/index.js:110-120`, `modules/agents.js:401-410`), কিন্তু model/persona drift ধরার hash নেই।

### ৮.২ লক্ষ্য ডিজাইন

**Read-only টুল (main MCP):**

```
agent_personas        → { agents: [{id, name, role, model, enabled, source, persona_sha256, updated_at}] }
agent_persona_get     → { id, name, role, persona, rules, source, sha256 }
```

- `AGENTS`/DB থেকেই পড়বে; কোনো hardcoded list নয়।
- `persona_sha256 = sha256(persona)`; `source=db|agent/*.js`; `updated_at`।
- `id` বা `name` (case-insensitive) দুটোই accept।
- persona output-এ `stripInvisible` (`lib/text-integrity.js`) প্রয়োগ; সর্বোচ্চ দৈর্ঘ্য cap।

**Edit (admin-only):** বিদ্যমান `POST /api/admin/agents` (`lib/admin-routes.js:60-110`) — persona DB-তে; agent file নয়। প্রতিটি edit-এ `persona_sha256` ও `updated_at` আপডেট; পুরোনো hash history রাখলে rollback সম্ভব।

**Boot validation:**

```js
for (const a of AGENTS) {
  if (!a.id || !a.name || !a.persona) → AGENT_PERSONA_INVALID, drop (already)
  if (!usableAgentModel(a)) → AGENT_MODEL_MISSING, mark disabled + honest error
  a.persona_sha256 = sha256(a.persona)
}
```

**Adapter:**

- `universal-adapter/personas.js` মুছুন বা main-এর `agent_personas`-কে proxy করুন (`main-sync`-এর মতো)।
- adapter-এর নিজের file tools (`read_file` ইত্যাদি) prefix করুন বা সরান — main-এর সাথে নাম conflict যেন না হয়।

### ৮.৩ কেন এটা productivity বাড়ায়

- একই persona সব ক্লায়েন্টে; model/persona mismatch ধরা পড়ে boot-এ।
- এজেন্ট নিজের persona পড়তে পারে → self-check, কিন্তু edit করতে পারে না (tool read-only)।
- `sha256` থাকলে prompt-এ `persona_hash` দেখিয়ে “কে কথা বলছে” যাচাই করা যায়।

### ৮.৪ নিরাপত্তা নোট

`agent/index.js:85-101` agent file-কে `vm.runInNewContext`-এ চালায়, sandbox-এ `require: require` দেওয়া আছে — অর্থাৎ agent/*.js কার্যত server-প্রিভিলেজে কোড চালায়। এটি local trust boundary। ভবিষ্যতে agent definition-কে JSON/data-তে নিন বা restricted evaluator ব্যবহার করুন; অন্তত ডকুমেন্টে লিখুন “agent/ = trusted code”।

---

## ৯. কম্পাইলার ভেরিফিকেশন স্বয়ংক্রিয় করা

### ৯.১ নীতি

1. **Claim নয়, exit code।** “done” বলতে `node --check`/`npm run build`/`JSON.parse`-এর exit 0 লাগবে।
2. **লেখার সাথে সাথেই।** `write_file`/`rename_file`-এর ফলেই compile check।
3. **ব্যর্থতা model-কে ফেরত।** Tool result-এ stderr; model repair round পাবে।
4. **শেষ gate।** `MAX_ROUNDS` শেষে compile fail থাকলে success নয় — honest failure।

### ৯.২ Hook points

| Hook | লাইন | কাজ |
|---|---|---|
| `write_file` | `api.js:10646-10700` | লেখার পর `compileFiles` |
| `rename_file` | `api.js:10780` | নতুন path-এ compile |
| tool loop (non-stream) | `api.js:7392-7415` | `isError` ফল track |
| tool loop (stream) | `api.js:7559-7585` | একই |
| `handleMessage` | `api.js:19304` | `analyzeContent` → `compileFiles` (code blocks হলে temp file) |
| final verification | `modules/verify.js` | `intent.requires.compiler` → evidence বাধ্যতামূলক |

### ৯.৩ `compileFiles` কেন সঠিক

`modules/compiler.js:53-85`:

- `.js/.cjs/.mjs` → `spawnSync(node, ["--check", abs])` — আসল parser।
- `.json` → `JSON.parse`।
- timeout ২০s default, `maxBuffer` নেই কিন্তু stderr ৫০০ char-এ কাটা।
- `tests/modules-runtime-check.js:232-238` ইতিমধ্যে ভালো/খারাপ ফাইল দিয়ে প্রমাণ করে।

### ৯.৪ কোড স্কেচ (পূর্ণ)

```js
// api.js — write_file-এর ভেতরে, fs.writeFileSync(p, writeSan.text)-এর পরে
function compileAfterWrite(file, workDir) {
  const ext = path.extname(file).toLowerCase();
  if (![".js", ".cjs", ".mjs", ".json"].includes(ext)) return null;
  const rel = path.relative(workDir, file);
  const result = compilerModule.compileFiles([rel], {
    cwd: workDir,
    timeoutMs: Number(process.env.COMPILE_TIMEOUT_MS || 20000),
  });
  return result;
}

// write_file return
const compile = compileAfterWrite(p, workDir);
if (compile && !compile.passed) {
  const detail = compile.results
    .map((r) => r.file + ": " + (r.error || "failed"))
    .join("\n");
  log("WARN", "WRITE_COMPILE_FAILED", { path: p, detail });
  return {
    content: [{ type: "text", text:
      "COMPILE_FAILED — file was written but is not valid.\n" + detail +
      "\nFix it before claiming completion." }],
    isError: true,
  };
}
return { content: [{ type: "text", text: "Written ... and COMPILE_OK" }] };
```

### ৯.৫ Goal ledger দিয়ে end-to-end gate

`modules/goals.js:44-158`-এ `GoalLedger` আছে: `open()` → `close()` আসল command চালায়, exit code + expected marker মেলায়। `api.js` এটি কোথাও ব্যবহার করে না। Compiler-এর জন্য:

```js
const ledger = new goalsModule.GoalLedger({ dir: workDir });
const goal = ledger.open({
  goal: "build passes",
  input: userInput,
  expected: "BUILD_OK",
  check: "npm run build && echo BUILD_OK",
  pass: "BUILD_OK",
  match: "contains",
});
const result = ledger.close(goal.id); // {status:"PASS"|"FAIL", exitCode, observed}
if (result.status !== "PASS") → honest failure
```

এটি `tests/modules-runtime-check.js:160`-এ already tested (goal ledger runs the real command)।

### ৯.৬ যা করবেন না

- regex দিয়ে “syntax ঠিক আছে” বলা (`analyzeContent` একা যথেষ্ট নয়)।
- `write_file`-এ ব্যর্থ compile-ও success বলা।
- exit code না দেখে `done` claim করা।
- `node --check`-কে build test ভাবা — এটি syntax, runtime behavior নয়। বড় project-এ `npm test`/`tsc --noEmit` আলাদা gate।

---

## ১০. সিলেবাস আপডেট স্বয়ংক্রিয় করা

### ১০.১ এক writer

`modules/syllabus.js`-এর `appendSyllabusEntry(spec)` (`:330-395`) একমাত্র writer হওয়া উচিত:

- `entryKey(input)` sha256 → `zc-entry:<key>` marker।
- merged view-তে key/probe থাকলে skip (`duplicate`/`plugin-entry`)।
- `workspaceFingerprint` বদলালে `fingerprint-mismatch`।
- atomic write (`atomicWrite` `:95-104`)।
- `renderEntry`-এ user input, intent, prior conversation, source।

`api.js`-এর `learnToSyllabus` (`:3692-3723`) এবং `writeSyllabus` (`:3678-3690`) এটিকে ডাকবে; `recordLearning` (`modules/syllabus.js:261-290`) মুছুন বা wrapper করুন (dedupe নেই)।

### ১০.২ কখন লিখবে

- শুধু verified output: `crossVerifySingleAgent.passed` বা `compiler PASS` বা মানব-অনুমোদিত।
- একই topic-এ একবার; নতুন তথ্য হলে version/append।
- trivial chatter (<40 char) বাদ — বর্তমান `api.js:3694` এই threshold রাখে, ভালো।

### ১০.৩ কী লিখবে

```js
{
  dir: projectDir,
  input: userInput,          // normalize করা
  title: topic,              // 60-80 char
  intent: classification,    // label/mode/confidence
  conversation: recentTurns, // bounded 6
  source: "agent:" + agent.id,
}
```

### ১০.৪ API

`POST /api/syllabus` (`api.js:17386`) এবং MCP `append_syllabus` (`api.js:11128`) — দুই entry-ই `writeSyllabus` → `recordLearning`-এ যায়; এদের `appendSyllabusEntry`-এ পাঠান। Response-এ `{written, skipped, reason, key}` ফেরত দিন, শুধু `true/false` নয়।

### ১০.৫ Race ও size

- `updateLatestLearnings` (`modules/syllabus.js:293-327`) দুবার লেখে; এক atomic read-modify-write করুন।
- `SYLLABUS_MAX_BYTES` 16 MB (`:35`); append-এর আগে size check, ছাড়ালে rotate/archive।
- concurrent agent-দের জন্য file lock (`.lock` O_EXCL) বা single-writer queue।

### ১০.৬ Gate

`tests/workspace-layout-check.js:227-240` ও `tests/modules-runtime-check.js:124-151` already dedupe/fingerprint test করে। নতুন gate: `SYLLABUS_SINGLE_WRITER_OK` — `grep` করে নিশ্চিত করুন `recordLearning` আর `appendSyllabusEntry` দুটো আলাদা production path-এ ডাকা হয় না।

---

## ১১. ট্রান্সপোর্ট সঠিকভাবে ম্যানেজ করা

### ১১.১ বর্তমান ট্রান্সপোর্ট ম্যাট্রিক্স

| ট্রান্সপোর্ট | এন্ট্রি | সার্ভার | নোট |
|---|---|---|---|
| HTTP/1.1 | `PORT` | `server` `api.js:17753`, `tcpServer` sniffer `:13371` | মূল |
| h2c | একই port | `h2cServer` `:17997`, `:18022` | preface detect |
| HTTPS | `HTTPS_PORT` | `:18378` | optional cert |
| UDS (MCP+OpenAI) | `UDS_PATHS` | `createUdsGateway` `:18338`; legacy `:18301` | protocol sniff |
| UDS OpenAI (legacy) | `OPENAI_UDS_PATH` | `createUdsOpenAIServer` `:18318` | test mode |
| TCP fallback | `UDS_PORT` | `:18265` | Windows |
| WebSocket | upgrade | `:17758-18010` | chat/mcp/auth |
| gRPC | `GRPC_PORT` | `createGrpcServer` `:18395` | h2c+protobuf |
| stdio (outbound) | env | `external-mcp.js` | child process |

### ১১.২ নিয়ম

1. **Transport = wire only।** Business logic একটাই pipeline; transport শুধু decode/stream/close।
2. **Capability matrix এক।** কোন surface-এ কোন টুল/privilege — `modules/surface-policy.js` এক সত্য; ট্রান্সপোর্ট কোডে আলাদা allowlist নয়।
3. **Lifecycle এক।** `start()/ready()/shutdown()` এক coordinator; সব listener একসাথে বন্ধ।
4. **Error taxonomy:** 400 malformed, 401 auth, 403 origin, 404 unknown, 413 too large, 429 rate limit, 502 upstream, 503 unavailable। `readBody` oversize → 413 (F13)।
5. **Cancellation:** client disconnect → `AbortController` → provider request destroy। বর্তমানে `req.on("close")` নেই; দীর্ঘ stream client চলে গেলেও provider call চলতে পারে।
6. **Backpressure:** `res.write()` false হলে `drain`-এর অপেক্ষা; SSE-তে unbounded write নয় (`writeWebChunk` budget আছে, কিন্তু backpressure নেই)।
7. **Health vs readiness:** `/health` unhealthy provider-এও 200 দেয় (`api.js:13714-13738`); একটি `/ready` যোগ করুন যেখানে DB/listener/provider critical হলে 503।
8. **Graceful shutdown order:** stop accepting → drain streams → close UDS → kill children → flush → exit (F8)।

### ১১.৩ UDS

`transport/uds-gateway.js:1-20` — এক socket-এ MCP JSONL + HTTP; প্রথম বাইটে protocol নির্ধারণ। ভালো ডিজাইন। তবে:

- `preparePath` stale socket unlink করে (`:88-101`) — ঠিক।
- `close()` শুধু bound path unlink করে যদি inode মেলে (`:208-224`) — ঠিক।
- কিন্তু `api.js` `process.exit(0)` আগে promise resolve হয় না (F8)।
- `attachLegacyUds` (`api.js:18239-18263`) আলাদা parser — একই কাজ দুই জায়গায়; legacy mode বাদ দিয়ে এক gateway রাখুন।

### ১১.৪ gRPC/h2c

- gRPC `transport/grpc.js` `upstream: http://host:PORT`-এ forward করে (`api.js:18395-18399`) — অর্থাৎ gRPC নিজে business logic নয়, proxy। ভালো।
- `h2cServer` `server.emit("request")` করে (`:18051`) — একই handler, ভালো।
- `stripH2ForbiddenHeaders` (`:18011-18019`) প্রয়োজনীয়।
- gRPC/h2c-এর জন্য আলাদা auth নেই; HTTP handler-এর `mcpGate`-ই ভরসা। নিশ্চিত করুন `:authority` host header-এ map হয় (`:18024-18028`)।

### ১১.৫ WebSocket

- Origin gate আছে (`:17764-17780`) — ভালো।
- auth enforce নেই (F9)।
- Frame parsing নিজে লেখা (`:17782-17835`) — masking, 125/126/127 length, ping/pong আছে; কিন্তু fragmentation (continuation frames) handle করে না। বড় JSON frame ভাঙলে parse fail। `ws` library ব্যবহার না করলে fragmentation + max payload + UTF-8 validation যোগ করুন।

### ১১.৬ Rate limit

`RATE_LIMIT_STATES` domain-ভিত্তিক (`api.js:12507-12560`); `isRateLimited(providerId, model)` provider/model মেলায়। একটি provider-এর 429 পুরো domain-কে block করে না — ভালো। কিন্তু `state` একটাই slot; provider A-এর 429-এর পর provider B-এর 429 আগের তথ্য overwrite করে। per-provider map করুন।

---

## ১২. অগ্রাধিকার ও রোডম্যাপ

### Phase 0 — সত্য প্রতিষ্ঠা (০.৫–১ দিন)

- TOC/README/EDGE/GUIDEBOOK-এর সংখ্যা এক করুন; `tools-manifest` runtime করুন।
- `tests/surface-policy-check` আসল `MCP_TOOLS` পড়ুক; `docs-current-check`-এর identity.json dependency সরান।
- `docs/ADR-001`-এ “Execution record” সংশোধন: config module, line count, ১৮,৮০৭ দাবি।

**Gate:** `DOCS_TRUTH_OK` — একই `tools/list` সংখ্যা সব ডকে।

### Phase 1 — পাইপলাইন একীকরণ (২–৩ দিন)

- `dispatchRequest` এক; `/v1` agent branch → `handleMessage`।
- `/api/mission` → `executeMission`; `multiAgent` বাদ।
- এক `verifyOutput`; `verifyGoalOutput`/`crossVerifySingleAgent` merge।
- এক normalizer; `api.js:6350` সরান।

**Gate:** `PIPELINE_PARITY_OK` — ৪ ট্রান্সপোর্টে একই verification ফল।

### Phase 2 — কম্পাইলার ও গোল (২ দিন)

- `write_file` hook + `compileFiles`।
- `GoalLedger` wire; `BUILD_OK` gate।
- `modules/compiler.compileFiles` production-এ; `analyzeContent` শুধু text preview।

**Gate:** `COMPILER_GATE_OK` (ভালো/খারাপ/repair/honest-fail চার কেস)।

### Phase 3 — persona ও syllabus (২ দিন)

- `agent_personas` main-এ; adapter proxy; hardcoded list মুছুন।
- এক syllabus writer; atomic Latest Learnings; verified-only।

**Gate:** `PERSONA_SINGLE_SOURCE_OK`, `SYLLABUS_SINGLE_WRITER_OK`।

### Phase 4 — transport hardening (২–৩ দিন)

- async shutdown; WS auth/fragmentation; TCP prefix; streaming fallback; 413; per-provider rate limit; AbortController।

**Gate:** `TRANSPORT_LIFECYCLE_OK`, `WS_AUTH_OK`, `PARTIAL_HTTP_OK`।

### Phase 5 — মেমোরি/সেশন (২ দিন)

- `appendMemory` এক API; `SessionStore` wire; retention এক জায়গায়।

**Gate:** `MEMORY_SINGLE_STORE_OK`।

---

## ১৩. ফাইল-বাই-ফাইল ম্যাপ

| ফাইল | লাইন | ভূমিকা | গুরুত্বপূর্ণ রেফ | রায় |
|---|---:|---|---|---|
| `api.js` | 19727 | composition + HTTP/WS/UDS/gRPC + agents + tools | `6350`, `7280`, `7457`, `9313`, `15132`, `16469`, `19131`, `19622` | ভাগ করা দরকার |
| `start.js` | 1787 | supervisor/build | `1274-1280` signal | ঠিক আছে |
| `agent/index.js` | 174 | agent file loader | `54-125`, `85-101` vm | trusted-code সীমা |
| `modules/agents.js` | 429 | DB+file merge | `300-410` | ভালো |
| `modules/anti-dote.js` | 227 | non-blocking monitor | `20-60` | ভালো |
| `modules/chat-interpreter.js` | 161 | web-chat | `129` system webContext | double-insert |
| `modules/chat-upload.js` | 323 | attachment | — | ভালো |
| `modules/compiler.js` | 275 | compile/analyze | `53-85`, `87-135` | `compileFiles` wire করুন |
| `modules/config.js` | 147 | settings resolver | `139-147` | **অনাথ** |
| `modules/context.js` | 331 | prompt context | `buildPromptContext` | ভালো |
| `modules/data-prune.js` | 112 | prune | — | start.js |
| `modules/edge-proxy.js` | 531 | Caddy render | — | start.js |
| `modules/goals.js` | 451 | goal ledger/contract | `44-158` | wire করুন |
| `modules/intent.js` | 252 | classifier/prompts | `136` | api classifier merge |
| `modules/mcp-protocol.js` | 361 | MCP handshake | — | ভালো |
| `modules/project-memory.js` | 535 | SQLite memory | — | এক মেমোরি API-তে |
| `modules/provider-models.js` | 98 | merge rules | `reconcileModels` | ভালো |
| `modules/sessions.js` | 234 | bounded sessions | `44-232` | **অনাথ** |
| `modules/surface-policy.js` | 171 | surface table | `37` | টুল নাম ঠিক করুন |
| `modules/syllabus.js` | 406 | syllabus writer | `261-330` | এক writer |
| `modules/system-prompt.js` | 224 | prompt fit | — | ভালো |
| `modules/verify.js` | 355 | verify | `26-75`, `78-347` | এক verify |
| `modules/watchdog.js` | 151 | heartbeat | `142-145` stop | shutdown-এ stop |
| `provider/index.js` | 546 | adapter registry | `228-360` | ভালো |
| `provider/tools.js` | 158 | tool register | `prepare()` | ভালো |
| `provider/transport.js` | 315 | HTTP/SSE | `MAX_FRAME_BYTES` | ভালো |
| `normalizer/index.js` | 541 | response normalize | `1-60` | এক normalizer |
| `transport/uds-gateway.js` | 246 | UDS demux | `200-230` close | shutdown await |
| `transport/grpc.js` | 241 | gRPC proxy | — | close যোগ |
| `transport/protobuf.js` | 252 | protobuf | — | ভালো |
| `lib/env.js` | 523 | env/paths | `165-200` | এক loader |
| `lib/tool-budget.js` | 336 | tool budget | `18-22`, `validateConfig` | pin exist check |
| `lib/size-budget.js` | 128 | caps | `readBody` caller | 413 |
| `lib/admin-routes.js` | 283 | admin CRUD | `60-110` | persona hash |
| `universal-adapter/registry.js` | 530 | adapter tools | `325-360` | main-এ proxy |
| `universal-adapter/personas.js` | 270 | hardcoded roster | `37-46` | **মুছুন/proxy** |
| `universal-adapter/main-sync.js` | 421 | mirror | — | shadowing check |
| `external-mcp.js` | 307 | stdio/HTTP MCP | `64-75`, `30-50` | servers.json |
| `external mcp/tts-mcp.js` | 373 | TTS ৩ টুল | `71,85,96` | pin ঠিক |
| `external mcp/ocr-mcp.js` | 609 | OCR ৪ টুল | `286,331,353,374` | pin ঠিক |
| `external mcp/screen-recorder-mcp.js` | 424 | screen ৪ টুল | `65,88,123,137` | — |
| `tools/tools-manifest.js` | 80 | count claim | `31` | runtime করুন |
| `tools/tool-sanitizer.js` | 298 | text tool calls | — | stream path-এ যোগ |
| `tests/surface-policy-check.js` | — | gate | `71-74` | false green |
| `tests/modules-runtime-check.js` | — | module proof | `200-240` | ভালো gate |

---

## ১৪. রেফারেন্স

### স্থানীয় (এই চেকআউট)

- `api.js:8-95` — TOC; `api.js:6350` — normalizeResponse; `api.js:7280/7457` — tool loops; `api.js:9313` — executeSingleAgent; `api.js:12336` — verifyGoalOutput; `api.js:15132` — /v1/chat; `api.js:16915` — /api/mission; `api.js:19131` — handleMessage; `api.js:19622` — shutdown.
- `modules/verify.js:26,78`; `modules/compiler.js:53,87`; `modules/syllabus.js:261,330`; `modules/surface-policy.js:37`; `modules/config.js:139`; `modules/sessions.js:44`.
- `agent/index.js:54-125`; `modules/agents.js:300-410`.
- `universal-adapter/registry.js:325`; `universal-adapter/personas.js:37`.
- `lib/tool-budget.js:18-22`; `external-mcp.js:64-75`; `tools/tools-manifest.js:31`.
- `docs/ADR-001-APIJS-COMPOSITION-ROOT.md:23,130-144`; `docs/SURFACE-POLICY.md:10,25`; `docs/EDGE-RUNTIME-SPEC.md:53`; `docs/GUIDEBOOK-2026-11-20.md:15,69`; `README.md:118,192`.
- `tests/surface-policy-check.js:71-74`; `tests/modules-runtime-check.js:200-240`; `tests/workspace-layout-check.js:227-240`.

### অফিসিয়াল (আচরণ/প্রোটোকল যাচাইয়ের জন্য)

- OpenAI Chat Completions & tools: https://platform.openai.com/docs/api-reference/chat
- OpenAI function calling: https://platform.openai.com/docs/guides/function-calling
- Groq tool use: https://console.groq.com/docs/tool-use/overview
- Ollama tool calling: https://docs.ollama.com/capabilities/tool-calling
- Gemini generateContent / tools: https://ai.google.dev/api/generate-content
- MCP specification (JSON-RPC, tools/list, tools/call): https://modelcontextprotocol.io/specification
- Node.js HTTP/2 (`http2.createServer`, `:authority`): https://nodejs.org/api/http2.html
- Node.js `net` / Unix domain sockets: https://nodejs.org/api/net.html
- Node.js `child_process.spawnSync` (compiler gate): https://nodejs.org/api/child_process.html
- Edge TTS voices (bn-BD-NabanitaNeural): https://learn.microsoft.com/azure/ai-services/speech-service/language-support

---

## ১৫. পরিশিষ্ট — পরিমাপ ও পুনরুৎপাদন

### ১৫.১ `api.js` ফাংশন-ডুপ্লিকেট স্ক্যান

```bash
grep -oE "^(async )?function [A-Za-z0-9_]+" api.js | sed -E 's/^(async )?function //' | sort | uniq -c | sort -rn | head
# সব ১ — নাম-ডুপ্লিকেট নেই (২৬৬টি ইউনিক)
```

শরীর-সাদৃশ্য (Jaccard) শীর্ষ:

| স্কোর | ফাংশন ১ | ফাংশন ২ |
|---:|---|---|
| 0.67 | `saveAgentMemory` (`:6142`) | `saveMemory` (`:6215`) |
| 0.48 | `runDbQuery` (`:11615`) | `listDbTables` (`:11648`) |
| 0.44 | `loadSkills` (`:5232`) | `loadInstructions` (`:5259`) |
| 0.42 | `recordModelStat` (`:13053`) | `recordAgentStat` (`:13067`) |
| 0.40 | `callModelWithTools` (`:7280`) | `callModelStreamWithTools` (`:7457`) |
| 0.36 | `callModelStream` (`:6671`) | `callModel` (`:6929`) |

### ১৫.২ টুল গণনা (স্ট্যাটিক)

```
MCP_TOOLS keys: 28
+ remote_mcp_call: 1 → 29 core
ocr: 4, tts: 3, screen-recorder: 4 → 11 shipped
29 + 11 = 40 (servers.json থাকলে)
এই চেকআউটে servers.json নেই → 29
```

### ১৫.৩ যা এখনো অজানা (UNVERIFIED)

- লাইভ `tools/list`-এ প্রকৃত সংখ্যা (env-ভেদে ২৯–১৫৫)।
- `tts__tts_speak` এই মেশিনে এখন কাজ করে কিনা (servers.json নেই)।
- ৯ এজেন্টের প্রতিটির provider live health।
- `docs/E2E-RESULTS-2026-11-06.json`-এর ফল বর্তমান কোডে প্রযোজ্য কিনা।

> এই চারটি যাচাই করতে `.env`, `data/models.db`, `external mcp/servers.json` সহ লাইভ boot দরকার। যাচাই ছাড়া “কাজ করে” বলা হবে না।

---

**শেষ কথা:** ভুল থাকা অন্যায় নয় — লুকানো অন্যায়। এই রিপোর্টে প্রতিটি দাবির পাশে ফাইল ও লাইন আছে; যেগুলো যাচাই করা যায়নি সেগুলো UNVERIFIED লেখা। পরের ধাপ Phase 0: ডকুমেন্টের তিনটি সংখ্যা (২৯/৩৬/১০১/১৫৫) এক করা এবং `tests/surface-policy-check`-এর false green বন্ধ করা।

---

## ১৬. রিভিশন — ২০২৬-১১-২৫: টেস্টেড মডিউল ও api.js ওয়্যারিং

**Contract:** `gc-mwwc6ad1`
**Check:** `node tests/api-module-wiring-check.js`
**Marker:** `API_MODULE_WIRING_OK`

### ১৬.১ পরিমাপ

| মেট্রিক | আগে | পরে |
|---|---:|---:|
| `api.js` লাইন | 19,763 | 19,755 (−8) |
| api.js-এ inline loopback definition | ৩টি | ০ |
| `lib/net.js` importer | `lib/env.js`, `lib/bridge-upstreams.js` | + `api.js` |

### ১৬.২ আটটি মডিউলের সিদ্ধান্ত

`api.js` সরাসরি import করে না — এই আটটির প্রতিটির মালিকানা যাচাই করে সিদ্ধান্ত নেওয়া হয়েছে। **এই আটটির মধ্যে** শুধু `lib/net.js`-এর কোড api.js-এ ডুপ্লিকেট ছিল; বাকি সাতটি অন্য এন্ট্রিপয়েন্টের সম্পত্তি, তাই api.js-এ টেনে আনা dead import হতো। (এর বাইরে `api.js`-এ আরও দ্বিতীয় implementation আছে — §17.২।)

| মডিউল | টেস্ট | বর্তমান owner | সিদ্ধান্ত | প্রমাণ |
|---|---|---|---|---|
| `lib/net.js` | `tests/bridge-discovery-check.js` | api.js + bridge | **WIRED** — `isLoopbackUrl`, `isLoopbackAddress`, `isOriginAllowed` এখন `isLoopbackHost`/`normalizeHost` ব্যবহার করে; 127/8 নিয়ম মডিউলে এক জায়গায় | `api.js:120,1723,4079-4080,4889-4893`; `lib/net.js` `isLoopbackHost` |
| `lib/bridge-upstreams.js` | `tests/bridge-discovery-check.js` | `local-llm-bridge.js:109` | **NOT_WIRED** — bridge প্রসেসের concern | `BRIDGE_DISCOVERY_OK` |
| `modules/config.js` | `tests/env-loader-check.js:58` | `lib/env.js` loader; config resolver-এর runtime importer নেই | **NOT_WIRED** — guard নিজেই api.js-এ এই path নিষেধ করে; এটি loader নয়, resolver | `ENV_LOADER_OK`; “api.js has no modules/config.js env loader” |
| `modules/data-prune.js` | `tests/data-cleanup-check.js:166` | `start.js:75` boot | **NOT_WIRED** — boot-process housekeeping | `DATA_CLEANUP_OK` |
| `modules/edge-proxy.js` | `tests/edge-proxy-check.js` | `start.js:27` | **NOT_WIRED** — edge/deploy প্রসেস | `EDGE_PROXY_OK` |
| `modules/sessions.js` | `tests/modules-foundation-check.js:157` | কোনো consumer নেই | **NOT_WIRED** — `SessionStore` agent-turn archive (১০ resident); api.js-এর client session (`SESSIONS_FILE`, TTL/reuse) আলাদা concern; merge behaviour decision | `modules/sessions.js:1-16`; `api.js:5803-5903` |
| `modules/skill-db.js` | `tests/skill-mcp-check.js:130` | `external mcp/skill-mcp.js:17` | **NOT_WIRED** — MCP প্রসেস | `SKILL_MCP_OK` |
| `modules/skill-parser.js` | `tests/skill-mcp-check.js:131` | `external mcp/skill-mcp.js:27` | **NOT_WIRED** — MCP প্রসেস | `SKILL_MCP_OK` |

### ১৬.৩ Authentic test ফল

| কমান্ড | ফল |
|---|---|
| `node tests/api-module-wiring-check.js` | `API_MODULE_WIRING_OK` pass=11 fail=0 |
| `node tests/env-loader-check.js` | `ENV_LOADER_OK` (29/29) |
| `node tests/bridge-discovery-check.js` | `BRIDGE_DISCOVERY_OK` (7/7) |
| `node --check api.js` | exit 0 |

`AGENT_FS`/`dist` নোট: runtime `dist/api.js` rebuild বা restart করা হয়নি; এই রিভিশন source-level। নতুন কোড restart-এর পর লাইভ হবে — সেটি `NOT_TESTED`।

---

## ১৭. ময়না তদন্ত — ২০২৬-১১-২৬ (লাইভ)

**Scope:** `api.js` ১৯,৭৫৫ লাইন / ৭০২,৮০৫ বাইট (`wc -lc`, ২৬ নভেম্বর ২০২৬)। এই section-এ কোনো feature দাবি নেই; শুধু কোড-পাঠ, লাইভ log আর executable test-এর প্রমাণ।

### ১৭.১ "মডিউল import করছি, তবু api.js কমছে না" — কারণ

এটি একটাই কারণ নয়, চারটি আলাদা প্রক্রিয়া একসাথে কাজ করছে:

1. **Import মানে move নয়।** `lib/net.js` import করে api.js-এর ৩টি loopback helper বদলালে main file থেকে ৩ লাইন যায়, কিন্তু module-এ কোড থেকে যায়। মোট repo লাইন কমে না; শুধু `api.js`-এর হিসাব কমে। `modules/mcp-protocol.js` ৪০৯ লাইনের canonical validator — api.js শুধু call করে, কিন্তু call site, fallback আর আগের inline copy থেকে যাওয়া behaviour এখনো api.js-এ আছে।
2. **api.js-এ দ্বিতীয় implementation বেঁচে আছে।** `normalizeResponse()` (`api.js:6373-6659`, ২৮৭ লাইন) আর canonical `normalizer/index.js` (৫৪১ লাইন) — দুটোই জীবিত। `classifyInput()` (`api.js:7736-7916`, ১৮১ লাইন) আর `modules/intent.js`-এর `classifyIntent()` (২৫২ লাইনের module) — দুটোই জীবিত। Session system (`api.js:5794-6070`, ২৭৭ লাইন) আর `modules/sessions.js` (২৩৪ লাইন) — module-টির production consumer নেই।
3. **নতুন guard/logging যোগ হচ্ছে, পুরোনো duplicate যাচ্ছে না।** এই pass-এ ১৯টি `adminRouteAuthorized(req)` call site আছে (`api.js:4817` definition; প্রথম call `:13813`, শেষ `:17523`)। প্রতিটি ৪–৮ লাইনের 401 block; এগুলো এক middleware-এ গেলে ৭০+ লাইন বাঁচত, কিন্তু এখন প্রতিটি route-এ কপি করা।
4. **মোট line count খারাপ KPI।** `api.js` থেকে কোড module-এ সরালে main file ছোট হয়, repo বড় হয়; আর `normalizeResponse`-এর মতো দ্বিতীয় copy মুছলে behaviour বদলানোর ঝুঁকি থাকে। তাই "কম লাইন"目標 হলে আগে duplicate behaviour মাপতে হবে, শুধু `wc -l` নয়।

### ১৭.২ কোথায় কোন module আছে, কিন্তু api.js সেটি ব্যবহার করে না

| Module | api.js-এ সমমানের কোড | প্রমাণ | সিদ্ধান্ত |
|---|---|---|---|
| `normalizer/index.js` (৫৪১) | `normalizeResponse()` ২৮৭ লাইন; `/api/normalize`, r2t, internal call-এ ব্যবহৃত | `api.js:6373-6659`, call `:14632,:19434,:19543`; provider adapter `provider/openai.js:22` canonical `normalize` ব্যবহার করে | **NOT_WIRED in api.js** — provider path canonical, dev/r2t path second copy; একীভূত করতে golden-output test দরকার |
| `modules/intent.js` (২৫২) | `classifyInput()` ১৮১ লাইন | `api.js:7736-7916`, call `:8853,:9457`; module থেকে শুধু `PROMPTS` import (`:765-768`) | **PARTIAL** — prompt comes from module, classification still local |
| `modules/sessions.js` (২৩৪) | `readSessions`/`writeSessions`/`cleanExpired`/`createSession`/`getSession`/`updateSession` ২৭৭ লাইন | `api.js:5794-6070`; `modules/sessions.js:234` exports `SessionStore`, production importer নেই | **NOT_WIRED** — দুটি ভিন্ন concern (agent-turn archive vs client session); merge decision খোলা |
| `modules/config.js` (১৪৭) | `lib/env.js` loader; api.js-এ direct `process.env.X || default` শত শত জায়গায় | `tests/env-loader-check.js:58` নিজেই বলে api.js এই module import করবে না | **DEAD for runtime** — config resolver-এর importer নেই; ভবিষ্যতে `lib/env`-এর সাথে merge অথবা delete |
| `transport/uds-gateway.js` | পুরোনো `OPENAI_UDS_PATH` branch + নিজের frame parser | `api.js:18319-18406`; `transport/uds-gateway.js` canonical, call `:18356` | **PARTIAL** — নতুন gateway wired, legacy branch scripts/tests-এর জন্য টিকে আছে |
| `modules/skill-db.js` (২২০), `modules/skill-parser.js` (১৭৭) | api.js-এ সমমানের skill parser নেই; `loadSkills()` শুধু git download | `api.js:5255-5280` | **NOT_WIRED** — owner `external mcp/skill-mcp.js`; api.js-এ আনা dead import হবে |

**গুরুত্বপূর্ণ পার্থক্য:** §16-এ আটটি module-এর scope ছিল "api.js কেন এই module টানে না"। এখানে প্রশ্ন উল্টো: **api.js-এ এমন কোড আছে যা module-এও আছে, অথচ module-টি api.js import করে না**। দ্বিতীয় তালিকাটাই "ডাল মে কুছ কালা" — মডিউল থাকা সত্ত্বেও পুরোনো ডাল নিজের পাতে পড়ে আছে।

### ১৭.৩ hardcoded ও backdoor-ধরনের লজিক — F21…F30

| ID | Finding | প্রমাণ (path:line) | অবস্থা / ঝুঁকি |
|---|---|---|---|
| **F21** | **r2t `[[TOOL:exec]]` — request body থেকেই shell, কোনো admin gate নেই; default ছিল `true`** | আগে `process.env.R2T_ENABLED || "true"` (বর্তমান line `api.js:19457`); executor `:19614-19623`; `.env:160` এই মেশিনে `false` | **FIXED (opt-in)** — এখন শুধু exact `true`; test `R2T_TRACE_OK 15/15`। `.env` আগে থেকেই false, তাই live behaviour অপরিবর্তিত |
| **F22** | `/api/mission`-এ shell/file tool "in-process", admin token ছাড়া; auth optional | `modules/surface-policy.js:52-62` (`privileged: "in-process"`), `api.js:16969-16974` optional auth, `authFromRequest` no-header → `{ok:null}` (`:4732`), `:16935` route | **OPEN** — local-agent trust model; loopback-only। কিন্তু browser/other local process-এর জন্য blast radius বড়; §15-এ decision দরকার |
| **F23** | FS scope default `unrestricted`; terminal guard শুধু `cwd` দেখে, command দেখে না | `api.js:10539` default, `:10743-10762` `outsideSession(cwd)` তারপর `bash -c cmd`; `restricted`-ও `$HOME` allow করে (`:10570-10577`) | **OPEN / accepted** — `cd / && cat /etc/passwd` cwd guard পাশ কাটায়; unrestricted-এ guard-ই চলে না। §15-এ explicit accept/decision |
| **F24** | Admin fail-open switch: `ADMIN_ALLOW_UNAUTHENTICATED=true` + token unset → সব admin route open | `api.js:4791-4801`; `.env`-এ flag absent, তাই এখন fail-closed | **OPEN (config)** — production-এ flag সেট না করার guard দরকার; docs-এ इसे "dev only" রাখা |
| **F25** | Panel cookie-তে `Secure` নেই; panel GET credential ছাড়াই cookie mint করে | `lib/admin-session.js:54-61`; `api.js:14276-14281` | **OPEN (low/medium)** — loopback HTTP-তে Secure cookie কাজ করবে না, কিন্তু HTTPS edge-এ downgrade risk; token ছাড়া cookie একা admin route খোলে না (`:4817-4819`) |
| **F26** | Admin token প্রথমে সাধারণ `===`, পরে constant-time helper | `api.js:4804-4811` (`got === want` short-circuit), `mcpAdminTokenOk` | **OPEN (low)** — ৪৮-char token-এ network timing attack অবাস্তব, তবু first compare সরানো সহজ |
| **F27** | Provider-wide breaker model-scoped 404/400-এ trip করত; retired Gemini 2.5 পুরো Gemini skip করিয়েছিল | live log: `PROVIDER_UNHEALTHY consecutiveFailures:3 lastError:http_404 …gemini-2.5-pro` (`logs/2026-11-25.log`, 17:40:28); `api.js:12743` (`markProviderFailure`) | **FIXED** — `lib/provider-failure.js`; 400/404-model health ledger-এ যাবে না, 503/429 যাবে; `PROVIDER_HEALTH_OK 17/17` |
| **F28** | MCP `MCP-Protocol-Version: 2026-07-28` (client future date) প্রতিটি call-এ 400; ৫২টি reject | `logs/2026-11-25.log` 17:30–17:34 `MCP_HEADER_REJECTED …2026-07-28`; `modules/mcp-protocol.js` `isForwardProtocolVersion` | **FIXED** — future valid ISO date accepted as forward-compat, `2026-13-99` rejected; `MCP_API_INTEGRATION_OK`; live restart pending |
| **F29** | পুরোনো UDS parser + `OPENAI_UDS_PATH` branch canonical gateway-এর পাশে টিকে আছে | `api.js:18319-18406`, `transport/uds-gateway.js`; scripts `scripts/dist-verify.sh`, `scripts/p4-verify.sh`, `tests/agent-transport-e2e.js` এখনো legacy path ব্যবহার করে | **OPEN** — naive delete scripts ভাঙবে; migration plan দরকার |
| **F30** | `api.js`-এ দ্বিতীয় normalizer/intent/session implementation | §17.২ table: ২৮৭ + ১৮১ + ২৭৭ = ৭৪৫ লাইন | **OPEN** — একীভূত করতে behaviour/golden test; line count নয়, duplicate behaviour মাপা হবে |

### ১৭.৪ এই pass-এ যা বদলেছে (runtime)

| পরিবর্তন | আগে | এখন | প্রমাণ |
|---|---|---|---|
| Mission artifact cleanup | stream ও non-stream-এ হুবহু একই ৫-regex chain দুবার (২×~২৪ লাইন) | এক `stripMissionChatArtifacts()` helper | `api.js` helper definition; `node --check api.js` exit 0 |
| MCP forward log | api.js-এ `Set` + ১৭-লাইন block | `modules/mcp-protocol.js` `noteForwardProtocol()`; api.js ৫ লাইন | `MCP_API_INTEGRATION_OK` |
| Provider error scope | api.js-এ inline ১১-লাইন classifier | `lib/provider-failure.js` (১৯ লাইন), reusable + test | `PROVIDER_HEALTH_OK 17/17` |
| Chat entry log | routing-এর আগেই `REQUEST status:200` | `CHAT_ACCEPTED` (status নেই) | `api.js` chat entry |
| `PROVIDER_SKIP_DOWN` | প্রতি resolve-এ একই provider-এর জন্য ৫০+ লাইন | client+provider per-process একবার | live log আগে ৫৭৪/day; restart-এর পরে যাচাই বাকি |
| r2t default | absent → enabled, arbitrary `exec` | absent/false → disabled; exact `true` opt-in | `api.js:19457`; `R2T_TRACE_OK 15/15` |
| Panel test auth | `provider-panel-ops-check` bare token → 401 | `/admin/zombie` cookie bootstrap | `PROVIDER_PANEL_OPS_OK 18/18` |

### ১৭.৫ সীমা — যা এখনো প্রমাণিত নয়

- F22-এর exploitability test করা হয়নি (unauth mission দিয়ে shell চালানো হয়নি); এটি code-path audit, live exploit নয়।
- F21-এর enabled অবস্থায় exploit test করা হয়নি; `.env`-এ `false`, তাই live-এ শুধু `R2T_DISABLED` path যাচাই হয়েছে।
- `PROVIDER_SKIP_DOWN`-এর after-count (`574` histórico) restart-এর পরে বাড়েনি; তবে একটি provider সেই window-এ skip হয়েছে কিনা আলাদা করে ধরা হয়নি।
- F29/F30-এর migration হয়নি; এগুলো code-level decision, test नहीं।

### ১৭.৬ Live verification — ২০২৬-১১-২৬ ০০:৩৭ (+০৬)

`bash scripts/rebuild-restart.sh --restart` → `REBUILD_RESTART_OK`, source/dist sha `72decd3ad066…`। এরপর:

| Probe | ফল |
|---|---|
| `GET /health` | `HTTP 200`, `healthy:true`, `version:3.2.1`, uptime 8s |
| `POST /mcp` + `MCP-Protocol-Version: 2026-07-28` | `HTTP 200`, result `protocolVersion:2025-06-18`; log `MCP_PROTOCOL_FORWARD {requested:2026-07-28, negotiated:2025-06-18}` |
| `POST /mcp` + `MCP-Protocol-Version: 2026-13-99` | `HTTP 400`; `MCP_HEADER_REJECTED` — malformed date rejected |
| `POST /v1/chat/completions` model `r2t` | `R2T_DISABLED`; `R2T_ENABLED=false` (`.env:160`) |
| `POST /v1/chat/completions` model `gemini-2.5-pro` | `HTTP 502` upstream 404; log `PROVIDER_MODEL_SCOPED_FAILURE`; `PROVIDER_UNHEALTHY` count আগের ১-ই আছে, নতুন breaker trip নেই |
| `sha256sum api.js dist/api.js` | দুটোই `72decd3ad066…` |

**মন্তব্য:** row 7/8-এর source fix এখন live-verified। row 1-এর default opt-in code verified, কিন্তু `.env`-এ false থাকায় enabled exploitable path এখনো test করা হয়নি।

