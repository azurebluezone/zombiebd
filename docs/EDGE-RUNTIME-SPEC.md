# EDGE-RUNTIME-SPEC

**Project:** Mission Barisal / ZombieCoder Gateway
**Status:** verified 2026-11-06
**Scope:** edge, ports, environment contract, build, installer and runtime proof

This document records how the runtime is wired, as observed on 2026-11-06.
The source of truth is the code, `.env` and the SQLite database; this markdown
never configures runtime behaviour and a wrong edit here cannot change it.
Every "current state" claim below was produced by a command on 2026-11-06.
Historical work orders are kept only where they explain a decision; their old
status lines are not preserved as current facts.

---

## 0. Contract

### Goal

Caddy is the only edge. It owns `:80` and `:443`, terminates TLS and forwards to
fixed loopback upstreams. Environment variables are the only configuration
source. The application must boot from any working directory, create and seed
its SQLite database at runtime, and prove the result with live checks.

### Acceptance

- `caddy validate` returns `Valid configuration`.
- `node scripts/check-env.js` resolves every service port with no duplicates.
- A fresh clone runs `bash scripts/install.sh` and ends with the install
  sentinel in section 10.
- `bash scripts/install-verify.sh --quick` prints that sentinel only after
  every live check passed.

### Non-goals

- Public ACME issuance. It needs DNS control and inbound `80/443`; the current
  mode is `internal`.
- Tool authentication. The open-tool decision is recorded in section 7.
- Rewriting provider or agent logic beyond the broken seams listed here.

---

## 1. Verified current state (2026-11-06)

| Check | Observed |
| --- | --- |
| `ss -ltnp` | `127.0.0.1:5050` API, `127.0.0.1:5052` gRPC, `127.0.0.1:9932` llama.cpp |
| `systemctl is-active caddy` | active; Caddy v2.11.7 owns `:80` and `:443` |
| `curl https://localhost/health` | HTTP 200, verify code 0 (no `--resolve`) |
| `getent hosts localhost` | `::1 localhost` |
| `/health` | version 3.2.1, agents 9, model rows 111, Node v24.22.2 |
| `/api/v0/models` | 121 catalogue entries |
| `tools/list` over `/mcp` | 153 tools |
| `data/models.db` | 9 agent rows, no `MODELS_DB` sentinel after repair |
| `agent/*.js` | 9 agent definitions, each with an inline persona |
| Ollama | reachable on `127.0.0.1:11434` |
| local bridge | `127.0.0.1:11435`, backend `ollama`, model `qwen2:0.5b` |
| llama.cpp | OpenAI-compatible `http://127.0.0.1:9932/v1`, model `qwen3-1.7b-abliterated` |
| Process manager | systemd user unit `zombiecoder-gateway.service`, `Restart=always`; inactive while a terminal run owns the port |
| KDE Plasma | installed (`plasma-desktop 4:5.24.7`, `startplasma-x11` present) |
| active desktop session | XFCE; the installer did not switch display managers |

The public hostname `api.zombiecoder.my.id` resolves to Cloudflare addresses and
returned HTTP 530 on 2026-11-06; it is not part of the local edge. Local TLS
verification is green.

---

## 2. Decisions

| ID | Decision | Reason |
| --- | --- | --- |
| D1 | Caddy is the only edge and owns `:80` and `:443` | User order; removes the tunnel from the runtime path |
| D2 | Application services bind loopback only | Caddy is the only public listener |
| D3 | Caddy upstreams are fixed loopback addresses, never query-driven | `XTransformPort` is an open proxy/SSRF pattern |
| D4 | Environment variables are the only SSOT; defaults live in `lib/env.js` | One schema, no duplicated port truth |
| D5 | No domain literal in runtime code | `APP_URL`, `MAIN_HOST`, `TOOL_BASE_DOMAIN` provide every host |
| D6 | Tools stay unauthenticated in this personal deployment; origin checks remain | Recorded risk, not an accident |
| D7 | Tool exposure uses subdomains from `TOOL_BASE_DOMAIN`; path-prefix routing is rejected | Every MCP server serves `/mcp` at root |
| D8 | TLS mode is env-driven: `internal` for local, `acme` for public | ACME needs external DNS and inbound ports |
| D9 | `dist/` is the deployable runtime; the source tree is for development | Build script copies, renders and hashes |
| D10 | The app runs unprivileged; only Caddy binds low ports | No Node process runs as root |
| D11 | `universal-adapter/plugin/` is absent | No dependency install in that folder |
| D12 | llama.cpp has two providers: `custom_5` (OpenAI `/v1`, priority 0) and `custom_6` (native `/completion`, priority 1) | One upstream, two wire dialects; priority 0 keeps the plain model id on the OpenAI adapter |
| D13 | Agent DB rows must store a concrete model, never the `MODELS_DB` sentinel | A sentinel row silently fell through to the default cloud provider |
| D14 | A provider may declare `TIMEOUT_MS`, `STREAM_TIMEOUT_MS` and `MAX_PROMPT_CHARS` | A local CPU model needed 132 s for a 5.7k-token prefill and answered with a tool call; the cloud-shaped prompt and 60 s timeout were both wrong for it |
| D15 | A Gemini 3.x functionCall is replayed with its `thoughtSignature` and `id` | The API rejects the tool-result turn with HTTP 400 when the signature is dropped, so the normalizer and adapter must both carry it |
| D16 | Fallback walks the providers that advertise the requested model, in priority order, and never changes the model | Four live models are served by two providers. Re-resolving the model to its single highest-priority provider made `findNextProvider` skip the second one, so `gemini-4-argon` could not move from `gemini` to `opencode` |

---

## 3. Target architecture

```text
client (https/wss)
        |
        v
  Caddy :443 / :80          TLS termination, redirect, fixed upstreams
        |
        +--> 127.0.0.1:5050   main API + MCP (/mcp, /status, /api/*)
        +--> 127.0.0.1:3110   OCR MCP
        +--> 127.0.0.1:3111   screen recorder MCP
        +--> 127.0.0.1:3112   TTS MCP
        +--> 127.0.0.1:3121   Facebook Ads MCP
        +--> 127.0.0.1:3122   public API MCP
        +--> 127.0.0.1:3123   combined MCP
        +--> 127.0.0.1:5400   universal adapter (HTTP only)

internal only: Ollama 11434, bridge 11435, adapter HTTPS 5443,
               UDS /tmp/zombiecoder/mcp.sock, openai.sock,
               gRPC 5052, optional HTTPS 5444, Windows TCP 5150,
               llama.cpp 9932
```

Request path: client -> Caddy (HTTPS) -> loopback upstream (HTTP) -> Node.
Caddy adds `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Real-IP`; the app trusts
them only from loopback.

---

## 4. Port map (single source: `lib/env.js`)

| Env key | Default | Service | Bind | Public via Caddy |
| --- | ---: | --- | --- | --- |
| `PORT` | `5050` | main API / MCP | `127.0.0.1` | yes (`MAIN_HOST`) |
| `UDS_PORT` | `5150` | Windows TCP fallback for UDS | `127.0.0.1` | no |
| `UDS_PATH` | `/tmp/zombiecoder/mcp.sock` | Linux UDS (newline JSON-RPC) | filesystem `0660` | no |
| `OPENAI_UDS_PATH` | `/tmp/zombiecoder/openai.sock` | OpenAI HTTP over UDS | filesystem `0660` | no |
| `GRPC_PORT` | `5052` | gRPC (h2c + protobuf) | `127.0.0.1` | no |
| `HTTPS_PORT` | `5444` | optional in-process TLS | `127.0.0.1` | no |
| `OCR_MCP_PORT` | `3110` | OCR MCP | `127.0.0.1` | tool host |
| `SCREEN_MCP_PORT` | `3111` | screen recorder MCP | `127.0.0.1` | tool host |
| `TTS_MCP_PORT` | `3112` | TTS MCP | `127.0.0.1` | tool host |
| `FB_ADS_MCP_PORT` | `3121` | Facebook Ads MCP | `127.0.0.1` | tool host |
| `PUBLIC_API_MCP_PORT` | `3122` | public API MCP | `127.0.0.1` | tool host |
| `COMBINED_MCP_PORT` | `3123` | combined gateway | `127.0.0.1` | tool host |
| `ADAPTER_HTTP_PORT` | `5400` | universal adapter HTTP | `127.0.0.1` | tool host |
| `ADAPTER_HTTPS_PORT` | `5443` | adapter self-signed TLS | `127.0.0.1` | no |
| `BRIDGE_PORT` | `11435` | local LLM bridge | `127.0.0.1` | no |
| `BRIDGE_INTERNAL_PORT` | `11437` | bridge backend | `127.0.0.1` | no |
| `LLAMA_CPP_URL` | `http://127.0.0.1:9932/v1` | llama.cpp OpenAI endpoint | `127.0.0.1` | no |
| `CADDY_HTTP_PORT` | `80` | Caddy HTTP | `0.0.0.0` | - |
| `CADDY_HTTPS_PORT` | `443` | Caddy HTTPS | `0.0.0.0` | - |

Rules:

- Every service port comes from exactly one env key.
- `lib/env.js` rejects duplicate service ports, out-of-range ports and a
  non-HTTP `APP_URL`.
- `0.0.0.0` is allowed only for Caddy.
- The Windows UDS fallback is `UDS_PORT`, not `PORT+1`.

---

## 5. Env contract

```text
# Edge
APP_URL=https://localhost
MAIN_HOST=localhost
TOOL_BASE_DOMAIN=
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

# Providers
CUSTOM_PROVIDER_5_ENABLED=true
CUSTOM_PROVIDER_5_NAME=llama-cpp
CUSTOM_PROVIDER_5_URL=http://127.0.0.1:9932/v1
CUSTOM_PROVIDER_5_KEY=
CUSTOM_PROVIDER_5_MODELS=
CUSTOM_PROVIDER_5_PRIORITY=0
CUSTOM_PROVIDER_5_TYPE=openai
# Local CPU budgets: cloud default (60s) is too short for a 5.7k-token prefill.
CUSTOM_PROVIDER_5_TIMEOUT_MS=300000
CUSTOM_PROVIDER_5_STREAM_TIMEOUT_MS=600000
# 0/unset = no cap. When set, bulk context and auto-injected tools are dropped.
CUSTOM_PROVIDER_5_MAX_PROMPT_CHARS=2500

# Same upstream, native /completion dialect. Priority 1 keeps the plain model
# id on custom_5; the masked name resolves here exactly.
CUSTOM_PROVIDER_6_ENABLED=true
CUSTOM_PROVIDER_6_NAME=llama-native
CUSTOM_PROVIDER_6_URL=http://127.0.0.1:9932
CUSTOM_PROVIDER_6_PRIORITY=1
CUSTOM_PROVIDER_6_TYPE=llamacpp
CUSTOM_PROVIDER_6_MODELS=llama-native-qwen=>qwen3-1.7b-abliterated
```

Derived values are never stored separately:

- `PUBLIC_ORIGIN` = normalized `APP_URL`
- `PUBLIC_HOST` = hostname of `APP_URL`
- `MAIN_HOST` = explicit value, else `PUBLIC_HOST`
- `TOOL_HOSTS` = `deploy/tools.json` x `TOOL_BASE_DOMAIN` (or explicit host env)

Validation rules:

1. Ports are integers in `1..65535`.
2. No two services share a port.
3. `APP_URL` must use `http:` or `https:`.
4. `TLS_MODE` is `internal` or `acme`.
5. `acme` requires `ACME_EMAIL` and a resolvable public host.
6. `BIND_HOST` must be a loopback address for application services.

`scripts/env-ensure.js` fills missing keys from `.env.example`, keeps every
existing value, generates admin tokens only for a freshly created `.env`, and
adds the local and main-host origins. It prints key names, never values.

---

## 6. Caddy contract

- Global: `http_port {$CADDY_HTTP_PORT}`, `https_port {$CADDY_HTTPS_PORT}`,
  `email {$ACME_EMAIL}` when set.
- Main site: `https://{$MAIN_HOST}` -> `127.0.0.1:{$PORT}`.
- Tool sites: one block per non-empty host from `deploy/tools.json`.
- TLS: `tls internal` when `TLS_MODE=internal`; automatic ACME otherwise.
- Proxy headers: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Proto`.
- SSE/streaming: `flush_interval -1`; no compression on `/mcp`.
- WebSocket: native `reverse_proxy` upgrade handling.
- Forbidden: `{query.*}` in an upstream address, wildcard upstreams,
  `0.0.0.0` upstreams.
- Generated output must pass `caddy validate --adapter caddyfile`.

For `TLS_MODE=internal`, the installer copies the Caddy root CA to
`/usr/local/share/ca-certificates/caddy-local-root.crt` and runs
`update-ca-certificates`. Verified result: `curl` without `-k` returns HTTP 200
with `ssl_verify_result=0`, and `openssl s_client -verify_return_error` exits 0.

---

## 7. Build and installer contract

### Build

```text
dist/
  start.js, api.js, lib/, provider/, agent/, tools/, normalizer/
  external mcp/ (runtime scripts + servers.json for this install)
  universal-adapter/ (without plugin/)
  public/, deploy/Caddyfile, .env
  manifest.json (file list + sha256 + versions)
  VERSION
```

- `scripts/build.js` uses Node 24 built-ins only.
- `BUILD_OUT=<dir>` writes the build somewhere other than `dist/`. The build
  refuses to replace `dist/` while a gateway is running from it, so live
  verification builds into a scratch directory instead of deleting the runtime.
- Source files are copied, never symlinked.
- Every copied file is hashed into `manifest.json`.
- The launcher replaces the build's `.env` copy with a symlink to the checkout
  `.env`, and links `data/`, `logs/`, `cache/`, `locks/`, `.zombiecoder/` and
  `.missionbarisal/` so a rebuild never destroys operator state. `skills/` is
  build output and stays inside `dist/`.
- `APP_ROOT` resolves from the running script, so any folder works.
- `external mcp/servers.json` is machine-local and git-ignored. The repository
  ships `servers.example.json`; the installer copies it when the local file is
  missing and never overwrites an existing one. MCP credentials belong in
  `.env` (`FB_ACCESS_TOKEN`), not in that JSON.

### Installer

`scripts/install.sh` is idempotent and implements:

1. Node `>= 24` detection; official tarball install with SHA-256 verification
   when missing.
2. Minimal KDE Plasma install when absent (`--skip-kde` opts out). No `sddm`
   install and no display-manager switch.
3. `.env` creation and completion (`scripts/env-ensure.js`), plus
   `external mcp/servers.json` from the committed example when missing.
4. Ollama detection and `llama-local` alias recording.
5. Caddy install, Caddyfile render/validate, backup and reload.
6. Internal CA trust.
7. Build and start (systemd user unit when available). First boot creates and
   seeds `data/models.db`.
8. `scripts/install-verify.sh --quick`. Agent model bindings are operator state
   in the DB and are not rewritten by the installer.

Read-only preflight: `bash scripts/install.sh --check` prints
`INSTALL_CHECK_OK` and writes nothing.

Windows: `scripts/install.ps1` exists; it is **NOT_TESTED** on this Linux host.

---

## 8. UDS, database and runtime contract

- Linux UDS at `UDS_PATH`; directory `0700`; socket `0660`.
- Windows fallback is TCP on `UDS_PORT` (`127.0.0.1` only).
- DB path comes from `DB_SQLITE_PATH`, default `data/models.db`.
- First boot creates all tables and seeds agents from `agent/*.js`.
- Agent seeding stores a concrete model: the DB value when it is real, else the
  agent file's `fallbackModel`. The `MODELS_DB` sentinel is repaired at boot.
- Acceptance: a fresh temp DB contains 9 agent rows and at least one model row;
  `/status` reports the same agent count.
- No seed file is required from outside `dist/`.
- Agent model edits are loaded at boot. Restart the gateway after changing the
  DB directly; the in-memory `AGENTS` array is not live-reloaded.
- A provider with `MAX_PROMPT_CHARS` set uses a compact system prompt: persona
  plus rules, no SSOT/syllabus prose, no session history and no automatic tool
  injection. The full files stay on disk and client-supplied tools still pass
  through. The log line is `PROMPT_BUDGET_APPLIED` with the exact size.
- Provider timeouts are per custom provider (`CUSTOM_PROVIDER_N_TIMEOUT_MS`);
  the shared 60 s default is a cloud-shaped budget and is wrong for CPU models.

---

## 9. Test matrix

| Layer | Test | Evidence required |
| --- | --- | --- |
| Static | `node --check` on changed files | exit 0 |
| Env | `node scripts/check-env.js` | `ENV_OK`, no duplicate ports |
| Docs | `node tests/docs-claims-check.js` | advisory audit only; never gates install or runtime |
| Caddy | `caddy validate --adapter caddyfile` | `Valid configuration` |
| Runtime | boot `api.js` / `start.js` | `/status` returns 200 |
| TLS | `curl` without `-k` + `openssl -verify_return_error` | verify code 0, HTTP 200 |
| Origins | allowed `tools/call` / hostile origin | 200 / 401 |
| MCP | `tools/list` over HTTP and UDS | JSON-RPC result, tool count |
| DB | fresh temp DB | tables + 9 seeded agents |
| llama.cpp | direct completion + gateway catalogue + per-agent routing | non-empty content; every agent answers through its own provider/model pair |
| Workdir | live `get_working_dir` + `set_working_dir` in the registry + real completion | existing absolute path outside `/tmp`; HTTP 200, non-empty content |
| Build | `BUILD_OUT=<scratch> node scripts/build.js` | that directory's `manifest.json` exists; a live `dist/` is refused, not replaced |
| Full transports | `node tests/all-transports-check.js` | 13 live transport checks |

The install sentinel covers the rows it names. It does not claim that the full
transport suite passed; run that suite for its own evidence.

---

## 10. Install sentinel

```text
RESULT: MISSION BARISAL PASS env=ok installer=ok node=24 kde=present tls=ok origins=ok tools=153 providers=ok native=ok db=seed build=ok start=ok agents=9 workdir=ok reply=ok
```

`bash scripts/install-verify.sh --quick` prints this line only when every check
passed. On failure it prints `RESULT: MISSION BARISAL FAIL missing=...` and exits
non-zero. Logs and verification artifacts go to `logs/verify/` in the project.

---

## 11. External prerequisites

1. DNS for `MAIN_HOST` and every tool host must point at this origin without
   Cloudflare's orange proxy, or Cloudflare must use `Full (strict)` with an
   origin certificate Caddy can present.
2. Inbound `80` and `443` must reach the host. Without that, only `tls internal`
   works and public verification is impossible.
3. Public ACME requires a resolvable host and `ACME_EMAIL`.
4. On 2026-11-06 `api.zombiecoder.my.id` resolved to Cloudflare and returned
   HTTP 530 externally. This is outside the repository and must be fixed by the
   operator. The local edge uses `localhost`, which resolves to `::1`.

---

## 12. Accountability

Claims in the completion report must cite a command output or a `path:line`;
otherwise they are `UNVERIFIED`. A failed check is reported as failed, not
reworded. The working rule is simple: Caddy is the edge, env is the truth, and
no third-party runtime dependency gets a vote.
