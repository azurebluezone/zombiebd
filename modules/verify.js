"use strict";

const { AntiDoteError } = require("./goals.js");

// Release gate: answer, alignment, and evidence for success claims.

const SUCCESS_CLAIM =
  /\b(done|fixed|passes?|passing|working|deployed|complete[ds]?|implemented|resolved|works)\b|\u09B9\u09AF\u09BC\u09C7\s*\u0997\u09C7\u099B\u09C7|\u09B8\u09AE\u09CD\u09AA\u09A8\u09CD\u09A8|\u09A0\u09BF\u0995\s*\u0995\u09B0\u09C7\u099B\u09BF|\u0995\u09BE\u099C\s*\u0995\u09B0\u099B\u09C7/i;

const EVIDENCE =
  /\b(exit\s*(code)?\s*0|PASS|HTTP\s*[1-5]\d\d|VERIFIED)\b|[\w./-]+\.(js|cjs|mjs|json|md|sh|py|ts|yml|yaml)\b|`[^`]+`/i;

const UNCERTAINTY = /\b(UNVERIFIED|NOT_TESTED|cannot|unknown|unsure)\b|\u09A8\u09BF\u09B6\u09CD\u099A\u09BF\u09A4\s*\u09A8\u0987|\u09AA\u09CD\u09B0\u09AE\u09BE\u09A3\s*\u09A8\u09C7\u0987/i;

function significantTokens(input) {
  const words = String(input || "")
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{3,}/gu);
  return words ? Array.from(new Set(words)).slice(0, 20) : [];
}

/**
 * @param {{input: string, intent?: object, output: string, evidence?: string[]}} spec
 * @returns {{passed: boolean, checks: Array, reasons: string[]}}
 */
function verifyOutput(spec) {
  const s = spec || {};
  const output = String(s.output === undefined || s.output === null ? "" : s.output);
  const input = String(s.input || "");
  const intent = s.intent || null;
  const evidence = Array.isArray(s.evidence) ? s.evidence.filter(Boolean) : [];
  const checks = [];
  const reasons = [];

  const add = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: detail || "" });
    if (!ok) reasons.push(name + (detail ? ": " + detail : ""));
  };

  add("non-empty", output.trim().length > 0, "answer is empty");

  const tokens = significantTokens(input);
  const lowered = output.toLowerCase();
  const overlap = tokens.filter((token) => lowered.includes(token));
  const aligned = tokens.length === 0 || overlap.length > 0 || UNCERTAINTY.test(output);
  add(
    "intent-alignment",
    aligned,
    "answer shares none of the input terms: " + tokens.slice(0, 6).join(", "),
  );

  const claimsSuccess = SUCCESS_CLAIM.test(output);
  const hasEvidence = EVIDENCE.test(output) || evidence.length > 0;
  add(
    "evidence-for-success",
    !claimsSuccess || hasEvidence,
    "success is claimed without a path, command, exit code or PASS marker",
  );

  const mode = intent && intent.mode ? intent.mode : "advisory";
  if (mode === "execution") {
    const artifact = EVIDENCE.test(output) || evidence.length > 0;
    add("execution-artifact", artifact, "execution answer names no changed file or check");
  }

  if (intent && intent.requires && intent.requires.compiler) {
    add(
      "compiler-evidence",
      /node --check|npm run build|BUILD_OK|COMPILE_OK|exit\s*(code)?\s*0/i.test(output) ||
        evidence.length > 0,
      "compiler pass was required but not evidenced",
    );
  }

  return { passed: reasons.length === 0, checks, reasons };
}

function verifyContract(contract) {
  if (!contract.chain.includes("executed")) {
    return {
      verified: false,
      contract,
      error: new AntiDoteError("VERIFICATION_FAILED", {
        reason: "Cannot verify before execution",
        chain: contract.chain,
      }),
    };
  }

  const result = contract.execution.result;
  const goal = contract.goal;
  // STRICT: Start at 0, earn your score!
  const verification = { passed: false, score: 0, issues: [], checks: [] };

  if (!result || result.success === false) {
    verification.passed = false;
    verification.score = 0;
    verification.issues.push("Mission execution failed");
    verification.checks.push({ check: "execution_success", passed: false });
    contract.verification = {
      ...verification,
      verifiedAt: new Date().toISOString(),
    };
    contract.chain.push("verified_failed");
    return { verified: false, contract, result };
  }

  const combined = result.combined || "";
  const stats = result.stats || {};

  // ─── CHECK 1: Execution success (mandatory — 0 score if failed) ───
  // Already handled above — if we reach here, execution succeeded

  // ─── CHECK 2: Combined output exists and has substance ───
  // BUG #8 FIX: Check content quality, not just length
  if (!combined || combined.length < 10) {
    verification.score -= 20;
    verification.issues.push("Combined output too short or empty");
    verification.checks.push({ check: "has_output", passed: false });
  } else {
    // Quality checks: has structure, has evidence, not just filler
    const hasHeaders = /#{1,3}\s/.test(combined) || /\n[-=]{3,}/.test(combined);
    const hasBulletPoints =
      /[\-\*]\s/.test(combined) || /\d+\.\s/.test(combined);
    const hasCodeBlocks =
      /```[\s\S]*?```/.test(combined) || /`[^`]+`/.test(combined);
    const wordCount = combined.split(/\s+/).length;
    const hasSubstance = wordCount > 30; // At least 30 words for a real answer
    const qualityScore =
      (hasHeaders ? 3 : 0) +
      (hasBulletPoints ? 3 : 0) +
      (hasCodeBlocks ? 3 : 0) +
      (hasSubstance ? 6 : 0);
    verification.score += Math.min(15, qualityScore);
    verification.checks.push({
      check: "has_output",
      passed: true,
      detail: `${combined.length} chars, ${wordCount} words, quality=${qualityScore}/15`,
    });
  }

  // ─── CHECK 3: Agents responded ───
  if (!stats || stats.responded === 0) {
    verification.score -= 30;
    verification.issues.push("No agents responded");
    verification.checks.push({ check: "agents_responded", passed: false });
  } else {
    const rate = stats.responded / (stats.totalAgents || 1);
    if (rate < 0.3) {
      verification.score -= 15;
      verification.issues.push(
        "Too few agents responded (" +
        stats.responded +
        "/" +
        stats.totalAgents +
        ")",
      );
      verification.checks.push({
        check: "agents_responded",
        passed: false,
        detail: stats.responded + "/" + stats.totalAgents,
      });
    } else {
      const points = Math.min(20, Math.round(rate * 15));
      verification.score += points;
      verification.checks.push({
        check: "agents_responded",
        passed: true,
        detail: stats.responded + "/" + stats.totalAgents,
      });
    }
  }

  // ─── CHECK 4: Cross-verification was done ───
  // BUG #8 FIX: Count-based verification, not just boolean
  const verifData = result.verification || {};
  if (verifData.verified === true) {
    // Bonus for cross-verification rounds
    const rounds = verifData.rounds || 0;
    const challenges = verifData.challenges || 0;
    const debateCount = verifData.debates || 0;
    const verificationDepth = Math.min(
      15,
      10 + rounds * 2 + (challenges > 0 ? 3 : 0) + (debateCount > 0 ? 2 : 0),
    );
    verification.score += verificationDepth;
    verification.checks.push({
      check: "cross_verified",
      passed: true,
      detail: `${rounds} rounds, ${challenges} challenges, ${debateCount} debates — depth=${verificationDepth}`,
    });
  } else {
    verification.score -= 10;
    verification.issues.push("Cross-verification not completed");
    verification.checks.push({ check: "cross_verified", passed: false });
  }

  // ─── CHECK 5: Debates conducted (evidence of multi-agent review) ───
  const debateCount = verifData.debates || 0;
  if (debateCount > 0) {
    verification.score += 10;
    verification.checks.push({
      check: "debate_conducted",
      passed: true,
      detail: debateCount + " debates",
    });
  } else {
    verification.score -= 5;
    verification.checks.push({ check: "debate_conducted", passed: false });
  }

  // ─── CHECK 6: Code safety (when applicable) ───
  // BUG #8 FIX: More robust code safety checking
  if (goal.requiresCodeSafety && combined) {
    const hasFileRefs =
      /\b(server\/|src\/|app\/|lib\/|components\/|\.js|\.py|\.ts)\b/.test(
        combined,
      );
    const hasLineRefs = /\b(line\s+\d+|L\d+|\u09b2\u09be\u0987\u09a8\s+\d+)\b/i.test(combined);
    const hasTestMention = /\b(test|tested|verified|untested|UNTESTED)\b/i.test(
      combined,
    );
    const hasCodeBlocks = /```[\s\S]*?```/.test(combined);
    const hasSpecificChanges =
      /\b(changed|updated|modified|added|removed|replaced)\b/i.test(combined);

    let codeScore = 0;
    let codeDetail = [];
    if (hasFileRefs) {
      codeScore += 5;
      codeDetail.push("file refs");
    }
    if (hasLineRefs) {
      codeScore += 3;
      codeDetail.push("line refs");
    }
    if (hasTestMention) {
      codeScore += 3;
      codeDetail.push("test mention");
    }
    if (hasCodeBlocks) {
      codeScore += 2;
      codeDetail.push("code blocks");
    }
    if (hasSpecificChanges) {
      codeScore += 2;
      codeDetail.push("specific changes");
    }

    if (codeScore >= 10) {
      verification.score += 15;
      verification.checks.push({
        check: "code_safety",
        passed: true,
        detail: codeDetail.join(", ") + " — comprehensive",
      });
    } else if (codeScore >= 5) {
      verification.score += 5;
      verification.checks.push({
        check: "code_safety",
        passed: true,
        detail: codeDetail.join(", ") + " — partial",
      });
    } else {
      verification.score -= 15;
      verification.issues.push(
        "Code claims without file references — cannot verify",
      );
      verification.checks.push({
        check: "code_safety",
        passed: false,
        detail: "No file references found",
      });
    }
  }

  // CHECK 7: Language match
  const bengaliChars = combined.match(/[\u0980-\u09FF]/g);
  if (bengaliChars && bengaliChars.length > 5) {
    verification.score += 5;
    verification.checks.push({ check: "language_match", passed: true });
  }

  // CHECK 8: Hallucination scan — detect unsupported claims
  const lowContent = combined.toLowerCase();
  const weakPhrases = [
    /it will work/i,
    /this should fix/i,
    /it should work/i,
    /trust me/i,
    /definitely works/i,
    /i think/i,
    /probably/i,
    /may work/i,
    /might work/i,
    /could work/i,
    /i believe/i,
  ];
  let weakCount = 0;
  for (const phrase of weakPhrases) {
    if (phrase.test(lowContent)) {
      weakCount++;
    }
  }
  if (weakCount > 0) {
    verification.score -= weakCount * 10;
    verification.issues.push(
      weakCount + " unsupported/weak claim(s) detected in output",
    );
    verification.checks.push({
      check: "hallucination_scan",
      passed: false,
      detail: weakCount + " weak claims",
    });
  } else {
    verification.score += 5;
    verification.checks.push({ check: "hallucination_scan", passed: true });
  }

  // ─── FINAL: Clamp score 0-100, set pass/fail ───
  verification.score = Math.max(0, Math.min(100, verification.score));
  // STRICT: Minimum 75 to pass
  const PASS_THRESHOLD = 75;
  verification.passed = verification.score >= PASS_THRESHOLD;

  if (!verification.passed) {
    verification.issues.push(
      "Score " +
      verification.score +
      "/100 below threshold (" +
      PASS_THRESHOLD +
      ")",
    );
  }

  contract.verification = {
    ...verification,
    verifiedAt: new Date().toISOString(),
  };
  contract.chain.push(
    verification.passed ? "verified_passed" : "verified_failed",
  );

  return { verified: verification.passed, contract, result };
}


module.exports = {
  verifyContract,
  SUCCESS_CLAIM,
  EVIDENCE,
  UNCERTAINTY,
  significantTokens,
  verifyOutput,
};
