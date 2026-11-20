#!/usr/bin/env node
"use strict";
// =============================================================================
// TEST: package.json + package-manager-aware edge installer
//       (runbook P1-09 + P1-08, gate PACKAGE_INSTALL_OK)
// =============================================================================
// Method (real files, real --plan calls):
//   1) package.json is valid, private, Node >=24, and every script points at
//      a real entry file
//   2) one version: package.json = identity.json = start.js = domain-config.js
//   3) install-edge.sh --plan prints the correct Caddy command for
//      apt, dnf, pacman and brew (no host changes)
//   4) unknown manager and --pm without --plan are rejected
//
// Run: node tests/package-install-check.js
// Exit 0 + PACKAGE_INSTALL_OK only when every assertion passes.
// =============================================================================
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
const rows = [];
function assert(name, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(["PASS", name, detail || ""]);
  } else {
    fail += 1;
    rows.push(["FAIL", name, detail || ""]);
  }
}

// ─────────────────────────────────────────────────────────────
// 1) package.json shape + real scripts
// ─────────────────────────────────────────────────────────────
let pkg = null;
try {
  pkg = JSON.parse(read("package.json"));
} catch (e) {
  assert("package.json parses", false, e.message);
}
if (pkg) {
  assert("package.json parses", true, "name=" + pkg.name);
  assert("name is set", typeof pkg.name === "string" && pkg.name.length > 0, pkg.name);
  assert("private is true", pkg.private === true, String(pkg.private));
  assert(
    "engines.node requires 24+",
    /^>=\s*24/.test(String(pkg.engines && pkg.engines.node || "")),
    String(pkg.engines && pkg.engines.node),
  );
  assert(
    "no runtime dependencies",
    !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
    String(pkg.dependencies ? Object.keys(pkg.dependencies).length : 0),
  );

  const scripts = pkg.scripts || {};
  const expected = {
    start: ["start.js", "--start-all"],
    build: ["start.js", "--build-only"],
    health: ["start.js", "--health-only"],
    "rebuild-restart": ["scripts/rebuild-restart.sh"],
    "check:packaging": ["tests/package-install-check.js"],
  };
  for (const [name, parts] of Object.entries(expected)) {
    const cmd = String(scripts[name] || "");
    assert(
      "script " + name + " exists",
      !!cmd && parts.every((p) => cmd.includes(p)),
      cmd || "missing",
    );
  }
  assert(
    "rebuild-restart target exists",
    fs.existsSync(path.join(ROOT, "scripts", "rebuild-restart.sh")),
  );
}

// ─────────────────────────────────────────────────────────────
// 2) one version across the source
// ─────────────────────────────────────────────────────────────
const identity = JSON.parse(read("identity.json")).system_identity;
const startVersion = (read("start.js").match(/const VERSION = "([^"]+)"/) || [])[1];
const domainVersion = (read("domain-config.js").match(/SERVER_VERSION \|\| "([^"]+)"/) || [])[1];
const versions = {
  "package.json": pkg && pkg.version,
  "identity.json": identity.version,
  "start.js": startVersion,
  "domain-config.js": domainVersion,
};
const unique = new Set(Object.values(versions).filter(Boolean));
assert(
  "all version sources agree",
  unique.size === 1 && versions["package.json"] === "3.2.1",
  JSON.stringify(versions),
);
assert(
  "scripts/build.js reads package.json",
  read("scripts/build.js").includes("package.json"),
);

// ─────────────────────────────────────────────────────────────
// 3) installer: static wiring + four real plan calls
// ─────────────────────────────────────────────────────────────
const installerPath = path.join(ROOT, "deploy", "install-edge.sh");
const installer = read("deploy/install-edge.sh");
assert("installer has detect_pm", installer.includes("detect_pm()"));
assert("installer has caddy_install_plan", installer.includes("caddy_install_plan()"));
assert("installer has install_caddy", installer.includes("install_caddy()"));
assert(
  "real install path uses install_caddy $PM",
  installer.includes('say "caddy not found — installing via $PM"') &&
    installer.includes('install_caddy "$PM"'),
);
assert("installer supports --plan", installer.includes("--plan) PLAN_ONLY=1"));
assert("installer supports --pm=", installer.includes("--pm=*) PM_OVERRIDE="));

const matrix = {
  apt: "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y caddy",
  dnf: "dnf install -y caddy",
  pacman: "pacman -Sy --noconfirm caddy",
  brew: "brew install caddy",
};
for (const [pm, command] of Object.entries(matrix)) {
  const res = spawnSync("bash", [installerPath, "--plan", "--pm=" + pm], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15000,
  });
  const out = (res.stdout || "") + (res.stderr || "");
  assert(
    "plan " + pm + " exits 0",
    res.status === 0,
    "status=" + res.status,
  );
  assert(
    "plan " + pm + " names the manager",
    out.includes("PM=" + pm),
    out.split("\n")[0] || "",
  );
  assert(
    "plan " + pm + " prints the right command",
    out.includes("CADDY_INSTALL=" + command),
    out.split("\n")[1] || "",
  );
  assert("plan " + pm + " prints EDGE_PLAN_OK", out.includes("EDGE_PLAN_OK"));
}

const unknown = spawnSync("bash", [installerPath, "--plan", "--pm=unknown"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 15000,
});
assert(
  "unknown manager is rejected",
  unknown.status !== 0 && (unknown.stderr || "").includes("unsupported package manager"),
  "status=" + unknown.status,
);

const noPlan = spawnSync("bash", [installerPath, "--pm=dnf"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 15000,
});
assert(
  "--pm without --plan is rejected",
  noPlan.status !== 0 && (noPlan.stderr || "").includes("only supported with --plan"),
  "status=" + noPlan.status,
);

// ─────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════");
console.log("  TEST: package.json + package-manager installer");
console.log("══════════════════════════════════════════════════════════");
for (const [status, name, detail] of rows) {
  const tag = status === "PASS" ? "  PASS " : "  FAIL ";
  console.log(tag + name + (detail ? "   [" + detail + "]" : ""));
}
console.log("────────────────────────────────────────────────────────────");
console.log("  RESULT: " + pass + " passed, " + fail + " failed");
if (!fail) console.log("PACKAGE_INSTALL_OK");
console.log("══════════════════════════════════════════════════════════\n");
process.exit(fail ? 1 : 0);
