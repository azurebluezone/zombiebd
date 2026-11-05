#!/usr/bin/env bash
# install-verify.sh - live proof for the Mission Barisal stack.
#
#   bash scripts/install-verify.sh --quick
#
# Every line below is a real request against the running processes on this
# machine. The final sentinel is printed only when every check passed.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

OUT="${INSTALL_VERIFY_OUT:-/tmp/opencode}"
mkdir -p "$OUT"
LOG="$OUT/install-verify-$(date +%Y%m%d-%H%M%S).log"
EXPECTED_TOOLS="${EXPECTED_TOOLS:-153}"
FAILED=""

say() { echo "$*" | tee -a "$LOG"; }
pass() { say "PASS $*"; }
fail() { FAILED="$FAILED $1"; say "FAIL $1${2:+ ($2)}"; }

node_ok() { "$@" >/dev/null 2>&1; }

API_PORT="$(node -p 'require("./lib/env").loadEnv({root:process.cwd()}).ports.api' 2>/dev/null || echo 5050)"
CADDY_HTTPS="$(node -p 'require("./lib/env").loadEnv({root:process.cwd()}).ports.caddy_https' 2>/dev/null || echo 443)"
MAIN_HOST="$(node -p 'require("./lib/env").loadEnv({root:process.cwd()}).derived.mainHost' 2>/dev/null || echo localhost)"
DB_PATH="$(node -p 'const p=require("path");const v=process.env.DB_SQLITE_PATH||"data/models.db";p.resolve(process.cwd(),v)' 2>/dev/null || echo "$ROOT/data/models.db")"

say "=== Mission Barisal install verification ==="
say "api=$API_PORT caddy_https=$CADDY_HTTPS host=$MAIN_HOST db=$DB_PATH"

# 1. Documentation claims.
if node tests/docs-claims-check.js >>"$LOG" 2>&1; then pass "docs=ok"; else fail "docs"; fi

# 2. Installer preflight (read-only).
if bash scripts/install.sh --check >>"$LOG" 2>&1; then pass "installer=ok"; else fail "installer"; fi

# 3. Node major.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -ge 24 ]; then pass "node=24 ($(node -v))"; else fail "node" "found $(node -v 2>/dev/null || echo none)"; fi

# 4. KDE Plasma.
if command -v startplasma-x11 >/dev/null 2>&1 || command -v plasmashell >/dev/null 2>&1; then
  pass "kde=present"
else
  fail "kde"
fi

# 5. TLS through Caddy, system trust store (no -k).
TLS_URL="https://$MAIN_HOST"
if [ "$CADDY_HTTPS" != "443" ]; then TLS_URL="$TLS_URL:$CADDY_HTTPS"; fi
TLS_RESULT="$(curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}' -m 8 \
  --resolve "$MAIN_HOST:$CADDY_HTTPS:127.0.0.1" "$TLS_URL/health" 2>>"$LOG" || true)"
TLS_CODE="${TLS_RESULT%% *}"
TLS_VERIFY="${TLS_RESULT##* }"
if [ "$TLS_CODE" = "200" ] && [ "$TLS_VERIFY" = "0" ]; then
  pass "tls=ok"
else
  fail "tls" "http=$TLS_CODE verify=$TLS_VERIFY"
fi
if echo | openssl s_client -connect "127.0.0.1:$CADDY_HTTPS" -servername "$MAIN_HOST" -verify_return_error >/dev/null 2>&1; then
  pass "tls-chain=ok"
else
  fail "tls-chain"
fi

# 6. Origins: allowed origin works, hostile origin is rejected.
ORIGIN_ALLOWED="https://$MAIN_HOST"
ALLOW_BODY="$OUT/origin-allowed.json"
DENY_BODY="$OUT/origin-denied.json"
ALLOW_CODE="$(curl -sS -o "$ALLOW_BODY" -w '%{http_code}' -m 8 -X POST "http://127.0.0.1:$API_PORT/mcp" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_ALLOWED" \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_working_dir","arguments":{}}}' 2>>"$LOG" || true)"
DENY_CODE="$(curl -sS -o "$DENY_BODY" -w '%{http_code}' -m 8 -X POST "http://127.0.0.1:$API_PORT/mcp" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"get_working_dir","arguments":{}}}' 2>>"$LOG" || true)"
if [ "$ALLOW_CODE" = "200" ] && [ "$DENY_CODE" = "401" ]; then
  pass "origins=ok allow=$ALLOW_CODE deny=$DENY_CODE"
else
  fail "origins" "allow=$ALLOW_CODE deny=$DENY_CODE"
fi

# 7. Tool registry count over the real MCP endpoint.
TOOLS_BODY="$OUT/tools-list.json"
curl -sS -o "$TOOLS_BODY" -m 10 -X POST "http://127.0.0.1:$API_PORT/mcp" \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN_ALLOWED" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' >>"$LOG" 2>&1 || true
TOOL_COUNT="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.result&&j.result.tools||[]).length))}catch(_){process.stdout.write("0")}' "$TOOLS_BODY" 2>/dev/null || echo 0)"
if [ "$TOOL_COUNT" = "$EXPECTED_TOOLS" ]; then pass "tools=$TOOL_COUNT"; else fail "tools" "live=$TOOL_COUNT expected=$EXPECTED_TOOLS"; fi

# 8. Database created and seeded with concrete models.
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

# 9. Build.
if node scripts/build.js >>"$LOG" 2>&1 && [ -s dist/manifest.json ]; then
  pass "build=ok"
else
  fail "build"
fi

# 10. Server health.
HEALTH_BODY="$OUT/health.json"
HEALTH_CODE="$(curl -sS -o "$HEALTH_BODY" -w '%{http_code}' -m 8 "http://127.0.0.1:$API_PORT/health" 2>>"$LOG" || true)"
HEALTH_OK="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(j.healthy===true&&j.agents===9?"yes":"no")}catch(_){process.stdout.write("no")}' "$HEALTH_BODY" 2>/dev/null || echo no)"
if [ "$HEALTH_CODE" = "200" ] && [ "$HEALTH_OK" = "yes" ]; then
  pass "start=ok"
else
  fail "start" "http=$HEALTH_CODE healthy=$HEALTH_OK"
fi

# 11. llama.cpp provider + agent binding.
if node tests/llama-cpp-check.js >>"$LOG" 2>&1; then pass "llama=ok"; else fail "llama"; fi

# 12. Agent count.
STATUS_BODY="$OUT/status.json"
curl -sS -o "$STATUS_BODY" -m 8 "http://127.0.0.1:$API_PORT/status" >>"$LOG" 2>&1 || true
AGENT_COUNT="$(node -e 'try{const j=require(process.argv[1]);process.stdout.write(String((j.agents||[]).length))}catch(_){process.stdout.write("0")}' "$STATUS_BODY" 2>/dev/null || echo 0)"
if [ "$AGENT_COUNT" = "9" ]; then pass "agents=9"; else fail "agents" "live=$AGENT_COUNT"; fi

# 13. Real agent request from a different working directory.
CWD_BODY="$OUT/cwd-agent.json"
CWD_CODE="$(cd /tmp && curl -sS -o "$CWD_BODY" -w '%{http_code}' -m 90 -X POST "http://127.0.0.1:$API_PORT/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"team-heart","messages":[{"role":"user","content":"Reply with exactly: CWD-OK"}],"max_tokens":200,"stream":false}' 2>>"$LOG" || true)"
CWD_TEXT="$(node -e 'try{const j=require(process.argv[1]);const m=j.choices&&j.choices[0]&&j.choices[0].message;process.stdout.write(String((m&&m.content)||"").trim())}catch(_){process.stdout.write("")}' "$CWD_BODY" 2>/dev/null || true)"
if [ "$CWD_CODE" = "200" ] && [ -n "$CWD_TEXT" ]; then
  pass "cwd=/tmp reply=$(printf '%s' "$CWD_TEXT" | head -c 40)"
else
  fail "cwd" "http=$CWD_CODE empty_reply"
fi

echo "log=$LOG"
if [ -n "$FAILED" ]; then
  echo "RESULT: MISSION BARISAL FAIL missing=${FAILED# }"
  exit 1
fi
echo "RESULT: MISSION BARISAL PASS docs=ok installer=ok node=24 kde=present tls=ok origins=ok tools=$EXPECTED_TOOLS db=seed build=ok start=ok llama=ok agents=9 cwd=/tmp"
