# ZombieCoder - Mission Barisal

A zero-dependency Node.js gateway for agents, MCP tools and OpenAI-compatible
clients. One process serves MCP over HTTP JSON-RPC, SSE, WebSocket and a Unix
socket, and serves the OpenAI chat API on `/v1`.

The project is named **Mission Barisal**. Every count and endpoint in this file
is either checked by a command in the repository or marked as unverified. The
live verifier is `bash scripts/install-verify.sh --quick`.

---

## Requirements

- **Node.js 24 or newer** - `node:sqlite` is built in; there are no npm
  dependencies to install.
- Linux x86_64. The live evidence in this file was captured on Ubuntu 22.04.
- Optional: `llama.cpp` (`llama-server`) exposing an OpenAI-compatible
  `/v1` endpoint, or Ollama on `127.0.0.1:11434`.
- Caddy for the HTTPS edge. The installer sets up an internal CA for local TLS.

Windows: `scripts/install.ps1` exists but is **NOT_TESTED** on this Linux host.

---

## Fresh clone: one command

```bash
git clone https://github.com/azurebluezone/zombiebd.git
cd zombiebd
bash scripts/install.sh
```

`scripts/install.sh` performs these steps, in order, and can be re-run safely:

1. Finds Node 24+. If missing, downloads the official linux-x64/arm64 tarball,
   verifies its SHA-256 and installs it under `~/.local`.
2. Installs minimal KDE Plasma (`plasma-desktop`, `kwin-x11`,
   `plasma-workspace`, `konsole`) when no Plasma session is present. It does
   not install or switch `sddm`.
3. Creates `.env` from `.env.example` when missing, keeps every existing value,
   fills missing keys, generates admin tokens on first install, and adds local
   origins. Secret values are never printed. It also creates
   `external mcp/servers.json` from `servers.example.json` when missing, so the
   same set of external MCP servers exists on a fresh clone; credentials stay
   in `.env`, never in that JSON.
4. Detects Ollama and records the `llama-local` alias.
5. Installs Caddy when missing, renders `/etc/caddy/Caddyfile` from the env
   contract, validates it, and reloads the service.
6. Trusts the Caddy local root CA when `TLS_MODE=internal`.
7. Builds `dist/` and starts the gateway; the gateway creates and seeds the
   SQLite database on first boot.
8. Probes `llama.cpp` on `127.0.0.1:9932`; when it answers, runs
   `scripts/bind-llama-cpp.js` to register provider `custom_5`, bind all agent
   rows, then restarts the gateway so routing reloads the new models.
9. Runs the live verifier and prints the final sentinel.

Useful modes:

```bash
bash scripts/install.sh --check      # read-only preflight, writes nothing
bash scripts/install.sh --yes        # non-interactive
bash scripts/install.sh --skip-kde   # headless server
bash scripts/install.sh --skip-caddy # app only
bash scripts/install.sh --no-start   # configure and build, do not start
```

Manual path, if you already manage the services yourself:

```bash
cp .env.example .env                 # then edit the values you need
node start.js --start-all            # creates and seeds data/models.db
node scripts/bind-llama-cpp.js       # optional: llama.cpp on 127.0.0.1:9932
systemctl --user restart zombiecoder-gateway.service   # reload agent models
bash scripts/install-verify.sh --quick
```

---

## Verified live state (2026-11-06)

| Item | Observed value | Command |
|------|----------------|---------|
| Gateway | `http://127.0.0.1:5050` | `curl -s localhost:5050/health` |
| gRPC | `127.0.0.1:5052` | `ss -ltnp` |
| Caddy | `:80` and `:443`, v2.11.7 | `caddy version` |
| TLS mode | `internal`, host `api.zombiecoder.my.id` | `.env`, `openssl s_client` |
| Local HTTPS | HTTP 200, verify code 0 | `curl --resolve ... https://.../health` |
| Agents | 9 | `/health`, `/status` |
| MCP tools | 153 | `tools/list` over `/mcp` |
| Model rows | 111 | `/health` |
| Advertised catalogue | 121 entries | `/api/v0/models` |
| llama.cpp | `http://127.0.0.1:9932/v1` | `/v1/models` |
| llama.cpp model | `qwen3-1.7b-abliterated` | `/v1/models` |
| Ollama | `http://127.0.0.1:11434` | `/api/tags` |
| Local bridge | `127.0.0.1:11435`, backend `ollama`, model `qwen2:0.5b` | `/health` |
| MCP UDS | `/tmp/zombiecoder/mcp.sock` | `ss -lxp` |
| OpenAI UDS | `/tmp/zombiecoder/openai.sock` | `ss -lxp` |
| Runtime Node | v24.22.2 | `/health` |
| Process manager | systemd user unit `zombiecoder-gateway.service`, active | `systemctl --user is-active` |

The two model numbers are different views: `/health` reports the SQLite row
count, while `/api/v0/models` reports the deduplicated catalogue the router can
actually address. Neither number is hardcoded in the docs test; the tool and
agent counts are.

### Local TLS trust

The Caddy root CA from `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`
is installed as `/usr/local/share/ca-certificates/caddy-local-root.crt` and
`update-ca-certificates` has been run. `curl` without `-k` therefore returns
`verify=0` for the local host.

### Public DNS is not part of this repository

`api.zombiecoder.my.id` resolves to Cloudflare addresses (`2606:4700:...`).
On 2026-11-06 the public URL returned HTTP 530 because Cloudflare could not
reach an origin. The same request with `--resolve api.zombiecoder.my.id:443:127.0.0.1`
returns HTTP 200 and verify code 0. Fixing DNS/origin routing is an operator
step, not a code change.

---

## The Mission Barisal Agents (9)

Agent definitions live in `agent/*.js`; each file carries its persona inline.
The SQLite `agents` table is the runtime source of truth. The file
`fallbackModel` is used only when a DB row has no concrete model.

| ID | Role |
|----|------|
| `security-hero` | security |
| `perf-wizard` | performance |
| `doc-king` | documentation |
| `qa-tyrant` | quality |
| `team-heart` | general |
| `customer-experience-specialist` | customer-experience |
| `ecommerce-operations-analyst` | ecommerce-operations |
| `bug-hunter` | debugging |
| `code-guru` | architecture |

On 2026-11-06 all nine rows were bound to `qwen3-1.7b-abliterated` after the
llama.cpp probe succeeded. The binding is reproducible:

```bash
node scripts/bind-llama-cpp.js --chat
```

Calling an agent through the OpenAI API uses the agent id as the model name:

```bash
curl -s http://127.0.0.1:5050/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"team-heart","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"max_tokens":200}'
```

`max_tokens` matters with the current reasoning model: 32 tokens can be spent
entirely on `reasoning_content` and return an empty `content`. A limit of 160
or more returned `PONG` in the verified run.

---

## MCP Tools (153)

The live registry is the only list that matters: 153 tools on 2026-11-06, all
carrying an `inputSchema`. The count is re-checked against this heading by
`tests/docs-claims-check.js`, so a stale number fails verification.

```bash
curl -s http://127.0.0.1:5050/mcp \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://api.zombiecoder.my.id' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Tool families in that registry: built-in workspace/shell/web/database tools,
plus external MCP servers for OCR, screen recording, TTS, Facebook Ads, public
APIs and the combined gateway. The exact installed set varies with the external
servers that are running; the verifier reads the live list instead of a fixture.

Tools are unauthenticated by design in this personal deployment (recorded
decision D6 in `docs/EDGE-RUNTIME-SPEC.md`). Origin checks still reject
cross-origin `tools/call` requests with HTTP 401.

---

## Transports

| Transport | Endpoint | Wire format |
|-----------|----------|-------------|
| HTTP JSON-RPC 2.0 | `POST /mcp` | JSON-RPC request/response |
| SSE | `GET /mcp` | `text/event-stream` |
| WebSocket | HTTP upgrade | full-duplex JSON-RPC |
| Unix domain socket | `/tmp/zombiecoder/mcp.sock` | newline-delimited JSON-RPC |
| OpenAI HTTP | `POST /v1/chat/completions` | chat completions, optional SSE |
| gRPC | `127.0.0.1:5052` | h2c + protobuf |

The full live transport audit is:

```bash
node tests/all-transports-check.js
node tests/system-readiness-check.js
```

The install sentinel in this repository covers HTTP, HTTPS/TLS, origins, the
tool registry and one real agent request from `/tmp`; it does not claim that
every transport in the table passed on the last run. Run the two commands
above for that evidence.

---

## Providers and routing

Providers are configured by environment variables only. The router resolves
`model name -> provider -> adapter` and never writes a provider choice into
source code.

| Provider | Config | Notes |
|----------|--------|-------|
| `opencode` | `OPENCODE_*` | Cloud. Rate-limited with HTTP 429 on this host on 2026-11-06. |
| `groq` | `GROQ_*` | Requires a valid key. |
| `gemini` | `GEMINI_*` | Requires a valid key. |
| `ollama` | `OLLAMA_*` | Local, default `127.0.0.1:11434`. |
| `custom_5` | `CUSTOM_PROVIDER_5_*` | llama.cpp OpenAI endpoint, priority 0. |

`scripts/bind-llama-cpp.js` writes only these keys: name, URL, empty key,
model, type, priority, enabled, `CUSTOM_PROVIDER_5_TIMEOUT_MS`,
`CUSTOM_PROVIDER_5_STREAM_TIMEOUT_MS` and `CUSTOM_PROVIDER_5_MAX_PROMPT_CHARS`.
It refuses to replace a conflicting `custom_5` unless `--force` is passed.

A CPU-served model needs two budgets that a cloud API does not:

| Key | Value | Why |
|-----|-------|-----|
| `CUSTOM_PROVIDER_5_TIMEOUT_MS` | `300000` | 5.7k-token prefill measured 132 s on this host; the 60 s default aborted real answers |
| `CUSTOM_PROVIDER_5_STREAM_TIMEOUT_MS` | `600000` | streaming has the same prefill plus generation |
| `CUSTOM_PROVIDER_5_MAX_PROMPT_CHARS` | `2500` | keeps persona and rules, drops SSOT/syllabus prose, session history and auto-injected tool schemas |

With the budget applied, one measured agent request from `/tmp` returned
`CWD-OK` in 1.3 s with a warm prompt cache and 15.9 s cold; the same request
without it needed 132 s for prefill alone and then emitted a tool call instead
of text. Client-supplied tools still pass through; only the automatic
injection of all 153 schemas is skipped. Set the budget to `0` to disable it.

The router's `fallbackModel` behavior is deliberately conservative: when an
agent row still contains the legacy `MODELS_DB` sentinel, `api.js` resolves the
agent file's concrete fallback instead of forwarding the sentinel to a cloud
provider. Database edits are loaded into memory at boot; restart the gateway
after changing agent models.

---

## Install verification

```bash
bash scripts/install-verify.sh --quick
```

Every field in the final line is a live check:

| Field | Meaning |
|-------|---------|
| `docs=ok` | `tests/docs-claims-check.js` passed |
| `installer=ok` | `scripts/install.sh --check` passed |
| `node=24` | running Node major is 24 or newer |
| `kde=present` | `startplasma-x11` or `plasmashell` exists |
| `tls=ok` | Caddy HTTPS returns 200 with system-trust verify code 0 |
| `origins=ok` | allowed origin 200, hostile origin 401 |
| `tools=153` | live `tools/list` count |
| `db=seed` | 9 agent rows, no `MODELS_DB` sentinel |
| `build=ok` | `scripts/build.js` produced `dist/manifest.json` |
| `start=ok` | `/health` returns 200 with 9 agents |
| `llama=ok` | llama.cpp models + real completion + gateway catalogue + binding |
| `agents=9` | `/status` agent count |
| `cwd=/tmp` | real agent completion requested from `/tmp` |

A passing run ends with exactly:

```text
RESULT: MISSION BARISAL PASS docs=ok installer=ok node=24 kde=present tls=ok origins=ok tools=153 db=seed build=ok start=ok llama=ok agents=9 cwd=/tmp
```

Logs are written under `/tmp/opencode/install-verify-*.log`.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `api.js` | HTTP/MCP/gRPC server, routing, provider registry, SQLite |
| `start.js` | boot, port cleanup, DB preflight, bridge spawn |
| `agent/` | agent definitions, personas and model resolution |
| `provider/` | OpenAI, Ollama, Gemini, Groq and OpenCode adapters |
| `normalizer/` | provider response normalization and streaming |
| `external mcp/` | local MCP servers (OCR, screen, TTS, ads, public API); `servers.example.json` ships, `servers.json` is local |
| `universal-adapter/` | adapter for external tool transports |
| `deploy/tools.json` | tool host manifest consumed by Caddy renderer |
| `scripts/install.sh` | fresh-clone installer |
| `scripts/install-verify.sh` | live verification sentinel |
| `scripts/bind-llama-cpp.js` | llama.cpp provider + agent binding |
| `scripts/build.js` | self-contained `dist/` build |
| `scripts/env-ensure.js` | complete `.env` without overwriting values |
| `docs/EDGE-RUNTIME-SPEC.md` | edge/runtime contract and port map |
| `tests/` | live transport, readiness, docs and provider checks |

---

## Known limitations

- Public DNS for `api.zombiecoder.my.id` currently points at Cloudflare and
  returned HTTP 530 externally on 2026-11-06. Local HTTPS works.
- The `opencode` provider was rate-limited (`HTTP 429`) during the audit. A
  request that lands on it can fail even when the local stack is healthy.
- llama.cpp spends completion tokens on `reasoning_content` before `content`;
  small `max_tokens` values return an empty answer with `finish_reason=length`.
- The gateway loads agent models into memory at boot. Editing the DB while it
  runs does not refresh routing until restart.
- KDE Plasma is installed on this host, but the active desktop session is
  still XFCE. The installer does not switch display managers.
- The Windows installer is present but unverified on this Linux host.
- Tool and model counts are point-in-time. External MCP servers and provider
  catalogues can change them; the docs test checks the two counts that are
  part of the install contract (agents and tools).

---

## Evidence discipline

Claims in this file follow one rule: a path, a command output or an HTTP
status, otherwise the claim is marked `UNVERIFIED`. The verification scripts
fail rather than print a green line they did not observe.

Project: Mission Barisal. Author: Sahon Srabon. Contact: infi@zombiecoder.my.id.
