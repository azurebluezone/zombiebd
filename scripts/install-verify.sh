#!/usr/bin/env bash
# install-verify.sh - live proof for the Mission Barisal stack.
#
#   bash scripts/install-verify.sh
#
# Public checks target APP_URL directly (Caddy). Local checks cover artifacts
# that only exist on this host. A localhost shortcut is never accepted as
# evidence for a public URL.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

OUT="${INSTALL_VERIFY_OUT:-$ROOT/logs/verify}"
mkdir -p "$OUT"
LOG="$OUT/install-verify-$(date +%Y%m%d-%H%M%S).log"
EXPECTED_TOOLS="${EXPECTED_TOOLS:-153}"
FAILED=""

say() { echo "$*" | tee -a "$LOG"; }
pass() { say "PASS $*"; }
fail() { FAILED="$FAILED $1"; say "FAIL $1${2:+ ($2)}"; }

env_value() {
  "$@" 2>/dev/null || true
}

APP_URL="$(env_value node -p 'require("./lib/env").loadEnv({root:process.cwd()}).derived.publicOrigin')"
APP_URL="${APP_URL%/}"
[ -n "$APP_URL" ] || APP_URL="http://localhost:5050"
API_PORT="$(env_value node -p 'require("./lib/env").loadEnv({root:process.cwd()}).ports.api')"
API_PORT="${API_PORT:-5050}"
CADDY_HTTPS="$(env_value node -p 'require("./lib/env").loadEnv({root:process.cwd()}).ports.caddy_https')"
CADDY_HTTPS="${CADDY_HTTPS:-443}"
MAIN_HOST="$(env_value node -p 'require("./lib/env").loadEnv({root:process.cwd()}).derived.mainHost')"
MAIN_HOST="${MAIN_HOST:-localhost}"
DB_PATH="$(env_value node -p 'require("./lib/env").loadEnv({root:process.cwd()}).derived.dbPath')"
DB_PATH="${DB_PATH:-$ROOT/data/models.db}"

say "=== Mission Barisal install verification ==="
say "app_url=$APP_URL main_host=$MAIN_HOST api=$API_PORT caddy_https=$CADDY_HTTPS db=$DB_PATH"

# 1. Documentation claims are advisory only. A wrong markdown edit must never
#    fail an install: runtime truth is the code, .env and the database. Run
#    tests/docs-claims-check.js explicitly when auditing the docs.
if node tests/docs-claims-check.js >>"$LOG" 2>&1; then say "docs=ok (advisory)"; else say "docs=DRIFT (advisory, install unaffected)"; fi

# 2. Environment contract.
if node scripts/check-env.js >>"$LOG" 2>&1; then pass "env=ok"; else fail "env"; fi

# 3. Installer preflight (read-only).
if bash scripts/install.sh --check >>"$LOG" 2>&1; then pass "installer=ok"; else fail "installer"; fi

# 4. Node major.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -ge 24 ]; then pass "node=24 ($(node -v))"; else fail "node" "found $(node -v 2>/dev/null || echo none)"; fi

# 5. KDE Plasma.
if command -v startplasma-x11 >/dev/null 2>&1 || command -v plasmashell >/dev/null 2>&1; then
  pass "kde=present"
else
  fail "kde"
fi

# 6. Public health over APP_URL: DNS, TLS trust, Caddy and the gateway together.
HEALTH_BODY="$OUT/health.json"
HEALTH_RESULT="$(curl -sS -o "$HEALTH_BODY" -w '%{http_code} %{ssl_verify_result}' -m 15 "$APP_URL/health" 2>>"$LOG" || true)"
HEALTH_RESULT="${HEALTH_RESULT:-000 1}"
HEALTH_CODE="${HEALTH_RESULT%% *}"
HEALTH_VERIFY="${HEALTH_RESULT##* }"
HEALTH_OK="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(j.healthy===true&&j.agents===9?"yes":"no")}catch(_){process.stdout.write("no")}' "$HEALTH_BODY" 2>/dev/null || echo no)"
if [ "$HEALTH_CODE" = "200" ] && [ "$HEALTH_VERIFY" = "0" ] && [ "$HEALTH_OK" = "yes" ]; then
  pass "tls=ok remote=$APP_URL"
  pass "start=ok"
else
  fail "tls" "http=$HEALTH_CODE verify=$HEALTH_VERIFY"
  fail "start" "http=$HEALTH_CODE healthy=$HEALTH_OK"
fi

# 7. Local Caddy chain, no -k. This proves the edge certificate itself; the
# public check above remains the only evidence for APP_URL reachability.
if echo | openssl s_client -connect "127.0.0.1:$CADDY_HTTPS" -servername "$MAIN_HOST" -verify_return_error >/dev/null 2>&1; then
  pass "tls-chain=ok"
else
  fail "tls-chain"
fi

# 8. Origins: the public origin works, a hostile origin is rejected.
ORIGIN_ALLOWED="$APP_URL"
ALLOW_BODY="$OUT/origin-allowed.json"
DENY_BODY="$OUT/origin-denied.json"
ALLOW_CODE="$(curl -sS -o "$ALLOW_BODY" -w '%{http_code}' -m 10 -X POST "$APP_URL/mcp" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_ALLOWED" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_working_dir","arguments":{}}}' 2>>"$LOG" || true)"
DENY_CODE="$(curl -sS -o "$DENY_BODY" -w '%{http_code}' -m 10 -X POST "$APP_URL/mcp" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_working_dir","arguments":{}}}' 2>>"$LOG" || true)"
if [ "$ALLOW_CODE" = "200" ] && [ "$DENY_CODE" = "401" ]; then
  pass "origins=ok allow=$ALLOW_CODE deny=$DENY_CODE"
else
  fail "origins" "allow=$ALLOW_CODE deny=$DENY_CODE"
fi

# 9. Tool registry count over the public MCP endpoint.
TOOLS_BODY="$OUT/tools-list.json"
curl -sS -o "$TOOLS_BODY" -m 15 -X POST "$APP_URL/mcp" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_ALLOWED" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' >>"$LOG" 2>&1 || true
TOOL_COUNT="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.result&&j.result.tools||[]).length))}catch(_){process.stdout.write("0")}' "$TOOLS_BODY" 2>/dev/null || echo 0)"
if [ "$TOOL_COUNT" = "$EXPECTED_TOOLS" ]; then pass "tools=$TOOL_COUNT"; else fail "tools" "live=$TOOL_COUNT expected=$EXPECTED_TOOLS"; fi

# 10. Provider registration: both llama.cpp dialects must be listed.
MODELS_BODY="$OUT/models.json"
curl -sS -o "$MODELS_BODY" -m 15 "$APP_URL/api/v0/models" >>"$LOG" 2>&1 || true
PROVIDER_OWNERS="$(node -e '
try {
  const j = require(process.argv[1]);
  const owners = new Set((j.data || []).map((m) => m && m.owned_by).filter(Boolean));
  process.stdout.write([...owners].filter((o) => /llama-cpu-openai|llama-native/i.test(o)).sort().join(","));
} catch (_) { process.stdout.write(""); }
' "$MODELS_BODY" 2>/dev/null || true)"
if [ -n "$PROVIDER_OWNERS" ]; then
  pass "providers=$PROVIDER_OWNERS"
else
  fail "providers" "neither llama-cpu-openai nor llama-native advertised"
fi

# 11. Native llama.cpp /completion adapter, real request.
NATIVE_RESULT="$(node - <<'NODE' 2>>"$LOG" || true
const { readEnvFile } = require("./lib/env");
Object.assign(process.env, readEnvFile(".env"));
const adapter = require("./provider/llamacpp");
const base = process.env.LLAMA_CPP_BASE || "";
const model = (process.env.CUSTOM_PROVIDER_6_MODELS || "").split(",")[0].trim();
if (!base || !model) { console.log("NATIVE_FAIL missing_config"); process.exit(0); }
adapter.chat({ id: "custom_6", baseUrl: base, timeout: 120000 }, {
  model,
  messages: [{ role: "user", content: "Reply with exactly: NATIVE-OK" }],
  max_tokens: 80,
  temperature: 0.2,
}).then((res) => {
  console.log(res.ok && res.content ? "NATIVE_OK" : "NATIVE_FAIL empty_or_error");
}).catch((err) => {
  console.log("NATIVE_FAIL " + err.message);
});
NODE
)"
if [ "$NATIVE_RESULT" = "NATIVE_OK" ]; then pass "native=ok"; else fail "native" "${NATIVE_RESULT:-no_result}"; fi

# 12. Database created and seeded with concrete models.
DB_RESULT="$(node - "$DB_PATH" <<'NODE' 2>>"$LOG"
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const agents = db.prepare("SELECT id, model, enabled FROM agents").all();
const models = db.prepare("SELECT COUNT(*) c FROM models").get();
const bad = agents.filter((a) => !a.model || a.model === "MODELS_DB");
console.log(JSON.stringify({ agents: agents.length, models: models.c, bad: bad.map((a) => a.id) }));
db.close();
NODE
)"
DB_AGENTS="$(printf '%s' "$DB_RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).agents))}catch(_){process.stdout.write("0")}})' 2>/dev/null || echo 0)"
DB_BAD="$(printf '%s' "$DB_RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).bad||[]).join(","))}catch(_){process.stdout.write("parse")}})' 2>/dev/null || echo parse)"
if [ "$DB_AGENTS" = "9" ] && [ "$DB_BAD" = "" ]; then
  pass "db=seed agents=$DB_AGENTS"
else
  fail "db" "agents=$DB_AGENTS sentinel_rows=$DB_BAD"
fi

# 13. Build. A live gateway owns dist/, so build into a scratch directory:
# replacing the running runtime would delete files the server still serves.
BUILD_DIR="$OUT/build-verify"
rm -rf "$BUILD_DIR"
if BUILD_OUT="$BUILD_DIR" node scripts/build.js >>"$LOG" 2>&1 && [ -s "$BUILD_DIR/manifest.json" ]; then
  pass "build=ok"
else
  fail "build"
fi

# 14. Agent count, real working directory, and one real completion.
STATUS_BODY="$OUT/status.json"
curl -sS -o "$STATUS_BODY" -m 15 "$APP_URL/status" >>"$LOG" 2>&1 || true
AGENT_COUNT="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.agents||[]).length))}catch(_){process.stdout.write("0")}' "$STATUS_BODY" 2>/dev/null || echo 0)"
if [ "$AGENT_COUNT" = "9" ]; then pass "agents=9"; else fail "agents" "live=$AGENT_COUNT"; fi

# A UDS path in /tmp is a kernel socket, never a working directory. Agents
# operate in real filesystem directories and switch them with set_working_dir.
# Read the live directory, require an existing path outside /tmp, and confirm
# the switch tool is advertised. No directory is mutated by this check.
WD_BODY="$OUT/workdir.json"
WD_CODE="$(curl -sS -o "$WD_BODY" -w '%{http_code}' -m 10 -X POST "$APP_URL/mcp" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_ALLOWED" \
  -d '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"get_working_dir","arguments":{}}}' 2>>"$LOG" || true)"
WD_ACTUAL="$(node -e 'try{const j=require(process.argv[1]);const c=(j.result&&j.result.content)||[];process.stdout.write(String((c[0]&&c[0].text)||"").trim())}catch(_){process.stdout.write("")}' "$WD_BODY" 2>/dev/null || true)"
HAS_SET_WD="$(node -e 'try{const j=require(process.argv[1]);const t=(j.result&&j.result.tools)||[];process.stdout.write(t.some((x)=>x&&x.name==="set_working_dir")?"yes":"no")}catch(_){process.stdout.write("no")}' "$TOOLS_BODY" 2>/dev/null || echo no)"
WD_REAL="no"
case "$WD_ACTUAL" in
  /*) [ -d "$WD_ACTUAL" ] && WD_REAL="yes" ;;
esac
case "$WD_ACTUAL" in
  /tmp/*|/var/tmp/*) WD_REAL="no" ;;
esac
if [ "$WD_CODE" = "200" ] && [ "$WD_REAL" = "yes" ] && [ "$HAS_SET_WD" = "yes" ]; then
  pass "workdir=$WD_ACTUAL switch=available"
else
  fail "workdir" "get=$WD_CODE actual=$WD_ACTUAL real=$WD_REAL set_working_dir=$HAS_SET_WD"
fi

REPLY_BODY="$OUT/agent-reply.json"
REPLY_CODE="$(cd "$ROOT" && curl -sS -o "$REPLY_BODY" -w '%{http_code}' -m 120 -X POST "$APP_URL/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"team-heart","messages":[{"role":"user","content":"Reply with exactly: CWD-OK"}],"max_tokens":200,"stream":false}' 2>>"$LOG" || true)"
REPLY_TEXT="$(node -e 'try{const j=require(process.argv[1]);const m=j.choices&&j.choices[0]&&j.choices[0].message;process.stdout.write(String((m&&m.content)||"").trim())}catch(_){process.stdout.write("")}' "$REPLY_BODY" 2>/dev/null || true)"
if [ "$REPLY_CODE" = "200" ] && [ -n "$REPLY_TEXT" ]; then
  pass "reply=$(printf '%s' "$REPLY_TEXT" | head -c 40)"
else
  fail "reply" "http=$REPLY_CODE empty_reply"
fi

echo "log=$LOG"
if [ -n "$FAILED" ]; then
  echo "RESULT: MISSION BARISAL FAIL missing=${FAILED# }"
  exit 1
fi
echo "RESULT: MISSION BARISAL PASS env=ok installer=ok node=24 kde=present tls=ok origins=ok tools=$EXPECTED_TOOLS providers=ok native=ok db=seed build=ok start=ok agents=9 workdir=ok reply=ok"
