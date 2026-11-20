#!/usr/bin/env bash
# =============================================================================
# scripts/rebuild-restart.sh — one safe rebuild + restart + proof (runbook N5)
# =============================================================================
# Why:
#   A code change is not live until dist/ is rebuilt and the unit is restarted.
#   `systemctl start` on an already-active unit is a silent no-op, and a failed
#   build can leave a half-written dist. This script makes the whole sequence
#   one command and refuses to claim success without a real health + R2T proof.
#
# Modes:
#   --check     build to a temp dir, verify manifest/source sha, no service touch
#   --restart   stop -> snapshot dist -> build -> verify -> start -> health -> R2T
#               (default when no mode is given)
#
# Success marker: REBUILD_RESTART_OK (restart) / REBUILD_CHECK_OK (check).
# On a post-stop failure the previous dist is restored and booted; the script
# still exits non-zero so a caller cannot mistake a rollback for a success.
# =============================================================================
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="${ZC_UNIT:-zombiecoder-gateway}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
HEALTH_URL="${ZC_HEALTH_URL:-http://127.0.0.1:5050/health}"
R2T_URL="${ZC_R2T_URL:-http://127.0.0.1:5050/v1/chat/completions}"
DIST="$APP_DIR/dist"
PREV="$APP_DIR/dist.prev"
CHECK_DIR=""
SKIP_ENV_SET=0

log() { printf '[%s] %s\n' "$(date -Is)" "$*"; }
fail() { log "REBUILD_RESTART_FAILED step=$1 ${2:-}"; exit 1; }

cleanup() {
  if [ "$SKIP_ENV_SET" = "1" ]; then
    systemctl --user unset-environment ZC_SKIP_BUILD >/dev/null 2>&1 || true
  fi
  if [ -n "$CHECK_DIR" ] && [ -d "$CHECK_DIR" ]; then
    rm -rf "$CHECK_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

preflight() {
  [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail preflight "node not found"
  "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)' \
    || fail preflight "node 24+ required"
  local f
  for f in api.js start.js scripts/build.js lib/env.js lib/size-budget.js \
           provider/transport.js provider/openai.js provider/index.js \
           local-llm-bridge.js; do
    [ -f "$APP_DIR/$f" ] || fail preflight "missing $f"
    "$NODE_BIN" --check "$APP_DIR/$f" >/dev/null 2>&1 \
      || fail preflight "syntax $f"
  done
  log "PRECHECK_OK node=$("$NODE_BIN" -v)"
}

sha() {
  "$NODE_BIN" -e '
    const c=require("crypto"),f=require("fs");
    process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"));
  ' "$1"
}

manifest_check() {
  local dist="$1"
  [ -f "$dist/manifest.json" ] || fail manifest "missing manifest"
  "$NODE_BIN" -e '
    const fs=require("fs"),crypto=require("crypto"),path=require("path");
    const [dist,src]=process.argv.slice(1);
    const m=JSON.parse(fs.readFileSync(path.join(dist,"manifest.json"),"utf8"));
    const files=Array.isArray(m.files)?m.files:[];
    const bad=[];
    const h=(p)=>crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    for (const f of files) {
      const rel=String(f.path||"");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { bad.push(rel||"<empty>"); continue; }
      const s=path.join(src,rel), d=path.join(dist,rel);
      if (!fs.existsSync(s) || !fs.existsSync(d)) continue; // generated files
      if (h(s)!==h(d) || h(d)!==f.sha256) bad.push(rel);
    }
    if (bad.length) { console.error("MANIFEST_MISMATCH "+bad.slice(0,5).join(",")); process.exit(1); }
    const api=files.find(f=>f.path==="api.js");
    console.log("MANIFEST_OK files="+files.length+" api_sha="+(api?api.sha256:"none"));
  ' "$dist" "$APP_DIR" || fail manifest "source/dist mismatch"
}

check_mode() {
  preflight
  CHECK_DIR="$(mktemp -d /tmp/opencode/zc-rebuild-check-XXXXXX)"
  log "CHECK build=$CHECK_DIR"
  ( cd "$APP_DIR" && ZC_DIST_DIR="$CHECK_DIR" "$NODE_BIN" start.js --build-only ) \
    || fail check "build failed"
  manifest_check "$CHECK_DIR"
  local src_sha dist_sha
  src_sha="$(sha "$APP_DIR/api.js")"
  dist_sha="$(sha "$CHECK_DIR/api.js")"
  [ "$src_sha" = "$dist_sha" ] || fail check "api sha mismatch"
  log "REBUILD_CHECK_OK api_sha=$src_sha dist=$CHECK_DIR"
  exit 0
}

health_ok() {
  "$NODE_BIN" -e '
    const http=require("http");
    const url=new URL(process.argv[1]);
    const req=http.get({hostname:url.hostname,port:url.port,path:url.pathname,timeout:2000},res=>{
      let b="";res.on("data",c=>b+=c);res.on("end",()=>{
        let j=null;try{j=JSON.parse(b)}catch(e){}
        process.exit(res.statusCode===200&&j&&j.healthy===true?0:1);
      });
    });
    req.on("timeout",()=>req.destroy());
    req.on("error",()=>process.exit(1));
  ' "$HEALTH_URL"
}

wait_health() {
  local deadline=$((SECONDS+60))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_ok; then return 0; fi
    sleep 1
  done
  return 1
}

r2t_header_ok() {
  "$NODE_BIN" -e '
    const http=require("http");
    const url=new URL(process.argv[1]);
    const body=JSON.stringify({model:"r2t",messages:[{role:"user",content:"[[TOOL:info]][[/TOOL]]"}],stream:false});
    const req=http.request({hostname:url.hostname,port:url.port,path:url.pathname,method:"POST",timeout:15000,
      headers:{"content-type":"application/json","content-length":Buffer.byteLength(body)}},res=>{
      res.resume();res.on("end",()=>{
        const engine=String(res.headers["x-zc-r2t-engine"]||"");
        if (res.statusCode===200 && engine) { console.log("R2T_ENGINE="+engine); process.exit(0); }
        process.exit(1);
      });
    });
    req.on("timeout",()=>req.destroy());
    req.on("error",()=>process.exit(1));
    req.write(body);req.end();
  ' "$R2T_URL"
}

restore_prev() {
  log "ROLLBACK restoring dist.prev"
  systemctl --user stop "$UNIT" >/dev/null 2>&1 || true
  if [ -d "$PREV" ]; then
    rm -rf "$DIST"
    mv "$PREV" "$DIST"
  fi
  systemctl --user set-environment ZC_SKIP_BUILD=1 >/dev/null 2>&1 || true
  SKIP_ENV_SET=1
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user start "$UNIT" >/dev/null 2>&1 || true
  if wait_health; then
    log "ROLLBACK_HEALTH_OK"
  else
    log "ROLLBACK_HEALTH_FAILED"
  fi
}

main_mode() {
  preflight
  local was_active
  was_active="$(systemctl --user is-active "$UNIT" 2>/dev/null || true)"
  log "unit=$UNIT active=$was_active"

  if [ "$was_active" = "active" ]; then
    systemctl --user stop "$UNIT" || fail stop "systemctl stop failed"
    local deadline=$((SECONDS+15))
    while [ "$SECONDS" -lt "$deadline" ]; do
      [ "$(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null)" = "inactive" ] && break
      sleep 0.5
    done
    [ "$(systemctl --user show "$UNIT" -p ActiveState --value 2>/dev/null)" = "inactive" ] \
      || fail stop "still active after stop"
    log "STOPPED"
  fi

  rm -rf "$PREV"
  if [ -d "$DIST" ]; then
    mv "$DIST" "$PREV"
    log "SNAPSHOT dist.prev"
  fi

  if ! ( cd "$APP_DIR" && "$NODE_BIN" start.js --build-only ); then
    restore_prev
    fail build "build failed"
  fi
  manifest_check "$DIST"

  systemctl --user set-environment ZC_SKIP_BUILD=1 || { restore_prev; fail start "set-environment failed"; }
  SKIP_ENV_SET=1
  systemctl --user reset-failed "$UNIT" >/dev/null 2>&1 || true
  systemctl --user start "$UNIT" || { restore_prev; fail start "systemctl start failed"; }

  if ! wait_health; then
    restore_prev
    fail health "health timeout"
  fi

  local src_sha dist_sha
  src_sha="$(sha "$APP_DIR/api.js")"
  dist_sha="$(sha "$DIST/api.js")"
  if [ "$src_sha" != "$dist_sha" ]; then
    restore_prev
    fail hash "api sha mismatch"
  fi

  local r2t
  if ! r2t="$(r2t_header_ok)"; then
    restore_prev
    fail r2t "x-zc-r2t-engine missing"
  fi

  log "HEALTH_OK 200"
  log "$r2t"
  rm -rf "$PREV"
  log "REBUILD_RESTART_OK api_sha=$src_sha dist=$DIST unit=$UNIT"
}

case "${1:-}" in
  --check) check_mode ;;
  ""|--restart) main_mode ;;
  *) echo "usage: $0 [--check|--restart]" >&2; exit 2 ;;
esac
