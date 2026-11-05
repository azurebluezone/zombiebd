#!/usr/bin/env bash
# boot-all.sh — one command for the whole runtime.
#
#   bash scripts/boot-all.sh              start everything that can start, then verify
#   bash scripts/boot-all.sh --verify     verify the running stack only
#   bash scripts/boot-all.sh --no-caddy   start the app stack, skip the edge
#
# The script is idempotent: a healthy service is reused, a foreign listener is
# reported and never killed. Caddy on :80/:443 needs root once; when this user
# cannot bind those ports the script says so and prints the one command to run.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="start"
for arg in "$@"; do
  case "$arg" in
    --verify) MODE="verify" ;;
    --no-caddy) MODE="no-caddy" ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p logs data

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

PORT="${PORT:-5050}"
BRIDGE_PORT="${BRIDGE_PORT:-11435}"
OLLAMA_URL="${BRIDGE_OLLAMA_URL:-http://127.0.0.1:11434}"
NODE_BIN="${NODE_BIN:-node}"

say() { printf '%s\n' "$*"; }
ok() { printf 'PASS %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; }

http_ok() {
  curl -fsS -m 3 "$1" >/dev/null 2>&1
}

wait_http() {
  local url="$1" seconds="${2:-30}" i=0
  while [ "$i" -lt "$seconds" ]; do
    if http_ok "$url"; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

ensure_ollama() {
  if http_ok "$OLLAMA_URL/api/tags"; then
    ok "ollama $OLLAMA_URL"
    return 0
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    fail "ollama binary not found"
    return 1
  fi
  say "starting ollama serve ..."
  nohup ollama serve >> logs/ollama.log 2>&1 &
  echo $! > logs/ollama.pid
  if wait_http "$OLLAMA_URL/api/tags" 30; then
    ok "ollama started"
    return 0
  fi
  fail "ollama did not become ready — logs/ollama.log"
  return 1
}

ensure_bridge() {
  if http_ok "http://127.0.0.1:$BRIDGE_PORT/health"; then
    ok "bridge :$BRIDGE_PORT"
    return 0
  fi
  if ! "$NODE_BIN" --check local-llm-bridge.js >/dev/null 2>&1; then
    fail "local-llm-bridge.js syntax"
    return 1
  fi
  say "starting local-llm-bridge.js on :$BRIDGE_PORT ..."
  nohup "$NODE_BIN" local-llm-bridge.js >> logs/bridge.log 2>&1 &
  echo $! > logs/bridge.pid
  if wait_http "http://127.0.0.1:$BRIDGE_PORT/health" 20; then
    ok "bridge started"
    return 0
  fi
  fail "bridge did not become ready — logs/bridge.log"
  tail -n 20 logs/bridge.log 2>/dev/null
  return 1
}

gateway_capabilities() {
  curl -fsS -m 3 "http://127.0.0.1:$PORT/api/system" >/dev/null 2>&1
}

wait_gateway_capabilities() {
  local seconds="${1:-20}" i=0
  while [ "$i" -lt "$seconds" ]; do
    if gateway_capabilities; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

ensure_gateway() {
  if http_ok "http://127.0.0.1:$PORT/health"; then
    local health
    health="$(curl -fsS -m 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
    case "$health" in
      *'"instance_id"'*)
        if wait_gateway_capabilities 5; then
          ok "gateway :$PORT"
          return 0
        fi
        warn "gateway :$PORT is running older code (no /api/system) — restarting"
        ;;
      *)
        fail "port $PORT is owned by a process that is not zombiebd — not touching it"
        return 1
        ;;
    esac
  fi
  if ! "$NODE_BIN" --check start.js >/dev/null 2>&1; then
    fail "start.js syntax"
    return 1
  fi
  say "starting gateway (api + 7 MCP servers + gRPC + UDS) ..."
  nohup "$NODE_BIN" start.js --start-all >> logs/start-all.log 2>&1 &
  echo $! > logs/gateway.pid
  if wait_http "http://127.0.0.1:$PORT/health" 45; then
    if wait_gateway_capabilities 20; then
      ok "gateway started"
      return 0
    fi
    fail "gateway started but /api/system is missing — logs/start-all.log"
    return 1
  fi
  fail "gateway did not become ready — logs/start-all.log"
  tail -n 30 logs/start-all.log 2>/dev/null
  return 1
}

edge_state() {
  local host="${MAIN_HOST:-}"
  local body=""
  if [ -z "$host" ] && [ -n "${APP_URL:-}" ]; then
    host="$("$NODE_BIN" -e 'try{console.log(new URL(process.argv[1]).hostname)}catch(e){}' "$APP_URL" 2>/dev/null || true)"
  fi

  if command -v caddy >/dev/null 2>&1 && [ -n "$host" ]; then
    for _ in $(seq 1 20); do
      body="$(curl -k -fsS -m 4 --resolve "$host:443:127.0.0.1" "https://$host/health" 2>/dev/null || true)"
      case "$body" in
        *'"healthy":true'*)
          ok "caddy :80/:443 live (https $host/health)"
          return 0
          ;;
      esac
      sleep 0.5
    done
    if systemctl is-active --quiet caddy 2>/dev/null; then
      fail "caddy is active but https $host/health failed — journalctl -u caddy"
      return 1
    fi
  fi

  if [ "$(id -u)" -eq 0 ]; then
    say "installing edge (root) ..."
    bash deploy/install-edge.sh
    return $?
  fi
  warn "caddy :80/:443 is not live; sudo is required once"
  say "EDGE installer-ready: sudo bash deploy/install-edge.sh"
  return 0
}

verify() {
  if [ ! -f tests/system-readiness-check.js ]; then
    fail "tests/system-readiness-check.js missing"
    return 1
  fi
  "$NODE_BIN" tests/system-readiness-check.js
}

if [ "$MODE" = "verify" ]; then
  verify
  exit $?
fi

say "=== zombiebd boot-all ==="
say "root=$ROOT node=$("$NODE_BIN" -v 2>/dev/null || echo missing)"
say "api=:$PORT bridge=:$BRIDGE_PORT ollama=$OLLAMA_URL"

ensure_ollama || exit 1
ensure_bridge || exit 1
ensure_gateway || exit 1

if [ "$MODE" != "no-caddy" ]; then
  edge_state || true
fi

verify
exit $?
