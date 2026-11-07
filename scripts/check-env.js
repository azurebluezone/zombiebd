#!/usr/bin/env node
"use strict";

/**
 * scripts/check-env.js - validate the runtime environment contract.
 * Prints the resolved port map and exits non-zero on any violation.
 */

const path = require("path");
const { loadEnv, formatReport, SERVICE_PORTS } = require("../lib/env");

const config = loadEnv({ root: path.resolve(__dirname, "..") });

console.log(formatReport(config));

for (const warning of config.warnings) {
  console.warn("WARN " + warning);
}
for (const error of config.errors) {
  console.error("ERROR " + error);
}

if (config.errors.length > 0) {
  console.error("ENV_FAIL errors=" + config.errors.length);
  process.exit(1);
}

console.log(
  "ENV_OK services=" +
    Object.keys(SERVICE_PORTS).length +
    " unique=yes tls=" +
    config.derived.tlsMode +
    " host=" +
    (config.derived.mainHost || "unset"),
);
