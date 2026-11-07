#!/usr/bin/env bash
# Mission Barisal installer (Linux).
#
#   bash scripts/install.sh              full install: Node 24+, KDE, .env,
#                                        Caddy/TLS, build, start, live verify
#   bash scripts/install.sh --check      read-only preflight (no writes)
#   bash scripts/install.sh --yes        non-interactive, keep existing values
#   bash scripts/install.sh --skip-kde   do not install KDE
#   bash scripts/install.sh --skip-caddy do not install/reconfigure Caddy
#   bash scripts/install.sh --no-start   build and configure, do not start
#
# The script is idempotent. It never overwrites an existing .env and never
# prints secret values. Run it as your normal user; it uses sudo when a step
# really needs root (KDE, Caddy, TLS trust).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MODE="install"
ASSUME_YES=0
SKIP_KDE=0
SKIP_CADDY=0
SKIP_START=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-kde) SKIP_KDE=1 ;;
    --skip-caddy) SKIP_CADDY=1 ;;
    --no-start) SKIP_START=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { echo; echo "== $* =="; }
ok() { echo "OK   $*"; }
warn() { echo "WARN $*" >&2; }
fail() { echo "FAIL $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}
run_user() {
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    sudo -u "$SUDO_USER" -- "$@"
  else
    "$@"
  fi
}

# Node.js is a separate runtime owned by this project, not whatever `node`
# happens to be on PATH. The installer writes it to $HOME/.local/node-v24 with
# an official checksum; the gateway wrapper reads the same path.
NODE_BIN=""
node_major() {
  [ -n "$NODE_BIN" ] || { echo 0; return; }
  "$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

find_node_24() {
  local candidate
  if [ -x "$ROOT/runtime/node/bin/node" ] &&
     "$ROOT/runtime/node/bin/node" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
    NODE_BIN="$ROOT/runtime/node/bin/node"
    return 0
  fi
  for candidate in \
    "$HOME"/.local/node-v24/bin/node \
    "$HOME"/.local/node-v24.*/bin/node; do
    if [ -x "$candidate" ] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' 2>/dev/null; then
      NODE_BIN="$candidate"
      return 0
    fi
  done
  return 1
}

install_node() {
  local home_dir="${HOME}"
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    home_dir="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
  fi
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch="linux-x64" ;;
    aarch64|arm64) arch="linux-arm64" ;;
    *) fail "unsupported CPU architecture: $(uname -m)" ;;
  esac
  have curl || fail "curl is required to download Node.js"
  have tar || fail "tar is required to unpack Node.js"
  local sums ver
  sums="$(curl -fsSL --max-time 30 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt)" \
    || fail "cannot reach nodejs.org; install Node.js 24+ manually"
  ver="$(printf '%s\n' "$sums" | grep -oE 'node-v24\.[0-9]+\.[0-9]+-'"$arch"'\.tar\.xz' | head -1)"
  [ -n "$ver" ] || fail "no Node 24 tarball for $arch"
  local tmp expected
  mkdir -p "$ROOT/.verify/install"
  tmp="$(mktemp -d "$ROOT/.verify/install/node-XXXXXX")"
  curl -fsSL --max-time 300 "https://nodejs.org/dist/latest-v24.x/$ver" -o "$tmp/$ver" \
    || fail "Node.js download failed"
  expected="$(printf '%s\n' "$sums" | awk -v f="$ver" '$2==f{print $1}')"
  [ -n "$expected" ] || fail "no checksum for $ver"
  echo "$expected  $tmp/$ver" | sha256sum -c - >/dev/null || fail "Node.js checksum mismatch"
  mkdir -p "$home_dir/.local"
  tar -xJf "$tmp/$ver" -C "$home_dir/.local" || fail "Node.js unpack failed"
  local dir
  dir="$(basename "$ver" .tar.xz)"
  ln -sfn "$home_dir/.local/$dir" "$home_dir/.local/node-v24"
  rm -rf "$tmp"
  NODE_BIN="$home_dir/.local/$dir/bin/node"
  export PATH="$home_dir/.local/$dir/bin:$PATH"
}

sha_of() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

kde_present() {
  have startplasma-x11 || have plasmashell
}

install_kde() {
  if kde_present; then ok "KDE Plasma present"; return; fi
  if [ "$SKIP_KDE" = 1 ]; then warn "KDE missing and --skip-kde was used"; return; fi
  if ! have apt-get; then warn "KDE missing; automatic install is implemented for apt-based systems only"; return; fi
  step "Installing minimal KDE Plasma (no display-manager switch)"
  as_root apt-get update || fail "apt-get update failed"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    --no-install-recommends plasma-desktop kwin-x11 plasma-workspace konsole \
    || fail "KDE install failed"
  kde_present || fail "KDE install finished but startplasma-x11/plasmashell is still missing"
  ok "KDE Plasma installed"
}

ensure_env() {
  if [ -f .env ]; then
    ok ".env exists (kept)"
  else
    [ -f .env.example ] || fail ".env.example missing"
    cp .env.example .env
    chmod 600 .env
    ok ".env created from .env.example"
  fi
  "$NODE_BIN" scripts/env-ensure.js || fail "env-ensure failed"
}

ensure_servers_config() {
  local cfg="external mcp/servers.json"
  local example="external mcp/servers.example.json"
  if [ -f "$cfg" ]; then ok "external MCP config exists (kept)"; return 0; fi
  if [ ! -f "$example" ]; then
    warn "external mcp/servers.example.json missing; external MCP tools will be absent"
    return 0
  fi
  cp "$example" "$cfg"
  chmod 600 "$cfg"
  ok "external MCP config created from example (tokens empty; credentials belong in .env)"
}

ollama_alias() {
  have curl || return 0
  local tags model
  tags="$(curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags 2>/dev/null || true)"
  [ -n "$tags" ] || { warn "Ollama not reachable on 11434 (optional)"; return 0; }
  model="$(printf '%s' "$tags" | "$NODE_BIN" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);const m=(j.models||[])[0];
      if(m&&m.name)process.stdout.write(m.name)}catch(_){}
    })')"
  [ -n "$model" ] || { warn "Ollama reachable but advertises no models"; return 0; }
  "$NODE_BIN" scripts/env-ensure.js --ollama-model "$model" || warn "could not record Ollama alias"
  ok "Ollama reachable: $model"
}

install_caddy() {
  if have caddy; then ok "Caddy present: $(caddy version 2>/dev/null | head -1)"; return; fi
  if [ "$SKIP_CADDY" = 1 ]; then warn "Caddy missing and --skip-caddy was used"; return; fi
  if ! have apt-get; then warn "Caddy missing; install it manually, then re-run"; return; fi
  step "Installing Caddy from the official apt repository"
  as_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg \
    || fail "Caddy prerequisites failed"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | as_root gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    || fail "Caddy signing key failed"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | as_root tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null \
    || fail "Caddy apt source failed"
  as_root apt-get update || fail "apt-get update failed"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy || fail "Caddy install failed"
  ok "Caddy installed"
}

configure_caddy() {
  have caddy || { warn "Caddy not installed; skipping edge configuration"; return 0; }
  step "Rendering and validating Caddyfile"
  local scratch="$ROOT/.verify/install"
  local rendered validate_log
  mkdir -p "$scratch"
  rendered="$scratch/Caddyfile.$$"
  validate_log="$scratch/caddy-validate.$$.log"
  "$NODE_BIN" scripts/caddy-render.js --out "$rendered" >/dev/null || fail "Caddyfile render failed"
  caddy validate --config "$rendered" --adapter caddyfile >"$validate_log" 2>&1 \
    || { tail -20 "$validate_log" >&2; fail "Caddyfile validation failed"; }
  ok "Caddyfile valid"
  if [ "$SKIP_CADDY" = 1 ]; then
    warn "SKIP_CADDY: rendered file left at $rendered"
    return 0
  fi
  if [ -f /etc/caddy/Caddyfile ] && [ "$(sha_of /etc/caddy/Caddyfile)" = "$(sha_of "$rendered")" ]; then
    ok "/etc/caddy/Caddyfile already current"
  else
    if [ -f /etc/caddy/Caddyfile ]; then
      as_root cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)" || fail "Caddyfile backup failed"
    fi
    as_root install -m 644 "$rendered" /etc/caddy/Caddyfile || fail "Caddyfile install failed"
    ok "/etc/caddy/Caddyfile updated"
  fi
  as_root systemctl enable --now caddy >/dev/null 2>&1 || fail "cannot start caddy"
  as_root systemctl reload caddy >/dev/null 2>&1 || as_root systemctl restart caddy >/dev/null 2>&1 || fail "cannot reload caddy"
  ok "Caddy active"
}

trust_local_ca() {
  local tls_mode
  tls_mode="$("$NODE_BIN" -e 'const {loadEnv}=require("./lib/env");console.log(loadEnv({root:process.cwd()}).derived.tlsMode)' 2>/dev/null || echo internal)"
  [ "$tls_mode" = "internal" ] || { ok "TLS mode=$tls_mode (no local CA needed)"; return 0; }
  # If the running Caddy chain already verifies against the system store there
  # is nothing to copy — and no reason to ask for sudo on a re-install.
  if have openssl && have curl; then
    local https_port host
    https_port="$("$NODE_BIN" -e 'const {loadEnv}=require("./lib/env");console.log(loadEnv({root:process.cwd()}).ports.caddy_https)' 2>/dev/null || echo 443)"
    host="$("$NODE_BIN" -e 'const {loadEnv}=require("./lib/env");console.log(loadEnv({root:process.cwd()}).derived.mainHost)' 2>/dev/null || echo localhost)"
    if echo | openssl s_client -connect "127.0.0.1:$https_port" -servername "$host" -verify_return_error >/dev/null 2>&1; then
      ok "Caddy local root CA already trusted"
      return 0
    fi
  fi
  local root_crt=""
  if as_root test -f /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt; then
    root_crt="/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt"
  elif [ -f "$HOME/.local/share/caddy/pki/authorities/local/root.crt" ]; then
    root_crt="$HOME/.local/share/caddy/pki/authorities/local/root.crt"
  fi
  if [ -z "$root_crt" ]; then
    warn "Caddy local root CA not found; HTTPS verification will fail until it is trusted"
    return 0
  fi
  local ca_dir="${CA_TRUST_DIR:-/usr/local/share/ca-certificates}"
  local target="$ca_dir/caddy-local-root.crt"
  if as_root test -f "$target" && [ "$(as_root sha256sum "$target" | awk '{print $1}')" = "$(as_root sha256sum "$root_crt" | awk '{print $1}')" ]; then
    ok "Caddy local root CA already trusted"
    return 0
  fi
  as_root install -m 644 "$root_crt" "$target" || { warn "could not copy Caddy CA"; return 0; }
  as_root update-ca-certificates >/dev/null 2>&1 || { warn "update-ca-certificates failed"; return 0; }
  ok "Caddy local root CA trusted"
}

render_tools_manifest() {
  [ -s deploy/tools.json ] || fail "deploy/tools.json missing"
  "$NODE_BIN" -e 'const j=require("./deploy/tools.json");if(!Array.isArray(j.tools)||j.tools.length===0)process.exit(1)' \
    || fail "deploy/tools.json is empty"
  ok "tools manifest present"
}

build() {
  step "Building dist/"
  "$NODE_BIN" --check api.js || fail "api.js syntax check failed"
  mkdir -p "$ROOT/.verify/install"
  "$NODE_BIN" scripts/build.js >"$ROOT/.verify/install/build.log" 2>&1 \
    || { tail -20 "$ROOT/.verify/install/build.log" >&2; fail "build failed"; }
  [ -s dist/manifest.json ] || fail "dist/manifest.json missing"
  ok "build complete"
}

start_stack() {
  if [ "$SKIP_START" = 1 ]; then warn "--no-start: stack not started"; return 0; fi
  step "Starting the gateway"
  if have systemctl; then
    bash scripts/install-service.sh --start || fail "systemd user start failed"
  else
    mkdir -p logs
    # Same launcher as the systemd unit: dist/ runtime, project Node.js.
    nohup bash scripts/zombiecoder-gateway.sh >>logs/install-start.log 2>&1 &
    ok "started in background (pid $!)"
  fi
  local health=""
  for _ in $(seq 1 60); do
    health="$(curl -fsS --max-time 1 http://127.0.0.1:"$("$NODE_BIN" -e 'const{loadEnv}=require("./lib/env");console.log(loadEnv({root:process.cwd()}).ports.api)' 2>/dev/null || echo 5050)"/health 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 1
  done
  [ -n "$health" ] || fail "gateway did not answer /health"
  ok "gateway healthy"
}

preflight() {
  step "Preflight -- project files are not modified"
  find_node_24 || { warn "Node 24+ not found (full install can download it)"; }
  [ -f .env.example ] || fail ".env.example missing"
  [ -f "external mcp/servers.example.json" ] || fail "external mcp/servers.example.json missing"
  [ -f scripts/env-ensure.js ] || fail "scripts/env-ensure.js missing"
  [ -f scripts/build.js ] || fail "scripts/build.js missing"
  [ -f scripts/install-verify.sh ] || fail "scripts/install-verify.sh missing"
  [ -x scripts/install-verify.sh ] || warn "install-verify.sh has no exec bit; 'bash scripts/install-verify.sh' still works"
  bash -n scripts/install.sh || fail "install.sh syntax"
  bash -n scripts/install-service.sh || fail "install-service.sh syntax"
  "$NODE_BIN" --check scripts/env-ensure.js || fail "env-ensure.js syntax"
  render_tools_manifest
  if have caddy && [ -f .env ]; then
    local check_config="$ROOT/.verify/install/Caddyfile.check.$$"
    mkdir -p "$ROOT/.verify/install"
    "$NODE_BIN" scripts/caddy-render.js --out "$check_config" >/dev/null \
      && caddy validate --config "$check_config" --adapter caddyfile >/dev/null 2>&1 \
      || { rm -f "$check_config"; fail "Caddyfile does not validate"; }
    rm -f "$check_config"
    ok "Caddyfile validates"
  fi
  echo "INSTALL_CHECK_OK installer=ok"
}

# ── main ────────────────────────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  find_node_24 >/dev/null || true
  preflight
  exit 0
fi

step "Mission Barisal installer"
echo "root=$ROOT"

if ! find_node_24; then
  step "Installing Node.js 24 (official tarball, checksum verified)"
  install_node
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
ok "Node $("$NODE_BIN" -v) at $NODE_BIN"

install_kde
ensure_env
ensure_servers_config
ollama_alias
install_caddy
configure_caddy
trust_local_ca
render_tools_manifest
build
start_stack

step "Live verification"
if [ "$SKIP_START" = 1 ]; then
  warn "--no-start: live verification skipped; run 'bash scripts/install-verify.sh --quick' after the gateway is up"
else
  bash scripts/install-verify.sh --quick || fail "live verification failed"
fi
