"use strict";

/**
 * tests/modules-runtime-check.js
 *
 * Real check for the runtime modules. It uses the real filesystem, real child
 * processes (`node -e`, `node --check`) and a real local HTTP server for the
 * web-search path. No mocked command results and no placeholder assertions.
 */

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const intentModule = require(path.join(ROOT, "modules", "intent"));
const syllabusModule = require(path.join(ROOT, "modules", "syllabus"));
const { GoalLedger } = require(path.join(ROOT, "modules", "goals"));
const verifyModule = require(path.join(ROOT, "modules", "verify"));
const compilerModule = require(path.join(ROOT, "modules", "compiler"));
const { Watchdog } = require(path.join(ROOT, "modules", "watchdog"));
const chatModule = require(path.join(ROOT, "modules", "chat-interpreter"));
const workspace = require(path.join(ROOT, "modules", "workspace"));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zc-runtime-"));
const ws = path.join(tmp, "ws");

async function main() {
  // ── 1. intent: validation + routing ─────────────────────────
  let executionIntent = null;
  await check("intent validates labels/modes/confidence and routes execution vs advisory", () => {
    assert.throws(
      () =>
        intentModule.validateIntent({
          label: "nonsense",
          mode: "advisory",
          confidence: 0.5,
          reason: "x",
          requires: { web_search: false, code_change: false, verification: false, compiler: false },
        }),
      (error) => error.code === "ZC_INTENT_INVALID",
    );
    assert.throws(
      () =>
        intentModule.validateIntent({
          label: "change",
          mode: "execution",
          confidence: 2,
          reason: "x",
          requires: { web_search: false, code_change: true, verification: true, compiler: true },
        }),
      (error) => error.code === "ZC_INTENT_INVALID",
    );
    assert.throws(
      () =>
        intentModule.validateIntent({
          label: "question",
          mode: "execution",
          confidence: 0.5,
          reason: "x",
          requires: { web_search: false, code_change: false, verification: false, compiler: false },
        }),
      (error) => error.code === "ZC_INTENT_INVALID",
    );

    executionIntent = intentModule.classifyIntent("fix the duplicate session store and run the check");
    assert.strictEqual(executionIntent.mode, "execution");
    assert.ok(["change", "execute"].includes(executionIntent.label));
    assert.strictEqual(executionIntent.requires.verification, true);

    const question = intentModule.classifyIntent("what does the normalizer do?");
    assert.strictEqual(question.mode, "advisory");
    assert.strictEqual(question.label, "question");
  });

  await check("planExecution asks for a syllabus write and a goal contract", () => {
    const plan = intentModule.planExecution(executionIntent, "fix the duplicate session store", {
      goal: "remove the duplicate session store",
      expected: "SESSION_STORE_OK",
      check: "node tests/session-store-check.js",
      pass: "only one store remains",
    });
    assert.strictEqual(plan.syllabus.input, "fix the duplicate session store");
    assert.strictEqual(plan.goal.verification, "contract");
    assert.strictEqual(plan.goal.expected, "SESSION_STORE_OK");

    const unverified = intentModule.planExecution(executionIntent, "fix the duplicate session store");
    assert.strictEqual(unverified.goal.verification, "UNVERIFIED");
  });

  // ── 2. syllabus: plugin skip + real append ──────────────────
  const pluginInput = "fix the duplicate session store";
  const freshInput = "rewrite the MCP handshake to negotiate protocol versions";
  await check("syllabus skips a plugin-written entry and appends a new one with fingerprint", () => {
    workspace.ensureWorkspace(ws);
    const paths = workspace.ensureWorkspacePaths(ws);
    fs.writeFileSync(
      paths.syllabus,
      [
        "# Agent Syllabus",
        "",
        "### Plugin entry",
        "- user input: " + pluginInput,
        "- result: plugin already recorded this",
        "",
      ].join("\n"),
      "utf8",
    );
    workspace.clearCache();

    const skipped = syllabusModule.appendSyllabusEntry({ dir: ws, input: pluginInput });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(skipped.reason, "plugin-entry");
    assert.ok(!fs.readFileSync(paths.syllabus, "utf8").includes("zc-entry:"));

    const written = syllabusModule.appendSyllabusEntry({
      dir: ws,
      input: freshInput,
      intent: executionIntent,
      conversation: [
        { role: "user", content: "the handshake is stale" },
        { role: "assistant", content: "I will inspect the MCP initialize path" },
      ],
      source: "runtime-check",
    });
    assert.strictEqual(written.written, true);
    assert.match(written.fingerprint_after, /^[a-f0-9]{16}$/);

    const text = fs.readFileSync(paths.syllabus, "utf8");
    assert.ok(text.includes("zc-entry:" + written.key));
    assert.ok(text.includes(freshInput));
    assert.ok(text.includes("prior conversation:"));
    assert.ok(text.includes("user: the handshake is stale"));

    const duplicate = syllabusModule.appendSyllabusEntry({ dir: ws, input: freshInput });
    assert.strictEqual(duplicate.reason, "duplicate");

    const stale = syllabusModule.appendSyllabusEntry({
      dir: ws,
      input: "another change",
      expectedFingerprint: "0000000000000000",
    });
    assert.strictEqual(stale.reason, "fingerprint-mismatch");
  });

  // ── 3. goal ledger: runs its own check ──────────────────────
  await check("goal ledger runs the real command and refuses a status-word expected", () => {
    const ledger = new GoalLedger({ dir: ws, timeoutMs: 20000 });
    const good = ledger.open({
      goal: "print the marker",
      input: "print GOAL_MARKER",
      expected: "GOAL_MARKER",
      check: 'node -e "process.stdout.write(\'GOAL_MARKER\')"',
      pass: "stdout contains GOAL_MARKER",
    });
    const pass = ledger.close(good.id);
    assert.strictEqual(pass.status, "PASS");
    assert.strictEqual(pass.exitCode, 0);
    assert.ok(pass.observed.includes("GOAL_MARKER"));

    const bad = ledger.open({
      goal: "print the marker",
      input: "print GOAL_MARKER",
      expected: "SOMETHING_ELSE",
      check: 'node -e "process.stdout.write(\'GOAL_MARKER\')"',
      pass: "stdout contains SOMETHING_ELSE",
    });
    const fail = ledger.close(bad.id);
    assert.strictEqual(fail.status, "FAIL");
    assert.strictEqual(fail.exitCode, 0);

    assert.throws(
      () =>
        ledger.open({
          goal: "status word",
          input: "x",
          expected: "PASS",
          check: 'node -e "process.stdout.write(\'PASS\')"',
          pass: "x",
        }),
      (error) => error.code === "ZC_GOAL_INVALID",
    );
  });

  // ── 4. verifier: no evidence, no success ────────────────────
  await check("verifier rejects a success claim without evidence and accepts real proof", () => {
    const bare = verifyModule.verifyOutput({
      input: "fix the duplicate session store",
      intent: executionIntent,
      output: "Done, fixed everything.",
    });
    assert.strictEqual(bare.passed, false);
    assert.ok(bare.reasons.some((reason) => reason.startsWith("evidence-for-success")));

    const proven = verifyModule.verifyOutput({
      input: "fix the duplicate session store",
      intent: executionIntent,
      output:
        "Fixed modules/sessions.js; node tests/modules-foundation-check.js exit 0 with MODULES_FOUNDATION_OK.",
    });
    assert.strictEqual(proven.passed, true, proven.reasons.join("; "));

    const aligned = verifyModule.verifyOutput({
      input: "how does masking work?",
      intent: intentModule.classifyIntent("how does masking work?"),
      output: "Masking strips provider identity in normalizer/index.js before the agent call.",
    });
    assert.strictEqual(aligned.passed, true, aligned.reasons.join("; "));
  });

  // ── 5. compiler: real parser ────────────────────────────────
  await check("compiler accepts valid JS/JSON and rejects a syntax error", () => {
    const dir = path.join(tmp, "compile");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "valid.js"), "const value = 1;\nmodule.exports = value;\n");
    fs.writeFileSync(path.join(dir, "invalid.js"), "const = ;\n");
    fs.writeFileSync(path.join(dir, "valid.json"), '{"ok":true}\n');

    const bad = compilerModule.compileFiles(["valid.js", "invalid.js", "valid.json"], { cwd: dir });
    assert.strictEqual(bad.passed, false);
    assert.strictEqual(bad.results.find((result) => result.file === "invalid.js").ok, false);

    const good = compilerModule.compileFiles(["valid.js", "valid.json"], { cwd: dir });
    assert.strictEqual(good.passed, true);
    assert.strictEqual(good.compiled, 2);
  });

  // ── 6. watchdog: file change + stale heartbeat ──────────────
  await check("watchdog detects a changed file and a stale heartbeat", () => {
    const file = path.join(tmp, "watched.txt");
    fs.writeFileSync(file, "one\n");
    let clock = 1000000;
    const watchdog = new Watchdog({ files: [file], now: () => clock, staleMs: 100 });
    watchdog.prime();
    assert.strictEqual(watchdog.checkNow().changes.length, 0);

    fs.writeFileSync(file, "two\n");
    const changed = watchdog.checkNow();
    assert.strictEqual(changed.changes.length, 1);
    assert.strictEqual(changed.changes[0].type, "changed");

    watchdog.beat("runtime");
    assert.strictEqual(watchdog.status().healthy, true);
    clock += 500;
    const status = watchdog.status();
    assert.strictEqual(status.stale, true);
    assert.strictEqual(status.healthy, false);
  });

  // ── 7. chat interpreter: web-chat only + real HTTP search ───
  await check("chat interpreter refuses other channels and fetches real search results", async () => {
    await assert.rejects(
      () => chatModule.interpretChat({ channel: "mcp", input: "hello" }),
      (error) => error.code === "ZC_CHAT_CHANNEL",
    );

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            {
              title: "MCP lifecycle " + url.searchParams.get("q"),
              url: "https://modelcontextprotocol.io/specification/lifecycle",
              snippet: "protocol version negotiation happens in initialize",
            },
          ],
        }),
      );
    });
    await new Promise((resolve) => server.listen(0, "localhost", resolve));
    const port = server.address().port;
    let searchCalls = 0;
    const webSearch = async (query) => {
      searchCalls += 1;
      const response = await fetch(
        "http://localhost:" + port + "/search?q=" + encodeURIComponent(query),
      );
      return response.json();
    };

    try {
      const chat = await chatModule.interpretChat({
        channel: "web-chat",
        input: "search the latest MCP lifecycle spec",
        history: [{ role: "user", content: "earlier question" }],
        tools: ["web_search", "write_file", "read_file"],
        webSearch,
      });
      assert.strictEqual(searchCalls, 1);
      assert.strictEqual(chat.usedWebSearch, true);
      assert.deepStrictEqual(chat.allowedTools, ["web_search"]);
      assert.ok(chat.messages.some((message) => message.content.includes("WEB SEARCH RESULTS")));
      assert.ok(chat.messages.some((message) => message.content.includes("modelcontextprotocol.io")));
      assert.ok(chat.messages.some((message) => message.content.includes("earlier question")));

      const plain = await chatModule.interpretChat({
        channel: "web-chat",
        input: "hello there",
        tools: ["web_search"],
        webSearch,
      });
      assert.strictEqual(plain.usedWebSearch, false);
      assert.strictEqual(searchCalls, 1, "plain chat must not call web search");
    } finally {
      await new Promise((resolve) => server.close(resolve));
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
      console.error("\nMODULES_RUNTIME_FAILED (" + failures.length + ")");
      process.exit(1);
    }
    console.log("\nMODULES_RUNTIME_OK");
  });
