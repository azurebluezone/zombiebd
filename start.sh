#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════
# ZombieCoder — Mission Barisal · Gateway Server — Linux launcher
# Usage:  ./start.sh            (first run copies .env from example)
# ════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m %s\033[0m\n' "$*"; }

NODE_VER="$(node -v 2>/dev/null || true)"
if [ -z "$NODE_VER" ]; then
  warn "Node.js পাওয়া যায়নি। প্রথমে Node ≥ 24 ইনস্টল করো:"
  echo "   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -"
  echo "   sudo apt-get install -y nodejs"
  exit 1
fi
MAJOR="${NODE_VER#v}"; MAJOR="${MAJOR%%.*}"
if [ "$MAJOR" -lt 24 ]; then
  warn "Node $NODE_VER — ২৪+ দরকার (node:sqlite, zero-dependency DB)।"
  exit 1
fi
info "✓ Node $NODE_VER"

# Ollama (ঐচ্ছিক — লোকাল মডেলের জন্য)। না থাকলে শুধু ক্লাউড provider-রা চলে।
OLLAMA_BASE_VAL="$(grep -E '^OLLAMA_BASE=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
OLLAMA_BASE_VAL="${OLLAMA_BASE_VAL:-http://127.0.0.1:11434/v1}"
if command -v ollama >/dev/null 2>&1; then
  if ! curl -sf "${OLLAMA_BASE_VAL%/v1}/v1/models" >/dev/null 2>&1; then
    warn "ollama ইনস্টল আছে কিন্তু চলছে না → লোকাল মডেল আসবে না।"
    warn "   চালাও: ollama serve   (বা pull করো: ollama pull llama3.2:latest)"
  else
    info "✓ ollama reachable (llama3.2:latest = $("${OLLAMA_LIST:-ollama list}" --format json 2>/dev/null | grep -c llama3.2 || echo "?") )"
  fi
fi

# প্রথম রান: .env না থাকলে .env.example থেকে তৈরি করে দেখিয়ে দিই।
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env তৈরি হয়েছে (.env.example থেকে) — এখন keys বসাও:"
  warn "   nano .env   →   তারপর আবার ./start.sh চালাও"
  echo
fi

info "Booting ZombieCoder (PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)) ..."
exec node start.js --start-all -s