#!/usr/bin/env bash
# dist-verify: build to a scratch directory and boot that copy on loopback.
# It never deletes or overwrites dist/ because the live gateway runs from it.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${DIST_VERIFY_PORT:-15105}"
# The copy must not touch the live gateway's sockets or ports. Without these,
# a dist boot unlinked /tmp/zombiecoder/*.sock and the running gateway lost
# its UDS endpoints even though the TCP listener stayed healthy.
VERIFY_GRPC="${DIST_VERIFY_GRPC_PORT:-$((VERIFY_PORT + 1))}"
VERIFY_HTTPS="${DIST_VERIFY_HTTPS_PORT:-$((VERIFY_PORT + 2))}"
SCRATCH="${DIST_VERIFY_SCRATCH:-$ROOT/.verify/dist}"
cd "$ROOT"

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
BUILD_OUT="$SCRATCH/build" node scripts/build.js >/dev/null
test -s "$SCRATCH/build/manifest.json"
test -s "$SCRATCH/build/VERSION"
test -s "$SCRATCH/build/deploy/Caddyfile"
node -e "const m=require(process.argv[1]); if(!Array.isArray(m.files)||m.files.length<10) process.exit(1);" "$SCRATCH/build/manifest.json"

TESTDIR="$SCRATCH/run"
cp -a "$SCRATCH/build" "$TESTDIR"
cd "$TESTDIR"
APP_ROOT="$TESTDIR" DATA_DIR="$TESTDIR/data" LOG_DIR="$TESTDIR/logs" LOCK_DIR="$TESTDIR/locks" CACHE_DIR="$TESTDIR/cache" DB_SQLITE_PATH="$TESTDIR/models.db" MCP_CLIENTS_FILE="$TESTDIR/data/mcp-clients.json" UDS_PATH="$TESTDIR/mcp.sock" OPENAI_UDS_PATH="$TESTDIR/openai.sock" PORT="$VERIFY_PORT" GRPC_PORT="$VERIFY_GRPC" HTTPS_PORT="$VERIFY_HTTPS" BIND_HOST=127.0.0.1 node api.js >"$SCRATCH/boot.log" 2>&1 &
PID=$!
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:"$VERIFY_PORT"/status 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
curl -s http://127.0.0.1:"$VERIFY_PORT"/status >/dev/null
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
echo "DIST_OK manifest=ok boot=200"
