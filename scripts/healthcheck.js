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
 *   2. main MCP server        MAIN_SERVER_MCP (default http://127.0.0.1:5050/mcp)
 *   3. every local server in "external mcp/servers.json"    (port + tools/list)
 *   4. adapter over HTTPS      with certificate verification ON
 *   5. unified log file writable (logs/zc.jsonl)
 *
 * WHAT --fix DOES (least invasive first)
 *   • unit failed / inactive      → systemctl --user reset-failed + start
 *   • unit active but main server dead → systemctl --user restart <unit>
 *   • a servers.json entry is dead    → spawn it detached, log → logs/
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
const net = require("net");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");

const ROOT = process.env.ZC_ROOT || path.resolve(__dirname, "..");
const zclog = require(path.join(ROOT, "lib", "zc-log.js"));
// Load .env before any module-level env read below: without this the
// standalone healthcheck ignored .env entirely (only shell-exported vars
// counted) and servers.json ${VAR} ports would expand empty.
const { expandEnv, ensureEnv } = require(path.join(ROOT, "lib", "expand-env.js"));
ensureEnv();

const FIX = process.argv.includes("--fix");
const UNIT = process.env.ZC_UNIT || "zombiecoder-gateway.service";
const MAIN_URL = process.env.MAIN_SERVER_MCP || "http://127.0.0.1:5050/mcp";
const CERT = process.env.UNIVERSAL_ADAPTER_CA ||
  path.join(os.homedir(), ".zombiecoder", "certs", "adapter-cert.pem");
const SERVERS_JSON = path.join(ROOT, "external mcp", "servers.json");
const READY_WAIT_MS = Number(process.env.HC_READY_WAIT_MS || 15000);

const results = []; // { name, ok, detail, fixed? }

function record(name, ok, detail, fixed) {
  results.push({ name, ok, detail, fixed });
}

/** TCP probe: resolves true if something accepts on host:port. */
function tcpUp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(v);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
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
      .map((s) => {
        let port = 0;
        let mcpPath = "/";
        try {
          const u = new URL(expandEnv(s.url));
          port = Number(u.port) || 0;
          const p = u.pathname.replace(/\/+$/, "");
          if (p) mcpPath = p;
        } catch (_) { /* bad url → port 0 → reported below */ }
        return {
          name: String(s.name),
          script: path.resolve(ROOT, s.script),
          port,
          mcpPath,
          portEnv:
            ({ ocr: "OCR_MCP_PORT", "screen-recorder": "SCREEN_MCP_PORT", tts: "TTS_MCP_PORT", "universal-adapter": "ADAPTER_HTTP_PORT" })[s.name] ||
            String(s.name).toUpperCase().replace(/-/g, "_") + "_MCP_PORT",
        };
      });
  } catch (e) {
    record("servers.json", false, "unreadable: " + e.message);
    return [];
  }
}

/** Detached respawn of a dead local server (never duplicates a live one). */
function spawnDetached(entry) {
  if (!fs.existsSync(entry.script)) return false;
  fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });
  const logPath = path.join(ROOT, "logs", "local-mcp-" + entry.name + ".log");
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [entry.script], {
    cwd: ROOT,
    env: { ...process.env, [entry.portEnv]: String(entry.port) },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return true;
}

async function waitForPort(port, deadlineMs) {
  while (Date.now() < deadlineMs) {
    if (await tcpUp("127.0.0.1", port, 400)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
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

  // ── 3. every local server from servers.json ────────────────────────────
  const entries = loadEntries();
  const dead = [];
  for (const e of entries) {
    if (!e.port) {
      record(e.name, false, "bad url (no port) in servers.json");
      continue;
    }
    const up = await tcpUp("127.0.0.1", e.port, 800);
    if (up) {
      const reply = await rpc(`http://127.0.0.1:${e.port}${e.mcpPath}`, {
        jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
      });
      const n = toolsCount(reply);
      record(e.name, n > 0, `127.0.0.1:${e.port}${e.mcpPath} → ${n} tools`);
    } else {
      dead.push(e);
      record(e.name, false, `127.0.0.1:${e.port} not listening`);
    }
  }

  if (FIX && dead.length) {
    for (const e of dead) {
      console.log(`  repairing: spawning ${e.name} (detached) …`);
      if (!spawnDetached(e)) {
        record(e.name, false, "script missing: " + e.script, true);
        continue;
      }
      const ok = await waitForPort(e.port, Date.now() + READY_WAIT_MS);
      // tools/list may take a moment longer than the TCP accept
      let n = 0;
      if (ok) {
        await new Promise((r) => setTimeout(r, 500));
        n = toolsCount(await rpc(`http://127.0.0.1:${e.port}${e.mcpPath}`, {
          jsonrpc: "2.0", id: 1, method: "tools/list", params: {},
        }));
      }
      record(e.name, ok && n > 0, `respawned → ${ok ? n + " tools" : "never bound"}`, true);
    }
  }

  // ── 4. adapter over HTTPS with verification ON ─────────────────────────
  const httpsUrl = process.env.ADAPTER_HTTPS_URL || "https://localhost:5443/mcp";
  if (!fs.existsSync(CERT)) {
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
