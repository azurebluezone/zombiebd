#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: local skill library + MCP stdio surface (runbook N6)
// =============================================================================
// Proves the shipped architecture, not the experiment project:
//   • skills/skills.db is the imported SQLite data (256 active skills);
//   • the Markdown body parser renders the same card for CLI and MCP;
//   • the CLI works from a different working directory;
//   • external-mcp.js spawns the local Node server over stdio and answers
//     initialize / tools/list / tools/call;
//   • no runtime file references the experiment project;
//   • the database is read-only (hash and file set unchanged).
//
// Run: node tests/skill-mcp-check.js
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "skills", "skills.db");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const rows = [];
let pass = 0;
let fail = 0;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } catch (err) {
    fail += 1;
    rows.push(["FAIL", name, String((err && err.message) || err)]);
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", "skill.js"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20000,
  });
}

(async () => {
  const guard = setTimeout(() => {
    console.error("SKILL_MCP_TIMEOUT");
    process.exit(1);
  }, 60000);

  const { openStore } = require(path.join(ROOT, "modules", "skill-db.js"));
  const { compactCard } = require(path.join(ROOT, "modules", "skill-parser.js"));
  const store = openStore(DB);

  await check("database: local SQLite data is present", () => {
    assert(fs.existsSync(DB), "missing " + DB);
    const stats = store.stats();
    assert(stats.active === 256, "active=" + stats.active);
    assert(stats.terms > 1000, "terms=" + stats.terms);
    return "active=" + stats.active + " terms=" + stats.terms;
  });

  await check("database: file is not git-ignored", () => {
    const res = spawnSync("git", ["check-ignore", "skills/skills.db"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert(res.status === 1, "skills/skills.db is ignored (add !skills/skills.db)");
    return "tracked candidate";
  });

  await check("parser: Markdown body becomes a card", () => {
    const skill = store.get("cdp-operations");
    assert(skill, "cdp-operations missing");
    const card = compactCard(skill, 1200);
    assert(card.startsWith("SKILL: cdp-operations"), "card header missing");
    assert(card.includes("WHEN:"), "WHEN missing");
    assert(card.includes("STEPS:"), "STEPS missing");
    assert(!/api[_-]?key\s*[:=]\s*[^\[\s]/i.test(card), "secret-looking assignment leaked");
    return "card=" + card.length + " chars";
  });

  await check("route: cdp and sqlite resolve locally", () => {
    const cdp = store.route("cdp", 3, 3.0).map((match) => match.slug);
    const sqlite = store.route("sqlite", 3, 3.0).map((match) => match.slug);
    assert(cdp.includes("cdp-operations"), "cdp=" + cdp.join(","));
    assert(sqlite.includes("sqlite-operations"), "sqlite=" + sqlite.join(","));
    return cdp[0] + "," + sqlite[0];
  });

  await check("cli: works from another working directory", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "zc-skill-cli-"));
    const route = runCli(cwd, ["route", "cdp"]);
    assert(route.status === 0, "route exit=" + route.status + " " + route.stderr);
    assert(route.stdout.includes("cdp-operations"), "route output missing cdp-operations");
    const get = runCli(cwd, ["get", "cdp-operations"]);
    assert(get.status === 0, "get exit=" + get.status + " " + get.stderr);
    assert(get.stdout.startsWith("SKILL: cdp-operations"), "get card header missing");
    return "cwd=" + cwd;
  });

  await check("cli: doctor passes", () => {
    const doctor = runCli(ROOT, ["doctor"]);
    assert(doctor.status === 0, "doctor exit=" + doctor.status + " " + doctor.stderr);
    assert(doctor.stdout.includes("SKILLS_DOCTOR_OK"), "doctor marker missing");
    return "SKILLS_DOCTOR_OK";
  });

  await check("runtime: no experiment-project reference", () => {
    const files = [
      "external-mcp.js",
      "external mcp/servers.json",
      "external mcp/servers.example.json",
      "external mcp/skill-mcp.js",
      "modules/skill-db.js",
      "modules/skill-parser.js",
      "scripts/skill.js",
    ];
    const hits = files.filter((rel) => read(rel).includes("/home/sahon/Documents/GGUF"));
    assert(hits.length === 0, "reference path in: " + hits.join(","));
    return files.length + " runtime files clean";
  });

  const before = sha256File(DB);
  const beforeFiles = fs.readdirSync(path.join(ROOT, "skills")).sort();

  // Isolate the loader: one temp config, no HTTP URLs from the live .env.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zc-skill-mcp-"));
  const configPath = path.join(tmpDir, "servers.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        servers: [
          {
            name: "skills",
            transport: "stdio",
            enabled: true,
            autoConnect: true,
            local: true,
            script: "external mcp/skill-mcp.js",
          },
        ],
      },
      null,
      2,
    ),
  );
  process.env.EXTERNAL_MCP_CONFIG = configPath;
  process.env.EXTERNAL_MCP_URLS = "";
  const external = require(path.join(ROOT, "external-mcp.js"));

  const results = await external.loadAll();
  const skills = results.find((result) => result.name === "skills");
  let searchSlug = "";
  let cardSlug = "";

  await check("mcp: loadAll lists exactly two skill tools", () => {
    assert(skills, "skills result missing");
    assert(!skills.error, "connect error: " + skills.error);
    assert(skills.success === true, "success=" + skills.success);
    assert(skills.tools === 2, "tools=" + skills.tools);
    const status = external.getStatus().find((row) => row.name === "skills");
    assert(status && status.status === "connected", "status=" + (status && status.status));
    assert(status.tools === 2, "status tools=" + status.tools);
    const names = external
      .getAllTools()
      .map((tool) => tool.fullName)
      .filter((name) => name.startsWith("skills__"))
      .sort();
    assert(
      JSON.stringify(names) === JSON.stringify(["skills__get_skill", "skills__search_skills"]),
      "tools=" + names.join(","),
    );
    return names.join(",");
  });

  await check("mcp: search_skills('cdp') returns cdp-operations", async () => {
    const result = await external.call("skills", "search_skills", { query: "cdp", limit: 3 });
    const text = (result.content || []).map((part) => part.text || "").join("");
    const payload = JSON.parse(text);
    const slugs = (payload.matches || []).map((match) => match.slug);
    assert(slugs.includes("cdp-operations"), "matches=" + slugs.join(","));
    searchSlug = "cdp-operations";
    return slugs.join(",");
  });

  await check("mcp: get_skill('cdp-operations') returns its card", async () => {
    const result = await external.call("skills", "get_skill", {
      slug: "cdp-operations",
      mode: "card",
    });
    const text = (result.content || []).map((part) => part.text || "").join("");
    const payload = JSON.parse(text);
    assert(payload.slug === "cdp-operations", "slug=" + payload.slug);
    assert(payload.mode === "card", "mode=" + payload.mode);
    assert(String(payload.card || "").startsWith("SKILL: cdp-operations"), "card header missing");
    cardSlug = payload.slug;
    return payload.slug + "/" + payload.mode;
  });

  const after = sha256File(DB);
  const afterFiles = fs.readdirSync(path.join(ROOT, "skills")).sort();

  await check("read-only: database hash and file set unchanged", () => {
    assert(before === after, "database changed: " + before.slice(0, 12) + " -> " + after.slice(0, 12));
    assert(
      JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
      "file set changed: " + beforeFiles.join(",") + " -> " + afterFiles.join(","),
    );
    return before.slice(0, 12) + " files=" + afterFiles.length;
  });

  store.close();
  clearTimeout(guard);
  printRows();
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (!fail) {
    console.log(
      "SKILL_MCP_OK local=1 active=256 tools=2 search=" +
        searchSlug +
        " card=" +
        cardSlug +
        " readonly=1",
    );
  }
  console.log("══════════════════════════════════════════════════════════\n");

  // The module's exit hook kills the stdio child.
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("SKILL_MCP_ERROR", err);
  process.exit(1);
});

function printRows() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: local skill library + MCP stdio (N6)");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    console.log((status === "PASS" ? "  PASS " : "  FAIL ") + name + (detail ? "   [" + detail + "]" : ""));
  }
}
