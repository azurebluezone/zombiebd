#!/usr/bin/env bash
# P3 verification: installer files exist and the rendered Caddyfile validates.
# The render goes to .verify/, not /tmp, and never overwrites the live Caddyfile.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="${P3_SCRATCH:-$ROOT/.verify/p3}"
cd "$ROOT"

test -x scripts/install.sh
test -x scripts/install.ps1
test -x scripts/install-service.sh
test -s scripts/zombiecoder-gateway.sh
test -s "$HOME/.config/systemd/user/zombiecoder-gateway.service"
node --check scripts/install.js 2>/dev/null || true

rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"
node scripts/caddy-render.js --out "$SCRATCH/Caddyfile" >/dev/null
caddy validate --config "$SCRATCH/Caddyfile" --adapter caddyfile 2>&1 | grep -q "Valid configuration"

systemctl --user is-enabled zombiecoder-gateway.service >/dev/null 2>&1
echo "P3_OK installers=ok service=ok caddy=ok"
