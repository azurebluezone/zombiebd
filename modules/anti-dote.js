"use strict";

// modules/anti-dote.js — the anti-dote monitor, extracted from api.js.
//
// The monitor observes the six-step chain and NEVER blocks execution. The
// old strict wrapper (wrapWithAntiDote) was never called by any route and
// only existed to block on a consent flag; it has been removed so the code
// matches the documented contract: monitoring mode reports, it does not
// stop the mission.

const goals = require("./goals.js");
const verify = require("./verify.js");
const { sanitizeForModel } = require("../lib/text-integrity.js");

async function antiDoteMonitor(missionFn, input, ...args) {
  const startTime = Date.now();
  const chainLog = [];

  // Model-bound input: zero-width joiners, BOM and control characters are
  // removed before validation, so they cannot consume tokens or hide text.
  const sanitized = sanitizeForModel(String(input === undefined || input === null ? "" : input));
  const safeInput = sanitized.text;

  const logChain = (step, status, detail) => {
    const entry = { step, status, detail, time: Date.now() - startTime };
    chainLog.push(entry);
    const color =
      status === "PASSED"
        ? "\x1b[32m"
        : status === "FAILED"
          ? "\x1b[31m"
          : "\x1b[33m";
    const reset = "\x1b[0m";
    console.log(
      `  ${color}[ANTI-DOTE]${reset} ${step.padEnd(15)} ${status.padEnd(8)} ${detail}`,
    );
  };
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  const cyan = "\x1b[36m";
  const yellow = "\x1b[33m";

  console.log(
    `\n${bold}${cyan}══════════════════ ANTI-DOTE MONITOR ══════════════════${reset}`,
  );
  console.log(`  ${bold}Input:${reset} "${safeInput.slice(0, 80)}..."`);
  console.log(
    `  ${bold}Mode:${reset} Non-blocking monitoring ${yellow}(execution proceeds regardless)${reset}\n`,
  );
  if (sanitized.total > 0) {
    logChain(
      "sanitize",
      "CLEANED",
      `${sanitized.total} invisible/control character(s) removed`,
    );
  }

  // Step 1: Validate
  const { valid, contract, error: vErr } = goals.validateInput(safeInput);
  if (!valid) {
    logChain("validate", "FAILED", vErr.message);
    console.log(
      `  ${bold} ANTI-DOTE: Validation failed, but execution continues (monitoring mode)${reset}\n`,
    );
    // Still execute the mission even if validation fails.
    try {
      const result = await missionFn(safeInput, ...args);
      console.log(
        `  ${bold}${cyan}══════════════ ANTI-DOTE MONITOR (execution result) ══════════════${reset}\n`,
      );
      return {
        ...result,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: vErr.message,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: vErr.message,
        },
      };
    }
  }
  logChain("validate", "PASSED", `Input valid (${safeInput.length} chars)`);

  // Step 2: Proof Check
  const { provable, error: pErr } = goals.checkProof(contract);
  if (!provable) {
    logChain("proof_check", "FAILED", pErr.message);
    console.log(
      `  ${bold} ANTI-DOTE: Proof check failed, but execution continues${reset}\n`,
    );
    try {
      const result = await missionFn(safeInput, ...args);
      console.log(
        `  ${bold}${cyan}══════════════ ANTI-DOTE MONITOR (execution result) ══════════════${reset}\n`,
      );
      return {
        ...result,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: pErr.message,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        antiDoteMonitor: {
          applied: true,
          passed: false,
          chain: chainLog,
          error: pErr.message,
        },
      };
    }
  }
  logChain("proof_check", "PASSED", `Complexity: ${contract.proof.complexity}`);

  // Step 3: Goal Contract (skip consent in monitoring mode)
  const { contracted, error: cErr } = goals.setGoalContract(contract);
  if (!contracted) {
    logChain("goal_contract", "FAILED", cErr.message);
  } else {
    logChain(
      "goal_contract",
      "PASSED",
      `Type: ${contract.goal.type}, ${contract.goal.successCriteria.length} criteria`,
    );
  }
  // In monitoring mode, always proceed to execution.

  // Step 5: Execute (always run the actual mission)
  let eSuccess = true;
  let eResult = null;
  let eErr2 = null;
  try {
    eResult = await missionFn(safeInput, ...args);
    eSuccess = eResult?.success !== false;
    logChain(
      "execute",
      eSuccess ? "PASSED" : "FAILED",
      `Done in ${Date.now() - startTime}ms`,
    );
    if (!eSuccess) eErr2 = eResult?.error || "Execution returned success=false";
  } catch (err) {
    eSuccess = false;
    eErr2 = err.message;
    logChain("execute", "FAILED", err.message);
  }

  // Step 6: Verify (if we have a contract and results)
  let verified = false;
  let verificationScore = 0;
  let verificationIssues = [];
  let verificationChecks = [];
  if (contracted && eResult) {
    contract.execution = {
      completedAt: new Date().toISOString(),
      success: eSuccess,
      result: eResult,
    };
    contract.chain.push("executed");
    const vResult = verify.verifyContract(contract);
    verified = vResult.verified;
    verificationScore = contract.verification.score;
    verificationIssues = contract.verification.issues;
    verificationChecks = contract.verification.checks;
    logChain(
      "verify",
      verified ? "PASSED" : "FAILED",
      `Score: ${verificationScore}/100, Issues: ${verificationIssues.length}`,
    );
  } else {
    logChain(
      "verify",
      "SKIPPED",
      "No verification (contract or result missing)",
    );
  }

  // Visual summary
  const statusColor = verified ? "\x1b[32m" : "\x1b[31m";
  console.log(
    `\n  ${bold}${statusColor} ANTI-DOTE VERDICT: ${verified ? "PASSED ✓" : "FAILED ✗"}${reset}`,
  );
  console.log(`  ${bold}Score:${reset} ${verificationScore}/100`);
  if (verificationIssues.length > 0) {
    console.log(`  ${bold}Issues:${reset}`);
    for (const issue of verificationIssues) {
      console.log(`    • ${issue}`);
    }
  }
  console.log(
    `${bold}${cyan}══════════════════════════════════════════════════════${reset}\n`,
  );

  // Return augmented result
  const baseResult = eResult || { success: eSuccess, combined: "" };
  return {
    ...baseResult,
    antiDoteMonitor: {
      applied: true,
      passed: verified,
      score: verificationScore,
      issues: verificationIssues,
      checks: verificationChecks,
      chain: chainLog,
      elapsed: Date.now() - startTime,
      sanitized: sanitized.total,
      error: eErr2 || undefined,
    },
  };
}

module.exports = { antiDoteMonitor };
