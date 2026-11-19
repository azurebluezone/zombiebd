#!/usr/bin/env node
// verify-capability-failclosed.js — P1-06 proof.
//
// With no database handle attached, a capability must not be granted: both
// provider.supports() and provider/tools.allowsTools() deny and warn
// CAPABILITY_UNKNOWN. This is the runtime state that used to silently allow
// every tool/media/stream request.
"use strict";

const provider = require("../provider");
const tools = require("../provider/tools");

const supports = provider.supports("opencode", "probe-model", "tools");
const allowsTools = tools.allowsTools("opencode", "probe-model");

if (supports !== false) {
  console.error("FAIL supports() returned " + JSON.stringify(supports));
  process.exit(1);
}
if (allowsTools !== false) {
  console.error("FAIL allowsTools() returned " + JSON.stringify(allowsTools));
  process.exit(1);
}
console.log("CAPABILITY_FAILCLOSED_OK");
