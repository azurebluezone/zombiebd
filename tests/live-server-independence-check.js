"use strict";

/**
 * Live server independence gate.
 *
 * Proves the *running* gateway executes the server-independent build, not just
 * that the source tree contains it:
 *   1. dist/api.js was rebuilt from the new source (adapter + workspace header);
 *   2. /health is 200 and healthy;
 *   3. a real MCP initialize with a fresh `roots` entry creates `.zombie/`
 *      in that workspace and never creates `.zombiecoder/`;
 *   4. the response carries a stable 12-hex `x-zc-workspace-id`;
 *   5. a second initialize with the real project root restores the working
 *      directory (verified through the real `get_working_dir` tool).
 *
 * Exit 0 + `LIVE_SERVER_INDEPENDENT_OK` only when every check passes.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const adapter = require(path.join(ROOT, "modules", "workspace-adapter.js"));

const HOST = process.env.ZC_HOST || "127.0.0.1";
const PORT = Number(process.env.ZC_PORT || 5050);
const HEALTH_URL = "http://" + HOST + ":" + PORT + "/health";
const MCP_URL = "http://" + HOST + ":" + PORT + "/mcp";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  [PASS] " + name + (detail ? " — " + detail : ""));
    return true;
  }
  failed += 1;
  const line = name + (detail ? " — " + detail : "");
  failures.push(line);
  console.log("  [FAIL] " + line);
  return false;
}

function postJson(url, body) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": payload.length,
          accept: "application/json",
          "x-mcp-client-name": "live-server-independence-check",
          "x-mcp-client-version": "1.0.0",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* non-JSON body is reported by the caller */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, headers: {}, text: "", json: null, error: error.message }));
    req.end(payload);
  });
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (_) {
          /* ignore */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve({ status: 0, json: null, error: error.message }));
  });
}

function initializeBody(roots, id) {
  return {
    jsonrpc: "2.0",
    id: id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "live-server-independence-check", version: "1.0.0" },
      roots: roots,
    },
  };
}

function toolCallBody(name, args, id) {
  return {
    jsonrpc: "2.0",
    id: id,
    method: "tools/call",
    params: { name: name, arguments: args || {} },
  };
}

async function main() {
  const base = fs.existsSync("/tmp/opencode")
    ? fs.mkdtempSync(path.join("/tmp/opencode", "zc-live-indep-"))
    : fs.mkdtempSync(path.join(os.tmpdir(), "zc-live-indep-"));
  const probe = path.join(base, "probe-project");
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "README.md"), "# live independence probe\n", "utf8");

  console.log("Live server independence check");
  console.log("  gateway: http://" + HOST + ":" + PORT);
  console.log("  probe:   " + probe);

  // 1. The build on disk is the new build.
  const distApi = path.join(ROOT, "dist", "api.js");
  const distText = fs.existsSync(distApi) ? fs.readFileSync(distApi, "utf8") : "";
  check("dist/api.js exists", distText.length > 0, distApi);
  check(
    "dist/api.js contains the workspace adapter",
    distText.includes("workspace-adapter"),
    "adapter=" + distText.includes("workspace-adapter"),
  );
  check(
    "dist/api.js carries the workspace id header",
    distText.includes("x-zc-workspace-id"),
    "header=" + distText.includes("x-zc-workspace-id"),
  );

  // 2. The live process answers.
  const health = await getJson(HEALTH_URL);
  check(
    "live /health is healthy",
    health.status === 200 && health.json && health.json.healthy === true,
    health.error || "status=" + health.status,
  );

  // 3. Fresh workspace through the real initialize path.
  const probeInit = await postJson(
    MCP_URL,
    initializeBody([{ uri: "file://" + probe }], 1),
  );
  check("live initialize accepted", probeInit.status === 200 && Boolean(probeInit.json && probeInit.json.result), probeInit.error || "status=" + probeInit.status);
  const probeId = String(probeInit.headers["x-zc-workspace-id"] || "");
  check("live initialize returns a 12-hex workspace id", /^[0-9a-f]{12}$/.test(probeId), probeId || "missing");
  check("workspace id matches the adapter", probeId === adapter.workspaceId(probe), probeId + " vs " + adapter.workspaceId(probe));

  const probeZombie = path.join(probe, ".zombie");
  const probePlugin = path.join(probe, ".zombiecoder");
  check("live initialize created .zombie/", fs.existsSync(probeZombie), probeZombie);
  check("live initialize created .zombie/SSOT.md", fs.existsSync(path.join(probeZombie, "SSOT.md")), path.join(probeZombie, "SSOT.md"));
  check("live initialize never created .zombiecoder/", !fs.existsSync(probePlugin), probePlugin);

  // 4. Restore the real working directory through the same real path.
  const restoreInit = await postJson(
    MCP_URL,
    initializeBody([{ uri: "file://" + ROOT }], 2),
  );
  check("restore initialize accepted", restoreInit.status === 200 && Boolean(restoreInit.json && restoreInit.json.result), restoreInit.error || "status=" + restoreInit.status);
  const restoreId = String(restoreInit.headers["x-zc-workspace-id"] || "");
  check("restore returns the real project id", /^[0-9a-f]{12}$/.test(restoreId) && restoreId === adapter.workspaceId(ROOT), restoreId || "missing");

  const working = await postJson(MCP_URL, toolCallBody("get_working_dir", {}, 3));
  const workingText =
    working.json &&
    working.json.result &&
    Array.isArray(working.json.result.content) &&
    working.json.result.content[0]
      ? String(working.json.result.content[0].text || "")
      : "";
  check("get_working_dir restored the real project", workingText === ROOT, workingText || "empty");

  console.log("");
  console.log("checks: " + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("LIVE_SERVER_INDEPENDENT_FAIL");
    for (const line of failures) console.log("  - " + line);
    process.exit(1);
  }
  console.log(
    "LIVE_SERVER_INDEPENDENT_OK dist=1 live=1 zombie_only=1 id=12 restore=1",
  );
  process.exit(0);
}

main().catch((error) => {
  console.log("LIVE_SERVER_INDEPENDENT_FAIL " + error.message);
  process.exit(1);
});
