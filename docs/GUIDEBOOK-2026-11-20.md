# GUIDEBOOK — জম্বি বিডি গেটওয়ে

**তারিখ:** 2026-11-20
**অবস্থা:** GUIDEBOOK v1 — **কাজ শুরু হয়নি**। এই কিতাবে কোনো code, DB বা service বদলানো হয়নি; শুধু প্রমাণ, ব্যাখ্যা আর পরিকল্পনা।
**সঙ্গে:** বাংলা narration অডিও — `~/Music/mp3/zbd/today/zbd-guidebook-2026-11-20.mp3`।

---

## 0. এক নজরে

| প্রশ্ন | উত্তর (verified) |
|---|---|
| গেটওয়ে চলছে? | হ্যাঁ — `GET 127.0.0.1:5050/health` → `healthy:true`, `version:3.2.1`, `models:96`, `agents:9` |
| প্রসেস | pid `827`, `dist/start.js`, node `v24.22.2`, uptime ~11 ঘণ্টা |
| MCP টুল কতটা? | সার্ভারে **155**টি, কিন্তু এজেন্ট দেখে **25**টি (`api.js:4922`) |
| TTS কাজ করে? | হ্যাঁ — `tts__tts_speak` দিয়ে আসল MP3 তৈরি হয়েছে (probe `20 KB`, `3.46s`) |
| ওয়ার্কিং ডিরেক্টরির বাইরে চলে? | হ্যাঁ — `AGENT_FS_SCOPE=unrestricted` (`.env:33`) |
| Monu Builder? | retire — ports `5000/11436` বন্ধ, dir `monu_the_builder.retired-2026-11-19` |
| OpenCode provider? | কোড আছে, DB-তে model `0`, `.env`-এ disabled (free tier শুধু client-এ) |
| Edge? | Caddy → `127.0.0.1:5050`; DNS/Cloudflare শর্ত নয় |
| কাজ শুরু হয়েছে? | **না** — `git tag pre-single-truth*` → `0`; `api.js` mtime `2026-11-16 10:05:06` |

**তিন বাক্যে গোটা কিতাব:**

1. সিস্টেম **চলছে**, কিন্তু এজেন্ট TTS/OCR/Public-API টুল **দেখতেই পায় না**, কারণ 155 টুলের ক্যাটালগ প্রথম 25-এ কাটা হয় — এটা মডেলের দোষ নয়, config-এর।
2. আসল সমস্যাগুলো config, path, tool budget, DB আর provider pipeline-এ — প্রতিটার জন্য একটাই সত্য (SSOT) আর fail-fast দরকার।
3. সমাধান **Phase 0 → Phase 10**; কোনো code এখনো বদলায়নি। তুমি **“শুরু করো”** বললে Phase 0 baseline দিয়ে শুরু।

---

## 1. সিস্টেম কীভাবে কাজ করে

### 1.1 কম্পোনেন্ট ম্যাপ

| স্তর | জিনিস | পোর্ট / path | প্রমাণ |
|---|---|---|---|
| Edge | Caddy | `443` → `127.0.0.1:5050` | runbook Appendix B |
| Gateway | `dist/start.js` (api.js) | `5050` | health JSON; pid `827` |
| MCP aggregator | main `/mcp` | `5050/mcp` | `SYNC_OK tools=155` |
| MCP সার্ভার | tts / ocr / screen-recorder / facebook-ads / public-api / combined | `3112` / `3111` / `3121` / `3122` / `3123` | audit §7 |
| MCP সার্ভার | universal-adapter (main থেকে mirror) | `5400/mcp` | audit §7 |
| Local LLM | ollama | `11434` | llm-heal.sh:39 |
| Local bridge | `local-llm-bridge.js` (TCP + UDS) | `11436` + `/tmp/local-llm.sock` | llm-heal.sh:37-39 |
| DB | `data/models.db` (SQLite) | `DB_SQLITE_PATH` | `.env`; runbook §3.8 |
| Frontend | `hasFrontend:true` | `5050` | health JSON |

### 1.2 একটা request-এর যাত্রা

1. ক্লায়েন্ট → **Caddy** (`https://localhost`) → **gateway 5050**।
2. gateway agent + model বেছে নেয় → **provider adapter** (openai / anthropic / vscode / opencode / bridge)।
3. provider-এর উত্তর → **normalizer** (`normalizer/index.js`, api adapter `normalizer/api-response.js`) → এক OpenAI-compatible shape।
4. agent টুল চাইলে gateway **MCP ক্যাটালগ** থেকে টুল বাছাই করে; কিন্তু বাছাইয়ের আগেই ক্যাটালগ **25**-এ কাটা হয় (`api.js:4922`)।
5. টুল কল MCP সার্ভারে যায় (যেমন `tts__tts_speak` → port `3112`) → ফল ফেরত।
6. উত্তর stream হয়ে ক্লায়েন্টে; খরচ/লেটেন্সি `request_log`-এ।
7. `/health` শুধু process বাঁচে কি না বলে; provider সত্যিই উত্তর দেয় কি না তা **health বলে না** (P1 সমস্যা, §4)।

### 1.3 root বনাম dist

- লাইভ প্রসেস চলে `dist/start.js` (cwd `dist`), আর `dist/` gitignored।
- `api.js`/`dist/api.js` আর `start.js`/`dist/start.js`-এর sha256 **এক** (runbook Appendix B)।
- মানে: source edit করলে **rebuild + restart** না করলে কিছুই বদলাবে না। এটা Phase 10-এ fix হবে (service `ExecStart` root `start.js`)।

---

## 2. MCP — বাস্তবে কোন টুল চলে

### 2.1 ক্যাটালগের হিসাব

`main` ক্যাটালগে **155** টুল = `28` native + `4` (tts) + `4` (ocr) + `3` (screen-recorder) + `29` (facebook-ads) + `29` (public-api) + `58` (combined)। `universal-adapter`-এর নিজের 158 টুল main-এ নেই — সে main থেকে mirror করে, তাই recursion এড়াতে বাদ (audit §7)।

### 2.2 ক্যাপ — একই সীমা চার জায়গায়

| জায়গা | মান | প্রমাণ |
|---|---:|---|
| gateway global cap | `25` | `api.js:4922` |
| stream path duplicate | `25` (hardcoded) | `api.js:16281` |
| provider capability | `15` | `provider/capabilities.js:16` |
| bridge path | `5` | `api.js:1170` |
| `prepare()` cap মানে না | — | `provider/tools.js:122` |

### 2.3 এর ফল কী

- `tts__tts_speak` ক্যাটালগে **37** নম্বরে → কেউ পায় না।
- `ocr__*` 29-এ, `public-api__*` 40+ — পায় না।
- bridge path-এ ক্যাপ `5` — শুধু `read_file/write_file/set_working_dir/get_working_dir/web_search`।
- তাই “অডিও বানাও” বললে এজেন্ট টুলটাই দেখে না; টেক্সটে উত্তর দেয় বা ভুল টুল বাছে (audit §3-4)।

**এটাই Phase 5-এর কাজ:** একটাই resolver, `MCP_TOOL_BUDGET_MAX` (ডিফল্ট `24`), pinned tool থাকবে, provider শুধু কমানো পারবে — বাড়ানো নয়।

### 2.4 যেসব টুল বাস্তবে প্রমাণিত

| টুল | প্রমাণ |
|---|---|
| `tts__tts_speak` | main `/mcp` দিয়ে `probe.mp3` — 20 KB, 3.46s, voice `bn-BD-NabanitaNeural` |
| `get_working_dir`, `read_file`, `write_file`, `delete_file`, `memory_recent` | `MCP_CALL` লগ 2026-11-16/17 |
| MCP sync | `main-sync`: `SYNC_OK url=http://localhost:5050/mcp tools=155` |

### 2.5 ওয়ার্কিং ডিরেক্টরির বাইরে কোনগুলো কাজ করে

এই machine-এর `.env`-এ `AGENT_FS_SCOPE=unrestricted` (explicit operator choice); code default এখন `session` (`lib/fs-scope.js`), তাই নতুন install sandbox-সহ শুরু হয়।`

| টুল | সীমা | বাইরে? | প্রমাণ |
|---|---|---|---|
| `read_file`, `write_file`, `delete_file`, `rename_file`, `list_directory` | unrestricted | **হ্যাঁ, যেকোনো path** | `api.js:10991-10999` |
| `set_working_dir` | root বদলায় | **হ্যাঁ** | `api.js:15155` |
| `terminal`, `exec`, `http_request`, `db_query` | FS সীমা নেই | **হ্যাঁ** | `api.js` tool switch |
| `tts__tts_speak` | নিজের output dir `~/zombie-tts` | **হ্যাঁ** (custom `output`-ও) | `logs/local-mcp-tts.log` |
| `ocr__*`, `screen-recorder__*` | নিজেদের output dir | **হ্যাঁ** | `servers.json` |
| `missionbarisal_*` (external surface) | workspace root | **না** — path policy deny | plugin path policy |

**নিরাপত্তার অর্থ:** একটি prompt injection পুরো হোম ডিরেক্টরি মুছে ফেলতে পারে। `AGENT_FS_SCOPE=restricted` করলে workspace + `$HOME`-এ সীমিত হবে (`api.js:11000-11021`)। এটা Phase 8-এর সাথে ঠিক করার বিষয়।

---

## 3. `~/llm-heal.sh` — কীভাবে কাজ করে

**উদ্দেশ্য:** লোকাল LLM স্ট্যাক (ollama → bridge → app) বাঁচিয়ে রাখা এবং ভাঙা অবস্থা থেকে ফিরিয়ে আনা। ৫৯৩ লাইন, bash।

```
./llm-heal.sh status | once | start | watch | stop | install | uninstall
flags: --dry-run | --deep | --fix-duplicates | --verbose
exit: 0 healthy/repaired, 1 broken, 2 usage
```

- **কনফিগ:** `.env` কে `source` করে না (ডেটা, কোড নয়); শুধু `BRIDGE_*`, `OLLAMA_*`, `LLAMA_*` key export করে, inline comment কাটে (`llm-heal.sh:106-140`)।
- **probe চার রকম:** `http_ok` (curl 2xx), `port_listening` (`ss`), `socket_ok` (UDS `/v1/models`), `gen_ok` (আসল ৪-টোকেন generation) — শুধু listener নয়, ইঞ্জিন উত্তর দেয় কি না দেখে (`llm-heal.sh:141-168`)।
- **heal:** `HEAL_ATTEMPTS=3` বার `ensure_ollama` → `ensure_bridge` → `ensure_app`, তারপর `check_all` আবার (`llm-heal.sh:428-455`)।
- **watch:** `CHECK_INTERVAL=60s` লুপ, `flock` দিয়ে একটাই watchdog (`llm-heal.sh:458-465`)।
- **install:** `systemd --user` unit — `~/.config/systemd/user/llm-heal.service` (`llm-heal.sh:501-533`)।

**আজকের verified অবস্থা:**

- unit `llm-heal.service` → `inactive`।
- ডিফল্ট `APP_DIR=$HOME/monu_the_builder` (`llm-heal.sh:35`) — কিন্তু ওই directory **নেই**; আছে `~/monu_the_builder.retired-2026-11-19`।
- মানে watchdog আবার চালু করলে সে ভুল path-এ app খুঁজবে। ঠিক করার নিয়ম: `APP_DIR` env থেকে আসবে, default হবে না — এটা Phase 4-এর path contract-এর অংশ।

---

## 4. সমস্যা — verified inventory

### P0 — এখনই ভাঙছে

| # | সমস্যা | প্রমাণ |
|---|---|---|
| 1 | টুল ক্যাটালগ 25-এ কাটা, `prepare()` cap মানে না | `api.js:4922`, `:16281`, `provider/tools.js:122` |
| 2 | DB না পেলে silent null / fail-open | `api.js:1551-1555`, `provider/index.js:79`, `provider/tools.js:106-113` |
| 3 | env loader তিন জায়গায়, error গিলে ফেলে | `api.js:211-237`, `start.js:57-72`, `lib/env.js:82` |
| 4 | hidden loopback probe + ভাঙা loopback check | `local-llm-bridge.js:107`, `:209`, `:226`; `lib/env.js:80` |
| 5 | bridge timeout mismatch | `provider/transport.js:26`; `api.js:1156-1171`; `.env:212` |

### P1 — correctness / observability

| # | সমস্যা | প্রমাণ |
|---|---|---|
| 6 | health অতিরিক্ত আশাবাদী | `api.js:12941`, `:12955`, `:12996-13005` |
| 7 | `last_error` COALESCE-এ মুছে যায় না | `api.js:13227-13234` |
| 8 | body/frame/history default hardcoded | `api.js:235`, `provider/transport.js:34`, `api.js:251` |
| 9 | normalizer + R2T builtin fallback | single path `normalizer/index.js`; R2T fallback trace `R2T_TRACE_OK` |

### P2 — portability / hygiene

| # | সমস্যা | প্রমাণ |
|---|---|---|
| 10 | installer শুধু apt | `deploy/install-edge.sh:44` |
| 11 | dist আর root drift করার ঝুঁকি | runbook Appendix B |
| 12 | `package.json` নেই | `ls package.json` → No such file |

---

## 5. সমাধান — Phase 0 → Phase 10

| Phase | কাজ | সময় | Gate |
|---|---|---:|---|
| **Phase 0** | Baseline: git tag, test baseline, DB backup | 15 min | `BASELINE_OK` |
| **Phase 1** | Monu retire verify (হয়ে গেছে) | 5 min | `MONU_RETIRED_OK` |
| **Phase 2** | OpenCode paid-only config; dead key সরানো | 10 min | `OPENCODE_CONFIG_OK` |
| **Phase 3** | Config SSOT + size budgets + fail-fast | 2–3 h | `CONFIG_CONTRACT_OK` |
| **Phase 4** | Path contract + OS-detect installer | 2 h | `PATH_CONTRACT_OK` |
| **Phase 5** | Tool budget SSOT (`MCP_TOOL_BUDGET_MAX`) | 3–4 h | `TOOL_BUDGET_OK` |
| **Phase 6** | DB required + `DB_FATAL` | 1–2 h | `DB_FAILFAST_OK` |
| **Phase 7** | Normalizer/adapter + health + trace | 3 h | `PROVIDER_TRACE_OK` |
| **Phase 8** | Loopback + MCP registry | 2 h | `MCP_REGISTRY_OK` |
| **Phase 9** | 30-case eval + adapter golden tests | 4–6 h | `QUALITY_EVAL_OK` |
| **Phase 10** | Cleanup + release | 2 h | `RELEASE_OK` |

**ক্রম:** Phase 0 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10। Phase 1 শুধু verify।

### 5.1 বারোটি সিদ্ধান্ত (D1–D12)

| # | সিদ্ধান্ত |
|---|---|
| D1 | Monu retire — remote snapshot আছে, service বন্ধ, archive সংরক্ষিত |
| D2 | OpenCode provider থাকবে; free tier শুধু client-এ, তাই paid key ছাড়া disabled |
| D3 | Caddyfile-ই একমাত্র edge শর্ত; DNS/Cloudflare নয় |
| D4 | Local ও cloud provider একই contract |
| D5 | Tool budget এক জায়গা, env-driven (`MCP_TOOL_BUDGET_MAX`) |
| D6 | Body/session/web-UI/outbound/tool-result — সব size env-driven |
| D7 | Path এক resolver, absolute, boot-এ `PATH_RESOLVED` |
| D8 | DB required; missing/corrupt → fatal, exit `78` |
| D9 | Hidden loopback scan বন্ধ; self-reference fatal |
| D10 | Provider → normalizer → OpenAI-compatible → adapter |
| D11 | UDS শুধু transport; OS-detect installer |
| D12 | 30-case eval + adapter golden test = quality gate |

---

## 6. নীতি — চিরন্তন সত্য

1. **এক concern, এক সত্য।** Config, path, budget, DB — প্রতিটার একটাই resolver।
2. **Env-driven, hardcoded নয়।** `MCP_TOOL_BUDGET_MAX`, `SESSION_MAX_BYTES`, `TOOL_RESULT_MAX_BYTES` — সব `.env`।
3. **Fail-fast।** `.env` নেই → `CONFIG_FATAL`, DB নেই → `DB_FATAL`, exit `78`; hidden fallback নেই।
4. **কোনো hidden loopback নেই।** `BRIDGE_UPSTREAMS` explicit; নিজেকে upstream করলে fatal।
5. **UDS শুধু transport।** Business logic TCP আর UDS — দুই পথেই একই।
6. **Adapter শুধু shape।** সিদ্ধান্ত normalizer-এ, adapter-এ নয়।
7. **Quality gate।** 30 case, pass ≥ 90%, injection escape 0।

---

## 7. কী এখনো হয়নি + শুরু করার শর্ত

**হয়নি (proof):**

- `git tag -l 'pre-single-truth*'` → `0`
- `api.js` mtime → `2026-11-16 10:05:06`
- কোনো phase চালানো হয়নি; `dist/` rebuild হয়নি

**কেন এটা ভালো:** আগে plan, পরে কাজ। 155 টুলের ক্যাটালগ, DB fail-open, তিনটা env loader — একসাথে বদলালে debugging অসম্ভব হয়ে যাবে। তাই এক phase, এক commit, এক gate।

**তুমি “শুরু করো” বললে:**

1. Phase 0 baseline — `git tag pre-single-truth-2026-11-20`, test output সংরক্ষণ, `data/models.db` backup (`VACUUM INTO`)।
2. তারপর Phase 2 (OpenCode), তারপর Phase 3 (config SSOT) — আলাদা commit।
3. প্রতিটি phase-এর আগে tag, পরে gate check।
4. কোনো phase fail করলে থামব, কারণ দেখাব; অনুমান দিয়ে এগোব না।

---

## 8. সংযুক্ত ফাইল, অডিও ও যাচাই

| জিনিস | কোথায় |
|---|---|
| এই গাইডবুক | `docs/GUIDEBOOK-2026-11-20.md` |
| পূর্ণ প্রমাণ-ভিত্তিক runbook | `docs/RUNBOOK-OPTIMIZATION-2026-11-19.md` (section 0–9 + Appendix A/B) |
| ফেজ পরিকল্পনা | `docs/PLAN-2026-11-20.md` |
| প্রোভাইডার ও MCP অডিট | `docs/AUDIT-PROVIDERS-2026-11-19.md` |
| বাংলা narration | `~/Music/mp3/zbd/today/zbd-guidebook-2026-11-20.mp3` |

**অডিওর প্রমাণ (`zbd-guidebook-2026-11-20.mp3`):**

| Field | Value |
|---|---|
| Size | **3,596,060 bytes** (`stat -c%s`) |
| Duration | **599.3s** (9:59), `ffprobe format=duration` |
| sha256 | `3064123397b66876b7cf074d874e1e7814b6cb8f2eba293596b110f1f77fddae` |
| Voice | `bn-BD-NabanitaNeural` (edge-tts, 14 chunks, সব প্রথম attempt-এ) |
| Script | `tmp/guidebook-narration.txt` (7,607 chars) |
| Builder | `tmp/tts-guidebook.py`; লগ `tmp/tts-guidebook.log` |

**Contract evidence:**

- `gc-mwnwdske` → `GUIDEBOOK_AUDIO_OK` — এই গাইডবুক + MP3 (এই ডকুমেন্ট লেখার সময় খোলা)

Check marker: `GUIDEBOOK_AUDIO_OK`
