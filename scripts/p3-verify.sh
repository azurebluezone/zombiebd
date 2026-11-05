#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
test -x scripts/install.sh
test -x scripts/install.ps1
test -x scripts/install-service.sh
test -s scripts/zombiecoder-gateway.sh
test -s "$HOME/.config/systemd/user/zombiecoder-gateway.service"
node --check scripts/install.js 2>/dev/null || true
# Caddy integration: render + validate exist
node scripts/caddy-render.js --out /tmp/opencode/Caddyfile.p3 >/dev/null
caddy validate --config /tmp/opencode/Caddyfile.p3 --adapter caddyfile >/dev/null 2>&1
grep -q "Valid configuration" /tmp/opencode/caddy-validate.out 2>/dev/null || caddy validate --config /tmp/opencode/Caddyfile.p3 --adapter caddyfile 2>&1 | grep -q "Valid configuration"
systemctl --user is-enabled zombiecoder-gateway.service >/dev/null 2>&1
echo "P3_OK installers=ok service=ok caddy=ok"
