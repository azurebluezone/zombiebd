# Agent → provider matrix

Every agent is bound to a concrete model from a live provider. The binding is
stored twice: `agent/*.js` carries the curated default, and the SQLite
`agents` table carries the runtime value. The DB row wins when it names a real
model; the file default is used when the row is empty.

The matrix deliberately spreads nine agents across five provider families so a
single provider outage, key expiry or stopped local server cannot take the
whole team down.

## Mapping (2026-11-08)

| Agent | Role | Model | Provider | Why this pairing |
|---|---|---|---|---|
| `security-hero` | security | `qwen3-1.7b-abliterated` | `llama-uds` | Local llama.cpp CPU; security review stays on-box and the model emits native tool calls. |
| `perf-wizard` | performance | `qwen3:0.6b` | `ollama` | Local Ollama; smallest live model for fast benchmark/profiling loops. |
| `doc-king` | documentation | `gpt-oss:20b` | `ollama_cloud` | Cloud writing quality without spending the large-model budget. |
| `qa-tyrant` | quality | `openai/gpt-oss-20b` | `groq` | Fast verification turns on Groq's OpenAI-compatible endpoint. |
| `team-heart` | general | `gpt-oss:20b` | `ollama_cloud` | Fast general chat without spending the Gemini free-tier quota. |
| `customer-experience-specialist` | customer-experience | `gemini-2.5-flash` | `gemini` | Flash model whose tool path still answers on the free tier; 3.6/3.7/3.8 Flash returned 503 high-demand during the gate. |
| `ecommerce-operations-analyst` | ecommerce-operations | `gpt-oss:120b` | `ollama_cloud` | Larger cloud model for catalogue and operations analysis. |
| `bug-hunter` | debugging | `openai/gpt-oss-120b` | `groq` | Large model for debugging probes with fast streaming tool calls. |
| `code-guru` | architecture | `gpt-oss:120b` | `ollama_cloud` | Large cloud model for architecture and code review; keeps the gate off Groq's 8000 TPM free-tier pool, which cannot carry two 120b agents per run. |

Provider coverage:

| Provider | Transport | Models used | Agents |
|---|---|---|---|
| `llama-uds` | llama.cpp OpenAI over UDS/TCP | `qwen3-1.7b-abliterated` | `security-hero` |
| `ollama` | Ollama OpenAI `/v1` | `qwen3:0.6b` | `perf-wizard` |
| `ollama_cloud` | Ollama native `/api/chat` at ollama.com | `gpt-oss:20b`, `gpt-oss:120b` | `doc-king`, `team-heart`, `ecommerce-operations-analyst`, `code-guru` |
| `groq` | OpenAI-compatible HTTPS | `openai/gpt-oss-20b`, `openai/gpt-oss-120b` | `qa-tyrant`, `bug-hunter` |
| `gemini` | Gemini generateContent | `gemini-2.5-flash` | `customer-experience-specialist` |

Gemini's free tier allows 20 requests/day per model. The 3.6/3.7/3.8 Flash
tool path returned HTTP 503 high-demand during the gate, so the Gemini agent
uses `gemini-2.5-flash`, whose tool calls still answer. The other two agents
that once shared the Gemini quota stay on Ollama Cloud and Groq; one Gemini
agent keeps the family covered without making the gate depend on a saturated
model.

## How the binding is applied

- Edit `agent/<id>.js` and add `model: "<catalog name>"` for the durable
  default.
- Update the live row through the admin API; the server refreshes `AGENTS`
  immediately:

```bash
curl -s -X POST http://127.0.0.1:5050/api/admin/agents \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"security-hero","model":"qwen3-1.7b-abliterated"}'
```

- A model name must exist in the live catalogue. If it does not, the agent
  falls back to `AGENT_MODEL` or the first usable live model and logs
  `AGENT_MODEL_FALLBACK`. That fallback is visible in `swap_notice`, not
  silent.
- Direct SQLite edits are read at boot; restart the gateway after changing the
  DB by hand.

## Local CPU budget and thinking

`OLLAMA_BASE` points at `http://127.0.0.1:11434/v1` and
`OLLAMA_DIALECT=openai`. Ollama's OpenAI-compatible `/v1/chat/completions`
endpoint emits native `tool_calls` directly; the native `/api/chat` path needs
a separate `think` flag and is not used here. The cloud provider keeps the
native dialect because `gpt-oss` does not need the flag.

qwen3 models think by default. On a CPU box that hidden reasoning consumes the
whole generation budget, so the model never reaches the tool call. The OpenAI
endpoint ignores `think`, but honours `reasoning_effort`; the provider config
therefore sends it as an extra body field:

```dotenv
OLLAMA_MAX_PROMPT_CHARS=1800
OLLAMA_MAX_TOKENS=160
OLLAMA_EXTRA_BODY={"reasoning_effort":"none"}
```

The llama.cpp server (`llama-uds`) has the same problem with its Jinja
template. DB provider rows have no budget columns, so the same knobs are
read from `PROVIDER_<ID>_*`:

```dotenv
PROVIDER_LLAMA_UDS_MAX_PROMPT_CHARS=1800
PROVIDER_LLAMA_UDS_MAX_TOKENS=160
PROVIDER_LLAMA_UDS_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}
```

Measured effect on this box (4-core i3, both local agents in parallel):
security-hero 180s → 40s for the tool round, perf-wizard 170s → 32s. The full
9-agent test now finishes in ~45s.

Key mapping stays one-way: `ollama` reads only `OLLAMA_API_KEY`, while
`ollama_cloud` owns `OLLAMA_CLOUD_API_KEY`. The cloud key is never sent to the
local server.

## Acceptance test

```bash
node tests/agent-provider-matrix-check.js
# RESULT: AGENT PROVIDER MATRIX PASS agents=9 providers=5 toolcalls=9 docs=ok
```

The test is not a mock:

1. It reads the live `agents` rows from `data/models.db` (the public
   `GET /api/agents` masks model names) and the `GET /api/v1/models`
   catalogue.
2. It creates a throw-away directory under `/tmp/opencode/` with
   `vault.txt` containing `ACCESS_CODE=ZOMBIE-7421`.
3. It streams a real `/v1/chat/completions` request per agent with
   `list_directory` and `read_file` tools.
4. It executes the emitted tool calls client-side against that directory,
   replays the tool results, and requires the final answer to contain the
   access code.
5. It sends a unique `session_id` per request. The gateway reuses one session
   per anonymous client and replays that session's memory, so without this
   isolation an earlier run's answer can steer the next one.
6. It fails on a provider swap, a malformed tool call, an answer that never
   read the vault, or a mapping drift.
7. Providers run in parallel; agents inside one provider run in order. Groq's
   free tier allows 8000 TPM per model, so two 120b agents firing together
   would 429 into an empty stream. Serialising per provider keeps the gate
   about tool calls, not quota races.
8. A transient empty stream is retried up to 3 times with a growing delay and
   a fresh session id. The retry re-asks the model; it never fabricates a
   tool call or an access code.

The result line is the release gate. A `FAIL` line means the matrix is not
shippable even if some individual agents answered.
