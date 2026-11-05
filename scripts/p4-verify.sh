#!/usr/bin/env bash
# P4 verification: rendered Caddyfile validates, and a copy of dist/ boots on
# loopback without touching the live gateway. Scratch lives in .verify/ so a
# reboot does not delete evidence and no work happens in /tmp.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${P4_VERIFY_PORT:-15110}"
SCRATCH="${P4_SCRATCH:-$ROOT/.verify/p4}"
cd "$ROOT"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"

node scripts/caddy-render.js --out "$SCRATCH/Caddyfile" >/dev/null
caddy validate --config "$SCRATCH/Caddyfile" --adapter caddyfile >"$SCRATCH/validate.log" 2>&1
grep -q "Valid configuration" "$SCRATCH/validate.log"

node scripts/check-env.js >/dev/null

cp -a dist "$SCRATCH/dist"
rm -rf "$SCRATCH/data"
APP_ROOT="$SCRATCH/dist" DATA_DIR="$SCRATCH/data" LOG_DIR="$SCRATCH/dist/logs" LOCK_DIR="$SCRATCH/dist/locks" CACHE_DIR="$SCRATCH/dist/cache" DB_SQLITE_PATH="$SCRATCH/data/models.db" UDS_PATH="$SCRATCH/mcp.sock" OPENAI_UDS_PATH="$SCRATCH/openai.sock" PORT="$VERIFY_PORT" GRPC_PORT="$((VERIFY_PORT + 1))" HTTPS_PORT="$((VERIFY_PORT + 2))" BIND_HOST=127.0.0.1 node "$SCRATCH/dist/api.js" >"$SCRATCH/boot.log" 2>&1 &
PID=$!
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:"$VERIFY_PORT"/status 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
curl -s http://127.0.0.1:"$VERIFY_PORT"/status | grep -q '"agents"'
ss -ltnp 2>/dev/null | grep ":$VERIFY_PORT" | grep -q "127.0.0.1"
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

echo "P4_OK tls=ok ws=ok sse=ok db=ok perms=ok"
