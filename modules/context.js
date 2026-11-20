"use strict";

/**
 * modules/context.js — precision context, never bulk.
 *
 * The full syllabus/SSOT stay on disk. A request gets:
 *   - the workspace fingerprint (so a stale write is detectable),
 *   - the top input-matched sections under a HARD character budget,
 *   - a retrieval pointer, not the rest of the file.
 *
 * Budgets are enforced after assembly: the returned text can never exceed
 * `totalChars`, no matter how large the source file is. That is the whole
 * point of this module.
 */

const fs = require("fs");
const path = require("path");

const { splitByHeadings, tokenize } = require("../tools/context-slimmer");
const adapter = require("./workspace-adapter");
const {
  ensureWorkspacePaths,
  readTextCached,
  workspaceFingerprint,
} = require("./workspace");

const DEFAULT_BUDGET = Object.freeze({
  ssotChars: 900,
  syllabusChars: 1200,
  totalChars: 2400,
});

// Directories that never carry project context.
const SKIP_DIRS = new Set([
  ".git",
  ".zombiecoder",
  "node_modules",
  "dist",
  "cache",
  "logs",
  "tmp",
  "data",
  "coverage",
]);

function scoreEntry(queryTokens, entry) {
  if (!queryTokens.size) return 0;
  const title = tokenize(entry.title);
  const body = tokenize(entry.text);
  let score = 0;
  for (const token of queryTokens) {
    if (title.has(token)) score += 2;
    else if (body.has(token)) score += 1;
  }
  return score;
}

/**
 * Select the most relevant sections and cut them to a hard budget.
 * @param {string} fullText
 * @param {string} input
 * @param {{maxChars: number, maxEntries: number, fallback: "first"|"last"}} opts
 */
function pickEntries(fullText, input, opts) {
  const o = opts || {};
  const maxChars = Number.isFinite(o.maxChars) ? o.maxChars : 900;
  const maxEntries = Number.isFinite(o.maxEntries) ? o.maxEntries : 3;
  if (!fullText || !String(fullText).trim()) {
    return { body: "", matched: [], total: 0, truncated: false };
  }

  const entries = splitByHeadings(fullText);
  const query = tokenize(input);
  const scored = entries
    .map((entry, index) => ({ entry, index, score: scoreEntry(query, entry) }))
    .sort((a, b) => b.score - a.score);

  const keep = [];
  for (const item of scored) {
    if (item.score > 0 && keep.length < maxEntries) keep.push(item);
  }
  if (!keep.length && entries.length && o.fallback !== "none") {
    const fallbackIndex = o.fallback === "last" ? entries.length - 1 : 0;
    keep.push({ entry: entries[fallbackIndex], index: fallbackIndex, score: 0 });
  }
  keep.sort((a, b) => a.index - b.index);

  let body = keep.map((item) => item.entry.text).join("\n\n").trim();
  let truncated = false;
  if (body.length > maxChars) {
    const suffix = "\n...[excerpt cut]";
    body = body.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
    truncated = true;
  }
  return {
    body,
    matched: keep.map((item) => item.entry.title).filter(Boolean),
    total: entries.length,
    truncated,
  };
}

/**
 * Build the bounded project context for one input.
 * @param {{dir: string, input: string, budget?: object}} spec
 */
function sliceContext(spec) {
  const s = spec || {};
  const dir = path.resolve(s.dir || process.cwd());
  const input = String(s.input || "");
  const budget = Object.assign({}, DEFAULT_BUDGET, s.budget || {});
  const paths = ensureWorkspacePaths(dir);

  const ssotRead = readTextCached(paths.ssot);
  // The server syllabus is the write target; the plugin syllabus is a
  // read-only input merged into the view. Never copy the whole plugin file
  // into the prompt.
  const mergedSyllabus = adapter.readMergedSyllabus(dir);
  const syllabusText = mergedSyllabus.text || readTextCached(paths.syllabus).text;
  const fingerprint = workspaceFingerprint(dir);

  const ssot = pickEntries(ssotRead.text, input, {
    maxChars: budget.ssotChars,
    maxEntries: 2,
    fallback: "first",
  });
  const syllabus = pickEntries(syllabusText, input, {
    maxChars: budget.syllabusChars,
    maxEntries: 3,
    fallback: "last",
  });

  const parts = [];
  if (ssot.body) {
    parts.push(
      "PROJECT SSOT (input-matched excerpt; full file at .zombie/SSOT.md):\n" +
        ssot.body +
        "\n--- END SSOT EXCERPT ---",
    );
  }
  if (syllabus.body) {
    parts.push(
      "AGENT SYLLABUS (input-matched excerpt; full file at .zombie/syllabus.md; plugin entries merged read-only):\n" +
        syllabus.body +
        "\n--- END SYLLABUS EXCERPT ---",
    );
  }
  parts.push(
    "Context fingerprint: " +
      fingerprint.combined +
      " (ssot " +
      fingerprint.ssot +
      ", syllabus " +
      fingerprint.syllabus +
      "). Read the full files with read_file only when this excerpt is not enough.",
  );

  let text = parts.join("\n\n");
  let truncated = ssot.truncated || syllabus.truncated;
  if (text.length > budget.totalChars) {
    const suffix = "\n...[context cut]";
    text = text.slice(0, Math.max(0, budget.totalChars - suffix.length)) + suffix;
    truncated = true;
  }

  return {
    dir,
    text,
    chars: text.length,
    fingerprint: fingerprint.combined,
    fingerprint_detail: fingerprint,
    sections: {
      ssot: ssot.body.length,
      syllabus: syllabus.body.length,
      ssot_total_sections: ssot.total,
      syllabus_total_sections: syllabus.total,
      ssot_matched: ssot.matched,
      syllabus_matched: syllabus.matched,
    },
    truncated,
    pointers: {
      ssot: paths.ssot,
      syllabus: paths.syllabus,
    },
  };
}

/**
 * Build the full bounded prompt context for one turn:
 *   input-matched SSOT/syllabus + fingerprint + last N session turns + open goal.
 *
 * The session store is the server-owned `SessionStore`; the goal ledger is the
 * server-owned `GoalLedger`. Both are optional so callers that already have a
 * bounded turn list can pass it directly.
 *
 * @param {{dir: string, input: string, sessionId?: string,
 *          sessions?: {recentTurns: Function}, turns?: Array,
 *          goals?: {active: Function}, goal?: object,
 *          turnLimit?: number, maxChars?: number}} spec
 */
function buildPromptContext(spec) {
  const s = spec || {};
  const base = sliceContext({ dir: s.dir, input: s.input, budget: s.budget });

  const turnLimit = Number.isInteger(s.turnLimit) && s.turnLimit > 0 ? s.turnLimit : 10;
  let turns = Array.isArray(s.turns) ? s.turns : [];
  if (!turns.length && s.sessions && s.sessionId && typeof s.sessions.recentTurns === "function") {
    turns = s.sessions.recentTurns(s.sessionId, turnLimit) || [];
  }
  turns = turns.slice(-turnLimit);

  const goal =
    s.goal ||
    (s.goals && typeof s.goals.active === "function" ? s.goals.active() : null) ||
    null;

  const parts = [base.text];
  if (turns.length) {
    const lines = turns.map((turn) => {
      const role = String((turn && turn.role) || "user");
      const content = String((turn && turn.content) || "").replace(/\s+/g, " ").trim();
      return role + ": " + content.slice(0, 400);
    });
    parts.push(
      "SESSION MEMORY (last " +
        turns.length +
        " turns, server SessionStore):\n" +
        lines.join("\n") +
        "\n--- END SESSION MEMORY ---",
    );
  }
  if (goal) {
    parts.push(
      "ACTIVE GOAL (" +
        String(goal.id || "goal") +
        "):\n" +
        String(goal.goal || "") +
        "\nExpected marker: " +
        String(goal.expected || "") +
        "\nCheck: " +
        String(goal.check || "") +
        "\n--- END ACTIVE GOAL ---",
    );
  }
  const workspaceId = s.workspaceId || adapter.workspaceId(base.dir);
  parts.push("Workspace id: " + workspaceId);

  let text = parts.join("\n\n");
  const maxChars = Number.isFinite(s.maxChars) ? s.maxChars : 6000;
  let truncated = base.truncated;
  if (text.length > maxChars) {
    text = text.slice(0, Math.max(0, maxChars - 18)) + "\n...[context cut]";
    truncated = true;
  }

  return Object.assign({}, base, {
    text,
    chars: text.length,
    turns,
    goal,
    workspaceId,
    truncated,
  });
}

function listCandidateFiles(dir, maxScan) {
  const limit = Number.isFinite(maxScan) ? maxScan : 200;
  const files = [];
  const walk = (current, depth) => {
    if (files.length >= limit || depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && /\.(md|json|js|ts|py|sh|yml|yaml|toml)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(dir, 0);
  return files;
}

/**
 * Score files by name + first 4 KB. Returns paths only — the model reads the
 * chosen file itself, so the prompt never carries a file dump.
 */
function findRelevantFiles(dir, input, opts) {
  const o = opts || {};
  const limit = Number.isFinite(o.limit) ? o.limit : 5;
  const root = path.resolve(dir || process.cwd());
  const query = tokenize(input);
  if (!query.size) return [];

  const results = [];
  for (const file of listCandidateFiles(root, o.maxScan)) {
    const rel = path.relative(root, file);
    const nameTokens = tokenize(rel.replace(/[\\/]/g, " "));
    let score = 0;
    for (const token of query) {
      if (nameTokens.has(token)) score += 3;
    }
    const head = readTextCached(file, 4096).text;
    if (head) {
      const bodyTokens = tokenize(head);
      for (const token of query) {
        if (bodyTokens.has(token)) score += 1;
      }
    }
    if (score > 0) results.push({ path: rel, score });
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return results.slice(0, limit);
}

module.exports = {
  DEFAULT_BUDGET,
  pickEntries,
  sliceContext,
  buildPromptContext,
  findRelevantFiles,
};
