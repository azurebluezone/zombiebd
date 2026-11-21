#!/usr/bin/env node
"use strict";

/*
 * LIVE_HTTPS_OK — proves the live gateway is running the loopback TLS code.
 *
 *   1. The process listening on 127.0.0.1:5050 exists and has the new env:
 *      BIND_HOST=127.0.0.1, APP_URL=https://127.0.0.1, and real cert paths.
 *   2. http://127.0.0.1:5050/health answers 200.
 *   3. https://127.0.0.1:5444/health answers 200 with the loopback cert.
 *   4. The live log shows HTTPS_LISTENING with port 5444 and host 127.0.0.1,
 *      with no HTTPS_ERROR after it.
 *
 * Run: node tests/live-https-check.js
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.LIVE_HTTP_PORT || 5050);
const HTTPS_PORT = Number(process.env.LIVE_HTTPS_PORT || 5444);

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log("PASS " + name + (detail ? "  [" + detail + "]" : ""));
  } else {
    fail++;
    console.log("FAIL " + name + (detail ? "  [" + detail + "]" : ""));
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return "";
  }
}

function envValue(text, key) {
  const match = String(text).match(new RegExp("^" + key + "=(.*)$", "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function resolveFromRoot(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

function listenerPid(port) {
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(":" + port + " ") || !line.includes("LISTEN")) continue;
      const match = line.match(/pid=(\d+)/);
      if (match) return Number(match[1]);
    }
  } catch (_) {}
  return 0;
}

function processEnv(pid) {
  const map = {};
  try {
    const raw = fs.readFileSync("/proc/" + pid + "/environ", "utf8");
    for (const entry of raw.split("\0")) {
      const index = entry.indexOf("=");
      if (index > 0) map[entry.slice(0, index)] = entry.slice(index + 1);
    }
  } catch (_) {}
  return map;
}

function latestLog() {
  const dir = path.join(ROOT, "logs");
  try {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].file : "";
  } catch (_) {
    return "";
  }
}

function get(port, useTls, pathName) {
  return new Promise((resolve) => {
    const client = useTls ? https : http;
    const req = client.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method: "GET",
        timeout: 5000,
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", (error) =>
      resolve({ status: 0, body: String(error.message || error) }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
    req.end();
  });
}

async function main() {
  const pid = listenerPid(HTTP_PORT);
  check("live gateway listens on 127.0.0.1:" + HTTP_PORT, pid > 0, "pid=" + pid);

  const envText = read(path.join(ROOT, ".env"));
  check(
    "live .env BIND_HOST is 127.0.0.1",
    envValue(envText, "BIND_HOST") === "127.0.0.1",
    "BIND_HOST=" + (envValue(envText, "BIND_HOST") || "missing"),
  );
  check(
    "live .env APP_URL uses 127.0.0.1",
    envValue(envText, "APP_URL").startsWith("https://127.0.0.1"),
    "APP_URL=" + (envValue(envText, "APP_URL") || "missing"),
  );

  const certFile = resolveFromRoot(envValue(envText, "HTTPS_CERT_PATH"));
  const keyFile = resolveFromRoot(envValue(envText, "HTTPS_KEY_PATH"));
  check(
    "live .env cert/key paths point to real files",
    !!certFile &&
      !!keyFile &&
      fs.existsSync(certFile) &&
      fs.existsSync(keyFile),
    "cert=" + (certFile || "missing") + " key=" + (keyFile || "missing"),
  );

  const httpHealth = await get(HTTP_PORT, false, "/health");
  check(
    "http://127.0.0.1:" + HTTP_PORT + "/health answers 200",
    httpHealth.status === 200,
    "status=" + httpHealth.status,
  );

  let healthJson = null;
  try {
    healthJson = JSON.parse(httpHealth.body);
  } catch (_) {}
  check(
    "live /health reports domain 127.0.0.1",
    !!healthJson && healthJson.domain === "127.0.0.1",
    "domain=" + (healthJson ? healthJson.domain : "unparsed"),
  );

  const identity = await get(HTTP_PORT, false, "/identity");
  let identityJson = null;
  try {
    identityJson = JSON.parse(identity.body);
  } catch (_) {}
  const identityDomain =
    identityJson &&
    identityJson.system_identity &&
    identityJson.system_identity.server &&
    identityJson.system_identity.server.domain;
  check(
    "live /identity reports server domain 127.0.0.1",
    identityDomain === "127.0.0.1",
    "domain=" + (identityDomain || "unparsed"),
  );

  const runtimeConfig = await get(HTTP_PORT, false, "/api/config");
  let configJson = null;
  try {
    configJson = JSON.parse(runtimeConfig.body);
  } catch (_) {}
  const configDomain =
    configJson && configJson.config && configJson.config.domain;
  const sessionVerifyUrl =
    configJson && configJson.config && configJson.config.sessionVerifyUrl;
  check(
    "live /api/config reports 127.0.0.1 domain and session verifier",
    configDomain === "127.0.0.1" &&
      String(sessionVerifyUrl || "").startsWith("https://127.0.0.1"),
    "domain=" +
      (configDomain || "unparsed") +
      " sessionVerifyUrl=" +
      (sessionVerifyUrl || "missing"),
  );

  const httpsHealth = await get(HTTPS_PORT, true, "/health");
  check(
    "https://127.0.0.1:" + HTTPS_PORT + "/health answers 200",
    httpsHealth.status === 200,
    "status=" + httpsHealth.status,
  );

  const logFile = latestLog();
  const log = read(logFile);
  const lines = log.split(/\r?\n/);
  let listenerIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    if (/HTTPS_LISTENING/.test(lines[index])) listenerIndex = index;
  }
  const listenerLine = listenerIndex >= 0 ? lines[listenerIndex] : "";
  check(
    "live log shows HTTPS_LISTENING on port " + HTTPS_PORT + " / host 127.0.0.1",
    new RegExp('"port":' + HTTPS_PORT).test(listenerLine) &&
      /"host":"127\.0\.0\.1"/.test(listenerLine),
    listenerLine.trim().slice(0, 240),
  );
  const after = listenerIndex >= 0 ? lines.slice(listenerIndex + 1, listenerIndex + 40).join("\n") : "";
  check(
    "no HTTPS_ERROR after the latest listener start",
    !/HTTPS_ERROR/.test(after),
    logFile,
  );

  console.log("\n" + pass + " passed, " + fail + " failed");
  if (fail > 0) process.exit(1);
  console.log("LIVE_HTTPS_OK");
}

main().catch((error) => {
  console.error("FAIL " + (error && error.stack ? error.stack : String(error)));
  process.exit(1);
});
