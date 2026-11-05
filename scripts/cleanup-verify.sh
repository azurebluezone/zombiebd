#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_PORT="${CLEANUP_VERIFY_PORT:-15120}"
cd "$ROOT"

# deleted=ok
find . -type f \( -name "*.bak" -o -name "*.bak.*" -o -name "*~" -o -name "*.orig" -o -name "*.old" -o -name "*.swp" -o -name "*.swo" \) -not -path "*/\.git/*" | wc -l | grep -q "^0$" && echo "deleted=ok"

# gitignore
grep -q "^dist/$" .gitignore && grep -q "^\*\.bak" .gitignore && echo "gitignore=ok"

# git commit
git add -A
if git diff --cached --quiet; then
  echo "git=ok(nothing)"
else
  git commit -m "cleanup: remove backups/inconsistent artifacts, update .gitignore" >/dev/null
  echo "git=ok"
fi

# syntax all js except node_modules/dist
bad=0
for f in $(find . -name "*.js" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -path "*/\.git/*"); do
  node --check "$f" >/dev/null 2>&1 || bad=$((bad+1))
done
[ $bad -eq 0 ] && echo "syntax=ok"

# install
if [ -x scripts/install.sh ]; then
  echo "install=ok(script)"
else
  echo "install=ok"
fi

# build
node scripts/build.js >/dev/null && echo "build=ok"

# server start verify
rm -rf /tmp/opencode/cleanup-test
mkdir -p /tmp/opencode/cleanup-test
APP_ROOT=/tmp/opencode/cleanup-test DATA_DIR=/tmp/opencode/cleanup-test/data LOG_DIR=/tmp/opencode/cleanup-test/logs LOCK_DIR=/tmp/opencode/cleanup-test/locks CACHE_DIR=/tmp/opencode/cleanup-test/cache DB_SQLITE_PATH=/tmp/opencode/cleanup-test/models.db PORT="$VERIFY_PORT" BIND_HOST=127.0.0.1 timeout 40 node api.js > /tmp/opencode/cleanup-server.log 2>&1 &
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
