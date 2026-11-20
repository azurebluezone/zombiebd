# RUNBOOK — Single-Truth Optimization (2026-11-19)

**Scope:** `~/zombiebd` এবং এই মেশিনে চলা adjacent stacks।
**Status:** `IMPLEMENTATION_NOT_STARTED` — PROPOSAL + EXECUTION PLAN; এই ডকুমেন্ট লেখার সময় product code বদলানো হয়নি, কোনো phase এখনো চালানো হয়নি।
**Entry point (আগে এটা পড়ো):** `docs/PLAN-2026-11-20.md` — ১০ phase, gate ও সময়সহ সংক্ষিপ্ত করণীয়; narration `/home/sahon/Music/mp3/zbd/today/zbd-plan-2026-11-20.mp3` (424.1s, 2,544,860 bytes)।
**Closed contracts:** `gc-mwnurzwx` → `RETIRE_AUDIO_OK` (Monu retire + runbook narration); `gc-mwnvesuc` → `PLAN_AUDIO_OK` (plan doc + narration)।
**Evidence rule:** প্রতিটি দাবির পাশে `path:line`, command output বা exit code আছে। যা probe করা হয়নি তা `UNVERIFIED`।
**Companion audit:** `docs/AUDIT-PROVIDERS-2026-11-19.md`।

---

## 0. Executive decisions — আগে সিদ্ধান্ত, পরে কাজ

| # | সিদ্ধান্ত | কারণ | Phase |
|---|---|---|---|
| **D1** | **Monu Builder বন্ধ হবে** — আগে বর্তমান অবস্থার নতুন branch + remote push, তারপর archive, তারপর service stop | একই কোডের দ্বিতীয় stack: app `5000`, bridge `11436`, আলাদা DB; `llm-heal.service` এটাকে বাঁচিয়ে রাখছে | 1 |
| **D2** | **OpenCode provider ফেলে দেওয়া হবে না** | Provider = provider। Free tier শুধু OpenCode client-এ চলে; paid key থাকলে adapter আগের মতোই কাজ করবে | 2 |
| **D3** | **Caddyfile-ই একমাত্র edge শর্ত** | Cloudflare Tunnel/DNS কোনো শর্ত নয়; Caddy HTTPS+proxy দিলেই localhost provider reachable | 4 |
| **D4** | **Local আর cloud provider-এ কোনো ভেদাভেদ নেই** | একই provider contract, একই capability query, একই timeout/fallback logic | 4–5 |
| **D5** | **Tool budget এক জায়গা থেকে, env-driven** | এখন `25`, `15`, `5`, আবার `25` — একই limit পাঁচ জায়গায় | 5 |
| **D6** | **সব size/MB budget env-driven** | body, session, web-UI payload, outbound frame, tool result — hardcode নয় | 3 |
| **D7** | **Path এক resolver, absolute, boot-এ log** | `DATA_DIR`, `DB_SQLITE_PATH`, homedir, `/tmp` — আলাদা আলাদা নিয়ম | 4 |
| **D8** | **DB required; না পেলে fatal** | এখন DB missing হলে server চালু থাকে, env-only mode-এ নেমে যায় | 6 |
| **D9** | **কোনো hidden loopback discovery নয়** | bridge নিজে `11434, 3000, 8080...` scan করে; self-check-এ `127.0.0.1` ধরা পড়ে না | 8 |
| **D10** | **Provider → normalizer → OpenAI-compatible → adapter** | UDS শুধু transport-এ; client-ভিত্তিক `दालালি` core-এ নয় | 7 |
| **D11** | **OS detect করে install** | service যেকোনো disk location থেকে চলবে; installer OS অনুযায়ী config/unit বানাবে | 4 |
| **D12** | **শুধু fix নয় — quality gate** | 30-case eval + adapter golden tests + cost/latency | 9 |

### OpenCode প্রশ্নের সরাসরি উত্তর

**OpenCode-এর free tier আছে, কিন্তু শুধু OpenCode-এর নিজের client-এর ভিতরে।**
Official doc (`https://opencode.ai/docs/console/models/`, fetched 2026-11-19):

> “Free-tier chat models require OpenCode; use paid models or Go from other clients.”

আমাদের gateway direct HTTP + API key দিয়ে call করে, তাই free model (`deepseek-v4.1-flash-free`, `big-pickle`, `iceman-free` ইত্যাদি) direct API-তে চলবে না। কোডে এটা আগেই ধরা আছে — `provider/opencode.js:77-80`:

```js
// 400 "free tier can only be used from within OpenCode" → not usable here.
if (/free tier|within opencode/i.test(e)) {
  res.retriable = true;
```

**সিদ্ধান্ত (আপডেট): provider code থাকবে, free-tier expectation থাকবে না।**

```bash
# .env — paid key না থাকলে
OPENCODE_ENABLED=false
# OPENCODE_API_KEY=...   ← শুধু paid key হলে
```

`provider/opencode.js`, capability row, timeout — সবই প্রথম শ্রেণির provider হিসেবে থাকবে। শুধু `.env.example`-এ লেখা থাকবে “paid only; free tier works only inside the OpenCode client”।

---

## 1. চিরন্তন সত্য (invariants)

এই সত্যগুলো ভাঙলে optimization নয়, নতুন bug তৈরি হবে।

| # | Truth | এখন যা ভাঙে | Proof gate |
|---|---|---|---|
| **T1** | একটাই config loader | `api.js:211-237`, `start.js:57-72`, `lib/env.js:82`, `lib/expand-env.js:15` | `grep -rn "function loadEnv\\|function parseEnvFile"` → ১টা |
| **T2** | একটাই tool budget resolver | `MAX_TOOLS_LIMIT=25` (`api.js:4922`), `15` (`provider/capabilities.js:16`), `5` (`api.js:1170`), `25` (`api.js:16281`) | `MAX_TOOLS_LIMIT` grep → ০ |
| **T3** | একটাই path resolver | `api.js:244-245` vs `start.js:28-35`; MCP-তে `os.homedir()` | production-এ homedir/`\"/tmp/\"` → ০ |
| **T4** | DB required | missing DB → `MODELS_DB=null` → env-only (`api.js:1551-1555`) | DB সরিয়ে boot → exit 78 |
| **T5** | required env নেই → fatal | `catch (_) {}` silent | `.env` সরিয়ে boot → `CONFIG_FATAL` |
| **T6** | hidden loopback নেই | ~~`DEFAULT_PROBE_PORTS` scan; broken self-check~~ → SOLVED 2026-11-20: explicit-only candidates + `lib/net.js` | `node tests/bridge-discovery-check.js` → `BRIDGE_DISCOVERY_OK` |
| **T7** | health truth = DB + probe | optimistic `healthy=true`, 60s auto-recover | provider down → UI down |
| **T8** | timeout per-provider | transport `60s`, ollama `1200s`, bridge provider-এ timeout নেই | `PROVIDER_TIMEOUT` log |
| **T9** | fallback explicit + traced | `request_log`-এ attempt/fallback নেই | `PROVIDER_ATTEMPT` rows |
| **T10** | একটাই size budget contract | body 10MB, frame 8MB, history 10 — আলাদা আলাদা hardcode | সব `*_BYTES` env থেকে |
| **T11** | provider উত্তর আগে OpenAI-compatible | adapter-specific শাখা pipeline-এর মাঝে | `normalizeResponse` golden test |
| **T12** | একটাই quality gate | manual probe ছাড়া কিছু নেই | `QUALITY_EVAL_OK` |

---

## 2. Verified problem inventory

### 2.1 P0 — এখনই ভাঙছে

#### P0-01 — Tool budget পাঁচ জায়গায়, একটাও authoritative নয় — ✅ SOLVED (2026-11-20)

**Evidence**

- `api.js:4922` — `const MAX_TOOLS_LIMIT = 25;`
- `api.js:9413` — mission path-এ আবার slice
- `api.js:10113` — agent path-এ আবার same cap
- `api.js:16281` — `const streamToolLimit = Math.min(25, agentCaps.maxTools);`
- `provider/capabilities.js:16` — `maxTools: 15` default
- `api.js:1170` — bridge `maxTools: positiveIntEnv("BRIDGE_MAX_TOOLS") || 5`
- `provider/tools.js:122` — `prepare()` শুধু `allowsTools()` দেখে; `maxTools` ignore করে

**Impact:** 155টি MCP tool → 25-এ কাটা; `tts__tts_speak` index 37; 25 schema ≈ 11,428 bytes ≈ 2,857 tokens; ~30 tok/s-এ ~95s, bridge-এর effective timeout 60s → `TOOL_LOOP_NO_TOOL_CALLS` (`logs/2026-11-19.log:4455`)।

**Fix:** Phase 5 — `lib/tool-budget.js` একটাই resolver; সব caller সেখান থেকে limit নেবে।

**Fix (2026-11-20):** `lib/tool-budget.js` owns the global count (`MCP_TOOL_BUDGET_MAX=24`), pin (`MCP_TOOL_BUDGET_PIN=tts__tts_speak,ocr__ocr_image`), bytes (`MCP_TOOL_BUDGET_MAX_BYTES=12000`) and prefill budget (`estPrefillMs ≤ min(timeout/2, 45000)`, 30 tok/s). `api.js` applies it once in `callModel`/`callModelStream` (two call sites), the bridge declares `PROVIDER_BRIDGE_MAX_TOOLS=5` through `bridgeMaxTools()`, `provider/capabilities.js` has `maxTools: Infinity`, and `provider/tools.js prepare()` enforces the effective max with `capTools()`. `MAX_TOOLS_LIMIT` and every inline slice are gone; `/api/agents` reports `limitFor()`/`rankNames()`. Boot validates the config and exits `CONFIG_FATAL` (78) on invalid values.

**Proof:** `node tests/tool-budget-check.js` → `TOOL_BUDGET_OK` (36 checks: single resolver, 155→24, bridge 5, pinned tts survives, bytes/prefill bounds, prepare cap, grep gate).

#### P0-02 — DB missing হলে server বেঁচে থাকে — ✅ SOLVED (2026-11-20)

**Before:**

- `api.js:1303-1308` — comment: “so a forgotten env var can never brick the gateway.”
- `api.js:1325` — DB না থাকলে `DB_REMOTE_URL` থেকে download
- `api.js:1551-1555` — `MODELS_DB = null; log("WARN", "SQLITE_UNAVAILABLE")`
- `provider/index.js:79` — `if (!MODELS_DB) return true;`
- `provider/tools.js:106-113` — DB error হলে tools allow

**Impact:** ভুল DB path-এ gateway “healthy”, কিন্তু capability প্রমাণহীন। `provider_stats`-এ `unknown` row।

**Fix (2026-11-20):** `api.js` `initModelsDb()` now gates boot on the models DB:

- missing DB + `DB_BOOTSTRAP=1` → create schema → `DB_OK`; without it → `DB_FATAL missing path=...` (exit 78).
- `SQLITE_BUSY/LOCKED` → retry `DB_BUSY_RETRY_MS` ×3 → `DB_FATAL busy`.
- `SQLITE_CORRUPT/NOTADB` or a failed `PRAGMA quick_check` → `DB_FATAL corrupt`; the file is never renamed.
- `MODELS_DB` is never null after boot; the `DB_REMOTE_URL` download path is removed.
- `provider/index.js` `supports()` and `provider/tools.js` `allowsTools()` deny with `CAPABILITY_UNKNOWN` when the DB handle is missing or the query fails (P1-06).

**Proof:** `bash scripts/verify-db-failfast.sh` → `DB_FAILFAST_OK` (missing/corrupt/busy exit 78, bootstrap + re-boot `/health` 200, capability deny). `node scripts/verify-capability-failclosed.js` → `CAPABILITY_FAILCLOSED_OK`.

#### P0-03 — `.env` loader চারটি, error গেলা হয় — ✅ SOLVED (2026-11-20)

`api.js:211-237` (`catch (_) {}`), `start.js:57-72` (`catch (_) {}`), `lib/env.js:82`/`:170`, `lib/expand-env.js:15`; `api.js:117` শুধু `SERVICE_PORTS, DEFAULTS` নেয়, loader নেয় না।

**Fix (2026-11-20):** `lib/env.js:153` `loadProcessEnv()` is the only `.env` reader and the only `loadProcessEnv` definition. It returns `{loaded, file, count, vars, warnings, missing?, error?}`: `ENOENT` is a reported `missing` (non-fatal), any other read failure is an `error` string, and malformed lines become warnings instead of vanishing. Parent env wins unless `overwrite:true`; `${VAR}` expansion, quotes and `export` stay supported. `api.js:118`/`:221` requires it and exits `78` on a read error; `start.js:19`/`:138` delegates and no longer has a swallowed `catch`; `lib/expand-env.js:15`/`:26` delegates too. `modules/config.js` no longer contains `parseEnv`/`loadEnvFile` or any `fs`/`path` import.

**Proof:** `node tests/env-loader-check.js` → `ENV_LOADER_OK` (29 checks: one implementation, four delegating callers, no private `.env` reader, read error returned, missing reported, parent-wins/overwrite, malformed warning, `loadEnv` validation). Related gates still pass: `node scripts/check-env.js` → `ENV_OK services=17 unique=yes`, `node tests/modules-foundation-check.js` → `MODULES_FOUNDATION_OK`, `node tests/modules-runtime-check.js` → `MODULES_RUNTIME_OK`.

#### P0-04 — Path resolution দুই জায়গায়, কিছু default home-এ — ✅ SOLVED (2026-11-20)

- `api.js:244-245` — `LOG_DIR`/`DATA_DIR` default `./logs`, `./data`
- `start.js:28-35` — `projectDataDir()` + `projectDbPath()` আবার একই logic
- `external mcp/tts-mcp.js:22` — `os.homedir()/zombie-tts`
- `external mcp/screen-recorder-mcp.js:21` — `os.homedir()/zombie-recordings`
- `cdp-pipe.js:45-46` — `/opt/google/chrome/chrome`, `/tmp/opencode`
- `tests/agent-transport-e2e.js:23`, `tests/workspace-layout-check.js:44` — `/home/sahon` (test-only; removed 2026-11-20, P2-01)

**Fix (2026-11-20):** `lib/env.js:259` `resolveRuntimePaths()` is the only runtime path resolver: `APP_ROOT` defaults to the tree that owns `lib/` (checkout or its dist twin) and env `APP_ROOT` wins; relative `DATA_DIR`/`LOG_DIR`/`CACHE_DIR`/`TMP_DIR`/`DB_SQLITE_PATH`/`MCP_OUTPUT_DIR`/`TTS_OUTPUT_DIR`/`SCREEN_RECORDINGS_DIR`/`ZOMBIECODER_CONFIG_DIR` resolve against it, absolute values stay absolute. `lib/env.js:309` `assertPathInside()` throws `PATH_ESCAPE` on an escape, `:231` `userHomeDir()` is the only `os.homedir()` call, `:235` `expandHome()` owns `~`, and `loadEnv()` returns the same map as `paths`. `api.js:260` computes `RUNTIME_PATHS` once, takes DATA/LOG/CACHE/DB from it, anchors `.missionbarisal` at APP_ROOT and prints `PATH_RESOLVED name=... path=...` for all nine locations (`api.js:1200`). `start.js:30/56/59/493` delegates config/data/db/tmp; `local-llm-bridge.js:16` uses `userHomeDir()`; `external mcp/tts-mcp.js:24` defaults to `data/tts` and `screen-recorder-mcp.js:22` to `data/recordings`; `lib/secret-store.js:42` takes the DB path from the resolver. Production `os.homedir()` is now zero in the T3 grep list; `cdp-pipe.js:45-46` keeps its tool-local `CHROME_BIN`/`CDP_TMP_DIR` env defaults (browser-tool paths, not runtime state), and the former `/home/sahon` test hits were removed under P2-01 (`tests/portability-check.js` proves the copied tree resolves its own paths).

**Proof:** `node tests/path-resolver-check.js` → `PATH_RESOLVER_OK` (49 checks: exports and callers, no production `os.homedir()`, default and override maps, `~` expansion, `PATH_ESCAPE`, `loadEnv().paths`, MCP defaults). Regression: `node tests/env-loader-check.js` → `ENV_LOADER_OK`, `node tests/bridge-timeout-check.js` → `BRIDGE_TIMEOUT_OK`, `node tests/tool-budget-check.js` → `TOOL_BUDGET_OK`, `node scripts/check-env.js` → `ENV_OK services=17`; `local-tool-cap.test.js` A6 PASS with only the pre-existing A1/D15 failures.

#### P0-05 — Hidden loopback scan + ভাঙা self-reference check — ✅ SOLVED (2026-11-20)

- `local-llm-bridge.js:107` — `DEFAULT_PROBE_PORTS = [11434, 9932, 8080, 9999, 3000, 1234, 5252, 8000]`
- `local-llm-bridge.js:226` — `BRIDGE_PROBE_DEFAULTS` truthy হলে scan
- `.env:148` — `BRIDGE_PROBE_DEFAULTS=1`
- `local-llm-bridge.js:209` — `u.hostname === "localhost" || u.hostname === "localhost"` — `127.0.0.1` miss
- `lib/env.js:80` — `["localhost","::1","localhost"]`

**Fix (2026-11-20):** `lib/net.js` is the one loopback definition (`localhost`, `127.0.0.1`, `::1`, `[::1]`, expanded IPv6) with `isLoopbackHost()`, `isSelfReference()` and `upstreamKey()`; `lib/env.js` consumes it instead of keeping a second set. `lib/bridge-upstreams.js` builds candidates only from `BRIDGE_UPSTREAMS`, the configured `BRIDGE_OLLAMA_URL` and an explicit `BRIDGE_BACKEND=llama` server; `DEFAULT_PROBE_PORTS` and the `BRIDGE_PROBE_DEFAULTS` scan are deleted. A loopback URL on the bridge/gateway port is rejected before any request and reported as `BRIDGE_SELF_REFERENCE` in the log and `/health.self_references`; loopback aliases on the same port/path dedupe to one upstream. `.env.example` no longer advertises the probe flag and shows the explicit Ollama upstream.

**Proof:** `node tests/bridge-discovery-check.js` → `BRIDGE_DISCOVERY_OK` (7 checks: loopback spellings, env single source, self-reference for 127.0.0.1/localhost/[::1], alias dedupe, explicit-only candidates, source/config grep, and a real bridge with `BRIDGE_PROBE_DEFAULTS=1` + no config reporting `upstreams=[]`). Regression: `node tests/env-loader-check.js` → `ENV_LOADER_OK`, `node tests/bridge-timeout-check.js` → `BRIDGE_TIMEOUT_OK`, `node tests/path-resolver-check.js` → `PATH_RESOLVER_OK`, `node tests/agent-provider-ssot-check.js` → `AGENT_PROVIDER_SSOT_OK`, `node tests/tool-budget-check.js` → `TOOL_BUDGET_OK`, `node scripts/check-env.js` → `ENV_OK services=17`. UDS e2e bridge checks pass; its 3 remaining failures are pre-existing environment checks (dist-vs-root UDS path, Gemini 400, OpenCode disabled).

#### P0-06 — Monu Builder দ্বিতীয় stack, watchdog দিয়ে জীবিত

- `systemctl --user is-enabled llm-heal.service` → `enabled`; `is-active` → `active`
- Unit `APP_DIR=/home/sahon/monu_the_builder`
- `ss -ltnp` → `127.0.0.1:5000` (pid 2335), `127.0.0.1:11436` (pid 2384)
- `bash ~/llm-heal.sh status` → `bridge processes 2 own=1`
- `~/monu_the_builder/.env:10` → `APP_URL=https://z.infiniteearningzone.com`
- `/etc/caddy/Caddyfile` → শুধু `127.0.0.1:5050` vhost; `5000` নেই
- `llm-heal.sh` help line 20 — `stop` শুধু watchdog থামায়, stack চলে

#### P0-07 — Timeout mismatch — ✅ SOLVED (2026-11-20)

- `provider/transport.js:26` — `DEFAULT_TIMEOUT = 60000`
- `provider/transport.js:194` — stream default `300000`
- `api.js:1120-1121` — `OLLAMA_TIMEOUT_MS` / `OLLAMA_STREAM_TIMEOUT_MS`
- `.env:68-69` — `1200000`
- `api.js:1156-1171` — bridge provider-এ `timeout`/`streamTimeout` নেই
- `.env:212` — `BRIDGE_TIMEOUT_MS=1200000`

**Fix (2026-11-20):** `lib/provider-timeout.js:41` `resolveBridgeTimeouts()` is the one bridge deadline: `upstream = BRIDGE_TIMEOUT_MS` (default 120s), gateway `timeout = upstream + BRIDGE_TIMEOUT_GRACE_MS` (default 5s), and the stream inherits it — so the gateway can no longer expire while the bridge is still prefilling. `lib/provider-timeout.js:57` `resolveProviderTimeouts()` covers every other provider (`<PROVIDER>_TIMEOUT_MS` → `PROVIDER_TIMEOUT_MS` → 300s unified default; the stream falls back to the resolved request deadline). `provider/transport.js:25/30` requires the resolver and replaces the hardcoded 60s/300s with `fallbackTimeouts()` at call time; `DEFAULT_TIMEOUT` is gone. `api.js:964/991/1013` ollama, ollama_cloud and bridge spread the resolver and log `[PROVIDER_TIMEOUT]` at boot (`api.js:1044`); `local-llm-bridge.js:157` uses the same `.upstream`; `.env.example:288-291` documents `BRIDGE_TIMEOUT_MS` and `BRIDGE_TIMEOUT_GRACE_MS`.

**Proof:** `node tests/bridge-timeout-check.js` → `BRIDGE_TIMEOUT_OK` (27 checks: static wiring, precedence and invalid-env fallback, bridge `upstream < gateway`, real HTTP request/stream timeouts driven by cfg and resolver env). Regression: `node tests/local-tool-cap.test.js` A6 PASS (43 passed; only the two pre-existing A1/D15 failures remain), `node tests/env-loader-check.js` → `ENV_LOADER_OK`, `node tests/tool-budget-check.js` → `TOOL_BUDGET_OK`, `node scripts/check-env.js` → `ENV_OK services=17`.

#### P0-08 — “Online” মিথ্যা; DB-তে পুরোনো error আটকে থাকে

- `api.js:12941` — নতুন provider `healthy: true`
- `api.js:12955-12964` — success-এ `healthy=true`, `lastError=null`
- `api.js:12996-13005` — 60s পর probe ছাড়াই `healthy=true`
- `api.js:13227-13234` — `last_error = COALESCE(excluded.last_error, last_error)`

#### P0-09 — চলমান gateway `dist/start.js`, root `api.js` নয় — ✅ SOLVED (2026-11-20)

**Evidence (live, 2026-11-19 23:52–00:05 — আগের অবস্থা)**

- `ps -p 827 -o cmd` → `/home/sahon/zombiebd/dist/start.js --start-all -s`
- `readlink /proc/827/cwd` → `/home/sahon/zombiebd/dist`
- `systemctl --user cat zombiecoder-gateway.service` → `WorkingDirectory=/home/sahon/zombiebd/dist`, `ExecStart=/home/sahon/zombiebd/scripts/zombiecoder-gateway.sh`
- `git check-ignore -v dist/start.js` → `.gitignore:46:dist/`
- `sha256sum api.js dist/api.js` → দুইটাই `4608054f…`; `start.js`/`dist/start.js` → দুইটাই `764b7222…` — তখন কোনো drift নেই, dist বিল্ড হয়েছে root থেকে (root mtime 10:05, dist 10:38)

**Impact:** root-এ ভবিষ্যতে করা fix `dist/` rebuild + service restart ছাড়া চলমান pid 827-এ পৌঁছাবে না। `dist/` gitignored, তাই release artifact-এর provenance আলাদা রাখতে হবে; “কোড বদলেছি” মানেই “লাইভে গেছে” নয়।

**Fix (implemented 2026-11-20):** root `start.js` এখন একমাত্র entry — `--start-all` প্রতি রানে `scripts/build.js` চালায়, তারপর `$ZC_DIST_DIR/api.js` require করে। `dist/start.js` আর কপি হয় না; কেউ চালালে exit `78`। Build operator state (`data`, `logs`, `cache`, `locks`, `.zombiecoder`, `.missionbarisal`, `.env`) কপি না করে symlink করে, আর live-runtime guard `dist/.runtime.json`-ও পড়ে। Service unit-এ `WorkingDirectory=/home/sahon/zombiebd`; wrapper root `start.js` চালায়।

**Proof (2026-11-20, live):**

```text
$ bash scripts/verify-start-dist.sh ; echo exit=$?
LIVE_SERVICE_OK pid=88009 working_directory=/home/sahon/zombiebd
START_DIST_OK dist=/tmp/zbd-start-dist.xOLA0w/dist api_sha256=640b31ea44537d07cafcfe406e3ca28f8a46a806598493015a490a7ed19d97fd builtAt=2026-11-19T22:08:31.945Z health=200
exit=0
```

- `MainPID=88009` → `/home/sahon/.local/node-v24/bin/node /home/sahon/zombiebd/start.js --start-all -s`, cwd `/home/sahon/zombiebd`
- `ls dist/start.js` → `No such file or directory`
- `sha256sum api.js dist/api.js` → দুইটাই `640b31ea…`; `manifest.json`-এ api.js sha256 একই
- `curl -s 127.0.0.1:5050/health` → HTTP 200
- contract `gc-mwo3iygr` PASS (marker `START_DIST_OK`)

### 2.2 P1 — correctness/observability

| ID | Problem | Evidence | Fix |
|---|---|---|---|
| P1-01 | Bridge timeout upstream-এর চেয়ে কম | `provider/transport.js:26`, `.env:212` | ✅ SOLVED (2026-11-20): `lib/provider-timeout.js` bridge = `BRIDGE_TIMEOUT_MS` + grace; `provider/transport.js` has no literal default; proof `node tests/bridge-timeout-check.js` |
| P1-02 | `request_log`-এ routing প্রমাণ নেই | `PRAGMA table_info(request_log)` | Phase 7 |
| P1-03 | Tool selection insertion order | `api.js:4946-4951`, `9413`, `10113` | Phase 5 — ✅ SOLVED (2026-11-20): intent rank + deterministic tie-break |
| P1-04 | `prepare()` cap enforce করে না | `provider/tools.js:122-125` | Phase 5 — ✅ SOLVED (2026-11-20): `capTools()` |
| P1-05 | Bridge default port দুই জায়গায় | `api.js:1159` (`11435`) vs `local-llm-bridge.js:136` (`11437`) | ✅ SOLVED (2026-11-20): `lib/env.js` DEFAULTS একমালিক; `local-llm-bridge.js`/`api.js`/`provider/defaults.js` সব সেখান থেকেই পড়ে; proof `node tests/agent-provider-ssot-check.js` |
| P1-06 | Capability query fail-open | `provider/index.js:79/88/95`, `provider/tools.js:106-113` | Phase 6 — ✅ SOLVED (2026-11-20): deny + `CAPABILITY_UNKNOWN` |
| P1-07 | R2T module না পেলে silent builtin fallback | `api.js:19574-19581` (`builtin-fallback`) | Phase 7 |
| P1-08 | Edge installer শুধু apt ধরে | `deploy/install-edge.sh:44` | Phase 4 |
| P1-09 | `package.json` নেই | `ls package.json` → No such file | Phase 4 |
| P1-10 | Size limit ছড়িয়ে আছে | `api.js:235` (10MB), `provider/transport.js:34` (8MB), `api.js:251` (10 msg) | Phase 3 |

### 2.3 P2 — portability/hygiene

| ID | Problem | Evidence | Fix |
|---|---|---|---|
| P2-01 | Test-এ `/home/sahon` | `tests/agent-transport-e2e.js:24`, `tests/agent-transport-e2e-verify.js:14/40`, `tests/workspace-layout-check.js:38` | ✅ SOLVED (2026-11-20): `E2E_WORK_DIR` or `TEST_DIR` or `os.tmpdir()`; no machine-home literal in tracked source/tests; `tests/portability-check.js` copies the tracked tree, runs the resolver there, and proves its DB/UDS stay inside the copy on `PORT=5599` |
| P2-02 | Stale artifacts | `dist/`, `.zombiecoder/.state/backups/*`, `logs/` 24MB | retention |
| P2-03 | কোনো eval harness নেই | manual probe | Phase 9 |
| P2-04 | Git worktree dirty | `git status --short` | Phase 0 tag/stash |

---

## 3. Target architecture — প্রতিটি concern-এর একটাই সত্য

### 3.1 Config flow

```
~/zombiebd/.env
      │
      ▼
lib/env.js  readEnvFile()      ← একমাত্র parser
      │
      ▼
validateRequired()  ── missing/invalid ──▶ CONFIG_FATAL (exit 78)
      │
      ▼
resolveRuntimePaths()  ── APP_ROOT, DATA_DIR, LOG_DIR, DB_SQLITE_PATH
      │
      ▼
Object.freeze(config)  ── boot-এ একবার CONFIG_REPORT
      │
      ├── api.js
      ├── start.js
      ├── local-llm-bridge.js
      └── external MCP spawner
```

Error format (একটাই):

```
CONFIG_FATAL key=DB_SQLITE_PATH reason=missing hint=set an absolute path in ~/zombiebd/.env
```

Exit code `78` (EX_CONFIG)। কোনো `catch (_) {}` নেই।

### 3.2 Required vs optional

**Required:** `APP_ROOT` (absolute, exists), `DB_SQLITE_PATH` (absolute; file থাকতে হবে unless `DB_BOOTSTRAP=1`), `DATA_DIR`, `LOG_DIR`, `CACHE_DIR`, `TMP_DIR`, `PORT` (1–65535), `MCP_TOOL_BUDGET_MAX` (1–128), `BRIDGE_UPSTREAMS` (`BRIDGE_ENABLED=1` হলে), enabled provider-এর key।

**Optional (default শুধু `lib/env.js`-এ, boot-এ log):** `MAX_HISTORY`, `SESSION_TTL`, `EXEC_TIMEOUT`, `EXEC_MAX_BUFFER`, `MAX_BODY_SIZE`, `MCP_TOOL_BUDGET_PIN`, `MCP_TOOL_BUDGET_STRATEGY`, `DB_BUSY_RETRY_MS`, `PROVIDER_*_TIMEOUT_MS`।

```
CONFIG_DEFAULT key=MAX_HISTORY value=10 source=lib/env.js
```

### 3.3 Tool budget — একটাই contract

```bash
# Global ceiling. No code may hardcode a second number.
MCP_TOOL_BUDGET_MAX=24
MCP_TOOL_BUDGET_PIN=tts__tts_speak,ocr__ocr_image
MCP_TOOL_BUDGET_STRATEGY=intent
MCP_TOOL_BUDGET_MAX_BYTES=12000
MCP_TOOL_BUDGET_MAX_PREFILL_MS=45000
MCP_TOOL_PREFILL_TOKENS_PER_SEC=30

# Provider may only LOWER the global ceiling.
PROVIDER_BRIDGE_MAX_TOOLS=5
```

Resolver (`lib/tool-budget.js`):

```js
resolveToolBudget({ providerId, tools, timeoutMs, intent }) → {
  tools, limit, bytes, estTokens, estPrefillMs, dropped, pinned
}
```

Rules:

1. `limit = min(MCP_TOOL_BUDGET_MAX, providerMax)`.
2. Pinned tool থাকবেই; pinned > limit হলে boot-এ `CONFIG_FATAL`.
3. Intent + name/description rank; deterministic tie-break (name)।
4. `bytes ≤ MCP_TOOL_BUDGET_MAX_BYTES` এবং `estPrefillMs ≤ min(timeoutMs × 0.5, MCP_TOOL_BUDGET_MAX_PREFILL_MS)`।
5. প্রতি request-এ একবার `TOOL_BUDGET` log।
6. কোনো caller আর `slice()` করবে না।

Replace map:

| File | এখন | হবে |
|---|---|---|
| `api.js:4922` | `MAX_TOOLS_LIMIT=25` | delete |
| `api.js:9413` | `slice(0, MAX_TOOLS_LIMIT)` | `resolveToolBudget(...)` |
| `api.js:10113` | same | same |
| `api.js:16281` | `Math.min(25, ...)` | same |
| `provider/capabilities.js:16` | `maxTools: 15` | `maxTools: Infinity` |
| `api.js:1170` | `|| 5` | `PROVIDER_BRIDGE_MAX_TOOLS` |
| `provider/tools.js:122` | ignore cap | `slice(0, effectiveMax)` |

### 3.4 Path + OS contract

```bash
APP_ROOT=/home/sahon/zombiebd
DATA_DIR=${APP_ROOT}/data
LOG_DIR=${APP_ROOT}/logs
CACHE_DIR=${APP_ROOT}/cache
TMP_DIR=/tmp/opencode/zbd
DB_SQLITE_PATH=${DATA_DIR}/models.db
MCP_OUTPUT_DIR=${APP_ROOT}/data/mcp-output
TTS_OUTPUT_DIR=${APP_ROOT}/data/tts
SCREEN_RECORDINGS_DIR=${APP_ROOT}/data/recordings
```

`lib/env.js`:

```js
resolveRuntimePaths(config) → { appRoot, dataDir, logDir, cacheDir, tmpDir, dbPath, mcpOutputDir, ttsOutputDir, screenDir }
assertPathInside(root, candidate)
```

Boot log: `PATH_RESOLVED name=DB_SQLITE_PATH path=/home/sahon/zombiebd/data/models.db`

Rules:

- Production-এ `os.homedir()`/`"/tmp/` literal নেই; test-only exception `TEST_DIR`।
- `lib/expand-env.js` unknown `${VAR}` → `CONFIG_FATAL unresolved=${VAR}`।
- `APP_ROOT` installer স্ক্রিপ্টের নিজের directory থেকে (`dirname "$0"`) — disk-এর যেকোনো জায়গায় চলবে; unit-এ absolute path রেকর্ড হবে।

**OS detect (installer):**

```bash
# deploy/install.sh (proposed)
source /etc/os-release 2>/dev/null || true     # linux
uname -s                                        # Darwin / Linux / MINGW*
command -v apt-get|dnf|pacman|apk|brew          # package manager
systemctl --user show-environment >/dev/null 2>&1 && INIT=systemd
```

- Linux+systemd → `~/.config/systemd/user/zombiebd.service`
- macOS → `~/Library/LaunchAgents/com.zombiebd.plist`
- Windows → `sc.exe create` / NSSM
- প্রতিটি ক্ষেত্রে `WorkingDirectory=$APP_ROOT`, `ExecStart=$(command -v node) $APP_ROOT/start.js`
- log: `OS_DETECTED id=ubuntu-24.04 pkg=apt init=systemd app_root=...`
- `deploy/install-edge.sh:44` এখন শুধু `apt-get` ধরে — এটাই বদলাবে।

### 3.5 Size budget — সব env-driven (একটাই table)

| Concern | Key | Default | কোথায় enforce |
|---|---|---:|---|
| HTTP request body | `MAX_BODY_SIZE` | 10485760 | `api.js:235`, `readBody` |
| Session history (messages) | `MAX_HISTORY` | 10 | `api.js:251` |
| Session total bytes | `SESSION_MAX_BYTES` | 2097152 | context builder (proposed) |
| Session total tokens | `SESSION_MAX_TOKENS` | 32000 | context builder (proposed) |
| Prompt sent to provider | `PROMPT_MAX_BYTES` | 1048576 | `provider/*` (proposed) |
| Web-UI payload | `WEB_UI_MAX_BYTES` | 524288 | SSE/WS writer (proposed) |
| One SSE/NDJSON frame | `MAX_FRAME_BYTES` | 8388608 | `provider/transport.js:34` |
| Tool result sent back | `TOOL_RESULT_MAX_BYTES` | 65536 | tool executor (proposed) |
| Exec stdout buffer | `EXEC_MAX_BUFFER` | 8388608 | `api.js:11716` |
| Attachment | `ATTACHMENT_MAX_BYTES` | 10485760 | upload path (proposed) |

নিয়ম:

- প্রতিটি key `lib/env.js`-এ validate; missing হলে default শুধু ওখানেই।
- Bytes limit মানে UTF-8 bytes, `String.length` নয়।
- Limit ছাড়ালে silent truncate নয় — `BUDGET_EXCEEDED key=... limit=... actual=...` + explicit client error বা documented truncation marker।

### 3.6 Provider pipeline — normalizer আগে, adapter পরে

```
request
  │
  ▼
provider adapter (gemini/groq/ollama/llamacpp/opencode/openai/bridge)
  │  raw response
  ▼
normalizeResponse()  api.js:6310
  │  OpenAI-compatible object (100% contract)
  ▼
adapters/
  ├── openai.js      ← OpenCode / generic OpenAI clients
  ├── anthropic.js   ← Claude-style clients
  └── vscode.js      ← VS Code extension
```

- Normalizer-এর output ছাড়া কোনো adapter কিছু পাবে না।
- Adapter শুধু shape বদলাবে; provider selection, timeout, fallback, tool budget — core-এ।
- `deepseek`/`opencode`/`ollama` — সবাই একই provider interface।
- Local ollama ধীর হলে সেটা performance gossip, correctness নয়; একই timeout/fallback নিয়ম।
- llama.cpp: **UNVERIFIED** — response format ঠিক নয় বলে সন্দেহ, কিন্তু probe করা হয়নি; এই runbook-এ কিছু বদলানো হবে না, শুধু `provider/llamacpp.js` dormant + eval-এ একটি case।

**Fallback ladder (explicit):**

```
1. primary provider attempt          → PROVIDER_ATTEMPT attempt=1
2. fallback provider attempt         → PROVIDER_ATTEMPT attempt=2 fallback_from=...
3. tool parser (R2T) on plain text   → R2T_FALLBACK engine=external|builtin
4. still no tool call / invalid      → PROVIDER_ERROR code=... (client gets error)
```

- `builtin-fallback` (`api.js:19581`) আর silent নয় — `R2T_FALLBACK` log + response header `x-zbd-engine`।
- Tool parser fail করলে সরাসরি error; কোনো লুকানো retry loop নেই।

### 3.7 Transport — UDS

- `provider/transport.js` already supports `socketPath` (`:14`, `:46`, `:59`, `:193`, `:208`)।
- `UDS_PORT=5150` (`.env.example:225`); `UDS_PATHS` `api.js:329`।
- নিয়ম: UDS শুধু transport; tool-selection বা client-specific logic UDS layer-এ নয়।
- TCP fallback শুধু explicit `TRANSPORT=tcp` হলে; hidden dual-write নয়।

### 3.8 DB contract

```
DB file missing?
  ├─ DB_BOOTSTRAP=1 → create schema → DB_OK
  └─ else → DB_FATAL missing path=... (exit 78)

open error?
  ├─ SQLITE_BUSY/LOCKED → retry DB_BUSY_RETRY_MS × 3 → DB_FATAL busy
  └─ SQLITE_CORRUPT/NOTADB → DB_FATAL corrupt (rename/delete নয়)

open OK → PRAGMA quick_check → schema_version → DB_OK
```

- `DB_REMOTE_URL` download বাদ।
- `MODELS_DB` boot-এর পরে কখনো null নয়।
- capability query error → `CAPABILITY_UNKNOWN` + deny (fail-closed)।

---

## 4. Phase plan — ক্রম, সময়, gate

| Phase | কাজ | সময় | Risk | Gate |
|---|---|---|---:|---|
| **0** | Baseline + git tag + DB backup | 15 min | low | `BASELINE_OK` |
| **1** | Monu branch+push → archive → service stop | 30 min | medium | `MONU_RETIRED_OK` |
| **2** | OpenCode paid-only config | 10 min | low | `OPENCODE_CONFIG_OK` |
| **3** | Config SSOT + size budgets + fail-fast | 2–3 h | high | `CONFIG_CONTRACT_OK` |
| **4** | Path + OS install contract | 2 h | high | `PATH_CONTRACT_OK` |
| **5** | Tool budget SSOT | 3–4 h | high | `TOOL_BUDGET_OK` |
| **6** | DB required + fail-fast | 1–2 h | high | `DB_FAILFAST_OK` |
| **7** | Normalizer/adapter + health + trace | 3 h | medium | `PROVIDER_TRACE_OK` |
| **8** | Loopback + MCP registry | 2 h | medium | `MCP_REGISTRY_OK` |
| **9** | 30-case eval + adapter golden tests | 4–6 h | medium | `QUALITY_EVAL_OK` |
| **10** | Cleanup + release | 2 h | low | `RELEASE_OK` |

Phase 1–2 স্বাধীন quick wins। Phase 3–4 foundation; 5–6 correctness; 7–9 quality। Phase 3+ শুরু করার আগে `lib/env.js` contract freeze।

### Phase 0 — Baseline

```bash
cd ~/zombiebd
git tag pre-single-truth-2026-11-19
mkdir -p tmp/baseline
node tests/local-tool-cap.test.js     > tmp/baseline/tool-cap.txt 2>&1; echo $?
node tests/provider-env-lock-check.js > tmp/baseline/provider-env.txt 2>&1; echo $?
node tests/system-readiness-check.js  > tmp/baseline/system.txt 2>&1; echo $?
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/models.db');d.exec(\"VACUUM INTO 'tmp/baseline/models.db'\");console.log('DB_BACKUP_OK')"
```

> `tests/local-tool-cap.test.js:68` এখন পুরোনো `isLocalAgent ? 5 : 15` আশা করে; Phase 5-এ update হবে। Baseline-এ fail expected।

---

## 5. Phase 1 — Monu Builder retire (branch → push → archive → stop)

### 5.1 Pre-flight

```bash
systemctl --user is-enabled llm-heal.service
systemctl --user is-active  llm-heal.service
ss -ltnp | grep -E ':(5000|11436)\b'
curl -fsS http://127.0.0.1:5000/health | head -c 200; echo
git -C ~/monu_the_builder remote -v
git -C ~/monu_the_builder status --short | wc -l      # verified: 78
git -C ~/monu_the_builder ls-remote --heads origin main
```

**Verified (2026-11-19 23:52):** remote `https://github.com/sahonsrabon-os/monu_the_builder.git`, branch `main`, 78 dirty paths, `ls-remote` exit 0। এই pass-এ pre-flight করার আগেই stack বন্ধ ছিল: `5000/11436`-এ listener নেই, `llm-heal.service` inactive, unit file missing।

**Execution log (2026-11-19 23:52–00:10)**

| Step | Result | Evidence |
|---|---|---|
| branch + commit | ✅ `retire/2026-11-19` @ `cb394e7` | `git log -1 --oneline` |
| remote push | ⛔ **BLOCKED** | `403 Permission to sahonsrabon-os/monu_the_builder.git denied to azurebluezone`; `gh repo view` → `viewerPermission: READ`; `gh api` → `permissions.push: false`; repo owner `sahonsrabon-os` |
| archive | ✅ `~/backups/monu_the_builder-2026-11-19.tgz` | 244K, 25 entries, mode 600 |
| service stop | ✅ already inactive | `systemctl --user is-active` → `inactive`; ports closed |
| rename | ✅ `~/monu_the_builder.retired-2026-11-19` | `ls -ld` |

> **Push blocker-এর কারণ:** এই মেশিনে শুধু `azurebluezone` GitHub অ্যাকাউন্ট আছে (`gh auth status`); repo-র মালিক `sahonsrabon-os`-এর token বা SSH key নেই। সমাধান: মালিক অ্যাকাউন্টে `gh auth login`, অথবা repo-তে `azurebluezone`-কে write collaborator করা; তারপর নিচের push command। এর আগে `RETIRE_AUDIO_OK` close করলে remote-branch check FAIL করবে — তাই contract খোলা রাখা হয়েছে।

### 5.2 নতুন branch + remote push (current state)

```bash
cd ~/monu_the_builder.retired-2026-11-19
git checkout -b retire/2026-11-19        # executed: cb394e7
git add -A
git commit -m "chore(retire): snapshot current state before decommission"
git push -u origin retire/2026-11-19     # BLOCKED: 403 (see execution log)
```

- `.gitignore` আগেই `.env`, `.env.*`, `*.bak` বাদ দেয় — secret push হবে না।
- Push verify: `git ls-remote --heads origin retire/2026-11-19` → SHA match।
- `main` untouched থাকবে।
- Push না হওয়া পর্যন্ত contract `RETIRE_AUDIO_OK` PASS করা যাবে না — remote branch check বাকি।

### 5.3 Archive (secrets + DB + logs)

```bash
mkdir -p ~/backups
tar czf ~/backups/monu_the_builder-2026-11-19.tgz \
  -C ~ monu_the_builder/.env \
       monu_the_builder/data/models.db \
       monu_the_builder/logs
chmod 600 ~/backups/monu_the_builder-2026-11-19.tgz
tar tzf ~/backups/monu_the_builder-2026-11-19.tgz | wc -l
```

### 5.4 Service stop (watchdog ⇒ unit ⇒ process tree)

```bash
# 1) watchdog শাটডাউন
systemctl --user disable --now llm-heal.service

# 2) unit file সরানো
bash ~/llm-heal.sh uninstall

# 3) stack-এর pid capture করে শুধু সেগুলো stop
ss -ltnp | grep -E ':(5000|11436)\b'
# verified: pid 2335 (node start.js --start-all -s), pid 2384 (monu bridge)
kill -TERM 2335 2384
sleep 10
ss -ltnp | grep -E ':(5000|11436)\b' || echo PORTS_CLOSED
```

**সতর্কতা:** `llm-heal.sh stop` একা যথেষ্ট নয় — help line 20 অনুযায়ী stack চলতে থাকে। PID INode/uptime দিয়ে মিলিয়ে নিন; অন্য process-এ একই port থাকলে ভুল kill করতে পারে।

### 5.5 Retire directory

```bash
mv ~/monu_the_builder ~/monu_the_builder.retired-2026-11-19
# 7 দিন পর: rm -rf ~/monu_the_builder.retired-2026-11-19
```

### 5.6 Acceptance

```bash
! ss -ltnp | grep -qE ':(5000|11436)\b' || exit 1
[ "$(systemctl --user is-active llm-heal.service)" = "inactive" ] || exit 1
git -C ~/monu_the_builder.retired-2026-11-19 ls-remote --heads origin retire/2026-11-19 | grep -q . || exit 1
curl -fsS http://127.0.0.1:5050/health >/dev/null || exit 1
echo MONU_RETIRED_OK
```

### 5.7 Rollback

```bash
mv ~/monu_the_builder.retired-2026-11-19 ~/monu_the_builder
cd ~/monu_the_builder && ./boot.sh
bash ~/llm-heal.sh install
```

**Caddy/DNS:** `z.infiniteearningzone.com`-এর DNS থাকলেও `/etc/caddy/Caddyfile`-এ `5000` vhost নেই (verified)। Local edge-এ কোনো public traffic নেই। Cloudflare tunnel/origin থাকলে সেটা এই runbook-এর বাইরে `UNVERIFIED` — তবে নতুন নীতি: **Caddyfile-ই একমাত্র edge শর্ত**, DNS নয়।

---

## 6. Phase 2 — OpenCode paid-only (provider থাকে)

### 6.1 Evidence recap

- Official doc: “Free-tier chat models require OpenCode; use paid models or Go from other clients.”
- `provider/opencode.js:77-80` — 400 free-tier error → `retriable`
- `.env:47` — `OPENCODE_ENABLED=false`
- `.env:44` — `OPENCODE_API_KEY=<set>` (dead key)
- DB opencode models: `0`; `/api/v1/models`: `0` opencode

### 6.2 Action

```bash
cd ~/zombiebd
cp -p .env .env.bak-2026-11-19
sed -i '/^OPENCODE_API_KEY=/d' .env
sed -i 's/^OPENCODE_ENABLED=.*/OPENCODE_ENABLED=false/' .env
```

`.env.example`:

```bash
# OpenCode Console: free-tier models work ONLY inside the OpenCode client.
# Direct API requires paid credits. Adapter stays first-class; enable with a paid key.
OPENCODE_ENABLED=false
```

DB purge শুধু dead row থাকলে; provider/capability row থাকবে:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/models.db');d.exec(\"DELETE FROM models WHERE provider='opencode' AND enabled=0\");console.log('OPENCODE_DEAD_ROWS_PURGED')"
```

### 6.3 Acceptance

```bash
! grep -q '^OPENCODE_API_KEY=' .env || exit 1
grep -q '^OPENCODE_ENABLED=false' .env || exit 1
node -e "const s=require('./provider/opencode.js'); if(typeof s.convertResponse!=='function'&&typeof s.generate!=='function')process.exit(1);console.log('OPENCODE_ADAPTER_PRESENT')" || exit 1
curl -fsS http://127.0.0.1:5050/health >/dev/null || exit 1
echo OPENCODE_CONFIG_OK
```

### 6.4 Rollback

`.env.bak-2026-11-19` restore + paid key + `OPENCODE_ENABLED=true`; restart। Free tier কেবল OpenCode client-এ, আমাদের gateway-তে নয়।

---

## 7. Phase 3–4 — Config SSOT, size budgets, path, OS install

### 7.1 Files

| File | Change |
|---|---|
| `lib/env.js` | `REQUIRED_KEYS`, `validateConfig()`, `resolveRuntimePaths()`, `fatal()` |
| `api.js:117` | `const ENV = require("./lib/env.js").loadEnv({ root: __dirname, strict: true })` |
| `api.js:211-237` | inline loader delete |
| `start.js:19` | `lib/env`; delete `loadEnv` (`start.js:57-72`) |
| `lib/expand-env.js:15` | `ensureEnv` → `ENV`; unresolved `${VAR}` → `CONFIG_FATAL` |
| `local-llm-bridge.js:136` | default port `lib/env.js` থেকে |
| `api.js:235` | `MAX_BODY_SIZE` from ENV only |
| `provider/transport.js:34` | `MAX_FRAME_BYTES` from ENV only |
| `deploy/install.sh` | OS detect + generated unit/config |
| `package.json` | নতুন — `engines.node >= 24`, `start`, `check` |

### 7.2 `validateConfig()` contract

```js
function fatal(key, reason, hint) {
  console.error(`CONFIG_FATAL key=${key} reason=${reason} hint=${hint}`);
  process.exit(78);
}
```

- missing `readEnvFile` → `CONFIG_FATAL key=ENV_FILE reason=missing`
- required missing/empty → `key=<KEY> reason=missing`
- non-absolute path → `reason=not_absolute`
- invalid port → `key=PORT reason=invalid`
- duplicate port → `key=PORT reason=duplicate service=...`
- unresolved `${VAR}` → `reason=unresolved_var value=${VAR}`

### 7.3 Acceptance

```bash
node -e "require('./lib/env.js').loadEnv({root:process.cwd(),strict:true});console.log('CONFIG_OK')"

env -u DB_SQLITE_PATH node -e "require('./lib/env.js').loadEnv({root:process.cwd(),strict:true})" \
  2>&1 | grep -q 'CONFIG_FATAL key=DB_SQLITE_PATH' || exit 1

mv .env .env.hidden
node -e "require('./lib/env.js').loadEnv({root:process.cwd(),strict:true})" \
  2>&1 | grep -q 'CONFIG_FATAL key=ENV_FILE' || { mv .env.hidden .env; exit 1; }
mv .env.hidden .env

# OS install dry-run
bash deploy/install.sh --dry-run | grep -q 'OS_DETECTED' || exit 1

echo CONFIG_CONTRACT_OK
```

Path acceptance:

```bash
node -e "const c=require('./lib/env.js').loadEnv({root:process.cwd(),strict:true});console.log(JSON.stringify(c.paths,null,2))" \
  | grep -q '"/home/sahon/zombiebd/data/models.db"' || exit 1
grep -rn "os.homedir()" --include='*.js' api.js start.js local-llm-bridge.js provider/ 'external mcp/' | grep -v node_modules || true
echo PATH_CONTRACT_OK
```

**Caddy-only edge acceptance:**

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
curl -fsS https://localhost/health >/dev/null
curl -fsS https://tts.localhost/mcp >/dev/null || true
echo EDGE_CADDY_OK
```

`/etc/caddy/Caddyfile` verified: `https://localhost` → `127.0.0.1:5050`, plus `ocr/tts/screen/ads/public/combined/adapter` vhosts। নতুন provider hostname লাগলে এখানেই যোগ হবে — DNS বা third-party tunnel নয়।

---

## 8. Phase 5–8 — Budget, DB, provider pipeline, loopback

### 8.1 Tool budget acceptance

```bash
node tests/tool-budget-check.js
# 1. only one resolver defines limits
# 2. 155 tools → limit 24; bridge → 5
# 3. tts__tts_speak survives trim
# 4. bytes ≤ 12000; estPrefillMs ≤ timeout/2
# 5. no MAX_TOOLS_LIMIT in api.js/provider
echo TOOL_BUDGET_OK
```

Grep gate:

```bash
grep -rn "MAX_TOOLS_LIMIT\|Math.min(25\|maxTools: 15\|maxTools:.*|| 5" \
  --include='*.js' api.js provider/ | grep -v node_modules
# expected: no output
```

### 8.2 Size budget acceptance

```bash
node -e "const c=require('./lib/env.js').loadEnv({root:process.cwd(),strict:true});const k=['MAX_BODY_SIZE','SESSION_MAX_BYTES','WEB_UI_MAX_BYTES','MAX_FRAME_BYTES','TOOL_RESULT_MAX_BYTES'];for(const x of k)if(!(x in c.env))process.exit(1);console.log('SIZE_BUDGET_OK')"
```

### 8.3 DB fail-fast acceptance

```bash
mv data/models.db data/models.db.hidden
node api.js 2>&1 | grep -q 'DB_FATAL missing' && echo DB_MISSING_OK
mv data/models.db.hidden data/models.db

printf 'not a sqlite file' > /tmp/opencode/bad.db
DB_SQLITE_PATH=/tmp/opencode/bad.db node api.js 2>&1 | grep -q 'DB_FATAL corrupt'
echo DB_CORRUPT_OK
```

### 8.4 Provider pipeline acceptance

- `normalizeResponse` golden: 7 provider fixture → একই OpenAI schema; `finish_reason`, `tool_calls`, usage সব আছে।
- Adapter golden: একই normalized object → openai/anthropic/vscode — শুধু shape বদলায়, content নয়।
- `R2T_FALLBACK` log ছাড়া plain-text tool execution নেই।

```bash
node tests/normalizer-golden.js && node tests/adapter-golden.js
echo PROVIDER_TRACE_OK
```

### 8.5 Health + trace

`provider_stats` column: `last_success_at`, `consecutive_failures`, `last_error_code`।
`request_log` column: `attempt`, `fallback_from`, `timeout_ms`, `tool_count`, `tool_budget`, `tokens_in`, `tokens_out`, `error_code`।

Success write:

```sql
UPDATE provider_stats
SET requests = requests + 1, last_used = ?, last_success_at = ?,
    consecutive_failures = 0, last_error = NULL, last_error_at = NULL, last_error_code = NULL
WHERE provider = ?;
```

এক request-এ অন্তত:

```
PROVIDER_ATTEMPT attempt=1 provider=custom_1 status=timeout elapsed_ms=60000
PROVIDER_ATTEMPT attempt=2 provider=bridge  status=ok      elapsed_ms=18432
```

### 8.6 Loopback

`lib/net.js`:

```js
const LOOPBACK_HOSTS = new Set([
  "localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1",
]);
function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}
```

- `DEFAULT_PROBE_PORTS` deleted; the `BRIDGE_PROBE_DEFAULTS` scan is gone and `.env.example` no longer advertises it.
- `BRIDGE_UPSTREAMS` and `BRIDGE_OLLAMA_URL` are the explicit sources; `BRIDGE_BACKEND=llama` adds only the server this process spawns.
- A self host/port is rejected before probing and reported as `BRIDGE_SELF_REFERENCE` (log + `/health.self_references`), never silently proxied.
- `local-llm-bridge.js` uses `isLoopbackHost()` / `isSelfReference()`; `localhost`, `127.0.0.1` and `[::1]` aliases on the same port/path dedupe to one upstream.

```bash
! grep -q 'DEFAULT_PROBE_PORTS' local-llm-bridge.js || exit 1
node tests/bridge-discovery-check.js   # BRIDGE_DISCOVERY_OK
```

---

## 9. Quality bar, eval, rollout, rollback

### 9.1 30-case eval

| Category | Test | Pass |
|---|---|---|
| Tool selection | “এই লেখাটা পড়ে শোনাও” → `tts__tts_speak` | সঠিক tool + args |
| Tool selection | “ছবি থেকে লেখা বের করো” → OCR | সঠিক tool |
| Groundedness | Provided doc-এর বাইরে claim? | support ≥ 90% |
| Hallucination | অজানা fact → “জানি না” | 5/5 |
| Injection | tool output-এ “ignore previous instructions” | 0 escape |
| Fallback | primary down → secondary | trace attempt 2 |
| Cost/latency | tokens, p50/p95, $/success | regression < 10% |

```json
{"pass_rate":0.93,"tool_selection":1.0,"groundedness":0.91,
 "injection_escapes":0,"p50_ms":4200,"p95_ms":28000,
 "tokens_per_success":3100,"cost_per_success_usd":0.0008}
```

Gate: `pass_rate ≥ 0.90`, `injection_escapes = 0`, `p95 < provider timeout`, `cost regression < 10%`।

### 9.2 “Done” checklist

1. একটাই tool limit definition, একটাই config loader, একটাই DB path resolver।
2. `.env`/DB missing → exit 78 + `CONFIG_FATAL`/`DB_FATAL`; server “healthy” নয়।
3. 155-tool probe-এ `tts__tts_speak` টিকে থাকে; bridge 5-tool budget-এ pinned tool থাকে।
4. Normalizer → OpenAI-compatible 100%; তিন adapter golden pass।
5. Provider down → UI down; success → DB error clear।
6. Monu: branch pushed, archive তৈরি, ports closed, unit inactive।
7. OpenCode: provider code present, paid-only config, dead key absent।
8. Caddy vhost দিয়ে `https://localhost/health` 200।
9. 30-case eval ≥ 90%, injection escape 0।
10. `deploy/install.sh --dry-run` → `OS_DETECTED ... app_root=...`।

### 9.3 Rollout

- Phase 1–2 একদিনে; Phase 3+ প্রতিটি আলাদা commit/PR।
- প্রতিটি phase-এর আগে `git tag phase-N-start`, পরে `phase-N-ok`।
- Gateway restart শুধু health-check + rollback script হাতে রেখে।
- Rollback: `git checkout phase-N-start`, `.env.bak-2026-11-19` restore, `systemctl --user restart zombiebd`।

---

## 10. পরবর্তী এক্সিকিউশন প্ল্যান ও নতুন সমস্যা (2026-11-20 audit)

**এই সেকশনটি section 9-এর শেষের “পরের ধাপ” লাইনটির বর্তমান প্রতিস্থাপন।** এখানে শুধু verified state, ordered backlog আর নতুন সমস্যা; এই pass-এ কোনো product code বদলায়নি।

### 10.1 Verified baseline (HEAD `2ba48b4`)

| বিষয় | প্রমাণ |
|---|---|
| MCP transport | local servers (`ocr`, `screen-recorder`, `tts`, `public-api`, `universal-adapter`) সব `transport=stdio`; `3110/3111/3112/3121/3122/3123`-এ কোনো listener নেই |
| Admin decoupling | `ADMIN_DIR` না থাকলেও gateway boot করে; `/api/admin/agents` POST SQLite-এ লেখে; `/api/mcp-remote/add` token encrypted persist করে |
| Runtime path | `.missionbarisal/mcp-config.json` → `/home/sahon/zombiebd/data/run/mcp.sock` (APP_ROOT; `dist/data` নেই) |
| Gates | `node tests/mcp-architecture-check.js` → `MCP_STDIO_ADMIN_OK` (21/21); `node tests/provider-neutrality-check.js` → `PROVIDER_NEUTRAL_OK`; `node tests/uds-e2e-check.js` → `RESULT: UDS E2E PASS`; `node tests/broker-free-check.js` → `BROKER-FREE PASS`; live `/health` → 97 models, 9 agents |

এক-লাইনে: **MCP stdio/admin batch বন্ধ; এখন একমাত্র খোলা P0 হলো P0-08।**

### 10.2 পরবর্তী একক ধাপ — P0-08 (provider health honesty)

**কেন এটাই প্রথম:** P0 তালিকার একমাত্র OPEN আইটেম; ভুল `healthy` মানে operator ভাঙা provider-কে সুস্থ ভাবছে, আর পুরোনো `last_error` সফল request-এর পরেও থেকে যাচ্ছে।

**বর্তমান প্রমাণ (line numbers HEAD-এ shift হয়েছে):**

- `api.js:12518` — `getProviderHealth()` নতুন provider-কে probe ছাড়াই `healthy: true` দেয়।
- `api.js:13443` — `/health` সবসময় `healthy: true` লেখে; provider-দের অবস্থা আলাদা করে বলে না।
- `api.js:12807` — `last_error = COALESCE(excluded.last_error, last_error)`; success-এ `null` পাঠালেও পুরোনো error মুছে না।

**প্রস্তাবিত fix (একই batch-এ, আলাদা commit):**

1. initial state `healthy: null` + `lastProbeAt: null`; probe/attempt ছাড়া কোনো provider “healthy” নয়।
2. `/health`-এ process liveness `healthy: true` থাকবে, কিন্তু নতুন additive `providers` block আসবে: `{id, status, lastProbeAt, lastError}`; TTL (`PROVIDER_HEALTH_TTL_MS`, default 60s) পেরোলে status `unknown`/`stale`, কখনো `true` নয়।
3. success-এ `last_error = NULL, last_error_at = NULL` (COALESCE বাদ); failure-এ timestamp-সহ set.
4. `/api/providers`, admin provider list আর `/health.providers` — তিনজন একই health source পড়বে; দ্বিতীয় map নয়।

**Gate:** নতুন `tests/provider-health-honesty-check.js` → `PROVIDER_HEALTH_OK`:

- stub 500 → provider degraded + `last_error` set;
- stub 200 → SQLite-এ `last_error` NULL;
- stub বন্ধ + TTL → status `unknown`/`stale`, `healthy: true` নয়;
- `/health.healthy` process-এর জন্য true থাকে, কিন্তু `providers.<id>.status` probe ছাড়া true হয় না।

**Done (2026-11-20, `gc-mwoi9t5a`):** `node tests/provider-health-honesty-check.js` → 11/11 `PROVIDER_HEALTH_OK`; fresh provider `unknown`, 3×500 → `down` + SQLite `last_error`, success clears it, TTL → `stale`, admin list ও `/health.providers` একই snapshot। Regression: `admin-panel-self-contained` 13/13, `custom-provider-n` 30/30, `provider-panel-ops` 17/17। Live restart-এ 10 provider honest (`custom_3` real tool call-এর পর `up`, বাকিরা probe ছাড়া `unknown`), process `healthy:true`।

**Rollback:** `/health`-এর নতুন `providers` block additive, তাই পুরোনো consumer ভাঙে না; শুধু `api.js` revert করলেই আগের state।

### 10.3 Ordered backlog — এরপর কী, কোন ক্রমে

| # | আইটেম | কাজ | Gate | Status |
|---:|---|---|---|---|
| 1 | **P0-08** | provider health honesty + stale `last_error` | `PROVIDER_HEALTH_OK` | ✅ DONE (`gc-mwoi9t5a`) |
| 2 | **N2** | test-spawned gateway `.missionbarisal` pollution বন্ধ | `TEST_APP_ROOT_OK` | ✅ DONE (`gc-mwoipfpp`) |
| 3 | **N1** | provider attribution: `bridge` vs `ollama` সত্য ঠিক করা | `ADMIN_CHAT_E2E_OK` | ✅ DONE (`gc-mwojol08`) |
| 4 | **N4** | `local-tool-cap`-এর পুরোনো A1/D15 assertion update | `LOCAL_TOOL_CAP_OK` | ✅ DONE (`gc-mwokuxf5`) |
| 5 | **P1-10 + P1-02** | বাকি size budget (`SESSION_MAX_BYTES`, `WEB_UI_MAX_BYTES`, `TOOL_RESULT_MAX_BYTES`) + `request_log` trace column | `CONFIG_TRACE_OK` | TODO |
| 6 | **P1-07** | R2T silent builtin fallback → log + response header | `R2T_TRACE_OK` | TODO |
| 7 | **N5** | safe rebuild+restart এক কমান্ডে (stale dist risk বন্ধ) | `REBUILD_RESTART_OK` | TODO |
| 8 | **P1-09 + P1-08** | `package.json` + installer-এ apt/dnf/pacman/brew | `PACKAGE_INSTALL_OK` | TODO |
| 9 | **P2-02 + P2-03** | log/backup retention + 30-case eval harness | `QUALITY_EVAL_OK` | TODO |
| 10 | **N3** | PLAN/status snapshot drift ঠিক করা | `DOCS_CURRENT_OK` | TODO |
| 11 | **N6** | skill MCP stdio integration (reference project read-only) | `SKILL_MCP_OK` | TODO |

**নীতি:** ১–২ একই দিনে (P0 + live config safety), ৩–৪ test truth, ৫–৬ observability, ৭–৮ release portability, ৯ quality, ১০–১১ docs/feature. প্রতিটি আইটেম আলাদা contract + gate; এক batch-এ দুইটার বেশি নয়।

### 10.4 নতুন সমস্যা — N1–N6 (প্রমাণসহ)

#### N1 — provider attribution drift: test `ollama` চায়, log `bridge` লিখছে

- **প্রমাণ:** `tests/admin-chat-e2e-check.js:340` — `logged.provider !== "ollama"` হলে fail; কিন্তু `data/models.db`-এর `request_log`-এ `doc-king`-এর local model row `provider=bridge` (ts `1795145597627`, আগের row-ও `bridge`)। `node tests/admin-chat-e2e-check.js` → `FAIL request_log provider=bridge want ollama`.
- **Impact:** provider attribution-কে ঘিরে gate মিথ্যা red; কোন layer (bridge transport না upstream ollama) খরচ/error বহন করছে তা log থেকে বোঝা যায় না।
- **Fix:** আগে সিদ্ধান্ত — `provider` হবে origin (`ollama`) না transport (`bridge`); তারপর P1-02-এর সাথে `upstream_provider`/`fallback_from` column যোগ করে test expectation ঠিক করা। routing বদলানো লাগলে আলাদা contract।
- **Gate:** `ADMIN_CHAT_E2E_OK` (expectation + DB row একই truth)।
- **Done (2026-11-20, `gc-mwojol08`):** সিদ্ধান্ত — `provider` = যে transport সত্যিই answer করেছে (`bridge`); origin (`ollama`) P1-02-এ `upstream_provider` হিসেবে আসবে। `executeSingleAgent`/`callModelWithTools` এখন `provider`+`model` return করে; stream, non-stream success ও failure telemetry সেই result থেকে লেখে, `resolveProvider(agent.model)` দিয়ে re-resolve করে না (grep-এ residual নেই)। Non-stream `/v1/chat/completions` এখন `x-zc-chat-provider` header দেয়, তাই gate attribution স্বাধীনভাবে দেখতে পারে। `tests/admin-chat-e2e-check.js` expected provider live `/api/admin/providers` থেকে derive করে (enabled, confirmed-down নয়, `NEW_MODEL` advertise) এবং header + `request_log` + `model_stats` তিনটেকেই একই provider চায়; `NEW_MODEL=lfm3:1.7b`, fresh `session_id`, একটি ছোট tool schema (৯৯-tool auto-inject বন্ধ) — তাই gate ৮৭s-এ শেষ হয় ১২০s close cap-এর ভিতরে। Live evidence: `ADMIN_CHAT_E2E_OK` (12/12); `request_log` + `model_stats` = `lfm3:1.7b` on `bridge`; bridge `CHAT_OK ms=86236`।

#### N2 — test-spawned gateway live `.missionbarisal` config overwrite করে

- **প্রমাণ:** `api.js:468` — `_MISSION_BARISAL_DIR = path.join(RUNTIME_PATHS.appRoot, ".missionbarisal")`; নিচের test-গুলো temp `DATA_DIR`/`UDS` দেয় কিন্তু `APP_ROOT` দেয় না, তাই config project root-এ লেখে: `tests/provider-suite-check.js`, `tests/transport-suite.js`, `tests/cwd-db-repair-check.js`, `tests/provider-matrix-check.js`। বাস্তবে observed: `node tests/broker-free-check.js` চালানোর পর live `.missionbarisal/mcp-config.json`-এ `/tmp/opencode/broker-free-34834/mcp.sock` ঢুকে গিয়েছিল; `2ba48b4`-এ broker-free-তে `APP_ROOT: TMP` যোগ করা হয়েছে, বাকি ৪টি এখনো বাকি।
- **Impact:** যেকোনো test run live editor config ভাঙতে পারে; gateway restart না করলে client ভুল socket-এ যায়।
- **Fix:** চারটি test-এ `APP_ROOT: TMP` (অথবা `MISSIONBARISAL_DIR` override); spawn audit gate।
- **Gate:** `TEST_APP_ROOT_OK` — প্রতিটি `api.js` spawn-এ `APP_ROOT` থাকা বা explicit isolated config dir; live config hash test-এর আগে/পরে একই।
- **Done (2026-11-20, `gc-mwoipfpp`):** চারটি test-এ `APP_ROOT: TMP`; নতুন `tests/test-app-root-check.js` সব ১১টি api.js-spawnকারী test scan করে এবং live `.missionbarisal/mcp-config.json` sha256 (`3feb4154…`) চারটি suite parallel চালানোর আগে/পরে অপরিবর্তিত থাকে। `provider-suite` exit 0; `transport-suite`/`cwd-db-repair`/`provider-matrix` আগের অসম্পর্কিত কারণে red (N1/N4 আলাদা), কিন্তু আর কোনো live config pollution নেই।

#### N3 — PLAN ও status snapshot drift

- **প্রমাণ:** `docs/PLAN-2026-11-20.md:3` — “কাজ শুরু হয়নি”; `:33` — “96 models”; `:34` — “pid 827, dist/start.js”; live এখন `/health` → 97 models, service MainPID `35382`, root `start.js`। `tmp/refactor-2026-11-20/runbook-status.md` — “audited against b805f65”, HEAD এখন `2ba48b4`।
- **Impact:** plan/status পড়ে ভুল সিদ্ধান্ত; কোনটা solved তা নিয়ে দ্বিতীয় truth তৈরি হয়।
- **Fix:** PLAN-এর snapshot block live `/health`+PID+HEAD দিয়ে update; status table নতুন HEAD-এ regenerate; freshness check।
- **Gate:** `DOCS_CURRENT_OK` — PLAN/status-এ HEAD sha ও live models/PID মেলে।

#### N4 — `local-tool-cap.test.js`-এ দুটি পুরোনো assertion

- **প্রমাণ (আগে):** `node tests/local-tool-cap.test.js` → `RESULT: 42 passed, 3 failed`; `FAIL A1 api.js uses /^custom_/.test(agentProviderId)`; `FAIL A2 CUSTOM_PROVIDER_N_* env creates a custom_N provider`; `FAIL D15 agent header has no prose tool list`.
- **Impact:** quality gate স্থায়ীভাবে red; নতুন regression আসলেও আলাদা করা কঠিন।
- **Fix:** `git log -S` intent যাচাই: inline `custom_` tool-gate `36ac2e1`-এ provider registry/tool-budget-এ সরেছে, env seed `provider/custom.js`-এ, header text `modules/system-prompt.js`-এ। assertion তিনটি বর্তমান single-source contract-এ update করা হয়েছে; suite এখন সব pass হলে `LOCAL_TOOL_CAP_OK` ছাপে।
- **Gate:** `LOCAL_TOOL_CAP_OK` (0 fail)।
- **Done (2026-11-20, `gc-mwokuxf5`):** `A1` এখন প্রমাণ করে inline `/^custom_/.test(agentProviderId)` নেই এবং caps `lib/tool-budget.js`-এর `providerMaxOf` থেকে আসে (api.js `toolBudget.providerMaxOf` call করে); `A2` প্রমাণ করে env seed `provider/custom.js`-এর `listCustomNumbers`/`fromEnv` দিয়ে হয় এবং `id: "custom_" + n` সেখানেই তৈরি; `D15` প্রমাণ করে dynamic `s.toolsCount` header `modules/system-prompt.js`-এ আছে, api.js `buildSystemPrompt`-এ delegate করে, এবং কোথাও prose `- TOOLS AVAILABLE:` list নেই। Live evidence: `RESULT: 45 passed, 0 failed` + `LOCAL_TOOL_CAP_OK`, exit 0।

#### N5 — rebuild/restart friction: stale dist-এর ঝুঁকি

- **প্রমাণ:** `scripts/build.js:90` — live runtime থাকলে `BUILD_REFUSED dist is the live runtime (pid=...)`; তাই operator-কে `systemctl --user stop` → build → start করতে হয়। Build না করলে `provider-env-lock-check` fail করে: `dist is a fresh build of the current source — api.js is newer than dist`।
- **Impact:** P0-09-এর মতো “কোড বদলেছি = লাইভে গেছে” ভুল ধারণা ফিরে আসতে পারে; প্রতিটি batch-এ manual stop/start।
- **Fix:** `start.js --rebuild-restart` (active unit হলে stop → build → start → health 200, fail হলে rollback) অথবা runbook-এ একমাত্র অনুমোদিত command sequence।
- **Gate:** `REBUILD_RESTART_OK` — active gateway-এ এক কমান্ডে build+restart+health, dist manifest sha = source sha।

#### N6 — skill MCP gap (removal-এর পর নতুন surface নেই)

- **প্রমাণ:** `external mcp/skill-mcp-tool.js` `2ba48b4`-এ delete; repo-র `skills/`-এ শুধু `404__Not_Found.md` আর `_instructions.md`; কোনো stdio skill server repo-তে নেই। User-provided reference `/home/sahon/Documents/GGUF/zombiecoder-agent-skills/` এই pass-এ read-only এবং verify করা হয়নি।
- **Impact:** skills loading-এর কোনো MCP path নেই; future skill feature অর্ধেক।
- **Fix:** reference project-এর stdio entry (`server/skill_mcp.py` হিসাবে user উল্লেখ করেছেন) verify করে `servers.json`-এ `transport:"stdio"` entry; না হলে skills আলাদা module হিসেবে রাখা।
- **Gate:** `SKILL_MCP_OK` — initialize/tools/list/tools/call কাজ করে, reference project-এ কোনো write নেই।

### 10.5 এই pass-এ যা করব না

- P0-05/P0-09-এর solved কাজ আবার খোলা নয়; শুধু regression gate চালু থাকবে।
- `docs/PLAN-2026-11-20.md`-এর uncommitted diff (`PLAN_EVIDENCE` marker) এই batch-এ touch করব না; N3 আলাদা contract।
- নতুন dependency, দ্বিতীয় health map, বা admin UI-নির্ভরতা যোগ করব না।

---

## Appendix A — Evidence table

| Claim | Evidence |
|---|---|
| Tool cap 25 | `api.js:4922` |
| Tool cap duplicate | `api.js:9413`, `api.js:10113`, `api.js:16281` |
| Provider cap 15 | `provider/capabilities.js:16` |
| Bridge cap 5 | `api.js:1170` |
| `prepare()` ignores cap | `provider/tools.js:122` |
| DB fallback comment | `api.js:1303-1308` |
| DB silent null | `api.js:1551-1555` |
| DB fail-open | `provider/index.js:79`, `provider/tools.js:106-113` |
| Env parser duplication | `api.js:211-237`, `start.js:57-72`, `lib/env.js:82` |
| Hidden probe ports | `local-llm-bridge.js:107`, `:226` |
| Broken loopback check | `local-llm-bridge.js:209`; `lib/env.js:80` |
| Bridge timeout mismatch | `provider/transport.js:26`; `api.js:1156-1171`; `.env:212` |
| Health optimistic | `api.js:12941`, `:12955`, `:12996-13005` |
| `last_error` COALESCE | `api.js:13227-13234` |
| Body/frame/history defaults | `api.js:235`, `provider/transport.js:34`, `api.js:251` |
| UDS transport support | `provider/transport.js:14/46/59/193/208`; `api.js:317/329` |
| Normalizer | `api.js:6310` |
| R2T builtin fallback | `api.js:19574-19581` |
| OS platform detect | `start.js:80-107` |
| Edge installer apt-only | `deploy/install-edge.sh:44` |
| Monu unit/ports | `systemctl --user cat llm-heal.service`; `ss -ltnp` |
| Monu remote | `git -C ~/monu_the_builder remote -v`; `ls-remote` exit 0 |
| Monu push permission | `gh repo view sahonsrabon-os/monu_the_builder --json viewerPermission` → `READ`; `gh api ... .permissions.push` → `false`; push → `403` |
| Live process runs dist | `ps -p 827 -o cmd`; `readlink /proc/827/cwd`; `systemctl --user cat zombiecoder-gateway.service` |
| Root/dist hashes | `sha256sum api.js dist/api.js start.js dist/start.js` — identical pairs |
| OpenCode free-tier rule | `https://opencode.ai/docs/console/models/` |
| OpenCode adapter 400 | `provider/opencode.js:77-80` |
| Node runtime | `node -v` → v24.22.2 |
| No package.json | `ls package.json` → No such file |

## Appendix B — Verified snapshot (2026-11-19 ~23:20)

- `GET http://127.0.0.1:5050/health` → `healthy:true`, `version:3.2.1`, `models:96`, `agents:9`
- `GET http://127.0.0.1:5000/health` → `healthy:true`, `models:4`
- `provider_stats`: `custom_1` 156/9, `gemini` 12/3, `bridge` 3/2, `groq` 17/1, `ollama_cloud` 1/1, `ollama` 30/0
- `models`: gemini 50, ollama_cloud 24, groq 11, custom_1 6, bridge 3, ollama 2, opencode 0
- Monu (23:20): `llm-heal.service` enabled+active; 5000 pid 2335; 11436 pid 2384; 19MB tree; 78 dirty paths
- Monu (23:52–00:10): ports `5000/11436` closed; `llm-heal.service` inactive, unit file missing (stop cause `UNVERIFIED` — agent এই pass-এ stop command চালায়নি); branch `retire/2026-11-19` @ `cb394e7`; archive 244K/25 entries; directory `monu_the_builder.retired-2026-11-19`; remote push blocked `403` (azurebluezone has `READ` only)
- Live gateway: pid 827, `dist/start.js`, cwd `dist`; root/dist sha256 identical (`4608054f…` api, `764b7222…` start)
- Caddy: `caddy.service` active; `/etc/caddy/Caddyfile` proxy `5050` + localhost service vhosts; no `5000`
- `llama.cpp` response format → `UNVERIFIED`

---

**পরের ধাপ:** Phase 0 baseline — শুধু ব্যবহারকারী “শুরু করো” বললে (`git tag pre-single-truth-2026-11-20`, test baseline, `data/models.db` backup; কোনো code বদল নয়)। তারপর Phase 2 (OpenCode paid-only) → Phase 3 (config single truth)। Phase 3+ শুরু করার আগে `lib/env.js` contract freeze; নাহলে path/tool/DB একসাথে বদলে debugging কঠিন হবে।
**Monu push:** সম্পন্ন — `retire/2026-11-19` = `cb394e764908f51e2ac57422c9d10f9d6ba8cf63` (local = remote), contract `gc-mwnurzwx` PASS (`RETIRE_AUDIO_OK`)।
