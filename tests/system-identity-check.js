#!/usr/bin/env node
"use strict";

/*
 * Immutable system identity acceptance check.
 *
 * Proves, with real files and a live gateway:
 *   1. identity.json exists, matches the mandated fields, and has no write bits.
 *   2. modules/system-identity.js returns a deep-frozen identity and the exact
 *      ownership headers / identity anchor sentence.
 *   3. buildSystemPrompt keeps the identity anchor and owner even under a tight
 *      character budget (compact prompts cannot lose the identity).
 *   4. api.js wires the headers, session metadata and both prompt builders.
 *   5. A running gateway returns the three headers on /health and on a 404.
 *
 * Run: node tests/system-identity-check.js
 * Exit 0 prints SYSTEM_IDENTITY_OK.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");

const ROOT = path.resolve(__dirname, "..");
const IDENTITY_FILE = path.join(ROOT, "identity.json");

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

const EXPECTED = {
  name: "Mission Barisal",
  product: "ZombieCoder",
  tagline: "Where code and words speak",
  owner: "Sahon Srabon",
  organization: "Developer Zone",
  location: "Dhaka, Bangladesh",
  website: "https://zombiecoder.my.id/",
  license: "Proprietary - Local Freedom Protocol",
  anchor:
    "আমি ZombieCoder, যেখানে কোড ও কথা বলে। আমার নির্মাতা ও মালিক Sahon Srabon, Developer Zone।",
};

// ── 1. identity.json ────────────────────────────────────────
let raw = null;
let doc = null;
try {
  raw = fs.readFileSync(IDENTITY_FILE, "utf8");
  doc = JSON.parse(raw).system_identity;
} catch (e) {
  console.log("FAIL identity.json — " + e.message);
}
check("identity.json exists and parses", !!doc);
if (!doc) {
  console.log("\nRESULT: SYSTEM_IDENTITY_FAIL identity.json missing");
  process.exit(1);
}

const b = doc.branding || {};
const c = doc.contact || {};
check("name is Mission Barisal", doc.name === EXPECTED.name, String(doc.name));
check("product is ZombieCoder", doc.product === EXPECTED.product, String(doc.product));
check("version is non-empty", typeof doc.version === "string" && doc.version.length > 0, String(doc.version));
check("tagline exact", doc.tagline === EXPECTED.tagline, String(doc.tagline));
check("owner exact", b.owner === EXPECTED.owner, String(b.owner));
check("organization exact", b.organization === EXPECTED.organization, String(b.organization));
check(
  "address present",
  typeof b.address === "string" && b.address.trim().length > 5,
  String(b.address || "").length + " chars",
);
check("location exact", b.location === EXPECTED.location, String(b.location));
check(
  "contact phone present",
  /^\+?[0-9][0-9 ()-]{6,}$/.test(String(c.phone || "")),
  String(c.phone || "").length + " chars",
);
check(
  "contact email valid",
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(c.email || "")),
  String(c.email || ""),
);
check("contact website exact", c.website === EXPECTED.website, String(c.website));
check("license exact", doc.license === EXPECTED.license, String(doc.license));
check("identity anchor exact", doc.identity_anchor === EXPECTED.anchor, String(doc.identity_anchor).slice(0, 40));
check("sovereignty notice present", typeof doc.sovereignty_notice === "string" && doc.sovereignty_notice.length > 20);

let mode = 0;
try {
  mode = fs.statSync(IDENTITY_FILE).mode;
} catch (_) {
  mode = 0;
}
check(
  "identity.json has no write bits (read-only)",
  (mode & 0o222) === 0,
  "mode=" + (mode & 0o777).toString(8),
);

// ── 2. Module contract ──────────────────────────────────────
let mod = null;
try {
  mod = require(path.join(ROOT, "modules", "system-identity.js"));
} catch (e) {
  console.log("FAIL module — " + e.message);
}
check("module loads", !!mod);
if (!mod) {
  console.log("\nRESULT: SYSTEM_IDENTITY_FAIL module missing");
  process.exit(1);
}

let identity = null;
try {
  identity = mod.getIdentity();
} catch (e) {
  console.log("FAIL getIdentity — " + e.message);
}
check("getIdentity() returns the identity", !!identity);
check("identity object is frozen", !!identity && Object.isFrozen(identity));
check("nested branding is frozen", !!identity && Object.isFrozen(identity.branding));
let mutationBlocked = false;
try {
  identity.name = "hacked";
  identity.branding.owner = "hacked";
  mutationBlocked = identity.name === EXPECTED.name && identity.branding.owner === EXPECTED.owner;
} catch (_) {
  mutationBlocked = true;
}
check("runtime mutation cannot change the identity", mutationBlocked, identity && identity.name);

const headers = mod.identityHeaders();
check("X-Powered-By exact", headers["X-Powered-By"] === "ZombieCoder-by-SahonSrabon", headers["X-Powered-By"]);
check("X-System-Identity exact", headers["X-System-Identity"] === "ZombieCoder", headers["X-System-Identity"]);
check("X-System-Owner exact", headers["X-System-Owner"] === "Sahon Srabon", headers["X-System-Owner"]);
check("identityAnchor() exact", mod.identityAnchor() === EXPECTED.anchor);
check(
  "identityMetadata() carries owner + source",
  mod.identityMetadata().owner === EXPECTED.owner &&
    mod.identityMetadata().source === "identity.json",
  JSON.stringify(mod.identityMetadata()),
);

// Invalid identity must fail loudly (no silent partial identity).
const tmpBad = path.join("/tmp/opencode", "bad-identity-" + process.pid + ".json");
try {
  fs.mkdirSync(path.dirname(tmpBad), { recursive: true });
  fs.writeFileSync(tmpBad, JSON.stringify({ system_identity: { name: "x" } }));
  let threw = false;
  try {
    mod.loadIdentity(tmpBad);
  } catch (_) {
    threw = true;
  }
  check("incomplete identity file is rejected", threw);
} finally {
  fs.rmSync(tmpBad, { force: true });
}

// ── 3. Prompt anchoring ────────────────────────────────────
let buildSystemPrompt = null;
try {
  ({ buildSystemPrompt } = require(path.join(ROOT, "modules", "system-prompt.js")));
} catch (e) {
  console.log("FAIL system-prompt — " + e.message);
}
check("system-prompt module loads", typeof buildSystemPrompt === "function");

if (typeof buildSystemPrompt === "function") {
  const agent = {
    id: "code-guru",
    name: "Code Guru",
    role: "engineer",
    persona: "P".repeat(900),
  };
  const out = buildSystemPrompt({
    agent,
    session: {
      persona: agent.persona,
      system_identity: mod.identityPromptBlock(),
      metadata: { session_id: "identity-check" },
      os: {},
      workspace: ROOT,
    },
    maxChars: 900,
  });
  check("prompt keeps the exact identity anchor under a tight budget", out.includes(EXPECTED.anchor), "chars=" + out.length);
  check("prompt keeps the owner", out.includes(EXPECTED.owner));
  check("prompt keeps the system name", out.includes("Mission Barisal"));
  check("prompt keeps the license", out.includes(EXPECTED.license));
}

// ── 4. api.js wiring ───────────────────────────────────────
const apiSrc = fs.readFileSync(path.join(ROOT, "api.js"), "utf8");
check(
  "api.js sets identity headers on every request",
  /setSystemIdentityHeaders\(res\);/.test(apiSrc),
);
check(
  "api.js injects identity into session metadata",
  /system_identity:\s*identityMetadata\(systemIdentityCore\(\)\)/.test(apiSrc),
);
const promptWiring = (apiSrc.match(/identityPromptBlock\(systemIdentityCore\(\)\)/g) || []).length;
check("both prompt builders use the identity block", promptWiring >= 2, "count=" + promptWiring);
check(
  "compact prompt passes real runtime facts",
  /os:\s*systemInfo\.collectSystemInfo\(\)/.test(apiSrc),
);

// ── 5. Live gateway headers ────────────────────────────────
function getHeaders(pathname, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port: 5050, path: pathname, timeout: timeoutMs || 5000 },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: e.message }));
  });
}

(async () => {
  const health = await getHeaders("/health");
  if (health.error) {
    console.log("FAIL live /health — " + health.error);
  } else {
    check(
      "live /health carries X-Powered-By",
      health.headers["x-powered-by"] === "ZombieCoder-by-SahonSrabon",
      String(health.headers["x-powered-by"]),
    );
    check(
      "live /health carries X-System-Identity",
      health.headers["x-system-identity"] === "ZombieCoder",
      String(health.headers["x-system-identity"]),
    );
    check(
      "live /health carries X-System-Owner",
      health.headers["x-system-owner"] === "Sahon Srabon",
      String(health.headers["x-system-owner"]),
    );
  }

  const missing = await getHeaders("/definitely-not-a-route");
  if (missing.error) {
    console.log("FAIL live 404 — " + missing.error);
  } else {
    check("live 404 is still a 404", missing.status === 404, String(missing.status));
    check(
      "live 404 also carries the identity headers",
      missing.headers["x-powered-by"] === "ZombieCoder-by-SahonSrabon" &&
        missing.headers["x-system-identity"] === "ZombieCoder" &&
        missing.headers["x-system-owner"] === "Sahon Srabon",
      JSON.stringify({
        powered: missing.headers["x-powered-by"],
        identity: missing.headers["x-system-identity"],
        owner: missing.headers["x-system-owner"],
      }),
    );
  }

  console.log("\nRESULT: " + pass + " passed, " + fail + " failed");
  if (fail > 0) {
    console.log("SYSTEM_IDENTITY_FAIL");
    process.exit(1);
  }
  console.log("SYSTEM_IDENTITY_OK");
})();
