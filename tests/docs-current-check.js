#!/usr/bin/env node
"use strict";

// =============================================================================
// TEST: docs freshness gate (runbook N3)
// =============================================================================
// The runbook is the single source of truth; the PLAN is its snapshot and the
// syllabus holds the PASS records. This gate fails when those three drift
// apart, when the PLAN still carries a stale claim, or when the live gateway
// no longer matches the snapshot.
//
// Run: node tests/docs-current-check.js
// Exit 0 + DOCS_CURRENT_OK only when every check passes.
// =============================================================================

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const RUNBOOK = "docs/RUNBOOK-OPTIMIZATION-2026-11-19.md";
const PLAN = "docs/PLAN-2026-11-20.md";
const STATUS_SNAPSHOT = "tmp/refactor-2026-11-20/runbook-status.md";

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

function sha256(rel) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");
}

function httpJson(pathname, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: 5050, path: pathname, timeout: timeoutMs || 5000 },
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

// Runbook status rows: | 1 | **P0-08** | ... | `GATE` | ✅ DONE (`gc-...`) |
function runbookRows(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 5) continue;
    out.push({
      num: Number(cells[0]),
      item: cells[1].replace(/\*\*/g, ""),
      gate: (cells[3].match(/`([A-Z0-9_]+)`/) || [])[1] || "",
      state: cells[4],
      contract: (cells[4].match(/`(gc-[a-z0-9]+)`/) || [])[1] || "",
      done: /✅\s*DONE/.test(cells[4]),
    });
  }
  return out;
}

(async () => {
  const runbook = read(RUNBOOK);
  const plan = read(PLAN);
  const syllabus = read(".zombiecoder/syllabus.md");
  const pkg = JSON.parse(read("package.json"));
  const identity = JSON.parse(read("identity.json"));

  // Only the ordered backlog table defines completion; other numeric tables
  // in the runbook are findings, not status.
  const backlogStart = runbook.indexOf("### 10.3 Ordered backlog");
  const backlogEnd = runbook.indexOf("### 10.4", backlogStart);
  assert(backlogStart > 0 && backlogEnd > backlogStart, "runbook backlog section not found");
  const table = runbookRows(runbook.slice(backlogStart, backlogEnd));
  const doneRows = table.filter((row) => row.done);
  const passIds = new Set(
    [...syllabus.matchAll(/### Goal Contract (gc-[a-z0-9]+) — result\s*\n+\s*- status: PASS/g)].map(
      (match) => match[1],
    ),
  );

  // ── Version agreement ───────────────────────────────────────
  await check("version: package, identity and PLAN agree", () => {
    assert(pkg.version === identity.system_identity.version, "package=" + pkg.version + " identity=" + identity.system_identity.version);
    const planVersion = (plan.match(/\*\*Version:\*\*\s*`?([0-9]+\.[0-9]+\.[0-9]+)`?/) || [])[1];
    assert(planVersion === pkg.version, "PLAN=" + planVersion + " package=" + pkg.version);
    return pkg.version;
  });

  // ── Runbook rows vs syllabus PASS records ───────────────────
  await check("runbook: at least 9 rows are DONE with a contract", () => {
    assert(doneRows.length >= 9, "done rows=" + doneRows.length);
    const numbers = doneRows.map((row) => row.num);
    assert(numbers.includes(1) && numbers.includes(9), "rows 1-9 not complete: " + numbers.join(","));
    for (const row of doneRows) {
      assert(row.contract, "row " + row.num + " has no contract id");
      assert(row.gate, "row " + row.num + " has no gate marker");
    }
    return "done=" + doneRows.length + " contracts=" + doneRows.map((row) => row.contract).join(",");
  });

  await check("runbook: every DONE row has PASS or Done evidence", () => {
    const doneBlockIds = new Set(
      [...runbook.matchAll(/\*\*Done \([^)]*`(gc-[a-z0-9]+)`\)/g)].map((match) => match[1]),
    );
    const missing = doneRows.filter(
      (row) => !passIds.has(row.contract) && !doneBlockIds.has(row.contract),
    );
    assert(
      missing.length === 0,
      "no PASS and no Done block: " + missing.map((row) => row.contract).join(","),
    );
    const fromSyllabus = doneRows.filter((row) => passIds.has(row.contract)).length;
    assert(fromSyllabus >= 4, "syllabus PASS records for DONE rows=" + fromSyllabus);
    return "syllabus=" + fromSyllabus + " runbook=" + (doneRows.length - fromSyllabus);
  });

  // ── PLAN snapshot ───────────────────────────────────────────
  await check("PLAN: all completed gates are listed", () => {
    const required = doneRows.map((row) => row.gate);
    assert(required.includes("DOCS_CURRENT_OK"), "DOCS_CURRENT_OK missing from runbook");
    const missing = required.filter((gate) => !plan.includes("`" + gate + "`"));
    assert(missing.length === 0, "PLAN missing gates: " + missing.join(","));
    return required.length + " gates";
  });

  await check("PLAN: next TODO row matches the runbook", () => {
    const next = table.find((row) => !row.done);
    assert(next, "runbook has no TODO row left");
    assert(plan.includes(next.gate), "PLAN does not mention " + next.gate);
    const planRow =
      plan
        .split(/\r?\n/)
        .find((line) => new RegExp("^\\|\\s*" + next.num + "\\s*\\|").test(line)) || "";
    assert(planRow.includes(next.gate), "PLAN row " + next.num + " missing gate " + next.gate);
    assert(/TODO/.test(planRow), "PLAN row " + next.num + " is not TODO: " + planRow.trim());
    return "row " + next.num + " = " + next.gate;
  });

  await check("PLAN: row 10 contract matches the runbook", () => {
    const row10 = table.find((row) => row.num === 10);
    assert(row10 && row10.done, "runbook row 10 is not DONE");
    assert(row10.gate === "DOCS_CURRENT_OK", "row 10 gate=" + row10.gate);
    assert(row10.contract, "row 10 has no contract id");
    assert(plan.includes(row10.contract), "PLAN does not name contract " + row10.contract);
    return row10.contract;
  });

  await check("PLAN: no stale claims survive", () => {
    const stale = ["কাজ শুরু হয়নি", "96 models", "pid 827", "PLAN_EVIDENCE_COMPLETE", "b805f65", "b871dfd"];
    const found = stale.filter((needle) => plan.includes(needle));
    assert(found.length === 0, "stale: " + found.join(", "));
    return "no stale marker";
  });

  await check("PLAN: snapshot commit is an ancestor of HEAD", () => {
    const snapshot = (plan.match(/\*\*Snapshot commit:\*\*\s*`?([0-9a-f]{7,40})`?/) || [])[1];
    assert(snapshot, "PLAN has no snapshot commit");
    const res = spawnSync("git", ["merge-base", "--is-ancestor", snapshot, "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert(res.status === 0, "snapshot " + snapshot + " is not an ancestor of HEAD");
    return snapshot;
  });

  await check("PLAN: every referenced project path exists", () => {
    const paths = new Set(
      [...plan.matchAll(/`((?:docs|tests|scripts|modules|lib|provider)\/[A-Za-z0-9._/-]+)`/g)].map(
        (match) => match[1],
      ),
    );
    const missing = [...paths].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    assert(missing.length === 0, "missing: " + missing.join(","));
    return paths.size + " paths";
  });

  await check("PLAN: no duplicate status snapshot remains", () => {
    assert(!fs.existsSync(path.join(ROOT, STATUS_SNAPSHOT)), "stale duplicate table exists: " + STATUS_SNAPSHOT);
    return "retired " + STATUS_SNAPSHOT;
  });

  await check("git: docs slice is committed and pushed", () => {
    const dirty = spawnSync(
      "git",
      ["status", "--porcelain", "--", PLAN, RUNBOOK, "tests/docs-current-check.js"],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert(dirty.status === 0, "git status failed");
    assert(dirty.stdout.trim() === "", "uncommitted: " + dirty.stdout.trim());
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    const remote = spawnSync("git", ["rev-parse", "origin/main"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    assert(head === remote, "HEAD " + head.slice(0, 7) + " != origin/main " + remote.slice(0, 7));
    return head.slice(0, 7);
  });

  // ── Live snapshot ───────────────────────────────────────────
  await check("live: /health version matches the docs", async () => {
    const health = await httpJson("/health", 5000);
    assert(health.status === 200, "status=" + health.status);
    assert(health.json && health.json.healthy === true, "healthy=" + (health.json && health.json.healthy));
    assert(health.json.version === pkg.version, "live=" + health.json.version + " package=" + pkg.version);
    return "version=" + health.json.version;
  });

  await check("live: PLAN model count matches /health", async () => {
    const recorded = Number((plan.match(/\|\s*Live models\s*\|\s*`(\d+)`/) || [])[1] || 0);
    assert(recorded > 0, "PLAN has no live model count");
    const health = await httpJson("/health", 5000);
    assert(health.json.models === recorded, "live=" + health.json.models + " PLAN=" + recorded + " (update the snapshot)");
    return String(recorded);
  });

  await check("dist: built api.js equals source api.js", () => {
    const source = sha256("api.js");
    const dist = sha256("dist/api.js");
    assert(source === dist, "source=" + source.slice(0, 12) + " dist=" + dist.slice(0, 12));
    return source.slice(0, 12);
  });

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  TEST: docs freshness gate (N3)");
  console.log("══════════════════════════════════════════════════════════");
  for (const [status, name, detail] of rows) {
    console.log((status === "PASS" ? "  PASS " : "  FAIL ") + name + (detail ? "   [" + detail + "]" : ""));
  }
  console.log("────────────────────────────────────────────────────────────");
  console.log("  RESULT: " + pass + " passed, " + fail + " failed");
  if (!fail) console.log("DOCS_CURRENT_OK");
  console.log("══════════════════════════════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("DOCS_CURRENT_ERROR", err);
  process.exit(1);
});
