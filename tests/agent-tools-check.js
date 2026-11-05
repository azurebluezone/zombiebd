#!/usr/bin/env node
"use strict";

/**
 * Agent tool audit — real requests, not fixture assertions.
 *
 * For every agent served by the live gateway this checks:
 *   1. the agent advertises its bound tool list in /api/agents
 *   2. every bound name exists in the live /mcp catalog
 *   3. a safe tool call (get_working_dir) succeeds with X-Agent-Id set
 *   4. X-Request-Actor on the response names the same agent and origin
 *
 * The probe proves the gateway routes and identifies the agent. It does not
 * prove per-agent permissions: the current build binds every agent to the
 * same first N tools from one catalog, which is printed as a finding.
 */

const http = require("http");
const path = require("path");
const { loadEnv } = require("../lib/env.js");

const ROOT = path.resolve(__dirname, "..");
const ENV = loadEnv({ root: ROOT });
const API = process.env.ZOMBIE_API_URL || "http://127.0.0.1:" + (ENV.ports.api || 5050);
// tools/call passes through the MCP CSRF gate: no-Origin and loopback
// origins are allowed, arbitrary external origins are not. A real local
// client uses this origin, so the audit does the same instead of weakening
// the gate for a test.
const ORIGIN = new URL(API).origin;
const CLIENT = "agent-tools-check";
const PROBE_TOOL = "get_working_dir";
const EXPECTED_AGENTS = 9;
const EXPECTED_BOUND = 25;

function request(pathname, options) {
  const payload = options && options.body ? JSON.stringify(options.body) : null;
  const url = new URL(pathname, API);
  const headers = Object.assign({}, (options && options.headers) || {});
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: (options && options.method) || "GET",
        headers,
        timeout: (options && options.timeoutMs) || 10000,
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* non-JSON body is reported through status/text */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", (err) => resolve({ status: 0, headers: {}, text: "", error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, headers: {}, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function decodeActor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch (_) {
    return null;
  }
}

function identityHeaders(agentId) {
  const headers = {
    "X-MCP-Client-Name": CLIENT,
    Origin: ORIGIN,
    Accept: "application/json",
  };
  if (agentId) headers["X-Agent-Id"] = agentId;
  return headers;
}

let failures = 0;
function pass(message) {
  console.log("PASS " + message);
}
function fail(message) {
  failures++;
  console.log("FAIL " + message);
}

async function mcp(method, params, agentId) {
  return request("/mcp", {
    method: "POST",
    headers: identityHeaders(agentId),
    body: { jsonrpc: "2.0", id: method + "-" + agentId, method, params: params || {} },
  });
}

async function main() {
  const health = await request("/health", { timeoutMs: 4000 });
  if (health.status !== 200) {
    console.log(
      "RESULT: AGENT TOOLS NOT_TESTED reason=api_unreachable status=" +
        (health.status || health.error) +
        " url=" +
        API,
    );
    process.exitCode = 2;
    return;
  }

  const catalogResponse = await mcp("tools/list", {});
  const tools = catalogResponse.json && catalogResponse.json.result && catalogResponse.json.result.tools;
  if (catalogResponse.status !== 200 || !Array.isArray(tools)) {
    fail(
      "catalog status=" +
        catalogResponse.status +
        " error=" +
        ((catalogResponse.json && catalogResponse.json.error && catalogResponse.json.error.message) ||
          catalogResponse.error ||
          "no tools array"),
    );
    console.log("RESULT: AGENT TOOLS FAIL catalog_unreadable");
    process.exitCode = 1;
    return;
  }
  const names = new Set(tools.map((t) => t && t.name).filter(Boolean));
  if (names.size !== 153) {
    fail("catalog size=" + names.size + " expected=153");
  } else {
    pass("catalog tools=153 source=live /mcp");
  }

  const schemaBad = tools.filter(
    (t) =>
      !t.name ||
      typeof t.description !== "string" ||
      !t.inputSchema ||
      t.inputSchema.type !== "object" ||
      typeof t.inputSchema.properties !== "object",
  );
  if (schemaBad.length) {
    fail("catalog schema bad=" + schemaBad.slice(0, 5).map((t) => t && t.name).join(","));
  } else {
    pass("catalog schema valid tools=" + tools.length);
  }

  const agentsResponse = await request("/api/agents");
  const agents = agentsResponse.json && agentsResponse.json.agents;
  if (agentsResponse.status !== 200 || !Array.isArray(agents)) {
    fail("agents status=" + agentsResponse.status);
    console.log("RESULT: AGENT TOOLS FAIL api_agents_unreadable");
    process.exitCode = 1;
    return;
  }
  if (agents.length !== EXPECTED_AGENTS) {
    fail("agents count=" + agents.length + " expected=" + EXPECTED_AGENTS);
  } else {
    pass("agents count=9 source=/api/agents");
  }

  const shard = agents[0] && agents[0].tools && agents[0].tools.bound;
  if (shard && agents.every((a) => JSON.stringify(a.tools.bound) === JSON.stringify(shard))) {
    console.log(
      "FINDING all agents share the same bound list (" +
        shard.length +
        " tools); no per-agent allowlist exists in this build",
    );
  }

  let probes = 0;
  for (const agent of agents) {
    const toolMeta = agent.tools || {};
    const bound = Array.isArray(toolMeta.bound) ? toolMeta.bound : [];
    const streamBound = Array.isArray(toolMeta.stream_bound) ? toolMeta.stream_bound : [];
    const unknown = bound.filter((name) => !names.has(name));
    const duplicates = bound.filter((name, index) => bound.indexOf(name) !== index);

    if (toolMeta.catalog !== tools.length) {
      fail("agent=" + agent.id + " catalog=" + toolMeta.catalog + " live=" + tools.length);
      continue;
    }
    if (bound.length !== EXPECTED_BOUND) {
      fail("agent=" + agent.id + " bound=" + bound.length + " expected=" + EXPECTED_BOUND);
      continue;
    }
    if (unknown.length || duplicates.length) {
      fail(
        "agent=" +
          agent.id +
          " unknown=" +
          unknown.slice(0, 3).join(",") +
          " duplicates=" +
          duplicates.slice(0, 3).join(","),
      );
      continue;
    }
    if (!streamBound.length || streamBound.length > bound.length) {
      fail("agent=" + agent.id + " stream_bound=" + streamBound.length);
      continue;
    }

    const call = await mcp("tools/call", { name: PROBE_TOOL, arguments: {} }, agent.id);
    const error = call.json && call.json.error;
    const result = call.json && call.json.result;
    if (call.status !== 200 || error || !result) {
      fail(
        "agent=" +
          agent.id +
          " probe=" +
          PROBE_TOOL +
          " status=" +
          call.status +
          " error=" +
          ((error && (error.message || error.code)) || call.error || "no result"),
      );
      continue;
    }

    const actor = decodeActor(call.headers["x-request-actor"]);
    if (!actor || actor.agent !== agent.id || actor.origin !== ORIGIN) {
      fail(
        "agent=" +
          agent.id +
          " actor=" +
          JSON.stringify(actor) +
          " expected agent=" +
          agent.id +
          " origin=" +
          ORIGIN,
      );
      continue;
    }

    probes++;
    pass(
      "agent=" +
        agent.id +
        " bound=" +
        bound.length +
        " stream=" +
        streamBound.length +
        " probe=" +
        PROBE_TOOL +
        " actor=" +
        actor.agent,
    );
  }

  if (failures === 0 && probes === EXPECTED_AGENTS) {
    console.log(
      "RESULT: AGENT TOOLS PASS agents=" +
        agents.length +
        " catalog=" +
        tools.length +
        " bound=" +
        EXPECTED_BOUND +
        " probes=" +
        probes,
    );
    process.exitCode = 0;
    return;
  }
  console.log("RESULT: AGENT TOOLS FAIL failures=" + failures + " probes=" + probes);
  process.exitCode = 1;
}

main().catch((err) => {
  console.log("RESULT: AGENT TOOLS FAIL error=" + err.message);
  process.exitCode = 1;
});
