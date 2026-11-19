"use strict";

// Append-only goal ledger that runs its own check on close.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const STATUS_WORDS = new Set(["pass", "ok", "done", "success", "failed", "fail"]);
const MATCH_MODES = new Set(["contains", "equals", "regex", "json"]);
const MAX_OBSERVED = 4000;

class GoalError extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = "GoalError";
    this.code = code;
  }
}

function clean(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      records.push(JSON.parse(text));
    } catch (_) {
      // A torn last line must not hide the earlier ledger.
    }
  }
  return records;
}

function matches(output, expected, mode) {
  if (mode === "equals") return output.trim() === expected;
  if (mode === "regex") {
    try {
      return new RegExp(expected).test(output);
    } catch (_) {
      return false;
    }
  }
  if (mode === "json") {
    try {
      return JSON.stringify(JSON.parse(output)) === JSON.stringify(JSON.parse(expected));
    } catch (_) {
      return false;
    }
  }
  return output.includes(expected);
}

class GoalLedger {
  constructor(opts) {
    const o = opts || {};
    this.dir = path.resolve(o.dir || process.cwd());
    this.file = path.join(this.dir, ".zombiecoder", ".state", "goals.jsonl");
    this.timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : 120000;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
  }

  _append(record) {
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  open(spec) {
    const s = spec || {};
    const goal = clean(s.goal);
    const input = clean(s.input);
    const expected = clean(s.expected);
    const check = clean(s.check);
    const pass = clean(s.pass);
    if (!goal || !input || !expected || !check || !pass) {
      throw new GoalError(
        "ZC_GOAL_INVALID",
        "open needs goal, input, expected, check and pass",
      );
    }
    if (STATUS_WORDS.has(expected.toLowerCase())) {
      throw new GoalError(
        "ZC_GOAL_INVALID",
        'expected "' + expected + '" is a status word, not a distinctive success marker',
      );
    }
    const match = clean(s.match) || "contains";
    if (!MATCH_MODES.has(match)) {
      throw new GoalError("ZC_GOAL_INVALID", 'unknown match mode "' + match + '"');
    }

    const record = {
      type: "open",
      id: "goal-" + crypto.randomBytes(6).toString("hex"),
      goal,
      input,
      expected,
      check,
      pass,
      match,
      cwd: path.resolve(s.cwd || this.dir),
      at: new Date().toISOString(),
    };
    this._append(record);
    return record;
  }

  get(id) {
    return this.list().find((goal) => goal.id === id) || null;
  }

  list() {
    const goals = new Map();
    for (const record of readRecords(this.file)) {
      if (record.type === "open") {
        goals.set(record.id, Object.assign({}, record, { status: "open" }));
      } else if (record.type === "close" && goals.has(record.id)) {
        Object.assign(goals.get(record.id), {
          status: record.status,
          exitCode: record.exitCode,
          observed: record.observed,
          closed_at: record.at,
        });
      }
    }
    return Array.from(goals.values());
  }

  /**
   * Run the recorded check and record the real result.
   * @returns {{id, status: "PASS"|"FAIL", exitCode, observed, expected, match}}
   */
  close(id) {
    const goal = this.get(id);
    if (!goal) throw new GoalError("ZC_GOAL_NOT_FOUND", 'unknown goal "' + id + '"');
    if (goal.status !== "open") {
      throw new GoalError("ZC_GOAL_CLOSED", 'goal "' + id + '" is already ' + goal.status);
    }

    const run = spawnSync(goal.check, {
      shell: true,
      cwd: goal.cwd,
      timeout: this.timeoutMs,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    const observedRaw = String(run.stdout || "") + String(run.stderr || "");
    const observed = observedRaw.length > MAX_OBSERVED ? observedRaw.slice(-MAX_OBSERVED) : observedRaw;
    const exitCode = typeof run.status === "number" ? run.status : 1;
    const passed =
      exitCode === 0 && observed.trim().length > 0 && matches(observed, goal.expected, goal.match);
    const status = passed ? "PASS" : "FAIL";

    this._append({
      type: "close",
      id: goal.id,
      status,
      exitCode,
      observed,
      at: new Date().toISOString(),
    });

    return {
      id: goal.id,
      status,
      exitCode,
      observed,
      expected: goal.expected,
      match: goal.match,
    };
  }
}


const ANTIDOTE_ERRORS = {
  INVALID_REQUEST: {
    code: "ANTIDOTE_INVALID_REQUEST",
    message: "Input validation failed - malformed or missing required fields",
    statusCode: 400,
  },
  PROOF_FAILED: {
    code: "ANTIDOTE_PROOF_FAILED",
    message: "Logical proof check failed - request cannot be satisfied",
    statusCode: 422,
  },
  LIMIT_EXCEEDED: {
    code: "ANTIDOTE_LIMIT_EXCEEDED",
    message: "Rate limit, token limit or payload size exceeded",
    statusCode: 429,
  },
  CONTRACT_FAILED: {
    code: "ANTIDOTE_CONTRACT_FAILED",
    message: "Goal contract could not be established",
    statusCode: 422,
  },
  EXECUTION_FAILED: {
    code: "ANTIDOTE_EXECUTION_FAILED",
    message: "Execution failed - see inner error for details",
    statusCode: 500,
  },
  VERIFICATION_FAILED: {
    code: "ANTIDOTE_VERIFICATION_FAILED",
    message: "Output verification failed - result does not satisfy contract",
    statusCode: 500,
  },
};

class AntiDoteError extends Error {
  constructor(type, details) {
    const d = details || {};
    const def = ANTIDOTE_ERRORS[type] || ANTIDOTE_ERRORS.INVALID_REQUEST;
    super(d.reason ? def.message + " - " + d.reason : def.message);
    this.name = "AntiDoteError";
    this.code = def.code;
    this.statusCode = def.statusCode;
    this.errorType = type;
    this.details = d;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: true,
      type: this.errorType,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
    };
  }
}

function createContract(input, context) {
  const ctx = context || {};
  return {
    input,
    originalInput: input,
    context: ctx,
    createdAt: new Date().toISOString(),
    validatedAt: null,
    proofCheckedAt: null,
    proof: null,
    goal: null,
    constraints: {
      maxAgents: ctx.maxAgents || 6,
      requireProof: true,
      requireConsent: false,
      timeout: ctx.timeout || 120000,
      allowedTools: ctx.allowedTools || null,
    },
    execution: {
      startedAt: null,
      completedAt: null,
      success: false,
      error: null,
      result: null,
    },
    verification: {
      passed: false,
      score: 0,
      issues: [],
      verifiedAt: null,
    },
    chain: [],
  };
}

function validateInput(input, context) {
  const contract = createContract(input, context);
  if (!input || typeof input !== "string" || input.trim().length === 0) {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Input must be a non-empty string",
        received: typeof input,
      }),
    };
  }
  if (input.length > 100000) {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Input exceeds max length (100000 chars)",
        length: input.length,
      }),
    };
  }
  if (context && typeof context !== "object") {
    return {
      valid: false,
      contract,
      error: new AntiDoteError("INVALID_REQUEST", {
        reason: "Context must be an object",
        received: typeof context,
      }),
    };
  }
  contract.validatedAt = new Date().toISOString();
  contract.chain.push("validated");
  return { valid: true, contract, error: null };
}

function checkProof(contract) {
  if (!contract.chain.includes("validated")) {
    return {
      provable: false,
      contract,
      error: new AntiDoteError("PROOF_FAILED", {
        reason: "Cannot check proof before validation",
        chain: contract.chain,
      }),
    };
  }
  const input = contract.input;
  const wordCount = input.split(/\s+/).length;
  const hasCode = /\b(code|file|function|fix|bug|implement|create|script|api)\b/i.test(input);
  const hasQuestion = /(\?|what|how|why|when|where|explain|tell)/i.test(input);
  const hasCommand =
    /^(create|make|build|write|fix|update|delete|add|change|refactor)/im.test(input.trim());
  const complexity = wordCount < 5 ? "simple" : wordCount > 100 ? "complex" : "moderate";
  const proof = {
    inputLength: input.length,
    wordCount,
    hasCodeIndicator: hasCode,
    hasQuestionIndicator: hasQuestion,
    hasCommandIndicator: hasCommand,
    complexity,
    isFeasible: true,
    reason:
      "Input: " +
      wordCount +
      " words. " +
      (hasCode ? "Code-related." : "General.") +
      " Logically feasible.",
  };
  contract.proofCheckedAt = new Date().toISOString();
  contract.proof = proof;
  contract.chain.push("proof_checked");
  return { provable: true, contract, error: null };
}

function setGoalContract(contract, opts) {
  if (!contract.chain.includes("proof_checked")) {
    return {
      contracted: false,
      contract,
      error: new AntiDoteError("CONTRACT_FAILED", {
        reason: "Cannot set goal before proof check",
        chain: contract.chain,
      }),
    };
  }
  const o = opts || {};
  const codeAgents = Array.isArray(o.codeAgents) ? o.codeAgents.slice() : [];
  const proof = contract.proof;
  const goal = {
    type: proof.hasCodeIndicator ? "code_task" : "qa_task",
    description: contract.input.slice(0, 200),
    successCriteria: [],
    requiredAgents: [],
    requiresCodeSafety: proof.hasCodeIndicator,
    requiresTestEvidence: proof.hasCodeIndicator,
  };
  if (proof.hasCodeIndicator) {
    goal.successCriteria.push("Code changes must be specific (file + line)");
    goal.successCriteria.push("Test evidence or UNTESTED disclaimer required");
    goal.requiredAgents = codeAgents;
  }
  if (proof.hasQuestionIndicator) {
    goal.successCriteria.push("Response must directly answer with evidence");
  }
  if (proof.hasCommandIndicator) {
    goal.successCriteria.push("Action must be executed or explained");
  }
  goal.successCriteria.push("Language must match user input");
  goal.successCriteria.push("No hallucinated or unverified claims");
  if (proof.complexity === "simple" && goal.requiredAgents.length === 0) {
    goal.requiredAgents = codeAgents.slice(0, 1);
  }
  contract.goal = goal;
  contract.chain.push("goal_set");
  return { contracted: true, contract, error: null };
}

async function executeContract(contract, missionFn) {
  const args = Array.prototype.slice.call(arguments, 2);
  if (!contract.chain.includes("goal_set")) {
    return {
      success: false,
      contract,
      error: new AntiDoteError("CONTRACT_FAILED", {
        reason: "Cannot execute before goal contract is set",
        chain: contract.chain,
      }),
    };
  }
  contract.execution.startedAt = new Date().toISOString();
  contract.chain.push("executing");
  try {
    const result = await missionFn.apply(null, args);
    contract.execution.completedAt = new Date().toISOString();
    contract.execution.success = result.success !== false;
    contract.execution.result = result;
    contract.chain.push("executed");
    return { success: true, contract, result, error: null };
  } catch (err) {
    contract.execution.completedAt = new Date().toISOString();
    contract.execution.success = false;
    contract.execution.error = { message: err.message, stack: err.stack };
    contract.chain.push("execution_failed");
    return {
      success: false,
      contract,
      result: null,
      error: new AntiDoteError("EXECUTION_FAILED", {
        reason: err.message,
        chain: contract.chain,
      }),
    };
  }
}

module.exports = {
  GoalLedger,
  GoalError,
  AntiDoteError,
  ANTIDOTE_ERRORS,
  STATUS_WORDS,
  MATCH_MODES,
  matches,
  createContract,
  validateInput,
  checkProof,
  setGoalContract,
  executeContract,
};
