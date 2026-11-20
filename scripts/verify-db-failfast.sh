#!/usr/bin/env bash
# verify-db-failfast.sh — P0-02 proof.
#
# Every case runs the real api.js composition root in an isolated temp dir:
#   1. missing DB + DB_BOOTSTRAP=0  => DB_FATAL missing, exit 78
#   2. non-SQLite file              => DB_FATAL corrupt, exit 78
#   3. held SQLite write lock       => DB_FATAL busy, exit 78 (after retries)
#   4. DB_BOOTSTRAP=1 fresh DB      => SQLITE_READY/DB_OK and /health 200
#   5. same DB, no DB_BOOTSTRAP     => DB_OK and /health 200
#   6. provider capability gates    => CAPABILITY_UNKNOWN + deny when no DB
#
# The live gateway and the live data/ directory are never touched.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || { echo "FAIL node missing"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/zbd-db-failfast.XXXXXX")"
BASE_PORT="${DB_FAILFAST_PORT:-$((20000 + (RANDOM % 20000)))}"
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL $*"
  local f
  for f in "$TMP"/*.log; do
    [ -f "$f" ] || continue
    echo "--- $f (tail)"
    tail -25 "$f"
  done
  exit 1
}

mkdir -p "$TMP/data" "$TMP/logs" "$TMP/cache" "$TMP/locks"

COMMON_ENV=(
  BIND_HOST=127.0.0.1
  GRPC=0
  UDS="$TMP/mcp.sock"
  UDS_OPENAI=0
  BRIDGE_ENABLED=0
  BRIDGE_AUTORUN=0
  WATCHDOG_INTERVAL=600000
  DATA_DIR="$TMP/data"
  LOG_DIR="$TMP/logs"
  CACHE_DIR="$TMP/cache"
  LOCK_DIR="$TMP/locks"
  MCP_CLIENTS_FILE="$TMP/data/mcp-clients.json"
)

run_fatal() { # name db bootstrap port [extra env assignments...]
  local name="$1" db="$2" bootstrap="$3" port="$4"
  shift 4
  timeout 30s env "${COMMON_ENV[@]}" \
    PORT="$port" DB_SQLITE_PATH="$db" DB_BOOTSTRAP="$bootstrap" \
    HTTPS_PORT="$((port + 2))" "$@" \
    "$NODE_BIN" "$ROOT/api.js" >"$TMP/$name.log" 2>&1
  return $?
}

start_api() { # name db bootstrap port [extra env assignments...]
  local name="$1" db="$2" bootstrap="$3" port="$4"
  shift 4
  env "${COMMON_ENV[@]}" \
    PORT="$port" DB_SQLITE_PATH="$db" DB_BOOTSTRAP="$bootstrap" \
    HTTPS_PORT="$((port + 2))" "$@" \
    "$NODE_BIN" "$ROOT/api.js" >"$TMP/$name.log" 2>&1 &
  LAST_PID=$!
  PIDS+=("$LAST_PID")
}

wait_health() { # name port pid
  local name="$1" port="$2" pid="$3" code
  for _ in $(seq 1 160); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 \
      "http://127.0.0.1:$port/health" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    kill -0 "$pid" 2>/dev/null || fail "$name exited before /health 200"
    sleep 0.25
  done
  fail "$name /health timeout"
}

stop_api() { # pid
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

# ── 1. Missing DB is fatal unless DB_BOOTSTRAP=1 ───────────────────────
MISSING_DB="$TMP/data/missing.db"
rm -f "$MISSING_DB"
run_fatal missing "$MISSING_DB" 0 "$BASE_PORT"
code=$?
[ "$code" -eq 78 ] || fail "missing DB exit=$code (expected 78)"
grep -qF "DB_FATAL missing" "$TMP/missing.log" || fail "missing DB marker absent"
grep -qF "path=" "$TMP/missing.log" || fail "missing DB path= absent"
[ ! -e "$MISSING_DB" ] || fail "missing DB was created without DB_BOOTSTRAP=1"

# ── 2. A file that is not SQLite is corruption, not a bootstrap ────────
CORRUPT_DB="$TMP/data/corrupt.db"
printf 'not a sqlite file' >"$CORRUPT_DB"
run_fatal corrupt "$CORRUPT_DB" 1 "$((BASE_PORT + 1))"
code=$?
[ "$code" -eq 78 ] || fail "corrupt DB exit=$code (expected 78)"
grep -qF "DB_FATAL corrupt" "$TMP/corrupt.log" || fail "corrupt DB marker absent"
[ -e "$CORRUPT_DB" ] || fail "corrupt DB was renamed/deleted"

# ── 2b. Installer one-shot creates/validates a DB without a listener ──
ONESHOT_DB="$TMP/data/oneshot.db"
rm -f "$ONESHOT_DB"
env "${COMMON_ENV[@]}" DB_SQLITE_PATH="$ONESHOT_DB" DB_BOOTSTRAP=1 \
  "$NODE_BIN" "$ROOT/api.js" --db-bootstrap >"$TMP/oneshot.log" 2>&1
code=$?
[ "$code" -eq 0 ] || fail "one-shot bootstrap exit=$code (expected 0)"
grep -qF "DB_OK" "$TMP/oneshot.log" || fail "one-shot bootstrap DB_OK absent"
[ -s "$ONESHOT_DB" ] || fail "one-shot bootstrap did not create $ONESHOT_DB"
env "${COMMON_ENV[@]}" DB_SQLITE_PATH="$ONESHOT_DB" \
  "$NODE_BIN" "$ROOT/api.js" --db-bootstrap >"$TMP/oneshot-verify.log" 2>&1
code=$?
[ "$code" -eq 0 ] || fail "one-shot verify exit=$code (expected 0)"
grep -qF "DB_OK" "$TMP/oneshot-verify.log" || fail "one-shot verify DB_OK absent"

# ── 3. Bootstrap creates a fresh DB and serves /health 200 ─────────────
FRESH_DB="$TMP/data/fresh.db"
FILTERED_DB="$TMP/data/busy.db"
rm -f "$FRESH_DB" "$FILTERED_DB"
start_api bootstrap "$FRESH_DB" 1 "$((BASE_PORT + 3))"
BOOT_PID=$LAST_PID
wait_health bootstrap "$((BASE_PORT + 3))" "$BOOT_PID"
grep -qF "DB_BOOTSTRAP_CREATE" "$TMP/bootstrap.log" || fail "bootstrap create marker absent"
grep -qF "SQLITE_READY" "$TMP/bootstrap.log" || fail "SQLITE_READY absent"
grep -qF "DB_OK" "$TMP/bootstrap.log" || fail "DB_OK absent"
[ -s "$FRESH_DB" ] || fail "bootstrap did not create $FRESH_DB"
stop_api "$BOOT_PID"

# ── 4. The same DB boots without DB_BOOTSTRAP and serves /health 200 ───
start_api normal "$FRESH_DB" 0 "$((BASE_PORT + 4))"
NORMAL_PID=$LAST_PID
wait_health normal "$((BASE_PORT + 4))" "$NORMAL_PID"
grep -qF "DB_OK" "$TMP/normal.log" || fail "normal boot DB_OK absent"
stop_api "$NORMAL_PID"

# ── 5. A held write lock retries, then exits 78 with DB_FATAL busy ─────
start_api busy-seed "$FILTERED_DB" 1 "$((BASE_PORT + 5))"
SEED_PID=$LAST_PID
wait_health busy-seed "$((BASE_PORT + 5))" "$SEED_PID"
stop_api "$SEED_PID"
"$NODE_BIN" - "$FILTERED_DB" <<'NODE' || fail "could not switch busy.db to rollback journal"
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
const mode = db.prepare("PRAGMA journal_mode = DELETE").get();
db.close();
if (String(Object.values(mode)[0] || "").toLowerCase() !== "delete") {
  console.error("journal_mode=" + JSON.stringify(mode));
  process.exit(1);
}
NODE

"$NODE_BIN" - "$FILTERED_DB" >"$TMP/lock.log" 2>&1 <<'NODE' &
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2]);
db.exec("BEGIN EXCLUSIVE");
process.stdout.write("LOCKED\n");
setTimeout(() => {
  try { db.exec("COMMIT"); } catch (_) {}
  db.close();
}, 15000);
NODE
LOCK_PID=$!
PIDS+=("$LOCK_PID")
for _ in $(seq 1 60); do
  grep -qF "LOCKED" "$TMP/lock.log" && break
  kill -0 "$LOCK_PID" 2>/dev/null || fail "locker exited before LOCKED"
  sleep 0.1
done
grep -qF "LOCKED" "$TMP/lock.log" || fail "locker never acquired the write lock"

run_fatal busy "$FILTERED_DB" 0 "$((BASE_PORT + 6))" \
  DB_BUSY_TIMEOUT_MS=200 DB_BUSY_RETRY_MS=100
code=$?
[ "$code" -eq 78 ] || fail "busy DB exit=$code (expected 78)"
grep -qF "DB_FATAL busy" "$TMP/busy.log" || fail "busy DB marker absent"
grep -qF "DB_BUSY_RETRY" "$TMP/busy.log" || fail "busy DB retry marker absent"
stop_api "$LOCK_PID"

# ── 6. Capability queries deny when no DB handle is attached ───────────
if ! "$NODE_BIN" "$ROOT/scripts/verify-capability-failclosed.js" \
  >"$TMP/capability.out" 2>"$TMP/capability.log"; then
  fail "capability gates did not deny without a DB"
fi
grep -qF "CAPABILITY_FAILCLOSED_OK" "$TMP/capability.out" || fail "capability marker absent"
grep -qF "CAPABILITY_UNKNOWN" "$TMP/capability.log" || fail "CAPABILITY_UNKNOWN warning absent"

echo "DB_FAILFAST_OK"
