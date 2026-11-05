#!/usr/bin/env bash
# install-edge.sh — one-time privileged Caddy install for :80/:443.
#
#   sudo bash deploy/install-edge.sh
#   bash deploy/install-edge.sh --dry-run        render + validate only
#   sudo bash deploy/install-edge.sh --keep-apache
#
# This is the only step the agent cannot perform: binding ports below 1024
# needs root, and this machine's sudo asks for a password. Everything else is
# prepared by the repository: the Caddyfile is rendered from .env, the unit
# gets CAP_NET_BIND_SERVICE instead of running Caddy as root, and the script
# stops Apache/nginx only when they own the edge ports.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
KEEP_APACHE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --keep-apache) KEEP_APACHE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'EDGE_INSTALL_FAIL %s\n' "$*" >&2; exit 1; }

if ! command -v caddy >/dev/null 2>&1; then
  if [ "$DRY_RUN" = "1" ]; then
    fail "caddy binary not found"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    say "caddy not found — installing the distribution package"
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
  else
    fail "caddy binary not found; install Caddy first"
  fi
fi

if [ ! -f .env ]; then
  fail ".env missing — copy .env.example and fill it first"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

MAIN_HOST="${MAIN_HOST:-}"
if [ -z "$MAIN_HOST" ] && [ -n "${APP_URL:-}" ]; then
  MAIN_HOST="$(node -e 'try{console.log(new URL(process.argv[1]).hostname)}catch(e){}' "$APP_URL")"
fi
[ -n "$MAIN_HOST" ] || fail "MAIN_HOST or APP_URL is required"

RENDER_TARGET="${CADDYFILE_PATH:-/etc/caddy/Caddyfile}"
if [ "$DRY_RUN" = "1" ]; then
  mkdir -p /tmp/opencode
  RENDER_TARGET="/tmp/opencode/Caddyfile.edge.$$"
fi

say "rendering $RENDER_TARGET from .env ..."
node scripts/caddy-render.js --out "$RENDER_TARGET" >/dev/null || fail "caddy-render.js failed"

say "validating $RENDER_TARGET ..."
VALIDATE_LOG="/tmp/opencode/caddy-validate.$$.log"
if ! VALIDATE_OUT="$(caddy validate --config "$RENDER_TARGET" --adapter caddyfile 2>&1)"; then
  printf '%s\n' "$VALIDATE_OUT" >&2
  fail "caddy validate rejected the rendered config"
fi
printf '%s\n' "$VALIDATE_OUT" > "$VALIDATE_LOG"
if [[ "$VALIDATE_OUT" != *"Valid configuration"* ]]; then
  printf '%s\n' "$VALIDATE_OUT" >&2
  fail "caddy validate did not report a valid configuration"
fi

if [ "$DRY_RUN" = "1" ]; then
  say "EDGE_DRY_RUN_PASS config=$RENDER_TARGET host=$MAIN_HOST"
  exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
  say "EDGE_INSTALL_NEEDS_ROOT"
  say "run once: sudo bash $ROOT/deploy/install-edge.sh"
  exit 2
fi

# Apache/nginx are the usual owners of :80. Stop them only when they are
# actually active; --keep-apache turns this into a hard stop instead.
#
# Do NOT wrap this in `systemctl list-unit-files | grep -q`: with `pipefail`
# grep exits as soon as it matches, systemctl gets SIGPIPE (141), and the
# whole pipeline is treated as failure — which is exactly how this script
# skipped the Apache stop and then failed on the still-busy port.
for svc in apache2 nginx httpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    if [ "$KEEP_APACHE" = "1" ]; then
      fail "$svc is active and --keep-apache was requested; stop it first"
    fi
    say "stopping $svc (owns :80/:443) ..."
    systemctl stop "$svc" || fail "could not stop $svc"
    say "$svc stopped; restore later with: systemctl enable --now $svc"
    systemctl disable "$svc" >/dev/null 2>&1 || true
  fi
done

PORT_OWNERS=""
for _ in $(seq 1 20); do
  PORT_OWNERS="$(ss -ltnp 2>/dev/null | grep -E ':(80|443)[[:space:]]' || true)"
  [ -z "$PORT_OWNERS" ] && break
  sleep 0.25
done
if [ -n "$PORT_OWNERS" ]; then
  say "port owner after service stop:"
  printf '%s\n' "$PORT_OWNERS" >&2
  fail "ports 80/443 are still owned by another process"
fi

if ! id -u caddy >/dev/null 2>&1; then
  useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
fi
install -d -o caddy -g caddy /var/lib/caddy
install -d -m 0755 /etc/caddy
chmod 0644 "$RENDER_TARGET"

say "installing /etc/systemd/system/caddy.service ..."
cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy edge (ZombieCoder)
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable caddy >/dev/null
systemctl restart caddy

for _ in $(seq 1 40); do
  if systemctl is-active --quiet caddy; then break; fi
  sleep 0.5
done
systemctl is-active --quiet caddy || {
  journalctl -u caddy -n 30 --no-pager >&2 || true
  fail "caddy.service is not active"
}

# Prove the user path, not just "the daemon started": :80 must redirect to
# HTTPS and https://<MAIN_HOST>/health must reach the API with a healthy body.
# --resolve pins the name to loopback, so the check does not depend on public
# DNS (which currently points at Cloudflare, not this host).
HTTP_CODE=""
HTTPS_CODE=""
HTTPS_BODY=""
HEALTH_FILE="/tmp/opencode/edge-health.$$.json"
for _ in $(seq 1 40); do
  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -m 5 -H "Host: $MAIN_HOST" http://127.0.0.1/health 2>/dev/null || true)"
  HTTPS_CODE="$(curl -k -sS -o "$HEALTH_FILE" -w '%{http_code}' -m 5 --resolve "$MAIN_HOST:443:127.0.0.1" "https://$MAIN_HOST/health" 2>/dev/null || true)"
  HTTPS_BODY="$(cat "$HEALTH_FILE" 2>/dev/null || true)"
  [ "$HTTPS_CODE" = "200" ] && break
  sleep 0.5
done

case "$HTTP_CODE" in 301|302|307|308) ;; *) fail "http :80 did not redirect to https (code=$HTTP_CODE)" ;; esac
case "$HTTPS_CODE" in 200) ;; *) journalctl -u caddy -n 30 --no-pager >&2 || true; fail "https /health returned $HTTPS_CODE" ;; esac
case "$HTTPS_BODY" in *'"healthy":true'*) ;; *) fail "https /health body is not the API health payload" ;; esac

PORT_OWNERS="$(ss -ltnp 2>/dev/null | grep -E ':(80|443)[[:space:]]' || true)"
case "$PORT_OWNERS" in
  *caddy*) ;;
  *) printf '%s\n' "$PORT_OWNERS" >&2; fail "caddy does not own :80/:443" ;;
esac
case "$PORT_OWNERS" in
  *apache2*|*nginx*|*httpd*) fail "an old edge process still owns :80/:443" ;;
esac

say "EDGE_INSTALL_PASS http=$HTTP_CODE https=$HTTPS_CODE health=ok host=$MAIN_HOST config=$RENDER_TARGET"
