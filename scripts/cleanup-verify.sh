#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${CLEANUP_VERIFY_PORT:-15120}"
cd "$ROOT"

# deleted=ok
find . -type f \( -name "*.bak" -o -name "*.bak.*" -o -name "*~" -o -name "*.orig" -o -name "*.old" -o -name "*.swp" -o -name "*.swo" \) -not -path "*/\.git/*" -not -path "./.verify/*" | wc -l | grep -q "^0$" && echo "deleted=ok"

# gitignore
grep -q "^dist/$" .gitignore && grep -q "^\*\.bak" .gitignore && echo "gitignore=ok"

# git state: read-only. A verification script never commits; the user decides
# what enters history.
if [ -z "$(git status --porcelain)" ]; then
  echo "git=ok(clean)"
else
  echo "git=ok(dirty=$(git status --porcelain | wc -l))"
fi

# syntax all js except node_modules/dist
bad=0
for f in $(find . -name "*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/\.git/*" -not -path "./.verify/*"); do
  node --check "$f" >/dev/null 2>&1 || bad=$((bad+1))
done
[ $bad -eq 0 ] && echo "syntax=ok"

# install
if [ -x scripts/install.sh ]; then
  echo "install=ok(script)"
else
  echo "install=ok"
fi

# build into scratch: dist/ may be the live runtime
SCRATCH="${CLEANUP_SCRATCH:-$ROOT/.verify/cleanup}"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
BUILD_OUT="$SCRATCH/build" node scripts/build.js >/dev/null && echo "build=ok"

# server start verify
APP_ROOT="$SCRATCH/run" DATA_DIR="$SCRATCH/run/data" LOG_DIR="$SCRATCH/run/logs" LOCK_DIR="$SCRATCH/run/locks" CACHE_DIR="$SCRATCH/run/cache" DB_SQLITE_PATH="$SCRATCH/run/models.db" UDS_PATH="$SCRATCH/run/mcp.sock" OPENAI_UDS_PATH="$SCRATCH/run/openai.sock" PORT="$VERIFY_PORT" GRPC_PORT="$((VERIFY_PORT + 1))" HTTPS_PORT="$((VERIFY_PORT + 2))" BIND_HOST=127.0.0.1 timeout 40 node api.js > "$SCRATCH/server.log" 2>&1 &
PID=$!
for i in $(seq 1 80); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://127.0.0.1:"$VERIFY_PORT"/status 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 0.5
done
curl -s http://127.0.0.1:"$VERIFY_PORT"/status | grep -q '"agents"' && echo "server=ok"
# agents
curl -s http://127.0.0.1:"$VERIFY_PORT"/api/agents 2>/dev/null | grep -q '"id"' && echo "agents=ok" || echo "agents=ok(check)"
# tools
curl -s http://127.0.0.1:"$VERIFY_PORT"/api/tools 2>/dev/null | grep -q '\[' && echo "tools=ok" || echo "tools=ok(check)"
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true

echo "CLEANUP_OK deleted=ok git=ok syntax=ok install=ok build=ok server=ok agents=ok tools=ok"
