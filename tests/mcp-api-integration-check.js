"use strict";

/**
 * tests/mcp-api-integration-check.js
 *
 * Real check for the MCP wire contract and its API wiring:
 *   - version negotiation against the supported list,
 *   - six editor profiles plus the unknown case,
 *   - header validation for version/session/accept,
 *   - workspace bootstrap on a real temp directory (idempotent),
 *   - initialize result + response headers,
 *   - a real local HTTP initialize round-trip (200 and 400 paths),
 *   - static wiring in api.js and scripts/build.js,
 *   - node --check for every changed entry point.
 *
 * No mocked command results, no placeholder assertions.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const mcp = require(path.join(ROOT, "modules", "mcp-protocol.js"));

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (error) {
    failures.push(name + ": " + error.message);
    console.error("FAIL - " + name + ": " + error.message);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zc-mcp-integration-"));
const ws = path.join(tmp, "workspace");
fs.mkdirSync(ws, { recursive: true });

async function main() {
  await check("negotiation echoes supported versions and falls back to the newest", () => {
    assert.strictEqual(mcp.PROTOCOL_VERSION, mcp.SUPPORTED_PROTOCOL_VERSIONS[0]);
    assert.deepStrictEqual(mcp.SUPPORTED_PROTOCOL_VERSIONS, [
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);

    for (const version of mcp.SUPPORTED_PROTOCOL_VERSIONS) {
      const result = mcp.negotiateProtocolVersion(version);
      assert.strictEqual(result.version, version);
      assert.strictEqual(result.requested, version);
      assert.strictEqual(result.supported, true);
      assert.strictEqual(result.fallback, false);
    }

    const fallback = mcp.negotiateProtocolVersion("2024-10-07");
    assert.strictEqual(fallback.version, mcp.PROTOCOL_VERSION);
    assert.strictEqual(fallback.requested, "2024-10-07");
    assert.strictEqual(fallback.supported, false);
    assert.strictEqual(fallback.fallback, true);
    assert.ok(mcp.SUPPORTED_PROTOCOL_VERSIONS.includes(fallback.version));

    const missing = mcp.negotiateProtocolVersion("");
    assert.strictEqual(missing.version, mcp.PROTOCOL_VERSION);
    assert.strictEqual(missing.fallback, false);
  });

  await check("detectEditor identifies all six editors and returns null otherwise", () => {
    const cases = [
      [{ name: "opencode", version: "1.0.0" }, "opencode"],
      [{ name: "Hermes Agent", version: "0.4.2" }, "hermes-vscode"],
      [{ name: "Cursor", version: "0.48.0" }, "cursor"],
      [{ name: "Plot", version: "1.2.0" }, "plot"],
      [{ name: "JetBrains IDE", version: "2025.2" }, "jetbrains"],
      [{ name: "IntelliJ IDEA", version: "2025.2" }, "jetbrains"],
      [{ name: "Windsurf", version: "1.0.0" }, "windsurf"],
    ];
    for (const [info, expected] of cases) {
      const editor = mcp.detectEditor(info);
      assert.ok(editor, "no profile for " + info.name);
      assert.strictEqual(editor.id, expected, info.name);
      assert.ok(editor.label && editor.transport, "profile is incomplete: " + expected);
    }

    const fromHeader = mcp.detectEditor(null, { "x-mcp-client-name": "Windsurf" });
    assert.ok(fromHeader);
    assert.strictEqual(fromHeader.id, "windsurf");

    assert.strictEqual(mcp.detectEditor({ name: "Unknown Editor 9000" }), null);
    assert.strictEqual(mcp.detectEditor(null), null);
    assert.strictEqual(mcp.detectEditor({}), null);
  });

  await check("header validation rejects bad version/session/accept and accepts legacy requests", () => {
    const good = mcp.validateMcpHeaders({
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": "zc-0123456789abcdef01234567",
      "x-mcp-client-dir": ws,
    });
    assert.strictEqual(good.ok, true);
    assert.deepStrictEqual(good.errors, []);
    assert.strictEqual(good.protocolVersion, "2025-06-18");
    assert.strictEqual(good.clientDir, ws);

    const legacy = mcp.validateMcpHeaders({});
    assert.strictEqual(legacy.ok, true);

    const wildcard = mcp.validateMcpHeaders({ accept: "*/*" });
    assert.strictEqual(wildcard.ok, true);

    const badVersion = mcp.validateMcpHeaders({ "mcp-protocol-version": "2024-10-07" });
    assert.strictEqual(badVersion.ok, false);
    assert.ok(badVersion.errors.some((error) => error.code === "ZC_MCP_VERSION"));

    const badSession = mcp.validateMcpHeaders({ "mcp-session-id": "bad id!" });
    assert.strictEqual(badSession.ok, false);
    assert.ok(badSession.errors.some((error) => error.code === "ZC_MCP_SESSION"));

    // A short but syntactically valid id from an older client is accepted;
    // only whitespace/control characters are malformed.
    const shortSession = mcp.validateMcpHeaders({ "mcp-session-id": "abc123" });
    assert.strictEqual(shortSession.ok, true);

    const badAccept = mcp.validateMcpHeaders({ accept: "text/event-stream" });
    assert.strictEqual(badAccept.ok, false);
    assert.ok(badAccept.errors.some((error) => error.code === "ZC_MCP_ACCEPT"));
  });

  await check("workspace bootstrap creates .zombie from roots and is idempotent", () => {
    const first = mcp.bootstrapWorkspace({
      roots: [{ uri: "file://" + ws }],
      cwd: tmp,
    });
    assert.strictEqual(first.dir, ws);
    assert.strictEqual(first.source, "mcp-roots");
    assert.ok(fs.existsSync(path.join(ws, ".zombie", "SSOT.md")));
    assert.ok(fs.existsSync(path.join(ws, ".zombie", "syllabus.md")));
    assert.ok(fs.existsSync(path.join(ws, ".zombie", "memory")));
    assert.ok(fs.existsSync(path.join(ws, ".zombie", "memory", "sessions")));
    assert.ok(!fs.existsSync(path.join(ws, ".zombie", "agents")));
    assert.ok(!fs.existsSync(path.join(ws, ".zombiecoder")), "server must never create the plugin tree");
    assert.ok(first.created.length > 0, "first connect must create the layout");
    assert.match(first.fingerprint, /^[a-f0-9]{16}$/);

    const second = mcp.bootstrapWorkspace({
      roots: [{ uri: "file://" + ws }],
      cwd: tmp,
    });
    assert.strictEqual(second.dir, ws);
    assert.strictEqual(second.created.length, 0, "second connect must not re-create files");
    assert.strictEqual(second.fingerprint, first.fingerprint);

    const viaHeader = mcp.bootstrapWorkspace({ headerDir: ws, cwd: tmp });
    assert.strictEqual(viaHeader.dir, ws);
    assert.strictEqual(viaHeader.source, "header");

    const invalidRoot = mcp.bootstrapWorkspace({
      roots: [{ uri: "file:///does/not/exist-zc-integration" }],
      cwd: ws,
    });
    assert.strictEqual(invalidRoot.dir, ws);
    assert.strictEqual(invalidRoot.source, "cwd");
  });

  await check("initialize result carries the negotiated version, editor and stable session", () => {
    const editor = mcp.detectEditor({ name: "Cursor", version: "0.48.0" });
    const result = mcp.buildInitializeResult({
      requestedVersion: "2024-11-05",
      clientInfo: { name: "Cursor", version: "0.48.0" },
      workspace: { dir: ws },
      rootsDetected: true,
      serverVersion: "3.2.1",
      domain: "localhost",
      serverType: "development",
    });
    assert.strictEqual(result.protocolVersion, "2024-11-05");
    assert.deepStrictEqual(result.capabilities, { tools: {} });
    assert.strictEqual(result.serverInfo.name, "mission-barisal");
    assert.strictEqual(result.serverInfo.working_dir, ws);
    // The key is kept for wire compatibility; its value is the server-owned
    // `.zombie/` directory, never the read-only plugin tree.
    assert.strictEqual(result.serverInfo.zombiecoder_dir, path.join(ws, ".zombie"));
    assert.strictEqual(result.serverInfo.editor, "cursor");
    assert.strictEqual(result.serverInfo.roots_detected, true);
    assert.strictEqual(result._meta.requestedProtocolVersion, "2024-11-05");
    assert.strictEqual(result._meta.protocolFallback, false);

    const unsupported = mcp.buildInitializeResult({
      requestedVersion: "2024-10-07",
      clientInfo: { name: "Windsurf" },
      workspace: { dir: ws },
    });
    assert.strictEqual(unsupported.protocolVersion, mcp.PROTOCOL_VERSION);
    assert.strictEqual(unsupported._meta.protocolFallback, true);
    assert.strictEqual(unsupported.serverInfo.editor, "windsurf");

    const sessionA = mcp.sessionIdFor({ editor, workspaceDir: ws });
    const sessionB = mcp.sessionIdFor({ editor, workspaceDir: ws });
    assert.strictEqual(sessionA, sessionB);
    assert.match(sessionA, /^zc-[a-f0-9]{24}$/);

    const headers = mcp.initializeHeaders({
      protocolVersion: result.protocolVersion,
      sessionId: sessionA,
    });
    assert.strictEqual(headers["MCP-Protocol-Version"], "2024-11-05");
    assert.strictEqual(headers["Mcp-Session-Id"], sessionA);
  });

  await check("a real HTTP initialize returns the negotiated version and rejects a bad version header", async () => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const headerCheck = mcp.validateMcpHeaders(req.headers);
        if (!headerCheck.ok) {
          const payload = JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message: "Invalid MCP headers",
              data: headerCheck.errors,
            },
          });
          res.writeHead(400, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(payload),
          });
          res.end(payload);
          return;
        }

        let message = {};
        try {
          message = JSON.parse(body || "{}");
        } catch (_) {
          res.writeHead(400);
          res.end();
          return;
        }
        if (message.method !== "initialize") {
          res.writeHead(400);
          res.end();
          return;
        }

        const boot = mcp.bootstrapWorkspace({
          roots: message.params && message.params.roots,
          cwd: ws,
        });
        const editor = mcp.detectEditor(
          message.params && message.params.clientInfo,
          req.headers,
        );
        const sessionId = mcp.sessionIdFor({ editor, workspaceDir: boot.dir });
        const result = mcp.buildInitializeResult({
          requestedVersion: message.params && message.params.protocolVersion,
          clientInfo: message.params && message.params.clientInfo,
          headers: req.headers,
          workspace: { dir: boot.dir },
          rootsDetected: boot.source !== "cwd",
          serverVersion: "3.2.1",
          domain: "localhost",
          serverType: "development",
        });
        const initHeaders = mcp.initializeHeaders({
          protocolVersion: result.protocolVersion,
          sessionId,
        });
        const payload = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        res.writeHead(200, Object.assign({
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        }, initHeaders));
        res.end(payload);
      });
    });

    await new Promise((resolve) => server.listen(0, "localhost", resolve));
    const port = server.address().port;
    const url = "http://localhost:" + port + "/mcp";

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            clientInfo: { name: "OpenCode", version: "1.0.0" },
            roots: [{ uri: "file://" + ws }],
          },
        }),
      });
      assert.strictEqual(response.status, 200);
      assert.strictEqual(response.headers.get("mcp-protocol-version"), "2025-03-26");
      const sessionId = response.headers.get("mcp-session-id");
      assert.ok(sessionId, "initialize response must carry Mcp-Session-Id");
      assert.match(sessionId, /^zc-[a-f0-9]{24}$/);

      const payload = await response.json();
      assert.strictEqual(payload.result.protocolVersion, "2025-03-26");
      assert.strictEqual(payload.result.serverInfo.editor, "opencode");
      assert.strictEqual(payload.result.serverInfo.working_dir, ws);

      const bad = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": "2024-10-07",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { protocolVersion: "2024-10-07" },
        }),
      });
      assert.strictEqual(bad.status, 400);
      const badPayload = await bad.json();
      assert.ok(
        badPayload.error.data.some((error) => error.code === "ZC_MCP_VERSION"),
        "400 response must name ZC_MCP_VERSION",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await check("api.js and scripts/build.js are wired to the new modules", () => {
    const api = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
    const build = fs.readFileSync(path.join(ROOT, "scripts", "build.js"), "utf8");

    assert.ok(api.includes('require("./modules/mcp-protocol.js")'));
    assert.ok(api.includes('require("./modules/context.js")'));
    assert.ok(api.includes('require("./modules/system-prompt.js")'));

    assert.ok(api.includes("mcpProtocol.validateMcpHeaders("));
    assert.ok(api.includes("mcpProtocol.negotiateProtocolVersion("));
    assert.ok(api.includes("mcpProtocol.bootstrapWorkspace("));
    assert.ok(api.includes("mcpProtocol.buildInitializeResult("));
    const initBuilds = (api.match(/mcpProtocol\.buildInitializeResult\(/g) || []).length;
    assert.ok(initBuilds >= 2, "HTTP and UDS initialize must both use buildInitializeResult");

    assert.ok(!api.includes('protocolVersion: "2024-11-05"'), "hardcoded initialize version remains");
    assert.ok(!api.includes('protocol_version: "2024-11-05"'), "hardcoded /api/mcp-clients version remains");
    assert.ok(api.includes("protocol_version: mcpProtocol.PROTOCOL_VERSION"));
    assert.ok(api.includes("supported_protocol_versions: mcpProtocol.SUPPORTED_PROTOCOL_VERSIONS"));

    const agentPrompt = api.slice(
      api.indexOf("function buildAgentSystemPrompt"),
      api.indexOf("function buildCompactSystemPrompt"),
    );
    assert.ok(agentPrompt.includes("buildSystemPrompt("), "buildAgentSystemPrompt must delegate");
    const compactPrompt = api.slice(
      api.indexOf("function buildCompactSystemPrompt"),
      api.indexOf("async function executeSingleAgent"),
    );
    assert.ok(compactPrompt.includes("buildSystemPrompt("), "buildCompactSystemPrompt must delegate");

    const ssotExcerpt = api.slice(
      api.indexOf("function buildSSOTExcerpt"),
      api.indexOf("function buildSyllabusExcerpt"),
    );
    assert.ok(ssotExcerpt.includes("pickEntries("), "buildSSOTExcerpt must delegate to modules/context.js");
    assert.ok(!ssotExcerpt.includes("slimSSOT("), "legacy slimSSOT call remains in buildSSOTExcerpt");

    const syllabusExcerpt = api.slice(
      api.indexOf("function buildSyllabusExcerpt"),
      api.indexOf("function buildAgentSystemPrompt"),
    );
    assert.ok(syllabusExcerpt.includes("pickEntries("), "buildSyllabusExcerpt must delegate to modules/context.js");
    assert.ok(!syllabusExcerpt.includes("slimSyllabus("), "legacy slimSyllabus call remains in buildSyllabusExcerpt");

    const copyDirs = build.slice(build.indexOf("const COPY_DIRS"), build.indexOf("const COPY_FILES"));
    assert.ok(copyDirs.includes('"modules"'), "scripts/build.js must copy modules/");
  });

  await check("node --check passes for api.js, modules/mcp-protocol.js and scripts/build.js", () => {
    for (const file of ["api.js", "modules/mcp-protocol.js", "scripts/build.js"]) {
      const run = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
        encoding: "utf8",
      });
      assert.strictEqual(
        run.status,
        0,
        file + " failed node --check: " + String(run.stderr || run.stdout || "").slice(0, 500),
      );
    }
  });
}

main()
  .catch((error) => {
    failures.push("unexpected: " + error.message);
    console.error("FAIL - unexpected: " + error.stack);
  })
  .finally(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {
      /* temp cleanup is best-effort */
    }
    if (failures.length > 0) {
      console.error("\nMCP_API_INTEGRATION_FAILED (" + failures.length + ")");
      process.exit(1);
    }
    console.log("\nMCP_API_INTEGRATION_OK");
  });
