#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${DIST_VERIFY_PORT:-15105}"
# The dist instance must not touch the live gateway's sockets or ports. Without
# these, a dist boot unlinked /tmp/zombiecoder/*.sock and the running gateway
# lost its UDS endpoints even though the TCP listener stayed healthy.
VERIFY_GRPC="${DIST_VERIFY_GRPC_PORT:-$((VERIFY_PORT + 1))}"
VERIFY_HTTPS="${DIST_VERIFY_HTTPS_PORT:-$((VERIFY_PORT + 2))}"
cd "$ROOT"
rm -rf dist
node scripts/build.js >/dev/null
test -s dist/manifest.json
test -s dist/VERSION
test -s dist/deploy/Caddyfile
node -e "const m=require('./dist/manifest.json'); if(!Array.isArray(m.files)||m.files.length<10) process.exit(1);"
TESTDIR=$(mktemp -d /tmp/opencode/dist-verify-XXXXXX)
cp -a dist/* "$TESTDIR/"
cp -a dist/.env "$TESTDIR/" 2>/dev/null || true
cd "$TESTDIR"
APP_ROOT="$TESTDIR" DATA_DIR="$TESTDIR/data" LOG_DIR="$TESTDIR/logs" LOCK_DIR="$TESTDIR/locks" CACHE_DIR="$TESTDIR/cache" DB_SQLITE_PATH="$TESTDIR/models.db" MCP_CLIENTS_FILE="$TESTDIR/data/mcp-clients.json" UDS_PATH="$TESTDIR/mcp.sock" OPENAI_UDS_PATH="$TESTDIR/openai.sock" PORT="$VERIFY_PORT" GRPC_PORT="$VERIFY_GRPC" HTTPS_PORT="$VERIFY_HTTPS" BIND_HOST=127.0.0.1 node api.js > /tmp/opencode/dist-verify-boot.log 2>&1 &
PID=$!
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:"$VERIFY_PORT"/status 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
curl -s http://127.0.0.1:"$VERIFY_PORT"/status >/dev/null
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
rm -rf "$TESTDIR"
echo "DIST_OK manifest=ok boot=200"
