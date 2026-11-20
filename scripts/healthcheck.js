#!/usr/bin/env node
/**
 * healthcheck.js — one command that answers "is the whole stack alive?"
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   node scripts/healthcheck.js          check everything, print a table
 *   node scripts/healthcheck.js --fix    check, then repair what is broken
 *
 * WHAT IS CHECKED
 *   1. systemd user unit (supervisor for the whole stack)   [if available]
 *   2. main MCP server        MAIN_SERVER_MCP (default http://localhost:5050/mcp)
 *   3. every local server in "external mcp/servers.json"    (stdio status + tools)
 *   4. optional standalone adapter over HTTPS (only when ADAPTER_HTTPS_URL is set)
 *   5. unified log file writable (logs/zc.jsonl)
 *
 * WHAT --fix DOES (least invasive first)
 *   • unit failed / inactive      → systemctl --user reset-failed + start
 *   • unit active but main server dead → systemctl --user restart <unit>
 *   • a stdio server is missing   → restart the unit so api.js respawns it
 *   Then it RE-CHECKS and reports. Every repair is logged to zc.jsonl.
 *
 * PORTABILITY — no hardcoded machine paths:
 *   • ROOT/LOG_DIR come from lib/zc-log (or ZC_ROOT / ZC_LOG_DIR env)
 *   • unit name        ZC_UNIT         (default zombiecoder-gateway.service)
 *   • main server URL  MAIN_SERVER_MCP
 *   • adapter cert     UNIVERSAL_ADAPTER_CA  (~/.zombiecoder/certs/adapter-cert.pem)
 *   • node binary is process.execPath — works with any nvm/system node
 * So a fresh OS install with the repo in a different folder still runs this
 * file as-is; only .env / env vars need to match the machine.
 *
 * Exit code: 0 = all green (after optional fix), 1 = something still broken.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = process.env.ZC_ROOT || path.resolve(__dirname, "..");
const zclog = require(path.join(ROOT, "lib", "zc-log.js"));
// Load .env before any module-level env read below: without this the
// standalone healthcheck ignored .env entirely (only shell-exported vars
// counted) and servers.json ${VAR} ports would expand empty.
const { ensureEnv } = require(path.join(ROOT, "lib", "expand-env.js"));
ensureEnv();

const FIX = process.argv.includes("--fix");
const UNIT = process.env.ZC_UNIT || "zombiecoder-gateway.service";
const MAIN_URL = process.env.MAIN_SERVER_MCP || "http://localhost:5050/mcp";
const CERT = process.env.UNIVERSAL_ADAPTER_CA ||
  path.join(os.homedir(), ".zombiecoder", "certs", "adapter-cert.pem");
const SERVERS_JSON = path.join(ROOT, "external mcp", "servers.json");

const results = []; // { name, ok, detail, fixed? }

function record(name, ok, detail, fixed) {
  results.push({ name, ok, detail, fixed });
}

/** GET a JSON endpoint; returns null on any failure. */
async function httpGetJson(url, timeout = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** POST a JSON-RPC body; returns parsed JSON or null. */
async function rpc(url, body, { ca, timeout = 5000 } = {}) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      // Node's fetch has no `ca` option — for the HTTPS check we drop to
      // https.request where verification can stay ON with our own cert.
      ...(ca ? {} : {}),
    });
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** Same, but over https with an explicit CA (verification ON, never off). */
function rpcHttps(urlObj, body, ca, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      const https = require("node:https");
      const payload = JSON.stringify(body);
      const req = https.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search,
          method: "POST",
          ca: [ca],
          rejectUnauthorized: true,
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          timeout,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (_) {
              resolve(null);
            }
          });
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.write(payload);
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

function toolsCount(reply) {
  return reply && reply.result && Array.isArray(reply.result.tools)
    ? reply.result.tools.length
    : 0;
}

/** systemctl --user, or null when no user bus exists (containers, fresh OS). */
function systemctl(args) {
  const r = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 8000 });
  if (r.error) return null; // command not found / no bus
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function loadEntries() {
  try {
    const raw = JSON.parse(fs.readFileSync(SERVERS_JSON, "utf8"));
    return (Array.isArray(raw.servers) ? raw.servers : [])
      .filter((s) => s && s.local === true && s.enabled !== false && s.script)
      .map((s) => ({
        name: String(s.name),
        transport: String(s.transport || (s.url ? "http" : "stdio")).toLowerCase(),
        script: path.resolve(ROOT, s.script),
      }));
  } catch (e) {
    record("servers.json", false, "unreadable: " + e.message);
    return [];
  }
}

/** Read the gateway's live external-MCP report (stdio and HTTP). */
async function externalMcpStatus() {
  const base = MAIN_URL.replace(/\/mcp\/?$/, "");
  const data = await httpGetJson(base + "/api/mcp-external");
  return (data && Array.isArray(data.servers)) ? data.servers : null;
}

async function main() {
  console.log(`\n══ ZC HEALTHCHECK ${FIX ? "(with --fix)" : ""} ══  root=${ROOT}\n`);
  zclog.info("healthcheck", "RUN", { fix: FIX, root: ROOT });

  // ── 1. supervisor ──────────────────────────────────────────────────────
  const unitState = systemctl(["is-active", UNIT]);
  if (unitState === null) {
    record("systemd unit", true, "systemctl/user-bus unavailable — skipped (not an error)");
  } else if (unitState.out === "active") {
    record("systemd unit", true, UNIT + " = active");
  } else if (FIX) {
    console.log(`  repairing: reset-failed + start ${UNIT} …`);
    systemctl(["reset-failed", UNIT]);
    systemctl(["start", UNIT]);
    await new Promise((r) => setTimeout(r, 4000));
    const after = systemctl(["is-active", UNIT]);
    record("systemd unit", after && after.out === "active",
      `${UNIT} was '${unitState.out}' → start → '${after ? after.out : "?"}'`, true);
  } else {
    record("systemd unit", false, `${UNIT} = ${unitState.out || unitState.err}`);
  }

  // ── 2. main MCP server ─────────────────────────────────────────────────
  const mainObj = new URL(MAIN_URL);
  let mainOk = toolsCount(await rpc(MAIN_URL, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) > 0;
  if (!mainOk && FIX) {
    // The unit supervises the main server. Two escalation steps:
    //   a) unit inactive → start;  b) unit active but port dead → restart.
    if (unitState && unitState.out !== "active") {
      systemctl(["reset-failed", UNIT]);
      systemctl(["start", UNIT]);
    } else {
      console.log(`  repairing: systemctl --user restart ${UNIT} …`);
      systemctl(["restart", UNIT]);
    }
    await new Promise((r) => setTimeout(r, 6000));
    mainOk = toolsCount(await rpc(MAIN_URL, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) > 0;
    record("main server", mainOk, MAIN_URL + " → after repair: " + (mainOk ? "up" : "still down"), true);
  } else {
    record("main server", mainOk, MAIN_URL + (mainOk ? " → up" : " → UNREACHABLE"));
  }

  // ── 3. every local server from servers.json (stdio children) ───────────
  const entries = loadEntries();
  const external = await externalMcpStatus();
  if (!external) {
    record("external mcp report", false, "GET /api/mcp-external failed");
  }
  const byName = new Map((external || []).map((s) => [s.name, s]));
  const dead = [];
  for (const e of entries) {
    const row = byName.get(e.name);
    if (!row) {
      dead.push(e);
      record(e.name, false, "not reported by /api/mcp-external");
      continue;
    }
    const ok = row.status === "connected" && Number(row.tools) > 0;
    record(
      e.name,
      ok,
      `${row.transport || e.transport} → ${row.tools || 0} tools` +
        (ok ? "" : " (" + (row.error || row.status) + ")"),
    );
    if (!ok) dead.push(e);
  }

  if (FIX && dead.length && unitState && unitState.out === "active") {
    console.log(`  repairing: systemctl --user restart ${UNIT} (respawns stdio children) …`);
    systemctl(["restart", UNIT]);
    await new Promise((r) => setTimeout(r, 6000));
    const after = await externalMcpStatus();
    const afterByName = new Map((after || []).map((s) => [s.name, s]));
    for (const e of dead) {
      const row = afterByName.get(e.name);
      const ok = row && row.status === "connected" && Number(row.tools) > 0;
      record(e.name + " (after restart)", !!ok, ok ? `${row.tools} tools` : "still missing", true);
    }
  }

  // ── 4. optional standalone adapter over HTTPS ──────────────────────────
  const httpsUrl = process.env.ADAPTER_HTTPS_URL || "";
  if (!httpsUrl) {
    record("adapter https", true, "not configured (gateway uses stdio) — skipped");
  } else if (!fs.existsSync(CERT)) {
    record("adapter https", true, "cert not found (" + CERT + ") — skipped; generate with: node universal-adapter/tls.js");
  } else {
    const u = new URL(httpsUrl);
    const reply = await rpcHttps(u, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, fs.readFileSync(CERT, "utf8"));
    const n = toolsCount(reply);
    record("adapter https", n > 0, `${httpsUrl} (verify ON, own cert) → ${n} tools`);
  }

  // ── 5. unified log writable ────────────────────────────────────────────
  try {
    fs.mkdirSync(zclog.dir, { recursive: true });
    fs.appendFileSync(zclog.file, "");
    record("unified log", true, zclog.file);
  } catch (e) {
    record("unified log", false, zclog.file + " → " + e.message);
  }

  // ── report ─────────────────────────────────────────────────────────────
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? "  PASS  " : "  FAIL  ";
    if (!r.ok) failed++;
    console.log(`${mark}${r.name.padEnd(18)} ${r.detail}${r.fixed ? "  [repaired]" : ""}`);
  }
  console.log(`\n  HEALTHCHECK: ${results.length - failed}/${results.length} passed${failed ? "  ← run with --fix" : ""}\n`);

  zclog[failed ? "fail" : "info"]("healthcheck", "RESULT", {
    passed: results.length - failed,
    total: results.length,
    fix: FIX,
    failed_names: failed ? results.filter((r) => !r.ok).map((r) => r.name) : undefined,
  });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  zclog.fail("healthcheck", "CRASH", { error: e.message || String(e) });
  console.error("healthcheck crashed:", e);
  process.exit(1);
});
