# প্রোভাইডার ও MCP অডিট — ২০২৬-১১-১৯

**অডিটর:** Tuhin — AIML & Model Auditor
**প্রজেক্ট:** `~/zombiebd` (Mission Barisal v3.2.1, runtime `dist/`)
**প্রমাণের সূত্র:** `logs/2026-11-19.log`, `logs/systemd-out.log`, `data/models.db` (`providers`, `provider_stats`, `request_log`, `agent_stats`), `api.js`, `provider/*.js`, `admin-api.js`, `external mcp/*`, live HTTP probe।

---

## 0. এক নজরে (TL;DR)

1. প্রোভাইডার তালিকার লাল লেখাগুলো **অধিকাংশই পুরোনো (`last_error`), বর্তমান অবস্থা নয়**। ৭টির মধ্যে ৫টি প্রোভাইডার এখন সাড়া দিচ্ছে; আসল সমস্যা তিনটি — (ক) `bridge`-এর ৬০ সেকেন্ড টাইমআউট, (খ) `groq`-এর ৮০০০ TPM লিমিট, (গ) মৃত মডেল নাম (`gemini-2.5-flash` এখন 404)।
2. `bridge` প্রোভাইডারের `timeout` সেট করা নেই, তাই `provider/transport.js`-এর ডিফল্ট **60000 ms** প্রযোজ্য; অথচ `ollama`-এর বাজেট `OLLAMA_TIMEOUT_MS=1200000` (২০ মিনিট)। একই `lfm3:1.7b` মডেলের জন্য bridge (priority 5) আগে চেষ্টা হয়, ৬০ সেকেন্ডে মরে, তারপর ollama (priority 6) সফল হয় — প্রতিটি টার্নে ৬০ সেকেন্ড নষ্ট।
3. এজেন্ট টুল কল না করার মূল কারণ **মডেল নয়, ক্যাটালগ কাটা**: সার্ভারে ১৫৫টি টুল আছে, কিন্তু `MAX_TOOLS_LIMIT = 25` (api.js:4922) প্রথম ২৫টি রাখে। `tts__tts_speak` আছে ৩৭ নম্বরে, `ocr__*` ২৯-এ, `public-api__*` ৪০+ — অর্থাৎ **কোনো এজেন্টই TTS/OCR/Public-API টুল পায় না**। bridge path-এ ক্যাপ আরও কঠিন: `maxTools = 5` (api.js:1170) — শুধু `read_file/write_file/set_working_dir/get_working_dir/web_search`।
4. `AGENT_FS_SCOPE=unrestricted` (`.env:33`) — তাই `read_file`, `write_file`, `delete_file`, `terminal`, `exec` কার্যত **পুরো হোম ডিরেক্টরি ও তার বাইরেও** কাজ করে। TTS নিজেই `~/zombie-tts`-এ লেখে, অর্থাৎ ওয়ার্কিং ডিরেক্টরির বাইরে।
5. `~/llm-heal.sh` **অন্য একটি স্ট্যাক** (`~/monu_the_builder`) পাহারা দেয় — `APP_DIR` ডিফল্ট `~/monu_the_builder`, bridge পোর্ট `11436`। zombiebd-এর ১১৪৩৫ bridge বা ৫০৫০ অ্যাপ এটি চেনে না। ফলে একই মেশিনে **দুই সেট bridge+app** চলছে এবং একই ollama-র CPU ভাগ করছে — এটাই টাইমআউট বাড়ানোর অন্যতম কারণ।

---

## 1. কীভাবে সিস্টেমটা চলে

```
start.js --start-all -s
 ├─ .env + lib/env.js  →  সব পোর্ট/কী এক জায়গা থেকে
 ├─ api.js (dist/api.js) → HTTP 127.0.0.1:5050, UDS data/run/mcp.sock (5052), WS, /mcp
 │   ├─ PROVIDER_CONFIG  ← .env + data/models.db (providers টেবিল)
 │   ├─ resolveProvider(model) — priority ascending (custom_1=1, groq=2, gemini=3,
 │   │                              bridge=5, ollama=6, ollama_cloud=7)
 │   ├─ callModel / callModelStream → provider adapters (openai/gemini/ollama)
 │   ├─ tool loop: model → tool_calls → executeTool → result ফেরত → আবার model
 │   └─ SQLite data/models.db: providers, models, agents, provider_stats, request_log
 └─ start-local-mcp.js → external mcp/servers.json
     ├─ ocr 3110 (4 tools)          ├─ screen-recorder 3111 (4)
     ├─ tts 3112 (3)                ├─ facebook-ads 3121 (29)
     ├─ public-api 3122 (29)        ├─ combined 3123 (58)
     └─ universal-adapter 5400 (158) ← main server থেকে ১৫৫ টুল mirror করে
```

মডেল রেজলভেশন: নাম → সব প্রোভাইডারের `models[]`-এ খোঁজ → সর্বনিম্ন priority জেতে। `lfm3:1.7b` দুই জায়গায় আছে (bridge ও ollama), তাই bridge আগে। `nvidia/nemotron-3.5-bolt-e4b` শুধু `custom_1`-এ, তাই সেটাই যায়।

টুল প্রবাহ: `/mcp` `tools/list` → ১৫৫ টুল → `sanitizeTools()` ২৫-এ কাটে → `provider/tools.prepare()` শুধু DB-র `supports_tools` দেখে, `maxTools` **দেখে না** → adapter wire-format বানায়। মডেল `tool_calls` ফিরিয়ে দিলে `executeTool()` চালায়, ফলাফল `role:"tool"` হয়ে আবার পাঠায়।

---

## 2. প্রোভাইডার এরর — পয়েন্ট বাই পয়েন্ট

ডেটা: `data/models.db` → `provider_stats` (2026-11-19 12:45 পর্যন্ত)।

| provider | req | err | OK% | শেষ error | কখন | বর্তমান অবস্থা (live probe) |
|---|---:|---:|---:|---|---|---|
| custom_1 (zombie-gateway) | 156 | 9 | 94% | `network_error: request timeout` | 2026-11-16 06:38 | **OK** — `/v1/models` 200, chat 0.55s |
| groq | 17 | 1 | 94% | `http_413: Request too large … TPM Limit 8000, Requested 29437` | 2026-11-16 06:40 | **OK** — `/models` 200, 8-token chat 0.74s |
| gemini | 12 | 3 | 75% | `network_error: request timeout` | 2026-11-16 06:50 | **আংশিক** — key OK, কিন্তু `gemini-2.5-flash` = 404 "no longer available"; `gemini-3.5-flash` = 200 |
| opencode | 0 | 0 | — | — | — | **বন্ধ** — `OPENCODE_ENABLED=false`, 0 মডেল, admin-এ "env locked" |
| bridge | 3 | 2 | 33% | `network_error: request timeout` | 2026-11-19 12:32 | **OK কিন্তু ধীর** — `/v1/models` 200; ৮ টোকেন ৩.৮s; আসল প্রম্পটে ৬০s টাইমআউট |
| ollama | 30 | 0 | 100% | — | — | **OK** — `/api/tags` 200, `lfm3:1.7b`, `deepseek-r1:1.5b` |
| ollama_cloud | 1 | 1 | 0% | `http_402: Add usage credits or subscribe` | 2026-11-16 04:55 | **FAIL** — অ্যাকাউন্টে ক্রেডিট নেই |

### 2.1 `custom_1` / zombie-gateway — "network error: request timeout"

- endpoint: `http://127.0.0.1:5010/v1`, UDS `/tmp/gateway.sock`; বাস্তবে **zombie-gateway** প্রসেস (pid 1365) 5010 ও 5011-এ শোনে।
- ৯টি error-এর সবই পুরোনো (2026-11-15/16), সেগুলো ছিল gateway-এর নিজের upstream (NVIDIA integrate API) 502/timeout।
- এখন probe: `/v1/models` 200 (৩৯ মডেল), `nvidia/nemotron-3.5-bolt-e4b` chat 0.546s। **বর্তমানে সুস্থ।**
- `.env`-এ `CUSTOM_PROVIDER_1_URL` **দুইবার** আছে (`https://integrate.api.nvidia.com/v1` তারপর `http://127.0.0.1:5010/v1`); `lib/env.js:82` last-wins, তাই লোকাল gateway জেতে। কিন্তু এই ডুপ্লিকেট কী-ই (মোট ৭টি ডুপ্লিকেট key) ভবিষ্যতে বিভ্রান্তির কারণ।

### 2.2 `groq` — HTTP 413, "Request too large"

- provider_stats-এ সংরক্ষিত মেসেজ: `TPM: Limit 8000, Requested 29437` (2026-11-16 06:40)।
- অর্থ: ফ্রি টিয়ারে প্রতি মিনিটে ৮,০০০ টোকেন, কিন্তু একটি অনুরোধেই ২৯,৪৩৭ টোকেন গেছে (২৫টি টুল ≈ ১১.৪ KB ≈ ২,৮৫৭ টোকেন + ৩.৮ KB system prompt + ইতিহাস)।
- probe: সাধারণ ৮-টোকেন chat 200 (73 prompt tokens)। অর্থাৎ key ঠিক, **শুধু বড় প্রম্পটে 413**।
- ফিক্স: Groq-এর জন্য টুল ক্যাপ কমাও (৫-৮), ইতিহাস ছোট করো, অথবা Dev Tier।

### 2.3 `gemini` — timeout + মৃত মডেল

- live প্রমাণ: `models/gemini-2.5-flash:generateContent` → **404**,
  `"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash"`।
- অথচ DB/`.env`-এর মডেল তালিকায় `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-flash-latest` এখনো আছে; `team-heart` এজেন্ট `gemini-flash-latest`-এ বাঁধা এবং `agent_stats`-এ ৩ error।
- `gemini-3.5-flash` probe → 200 (0.9s)। অর্থাৎ key সঠিক, **মডেল নাম পুরোনো**।
- ৩টি `network_error: request timeout` (2026-11-16) — ওই সময়ে 502/121s এন্ট্রি `request_log`-এ আছে; HTTP/2 fallback + ৬০s ডিফল্ট টাইমআউটের সমন্বয়।

### 2.4 `opencode` — "Off / env locked"

- `OPENCODE_ENABLED=false`, `OPENCODE_MODELS=` খালি, তাই ০ মডেল। এটি **কনফিগ অনুযায়ী বন্ধ**, ত্রুটি নয়। UI-তে "env locked" ঠিকই দেখাচ্ছে।

### 2.5 `bridge` — আসল স্মোকিং গান

- `PROVIDER_CONFIG.bridge`-এ `timeout` নেই (api.js:1156-1171) → `provider/transport.js:26` `DEFAULT_TIMEOUT = 60000`।
- একই `lfm3:1.7b`-এর জন্য `ollama`-র বাজেট `OLLAMA_TIMEOUT_MS=1200000` (২০ মিনিট), অথচ bridge-এর ৬০ সেকেন্ড — **একই মডেল, দুই বাজেট**।
- 로그: `2026-11-19T06:32:46.151Z [PROVIDER_FALLBACK] {"from":"bridge","to":"ollama","error":"request timeout"}`; ঠিক আগের লাইনে `CHAT label=CHAT provider=bridge model=lfm3:1.7b ms=60008`.
- `request_log`: bridge-এ একটি অনুরোধ HTTP 200 পেয়েও `elapsed_ms=370196` (৬ মিনিট ১০ সেকেন্ড) এবং `ok=0` — অর্থাৎ ৬ মিনিট পরেও উত্তরটি ব্যবহারযোগ্য হয়নি।
- bridge-এর নিজের upstream discovery প্রতি ১৫ সেকেন্ডে ৮-৯টি ডেড পোর্ট probe করে (`localhost:8080`, `:3000`, `:1234`, `:8000`, `:9999` …), লগে প্রতি সাইকেলে WARN — কনফিগে অপ্রয়োজনীয় upstream তালিকা।
- গাণিতিক প্রমাণ নিচে §6।

### 2.6 `ollama` — ১০০% OK

- `/api/tags`: `lfm3:1.7b` (capabilities: completion, tools, thinking), `deepseek-r1:1.5b` (tools, thinking, completion)।
- ৩০টি অনুরোধ, ০ error। `OLLAMA_TIMEOUT_MS=1200000` থাকায় লম্বা prefill-ও শেষ হয়।

### 2.7 `ollama_cloud` — HTTP 402

- `Add usage credits or subscribe …` — অ্যাকাউন্টে ক্রেডিট নেই। `ollama_cloud`-এর ২৪টি মডেল (kimi-k3, glm-5.3, gpt-oss:120b …) তাই কার্যত অব্যবহারযোগ্য।
- অথচ `agent_stats`-এ `team-heart`/`doc-king` একসময় এই প্রোভাইডারে ছিল; এখন DB-তে `lfm3`/`deepseek-r1`-এ বাঁধা।

### 2.8 "Online" অথচ লাল error — UI/state বাগ

`providerSummary()` (api.js:2010-2050) `healthy` নেয় `isProviderHealthy()` থেকে। `PROVIDER_HEALTH` (api.js:12933) একটি **ইন-মেমরি** ম্যাপ, বুটে খালি; `getProviderHealth()` ডিফল্ট `healthy: true` (api.js:12941-12952)। ফলে:

- রিস্টার্টের পর সব প্রোভাইডার "Online" দেখায়, যদিও DB-তে পুরোনো `last_error` আছে;
- একবার `healthy=false` হলেও `RECOVERY_COOLDOWN_MS=60000` (৬০s) পরে আবার `true` হয়ে যায় (api.js:12994-13013) — ব্যর্থ প্রোভাইডারও প্রতি মিনিটে "Online" হয়ে ওঠে;
- `last_error` কখনো মোছা হয় না (`markProviderSuccess` শুধু in-memory `lastError` null করে, api.js:12955-12964)।

তাই স্ক্রিনশটের "Online + network error" একসাথে দেখা যায়। **status কলাম আসল স্বাস্থ্য নয়, optimistic ডিফল্ট।**

---

## 3. এজেন্টরা টুল কল করতে পারে না কেন

### 3.1 ১৫৫ → ২৫ → ৫: ক্যাটালগ কাটা

- `tools/list` (live): মোট **১৫৫** টুল — native ২৮, ocr ৪, screen-recorder ৪, **tts ৩**, facebook-ads ২৯, public-api ২৯, combined ৫৮।
- `MAX_TOOLS_LIMIT = 25` (api.js:4922); `sanitizeTools()` শুধু `slice(0,25)` (api.js:4941-4953)। লগ: `TOOLS_CAPPED {"original":155,"capped":25}` (2026-11-19 06:31:46)।
- প্রথম ২৫টি: `read_file … exec, http_request` — অর্থাৎ **`env_get` (26), `system_info` (27), `remote_mcp_call` (28), সব OCR (29-32), সব TTS (33-39), facebook-ads, public-api, combined কিছুই মডেলের কাছে পৌঁছায় না**।
- `tts__tts_speak` индекс **৩৭** — তাই এজেন্টকে "অডিও বানাও" বললে সে টুলটাই দেখে না; টেক্সটে উত্তর দেয় বা ভুল টুল বেছে নেয়।
- bridge path: `capabilities.maxTools = 5` (api.js:1170), single-agent stream-এ `Math.min(25, agentCaps.maxTools)` (api.js:16281) → **৫টি টুল**। `provider/tools.prepare()` (provider/tools.js:122) `maxTools` একেবারেই প্রয়োগ করে না, শুধু `supports_tools` দেখে — তাই non-stream path-এ bridge ২৫টাই পায়, stream path-এ ৫টি। **একই প্রোভাইডারের দুই রকম ক্যাটালগ = nondeterministic আচরণ।**

### 3.2 মডেলের সীমা (probe-প্রমাণিত)

- `lfm3:1.7b` **পারে**: ২টি টুল দিয়ে probe → সঠিক `tool_calls:[{name:"get_working_dir"}]`, ৪৭ টোকেন ৮.৩s।
- কিন্তু ২৫টি টুল = ১১,৪২৮ বাইট ≈ ২,৮৫৭ টোকেন; system prompt ৩,৮৯৮ অক্ষর ≈ ৯৭৫ টোকেন; মোট ~৪,০০০+ টোকেন prefill। মাপা গতি: ১১০ টোকেন prefill = ৩.৬s (~৩০ tok/s) → **৪,০০০ টোকেন ≈ ১৩০-১৫০s**, যা bridge-এর ৬০s-এ শেষ হয় না।
- ফল: `TOOL_LOOP_NO_TOOL_CALLS {"round":0,"content_length":332}` — মডেল টুল না ডেকে প্লেইন টেক্সট দিয়েছে; লুপ শেষ।
- `deepseek-r1:1.5b` reasoning মডেল; টুল সাপোর্ট থাকলেও ছোট ক্যাটালগে reasoning টোকেন বাজেট খেয়ে ফেলে।

### 3.3 অন্যান্য কারণ

- `provider/tools.prepare()`-এ `supports_tools` DB-তে **NULL** (bridge/ollama/gemini rows) → "unknown ⇒ allow" (provider/tools.js:110-118)। অর্থাৎ capability gate কার্যত খোলা; ভুল মডেলেও টুল পাঠানো হয়।
- non-stream `callModel()` path-এ provider `maxTools` নেই (শুধু stream path-এ); একই অনুরোধ stream/non-stream-এ ভিন্ন টুল তালিকা পায়।
- টুল ফলাফল ফেরানো হয় `role:"tool"` হিসেবে; মডেল প্রথম রাউন্ডে টুল না ডাকলে `callModelWithTools()` (api.js:7209-7267) সাথে সাথে শেষ করে — retry/nudge নেই।
- MCP `tools/call` নিজে **কাজ করে** (নিচে §7), তাই সমস্যা ট্রান্সপোর্টে নয়, ক্যাটালগ/মডেল-সিদ্ধান্তে।

---

## 4. লগ প্রমাণ — টাইমলাইন (2026-11-19, UTC)

| সময় | লগ | অর্থ |
|---|---|---|
| 06:02:43 | `IDENTITY_LOAD_FAIL … dist/identity.json ENOENT` | runtime `dist/`-এ identity.json নেই (কসমেটিক, boot ব্যর্থ নয়) |
| 06:31:46 | `TOOLS_CAPPED {"original":155,"capped":25}` | ১৩০ টুল বাদ |
| 06:32:43 | `SYSTEM_PROMPT_BUILT {"agent":"code-guru","chars":3898}` | persona+SSOT+syllabus |
| 06:32:46 | `CHAT … provider=bridge model=lfm3:1.7b ms=60008 ok=false error=request timeout` | bridge ৬০s |
| 06:32:46 | `PROVIDER_FALLBACK {"from":"bridge","to":"ollama"}` | একই মডেল ollama-তে |
| 06:33:01 | `SINGLE_AGENT_STREAM_COMPLETE {"contentLength":99,"elapsed":1201}` | stream path (৫ টুল) দ্রুত সফল |
| 06:34:14 | `TOOL_LOOP_NO_TOOL_CALLS {"round":0,"content_length":332}` | মডেল টুল ডাকেনি |
| 06:34:14 | `SINGLE_AGENT_COMPLETE {"elapsed":148004}` | ১৪৮ সেকেন্ডে একটি উত্তর |

`request_log`-এ provider × status: custom_1 200=141, 502=5; ollama 200=30; groq 200=13; bridge 200=5; gemini 200=3, 502=2; ollama_cloud 502=1। **HTTP 200 হলেও `ok=0`** অনেক এন্ট্রি (টুল-লুপ ব্যর্থতা), তাই শুধু status কোড দেখে স্বাস্থ্য মাপা যায় না।

---

## 5. কোড-লেভেল ত্রুটি (file:line)

| # | ফাইল:লাইন | ত্রুটি | প্রভাব |
|---|---|---|---|
| 1 | `api.js:1156-1171` | bridge-এ `timeout` সেট নেই | ৬০s ডিফল্ট, প্রতিটি টার্নে টাইমআউট |
| 2 | `api.js:4922` | `MAX_TOOLS_LIMIT=25` | TTS/OCR/Public-API অদৃশ্য |
| 3 | `api.js:4941-4953` | `slice(0,25)` — priority/needs-based নয় | প্রথম ২৫টি "দৈবক্রমে" নির্বাচিত |
| 4 | `api.js:1170` + `provider/tools.js:122` | `maxTools` ঘোষিত কিন্তু প্রয়োগহীন | bridge-এ ৫ vs ২৫ অসঙ্গতি |
| 5 | `api.js:12933-13013` | in-memory health, optimistic default, ৬০s auto-recover | "Online" মিথ্যা, `last_error` চিরস্থায়ী |
| 6 | `api.js:12955-12964` | success-এ DB `last_error` clear হয় না | পুরোনো লাল লেখা থেকে যায় |
| 7 | `.env` (৭টি ডুপ্লিকেট key) | `CUSTOM_PROVIDER_1_*` দুইবার | last-wins; ভুল এডিটে silent change |
| 8 | DB `models` | `gemini-2.5-*` মৃত মডেল | 404/502, এজেন্ট ব্যর্থ |
| 9 | `api.js:10115` `IDENTITY_LOAD_FAIL` | `dist/identity.json` নেই | কসমেটিক |
| 10 | `external mcp/servers.json` নোট | combined "71 tools" → বাস্তবে ৫৮ | ডক অমিল |
| 11 | `start-local-mcp.js` হেডার | পোর্ট ডিফল্ট 3100/3101/3102 লেখা, বাস্তবে 3110/3111/3112 | ডক অমিল |

---

## 6. গাণিতিক প্রমাণ: কেন ৬০ সেকেন্ডে টাইমআউট

```
২৫টি টুলের JSON                = 11,428 bytes ≈ 2,857 tokens
system prompt (persona+SSOT+syllabus) = 3,898 chars ≈   975 tokens
user + ইতিহাস                            ≈ 300-800 tokens
------------------------------------------------------------
मोटামुটি prefill                          ≈ 4,000-4,600 tokens

মাপা prefill গতি (lfm3:1.7b, CPU i3-4130) = 110 tokens / 3.60s ≈ 30.5 tokens/s
তাহলে 4,300 tokens ≈ 141 সেকেন্ড  >>  bridge timeout 60 সেকেন্ড
```

এবং এটাই ঘটেছে — `request_log`: bridge-এর একটি অনুরোধ 370196ms নিয়েও `ok=0`। ৬০s-এ কেটে ফেলা হয়, তারপর ollama-তে আবার পুরো প্রম্পট প্রসেস হয় (দ্বিগুণ কাজ, দ্বিগুণ CPU)।

**ফিক্স (সরাসরি প্রমাণ-ভিত্তিক):**
1. `BRIDGE_TIMEOUT_MS=600000` (বা bridge বাদ দিয়ে priority-তে ollama-কে আগে নাও) — একই মডেল দুইবার চালানো বন্ধ।
2. টুল ক্যাপ `slice` নয়, **relevance/allowlist** — এজেন্টের দরকারি টুল আগে; অথবা `tools: "mcp"` চাইলে পূর্ণ ১৫৫।
3. `provider/tools.prepare()`-এ `Math.min(caps.maxTools, tools.length)` প্রয়োগ করো — দুই path এক হও।
4. health state DB-backed করো; `last_error` success-এ clear করো; status-এ `last_used`/`last_error_at` দেখাও।

---

## 7. MCP — বাস্তবে কোনটা চলে (live probe, 2026-11-19 12:5x)

| সার্ভার | পোর্ট | tools | probe | অবস্থা |
|---|---|---:|---|---|
| main (`/mcp`) | 5050 | 155 | `tools/list` 200, 60,676 bytes | **চালু** |
| ocr | 3110 | 4 | `tools/list` 200 | **চালু** |
| screen-recorder | 3111 | 4 | 200 | **চালু** |
| tts | 3112 | 3 | 200; `tts_speak` আসল ফাইল বানাল | **চালু ও প্রমাণিত** |
| facebook-ads | 3121 `/mcp` | 29 | 200 | **চালু** (ক্রেডেনশিয়াল-নির্ভর) |
| public-api | 3122 `/mcp` | 29 | 200 | **চালু** |
| combined | 3123 `/mcp` | 58 | 200 | **চালু** |
| universal-adapter | 5400 `/mcp` | 158 | 200; main-sync প্রতি ৩০s `SYNC_OK tools=155` | **চালু** |

**প্রমাণিত কাজ:** `tts__tts_speak` main `/mcp` দিয়ে চালিয়ে `probe.mp3` (২০ KB, ৩.৪৬s অডিও) তৈরি হয়েছে — voice `bn-BD-NabanitaNeural`, ১.৮s। লগে `MCP_CALL` প্রমাণ: `get_working_dir`, `read_file`, `write_file`, `delete_file`, `memory_recent` সফলভাবে চলেছে (2026-11-16/17)। `main-sync` লগ: `SYNC_OK url=http://localhost:5050/mcp tools=155`।

**নোট:** `universal-adapter`-এর ১৫৮ টুল main ক্যাটালগে **নেই** (main-এ ১৫৫ = ২৮ native + ৪+৪+৩+২৯+২৯+৫৮), কারণ adapter নিজেই main থেকে mirror করে — recursion এড়াতে বাদ। ফলে adapter-এর নিজস্ব ৯টি sandboxed টুলও এজেন্ট পায় না।

---

## 8. ওয়ার্কিং ডিরেক্টরির বাইরে কোন টুল কাজ করে

`AGENT_FS_SCOPE=unrestricted` (`.env:33`; কোড api.js:10992-10999) — তাই:

| টুল | path সীমা | বাইরে কাজ করে? | প্রমাণ |
|---|---|---|---|
| `read_file`, `write_file`, `delete_file`, `rename_file`, `list_directory` | `isPathSafe()` → unrestricted | **হ্যাঁ, যেকোনো path** | api.js:10991-10999 |
| `set_working_dir` | root বদলায় | **হ্যাঁ** | api.js:15155 |
| `terminal`, `exec`, `http_request`, `db_query` | কোনো FS সীমা নেই | **হ্যাঁ** | api.js tool switch |
| `tts__tts_speak` | নিজের output dir `~/zombie-tts` | **হ্যাঁ** (custom `output`-ও) | logs/local-mcp-tts.log; probe |
| `ocr__*`, `screen-recorder__*` | নিজেদের output dir | **হ্যাঁ** | servers.json |
| `missionbarisal_*` (external MCP surface) | allowed root = workspace | **না** — path policy deny করে | plugin path policy |
| `universal-adapter` নিজস্ব ৯ টুল | adapter-এর sandbox | আংশিক | adapter README |

অর্থাৎ "working directory-র বাইরে" প্রশ্নের উত্তর: **নেটিভ ফাইল/শেল/HTTP/TTS সবই বাইরে পারে**, কারণ sandbox ডিফল্টেই বন্ধ। এটি নিরাপত্তার দিক থেকে ঝুঁকি — একটি prompt injection পুরো হোম ডিরেক্টরি মুছতে পারে। `AGENT_FS_SCOPE=restricted` করলে workspace+`$HOME`-এ সীমিত হবে (api.js:11000-11021)।

---

## 9. `~/llm-heal.sh` — কীভাবে কাজ করে

**উদ্দেশ্য:** লোকাল LLM স্ট্যাক (ollama → bridge → app) জীবিত রাখা ও ভাঙা অবস্থা থেকে ফিরিয়ে আনা।

```
ACTION: status | once | start | watch | stop | install | uninstall
ডিফল্ট: APP_DIR=$HOME/monu_the_builder, ENV_FILE=$APP_DIR/.env,
        BRIDGE_PORT=11436, MONU_PORT=5000, OLLAMA_PORT=11434,
        BRIDGE_SOCKET=/tmp/local-llm.sock, CHECK_INTERVAL=60s
```

- **কনফিগ লোড:** `.env` কে `source` করে না (ডেটা, কোড নয়); শুধু `BRIDGE_*`, `OLLAMA_*`, `LLAMA_*` key export করে, ইনলাইন কমেন্ট কাটে (llm-heal.sh:104-140)।
- **probe:** `http_ok` (curl 2xx), `port_listening` (ss), `socket_ok` (UDS `/v1/models`), `gen_ok` (আসল ৪-টোকেন chat) — শুধু listener নয়, **ইঞ্জিন উত্তর দেয় কি না** দেখে (llm-heal.sh:145-175)।
- **watch loop:** ৬০s পরপর `check_all`; ব্যর্থ হলে `heal()` ৩ বার: `ensure_ollama` → `ensure_bridge` → `ensure_app`; সফল হলে `check_all` আবার (llm-heal.sh:428-470)।
- **bridge ownership:** `pgrep -f local-llm-bridge.js` + `/proc/<pid>/exe` node কিনা + cmdline/cwd মিলিয়ে শুধু **নিজের** bridge মারে; foreign bridge (zombiebd-এর ১১৪৩৫) ছোঁয় না (llm-heal.sh:197-230)।
- **socket race:** stale socket থাকলে এবং kernel-এ listener না থাকলে `rm -f`, তারপর নতুন bridge (llm-heal.sh:300-320)।
- **systemd:** `install` → `~/.config/systemd/user/llm-heal.service`, `Restart=always`, `ExecStart=/usr/bin/env bash ~/llm-heal.sh watch` (llm-heal.sh:505-530)। বর্তমানে **active** (pid 813, 12:02 থেকে), প্রতি মিনিটে `check: healthy`।
- **বর্তমান বাস্তবতা:** এই স্ক্রিপ্ট **monu_the_builder**-এর জন্য, zombiebd-এর জন্য নয়। ফলে একই ollama-তে দুই bridge (11435, 11436) + দুই app (5050, 5000) চলছে; `free -h` → 15.5 GB-র মধ্যে 5.9 GB used, load average 2.6/4 core। CPU প্রতিযোগিতা bridge টাইমআউটকে আরও খারাপ করে।
- **লগ:** `$XDG_STATE_HOME/llm-heal/heal.log`; কিন্তু 2026-11-19 12:51-এ দেখা গেল `~/.local/state/llm-heal/` **ডিরেক্টরিটাই নেই**, অথচ সার্ভিস active — `mkdir -p` শুধু startup-এ, তাই পরে ডিরেক্টরি মুছে গেলে `log()` চুপচাপ ব্যর্থ হয় (`2>/dev/null || true`)। watchdog এখন systemd journal-এ লেখে, ফাইলে নয়।

**সিদ্ধান্ত:** heal স্ক্রিপ্ট নিজে ঠিক আছে, কিন্তু (ক) ভুল APP_DIR ডিফল্ট, (খ) duplicate stack, (গ) state ডিরেক্টরি হারানো — এই তিনটি অপারেশনাল ঝুঁকি।

---

## 10. ঝুঁকি ও ফিক্স অগ্রাধিকার

| অগ্রাধিকার | কাজ | কেন |
|---|---|---|
| P0 | bridge-এর `timeout` ৬০০s করুন বা priority-তে ollama-কে আগে দিন | প্রতিটি টার্নে ৬০s অপচয় + ডাবল CPU |
| P0 | টুল ক্যাপ relevance/allowlist-ভিত্তিক করুন; TTS/OCR অন্তর্ভুক্ত করুন | এজেন্টের আসল কাজই হচ্ছে না |
| P1 | `provider/tools.prepare()`-এ `maxTools` প্রয়োগ | stream/non-stream অসঙ্গতি |
| P1 | মৃত মডেল নাম সরান (`gemini-2.5-*`) | 404/502 |
| P1 | Groq-এর জন্য ছোট ক্যাটালগ/প্রম্পট | 413 TPM |
| P2 | provider health DB-backed; status-এ `last_error_at` | ভুল "Online" |
| P2 | `.env` ডুপ্লিকেট key পরিষ্কার | silent misconfig |
| P2 | heal স্ক্রিপ্ট zombiebd-এর জন্য আলাদা instance বা APP_DIR ফিক্স | duplicate stack |
| P3 | `AGENT_FS_SCOPE=restricted` বিবেচনা | prompt-injection ঝুঁকি |
| P3 | `dist/identity.json` সিঙ্ক | boot warning |

---

## 11. যাচাই কমান্ড

```bash
# provider health (live)
curl -s http://127.0.0.1:5050/health | jq .
sqlite3 data/models.db "select provider,requests,errors,last_error from provider_stats;"

# bridge latency
time curl -s http://127.0.0.1:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"lfm3:1.7b","messages":[{"role":"user","content":"Say OK"}],"max_tokens":8}'

# tool catalog ও ক্যাপ
curl -s -X POST http://127.0.0.1:5050/mcp -H "authorization: Bearer $MCP_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools | length'

# tts (প্রমাণিত)
curl -s -X POST http://127.0.0.1:5050/mcp -H "authorization: Bearer $MCP_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tts__tts_speak","arguments":{"text":"পরীক্ষা"}}}'

# heal
~/llm-heal.sh status --verbose
```

---

## 12. পুনঃযাচাই — ২০২৬-১১-২৫ (live)

**কেন:** §1–§10 হলো 2026-11-19-এর audit। এরপর P0-01/P0-07/P0-08 ও Monu retirement বাস্তবে বদলেছে; এই section পুরোনো finding-গুলোর বর্তমান অবস্থা বলে। যেখানে §1–§10-এর সঙ্গে অমিল, এখানেই সত্য।

| Finding (2026-11-19) | 2026-11-25 অবস্থা | প্রমাণ |
|---|---|---|
| `MAX_TOOLS_LIMIT=25` slice, TTS/OCR অদৃশ্য | **FIXED** — `lib/tool-budget.js` একমাত্র resolver; `MCP_TOOL_BUDGET_MAX=24`, pinned `tts__tts_speak,ocr__ocr_image` | `node tests/tool-budget-check.js` → `35/35 TOOL_BUDGET_OK` |
| `provider/tools.prepare()` `maxTools` মানে না | **FIXED** — `capTools()` একই সীমা দুই path-এ প্রয়োগ করে | একই test: `prepare(capped) caps at 5` |
| bridge-এর 60s ডিফল্ট, ollama 20 মিনিট | **FIXED** — `lib/provider-timeout.js` এক bridge deadline; gateway = upstream + grace | `node tests/bridge-timeout-check.js` → `BRIDGE_TIMEOUT_OK` |
| provider health optimistic `healthy:true`, পুরোনো error | **FIXED** — `unknown → up/degraded/down`, probe timestamp + error clear | `node tests/provider-health-honesty-check.js` → `PROVIDER_HEALTH_OK`; live `/health.providers` |
| Monu দ্বিতীয় stack + `llm-heal` watchdog | **REMOVED** — unit নেই, 5000/11436 বন্ধ, retired copy | `systemctl --user is-active llm-heal` → `inactive`; `ss -ltnp` |
| Gemini মৃত মডেল `2.5-*` | **OPEN (তথ্য হালনাগাদ)** — catalog-এ এখনো পুরোনো নাম; 2.5 → 502 retired, `3.5-flash` কাজ করে কিন্তু মাঝে মাঝে 503 high-demand | `curl` 2.5 → `no longer available`; uds-e2e Gemini response |
| Groq 8000 TPM, বড় prompt-এ 413 | **OPEN** — 24-tool budget-এ ছোট prompt ঠিক, কিন্তু বড় ইতিহাস/টুলে 413 হতে পারে | এই pass-এ বড় prompt দিয়ে re-probe করা হয়নি |
| `AGENT_FS_SCOPE=unrestricted` | **OPEN (P3)** — ইচ্ছাকৃত; prompt-injection ঝুঁকি জানা | `.env:33`, api.js path guard |

### 12.1 নতুন finding — intent ranking requested tool বাদ দিচ্ছিল

§3-এর মূল diagnosis (ক্যাটালগ কাটা) ঠিক ছিল, কিন্তু 24-tool budget-এর পরেও একটি দ্বিতীয় bug ছিল: `lib/tool-budget.js`-এর `scoreTool()` নাম-মিল আর description-মিলকে সমান ওজন দিত। ফলে লম্বা description-ওয়ালা `browse_cdp`, `read_ssot` ইত্যাদি "use the read_file tool … list_directory" অনুরোধে আসল `read_file`/`list_directory`-এর আগে বসে যেত; প্রতি call-এ মাত্র ৫টি tool fit করত, তাই মডেল টুল দুটোই পেত না এবং "tools are not available" উত্তর দিত।

**Fix (2026-11-25):** নামের মিলে ৫ গুণ ওজন, পুরো tool-name-এর exact match-এ +২০; wrapper (`universal-adapter__*`) এখন canonical টুলের নিচে। নতুন regression check: "explicit tool name outranks description keyword noise"।

**Live proof:** একই `code-guru` অনুরোধে আগে `TOOL_BUDGET sent=5` (read_file নেই) → এখন `sent=10` (`read_file`, `list_directory` সহ), মডেল ফাইল পড়ে `ZC-live777` ফিরিয়ে দিল। `node tests/uds-e2e-check.js` → `27 pass / 0 fail / 1 skip` (`UDS E2E PASS`)।

### 12.2 বর্তমান snapshot (live)

| Field | Value |
|---|---|
| Gateway / version | `5050` healthy, `3.2.1` |
| Models / agents | `591` / `9` |
| MCP tools | `101` (`tools/list`) |
| Enabled providers | 13; probe-ভিত্তিক `up` শুধু `custom_3`; `gemini` degraded (503); বাকি `unknown` |
| Dist | source `api.js` == `dist/api.js` (`9314b489…`) |
| Edge | `https://127.0.0.1/health` → `200`; একটাই vhost |

**যাচাই কমান্ড:** `node tests/tool-budget-check.js`, `node tests/provider-health-honesty-check.js`, `node tests/uds-e2e-check.js`, `curl -s http://127.0.0.1:5050/health`।
**অডিও:** `~/Music/mp3/zbd/today/` — এই রিপোর্টের বাংলা narration, Edge TTS (`bn-BD-NabanitaNeural`)। MCP `tts__tts_speak` পথটি `probe.mp3` দিয়ে প্রমাণিত; পূর্ণ narration-টি একই Edge TTS ইঞ্জিন/ভয়েসের Python API দিয়ে তৈরি, কারণ CLI intermittently `NoAudioReceived` (service throttle) দেয় এবং MCP wrapper-এর 60s cap-এ লম্বা চাঙ্ক মারে।
