#!/usr/bin/env node
"use strict";

/*
 * FINAL_GUARD_OK — the last line of defence against hidden characters.
 *
 *   1. scripts/zero-width-guard.js exists and exits 0 with
 *      ZERO_WIDTH_GUARD_OK on the real tree.
 *   2. package.json exposes the check:zero-width script.
 *   3. Live gateway answers /health.
 *   4. Live tool_search returns read_file and write_file schemas.
 *   5. Live write_file receives U+200B/U+200C/U+200D/U+FEFF, a soft hyphen,
 *      a bidi override, a word joiner and a C0 control, yet the file on disk
 *      is clean; live read_file returns the clean bytes and delete_file
 *      removes the probe.
 *   6. Live get_working_dir answers with a real path.
 *   7. The new Bengali MP3 exists, decodes with ffprobe and is longer than
 *      30 seconds.
 *   8. node tests/hardening-check.js still reports HARDENING_OK.
 *
 * Run: node tests/final-guard-check.js
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HOST = "127.0.0.1";
const API_PORT = Number(process.env.LIVE_HTTP_PORT || 5050);
const AUDIO_DIRS = [
  path.join(ROOT, "tmp", "audio"),
  path.join(os.homedir(), "Music", "mp3", "zc lama"),
];

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

function read(relative) {
  try {
    return fs.readFileSync(path.join(ROOT, relative), "utf8");
  } catch (_) {
    return "";
  }
}

function envValue(key) {
  const text = read(".env");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    if (trimmed.slice(0, index).trim() !== key) continue;
    return trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return "";
}

function requestJson(method, pathname, body, headers) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const finalHeaders = { Accept: "application/json" };
    if (payload) {
      finalHeaders["Content-Type"] = "application/json";
      finalHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    Object.assign(finalHeaders, headers || {});
    const req = http.request(
      { host: HOST, port: API_PORT, path: pathname, method, headers: finalHeaders },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {}
          resolve({ status: res.statusCode || 0, text, json });
        });
      },
    );
    req.on("error", (error) => resolve({ status: 0, text: "", error: error.message }));
    req.setTimeout(15000, () => {
      req.destroy();
      resolve({ status: 0, text: "", error: "timeout" });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function mcp(method, params, privileged) {
  const headers = {
    Origin: "http://" + HOST + ":" + API_PORT,
    "X-MCP-Client-Name": "final-guard-check",
  };
  if (privileged) {
    const token =
      envValue("MCP_ADMIN_TOKEN") ||
      envValue("ADMIN_API_KEY") ||
      envValue("ADMIN_TOKEN");
    if (token) headers.Authorization = "Bearer " + token;
  }
  return requestJson(
    "POST",
    "/mcp",
    { jsonrpc: "2.0", id: "final-guard-" + method, method, params: params || {} },
    headers,
  );
}

function mcpText(response) {
  const content =
    response && response.json && response.json.result && response.json.result.content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => (item && item.text) || "").join("");
}

function runNode(relative) {
  return spawnSync(process.execPath, [path.join(ROOT, relative)], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120000,
  });
}

// ── 1. Standalone guard ─────────────────────────────────────────
function guardChecks() {
  const guardPath = path.join(ROOT, "scripts", "zero-width-guard.js");
  check("scripts/zero-width-guard.js exists", fs.existsSync(guardPath));

  const guard = runNode("scripts/zero-width-guard.js");
  check(
    "zero-width guard passes on the real tree",
    guard.status === 0 && /ZERO_WIDTH_GUARD_OK/.test(guard.stdout || ""),
    "exit=" + guard.status + " " + String(guard.stdout || "").trim().split("\n").pop(),
  );

  const pkg = JSON.parse(read("package.json") || "{}");
  check(
    "package.json exposes check:zero-width",
    Boolean(pkg.scripts && pkg.scripts["check:zero-width"]),
    pkg.scripts && pkg.scripts["check:zero-width"],
  );
}

// ── 2. Live tool round-trip ────────────────────────────────────
async function liveChecks() {
  const health = await requestJson("GET", "/health");
  check(
    "live gateway /health answers 200",
    health.status === 200 && health.json && health.json.healthy === true,
    "status=" + health.status,
  );

  const search = await mcp("tools/call", {
    name: "tool_search",
    arguments: { query: "file", limit: 20 },
  });
  let searchJson = null;
  try {
    searchJson = JSON.parse(mcpText(search));
  } catch (_) {}
  const found = searchJson && Array.isArray(searchJson.tools) ? searchJson.tools : [];
  const foundNames = found
    .map((tool) => tool && tool.function && tool.function.name)
    .filter(Boolean);
  check(
    "live tool_search returns read_file",
    search.status === 200 && foundNames.includes("read_file"),
    "status=" + search.status + " matches=" + foundNames.length,
  );
  check(
    "live tool_search returns write_file",
    search.status === 200 && foundNames.includes("write_file"),
    "status=" + search.status,
  );

  const workingDir = await mcp("tools/call", { name: "get_working_dir", arguments: {} });
  const workDirText = mcpText(workingDir).trim();
  check(
    "live get_working_dir answers with a real path",
    workingDir.status === 200 && path.isAbsolute(workDirText),
    "status=" + workingDir.status + " path=" + workDirText,
  );
  const workDir = path.isAbsolute(workDirText) ? workDirText : ROOT;

  const probeName = "tmp/final-guard-probe-" + Date.now() + ".txt";
  const probeAbsolute = path.join(workDir, probeName);
  const dirty =
    "alpha\u200Bbeta\u200Cgamma\u200Ddelta\uFEFFepsilon" +
    "\u00ADzeta\u202Eeta\u2060theta\u0007iota\n";
  const expected = "alphabetagammadeltaepsilonzetaetathetaiota\n";

  const write = await mcp(
    "tools/call",
    {
      name: "write_file",
      arguments: { path: probeName, content: dirty },
    },
    true,
  );
  const writeText = mcpText(write);
  check(
    "live write_file reports the probe was written",
    write.status === 200 && /Written \d+ bytes/.test(writeText),
    "status=" + write.status + " " + writeText.trim().slice(0, 90),
  );

  let onDisk = null;
  try {
    onDisk = fs.readFileSync(probeAbsolute, "utf8");
  } catch (_) {}
  check(
    "write_file persisted clean bytes",
    onDisk === expected,
    onDisk === null ? "missing" : JSON.stringify(onDisk),
  );

  const readBack = await mcp("tools/call", {
    name: "read_file",
    arguments: { path: probeName },
  });
  check(
    "live read_file returns the clean bytes",
    readBack.status === 200 && mcpText(readBack) === expected,
    "status=" + readBack.status + " " + JSON.stringify(mcpText(readBack)),
  );

  const del = await mcp(
    "tools/call",
    {
      name: "delete_file",
      arguments: { path: probeName },
    },
    true,
  );
  const delText = mcpText(del);
  check(
    "live delete_file removes the probe",
    del.status === 200 && /Deleted/.test(delText) && !fs.existsSync(probeAbsolute),
    "status=" + del.status + " " + delText.trim().slice(0, 90),
  );
}

// ── 3. Audio ───────────────────────────────────────────────────
function newestAudio() {
  const candidates = [];
  for (const dir of AUDIO_DIRS) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.mp3$/i.test(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      let stat = null;
      try {
        stat = fs.statSync(absolute);
      } catch (_) {
        continue;
      }
      candidates.push({ absolute, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

function audioChecks() {
  const audio = newestAudio();
  check("a project Bengali MP3 exists", Boolean(audio), audio ? audio.absolute : "none");
  if (!audio) return;

  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      audio.absolute,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  let duration = NaN;
  const stdout = String(probe.stdout || "");
  try {
    const parsed = JSON.parse(stdout);
    duration = Number(parsed && parsed.format && parsed.format.duration);
  } catch (_) {
    // The local ffprobe is a Python shim that always prints key=value lines.
    const match = stdout.match(/^duration=([0-9.]+)$/m);
    if (match) duration = Number(match[1]);
  }
  check(
    "the MP3 decodes with ffprobe",
    probe.status === 0 && Number.isFinite(duration) && duration > 0,
    "exit=" + probe.status + " duration=" + duration,
  );
  check(
    "the MP3 is longer than 30 seconds",
    Number.isFinite(duration) && duration > 30,
    "duration=" + duration.toFixed(2) + "s size=" + audio.size,
  );
  check(
    "the MP3 is fresh (today)",
    Date.now() - audio.mtime < 12 * 60 * 60 * 1000,
    new Date(audio.mtime).toISOString(),
  );
}

// ── 4. Hardening still green ───────────────────────────────────
function hardeningCheck() {
  const result = runNode("tests/hardening-check.js");
  check(
    "node tests/hardening-check.js still reports HARDENING_OK",
    result.status === 0 && /RESULT: HARDENING_OK/.test(result.stdout || ""),
    "exit=" + result.status,
  );
}

async function main() {
  console.log("Final guard check — hidden characters, live tools, audio");
  console.log("  root: " + ROOT);
  console.log("  api:  http://" + HOST + ":" + API_PORT);

  guardChecks();
  await liveChecks();
  audioChecks();
  hardeningCheck();

  console.log(
    "\nRESULT: " +
      (fail === 0 ? "FINAL_GUARD_OK" : "FINAL_GUARD_FAIL") +
      " pass=" +
      pass +
      " fail=" +
      fail,
  );
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log("FAIL unhandled: " + (error && error.message ? error.message : error));
  console.log("\nRESULT: FINAL_GUARD_FAIL");
  process.exitCode = 1;
});
