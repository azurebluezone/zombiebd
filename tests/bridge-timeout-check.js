#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: P0-07 / P1-01 — one provider timeout resolver
//
// What this proves (not a copy of the contract):
//   1. lib/provider-timeout.js is the only place that decides a deadline
//   2. provider/transport.js has no 60s/300s literal fallback
//   3. api.js bridge/ollama configs take timeout + streamTimeout from it
//   4. local-llm-bridge.js uses the same upstream value
//   5. the bridge gateway deadline is strictly larger than its upstream
//   6. resolver precedence, invalid env fallback, plain unit behavior
//   7. real HTTP: cfg wins, resolver env wins, request and stream both time out
//
// Run: node tests/bridge-timeout-check.js
// Exit 0 + BRIDGE_TIMEOUT_OK only when every assertion passes.
// =============================================================================

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const timeouts = require(path.join(ROOT, "lib", "provider-timeout.js"));
const transport = require(path.join(ROOT, "provider", "transport.js"));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log("PASS " + name + (detail ? " :: " + detail : ""));
  } else {
    fail += 1;
    failures.push(name + (detail ? " :: " + detail : ""));
    console.log("FAIL " + name + (detail ? " :: " + detail : ""));
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function startServer(delayMs, payload) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const timer = setTimeout(() => {
          try {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(payload);
          } catch (_) {
            // client already timed out and destroyed the socket
          }
        }, delayMs);
        res.on("close", () => clearTimeout(timer));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const url =
        "http://127.0.0.1:" + server.address().port + "/v1/chat/completions";
      resolve({
        url,
        close: () =>
          new Promise((done) => {
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

async function expectReject(label, run, messagePart) {
  try {
    await run();
    check(label, false, "resolved instead of timing out");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    check(label, message.indexOf(messagePart) !== -1, message);
  }
}

async function main() {
  // ─── 1. Static wiring ─────────────────────────────────────────────────
  const transportSrc = read("provider/transport.js");
  const apiSrc = read("api.js");
  const bridgeSrc = read("local-llm-bridge.js");

  check(
    "transport requires lib/provider-timeout",
    /require\(\s*["']\.\.\/lib\/provider-timeout["']\s*\)/.test(transportSrc),
  );
  check(
    "transport has no DEFAULT_TIMEOUT = 60000",
    !/DEFAULT_TIMEOUT/.test(transportSrc),
  );
  check(
    "transport has no bare 60s/300s fallback",
    !/\|\|\s*(?:60000|300000)\b/.test(transportSrc),
  );
  check(
    "transport resolves both deadlines at call time",
    /fallbackTimeouts\(\)\.timeout/.test(transportSrc) &&
      /fallbackTimeouts\(\)\.streamTimeout/.test(transportSrc),
  );

  check(
    "api.js requires the resolver",
    /require\(\s*["']\.\/lib\/provider-timeout\.js["']\s*\)/.test(apiSrc),
  );
  check(
    "api.js bridge config takes resolved timeouts",
    /\.\.\.resolveProviderTimeouts\(\s*["']bridge["']\s*,\s*process\.env\s*\)/.test(
      apiSrc,
    ),
  );
  check(
    "api.js ollama config takes resolved timeouts",
    /\.\.\.resolveProviderTimeouts\(\s*["']ollama["']\s*,\s*process\.env\s*\)/.test(
      apiSrc,
    ),
  );
  check(
    "api.js ollama_cloud config takes resolved timeouts",
    /\.\.\.resolveProviderTimeouts\(\s*["']ollama_cloud["']\s*,\s*process\.env\s*\)/.test(
      apiSrc,
    ),
  );
  check(
    "api.js has no direct OLLAMA_*_TIMEOUT_MS read",
    !/["']OLLAMA_(?:CLOUD_)?(?:STREAM_)?TIMEOUT_MS["']/.test(apiSrc),
  );
  check(
    "local-llm-bridge.js requires the resolver",
    /require\(\s*["']\.\/lib\/provider-timeout["']\s*\)/.test(bridgeSrc),
  );
  check(
    "local-llm-bridge.js upstream uses the resolver",
    /timeoutMs:\s*resolveBridgeTimeouts\(\s*process\.env\s*\)\.upstream/.test(
      bridgeSrc,
    ),
  );

  // ─── 2. Resolver unit behavior ────────────────────────────────────────
  const defaults = timeouts.resolveProviderTimeouts("", {});
  check(
    "default timeout and stream agree",
    defaults.timeout === defaults.streamTimeout &&
      defaults.timeout === timeouts.DEFAULT_PROVIDER_TIMEOUT_MS,
    "timeout=" + defaults.timeout + " stream=" + defaults.streamTimeout,
  );

  const providerSpecific = timeouts.resolveProviderTimeouts("ollama", {
    OLLAMA_TIMEOUT_MS: "1200000",
    OLLAMA_STREAM_TIMEOUT_MS: "900000",
  });
  check(
    "provider-specific env wins",
    providerSpecific.timeout === 1200000 &&
      providerSpecific.streamTimeout === 900000,
    "timeout=" + providerSpecific.timeout + " stream=" + providerSpecific.streamTimeout,
  );

  const providerSpecificStreamOnly = timeouts.resolveProviderTimeouts("ollama", {
    OLLAMA_TIMEOUT_MS: "1200000",
  });
  check(
    "stream falls back to the provider timeout",
    providerSpecificStreamOnly.streamTimeout === 1200000,
    "stream=" + providerSpecificStreamOnly.streamTimeout,
  );

  const generic = timeouts.resolveProviderTimeouts("groq", {
    PROVIDER_TIMEOUT_MS: "45000",
    PROVIDER_STREAM_TIMEOUT_MS: "90000",
  });
  check(
    "global PROVIDER_* env applies when the provider has none",
    generic.timeout === 45000 && generic.streamTimeout === 90000,
    "timeout=" + generic.timeout + " stream=" + generic.streamTimeout,
  );

  const invalid = timeouts.resolveProviderTimeouts("groq", {
    PROVIDER_TIMEOUT_MS: "abc",
    PROVIDER_STREAM_TIMEOUT_MS: "-1",
  });
  check(
    "invalid env falls back to defaults",
    invalid.timeout === timeouts.DEFAULT_PROVIDER_TIMEOUT_MS &&
      invalid.streamTimeout === timeouts.DEFAULT_PROVIDER_TIMEOUT_MS,
    "timeout=" + invalid.timeout + " stream=" + invalid.streamTimeout,
  );

  const bridge = timeouts.resolveBridgeTimeouts({ BRIDGE_TIMEOUT_MS: "1200000" });
  check(
    "bridge upstream keeps BRIDGE_TIMEOUT_MS",
    bridge.upstream === 1200000,
    "upstream=" + bridge.upstream,
  );
  check(
    "bridge gateway waits longer than its upstream",
    bridge.timeout > bridge.upstream && bridge.streamTimeout === bridge.timeout,
    "upstream=" + bridge.upstream + " gateway=" + bridge.timeout,
  );
  check(
    "bridge grace is the default 5s",
    bridge.grace === timeouts.DEFAULT_BRIDGE_GRACE_MS,
    "grace=" + bridge.grace,
  );

  const bridgeDefault = timeouts.resolveBridgeTimeouts({});
  check(
    "bridge default upstream is 120s",
    bridgeDefault.upstream === timeouts.DEFAULT_BRIDGE_TIMEOUT_MS &&
      bridgeDefault.timeout ===
        timeouts.DEFAULT_BRIDGE_TIMEOUT_MS + timeouts.DEFAULT_BRIDGE_GRACE_MS,
    "upstream=" + bridgeDefault.upstream + " gateway=" + bridgeDefault.timeout,
  );

  const bridgeInvalid = timeouts.resolveBridgeTimeouts({
    BRIDGE_TIMEOUT_MS: "nope",
    BRIDGE_TIMEOUT_GRACE_MS: "-10",
  });
  check(
    "invalid bridge env falls back to defaults",
    bridgeInvalid.upstream === timeouts.DEFAULT_BRIDGE_TIMEOUT_MS &&
      bridgeInvalid.grace === timeouts.DEFAULT_BRIDGE_GRACE_MS,
    "upstream=" + bridgeInvalid.upstream + " grace=" + bridgeInvalid.grace,
  );

  const bridgeAsProvider = timeouts.resolveProviderTimeouts("bridge", {
    BRIDGE_TIMEOUT_MS: "1200000",
  });
  check(
    "provider id bridge uses the bridge rule",
    bridgeAsProvider.timeout === bridge.timeout &&
      bridgeAsProvider.streamTimeout === bridge.streamTimeout,
    "timeout=" + bridgeAsProvider.timeout,
  );

  // ─── 3. Real HTTP: cfg and resolver deadlines ────────────────────────
  const slow = await startServer(250, '{"ok":true}');
  const slowStream = await startServer(250, 'data: {"ok":true}\n\n');
  try {
    const ok = await transport.request({ timeout: 2000 }, slow.url, {});
    check("cfg.timeout overrides the default", ok.statusCode === 200);

    await expectReject(
      "cfg.timeout still aborts a slow request",
      () => transport.request({ timeout: 100 }, slow.url, {}),
      "request timeout",
    );

    process.env.PROVIDER_TIMEOUT_MS = "120";
    try {
      await expectReject(
        "omitted cfg.timeout uses PROVIDER_TIMEOUT_MS",
        () => transport.request({}, slow.url, {}),
        "request timeout",
      );
    } finally {
      delete process.env.PROVIDER_TIMEOUT_MS;
    }

    process.env.PROVIDER_STREAM_TIMEOUT_MS = "120";
    try {
      await expectReject(
        "omitted cfg.streamTimeout uses PROVIDER_STREAM_TIMEOUT_MS",
        () => transport.stream({}, slowStream.url, {}, function () {}, { sse: true }),
        "stream timeout",
      );
    } finally {
      delete process.env.PROVIDER_STREAM_TIMEOUT_MS;
    }

    let line = "";
    const streamed = await transport.stream(
      { streamTimeout: 2000 },
      slowStream.url,
      {},
      function (next) {
        line = next;
      },
      { sse: true },
    );
    check(
      "cfg.streamTimeout overrides the default",
      streamed.statusCode === 200 && line === '{"ok":true}',
      "line=" + line,
    );
  } finally {
    await slow.close();
    await slowStream.close();
  }

  // ─── Summary ─────────────────────────────────────────────────────────
  console.log("");
  console.log("checks: " + (pass + fail) + " pass=" + pass + " fail=" + fail);
  if (fail > 0) {
    console.error("BRIDGE_TIMEOUT_FAIL");
    for (const item of failures) console.error(" - " + item);
    process.exit(1);
  }
  console.log("BRIDGE_TIMEOUT_OK");
}

main().catch((error) => {
  console.error("BRIDGE_TIMEOUT_FAIL " + (error && error.stack ? error.stack : error));
  process.exit(1);
});
