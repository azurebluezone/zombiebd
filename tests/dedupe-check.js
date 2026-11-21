#!/usr/bin/env node
"use strict";

/*
 * DEDUPE_OK — proves api.js no longer carries the logic of features that
 * already live in a module.
 *
 *   1. No top-level function in api.js redefines a module/lib export name.
 *   2. No api.js function body is an exact normalized copy of a module body
 *      (length > 250 chars).
 *   3. The 14 audited dead functions are gone, and no zero-reference
 *      top-level function remains.
 *   4. node --check api.js passes.
 *   5. hardening-check and final-guard-check still pass.
 *   6. The live gateway /health answers 200.
 *
 * Run: node tests/dedupe-check.js
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

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

function extractFunctions(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
    );
    if (!match) continue;
    let depth = 0;
    let started = false;
    const body = [];
    for (let j = i; j < lines.length; j++) {
      body.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (started && depth === 0) {
        out.push({
          name: match[1],
          start: i + 1,
          end: j + 1,
          body: body.join("\n"),
        });
        break;
      }
    }
  }
  return out;
}

function normalize(body) {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/["'`][^"'`]*["'`]/g, '"S"')
    .replace(/\s+/g, " ")
    .trim();
}

function countRefs(src, name) {
  const re = new RegExp("\\b" + name.replace(/[$]/g, "\\$&") + "\\b", "g");
  return (src.match(re) || []).length;
}

function moduleExports(src) {
  const names = new Set();
  const block = /module\.exports\s*=\s*\{([\s\S]*?)\}/g;
  let match;
  while ((match = block.exec(src))) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(":")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  const single = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  while ((match = single.exec(src))) names.add(match[1]);
  return names;
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function run(relative) {
  return spawnSync(process.execPath, [path.join(ROOT, relative)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180000,
  });
}

// ── 1. Static scan ─────────────────────────────────────────────
const api = read("api.js");
const apiFunctions = extractFunctions(api);

const moduleFiles = [];
for (const dir of ["modules", "lib"]) {
  for (const file of fs.readdirSync(path.join(ROOT, dir))) {
    if (file.endsWith(".js")) moduleFiles.push(path.join(dir, file));
  }
}

const exportedNames = new Set();
const moduleFunctions = [];
for (const file of moduleFiles) {
  const source = read(file);
  for (const name of moduleExports(source)) exportedNames.add(name);
  for (const fn of extractFunctions(source)) {
    moduleFunctions.push({ ...fn, file });
  }
}

const sameName = apiFunctions.filter((fn) => exportedNames.has(fn.name));
check(
  "no api.js function redefines a module export name",
  sameName.length === 0,
  sameName.map((fn) => fn.name + ":" + fn.start).join(",") || "none",
);

let exactDuplicates = 0;
for (const a of apiFunctions) {
  const aBody = normalize(a.body);
  if (aBody.length <= 250) continue;
  for (const m of moduleFunctions) {
    const mBody = normalize(m.body);
    if (mBody.length <= 250) continue;
    if (aBody !== mBody) continue;
    exactDuplicates++;
    console.log(
      "  duplicate api.js:" +
        a.start +
        " " +
        a.name +
        " == " +
        m.file +
        ":" +
        m.start +
        " " +
        m.name,
    );
  }
}
check(
  "no api.js function body is an exact copy of a module body",
  exactDuplicates === 0,
  "pairs=" + exactDuplicates,
);

const dead = apiFunctions.filter((fn) => countRefs(api, fn.name) <= 1);
check(
  "no zero-reference top-level function remains",
  dead.length === 0,
  dead.map((fn) => fn.name + ":" + fn.start).join(",") || "none",
);

const auditedDead = [
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
const stillThere = auditedDead.filter((name) =>
  new RegExp("\\b" + name + "\\b").test(api),
);
check(
  "the 14 audited dead functions are gone",
  stillThere.length === 0,
  stillThere.join(",") || "none",
);

const antiDoteCalls = (api.match(/antiDoteMonitor\(/g) || []).length;
check(
  "antiDoteMonitor is imported, aliased and called (4 sites)",
  /require\(\s*["']\.\/modules\/anti-dote\.js["']\s*\)/.test(api) &&
    /const\s+antiDoteMonitor\s*=\s*antiDoteModule\.antiDoteMonitor\s*;/.test(api) &&
    antiDoteCalls === 4,
  "calls=" + antiDoteCalls,
);

const staticAdminPath = path.join(ROOT, "public", "admin.html");
const staticAdmin = fs.existsSync(staticAdminPath)
  ? fs.readFileSync(staticAdminPath, "utf8")
  : "";
check(
  "public/admin.html is optional and API-only",
  !staticAdmin ||
    (staticAdmin.includes('id="adminTokenInput"') &&
      !/\bAuthorization\b|\bBearer\b|x-api-key/i.test(staticAdmin) &&
      !/fetch\(\s*["'`]https?:/i.test(staticAdmin)),
);
check(
  "lib/admin-panel.js owns the fallback panel",
  /PANEL_MARKER/.test(read("lib/admin-panel.js")) &&
    /renderAdminPanel\s*\(/.test(api),
);

console.log(
  "api.js lines=" +
    (api.endsWith("\n") ? api.split("\n").length - 1 : api.split("\n").length),
);

// ── 2. Syntax + existing proofs ────────────────────────────────
const syntax = spawnSync(process.execPath, ["--check", path.join(ROOT, "api.js")], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 60000,
});
check("node --check api.js passes", syntax.status === 0, "exit=" + syntax.status);

const hardening = run("tests/hardening-check.js");
check(
  "hardening-check still reports HARDENING_OK",
  hardening.status === 0 && /HARDENING_OK/.test(hardening.stdout || ""),
  "exit=" + hardening.status,
);

const finalGuard = run("tests/final-guard-check.js");
check(
  "final-guard-check still reports FINAL_GUARD_OK",
  finalGuard.status === 0 && /FINAL_GUARD_OK/.test(finalGuard.stdout || ""),
  "exit=" + finalGuard.status,
);

// ── 3. Live health ─────────────────────────────────────────────
function liveHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 5050, path: "/health", method: "GET" },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let healthy = false;
          try {
            healthy = JSON.parse(text).healthy === true;
          } catch (_) {}
          resolve({ status: res.statusCode || 0, healthy });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, healthy: false }));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ status: 0, healthy: false });
    });
    req.end();
  });
}

liveHealth().then((health) => {
  check(
    "live gateway /health answers 200",
    health.status === 200 && health.healthy,
    "status=" + health.status,
  );
  console.log(
    "\nRESULT: " +
      (fail === 0 ? "DEDUPE_OK" : "DEDUPE_FAIL") +
      " pass=" +
      pass +
      " fail=" +
      fail,
  );
  process.exitCode = fail === 0 ? 0 : 1;
});
