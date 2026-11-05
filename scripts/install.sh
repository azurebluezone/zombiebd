#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[install.sh] ZombieCoder installer (Linux)"
command -v node >/dev/null 2>&1 || { echo "Node.js not found; install Node 24+"; exit 1; }
NODEV=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODEV" -ge 24 ] || { echo "Node >= 24 required, found $(node -v)"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[install.sh] Copied .env.example -> .env (edit if needed)"
fi

bash scripts/install-service.sh
bash scripts/install-service.sh --start 2>&1 | tail -12 || true

echo "[install.sh] Done. Check: systemctl --user status zombiecoder-gateway.service"
