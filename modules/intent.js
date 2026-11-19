"use strict";

const fs = require("fs");
const path = require("path");

// Deterministic intent labels, modes and validation.

const LABELS = Object.freeze([
  "chat",
  "question",
  "search",
  "review",
  "debug",
  "change",
  "execute",
  "release",
]);

const MODES = Object.freeze(["advisory", "execution"]);
const EXECUTION_LABELS = new Set(["change", "execute", "release"]);

class IntentError extends Error {
  constructor(detail) {
    super("Invalid intent: " + detail);
    this.name = "IntentError";
    this.code = "ZC_INTENT_INVALID";
  }
}

// Order matters: the highest score wins, and ties fall back to this precedence
// (action > diagnosis > question > chat).
const RULES = [
  {
    label: "release",
    weight: 4,
    pattern: /\b(release|ship|publish|rollout|gate|go-live)\b|\u09B0\u09BF\u09B2\u09BF\u099C|\u09AA\u09CD\u09B0\u0995\u09BE\u09B6|\u09B6\u09BF\u09AA/i,
  },
  {
    label: "execute",
    weight: 3,
    pattern: /\b(implement|build|create|add|write|generate|scaffold|migrate|install|refactor)\b|\u09A4\u09C8\u09B0\u09BF\s*\u0995\u09B0|\u09AC\u09BE\u09A8\u09BE\u0993|\u09B2\u09BF\u0996|\u09AF\u09CB\u0997\s*\u0995\u09B0|\u0987\u09A8\u09B8\u09CD\u099F\u09B2/i,
  },
  {
    label: "change",
    weight: 3,
    pattern: /\b(fix|rewrite|replace|remove|delete|update|change|rename|move|patch|correct)\b|\u09A0\u09BF\u0995\s*\u0995\u09B0|\u09B8\u09B0\u09BE\u0993|\u09AE\u09C1\u099B\u09C7|\u09AC\u09A6\u09B2|\u09B0\u09BF\u09AA\u09CD\u09B2\u09C7\u09B8|\u0986\u09AA\u09A1\u09C7\u099F/i,
  },
  {
    label: "debug",
    weight: 3,
    pattern: /\b(error|bug|crash|broken|fails?|failing|stack ?trace|regression|why)\b|\u0995\u09C7\u09A8|\u09B8\u09AE\u09B8\u09CD\u09AF\u09BE|\u0995\u09CD\u09B0\u09CD\u09AF\u09BE\u09B6|\u09AC\u09BE\u0997|\u09AB\u09C7\u09B2/i,
  },
  {
    label: "review",
    weight: 3,
    pattern: /\b(review|audit|inspect|verify|check|validate|lint)\b|\u09B0\u09BF\u09AD\u09BF\u0989|\u09AF\u09BE\u099A\u09BE\u0987|\u09AA\u09B0\u09C0\u0995\u09CD\u09B7\u09BE\s*\u0995\u09B0|\u0985\u09A1\u09BF\u099F/i,
  },
  {
    label: "search",
    weight: 3,
    pattern: /\b(search|lookup|look up|find|google|browse)\b|\u0996\u09C1\u0981\u099C|\u09B8\u09BE\u09B0\u09CD\u099A|\u0996\u09CB\u0981\u099C/i,
  },
  {
    label: "question",
    weight: 2,
    pattern: /\b(what|how|why|when|where|who|which|can|does|is|are|should|could)\b|\u0995\u09C0|\u0995\u09BF\b|\u0995\u09BF\u09AD\u09BE\u09AC\u09C7|\u0995\u09CB\u09A5\u09BE\u09AF\u09BC|\u0995\u09C7\b|\u0995\u09CB\u09A8\u099F\u09BF/i,
  },
];

const TIME_SENSITIVE =
  /\b(latest|today|now|current|news|price|release notes|changelog)\b|\u0986\u099C|\u098F\u0996\u09A8|\u09B8\u09B0\u09CD\u09AC\u09B6\u09C7\u09B7|\u0996\u09AC\u09B0|\u09A6\u09BE\u09AE/i;

function normalize(text) {
  return String(text === undefined || text === null ? "" : text)
    .replace(/\s+/g, " ")
    .trim();
}

function countMatches(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  const matches = text.match(new RegExp(pattern.source, flags));
  return matches ? matches.length : 0;
}

function languageOf(text) {
  return /[\u0980-\u09FF]/.test(text) ? "bn" : "en";
}

function titleOf(text, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 80;
  const clean = normalize(text);
  return clean.length > limit ? clean.slice(0, limit - 3) + "..." : clean;
}

/** Validate an intent object. Returns the same object so callers can chain. */
function validateIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) {
    throw new IntentError("intent must be an object");
  }
  if (!LABELS.includes(intent.label)) {
    throw new IntentError(
      'unknown label "' + String(intent.label) + '" (allowed: ' + LABELS.join(", ") + ")",
    );
  }
  if (!MODES.includes(intent.mode)) {
    throw new IntentError('unknown mode "' + String(intent.mode) + '"');
  }
  if (intent.mode === "execution" && !EXECUTION_LABELS.has(intent.label)) {
    throw new IntentError('label "' + intent.label + '" cannot run in execution mode');
  }
  if (typeof intent.confidence !== "number" || !Number.isFinite(intent.confidence)) {
    throw new IntentError("confidence must be a finite number");
  }
  if (intent.confidence < 0 || intent.confidence > 1) {
    throw new IntentError("confidence must be between 0 and 1");
  }
  if (!normalize(intent.reason)) {
    throw new IntentError("reason is required");
  }
  if (!intent.requires || typeof intent.requires !== "object") {
    throw new IntentError("requires must be an object");
  }
  for (const key of ["web_search", "code_change", "verification", "compiler"]) {
    if (typeof intent.requires[key] !== "boolean") {
      throw new IntentError("requires." + key + " must be a boolean");
    }
  }
  return intent;
}

/**
 * Classify one user input.
 * @param {string} input
 * @param {{channel?: string}} [opts]
 */
function classifyIntent(input, opts) {
  const text = normalize(input);
  const o = opts || {};
  if (!text) {
    return validateIntent({
      label: "chat",
      mode: "advisory",
      confidence: 0.2,
      reason: "empty input",
      language: "en",
      channel: o.channel || "unknown",
      title: "",
      requires: { web_search: false, code_change: false, verification: false, compiler: false },
      matched: [],
    });
  }

  const scored = RULES.map((rule) => {
    const count = countMatches(text, rule.pattern);
    return { label: rule.label, score: count * rule.weight, count };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  let label = "chat";
  let matched = [];
  let confidence = 0.4;

  if (top.score > 0) {
    label = top.label;
    matched = scored.filter((item) => item.count > 0).map((item) => item.label);
    confidence = Math.min(0.95, 0.45 + 0.1 * Math.min(top.count, 4));
  } else if (/\?\s*$/.test(text)) {
    label = "question";
    confidence = 0.55;
    matched = ["question-mark"];
  }

  const execution = EXECUTION_LABELS.has(label);
  const requires = {
    web_search: label === "search" || TIME_SENSITIVE.test(text),
    code_change: execution,
    verification: execution,
    compiler: execution,
  };

  const reason =
    matched.length > 0
      ? "matched " + label + " signals: " + matched.join(", ")
      : "no action signal; treated as conversation";

  return validateIntent({
    label,
    mode: execution ? "execution" : "advisory",
    confidence: Math.round(confidence * 100) / 100,
    reason,
    language: languageOf(text),
    channel: o.channel || "unknown",
    title: titleOf(text),
    requires,
    matched,
  });
}

/**
 * Turn an execution intent into the two mandatory side effects:
 *   - a syllabus entry for this input,
 *   - a goal contract record.
 * A caller that cannot supply a check command still gets a contract, but it is
 * marked UNVERIFIED so nobody can claim success without evidence.
 */
function planExecution(intent, input, opts) {
  const validated = validateIntent(intent);
  if (validated.mode !== "execution") {
    throw new IntentError("planExecution needs an execution intent, got " + validated.mode);
  }
  const o = opts || {};
  const text = normalize(input);
  const expected = normalize(o.expected);
  const check = normalize(o.check);

  return {
    intent: validated,
    syllabus: {
      title: validated.title || titleOf(text),
      input: text,
      label: validated.label,
    },
    goal: {
      goal: normalize(o.goal) || validated.title || titleOf(text),
      input: text,
      expected,
      check,
      pass: normalize(o.pass),
      verification: expected && check ? "contract" : "UNVERIFIED",
      status: "open",
    },
  };
}

const PROMPTS = Object.freeze({
  extract: fs.readFileSync(path.join(__dirname, "prompts", "intent-extract.txt"), "utf8").trim(),
  alignment: fs.readFileSync(path.join(__dirname, "prompts", "alignment-check.txt"), "utf8").trim(),
  proof: fs.readFileSync(path.join(__dirname, "prompts", "proof-check.txt"), "utf8").trim(),
});

module.exports = {
  LABELS,
  MODES,
  EXECUTION_LABELS,
  PROMPTS,
  IntentError,
  normalize,
  titleOf,
  validateIntent,
  classifyIntent,
  planExecution,
};
