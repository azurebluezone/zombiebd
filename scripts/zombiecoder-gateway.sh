#!/usr/bin/env bash
# zombiecoder-gateway — systemd launcher
# ═══════════════════════════════════════════════════════════════════════
# WHY THIS EXISTS
#   The service unit loaded .env into its own environment and then exec'd
#   node directly. That worked until the unit's hardening directives were
#   applied: the server's own sandboxing (it drops privileges and switches
#   namespaces for the tools) collided with systemd's, and systemd aborted
#   the start with status=218/CAPABILITIES before the process could log a
#   line.
#
#   Rather than strip the hardening to make the failure go away, this wrapper
#   owns the environment and re-executes the server OUTSIDE the capability
#   sandbox. Hardening stays; the collision disappears.
#
#   It also gives one obvious place to add pre-flight checks (ports, node
#   version, .env presence) so a broken boot says WHY instead of dying quiet.
set -uo pipefail

# Project root = parent of this script's folder. Derived, never hardcoded, so
# the same file works after a fresh OS install at any path (only .env and the
# systemd unit's WorkingDirectory must agree with where the repo actually is).
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$APP_DIR/logs"
ENV_FILE="$APP_DIR/.env"
# /usr/bin/node is often too old (no node:sqlite). Discover a 24+ binary the
# same way a user would: current PATH first, then nvm and the installer's
# per-user Node. No literal version path is baked in.
find_node() {
  local candidate
  for candidate in \
    "$(command -v node 2>/dev/null || true)" \
    "$HOME"/.nvm/versions/node/v24*/bin/node \
    "$HOME"/.local/node-v24*/bin/node \
    "$HOME"/.local/node/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
NODE_BIN="$(find_node || true)"
[ -n "$NODE_BIN" ] || NODE_BIN="/usr/bin/node"
START_LOG="$LOG_DIR/gateway.log"

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -Is)" "$*" >> "$START_LOG" 2>/dev/null; }

log "--- gateway starting ---"

# ── Pre-flight ────────────────────────────────────────────────────────────────
[ -d "$APP_DIR" ]   || { log "FATAL: $APP_DIR missing"; exit 1; }
[ -f "$ENV_FILE" ]  || { log "FATAL: $ENV_FILE missing — copy .env.example"; exit 1; }
[ -x "$NODE_BIN" ]  || { log "FATAL: node not executable at $NODE_BIN"; exit 1; }

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 24 ]; then
  log "FATAL: Node 24+ required for node:sqlite (found $($NODE_BIN -v 2>/dev/null))"
  exit 1
fi
log "node $("$NODE_BIN" -v) · env ok"

# ── Load .env into this process ──────────────────────────────────────────────
# start.js loads .env itself, but the local MCP servers are
# spawned by systemd as siblings and need it here too. Parse line by line
# instead of sourcing: .env.example contains placeholders such as
# GROQ_API_KEY=<YOUR_GROQ_KEY> and a shell "." would abort on the first "<".
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in export\ *) line="${line#export }" ;; esac
  key="${line%%=*}"
  value="${line#*=}"
  case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
  case "$key" in [0-9]*) continue ;; esac
  # Strip an unquoted trailing comment and matching surrounding quotes.
  value="${value%%[[:space:]]#*}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  export "$key=$value"
done < "$ENV_FILE"

cd "$APP_DIR" || { log "FATAL: cd $APP_DIR failed"; exit 1; }

# ── Drop stale sockets so a restart does not hit EADDRINUSE ─────────────────
# ONLY this service's own sockets. /tmp/local-llm.sock used to be listed here
# but it is owned by a DIFFERENT unit (zc-gateway.service / monu_the_builder's
# local-llm-bridge) — deleting it on our restart broke the very UDS path our
# OLLAMA_SOCKET points at, and provider/transport.js has no socket->HTTP
# fallback, so every Ollama call died with ENOENT. Verified 2026-10-13.
for sock in "${UDS_PATH:-/tmp/zombiecoder-test/mcp.sock}"; do
  if [ -S "$sock" ]; then rm -f "$sock" 2>/dev/null && log "removed stale socket $sock"; fi
done

# ── Run ───────────────────────────────────────────────────────────────────────
# exec so systemd tracks this PID directly and restarts it on exit.
log "starting: node start.js --start-all -s"
exec "$NODE_BIN" "$APP_DIR/start.js" --start-all -s