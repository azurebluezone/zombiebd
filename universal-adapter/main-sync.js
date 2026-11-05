/**
 * main-sync.js — Pull the main server's MCP tools into the adapter
 * ═══════════════════════════════════════════════════════════════════════
 * The adapter does not own those tools. It advertises a cached copy of the
 * main server's `tools/list` and forwards every `tools/call` back to it, so
 * one process can serve three transports from a single upstream.
 *
 * Design notes
 * ────────────
 *   • PULL, never push: the main server (api.js) is untouched. If it is down
 *     the adapter keeps working with its own registry — no crash, no retry
 *     storm, no log spam on the production server.
 *   • Stale-while-error is deliberately NOT used. A tool that is advertised
 *     but unreachable is worse than a tool that is honestly absent, so a
 *     failed poll empties the remote list until the next successful poll.
 *   • `tools/list` in registry.js is synchronous per request, so the cache is
 *     warmed by a background timer; only the very first request waits.
 *
 * Zero dependencies — pure Node.js.
 */
"use strict";

// Requires FIRST: the UPSTREAM_TOKEN resolver below runs at module load and
// needs path/fs. Keep these three lines above it.
const zclog = require("../lib/zc-log");
const { createCircuit } = require("./circuit");
const path = require("path");
const fs = require("fs");

const MAIN_URL = process.env.MAIN_SERVER_MCP || "http://127.0.0.1:5050/mcp";

// ── Upstream credential ─────────────────────────────────────────────────────
// api.js guards `exec`, `env_get`, `db_*`, `write_file`, `set_working_dir`,
// `http_request`, ... behind mcpGate(): a privileged call needs
//   Authorization: Bearer <MCP_ADMIN_TOKEN|ADMIN_API_KEY>   (or x-api-key)
// The adapter used to send no credentials at all, so EVERY privileged tool
// proxied through it failed with -32001 Unauthorized even though the token
// existed in .env. Evidence:
//   curl -X POST http://127.0.0.1:5050/mcp -d '{... "exec" ...}'
//     -> Unauthorized: privileged tool 'exec' requires ...
// Priority mirrors api.js's own mcpAdminTokenOk(): MCP_ADMIN_TOKEN first,
// then ADMIN_API_KEY. NOTE: an EMPTY MCP_ADMIN_TOKEN= in .env is falsy, so
// the || correctly falls through to ADMIN_API_KEY — do not "fix" that.
const UPSTREAM_TOKEN = (() => {
  const fromEnv = () =>
    (process.env.MCP_ADMIN_TOKEN || "").trim() || (process.env.ADMIN_API_KEY || "").trim();
  const live = fromEnv();
  if (live) return live;

  // The adapter is spawned by start.js, which does not always export .env into
  // our environment. Read the file once so the token is found either way.
  const envFile = process.env.MCP_ADMIN_TOKEN_FILE || path.join(__dirname, "..", ".env");
  try {
    const txt = fs.readFileSync(envFile, "utf8");
    const pick = (k) => {
      // [ \t] and NOT \s: \s matches \n, so "MCP_ADMIN_TOKEN=" (empty value)
      // made \s* eat the newline and (.*) then captured the whole comment
      // block below it — a 89-char "token" built from prose.
      const m = txt.match(new RegExp("^[ \\t]*" + k + "[ \\t]*=[ \\t]*(.*)$", "m"));
      if (!m) return "";
      return m[1].trim().replace(/^["']|["']$/g, "").replace(/\r$/, "");
    };
    // Same precedence, and an empty value must stay empty — do not treat "" as
    // a match or we would send "Bearer " and mask the real failure.
    return pick("MCP_ADMIN_TOKEN") || pick("ADMIN_API_KEY") || "";
  } catch {
    return "";
  }
})();
const TTL_MS = Number(process.env.MAIN_SYNC_TTL_MS || 30000);
// start.js boots the adapter BEFORE api.js, so the first poll always loses
// the race. While upstream is down we retry on this shorter interval instead
// of waiting out the full TTL, otherwise the adapter would serve its own 9
// tools for up to 30s after the main server came up.
const RETRY_MS = Number(process.env.MAIN_SYNC_RETRY_MS || 5000);
const CALL_TIMEOUT_MS = Number(process.env.MAIN_SYNC_TIMEOUT_MS || 20000);

const netMod = require("net");
const { spawn } = require("child_process");

// ── Self-heal: runs once each time the circuit trips ─────────────────────
// The adapter cannot restart the main server itself (it is not its parent),
// so it does the two things it safely can:
//   1. TCP-probe the upstream port — distinguishes "dead" from "alive but
//      erroring" (a live port means the problem is application-level; a
//      restart would not help, so we only log).
//   2. If the port IS dead, spawn scripts/healthcheck.js --fix detached.
//      That script knows how to repair: systemd reset-failed/start/restart
//      and respawning dead local servers — then re-checks its own work.
// Everything is env-tunable and rate-limited so a persistent outage can
// never turn into a repair storm.
const HEALTHCHECK = path.join(__dirname, "..", "scripts", "healthcheck.js");
const SELFHEAL_ON = (process.env.ZC_CB_SELFHEAL || "1") !== "0";
const SELFHEAL_MIN_MS = Number(process.env.ZC_CB_HEAL_MS || 120000);
let lastSelfHeal = 0;

function probeUpstream() {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(MAIN_URL);
    } catch {
      return resolve(false);
    }
    const net = netMod;
    const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
    const sock = net.connect({ host: u.hostname, port });
    const done = (v) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

function selfHeal() {
  if (!SELFHEAL_ON) {
    zclog.warn("main-sync", "SELFHEAL_DISABLED", { hint: "set ZC_CB_SELFHEAL=1 to auto-repair" });
    return;
  }
  if (Date.now() - lastSelfHeal < SELFHEAL_MIN_MS) {
    zclog.debug("main-sync", "SELFHEAL_THROTTLED", { next_in_ms: SELFHEAL_MIN_MS - (Date.now() - lastSelfHeal) });
    return;
  }
  lastSelfHeal = Date.now();
  probeUpstream().then((live) => {
    if (live) {
      zclog.warn("main-sync", "SELFHEAL_SKIP", {
        url: MAIN_URL,
        hint: "port is OPEN but RPC failing — application-level fault, check logs/2026-*.log; restarting would not help",
      });
      return;
    }
    if (!fs.existsSync(HEALTHCHECK)) {
      zclog.warn("main-sync", "SELFHEAL_NO_TOOLS", { path: HEALTHCHECK, hint: "healthcheck script missing — fix manually: systemctl --user restart " + (process.env.ZC_UNIT || "zombiecoder-gateway.service") });
      return;
    }
    try {
      fs.mkdirSync(path.join(__dirname, "..", "logs"), { recursive: true });
      const out = fs.openSync(path.join(__dirname, "..", "logs", "healthcheck-fix.log"), "a");
      const child = spawn(process.execPath, [HEALTHCHECK, "--fix"], {
        cwd: path.join(__dirname, ".."),
        detached: true,
        stdio: ["ignore", out, out],
        env: process.env,
      });
      child.unref();
      zclog.warn("main-sync", "SELFHEAL_SPAWNED", {
        cmd: process.execPath + " " + HEALTHCHECK + " --fix",
        pid: child.pid,
        hint: "repair running detached — results in logs/zc.jsonl (subsystem=healthcheck) and logs/healthcheck-fix.log",
      });
    } catch (e) {
      zclog.fail("main-sync", "SELFHEAL_FAIL", { error: e.message || String(e) });
    }
  });
}

// Fails N times in a row → open (stop polling, serve local tools only),
// probe again after a cooldown. Keeps a dead upstream from turning every
// tools/list into a CALL_TIMEOUT_MS wait. onOpen → troubleshooting self-heal.
const circuit = createCircuit("main-sync", () => selfHeal());

const state = {
  /** MCP tool objects exactly as the main server advertised them. */
  tools: [],
  /** Names currently reachable upstream. */
  names: new Set(),
  /** Every name ever seen, so enable/disable keeps working across an outage. */
  seen: new Set(),
  /** Names the operator switched off through tools/disable. */
  disabled: new Set(),
  syncedAt: 0,
  reachable: false,
  error: null,
  calls: 0,
  errors: 0,
  inflight: null,
};

/**
 * Minimal JSON-RPC client. Only HTTP is expected in practice, but the main
 * server can also be reached over HTTPS (tunnel), so both are supported.
 */
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(MAIN_URL);
    } catch (e) {
      return reject(e);
    }
    const lib = u.protocol === "https:" ? require("node:https") : require("node:http");
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        // The tunnel uses a publicly trusted certificate; the loopback direct
        // link does not need TLS at all. Verification stays ON.
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
          // Gate for api.js privileged tools. Omitted when no token is
          // configured so the request stays identical to the old behaviour —
          // the 401 from upstream then remains the honest failure signal.
          ...(UPSTREAM_TOKEN ? { Authorization: `Bearer ${UPSTREAM_TOKEN}` } : {}),
        },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            return reject(new Error(`main server returned non-JSON (HTTP ${res.statusCode})`));
          }
          if (parsed && parsed.error) {
            // The server ANSWERED — this is an application-level error, not an
            // outage. Tagged so the circuit breaker counts only reachability
            // failures (ECONNREFUSED, timeout, non-JSON), not tool errors.
            const code = parsed.error.code;
            const msg = parsed.error.message ||
              (typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error).slice(0, 160));
            const e = new Error(code !== undefined ? `${code}: ${msg}` : `upstream error: ${msg}`);
            e.appLevel = true;
            return reject(e);
          }
          resolve(parsed ? parsed.result : undefined);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`main server timeout after ${CALL_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Re-fetch tools/list. Concurrent callers share one in-flight request.
 * A failure clears the remote list: we never advertise a tool we cannot call.
 *
 * Freshness window is reachability-aware — 30s while healthy (nothing to
 * gain from hammering), 5s while broken (so recovery is quick).
 */
function refresh(force = false) {
  if (state.inflight) return state.inflight;
  if (!force && state.syncedAt) {
    const window = state.reachable ? TTL_MS : RETRY_MS;
    if (Date.now() - state.syncedAt < window) return Promise.resolve(state);
  }

  // Circuit open → skip the network entirely this tick; the breaker's own
  // cooldown decides when the next probe happens (state stays "reachable=false"
  // so tools/list honestly reports the local registry only).
  if (!circuit.allow()) {
    zclog.debug("main-sync", "SYNC_SKIPPED", { reason: "circuit-open", url: MAIN_URL });
    return Promise.resolve(state);
  }

  const t0 = Date.now();
  state.inflight = rpc("tools/list")
    .then((result) => {
      const tools = Array.isArray(result && result.tools) ? result.tools : [];
      state.tools = tools;
      state.names = new Set(tools.map((t) => t.name));
      for (const n of state.names) state.seen.add(n);
      state.reachable = true;
      state.error = null;
      state.syncedAt = Date.now();
      circuit.onSuccess();
      zclog.info("main-sync", "SYNC_OK", {
        url: MAIN_URL,
        tools: tools.length,
        ms: Date.now() - t0,
      });
    })
    .catch((err) => {
      state.tools = [];
      state.names = new Set();
      state.reachable = false;
      state.error = err.message || String(err);
      state.syncedAt = Date.now();
      // App-level JSON-RPC error ⇒ the server answered ⇒ it is reachable.
      if (err.appLevel) circuit.onSuccess();
      else circuit.onFailure(err);
      zclog.fail("main-sync", "SYNC_FAIL", {
        url: MAIN_URL,
        ms: Date.now() - t0,
        error: state.error,
        circuit: circuit.state(),
      });
    })
    .finally(() => {
      state.inflight = null;
    });

  return state.inflight;
}

/**
 * Called on every tools/list. After the first poll it reads the cache, except
 * while upstream is down — then it retries, bounded by RETRY_MS so a hammering
 * client cannot turn into a denial of service against the main server.
 */
function ensureSynced() {
  if (state.syncedAt && (state.reachable || Date.now() - state.syncedAt < RETRY_MS)) {
    return Promise.resolve();
  }
  return refresh();
}

/** Enabled remote tools, upstream schemas passed through untouched. */
function list() {
  return state.tools.filter((t) => !state.disabled.has(t.name));
}

function has(name) {
  return state.names.has(name) && !state.disabled.has(name);
}

function knows(name) {
  return state.seen.has(name);
}

function setEnabled(name, enabled) {
  if (enabled) state.disabled.delete(name);
  else state.disabled.add(name);
}

function call(name, args) {
  state.calls++;
  // Circuit open → fail fast with a structured error instead of waiting
  // CALL_TIMEOUT_MS against an endpoint we already know is dead.
  const open = circuit.errorIfOpen();
  if (open) {
    state.errors++;
    zclog.warn("main-sync", "UPSTREAM_CALL_BLOCKED", {
      tool: name,
      circuit: circuit.state(),
      error: open.message,
    });
    return Promise.reject(open);
  }
  const t0 = Date.now();
  return rpc("tools/call", { name, arguments: args || {} }).then(
    (result) => {
      zclog.info("main-sync", "UPSTREAM_CALL_OK", { tool: name, ms: Date.now() - t0 });
      return result;
    },
    (err) => {
      state.errors++;
      // Only reachability failures feed the breaker; a JSON-RPC tool error
      // means the upstream answered fine.
      if (!err.appLevel) circuit.onFailure(err);
      zclog.fail("main-sync", "UPSTREAM_CALL_FAIL", {
        tool: name,
        ms: Date.now() - t0,
        error: err.message || String(err),
        circuit: circuit.state(),
      });
      throw err;
    },
  );
}

function status() {
  return {
    url: MAIN_URL,
    reachable: state.reachable,
    tools: state.tools.length,
    enabled: list().length,
    disabled: state.disabled.size,
    last_sync: state.syncedAt ? new Date(state.syncedAt).toISOString() : null,
    ttl_sec: Math.round(TTL_MS / 1000),
    calls: state.calls,
    errors: state.errors,
    error: state.error,
    circuit: circuit.stats(),
  };
}

function stats() {
  const out = {};
  for (const t of list()) out[t.name] = { enabled: true, remote: true };
  for (const n of state.disabled) out[n] = { enabled: false, remote: true };
  return out;
}

// Warm the cache as soon as the adapter loads, then keep it fresh.
refresh(true).catch(() => {});
// Ticks faster than TTL_MS on purpose: refresh() short-circuits while fresh,
// so a healthy upstream still gets polled every TTL_MS, but a broken one is
// retried every RETRY_MS instead of waiting out the full TTL.
const timer = setInterval(() => refresh().catch(() => {}), RETRY_MS);
// Never keep the process alive just for the poller.
if (typeof timer.unref === "function") timer.unref();

module.exports = {
  URL: MAIN_URL,
  ensureSynced,
  refresh,
  list,
  has,
  knows,
  setEnabled,
  call,
  status,
  stats,
  circuit,
};
