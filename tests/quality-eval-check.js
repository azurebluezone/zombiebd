#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: 30-case deterministic quality eval (runbook P2-03)
//       + bounded log/backup retention (runbook P2-02)
// =============================================================================
// Every case calls the real module or the live gateway. No mocks, no fixtures
// that replace production code: retention uses a temp directory, the rest read
// the project files or the running gateway.
//
// Run: node tests/quality-eval-check.js
// Exit 0 + QUALITY_EVAL_OK only when all 30 cases pass.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const { classifyIntent } = require(path.join(ROOT, "modules", "intent.js"));
const {
  CHAT_TOOL_ALLOWLIST,
  selectChatTools,
  normalizeResults,
  interpretChat,
} = require(path.join(ROOT, "modules", "chat-interpreter.js"));
const { limit, capText, trimMessages } = require(path.join(ROOT, "lib", "size-budget.js"));
const { buildSystemPrompt } = require(path.join(ROOT, "modules", "system-prompt.js"));
const { identityPromptBlock } = require(path.join(ROOT, "modules", "system-identity.js"));
const {
  pruneLogs,
  pruneBackups,
  pruneRetention,
} = require(path.join(ROOT, "modules", "retention.js"));

let pass = 0;
let fail = 0;
const rows = [];

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function runCase(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } catch (err) {
    fail += 1;
    rows.push(["FAIL", name, String((err && err.message) || err)]);
  }
}

function withEnv(key, value, fn) {
  const old = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env[key];
    else process.env[key] = old;
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(dir, name, bytes) {
  fs.writeFileSync(path.join(dir, name), "x".repeat(bytes));
}

function httpJson(port, pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: pathname, timeout: timeoutMs || 5000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(body) });
          } catch (err) {
            reject(new Error("invalid JSON: " + err.message));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

function toolName(tool) {
  if (typeof tool === "string") return tool;
  if (!tool || typeof tool !== "object") return "";
  return String(tool.name || tool.id || (tool.function && tool.function.name) || "");
}

function intentCase(text, expected) {
  const intent = classifyIntent(text);
  assert(intent.label === expected.label, "label=" + intent.label + " want " + expected.label);
  if (expected.mode) assert(intent.mode === expected.mode, "mode=" + intent.mode + " want " + expected.mode);
  for (const key of ["web_search", "code_change", "verification", "compiler"]) {
    if (expected[key] !== undefined) {
      assert(
        intent.requires[key] === expected[key],
        "requires." + key + "=" + intent.requires[key] + " want " + expected[key],
      );
    }
  }
  return intent.label + "/" + intent.mode;
}

(async () => {
  const guard = setTimeout(() => {
    console.error("QUALITY_EVAL_TIMEOUT");
    process.exit(1);
  }, 60000);

  // ── Intent (7) ───────────────────────────────────────────────
  await runCase("intent: Bengali greeting is chat", () =>
    intentCase("হ্যালো ভাইয়া কেমন আছো", { label: "chat", mode: "advisory", code_change: false }),
  );
  await runCase("intent: fix 500 is change", () =>
    intentCase("fix the 500 error in api.js", {
      label: "change",
      mode: "execution",
      code_change: true,
      verification: true,
      compiler: true,
    }),
  );
  await runCase("intent: security review is review", () =>
    intentCase("review this login code for security issues", { label: "review", mode: "advisory" }),
  );
  await runCase("intent: documentation is execute", () =>
    intentCase("write documentation for the runbook", { label: "execute", mode: "execution" }),
  );
  await runCase("intent: release gate is release", () =>
    intentCase("test the release and report failures", { label: "release", mode: "execution" }),
  );
  await runCase("intent: weather needs web search", () =>
    intentCase("what is the weather in Barisal today", {
      label: "question",
      mode: "advisory",
      web_search: true,
    }),
  );
  await runCase("intent: crash question is debug", () =>
    intentCase("why does the gateway crash on boot", { label: "debug", mode: "advisory" }),
  );

  // ── Chat interpreter (5) ────────────────────────────────────
  await runCase("chat: allowlist is exact and frozen", () => {
    assert(Array.isArray(CHAT_TOOL_ALLOWLIST), "allowlist is not an array");
    assert(Object.isFrozen(CHAT_TOOL_ALLOWLIST), "allowlist is not frozen");
    assert(
      JSON.stringify(CHAT_TOOL_ALLOWLIST) === JSON.stringify(["web_search", "get_time", "calculate"]),
      "allowlist=" + JSON.stringify(CHAT_TOOL_ALLOWLIST),
    );
    return CHAT_TOOL_ALLOWLIST.join(",");
  });
  await runCase("chat: file and shell tools are filtered out", () => {
    const selected = selectChatTools([
      "web_search",
      "shell",
      "get_time",
      { name: "read_file" },
      { function: { name: "calculate" } },
    ]);
    const names = selected.map(toolName);
    assert(names.length === 3, "selected=" + names.join(","));
    assert(!names.includes("shell") && !names.includes("read_file"), "unsafe tool leaked");
    return names.join(",");
  });
  await runCase("chat: mission channel is rejected", async () => {
    let error = null;
    try {
      await interpretChat({ channel: "mission", input: "hello" });
    } catch (err) {
      error = err;
    }
    assert(error && error.code === "ZC_CHAT_CHANNEL", "error=" + (error && error.code));
    return error.code;
  });
  await runCase("chat: web results are capped and trimmed", () => {
    const raw = Array.from({ length: 7 }, () => ({
      title: "t".repeat(300),
      url: "u".repeat(600),
      snippet: "s".repeat(600),
    }));
    const out = normalizeResults(raw);
    assert(out.length === 5, "length=" + out.length);
    assert(out[0].title.length === 200, "title=" + out[0].title.length);
    assert(out[0].url.length === 500, "url=" + out[0].url.length);
    assert(out[0].snippet.length === 500, "snippet=" + out[0].snippet.length);
    return "5 results, 200/500/500";
  });
  await runCase("chat: web-chat sees only allowed tools", async () => {
    const result = await interpretChat({
      channel: "web-chat",
      input: "hello",
      tools: ["web_search", "shell", "read_file", "calculate"],
    });
    assert(
      JSON.stringify(result.allowedTools) === JSON.stringify(["web_search", "calculate"]),
      "allowed=" + JSON.stringify(result.allowedTools),
    );
    assert(result.usedWebSearch === false, "unexpected web search");
    return result.allowedTools.join(",");
  });

  // ── Size budgets (5) ────────────────────────────────────────
  await runCase("budget: body default is 10 MB", () =>
    withEnv("MAX_BODY_SIZE", undefined, () => {
      const value = limit("MAX_BODY_SIZE");
      assert(value === 10485760, "value=" + value);
      return String(value);
    }),
  );
  await runCase("budget: env override wins", () =>
    withEnv("MAX_BODY_SIZE", "1234", () => {
      const value = limit("MAX_BODY_SIZE");
      assert(value === 1234, "value=" + value);
      return String(value);
    }),
  );
  await runCase("budget: invalid env falls back", () =>
    withEnv("MAX_BODY_SIZE", "0", () => {
      const value = limit("MAX_BODY_SIZE");
      assert(value === 10485760, "value=" + value);
      return String(value);
    }),
  );
  await runCase("budget: capText names the budget", () =>
    withEnv("TOOL_RESULT_MAX_BYTES", "100", () => {
      const out = capText("x".repeat(500), "TOOL_RESULT_MAX_BYTES");
      assert(out.truncated === true, "not truncated");
      assert(out.text.includes("[truncated: TOOL_RESULT_MAX_BYTES=100"), "marker missing");
      assert(Buffer.byteLength(out.text, "utf8") <= 100, "bytes=" + Buffer.byteLength(out.text, "utf8"));
      return "kept=" + Buffer.byteLength(out.text, "utf8");
    }),
  );
  await runCase("budget: trimMessages keeps system and newest", () =>
    withEnv("SESSION_MAX_BYTES", "1200", () => {
      const messages = [{ role: "system", content: "s".repeat(100) }];
      for (let i = 0; i < 6; i += 1) messages.push({ role: "user", content: "m" + i + "x".repeat(490) });
      const out = trimMessages(messages, "SESSION_MAX_BYTES");
      assert(out.dropped > 0, "dropped=" + out.dropped);
      assert(out.messages[0].role === "system", "system message lost");
      assert(
        out.messages[out.messages.length - 1].content === messages[messages.length - 1].content,
        "newest message lost",
      );
      assert(out.bytes <= 1200, "bytes=" + out.bytes);
      return "dropped=" + out.dropped + " bytes=" + out.bytes;
    }),
  );

  // ── Identity (3) ────────────────────────────────────────────
  const identity = identityPromptBlock();
  const prompt = buildSystemPrompt({
    agent: { id: "zombiecoder", name: "ZombieCoder", role: "arbiter" },
    persona: "Chief Arbiter",
    session: { system_identity: identity, metadata: {} },
    maxChars: 6000,
  });
  await runCase("identity: name and version are injected", () => {
    assert(prompt.includes("Mission Barisal 3.2.1"), "name/version missing");
    return "Mission Barisal 3.2.1";
  });
  await runCase("identity: exact anchor is injected", () => {
    assert(prompt.includes(identity.anchor), "anchor missing");
    assert(identity.anchor.includes("Sahon Srabon"), "owner missing from anchor");
    return identity.anchor.slice(0, 32) + "…";
  });
  await runCase("identity: evidence rule is injected", () => {
    assert(prompt.includes("UNVERIFIED"), "UNVERIFIED rule missing");
    assert(prompt.includes("Never present an assumption as fact"), "assumption rule missing");
    return "UNVERIFIED + assumption rule";
  });

  // ── Version SSOT (2) ────────────────────────────────────────
  const pkg = JSON.parse(read("package.json"));
  const versionSources = {
    "package.json": pkg.version,
    "identity.json": JSON.parse(read("identity.json")).system_identity.version,
    "start.js": (read("start.js").match(/const VERSION = "([^"]+)"/) || [])[1],
    "domain-config.js": (read("domain-config.js").match(/SERVER_VERSION \|\| "([^"]+)"/) || [])[1],
  };
  await runCase("version: four sources agree", () => {
    const values = new Set(Object.values(versionSources).filter(Boolean));
    assert(values.size === 1, JSON.stringify(versionSources));
    assert(versionSources["package.json"] === "3.2.1", "version=" + versionSources["package.json"]);
    return JSON.stringify(versionSources);
  });
  await runCase("version: package is private and Node 24+", () => {
    assert(pkg.private === true, "private=" + pkg.private);
    assert(/^>=\s*24/.test(String(pkg.engines && pkg.engines.node)), "engines=" + (pkg.engines && pkg.engines.node));
    assert(
      pkg.scripts && pkg.scripts.build && fs.existsSync(path.join(ROOT, "start.js")),
      "build script target missing",
    );
    return "private, " + pkg.engines.node;
  });

  // ── R2T trace (2) ───────────────────────────────────────────
  const apiText = read("api.js");
  await runCase("r2t: response headers are wired", () => {
    assert(apiText.includes("x-zc-r2t-engine"), "engine header missing");
    assert(apiText.includes("x-zc-r2t-fallback"), "fallback header missing");
    return "x-zc-r2t-engine + x-zc-r2t-fallback";
  });
  await runCase("r2t: fallback reasons are logged", () => {
    assert(apiText.includes("R2T_BUILTIN_FALLBACK"), "log marker missing");
    for (const reason of ["module-missing", "module-load-failed", "no-convert-response"]) {
      assert(apiText.includes(reason), "reason missing: " + reason);
    }
    return "module-missing, module-load-failed, no-convert-response";
  });

  // ── Retention (4) ───────────────────────────────────────────
  const now = Date.parse("2026-11-20T12:00:00Z");
  await runCase("retention: old daily log pruned, active kept", () => {
    const dir = tempDir("zc-retention-logs-");
    writeFile(dir, "2020-01-01.log", 10);
    writeFile(dir, "2026-11-20.log", 10);
    writeFile(dir, "zc.jsonl", 10);
    writeFile(dir, "models.db", 10);
    writeFile(dir, "facebook-ads-mcp.log", 10);
    const out = pruneLogs(dir, { now, logDays: 14, logMaxBytes: 10 * 1024 * 1024 });
    assert(out.deleted.includes("2020-01-01.log"), "old log not deleted");
    for (const keep of ["2026-11-20.log", "zc.jsonl", "models.db", "facebook-ads-mcp.log"]) {
      assert(fs.existsSync(path.join(dir, keep)), "protected file deleted: " + keep);
    }
    return "deleted=" + out.deleted.join(",");
  });
  await runCase("retention: backups keep newest two", () => {
    const dir = tempDir("zc-retention-backups-");
    writeFile(dir, "2020-01-01T00-00-00-000Z-a.js", 10);
    writeFile(dir, "2026-11-19T00-00-00-000Z-b.js", 10);
    writeFile(dir, "2026-11-20T00-00-00-000Z-c.js", 10);
    const out = pruneBackups(dir, { now, backupDays: 7, backupMaxFiles: 2 });
    assert(out.deleted.includes("2020-01-01T00-00-00-000Z-a.js"), "oldest backup not deleted");
    assert(fs.existsSync(path.join(dir, "2026-11-19T00-00-00-000Z-b.js")), "recent backup deleted");
    assert(fs.existsSync(path.join(dir, "2026-11-20T00-00-00-000Z-c.js")), "newest backup deleted");
    return "deleted=" + out.deleted.join(",");
  });
  await runCase("retention: dry-run deletes nothing", () => {
    const logs = tempDir("zc-retention-dry-logs-");
    const backups = tempDir("zc-retention-dry-backups-");
    writeFile(logs, "2020-01-01.log", 10);
    writeFile(backups, "2020-01-01T00-00-00-000Z-a.js", 10);
    const out = pruneRetention({
      logsDir: logs,
      backupsDir: backups,
      now,
      dryRun: true,
      logDays: 1,
      backupDays: 1,
    });
    assert(out.deleted === 0, "deleted=" + out.deleted);
    assert(out.candidates >= 2, "candidates=" + out.candidates);
    assert(fs.existsSync(path.join(logs, "2020-01-01.log")), "dry-run removed a log");
    assert(fs.existsSync(path.join(backups, "2020-01-01T00-00-00-000Z-a.js")), "dry-run removed a backup");
    return "candidates=" + out.candidates;
  });
  await runCase("retention: byte cap deletes rotated only", () => {
    const dir = tempDir("zc-retention-bytes-");
    writeFile(dir, "systemd-out.log", 100);
    writeFile(dir, "systemd-out.log.3", 300);
    writeFile(dir, "zc.jsonl.2", 300);
    writeFile(dir, "models.db", 50);
    const out = pruneLogs(dir, { now, logDays: 3650, logMaxBytes: 500 });
    assert(out.deleted.length === 1, "deleted=" + out.deleted.join(","));
    assert(out.bytesAfter <= 500, "bytesAfter=" + out.bytesAfter);
    assert(fs.existsSync(path.join(dir, "systemd-out.log")), "active log deleted");
    assert(fs.existsSync(path.join(dir, "models.db")), "models.db deleted");
    return "deleted=" + out.deleted[0] + " bytes=" + out.bytesAfter;
  });

  // ── Audio brief script (1) ──────────────────────────────────
  await runCase("audio: edge-tts brief check passes", () => {
    const res = spawnSync("python3", [path.join(ROOT, "scripts", "audio-brief.py"), "--check"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
    });
    const out = (res.stdout || "") + (res.stderr || "");
    assert(res.status === 0, "status=" + res.status + " " + out.trim());
    assert(out.includes("AUDIO_BRIEF_CHECK_OK"), "marker missing: " + out.trim());
    const sections = Number((out.match(/sections=(\d+)/) || [])[1] || 0);
    const chars = Number((out.match(/chars=(\d+)/) || [])[1] || 0);
    assert(sections >= 8, "sections=" + sections);
    assert(chars >= 1500, "chars=" + chars);
    assert(out.includes("voice=bn-BD-"), "voice is not bn-BD");
    return "sections=" + sections + " chars=" + chars;
  });

  // ── Live gateway (1) ────────────────────────────────────────
  await runCase("live: /health is 200 with 9 agents", async () => {
    const health = await httpJson(5050, "/health", 5000);
    assert(health.status === 200, "status=" + health.status);
    assert(health.json && health.json.healthy === true, "healthy=" + (health.json && health.json.healthy));
    assert(health.json.agents === 9, "agents=" + health.json.agents);
    return "healthy, agents=" + health.json.agents + ", version=" + health.json.version;
  });

  clearTimeout(guard);

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: 30-case quality eval + retention");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    const tag = status === "PASS" ? "  PASS " : "  FAIL ";
    console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (!fail) console.log("QUALITY_EVAL_OK");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("QUALITY_EVAL_ERROR", err);
  process.exit(1);
});
