/**
 * tls.js — Self-signed certificate management for the HTTPS transport
 * ═══════════════════════════════════════════════════════════════════════
 * Node.js has no built-in X.509 *generator* (crypto.X509Certificate only
 * parses), so we shell out to the openssl CLI that ships with every Linux
 * box. No npm dependency, no internet, works offline.
 *
 * Certificates are cached on disk and only regenerated when they are
 * missing, expired, or the hostname list changed.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const CERT_DIR = process.env.ADAPTER_CERT_DIR || path.join(os.homedir(), ".zombiecoder", "certs");
const KEY_FILE = path.join(CERT_DIR, "adapter-key.pem");
const CRT_FILE = path.join(CERT_DIR, "adapter-cert.pem");

function opensslAvailable() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Certificate is usable only if it exists, parses, and is not expired. */
function certIsFresh(hosts) {
  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(CRT_FILE)) return false;
  try {
    // -checkend returns 0 when valid for at least N more seconds.
    execFileSync("openssl", ["x509", "-in", CRT_FILE, "-checkend", "86400", "-noout"], { stdio: "ignore" });
  } catch {
    return false; // missing OR expiring within 24h
  }
  try {
    // The hostname lives in subjectAltName, NOT in the subject line —
    // `openssl -subject` only prints CN/O/OU etc, so it would never match
    // and would regenerate the certificate on every single start.
    const out = execFileSync("openssl", ["x509", "-in", CRT_FILE, "-noout", "-ext", "subjectAltName"], {
      encoding: "utf8",
    });
    const san = out.includes("DNS:") || out.includes("IP Address:") ? out : "";
    if (!san) return false;
    return hosts.every((h) => san.includes(`DNS:${h}`) || san.includes(`IP Address:${h}`));
  } catch {
    return false;
  }
}

function generate(hosts, days = 825) {
  if (!opensslAvailable()) {
    throw new Error(
      "openssl CLI not found — cannot generate a self-signed certificate.\n" +
        "Install it:  sudo apt-get install -y openssl",
    );
  }
  fs.mkdirSync(CERT_DIR, { recursive: true, mode: 0o700 });

  const SAN = hosts
    .map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`))
    .join(",");

  // SAN + basicConstraints are both required: Node 17+ refuses a cert that
  // has neither, and browsers refuse one with no subjectAltName.
  execFileSync(
    "openssl",
    [
      "req", "-x509",
      "-newkey", "rsa:2048",
      "-nodes",
      "-keyout", KEY_FILE,
      "-out", CRT_FILE,
      "-days", String(days),
      "-subj", "/C=BD/ST=Barisal/L=Dhaka/O=ZombieCoder/OU=Mission Barisal/CN=" + hosts[0],
      "-addext", `subjectAltName=${SAN}`,
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=digitalSignature,keyEncipherment",
      "-addext", "extendedKeyUsage=serverAuth",
    ],
    { stdio: "ignore" },
  );

  fs.chmodSync(KEY_FILE, 0o600); // private key — owner only
  fs.chmodSync(CRT_FILE, 0o644);
  return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE), generated: true };
}

/**
 * Return { key, cert, hosts, generated } — reuses the cached pair when
 * possible, regenerates when it is stale.
 */
function ensure(hosts = ["localhost"]) {
  if (!certIsFresh(hosts)) return { ...generate(hosts), hosts };
  return { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CRT_FILE), hosts, generated: false };
}

function fingerprint() {
  try {
    return execFileSync("openssl", ["x509", "-in", CRT_FILE, "-noout", "-fingerprint", "-sha256"], {
      encoding: "utf8",
    })
      .split("=")[1]
      .trim();
  } catch {
    return "(unavailable)";
  }
}

module.exports = { ensure, generate, opensslAvailable, fingerprint, CERT_DIR, KEY_FILE, CRT_FILE };