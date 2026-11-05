# EDGE-RUNTIME-SPEC

**Project:** `continue` (Mission Barisal / ZombieCoder Gateway)
**Contract:** `gc-mvzmfjdw`
**Owner:** Chair / Chief Arbiter
**Status:** Phase 1 in progress
**Date:** 2026-11-03

---

## 0. Contract

### Goal

Caddy-কে একমাত্র edge বানানো। `80`/`443`-এ সরাসরি bind, নিজের TLS termination ও verify। Cloudflare tunnel বা অন্য কোনো third-party resource যেন system-এর runtime dependency না হয়। একই সঙ্গে runtime configuration-এর একমাত্র সত্য হবে environment variables; port বা domain কোথাও hardcode থাকবে না।

### Input (user order, 2026-11-03)

1. Caddy একমাত্র edge; `80`/`443` নির্দিষ্ট bind; SSL/TLS verify direct.
2. Port পরিবর্তন অনুমোদিত।
3. `universal-adapter/plugin/` সরানো — এই folder-এ dependency install হবে না; upstream open-source plugin-ই যথেষ্ট।
4. Cloudflare tunnel থাকবে, কিন্তু system তার উপর নির্ভর করবে না।
5. Tools এই মুহূর্তে open (personal deployment); authentication পরে।
6. Tool logic ও code check করা; যেখানে ভাঙা, শুধু সেখানে touch করা।
7. দুটি script: build script (`dist/` তৈরি, সেখান থেকেই runtime) এবং installer (Node 24 minimum, Linux/Windows অনুযায়ী Caddy install বা configure, git clone → one-click ready)।
8. UDS port check; API server-এর ভেতরে duplicate local/Ollama/agent logic খুঁজে বের করা।
9. Env var-ই একমাত্র SSOT; runtime env loader; কোনো hardcoded domain নয়।
10. `80`–`443` bind করার permission বজায় রাখা; server যেকোনো OS folder থেকে চলতে পারবে।
11. Runtime-এ DB তৈরি ও seed নিশ্চিত করা; পূর্ণাঙ্গ authentic output দিয়ে test করা।
12. Code clean, code-এর ভিতরে বাংলা নয়।

### Deliverables (phase-wise)

| Phase | Deliverable | Contract |
| --- | --- | --- |
| P1 | এই spec, `lib/env.js`, `scripts/check-env.js`, `deploy/tools.json`, `scripts/caddy-render.js`, plugin removal, port/bind/origin/UDS fixes | `gc-mvzmfjdw` |
| P2 | `scripts/build.js` + `dist/` manifest + run-from-dist proof | next |
| P3 | `scripts/install.sh`, `scripts/install.ps1`, systemd unit, Windows service, Caddy install/upgrade, capability setup | next |
| P4 | Live Caddy `:80/:443` + TLS verify + WS/SSE + fresh DB seed + any-folder + permission proof | next |

### Acceptance (P1)

`caddy validate` must return `Valid configuration`; `scripts/check-env.js` must resolve every service port with no duplicates; the removed plugin path must not exist or be referenced.

### Non-goals (P1)

- Tool authentication (user decision: open for now).
- Public ACME certificate issuance (needs DNS + inbound `80/443`; phase P4).
- Deleting or rewriting provider/agent code. Only broken seams are touched.

---

## 1. Current live state (verified 2026-11-03)

| Check | Observed |
| --- | --- |
| `ss -ltn` | Nothing on `5050`, `443`, `5400`, `5443`, `3110–3123` |
| `curl http://127.0.0.1:80` | `Server: nginx/1.24.0` — nginx owns `:80` |
| `pgrep -a caddy` | Not running; binary `~/.local/bin/caddy` = `v2.11.7` |
| `find ~/continue -iname Caddyfile` | None |
| `getent hosts api.zombiecoder.my.id` | Cloudflare IPs (`2606:4700:...`) |
| `curl -I https://api.zombiecoder.my.id/status` | `HTTP/2 502` |
| `ss -ltnp` | `127.0.0.1:5050` held by `/home/sahon/zombie/src/server.js` |
| `node api.js` on test port `15050` | `/status` → `200` in ~2.5s |
| Fresh DB (`/tmp/opencode/smoke/models.db`) | `models=84`, `agents=9`, `users=1` |

Conclusion: the stack itself boots; the broken part is the edge and the configuration truth, not the Node runtime.

---

## 2. Autopsy — inconsistencies that survive a Caddy install

| # | Finding | Evidence | Impact |
| --- | --- | --- | --- |
| A1 | `BIND_HOST` is ignored | `api.js:16795-16801` derives bind from `DETECTED_DOMAIN`; `grep process.env.BIND_HOST` = 0 hits | FQDN `APP_URL` makes the API bind `0.0.0.0:5050`; Caddy TLS is bypassable over plain HTTP |
| A2 | CORS allowlist lacks the public HTTPS origin | `.env:51`; `api.js:11891-11917`; `domain-config.js:116` | `https://api.zombiecoder.my.id` gets `Access-Control-Allow-Origin: http://localhost:5010` |
| A3 | Wildcard origin is not implemented | `api.js:11901` exact/prefix only | `https://*.zombiecoder.my.id` never matches; tool subdomains get 403 |
| A4 | `mcpOriginAllowed` accepts only loopback + exact domain | `api.js:3776-3790` | Any proxied tool host or alternate hostname is rejected |
| A5 | Six tool backends have no auth and send `ACAO: *` | `external mcp/ocr-mcp.js:569`, `tts-mcp.js:349`, `screen-recorder-mcp.js:402`, `public-api-mcp.js:929`, `facebook-ads-mcp.js:321`, `combined.js:188` | Open exposure is a deliberate P1 choice; must be written down, not forgotten |
| A6 | `BROKER_PORT=5050` collides with a live process | `.env:189`; `ss` pid 4604 | Broker dies with `EADDRINUSE` and the launcher hides it |
| A7 | Generated editor configs hardcode stale `5000` | `api.js:430-520` merge order `{...defaultData, ...existing}`; `.missionbarisal/*.json` | Stale values survive every boot; clients point at a dead port |
| A8 | `mcp-config.json` advertises stdio `node start.js` | `api.js:437`; `start.js` default path opens `showMenu()` | Editor spawns a menu, not an MCP stdio server |
| A9 | `UDS_PORT` is inert | `api.js:246`, `api.js:16678-16683` uses `PORT+1` on Windows | Documented port `5150` is never used; Windows silently takes `5051` |
| A10 | `BROKER_PORT` default disagrees with `.env` | `php-broker-server.js:35` default `9998`; `.env` `5050` | Two sources of truth for the same port |
| A11 | `FRONTEND_DIR=./frontend` does not exist | `.env`; `php-broker-server.js:125-142`; `ls frontend` fails | Broker UI and its `.session/.projects` files cannot work |
| A12 | Adapter ships its own self-signed TLS on `5443` | `universal-adapter/index.js:36`; `tls.js` | Double TLS / cert warnings if proxied through Caddy; proxy must target `5400` |
| A13 | Adapter plugin pulls an external dependency | `universal-adapter/plugin/node_modules -> /home/sahon/z/zen-plugins/node_modules` | Violates "no dependencies in this folder"; removed in P1 |
| A14 | Existing Caddyfiles expose `?XTransformPort=` | `~/Desktop/*/Caddyfile` | Open proxy/SSRF pattern; must never be copied into this project |
| A15 | Duplicate provider/transport logic | `chatStream` in 7 files, `listModels` in 6, `executeTool` in 6, `chat` in 6 (`provider/*.js`, `api.js`, adapters) | Provider-specific duplication is legitimate; cross-transport duplication is the risk area |
| A16 | Two LLM paths exist | `local-llm-bridge.js` (11435 → Ollama 11434) and `provider/ollama.js` (direct) | Keep the bridge as one hop; document which path owns what |

Note on A15: per-provider `chat/chatStream/listModels` (gemini, groq, ollama, openai, opencode) is expected adapter shape, not accidental duplication. The real duplicates to watch are `executeTool` (6) and `handleRpc` (4) between `universal-adapter`, `external mcp`, and `api.js`. P1 records them; consolidation is scheduled only if a real behaviour conflict appears.

---

## 3. Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D1 | Caddy is the only edge and owns `:80` and `:443` | User order; removes tunnel dependency from the runtime path |
| D2 | nginx must release `:80` before Caddy start | Live evidence: nginx owns it; two binders cannot coexist |
| D3 | Caddy upstreams are fixed loopback addresses, never query-driven | `XTransformPort` is an open proxy (A14) |
| D4 | Env is the only SSOT; defaults live in exactly one schema (`lib/env.js`) | User order; kills A6/A7/A9/A10 |
| D5 | No domain literal in runtime code; `APP_URL`/`MAIN_HOST`/`TOOL_BASE_DOMAIN` provide every host | User order |
| D6 | Tools stay unauthenticated for now; risk accepted and recorded | User order; personal deployment |
| D7 | Tool exposure uses subdomains from `TOOL_BASE_DOMAIN`; path-prefix routing is rejected | Every MCP server serves `/mcp` at root and SSE returns an absolute `/mcp` endpoint |
| D8 | Caddy TLS mode is env-driven: `internal` for local/verify, `acme` for public | Public ACME needs DNS-only record + inbound 80/443, which are external prerequisites |
| D9 | `dist/` is the runtime; source tree is only for development | User order; build script will copy, render and checksum |
| D10 | Unprivileged process + `CAP_NET_BIND_SERVICE` (systemd ambient capability or `setcap`) | Bind 80/443 without running Node as root |
| D11 | `universal-adapter/plugin/` is deleted; adapter keeps HTTP/HTTPS/stdio | User order; no local dependency install |

---

## 4. Target architecture

```text
client (https/wss)
        |
        v
  Caddy  :443 / :80        TLS termination, redirect, no scope for query-routing
        |
        +--> 127.0.0.1:5050   main API + MCP (/mcp, /status, /api/*)
        +--> 127.0.0.1:3110   ocr
        +--> 127.0.0.1:3111   screen-recorder
        +--> 127.0.0.1:3112   tts
        +--> 127.0.0.1:3121   facebook-ads
        +--> 127.0.0.1:3122   public-api
        +--> 127.0.0.1:3123   combined
        +--> 127.0.0.1:5400   universal-adapter (HTTP only)
        +--> 127.0.0.1:9998   php-broker (not public by default)

internal only: Ollama 11434, bridge 11435, adapter HTTPS 5443,
               UDS /tmp/zombiecoder/mcp.sock, Windows TCP 5150
```

Request path: client → Caddy (`https`) → loopback upstream (`http`) → Node. Caddy adds `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP`; the app must trust them only from loopback.

---

## 5. Port map (single source)

| Env key | Default | Service | Bind | Public via Caddy |
| --- | ---: | --- | --- | --- |
| `PORT` | `5050` | main API / MCP | `BIND_HOST` (`127.0.0.1`) | yes (`MAIN_HOST`) |
| `UDS_PORT` | `5150` | Windows TCP fallback for UDS | `127.0.0.1` | no |
| `UDS_PATH` | `/tmp/zombiecoder/mcp.sock` | Linux UDS | filesystem `0660` | no |
| `BROKER_PORT` | `9998` | php-broker | `127.0.0.1` | only if explicitly mapped |
| `FRONTEND_PORT` | `8081` | broker frontend | `127.0.0.1` | only if explicitly mapped |
| `OCR_MCP_PORT` | `3110` | OCR MCP | `127.0.0.1` | tool host |
| `SCREEN_MCP_PORT` | `3111` | screen recorder MCP | `127.0.0.1` | tool host |
| `TTS_MCP_PORT` | `3112` | TTS MCP | `127.0.0.1` | tool host |
| `FB_ADS_MCP_PORT` | `3121` | Facebook Ads MCP | `127.0.0.1` | tool host |
| `PUBLIC_API_MCP_PORT` | `3122` | Public API MCP | `127.0.0.1` | tool host |
| `COMBINED_MCP_PORT` | `3123` | Combined gateway | `127.0.0.1` | tool host |
| `ADAPTER_HTTP_PORT` | `5400` | universal adapter HTTP | `127.0.0.1` | tool host |
| `ADAPTER_HTTPS_PORT` | `5443` | adapter self-signed TLS | `127.0.0.1` | no (Caddy owns TLS) |
| `BRIDGE_PORT` | `11435` | local LLM bridge | `127.0.0.1` | no |
| `BRIDGE_INTERNAL_PORT` | `11437` | llama backend | `127.0.0.1` | no |
| `CADDY_HTTP_PORT` | `80` | Caddy HTTP | `0.0.0.0` | — |
| `CADDY_HTTPS_PORT` | `443` | Caddy HTTPS | `0.0.0.0` | — |

Rules:

- Every service port comes from exactly one env key.
- `lib/env.js` rejects duplicate service ports, out-of-range ports and non-http `APP_URL`.
- `0.0.0.0` is allowed only for Caddy. Application services must stay on `127.0.0.1`.
- The Windows UDS fallback is `UDS_PORT`, not `PORT+1`.

---

## 6. Env contract

```text
# Edge
APP_URL=https://api.zombiecoder.my.id
MAIN_HOST=api.zombiecoder.my.id
TOOL_BASE_DOMAIN=zombiecoder.my.id
TLS_MODE=internal
ACME_EMAIL=
CADDY_HTTP_PORT=80
CADDY_HTTPS_PORT=443

# Runtime
APP_ROOT=
BIND_HOST=127.0.0.1
PORT=5050
UDS_PORT=5150
UDS_PATH=/tmp/zombiecoder/mcp.sock
```

Derived values (never stored separately):

- `PUBLIC_ORIGIN` = normalized `APP_URL`
- `PUBLIC_HOST` = hostname of `APP_URL`
- `MAIN_HOST` = explicit value, else `PUBLIC_HOST`
- `TOOL_HOSTS` = `deploy/tools.json` × `TOOL_BASE_DOMAIN` (or explicit `*_HOST`)

Validation rules:

1. Ports are integers in `1..65535`.
2. No two services share a port.
3. `APP_URL` must be `http:` or `https:`.
4. `TLS_MODE` is `internal` or `acme`.
5. `acme` requires `ACME_EMAIL` and a resolvable public host.
6. `BIND_HOST` must be a loopback address for application services.

---

## 7. Caddy contract

- Global: `http_port {$CADDY_HTTP_PORT}`, `https_port {$CADDY_HTTPS_PORT}`, `email {$ACME_EMAIL}` when set.
- Main site: `https://{$MAIN_HOST}` → `127.0.0.1:{$PORT}`.
- Tool sites: one block per non-empty host from `deploy/tools.json`.
- TLS: `tls internal` when `TLS_MODE=internal`; automatic ACME when `acme`.
- Proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- SSE/streaming: `flush_interval -1`; no response compression on `/mcp`.
- WebSocket: native `reverse_proxy` upgrade handling, no extra config.
- Forbidden: `{query.*}` in an upstream address, wildcard upstreams, `0.0.0.0` upstreams.
- Health: Caddy `reverse_proxy` has no active health check by default; use `/status` probes from the installer instead.

Generated output must pass `caddy validate --adapter caddyfile`.

---

## 8. Build contract (P2)

```text
dist/
├── start.js, api.js, lib/, provider/, agent/, tools/, normalizer/
├── external mcp/ (runtime scripts only)
├── universal-adapter/ (without plugin/)
├── public/
├── deploy/Caddyfile            # rendered from env
├── .env                        # copied or generated, never overwritten silently
├── manifest.json               # file list + sha256 + versions
└── VERSION
```

- `scripts/build.js` uses Node 24 built-ins only.
- Source files are copied, never symlinked.
- Every copied file is hashed into `manifest.json`.
- `node dist/start.js --start-all` must run with no reference to the source tree.
- `APP_ROOT` resolves from the running script, so any folder works.

---

## 9. Installer contract (P3)

### Linux

1. Verify Node `>= 24` (fail with install instructions).
2. Install or upgrade Caddy (`apt` repo or official static binary).
3. Create `zombiecoder` systemd unit:
   - `User=` invoking user, `WorkingDirectory=<dist>`
   - `AmbientCapabilities=CAP_NET_BIND_SERVICE`
   - `NoNewPrivileges=yes`, `ProtectSystem=strict` with explicit writable paths
4. Render `.env` (ask for `APP_URL`, `MAIN_HOST`, `TOOL_BASE_DOMAIN`, `TLS_MODE`).
5. Run `scripts/build.js`.
6. `caddy validate`, then start Caddy and the app.
7. Smoke: `/status`, DB counts, UDS socket mode, TLS verify.

### Windows

1. Verify Node `>= 24`.
2. Install Caddy (official zip or `winget`), add to `PATH`.
3. Register a service (NSSM or `sc.exe`) for Caddy and the app.
4. Same env render, build, validate, smoke.
5. Firewall rules for `80/443` only when the user confirms.

Installer must be idempotent: running it twice updates config, never duplicates units or services.

---

## 10. UDS, DB and runtime contract

- Linux: UDS at `UDS_PATH`; directory created with `0700`; socket `0660`.
- Windows: TCP fallback on `UDS_PORT` (`127.0.0.1` only).
- DB path from `DB_SQLITE_PATH` (default `data/models.db`).
- First boot creates all tables and seeds agents from `agent/*.js`.
- Acceptance: a fresh temp DB contains `agents > 0`, `models > 0`, and the API `/status` returns the same agent count.
- No seed file may be required from outside `dist/`.

---

## 11. Test matrix

| Layer | Test | Evidence required |
| --- | --- | --- |
| Static | `node --check` on changed files | exit 0 |
| Env | `node scripts/check-env.js` | `ENV_OK`, no duplicate ports |
| Caddy | `caddy validate --adapter caddyfile` | `Valid configuration` |
| Runtime | boot `api.js` on test port | `/status` → `200` |
| TLS | `openssl s_client -verify_return_error` + `curl` without `-k` | verify code `0`, HTTP `200` |
| MCP | `initialize` + `tools/list` over `https` | JSON-RPC result, tool count |
| WS | `wss://.../mcp` upgrade | `101` |
| SSE | `GET /mcp` | `text/event-stream`, no buffering |
| DB | fresh temp DB | tables + seed counts |
| UDS | connect + JSON-RPC | response over socket |
| Any-dir | run `dist` from `/tmp` | `/status` → `200` |
| Perms | `ss -ltnp` | `:80/:443` by Caddy, app on loopback only |

---

## 12. External prerequisites (not code)

1. DNS for `MAIN_HOST` and every tool host must point at this origin **without** Cloudflare's orange proxy, or Cloudflare must use `Full (strict)` with an origin certificate Caddy can present.
2. Inbound `80` and `443` must reach the host (router port-forward or public IP). Without that, only `tls internal` works and public verification is impossible.
3. nginx must be stopped/disabled before Caddy binds `:80`.
4. The `zombiecoder.my.id` record currently resolves to Cloudflare; `api...` returns `502`. This is outside the repository and must be resolved by the operator.

---

## 13. Phases and gates

| Gate | Criteria |
| --- | --- |
| G1 (P1) | `PHASE1_OK` check from contract `gc-mvzmfjdw` |
| G2 (P2) | `dist` boots and serves `/status` 200 with source tree moved away |
| G3 (P3) | installer finishes twice in a row; services active; Caddy validate passes |
| G4 (P4) | TLS verify code 0, MCP initialize over HTTPS, WS 101, fresh DB seeded, app bound to loopback only |

---

## 14. Accountability

This document is the SSOT for the edge/runtime work. If a later decision contradicts it, the document is updated first and the reason is recorded. Claims in the completion report must cite a command output or a `path:line`; otherwise they are `UNVERIFIED`.

Chair's ruling: Caddy is the edge, env is the truth, and the plugin goes. No third-party runtime dependency gets a vote.
