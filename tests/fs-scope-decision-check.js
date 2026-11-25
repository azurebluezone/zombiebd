#!/usr/bin/env node
"use strict";

/** FS_SCOPE_DECISION_OK — row 3. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const ROOT = path.resolve(__dirname, "..");
const scope = require(path.join(ROOT, "lib/fs-scope.js"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
const work = path.join(os.tmpdir(), "zc-fs-scope-work");
const allowed = path.join(os.tmpdir(), "zc-fs-scope-allowed");
const home = path.join(os.tmpdir(), "zc-fs-scope-home");

check("unset defaults to session, unrestricted is explicit", () => {
  assert.strictEqual(scope.mode({}), "session");
  assert.strictEqual(scope.mode({ AGENT_FS_SCOPE: "" }), "session");
  assert.strictEqual(scope.mode({ AGENT_FS_SCOPE: "unrestricted" }), "unrestricted");
  assert.strictEqual(scope.mode({ AGENT_FS_SCOPE: "root" }), "unrestricted");
  assert.strictEqual(scope.mode({ AGENT_FS_SCOPE: "restricted" }), "restricted");
  assert.strictEqual(scope.mode({ AGENT_FS_SCOPE: "bogus" }), "session");
});

check("session roots are workspace + ALLOWED_DIRS, never HOME", () => {
  const roots = scope.rootsFor({ mode: "session", workingDir: work, allowedDirs: [allowed], homeDir: home });
  assert.deepStrictEqual(roots.sort(), [allowed, work].sort());
  assert.strictEqual(scope.within(path.join(work, "a.txt"), roots), true);
  assert.strictEqual(scope.within(path.join(work, "..", "escape.txt"), roots), false);
  assert.strictEqual(scope.within(home, roots), false);
});

check("restricted adds HOME; root directories are not implicit", () => {
  const roots = scope.rootsFor({ mode: "restricted", workingDir: work, allowedDirs: [allowed, path.sep], homeDir: home });
  assert.ok(roots.includes(home), "HOME missing from restricted roots");
  assert.ok(!roots.includes(path.sep), "root directory became an implicit allow");
  assert.strictEqual(scope.rootsFor({ mode: "unrestricted", workingDir: work }), null);
});

check("shell cd escape is detected only in scoped modes", () => {
  const roots = [work];
  assert.strictEqual(scope.commandEscapes("cd /etc && cat passwd", { mode: "session", roots }), true);
  assert.strictEqual(scope.commandEscapes("cd /tmp && ls", { mode: "session", roots }), true);
  assert.strictEqual(scope.commandEscapes("cd sub && ls", { mode: "session", roots }), false);
  assert.strictEqual(scope.commandEscapes("cd \"$PWD\" && ls", { mode: "session", roots }), false);
  assert.strictEqual(scope.commandEscapes("cd /etc", { mode: "unrestricted", roots }), false);
});

check("api.js uses the module and no longer defaults to unrestricted", () => {
  const api = read("api.js");
  assert.ok(api.includes('require("./lib/fs-scope.js")'), "fs-scope not required");
  assert.ok(api.includes("const scope = fsScope.mode();"), "isPathSafe ignores the module");
  assert.ok(api.includes("fsScope.commandEscapes(cmd"), "terminal guard missing");
  assert.ok(!/AGENT_FS_SCOPE\s*\|\|\s*"unrestricted"/.test(api), "old unrestricted default remains");
});

check(".env.example documents session as the default", () => {
  const env = read(".env.example");
  assert.ok(/^AGENT_FS_SCOPE=session$/m.test(env), "example still defaults unrestricted");
  assert.ok(/^MISSION_ALLOW_PRIVILEGED=false$/m.test(env), "mission opt-in missing from example");
});

console.log("\nFS_SCOPE_DECISION_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
process.exitCode = fail === 0 ? 0 : 1;
