#!/usr/bin/env node
"use strict";

/** MISSION_PRIVILEGE_OK — row 2. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const policy = require(path.join(ROOT, "modules/surface-policy.js"));
const mission = require(path.join(ROOT, "lib/mission-privilege.js"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
const isPriv = (name) => policy.isPrivilegedTool(name);

check("admin token allows a privileged catalog", () => {
  const d = mission.decide({ tools: ["terminal", "web_search"], isPrivileged: isPriv, adminAuthorized: true, accept: false });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.via, "admin-token");
  assert.deepStrictEqual(d.privileged, ["terminal"]);
});

check("explicit operator accept is the only non-admin allow", () => {
  const d = mission.decide({ tools: ["write_file"], isPrivileged: isPriv, adminAuthorized: false, accept: true });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.via, "explicit-accept");
  const denied = mission.decide({ tools: ["write_file"], isPrivileged: isPriv, adminAuthorized: false, accept: false });
  assert.strictEqual(denied.allowed, false);
  assert.strictEqual(denied.reason, "mission_privileged_requires_admin");
});

check("chat-only mission does not get execution privileges", () => {
  const d = mission.decide({ tools: ["web_search", "get_time"], isPrivileged: isPriv, adminAuthorized: false, accept: false });
  assert.strictEqual(d.allowed, false);
  assert.deepStrictEqual(d.privileged, []);
});

check("tool objects and function wrappers are read", () => {
  const names = mission.privilegedToolNames(
    [{ name: "terminal" }, { function: { name: "write_file" } }, { name: "web_search" }],
    isPriv,
  );
  assert.deepStrictEqual(names, ["terminal", "write_file"]);
});

check("api route gates the request and the execution context", () => {
  const api = read("api.js");
  assert.ok(api.includes("const missionPrivilegeDecision = missionPrivilege.decide({"), "request gate missing");
  assert.ok(api.includes('code: "MISSION_PRIVILEGE_REQUIRES_ADMIN"'), "401 code missing");
  assert.ok(api.includes("allowPrivileged: missionPrivilegeDecision.allowed"), "decision not propagated");
  assert.ok(api.includes('surface: "mission"'), "surface not tagged");
  assert.ok(api.includes("MISSION_PRIVILEGE_BLOCKED_AT_EXEC"), "execution gate missing");
  assert.ok(api.includes('MISSION_ALLOW_PRIVILEGED === "true"'), "operator opt-in missing");
});

check("surface policy marks mission privileged tools admin-token", () => {
  assert.strictEqual(policy.policyFor("mission").privileged, "admin-token");
});

console.log("\nMISSION_PRIVILEGE_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
process.exitCode = fail === 0 ? 0 : 1;
