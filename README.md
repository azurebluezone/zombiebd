# ZombieCoder - Mission Barisal

A zero-dependency Node.js gateway for agents, MCP tools and OpenAI-compatible
clients. One process serves MCP over HTTP JSON-RPC, SSE, WebSocket and a Unix
socket, and serves the OpenAI chat API on `/v1`.

The project is named **Mission Barisal**. Every count and endpoint in this file
is either checked by a command in the repository or marked as unverified. The
live verifier is `bash scripts/install-verify.sh --quick`.

---

## Requirements

- **Node.js 24 or newer as its own runtime** - the installer places it at
  `~/.local/node-v24` after verifying the official SHA-256; the gateway never
  picks a `node` off `PATH`. `node:sqlite` is built in and there are no npm
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

1. Installs Node.js 24+ as a separate runtime under `~/.local/node-v24`:
   downloads the official linux-x64/arm64 tarball and verifies its SHA-256.
   Nothing is installed into the system `node` path.
2. Installs minimal KDE Plasma (`plasma-desktop`, `kwin-x11`,
   `plasma-workspace`, `konsole`) when no Plasma session is present. It does
   not install or switch `sddm`.
3. Creates `.env` from `.env.example` when missing, keeps every existing value,
   fills missing keys, and generates admin tokens on first install. Secret
   values are never printed. It also creates
   `external mcp/servers.json` from `servers.example.json` when missing, so the
   same set of external MCP servers exists on a fresh clone; credentials stay
   in `.env`, never in that JSON.
4. Detects Ollama and records the `llama-local` alias.
5. Installs Caddy when missing, renders `/etc/caddy/Caddyfile` from the env
   contract, validates it, and reloads the service.
6. Trusts the Caddy local root CA when `TLS_MODE=internal`.
7. Builds `dist/` and starts the gateway **from `dist/`**, using
   `~/.local/node-v24/bin/node`. The launcher links `data/`, `logs/`,
   `cache/`, `.zombiecoder/`, `.missionbarisal/` and `.env` from the checkout
   into `dist/`, so a rebuild never erases runtime state. The gateway creates
   and seeds the SQLite database on first boot.
8. Loads providers from `.env`; `lib/env.js` is the only place that knows
   hostnames, ports and provider URLs.
9. Runs the live verifier against `APP_URL` and prints the final sentinel.

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
cp .env.example .env                            # then edit the values you need
NODE="$HOME/.local/node-v24/bin/node"
"$NODE" scripts/build.js                        # produce the dist/ runtime
systemctl --user restart zombiecoder-gateway.service   # boot dist/start.js
bash scripts/install-verify.sh
```

The service unit does not run the source tree. `scripts/zombiecoder-gateway.sh`
refuses to boot without `dist/start.js`, so a stale or missing build is a
start-up error instead of a silently different runtime.

---

## Verified live state (2026-11-06)

| Item | Observed value | Command |
|------|----------------|---------|
| Gateway | `http://127.0.0.1:5050` | `curl -s localhost:5050/health` |
| gRPC | `127.0.0.1:5052` | `ss -ltnp` |
| Caddy | `:80` and `:443`, v2.11.7 | `caddy version` |
| TLS mode | `internal`, host `localhost` | `.env`, `openssl s_client` |
| Local HTTPS | HTTP 200, verify code 0 | `curl https://localhost/health` |
| Agents | 9 | `/health`, `/status` |
| MCP tools | 153 | `tools/list` over `/mcp` |
| Model rows | 111 | `/health` |
| Advertised catalogue | 121 entries | `/api/v0/models` |
| llama.cpp OpenAI | `custom_5`, `http://127.0.0.1:9932/v1` | `/api/v0/models` |
| llama.cpp native | `custom_6`, `http://127.0.0.1:9932` | `/api/v0/models` |
| llama.cpp model | `qwen3-1.7b-abliterated` | `/api/v0/models` |
| Ollama | `http://127.0.0.1:11434` | `/api/tags` |
| Local bridge | `127.0.0.1:11435`, backend `ollama`, model `qwen2:0.5b` | `/health` |
| MCP UDS | `/tmp/zombiecoder/mcp.sock` | `ss -lxp` |
| OpenAI UDS | `/tmp/zombiecoder/openai.sock` | `ss -lxp` |
| Runtime Node | v24.22.2 | `/health` |
| Process manager | systemd user unit `zombiecoder-gateway.service` (`Restart=always`); a terminal run stops the unit and owns the port | `systemctl --user is-active` |

The two model numbers are different views: `/health` reports the SQLite row
count, while `/api/v0/models` reports the deduplicated catalogue the router can
actually address. Neither number is hardcoded in the docs test; the tool and
agent counts are.

### Local TLS trust

The Caddy root CA from `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`
is installed as `/usr/local/share/ca-certificates/caddy-local-root.crt` and
`update-ca-certificates` has been run. `curl` without `-k` therefore returns
`verify=0` for the local host.

### Edge is localhost

The Caddy edge serves `https://localhost` with its internal CA. `localhost`
resolves to `127.0.0.1`, so the verifier calls `https://localhost/health`
directly; no `--resolve`, no remote host and no Cloudflare tunnel is used.
The public `zombiecoder.my.id` hostname is an external deployment and is not
part of this verification.

---

## The Mission Barisal Agents (9)

Agent definitions live in `agent/*.js`; each file carries its persona inline.
The SQLite `agents` table is the runtime source of truth. The file
`fallbackModel` is used only when a DB row has no concrete model.

| ID | Role | Provider | Model |
|----|------|----------|-------|
| `security-hero` | security | `custom_5` | `qwen3-1.7b-abliterated` |
| `perf-wizard` | performance | `custom_6` | `llama-native-qwen` |
| `doc-king` | documentation | `ollama` | `qwen2:0.5b` |
| `qa-tyrant` | quality | `groq` | `openai/gpt-oss-20b` |
| `team-heart` | general | `gemini` | `gemini-2.5-flash-lite` |
| `customer-experience-specialist` | customer-experience | `gemini` | `gemini-3.6-flash` |
| `ecommerce-operations-analyst` | ecommerce-operations | `groq` | `openai/gpt-oss-120b` |
| `bug-hunter` | debugging | `gemini` | `gemini-2.5-flash` |
| `code-guru` | architecture | `gemini` | `gemini-3.5-flash` |

The table is the binding observed on 2026-11-06: every row answered an OpenAI
request with HTTP 200 through the provider and model shown. The runtime source
of truth stays the SQLite `agents` table:

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("data/models.db",{readOnly:true});console.log(db.prepare("SELECT id,model FROM agents").all())'
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
carrying an `inputSchema`. `tests/docs-claims-check.js` audits this heading on
demand; documentation is advisory and never gates the runtime or the installer.

```bash
curl -s https://localhost/mcp \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://localhost' \
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
tool registry, the live working directory and one real agent request; it does not claim that
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
| `custom_5` | `CUSTOM_PROVIDER_5_*` | llama.cpp OpenAI-compatible `/v1`, priority 0. |
| `custom_6` | `CUSTOM_PROVIDER_6_*` | llama.cpp native `/completion`, priority 1. |

Both llama.cpp providers read one URL pair from `.env`:
`LLAMA_CPP_BASE` and `LLAMA_CPP_URL=${LLAMA_CPP_BASE}/v1`. `custom_5` uses
`${LLAMA_CPP_URL}` with the OpenAI adapter; `custom_6` uses `${LLAMA_CPP_BASE}`
with the native `llamacpp` adapter. No provider URL is hardcoded in source.

A CPU-served model gets its budgets from the same per-provider keys:

| Key pattern | Value | Why |
|-------------|-------|-----|
| `CUSTOM_PROVIDER_N_TIMEOUT_MS` | `300000` | a 5.7k-token prefill measured 132 s on this host; the 60 s default aborted real answers |
| `CUSTOM_PROVIDER_N_STREAM_TIMEOUT_MS` | `600000` | streaming has the same prefill plus generation |
| `CUSTOM_PROVIDER_N_MAX_PROMPT_CHARS` | `2500` | keeps persona and rules, drops SSOT/syllabus prose, session history and auto-injected tool schemas |

With the budget applied, one measured agent request returned
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
bash scripts/install-verify.sh
```

Every field in the final line is a live check:

| Field | Meaning |
|-------|---------|
| `env=ok` | `scripts/check-env.js` resolved every service once |
| `installer=ok` | `scripts/install.sh --check` passed |
| `node=24` | running Node major is 24 or newer |
| `kde=present` | `startplasma-x11` or `plasmashell` exists |
| `tls=ok` | `https://localhost/health` returns 200 with verify code 0 |
| `origins=ok` | allowed origin 200, hostile origin 401 |
| `tools=153` | live `tools/list` count |
| `providers=...` | `llama-cpu-openai` and `llama-native` in the live catalogue |
| `native=ok` | real llama.cpp `/completion` request through `provider/llamacpp.js` |
| `db=seed` | 9 agent rows, no `MODELS_DB` sentinel |
| `build=ok` | `scripts/build.js` produced `dist/manifest.json` |
| `start=ok` | `/health` returns 200 with 9 agents |
| `agents=9` | `/status` agent count |
| `workdir=ok` | live `get_working_dir` is an existing path outside `/tmp`; `set_working_dir` is advertised |
| `reply=ok` | real agent completion requested from the project root |

A passing run ends with exactly:

```text
RESULT: MISSION BARISAL PASS env=ok installer=ok node=24 kde=present tls=ok origins=ok tools=153 providers=ok native=ok db=seed build=ok start=ok agents=9 workdir=ok reply=ok
```

Documentation is not part of this gate. `tests/docs-claims-check.js` can be run
separately when auditing the docs; a stale number there never fails an install
or changes runtime behaviour.

Logs and verification artifacts are written under `logs/verify/` in the
project, so they survive a reboot.

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
| `provider/llamacpp.js` | llama.cpp native `/completion` adapter |
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
- Groq's `qwen/qwen3.8-27b` has a 7000 input-tokens-per-minute limit on this
  account. A tool-loop second call can therefore return `HTTP 429` even after
  the first call succeeded, which is why no agent is bound to it.
- Gemini 3.x free tier allows 20 generate-content requests per day per model.
  Once that is spent the provider answers `HTTP 429` with a retry window of
  about 10 hours; the binding is still correct, the quota is not.
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
