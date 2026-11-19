#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: P0-03 single .env loader
//
// Proves the acceptance contract, not a copy of it:
//   1. lib/env.js is the only file that reads .env (loadProcessEnv)
//   2. api.js, start.js, modules/config.js and lib/expand-env.js delegate
//   3. read errors are returned/reported, never swallowed
//   4. parent env wins unless overwrite=true; malformed lines warn
//   5. the loader still feeds loadEnv() validation
//
// Run: node tests/env-loader-check.js
// Exit 0 + ENV_LOADER_OK only when every assertion passes.
// =============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const envModule = require(path.join(ROOT, "lib", "env.js"));

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

// ─── 1. Static: one implementation, four delegating callers ──────────────
const apiSrc = read("api.js");
const startSrc = read("start.js");
const expandSrc = read("lib/expand-env.js");
const configSrc = read("modules/config.js");
const envSrc = read("lib/env.js");

const definitions = (envSrc.match(/function\s+loadProcessEnv\s*\(/g) || []).length;
check("lib/env.js defines loadProcessEnv exactly once", definitions === 1, "definitions=" + definitions);
check("lib/env.js defines parseEnvFile exactly once", (envSrc.match(/function\s+parseEnvFile\s*\(/g) || []).length === 1);

check(
  "api.js delegates to loadProcessEnv",
  /loadProcessEnv/.test(apiSrc) && /require\("\.\/lib\/env\.js"\)/.test(apiSrc),
);
check("api.js has no modules/config.js env loader", !/modules\/config\.js/.test(apiSrc));
check("api.js has no loadEnvFile", !/loadEnvFile/.test(apiSrc));

check("start.js delegates to loadProcessEnv", /loadProcessEnv/.test(startSrc));
check("start.js has no readEnvFile", !/readEnvFile/.test(startSrc));
const startLoadEnv = (startSrc.match(/function loadEnv\(\) \{([\s\S]*?)\n\}/) || [])[1] || "";
check(
  "start.js loadEnv has no swallowed catch",
  startLoadEnv.includes("loadProcessEnv") && !/catch\s*\(/.test(startLoadEnv),
);

check(
  "lib/expand-env.js delegates to loadProcessEnv",
  /loadProcessEnv/.test(expandSrc) && !/readEnvFile/.test(expandSrc),
);

check(
  "modules/config.js has no env file reader",
  !/function\s+loadEnvFile/.test(configSrc) &&
    !/readFileSync/.test(configSrc) &&
    !/function\s+parseEnv\s*\(/.test(configSrc),
);

// Every runtime JS file: only lib/env.js may read an env file. Match the
// actual readFileSync argument (.env / envFile), not a comment mentioning .env.
const runtimeFiles = [
  "api.js",
  "start.js",
  ...fs
    .readdirSync(path.join(ROOT, "lib"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => "lib/" + name),
  ...fs
    .readdirSync(path.join(ROOT, "modules"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => "modules/" + name),
  ...fs
    .readdirSync(path.join(ROOT, "provider"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => "provider/" + name),
];
const privateReaders = runtimeFiles.filter((rel) => {
  const src = rel === "api.js" ? apiSrc : rel === "start.js" ? startSrc : read(rel);
  return /readFileSync\s*\([^)]*(?:\.env|envFile|ENV_FILE)/.test(src);
});
check(
  "only lib/env.js reads .env",
  privateReaders.length === 1 && privateReaders[0] === "lib/env.js",
  privateReaders.join(", ") || "0 files",
);
const loaders = runtimeFiles.filter((rel) => {
  const src = rel === "api.js" ? apiSrc : rel === "start.js" ? startSrc : read(rel);
  return /function\s+loadProcessEnv\s*\(/.test(src);
});
check("only lib/env.js defines loadProcessEnv", loaders.length === 1 && loaders[0] === "lib/env.js");

// ─── 2. Functional: real files, real env objects ─────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zbd-env-"));
const envFile = path.join(tmp, ".env");
const content = [
  "\uFEFF# leading comment",
  "",
  "PORT=5555",
  'QUOTED="hello world"',
  "HASH=value # trailing comment",
  "EXPAND=${PORT}-x",
  "export EXPORTED=yes",
  "ZBD_ENV_TEST_KEY=abc",
  "MALFORMED LINE",
].join("\r\n");
fs.writeFileSync(envFile, content, "utf8");

const warnings = [];
const parsed = envModule.parseEnvFile(content, warnings);
check("parseEnvFile reads 6 keys", Object.keys(parsed).length === 6, "keys=" + Object.keys(parsed).length);
check("quoted value is unquoted", parsed.QUOTED === "hello world", JSON.stringify(parsed.QUOTED));
check("trailing comment is stripped", parsed.HASH === "value", JSON.stringify(parsed.HASH));
check("${VAR} expands from the same file", parsed.EXPAND === "5555-x", JSON.stringify(parsed.EXPAND));
check("export prefix is accepted", parsed.EXPORTED === "yes", JSON.stringify(parsed.EXPORTED));
check("malformed line warns instead of vanishing", warnings.length === 1, warnings.join("; "));

const fresh = {};
const loaded = envModule.loadProcessEnv({ root: tmp, env: fresh });
check("loadProcessEnv loads the file", loaded.loaded === true && loaded.count === 6, "count=" + loaded.count);
check("loadProcessEnv fills the target env", fresh.QUOTED === "hello world" && fresh.PORT === "5555");
check("loadProcessEnv does not touch process.env", process.env.ZBD_ENV_TEST_KEY === undefined);
check("loadProcessEnv reports the malformed line", (loaded.warnings || []).length === 1);

const parent = { PORT: "6000" };
const kept = envModule.loadProcessEnv({ root: tmp, env: parent });
check("parent env wins by default", parent.PORT === "6000" && kept.count === 5, "count=" + kept.count);

const overwritten = { PORT: "6000" };
envModule.loadProcessEnv({ root: tmp, env: overwritten, overwrite: true });
check("overwrite=true prefers the file", overwritten.PORT === "5555", overwritten.PORT);

const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbd-env-empty-"));
const missing = envModule.loadProcessEnv({ root: missingDir, env: {} });
check(
  "missing .env is reported, not thrown",
  missing.loaded === false && missing.missing === true && missing.error === undefined,
);

const unreadable = envModule.loadProcessEnv({ root: tmp, env: {}, envFile: tmp });
check(
  "unreadable .env returns a real error",
  unreadable.loaded === false && typeof unreadable.error === "string" && unreadable.error.length > 0,
  unreadable.error,
);

const disabled = envModule.loadProcessEnv({ envFile: null, env: {} });
check("envFile:null disables loading cleanly", disabled.loaded === false && disabled.missing === true);

const validated = envModule.loadEnv({ root: tmp, env: {}, envFile });
check("loadEnv validation still works through the loader", validated.errors.length === 0, validated.errors.join("; "));
check("loadEnv sees the file PORT", validated.ports.api === 5555, "api=" + validated.ports.api);

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(missingDir, { recursive: true, force: true });

// ─── Summary ─────────────────────────────────────────────────────────────
console.log("");
console.log("checks: " + (pass + fail) + " pass=" + pass + " fail=" + fail);
if (fail > 0) {
  console.error("ENV_LOADER_FAIL");
  for (const item of failures) console.error(" - " + item);
  process.exit(1);
}
console.log("ENV_LOADER_OK");
