#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: P0-04 — one runtime path resolver
//
// Proves the acceptance contract:
//   1. lib/env.js owns the resolver (resolveRuntimePaths/assertPathInside)
//   2. api.js, start.js, local-llm-bridge.js and the MCP tools delegate
//   3. no production os.homedir() or private DATA_DIR/LOG_DIR/DB join remains
//   4. defaults are APP_ROOT/data, APP_ROOT/logs, data/models.db, data/tts,
//      data/recordings, data/mcp-output
//   5. relative values resolve against APP_ROOT, absolute values stay put
//   6. assertPathInside rejects an escape
//   7. loadEnv().paths and the api.js PATH_RESOLVED boot log use the same map
//
// Run: node tests/path-resolver-check.js
// Exit 0 + PATH_RESOLVER_OK only when every assertion passes.
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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── 1. Static: resolver exports and delegating callers ─────────────────
const envSrc = read("lib/env.js");
const apiSrc = read("api.js");
const startSrc = read("start.js");
const bridgeSrc = read("local-llm-bridge.js");
const ttsSrc = read("external mcp/tts-mcp.js");
const screenSrc = read("external mcp/screen-recorder-mcp.js");
const secretSrc = read("lib/secret-store.js");

const exportsBlock = envSrc.slice(envSrc.indexOf("module.exports"));
for (const name of [
  "resolveRuntimePaths",
  "assertPathInside",
  "userHomeDir",
  "expandHome",
]) {
  check(
    "lib/env.js exports " + name,
    new RegExp("\\b" + name + "\\b").test(exportsBlock),
  );
}

check(
  "api.js delegates to resolveRuntimePaths",
  /resolveRuntimePaths\(process\.env\)/.test(apiSrc),
);
check(
  "api.js logs PATH_RESOLVED for the resolved map",
  /PATH_RESOLVED name=/.test(apiSrc) &&
    /DB_SQLITE_PATH: RUNTIME_PATHS\.dbPath/.test(apiSrc),
);
check("api.js has no os.homedir()", !/os\.homedir\(\)/.test(apiSrc));
check(
  "api.js has no private DATA_DIR/LOG_DIR/CACHE_DIR join",
  !/process\.env\.(?:DATA_DIR|LOG_DIR|CACHE_DIR)/.test(apiSrc) &&
    !/path\.join\(DATA_DIR,\s*"models\.db"\)/.test(apiSrc),
);
check(
  "api.js takes the DB path from the resolver",
  /const MODELS_DB_PATH = RUNTIME_PATHS\.dbPath/.test(apiSrc),
);

check("start.js has no os.homedir()", !/os\.homedir\(\)/.test(startSrc));
check(
  "start.js data/db/config come from the resolver",
  /function projectDataDir\(\) \{\s*return resolveRuntimePaths\(process\.env\)\.dataDir;/.test(
    startSrc,
  ) &&
    /function projectDbPath\(\) \{\s*return resolveRuntimePaths\(process\.env\)\.dbPath;/.test(
      startSrc,
    ) &&
    /function configDir\(\) \{\s*return resolveRuntimePaths\(process\.env\)\.configDir;/.test(
      startSrc,
    ),
);
check(
  "start.js has no private DATA_DIR join",
  !/path\.resolve\(__dirname,\s*process\.env\.DATA_DIR/.test(startSrc),
);

check(
  "local-llm-bridge.js has no os.homedir()",
  !/os\.homedir\(\)/.test(bridgeSrc),
);
check(
  "local-llm-bridge.js uses userHomeDir()",
  /userHomeDir\(\)/.test(bridgeSrc) && /require\(["']\.\/lib\/env["']\)/.test(bridgeSrc),
);

check("tts MCP has no os.homedir()", !/os\.homedir\(\)/.test(ttsSrc));
check(
  "tts MCP default is resolver.ttsOutputDir",
  /resolveRuntimePaths\(process\.env\)\.ttsOutputDir/.test(ttsSrc),
);
check("screen MCP has no os.homedir()", !/os\.homedir\(\)/.test(screenSrc));
check(
  "screen MCP default is resolver.screenDir",
  /resolveRuntimePaths\(process\.env\)\.screenDir/.test(screenSrc),
);
check(
  "secret-store has no cwd-relative DB default",
  /resolveRuntimePaths\(process\.env\)\.dbPath/.test(secretSrc) &&
    !/process\.env\.DB_SQLITE_PATH\s*\?/.test(secretSrc),
);

const providerFiles = fs
  .readdirSync(path.join(ROOT, "provider"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => "provider/" + name);
const homedirOffenders = ["api.js", "start.js", "local-llm-bridge.js", ...providerFiles,
  "external mcp/tts-mcp.js", "external mcp/screen-recorder-mcp.js"].filter((rel) =>
  /os\.homedir\(\)/.test(read(rel)),
);
check(
  "no production os.homedir() in the T3 target list",
  homedirOffenders.length === 0,
  homedirOffenders.join(", ") || "0 files",
);

// ─── 2. Default map ─────────────────────────────────────────────────────
const rootA = tempDir("zbd-paths-a-");
const defaults = envModule.resolveRuntimePaths({}, { appRoot: rootA });
check("appRoot follows the caller tree", defaults.appRoot === rootA, defaults.appRoot);
check("dataDir default", defaults.dataDir === path.join(rootA, "data"));
check("logDir default", defaults.logDir === path.join(rootA, "logs"));
check("cacheDir default", defaults.cacheDir === path.join(rootA, "cache"));
check(
  "dbPath default is data/models.db",
  defaults.dbPath === path.join(rootA, "data", "models.db"),
);
check(
  "mcp/tts/screen defaults live under data",
  defaults.mcpOutputDir === path.join(rootA, "data", "mcp-output") &&
    defaults.ttsOutputDir === path.join(rootA, "data", "tts") &&
    defaults.screenDir === path.join(rootA, "data", "recordings"),
);
check(
  "tmpDir uses the OS temp root",
  defaults.tmpDir === path.join(os.tmpdir(), "zombiecoder"),
  defaults.tmpDir,
);
check(
  "configDir stays in the user home",
  defaults.configDir === path.join(os.homedir(), ".zombiecoder"),
  defaults.configDir,
);

// ─── 3. Overrides: relative → APP_ROOT, absolute stays ─────────────────
const custom = envModule.resolveRuntimePaths(
  {
    DATA_DIR: "var/data",
    LOG_DIR: "/abs/logs",
    CACHE_DIR: "cache2",
    TMP_DIR: "tmp2",
    DB_SQLITE_PATH: "db/custom.db",
    TTS_OUTPUT_DIR: "tts-out",
    SCREEN_RECORDINGS_DIR: "/abs/recordings",
    MCP_OUTPUT_DIR: "mcp-out",
    ZOMBIECODER_CONFIG_DIR: "cfg",
  },
  { appRoot: rootA },
);
check("relative DATA_DIR resolves against APP_ROOT", custom.dataDir === path.join(rootA, "var", "data"));
check("absolute LOG_DIR stays absolute", custom.logDir === path.normalize("/abs/logs"));
check("relative CACHE_DIR resolves against APP_ROOT", custom.cacheDir === path.join(rootA, "cache2"));
check("relative TMP_DIR resolves against APP_ROOT", custom.tmpDir === path.join(rootA, "tmp2"));
check("relative DB_SQLITE_PATH resolves against APP_ROOT", custom.dbPath === path.join(rootA, "db", "custom.db"));
check("relative TTS_OUTPUT_DIR resolves against APP_ROOT", custom.ttsOutputDir === path.join(rootA, "tts-out"));
check("absolute SCREEN_RECORDINGS_DIR stays absolute", custom.screenDir === path.normalize("/abs/recordings"));
check("relative MCP_OUTPUT_DIR resolves against APP_ROOT", custom.mcpOutputDir === path.join(rootA, "mcp-out"));
check("relative config dir resolves against APP_ROOT", custom.configDir === path.join(rootA, "cfg"));

const rootB = tempDir("zbd-paths-b-");
const appRootEnv = envModule.resolveRuntimePaths({ APP_ROOT: rootB }, { appRoot: rootA });
check("env APP_ROOT wins over the default", appRootEnv.appRoot === rootB, appRootEnv.appRoot);
check(
  "env APP_ROOT moves data with it",
  appRootEnv.dataDir === path.join(rootB, "data"),
  appRootEnv.dataDir,
);

check("expandHome('~') is the home dir", envModule.expandHome("~") === os.homedir());
check(
  "expandHome('~/x') is an absolute home path",
  envModule.expandHome("~/x") === path.join(os.homedir(), "x"),
);
check("expandHome leaves plain values alone", envModule.expandHome("plain") === "plain");
const tilde = envModule.resolveRuntimePaths({ DATA_DIR: "~/zbd-data" }, { appRoot: rootA });
check(
  "~ in a runtime path expands instead of landing under APP_ROOT",
  tilde.dataDir === path.join(os.homedir(), "zbd-data"),
  tilde.dataDir,
);

// ─── 4. Containment guard ──────────────────────────────────────────────
let insideOk = false;
let insideErr = "";
try {
  insideOk = envModule.assertPathInside(rootA, path.join(rootA, "data", "x"));
  envModule.assertPathInside(rootA, rootA);
  envModule.assertPathInside(rootA, path.join(rootA, "..", "escape"));
} catch (error) {
  insideErr = error.code || error.message;
}
check("assertPathInside accepts root and children", insideOk === true);
check("assertPathInside rejects an escape", insideErr === "PATH_ESCAPE", insideErr);

// ─── 5. loadEnv().paths uses the same map ──────────────────────────────
const rootC = tempDir("zbd-paths-c-");
const envFile = path.join(rootC, ".env");
fs.writeFileSync(
  envFile,
  ["PORT=5050", "DATA_DIR=./data", "LOG_DIR=./logs", "DB_SQLITE_PATH=./data/models.db"].join("\n"),
  "utf8",
);
const loaded = envModule.loadEnv({ root: rootC, env: {}, envFile });
check("loadEnv() exposes paths", Boolean(loaded.paths), loaded.paths ? "yes" : "no");
check("loadEnv().paths.appRoot is the env root", loaded.paths.appRoot === rootC, loaded.paths.appRoot);
check(
  "loadEnv().paths.dataDir is anchored",
  loaded.paths.dataDir === path.join(rootC, "data"),
  loaded.paths.dataDir,
);
check(
  "loadEnv().paths.dbPath is anchored",
  loaded.paths.dbPath === path.join(rootC, "data", "models.db"),
  loaded.paths.dbPath,
);

for (const dir of [rootA, rootB, rootC]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ─── Summary ───────────────────────────────────────────────────────────
console.log("");
console.log("checks: " + (pass + fail) + " pass=" + pass + " fail=" + fail);
if (fail > 0) {
  console.error("PATH_RESOLVER_FAIL");
  for (const item of failures) console.error(" - " + item);
  process.exit(1);
}
console.log("PATH_RESOLVER_OK");
