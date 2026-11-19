# ADR-001 — api.js হবে COMPOSITION ROOT

**তারিখ:** 2026-11-20
**অবস্থা:** PROPOSED — কোনো code বদলানো হয়নি। এটা সিদ্ধান্তের রেকর্ড, কাজের অনুমতি নয়।
**প্রশ্ন (user):** প্রোভাইডার আর মডিউল আলাদা হয়ে গেছে, তাই না — api.js থেকে ওগুলো বাদ দিয়ে import করলে api.js আরও ক্লিন হবে না? নতুন করে লিখলেও মডিউলগুলো তো তৈরি আছে।

---

## 1. সংক্ষিপ্ত উত্তর

**হ্যাঁ, api.js composition root হওয়া উচিত।** কিন্তু “বাদ দিলেই ক্লিন” — এই ধারণাটা এখনকার কোডে সত্য নয়:

- **প্রোভাইডার লেয়ার ইতিমধ্যেই বাইরে এবং import করা** — `api.js:162-167` (`require("./provider")`, `transport`, `capabilities`, `tools`)। ওখানে বাদ দেওয়ার মতো কিছু নেই।
- **18টি module-এর মধ্যে 9টি api.js-এ import করা**; বাকি **7টির শূন্য importer** — ওগুলো “তৈরি” আছে, “যুক্ত” নেই।
- api.js-এ এখনো ওই 7টির **সমান্তরাল inline implementation** আছে (env loader, antiDote chain, intent prompt, watchdog, agent session, verify/compiler helpers)। তাই কাজটা “move” নয়, **“একটা সত্য বাছাই + অন্যটা মুছে ফেলা”**।

---

## 2. Verified বর্তমান অবস্থা

| জিনিস | পরিমাপ | প্রমাণ |
|---|---:|---|
| api.js | **19,804** lines | `wc -l api.js` |
| start.js | 1,054 lines | `wc -l start.js` |
| modules/ | 18 files, **3,886** lines | `wc -l modules/*.js` |
| provider/ | 13 files, 3,103 lines | `wc -l provider/*.js` |
| api.js → provider | 4 imports | `api.js:162-167` |
| api.js → modules | 9 imports | `api.js:118-123,130,3401,3402` |

### 2.1 প্রোভাইডার — ইতিমধ্যেই সম্পূর্ণ বাইরে

`api.js:162` → `require("./provider")` → `provider/index.js`। ওই ফাইল নিজেই ৬টি adapter (`openai`, `groq`, `gemini`, `ollama`, `opencode`, `llamacpp`), `validator`, `capabilities`, `tools` — সব লোড করে (`provider/index.js:23-32`)। মানে **provider/index.js-ই একমাত্র registry**, api.js শুধু call করে।

### 2.2 মডিউল — 9 of 18 যুক্ত, 7টি অনাথ

**যুক্ত (api.js import করে):**

| module | api.js line |
|---|---|
| `modules/mcp-protocol.js` | 118 |
| `modules/context.js` | 119 |
| `modules/system-prompt.js` | 120 |
| `modules/provider-models.js` | 121 |
| `modules/chat-interpreter.js` | 122 |
| `modules/project-memory.js` | 123 |
| `modules/system-identity.js` | 130 |
| `modules/syllabus.js` | 3401 |
| `modules/workspace.js` | 3402 |

**zero importers (শুধু নিজের ফাইল ছাড়া কেউ require করে না):**

`modules/agents.js`, `modules/compiler.js`, `modules/config.js`, `modules/goals.js`, `modules/intent.js`, `modules/verify.js`, `modules/watchdog.js`

**আলাদা হিসাব:**

- `modules/sessions.js` — শুধু `tests/modules-runtime-check.js` import করে; api.js নয়।
- `modules/data-prune.js` — `start.js` + `scripts/prune-data.js` ব্যবহার করে; api.js নয়।

---

## 3. api.js-এ থাকা inline duplicate

| Concern | api.js-এ inline | সমান্তরাল module | অবস্থা |
|---|---|---|---|
| Env/config | `.env` loader IIFE, `api.js:209-236`, `catch (_) { }` | `modules/config.js` (160) | দ্বিতীয় সত্য; fail-fast নয় |
| Goal + verify | `antiDote` chain `api.js:8536-9368` (~832 lines): `antiDoteSetGoalContract:8627`, `antiDoteVerifyOutput:8719`, `antiDoteMonitor:9168` | `modules/goals.js` (190) + `modules/verify.js` (86) | ভিন্ন contract |
| Intent | `INTENT_EXTRACT_PROMPT` `api.js:777`, LLM call `:7833` | `modules/intent.js` (255) | LLM বনাম keyword classifier |
| Agent session | `agent/index.js` থেকে `loadAgentFiles` (`api.js:115`) + inline session build | `modules/agents.js` (202) | API surface আলাদা |
| Watchdog | internal `setInterval`, `api.js:18125` | `modules/watchdog.js` (140) | দুটোই আছে |
| Verify helpers | Cross-Verification `api.js:19008`, Compiler Check `:19139` | `modules/verify.js`, `modules/compiler.js` | ভিন্ন নাম, একই কাজ |

---

## 4. কেন সরাসরি “বাদ” করা যাবে না

1. **Semantics আলাদা।** `modules/goals.js` নিজে `spawnSync` দিয়ে check চালায় এবং caller-এর `observed`/`exitCode` **উপেক্ষা করে**; api.js-এর `antiDote` chain একটা ধাপে-ধাপে যাচাই করা chain। দুটোকে একসাথে চালালে ফল দ্বিধা হবে; একটা মুছতে হবে — কিন্তু কোনটা, সেটা behavior decision।
2. **Test গুলো import string ধরে রাখে।** `tests/mcp-api-integration-check.js:348-350` api.js-এর ভেতরে `require("./modules/...")` খোঁজে; `tests/provider-env-lock-check.js:202` একই। Import সরালে test update করতে হবে, নাহলে false FAIL।
3. **লাইভ প্রসেস dist থেকে চলে।** `dist/api.js` আর `api.js`-এর sha256 এখন এক (runbook Appendix B)। Source বদলে rebuild + restart না করলে কিছুই বদলাবে না।
4. **api.js-এ শুধু business logic নয়, HTTP/WS server-ও আছে।** Bootstrap/routing বের করা আলাদা, বেশি ঝুঁকির axis — এই ADR-এ সেটা নেই।

---

## 5. সিদ্ধান্ত

1. **api.js = COMPOSITION ROOT।** এখানে থাকবে: env bootstrap, HTTP/WS server, route table, dependency wiring, shutdown। **কোনো business rule নয়।**
2. **modules/\* = এক concern, এক ফাইল।** api.js ওদের import করবে; module কখনো api.js import করবে না (cycle নিষিদ্ধ)।
3. **provider/\* = শুধু shape adapter।** সিদ্ধান্ত normalizer-এ, adapter-এ নয়। Registry একটাই — `provider/index.js`।
4. **ONE_TRUTH নিয়ম:** একই concern-এর দুটো implementation থাকলে একটা merge হবে বা delete হবে। “দুটোই রাখি” নিষিদ্ধ।

---

## 6. Extraction order — নিরাপদ থেকে ঝুঁকিপূর্ণ

| Step | কাজ | Behavior change? | Gate |
|---|---|---|---|
| 1 | 7 orphan module-এর decision table: কোনটা wire, কোনটা delete | না | `MODULE_DECISION_OK` |
| 2 | `modules/config.js` দিয়ে inline env loader প্রতিস্থাপন; `CONFIG_FATAL` + exit `78` | হ্যাঁ (fail-fast) | `CONFIG_CONTRACT_OK` |
| 3 | `goals.js` + `verify.js` দিয়ে antiDote chain প্রতিস্থাপন | হ্যাঁ (contract semantics) | `QUALITY_EVAL_OK` |
| 4 | `modules/agents.js` দিয়ে session build | না (আউটপুট এক রাখতে হবে) | `AGENT_SESSION_OK` |
| 5 | `modules/watchdog.js` দিয়ে internal interval | না | `WATCHDOG_OK` |
| 6 | `modules/compiler.js` দিয়ে compiler helpers | না | `COMPILER_OK` |

প্রতি step: এক commit, আগে/পরে line count, test output, gate marker। কোনো step fail করলে থামব।

**মাপা লাভ (estimate, প্রতিশ্রুতি নয়):** antiDote block ~832 lines → `goals.js` 190 + `verify.js` 86 = 276; net api.js **−~556 lines**। env/config বদলে line বাড়বে, কিন্তু correctness বাড়বে। মোট লাভ step-শেষে মাপব — এখন `UNVERIFIED`।

---

## 7. ঝুঁকি

- Migration-এর সময় দুটো সত্য একসাথে চললে bug ধরা কঠিন — তাই step-by-step, একটাই সত্য।
- `dist/` rebuild ভুলে গেলে “কিছু বদলায়নি” ভ্রম হবে।
- Test-এর hardcoded import string।
- এই refactor **performance বা tool-cap ঠিক করবে না** — ওগুলো Phase 5-এর কাজ; এটা শুধু রক্ষণাবেক্ষণযোগ্যতা।

---

## 8. পরের ধাপ

Step 1-এর decision table বানানো — ৭টি orphan module: কে import করবে, কীসের প্রতিদ্বন্দ্বী, wire না delete। কোনো code নয়, শুধু টেবিল + প্রমাণ।

তুমি **“শুরু করো”** বললে Step 1 দিয়ে শুরু করব।

Check marker: `APIJS_ADR_OK`

---

## 9. Execution record - 2026-11-20

All seven modules are imported by `api.js` and the matching implementations moved out.

| Module | Moved from api.js | New entry point |
|---|---|---|
| config | inline .env loader | `loadEnvFile` / `parseEnv` |
| intent | 3 prompt templates | `PROMPTS` from `modules/prompts/*.txt` |
| goals | antiDote contract lifecycle + `AntiDoteError` | `createContract`, `validateInput`, `checkProof`, `setGoalContract`, `executeContract` |
| verify | `antiDoteVerifyOutput` | `verifyContract` |
| compiler | `compilerCheck` + 5 helpers | `analyzeContent` |
| watchdog | inline heartbeat interval | `Watchdog.startHeartbeat` |
| agents | `loadPersonas` merge | `loadAgents` |

Measured: `api.js` 19,768 -> 18,807 lines (-961). The seven modules total 1,986 lines.

Proof: `BUILD_OK files=174 version=3.2.1`; `/health` healthy true; MCP `tools/list` 155 tools; MCP `tools/call read_file` returned 100,000 chars containing `modules/config.js`; `agent_single` returned `OK` through the antiDote chain; four test suites pass.

Remaining (not done, measured):
- `recommended_agents` policy tables in `api.js` still contain hardcoded agent ids.
- The HTTP router and mission orchestration remain in `api.js`.
- `schema-compile-check` 38 pass / 2 fail from commented dead keys in `.env` (pre-existing).

Marker: `MODULES_WIRED_REAL_OK`
