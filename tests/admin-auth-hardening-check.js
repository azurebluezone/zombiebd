#!/usr/bin/env node
"use strict";

/** ADMIN_AUTH_HARDENING_OK — row 4.
 * Production never fails open, the first compare is constant-time, and the
 * panel cookie gets Secure when the request is HTTPS.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const adminAuth = require(path.join(ROOT, "lib/admin-auth.js"));
const adminSession = require(path.join(ROOT, "lib/admin-session.js"));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }

check("dev opt-out works only outside production", () => {
  assert.strictEqual(adminAuth.allowUnauthenticated({ ADMIN_ALLOW_UNAUTHENTICATED: "true" }), true);
  assert.strictEqual(adminAuth.allowUnauthenticated({ ADMIN_ALLOW_UNAUTHENTICATED: "true", NODE_ENV: "production" }), false);
  assert.strictEqual(adminAuth.allowUnauthenticated({ ADMIN_ALLOW_UNAUTHENTICATED: "true", SERVER_TYPE: "production" }), false);
  assert.strictEqual(adminAuth.allowUnauthenticated({ ADMIN_ALLOW_UNAUTHENTICATED: "false" }), false);
  assert.strictEqual(adminAuth.allowUnauthenticated({}), false);
});

check("token compare is constant-time and length-safe", () => {
  assert.strictEqual(adminAuth.constantTimeEqual("abc", "abc"), true);
  assert.strictEqual(adminAuth.constantTimeEqual("abc", "abd"), false);
  assert.strictEqual(adminAuth.constantTimeEqual("abc", "abcdef"), false);
  assert.strictEqual(adminAuth.constantTimeEqual("", ""), true);
  assert.strictEqual(adminAuth.constantTimeEqual(undefined, ""), true);
});

check("Secure cookie is opt-in per request", () => {
  assert.ok(!adminSession.cookie("t").includes("Secure"), "plain HTTP cookie must not be Secure");
  assert.ok(adminSession.cookie("t", { secure: true }).includes("; Secure"), "HTTPS cookie missing Secure");
  assert.ok(!adminSession.cookie("t", { secure: false }).includes("Secure"), "explicit false was overridden");
});

check("request security detects TLS and trusted proxy", () => {
  assert.strictEqual(adminAuth.requestIsSecure({ socket: { encrypted: true } }, {}), true);
  assert.strictEqual(adminAuth.requestIsSecure({ headers: { "x-forwarded-proto": "https" } }, {}), true);
  assert.strictEqual(adminAuth.requestIsSecure({ headers: { "x-forwarded-proto": "http" } }, {}), false);
  assert.strictEqual(adminAuth.requestIsSecure({}, { ADMIN_COOKIE_SECURE: "true" }), true);
  assert.strictEqual(adminAuth.requestIsSecure({ socket: { encrypted: true } }, { ADMIN_COOKIE_SECURE: "false" }), false);
});

check("api.js uses the module for every admin compare", () => {
  const api = read("api.js");
  assert.ok(api.includes('require("./lib/admin-auth.js")'), "admin-auth not required");
  assert.ok(api.includes("adminAuth.allowUnauthenticated(process.env)"), "fail-open bypassed the policy");
  assert.ok(api.includes("adminAuth.constantTimeEqual(got, want)"), "first compare is not constant-time");
  assert.ok(api.includes("adminAuth.constantTimeEqual(provided, want)"), "MCP compare is not constant-time");
  assert.ok(!/got\s*===\s*want/.test(api), "plain === compare remains");
  assert.ok(!/return\s+process\.env\.ADMIN_ALLOW_UNAUTHENTICATED\s*===\s*"true"/.test(api), "raw fail-open remains");
});

check("panel cookie sets Secure from the request", () => {
  const api = read("api.js");
  assert.ok(api.includes("secure: adminAuth.requestIsSecure(req)"), "panel cookie has no Secure policy");
});

console.log("\nADMIN_AUTH_HARDENING_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
process.exitCode = fail === 0 ? 0 : 1;
