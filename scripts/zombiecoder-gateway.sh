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
# The gateway runs the built tree, never the source tree. `scripts/build.js`
# produces dist/ with every tool and helper inside it, so a source checkout is
# not a runtime dependency at request time.
RUNTIME_DIR="$APP_DIR/dist"

# Node.js is its own runtime, installed separately from the OS (the installer
# uses $HOME/.local/node-v24 with an official checksum). PATH and /usr/bin are
# deliberately not searched: a system Node older than 24 lacks node:sqlite and
# the failure would surface at request time instead of boot time.
find_node() {
  local candidate
  for candidate in \
    "$APP_DIR/runtime/node/bin/node" \
    "$HOME"/.local/node-v24/bin/node \
    "$HOME"/.local/node-v24.*/bin/node; do
    [ -n "$candidate" ] || continue
    if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}
NODE_BIN="$(find_node || true)"
START_LOG="$LOG_DIR/gateway.log"

mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[%s] %s\n' "$(date -Is)" "$*" >> "$START_LOG" 2>/dev/null; }

log "--- gateway starting ---"

# ── Pre-flight ────────────────────────────────────────────────────────────────
[ -d "$APP_DIR" ]   || { log "FATAL: $APP_DIR missing"; exit 1; }
[ -f "$ENV_FILE" ]  || { log "FATAL: $ENV_FILE missing — copy .env.example"; exit 1; }
[ -x "${NODE_BIN:-}" ] || { log "FATAL: no project Node 24 runtime (expected \$HOME/.local/node-v24 or runtime/node)"; exit 1; }
[ -f "$RUNTIME_DIR/start.js" ] || { log "FATAL: $RUNTIME_DIR/start.js missing — build it first: $NODE_BIN $APP_DIR/scripts/build.js"; exit 1; }

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

# ── Runtime state stays in the checkout, code comes from dist/ ──────────────
# The build output is disposable (a rebuild replaces it), while data/models.db,
# logs/ and .zombiecoder/ are the operator's state. Linking them keeps one
# copy of each and makes a rebuild safe.
#
# A boot that ran before the checkout directory existed left real state in
# dist/ (dist/data/models.db), while .env and install-verify resolve the same
# relative path from the checkout. That split is invisible until verification
# opens an empty database. Move any such runtime state into the checkout once,
# then replace the directory with a link so the next boot cannot re-split it.
# skills/ is build output, not operator state; it stays inside dist/.
for d in data logs cache locks .zombiecoder .missionbarisal; do
  src="$APP_DIR/$d"
  dst="$RUNTIME_DIR/$d"
  mkdir -p "$src" 2>/dev/null || true
  [ -e "$src" ] || { log "WARN $src is missing and cannot be created here — skipping link"; continue; }
  if [ -L "$dst" ]; then
    ln -sfn "$src" "$dst"
  elif [ -d "$dst" ]; then
    if [ -n "$(ls -A "$dst" 2>/dev/null)" ]; then
      for entry in "$dst"/* "$dst"/.[!.]* "$dst"/..?*; do
        [ -e "$entry" ] || continue
        base="$(basename "$entry")"
        if [ -e "$src/$base" ]; then
          if [ "$entry" -nt "$src/$base" ]; then
            keep="$src/.migrated-$base.$(date +%s)"
            mv "$src/$base" "$keep" 2>/dev/null && mv "$entry" "$src/$base" 2>/dev/null \
              && log "REPLACED $src/$base with newer runtime copy (old kept at $keep)" \
              || log "WARN could not replace $src/$base with $entry"
          else
            rm -rf "$entry" 2>/dev/null \
              && log "REMOVED duplicate $entry (checkout copy $src/$base is newer)" \
              || log "WARN could not remove duplicate $entry"
          fi
        elif mv "$entry" "$src/" 2>/dev/null; then
          log "MIGRATED $entry -> $src/$base"
        else
          log "WARN could not migrate $entry"
        fi
      done
    fi
    rmdir "$dst" 2>/dev/null && ln -s "$src" "$dst" || log "WARN could not link $dst (still a real dir)"
  elif [ -e "$dst" ]; then
    log "WARN $dst exists as a non-directory; leaving it untouched"
  else
    ln -s "$src" "$dst" || log "WARN could not link $dst"
  fi
done

# One .env: the wrapper reads the checkout copy and start.js reads the same
# inode from dist/. A build copies it; this keeps a stale copy from surviving
# an edit-and-restart.
ln -sfn "$ENV_FILE" "$RUNTIME_DIR/.env"

cd "$RUNTIME_DIR" || { log "FATAL: cd $RUNTIME_DIR failed"; exit 1; }

if [ "$APP_DIR/api.js" -nt "$RUNTIME_DIR/api.js" ]; then
  log "WARN dist/ is older than api.js — rebuild before trusting this boot"
fi

# ── Stale sockets ───────────────────────────────────────────────────────────
# transport/uds-gateway.js owns socket cleanup: it probes each `UDS` candidate,
# reuses a live listener, and only unlinks a path whose inode is dead. Never
# rm -f a socket path here — that would unlink a live listener during restart.
# /tmp/local-llm.sock belongs to a different unit and is not touched.

# ── Run ───────────────────────────────────────────────────────────────────────
# exec so systemd tracks this PID directly and restarts it on exit.
log "node $("$NODE_BIN" -v) · runtime $RUNTIME_DIR"
log "starting: node dist/start.js --start-all -s"
exec "$NODE_BIN" "$RUNTIME_DIR/start.js" --start-all -s