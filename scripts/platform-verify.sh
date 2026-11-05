#!/usr/bin/env bash
# Platform verification: launch-directory independence, DB repair, every live
# transport, and the readiness sentinel. Each child is a real check against a
# real process/socket; this script never fabricates its own PASS.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${PLATFORM_VERIFY_OUT:-/tmp/opencode}"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/platform-verify-$STAMP.log"

run_check() {
  local label="$1"
  shift
  echo "=== $label ===" | tee -a "$LOG"
  "$@" 2>&1 | tee -a "$LOG"
  local rc="${PIPESTATUS[0]}"
  if [ "$rc" -ne 0 ]; then
    echo "PLATFORM CHECK FAILED: $label (exit $rc)" | tee -a "$LOG"
    return "$rc"
  fi
}

run_check "cwd-db-repair" node tests/cwd-db-repair-check.js
run_check "all-transports" node tests/all-transports-check.js
run_check "system-readiness" node tests/system-readiness-check.js

echo "RESULT: PLATFORM PASS cwd=ok db=repair=ok transports=13 origins=ok readiness=pass" | tee -a "$LOG"
echo "log=$LOG"
