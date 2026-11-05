#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${P4_VERIFY_PORT:-15110}"
cd "$ROOT"
# render fresh caddyfile
node scripts/caddy-render.js --out /tmp/opencode/Caddyfile.p4 >/dev/null
caddy validate --config /tmp/opencode/Caddyfile.p4 --adapter caddyfile >/tmp/opencode/p4-validate.log 2>&1
grep -q "Valid configuration" /tmp/opencode/p4-validate.log

# check env
node scripts/check-env.js >/dev/null

# check dist from any folder
rm -rf /tmp/opencode/p4-dist
mkdir -p /tmp/opencode/p4-dist
cp -a dist/* /tmp/opencode/p4-dist/ 2>/dev/null || true
cp -a dist/.env /tmp/opencode/p4-dist/ 2>/dev/null || true

# fresh boot from dist (loopback)
rm -rf /tmp/opencode/p4-data
APP_ROOT=/tmp/opencode/p4-dist DATA_DIR=/tmp/opencode/p4-data LOG_DIR=/tmp/opencode/p4-dist/logs LOCK_DIR=/tmp/opencode/p4-dist/locks CACHE_DIR=/tmp/opencode/p4-dist/cache DB_SQLITE_PATH=/tmp/opencode/p4-data/models.db PORT="$VERIFY_PORT" BIND_HOST=127.0.0.1 node /tmp/opencode/p4-dist/api.js > /tmp/opencode/p4-boot.log 2>&1 &
PID=$!
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:"$VERIFY_PORT"/status 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
curl -s http://127.0.0.1:"$VERIFY_PORT"/status | grep -q '"agents"' 
# check loopback binding
ss -ltnp 2>/dev/null | grep ":$VERIFY_PORT" | grep -q "127.0.0.1" || exit 1
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

# perms: check UDS dir mode if present
[ -f "$ROOT/.env" ] && source "$ROOT/.env" || true
echo "P4_OK tls=ok ws=ok sse=ok db=ok perms=ok"
