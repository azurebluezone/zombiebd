#!/usr/bin/env bash
# Mission Barisal one-line bootstrap.
#
#   curl -fsSL https://raw.githubusercontent.com/azurebluezone/zombiebd/main/install.sh | bash -s -- "$HOME/zombiebd" --yes
#   bash install.sh [TARGET_DIR] [installer flags]
#
# This file only bootstraps: it checks git/curl, clones the repo into
# TARGET_DIR (default $HOME/zombiebd), then delegates to the proven installer
# inside the checkout (scripts/install.sh). That installer finds or downloads
# Node.js 24+, installs KDE only when missing, creates .env with the local
# Ollama URL, installs Caddy only when missing, builds dist/, installs the
# systemd user unit, starts the gateway and runs the live verification
# (providers FAIL when no provider exists).
#
# Pass-through flags: --yes, --skip-kde, --skip-caddy, --no-start.
# Bootstrap flags: --check (read-only plan), --clone-only, --dir <path>,
# --repo <url>, --help.
set -uo pipefail

REPO_URL="${ZC_REPO_URL:-https://github.com/azurebluezone/zombiebd.git}"
TARGET="${ZC_TARGET:-$HOME/zombiebd}"
MODE="install"
CLONE_ONLY=0
TARGET_SET=0
PASSTHRU=()

usage() {
  cat <<'EOF'
Mission Barisal one-line bootstrap

  curl -fsSL https://raw.githubusercontent.com/azurebluezone/zombiebd/main/install.sh \
    | bash -s -- [TARGET_DIR] [installer flags]

  bash install.sh [TARGET_DIR] [installer flags]

TARGET_DIR defaults to $HOME/zombiebd. The bootstrap clones the repo there and
runs scripts/install.sh inside it; that installer handles Node.js 24+, KDE,
Caddy, .env with the local Ollama URL, build, systemd and the live test.

Installer flags:  --yes  --skip-kde  --skip-caddy  --no-start
Bootstrap flags:  --check  --clone-only  --dir <path>  --repo <url>  --help
EOF
}

have() { command -v "$1" >/dev/null 2>&1; }
die() { echo "BOOTSTRAP_FAIL $*" >&2; exit 1; }
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --check) MODE="check" ;;
    --clone-only) CLONE_ONLY=1 ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir needs a path"
      TARGET="$2"
      TARGET_SET=1
      shift
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo needs a URL"
      REPO_URL="$2"
      shift
      ;;
    --*) PASSTHRU+=("$1") ;;
    *)
      if [ "$TARGET_SET" = 0 ]; then
        TARGET="$1"
        TARGET_SET=1
      else
        PASSTHRU+=("$1")
      fi
      ;;
  esac
  shift
done

ensure_tool() {
  local tool="$1"
  have "$tool" && return 0
  if have apt-get && { [ "$(id -u)" -eq 0 ] || have sudo; }; then
    echo "installing $tool"
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$tool" \
      || die "cannot install $tool"
    return 0
  fi
  die "$tool is required; install it and re-run"
}

parent="$(dirname "$TARGET")"

# --check is read-only: report the plan, never install tools or create dirs.
if [ "$MODE" = "check" ]; then
  if [ -d "$parent" ]; then
    TARGET="$(cd "$parent" && pwd)/$(basename "$TARGET")"
  fi
  echo "bootstrap repo=$REPO_URL target=$TARGET"
  echo "git=$(git --version 2>/dev/null || echo none)"
  echo "curl=$(curl --version 2>/dev/null | head -1 || echo none)"
  echo "node=$(command -v node >/dev/null 2>&1 && node -v || echo none)"
  if [ -f "$TARGET/scripts/install.sh" ]; then
    bash "$TARGET/scripts/install.sh" --check || die "installer preflight failed"
  else
    echo "would clone into $TARGET"
  fi
  echo "BOOTSTRAP_CHECK_OK target=$TARGET"
  exit 0
fi

ensure_tool git
ensure_tool curl
mkdir -p "$parent" 2>/dev/null || die "cannot create parent directory: $parent"
TARGET="$(cd "$parent" && pwd)/$(basename "$TARGET")"

echo "bootstrap repo=$REPO_URL target=$TARGET"

if [ -d "$TARGET/.git" ]; then
  if [ "${ZC_SKIP_PULL:-0}" != "1" ]; then
    git -C "$TARGET" pull --ff-only \
      || echo "WARN pull failed; using the existing checkout" >&2
  fi
elif [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  die "target exists and is not a git checkout: $TARGET"
else
  echo "cloning $REPO_URL -> $TARGET"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$REPO_URL" "$TARGET" \
    || die "git clone failed"
fi

[ -f "$TARGET/scripts/install.sh" ] \
  || die "installer missing after clone: $TARGET/scripts/install.sh"

if [ "$CLONE_ONLY" = 1 ]; then
  echo "BOOTSTRAP_CLONE_OK target=$TARGET"
  exit 0
fi

cd "$TARGET" || die "cannot cd $TARGET"
echo "delegating to scripts/install.sh"
if [ "${#PASSTHRU[@]}" -gt 0 ]; then
  bash scripts/install.sh --yes "${PASSTHRU[@]}" || die "installer failed"
else
  bash scripts/install.sh --yes || die "installer failed"
fi
echo "BOOTSTRAP_DONE target=$TARGET"
