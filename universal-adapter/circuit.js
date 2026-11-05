"use strict";
/**
 * circuit.js — circuit breaker for upstream (main server) calls
 * ═══════════════════════════════════════════════════════════════════════
 * WHY: main-sync polls http://127.0.0.1:5050/mcp. When the main server is
 * down (crash, port fight, reboot window), naive retry loops hammer a dead
 * endpoint and every tools/list stalls for CALL_TIMEOUT_MS.
 *
 * STATES
 *   closed    → normal, calls pass through.
 *   open      → after CONSECUTIVE_FAILURES consecutive failures. Calls are
 *               short-circuited with a structured error (no network wait).
 *               A troubleshooting hint is logged ONCE per open period.
 *   half-open → after COOLDOWN_MS the next call is allowed through as a
 *               probe. Success → closed. Failure → open again (timer resets).
 *
 * CONFIG (env — never hardcoded, so a fresh install can tune it)
 *   CB_FAILURES   failures before opening      (default 3)
 *   CB_COOLDOWN_MS time open before a probe    (default 15000)
 *
 * OBSERVABILITY
 *   Every state transition is written to logs/zc.jsonl via lib/zc-log
 *   (subsystem "circuit", events CB_OPEN / CB_CLOSE / CB_HALF_OPEN), with
 *   the last error attached — so a support person can see exactly why the
 *   adapter fell back to its own tools.
 */

const zclog = require("../lib/zc-log");

const FAILURE_LIMIT = Number(process.env.CB_FAILURES || 3);
const COOLDOWN_MS = Number(process.env.CB_COOLDOWN_MS || 15000);

/** Structured error callers receive while the breaker is open. */
class CircuitOpenError extends Error {
  constructor(name, lastError) {
    super(
      `circuit "${name}" is open — upstream failing; ` +
        `not retrying for ${COOLDOWN_MS}ms. ` +
        `last: ${lastError || "n/a"}. ` +
        `Troubleshoot: curl -s -X POST http://127.0.0.1:5050/mcp …tools/list`,
    );
    this.name = "CircuitOpenError";
    this.code = "CIRCUIT_OPEN";
    this.circuit = name;
    this.retryAfterMs = COOLDOWN_MS;
  }
}

/**
 * @param {string} name   circuit id (appears in logs)
 * @param {(stats: object) => void} [onOpen] called ONCE each time the circuit
 *        trips — the place to run troubleshooting / self-heal. Errors inside
 *        it are logged and swallowed (a broken healer must not break opening).
 * @returns {{
 *   state: () => string,
 *   allow: () => boolean,           // may I attempt a call?
 *   onSuccess: () => void,
 *   onFailure: (err: Error|string) => void,
 *   errorIfOpen: (err) => Error|null, // structured error when open
 *   reset: () => void,
 *   stats: () => object,
 * }}
 */
function createCircuit(name, onOpen) {
  let state = "closed";
  let consecutive = 0;
  let openedAt = 0;
  let lastError = null;
  let openedCount = 0;

  const stats = () => ({
    circuit: name,
    state,
    consecutive_failures: consecutive,
    opened_count: openedCount,
    last_error: lastError,
    opened_at: openedAt ? new Date(openedAt).toISOString() : null,
    cooldown_ms: COOLDOWN_MS,
    failure_limit: FAILURE_LIMIT,
  });

  function open(err) {
    state = "open";
    openedAt = Date.now();
    openedCount++;
    lastError = err ? String(err.message || err) : lastError;
    zclog.fail("circuit", "CB_OPEN", {
      ...stats(),
      hint: "upstream unavailable — adapter now serves LOCAL tools only and will probe after cooldown",
    });
    if (typeof onOpen === "function") {
      try {
        onOpen(stats());
      } catch (e) {
        zclog.fail("circuit", "CB_ONOPEN_FAIL", { error: e.message || String(e) });
      }
    }
  }

  return {
    state: () => state,

    allow() {
      if (state === "closed") return true;
      if (state === "half-open") return true;
      // open → is cooldown over? then promote to half-open for one probe.
      if (Date.now() - openedAt >= COOLDOWN_MS) {
        state = "half-open";
        zclog.warn("circuit", "CB_HALF_OPEN", { ...stats(), hint: "cooldown elapsed — allowing probe" });
        return true;
      }
      return false;
    },

    onSuccess() {
      const was = state;
      state = "closed";
      consecutive = 0;
      lastError = null;
      if (was !== "closed") {
        zclog.info("circuit", "CB_CLOSE", { ...stats(), hint: "upstream healthy again" });
      }
    },

    onFailure(err) {
      lastError = err ? String(err.message || err) : "unknown";
      consecutive++;
      if (state === "half-open") {
        // probe failed → straight back to open, fresh cooldown.
        open(lastError);
      } else if (consecutive >= FAILURE_LIMIT) {
        open(lastError);
      } else {
        zclog.warn("circuit", "CB_FAILURE", {
          ...stats(),
          hint: `${FAILURE_LIMIT - consecutive} more failure(s) before the circuit opens`,
        });
      }
    },

    /** If the circuit is open, return a ready-to-send structured error. */
    errorIfOpen() {
      if (this.allow()) return null;
      return new CircuitOpenError(name, lastError);
    },

    reset() {
      state = "closed";
      consecutive = 0;
      lastError = null;
    },

    stats,
  };
}

module.exports = { createCircuit, CircuitOpenError, FAILURE_LIMIT, COOLDOWN_MS };
