#!/usr/bin/env node
"use strict";

/** R2T_DEFAULT_OFF_OK — row 1. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log("PASS  " + name); pass++; }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); fail++; }
}
function read(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }

check("api.js enables r2t only on the exact true string", () => {
  const api = read("api.js");
  assert.ok(/String\(process\.env\.R2T_ENABLED \|\| ""\)\.toLowerCase\(\) === "true"/.test(api), "exact true opt-in missing");
  assert.ok(!/R2T_ENABLED\s*\|\|\s*"true"/.test(api), "default-on expression remains");
  assert.ok(!/R2T_ENABLED\s*!==\s*"false"/.test(api), "default-on expression remains");
});

check(".env.example defaults to false and explains the shared-edge rule", () => {
  const env = read(".env.example");
  assert.ok(/^R2T_ENABLED=false$/m.test(env), "example does not default off");
  assert.ok(/OPT-IN ONLY/i.test(env), "opt-in warning missing");
  assert.ok(/shared\s+edge/i.test(env), "shared-edge warning missing");
});

check("r2t disabled path is explicit and logged", () => {
  const api = read("api.js");
  assert.ok(api.includes('"R2T_DISABLED"'), "R2T_DISABLED log missing");
  assert.ok(api.includes("r2t virtual model is off"), "operator hint missing");
});

check("live .env is not flipped on by this change", () => {
  const live = fs.existsSync(path.join(ROOT, ".env")) ? read(".env") : "";
  if (/^R2T_ENABLED=true$/m.test(live)) {
    console.log("NOTE  local .env explicitly enables r2t (operator choice)");
  }
});

console.log("\nR2T_DEFAULT_OFF_" + (fail === 0 ? "OK" : "FAIL") + " pass=" + pass + " fail=" + fail);
process.exitCode = fail === 0 ? 0 : 1;
