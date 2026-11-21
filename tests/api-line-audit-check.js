#!/usr/bin/env node
"use strict";

/*
 * API_LINE_AUDIT_OK — reproducible accounting for api.js.
 *
 * Answers three questions with files and git, not memory:
 *   1. Did api.js grow during this session, or was it already ~20k?
 *   2. Are the modules imported, or are their functions copied into api.js?
 *   3. Which top-level functions are never referenced, and how many lines?
 *
 * Run: node tests/api-line-audit-check.js
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function countLines(text) {
  if (text === "") return 0;
  const parts = text.split("\n");
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function read(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), "utf8");
  } catch (_) {
    return "";
  }
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

// ── 1. Line count, HEAD vs now ──────────────────────────────────
const api = read("api.js");
const apiLines = api.split("\n");
const apiNow = countLines(api);
const headApi = git(["show", "HEAD:api.js"]);
const apiHead = countLines(headApi);
const numstat = git(["diff", "--numstat", "HEAD", "--", "api.js"]).trim().split(/\s+/);
const added = Number(numstat[0]);
const deleted = Number(numstat[1]);
const delta = apiNow - apiHead;

console.log("api.js now   = " + apiNow);
console.log("api.js HEAD  = " + apiHead);
console.log("delta        = " + (delta > 0 ? "+" : "") + delta);
console.log("diff         = +" + added + " / -" + deleted);

check("api.js did not grow against HEAD", delta < 0, "delta=" + delta);
check(
  "this session's diff is net negative",
  deleted > added,
  "added=" + added + " deleted=" + deleted,
);

// The 19k -> 20k crossing happened before this session's contracts.
const crossing = [
  { hash: "eb9446a", label: "chat attachments" },
  { hash: "c611272", label: "working directories" },
];
for (const item of crossing) {
  let lines = 0;
  try {
    lines = countLines(git(["show", item.hash + ":api.js"]));
  } catch (_) {}
  console.log("crossing " + item.hash + " = " + lines + " (" + item.label + ")");
}

// ── 2. Modules are imported, not converted ─────────────────────
const antiDote = read("modules/anti-dote.js");
const adminPanel = read("lib/admin-panel.js");

check(
  "modules/anti-dote.js exists",
  exists("modules/anti-dote.js") && antiDote.length > 0,
);
check(
  "api.js requires modules/anti-dote.js",
  /require\(\s*["']\.\/modules\/anti-dote\.js["']\s*\)/.test(api),
);
check(
  "api.js only aliases antiDoteMonitor",
  /const\s+antiDoteMonitor\s*=\s*antiDoteModule\.antiDoteMonitor\s*;/.test(api),
);
check(
  "api.js does not define antiDoteMonitor",
  !/(?:async\s+)?function\s+antiDoteMonitor\s*\(/.test(api),
);
const monitorCalls = (api.match(/antiDoteMonitor\(/g) || []).length;
check(
  "antiDoteMonitor has 4 live call sites",
  monitorCalls === 4,
  "calls=" + monitorCalls,
);
check(
  "modules/anti-dote.js exports only the monitor",
  /module\.exports\s*=\s*\{\s*antiDoteMonitor\s*\}/.test(antiDote) &&
    !/wrapWithAntiDote\s*\(/.test(antiDote),
);

const staticAdmin = read("public/admin.html");
check(
  "public/admin.html is optional and API-only",
  !exists("public/admin.html") ||
    (staticAdmin.includes('id="adminTokenInput"') &&
      !/\bAuthorization\b|\bBearer\b|x-api-key/i.test(staticAdmin) &&
      !/fetch\(\s*["'`]https?:/i.test(staticAdmin)),
);
check(
  "lib/admin-panel.js owns the fallback document",
  /PANEL_MARKER/.test(adminPanel) && /renderAdminPanel/.test(adminPanel),
);
check(
  "api.js resolves the optional page with a module fallback",
  /function\s+loadAdminPage\s*\(/.test(api) &&
    /renderAdminPanel\s*\(/.test(api),
);

// ── 3. Zero-reference top-level functions ──────────────────────
const defs = [];
for (let i = 0; i < apiLines.length; i++) {
  const line = apiLines[i];
  let match = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (match) {
    defs.push({ name: match[1], start: i + 1, kind: "function" });
    continue;
  }
  match = line.match(
    /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  );
  if (match) defs.push({ name: match[1], start: i + 1, kind: "const" });
}

for (const def of defs) {
  const re = new RegExp("\\b" + def.name.replace(/[$]/g, "\\$&") + "\\b", "g");
  def.refs = (api.match(re) || []).length;
  let end = def.start;
  const closer = def.kind === "const" ? /^};/ : /^}/;
  for (let i = def.start; i < apiLines.length; i++) {
    if (closer.test(apiLines[i])) {
      end = i + 1;
      break;
    }
  }
  def.end = end;
  def.lines = end - def.start + 1;
}

const dead = defs.filter((def) => def.refs <= 1);
const deadLines = dead.reduce((sum, def) => sum + def.lines, 0);
const expected = [
  "findModelInDb",
  "buildToolsDescription",
  "restoreRecentContext",
  "queryLockLogs",
  "cacheUserPattern",
  "cacheLearnCorrection",
  "cacheGetCorrections",
  "cacheQuickResponse",
  "maskProviderName",
  "isSimpleQuestion",
  "buildSSOTExcerpt",
  "buildSyllabusExcerpt",
  "checkReadiness",
  "getUnhealthyProviders",
];

console.log("\nZero-reference top-level functions (" + dead.length + ", " + deadLines + " lines):");
for (const def of dead) {
  console.log(
    "  " +
      def.name +
      " api.js:" +
      def.start +
      "-" +
      def.end +
      " lines=" +
      def.lines,
  );
}

const remaining = expected.filter((name) =>
  new RegExp("\\b" + name + "\\b").test(api),
);
check(
  "the 14 audited dead functions are gone",
  remaining.length === 0,
  "remaining=" + (remaining.join(",") || "none"),
);
check(
  "no zero-reference top-level functions remain",
  dead.length === 0,
  "found=" + dead.length,
);

// ── 4. Live gateway still answers ──────────────────────────────
async function liveCheck() {
  const http = require("node:http");
  const body = await new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 5050, path: "/health", method: "GET" },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: error.message }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ status: 0, text: "timeout" });
    });
    req.end();
  });
  let healthy = false;
  try {
    healthy = JSON.parse(body.text).healthy === true;
  } catch (_) {}
  check(
    "live gateway /health answers 200",
    body.status === 200 && healthy,
    "status=" + body.status,
  );
}

liveCheck().then(() => {
  console.log(
    "\nRESULT: " +
      (fail === 0 ? "API_LINE_AUDIT_OK" : "API_LINE_AUDIT_FAIL") +
      " pass=" +
      pass +
      " fail=" +
      fail,
  );
  process.exitCode = fail === 0 ? 0 : 1;
});
