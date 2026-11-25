#!/usr/bin/env bash
# verify-start-dist.sh — prove the single-entry contract:
#   the repo-root start.js rebuilds dist/ and serves api.js from that dist/.
#
# Isolated: ZC_DIST_DIR, DATA_DIR, LOG_DIR, DB, UDS and PORT are all temporary.
# The live dist/ and the live gateway are never replaced. If the systemd unit
# is active, its MainPID is also checked to be the root start.js (not
# dist/start.js), so the live path is proven, not inferred.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${START_DIST_PORT:-15115}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/zbd-start-dist.XXXXXX")"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID" 2>/dev/null || true
    for _ in $(seq 1 40); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$PID" 2>/dev/null || true
  fi
  wait "$PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL $*"
  [ -f "$TMP/start.log" ] && tail -40 "$TMP/start.log"
  exit 1
}

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ]; then
  for c in "$HOME/.local/node-v24/bin/node" "$(command -v node || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi
[ -n "$NODE_BIN" ] || { echo "FAIL node missing"; exit 1; }

mkdir -p "$TMP/data" "$TMP/logs" "$TMP/cache" "$TMP/locks"
START_TS="$(date +%s)"

env \
  ZC_DIST_DIR="$TMP/dist" \
  PORT="$PORT" \
  BIND_HOST=127.0.0.1 \
  GRPC=0 \
  GRPC_PORT="$((PORT + 1))" \
  HTTPS_PORT="$((PORT + 2))" \
  HTTPS_CERT_PATH="$TMP/cert.pem" \
  HTTPS_KEY_PATH="$TMP/key.pem" \
  BRIDGE_AUTORUN=0 \
  BRIDGE_PORT="$((PORT + 3))" \
  UDS="$TMP/mcp.sock" \
  UDS_PATH="$TMP/mcp.sock" \
  UDS_OPENAI=0 \
  DATA_DIR="$TMP/data" \
  LOG_DIR="$TMP/logs" \
  CACHE_DIR="$TMP/cache" \
  LOCK_DIR="$TMP/locks" \
  MCP_CLIENTS_FILE="$TMP/data/mcp-clients.json" \
  DB_SQLITE_PATH="$TMP/data/models.db" \
  DB_BOOTSTRAP=1 \
  "$NODE_BIN" "$ROOT/start.js" --start-all -s >"$TMP/start.log" 2>&1 &
PID=$!

ok=0
for _ in $(seq 1 120); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then ok=1; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
[ "$ok" = "1" ] || fail "health check did not return 200"

grep -Fq "BUILD_OK" "$TMP/start.log" || fail "BUILD_OK marker missing"
grep -Fq "serving from dist: $TMP/dist/api.js" "$TMP/start.log" || fail "runtime dist marker missing"
[ -s "$TMP/dist/manifest.json" ] || fail "manifest missing"
[ -s "$TMP/dist/VERSION" ] || fail "VERSION missing"
[ -f "$TMP/dist/api.js" ] || fail "dist/api.js missing"

# Built code must be a byte-for-byte copy of the source it claims to serve.
SRC_HASH="$("$NODE_BIN" -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$ROOT/api.js")"
DIST_HASH="$("$NODE_BIN" -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/dist/api.js")"
MANIFEST_HASH="$("$NODE_BIN" -e 'const m=require(process.argv[1]);const f=(m.files||[]).find(x=>x.path==="api.js");process.stdout.write(f?f.sha256:"")' "$TMP/dist/manifest.json")"
[ "$SRC_HASH" = "$DIST_HASH" ] || fail "dist/api.js does not match source api.js"
[ "$SRC_HASH" = "$MANIFEST_HASH" ] || fail "manifest api.js sha256 does not match source"

# Freshness: the manifest was written during this run, not reused.
BUILT_AT="$("$NODE_BIN" -e 'const m=require(process.argv[1]);process.stdout.write(String(m.builtAt||""))' "$TMP/dist/manifest.json")"
BUILT_TS="$(date -d "$BUILT_AT" +%s 2>/dev/null || echo 0)"
[ "$BUILT_TS" -ge "$START_TS" ] || fail "manifest is stale builtAt=$BUILT_AT"

# State and env are links to one checkout copy, never duplicated.
[ -L "$TMP/dist/.env" ] || fail ".env is not a symlink"
[ "$(readlink -f "$TMP/dist/.env")" = "$(readlink -f "$ROOT/.env")" ] || fail ".env link target"
for d in data logs cache locks .missionbarisal; do
  [ -L "$TMP/dist/$d" ] || fail "$d is not a symlink"
  [ "$(readlink -f "$TMP/dist/$d")" = "$(readlink -f "$ROOT/$d")" ] || fail "$d link target"
done

# The live dist/ must still exist; the isolated run must not delete it.
[ -d "$ROOT/dist" ] || fail "live dist disappeared"

# Live service path, when the unit exists. This is the proof that the service
# starts the root launcher, not a copied dist/start.js.
if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet zombiecoder-gateway.service 2>/dev/null; then
  UNIT="$(systemctl --user cat zombiecoder-gateway.service 2>/dev/null || true)"
  case "$UNIT" in
    *"ExecStart=$ROOT/scripts/zombiecoder-gateway.sh"*) ;;
    *) fail "unit ExecStart is not $ROOT/scripts/zombiecoder-gateway.sh" ;;
  esac
  WD="$(systemctl --user show -p WorkingDirectory --value zombiecoder-gateway.service 2>/dev/null || true)"
  [ "$WD" = "$ROOT" ] || fail "unit WorkingDirectory=$WD (expected $ROOT)"
  MAINPID="$(systemctl --user show -p MainPID --value zombiecoder-gateway.service 2>/dev/null || echo 0)"
  [ "$MAINPID" -gt 0 ] 2>/dev/null || fail "service MainPID missing"
  CMD="$(tr '\0' ' ' < "/proc/$MAINPID/cmdline" 2>/dev/null || true)"
  case "$CMD" in
    *"$ROOT/start.js"*) ;;
    *) fail "service MainPID is not root start.js: $CMD" ;;
  esac
  case "$CMD" in
    *"dist/start.js"*) fail "service still runs dist/start.js" ;;
  esac
  echo "LIVE_SERVICE_OK pid=$MAINPID working_directory=$WD"
else
  echo "LIVE_SERVICE=inactive (unit not checked)"
fi

echo "START_DIST_OK dist=$TMP/dist api_sha256=$SRC_HASH builtAt=$BUILT_AT health=200"
