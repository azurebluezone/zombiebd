"use strict";
/*
 * Gate for tests/agent-transport-e2e.js.
 * Reads the recorded result JSON and the real files it points at; it does not
 * trust the harness exit code or a prose claim. Prints one exact PASS line.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const RESULT_FILE = path.join(ROOT, "logs", "e2e", "e2e-results.json");
const WORK_DIR = "/home/sahon/Videos/test";
const EXPECTED_AGENTS = 9;
const EXPECTED_TRANSPORTS = 6;
const TRANSPORTS = ["http", "https", "uds", "stdio", "grpc", "websocket"];

function fail(reason) {
  console.log("E2E_FAIL: " + reason);
  process.exit(1);
}
function readJson(file) {
  if (!fs.existsSync(file)) fail("missing " + file);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    fail("invalid JSON in " + file + ": " + e.message);
  }
}
function check(cond, reason) {
  if (!cond) fail(reason);
}

const r = readJson(RESULT_FILE);
check(!r.error, "harness recorded an error: " + String(r.error).slice(0, 300));
check(r.reset, "missing reset evidence");
check(r.reset.performed === true, "server reset was not performed");
check(r.reset.health && r.reset.health.ok === true,
  "server health after reset is not ok");
check(Number(r.reset.health.body.agents) === EXPECTED_AGENTS,
  "health agents=" + (r.reset.health.body && r.reset.health.body.agents));
check(!!r.reset.new_pid, "missing new server pid");
check(String(r.reset.new_pid) !== String(r.reset.old_pid),
  "server pid did not change across reset");

check(r.mapping && r.mapping.all_mapped === true,
  "agents were not all mapped to the matrix model");
check(r.mapping.after && r.mapping.after.length === EXPECTED_AGENTS,
  "mapped agent count=" + (r.mapping.after && r.mapping.after.length));
for (const a of r.mapping.after || []) {
  check(a.model === r.matrixModel,
    "agent " + a.id + " model=" + a.model + " expected=" + r.matrixModel);
}

check(Array.isArray(r.matrix), "matrix is not an array");
check(r.matrix.length === EXPECTED_AGENTS * EXPECTED_TRANSPORTS,
  "matrix length=" + r.matrix.length);
const agents = new Set(r.matrix.map((m) => m.agent));
const transports = new Set(r.matrix.map((m) => m.transport));
check(agents.size === EXPECTED_AGENTS, "distinct agents=" + agents.size);
check(transports.size === EXPECTED_TRANSPORTS, "distinct transports=" + transports.size);
for (const t of TRANSPORTS) {
  const rows = r.matrix.filter((m) => m.transport === t);
  check(rows.length === EXPECTED_AGENTS,
    "transport " + t + " has " + rows.length + " calls");
  for (const row of rows) {
    check(row.ok === true,
      "failed call " + t + "/" + row.agent + ": " + (row.error || "empty"));
    check(String(row.content || "").trim().length > 0,
      "empty content " + t + "/" + row.agent);
    check(!/^no response$/i.test(String(row.content || "").trim()),
      "fallback content " + t + "/" + row.agent);
  }
}

check(r.bug, "missing bug task evidence");
check(r.bug.run_before && r.bug.run_before.exit !== 0,
  "the pre-fix calculator did not fail");
check(r.bug.run_after && r.bug.run_after.exit === 0,
  "the post-fix calculator did not exit 0");
check(String(r.bug.run_after.stdout || "").trim() === "5",
  "post-fix stdout=" + JSON.stringify(r.bug.run_after && r.bug.run_after.stdout));
check(r.bug.fixed === true, "bug.fixed is not true");
check(r.bug.creator && r.bug.creator.agent === "code-guru",
  "creator agent is not code-guru");
check(r.bug.solver && r.bug.solver.agent === "bug-hunter",
  "solver agent is not bug-hunter");
check(r.bug.creator.attempts.some((a) => a.ok === true),
  "creator never completed a successful model response");
check(r.bug.solver.attempts.some((a) => a.ok === true),
  "solver never completed a successful model response");

check(r.evidence, "missing server log evidence");
check(r.evidence.has_write_file === true, "no write_file MCP_CALL in server log");
check(r.evidence.has_exec === true, "no exec MCP_CALL in server log");
check(r.evidence.has_read_file === true, "no read_file MCP_CALL in server log");
check(r.evidence.creator_start === true, "no SINGLE_AGENT_START for code-guru");
check(r.evidence.solver_start === true, "no SINGLE_AGENT_START for bug-hunter");
check(r.evidence.counts && r.evidence.counts.single_agent_start >= EXPECTED_AGENTS * EXPECTED_TRANSPORTS,
  "SINGLE_AGENT_START count=" + (r.evidence.counts && r.evidence.counts.single_agent_start));
check(r.evidence.counts && r.evidence.counts.chat_workdir >= 1,
  "no CHAT_WORKDIR evidence");

check(fs.existsSync(r.evidence.server_window_path),
  "missing " + r.evidence.server_window_path);
const windowText = fs.readFileSync(r.evidence.server_window_path, "utf8");
check(windowText.includes("MCP_CALL"), "server window has no MCP_CALL");
check(windowText.includes(WORK_DIR), "server window has no " + WORK_DIR + " workdir");

const calcFile = path.join(WORK_DIR, "workspace", "calculator.py");
check(fs.existsSync(calcFile), "missing " + calcFile);
const calc = fs.readFileSync(calcFile, "utf8");
check(/def\s+add\s*\(/.test(calc), "calculator.py has no add()");
check(!/return\s+a\s*-\s*b/.test(calc), "calculator.py still contains the a-b bug");

const audioFile = path.join(WORK_DIR, "project-status-bn.mp3");
const audioOk = fs.existsSync(audioFile) && fs.statSync(audioFile).size > 5000;
check(audioOk, "missing or too-small Bengali audio " + audioFile);

console.log("E2E_ALL_PASS agents=9 transports=6 bug_fixed=5");
