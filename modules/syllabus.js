"use strict";

/**
 * modules/syllabus.js — the only implementation of syllabus reads and writes.
 *
 * The project has exactly one syllabus: `.zombiecoder/syllabus.md`, the same
 * file the OpenCode plugin appends its onboarding and footprint entries to.
 * The old gateway copy `.zombiecoder/agents/syllabus.md` is migrated on first
 * connect and never written again (see modules/workspace.js).
 *
 * Every append must be duplicate-safe:
 *
 *   1. same entry key marker            -> skip ("duplicate")
 *   2. the input excerpt already present -> skip ("plugin-entry")
 *   3. fingerprint changed since read    -> skip ("fingerprint-mismatch")
 *   4. otherwise append atomically and record the new fingerprint
 *
 * The entry carries the exact user input, the validated intent and a bounded
 * excerpt of the prior conversation, so a later agent can reconstruct why the
 * work happened without reading the whole history.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { normalize } = require("./intent");
const adapter = require("./workspace-adapter");
const {
  ensureWorkspace,
  ensureWorkspacePaths,
  readTextCached,
  workspaceFingerprint,
} = require("./workspace");

const PLUGIN_PROBE_CHARS = 80;

// The plugin syllabus is append-only and can grow past 5 MB. Read up to a
// generous ceiling so the newest lessons at the bottom are never cut off.
const SYLLABUS_MAX_BYTES = 16 * 1024 * 1024;

function entryKey(input) {
  return crypto.createHash("sha256").update(normalize(input), "utf8").digest("hex").slice(0, 16);
}

function priorConversation(conversation, maxChars) {
  const limit = Number.isFinite(maxChars) ? maxChars : 600;
  if (!Array.isArray(conversation) || conversation.length === 0) return "";
  const lines = conversation
    .slice(-6)
    .map((turn) => {
      const role = String(turn && turn.role ? turn.role : "user");
      const content = normalize(turn && turn.content);
      if (!content) return "";
      return role + ": " + content.slice(0, 240);
    })
    .filter(Boolean);
  let text = lines.join("\n");
  if (text.length > limit) text = text.slice(0, limit - 3) + "...";
  return text;
}

function renderEntry(spec, key, fingerprint) {
  const lines = [];
  lines.push("### " + spec.title);
  lines.push(
    "<!-- zc-entry:" +
      key +
      " fingerprint:" +
      fingerprint +
      " source:" +
      spec.source +
      " at:" +
      new Date().toISOString() +
      " -->",
  );
  lines.push("- user input: " + normalize(spec.input).slice(0, 600));
  if (spec.intent) {
    lines.push(
      "- intent: " +
        spec.intent.label +
        " / " +
        spec.intent.mode +
        " / confidence " +
        spec.intent.confidence +
        " (" +
        spec.intent.reason +
        ")",
    );
  }
  if (spec.prior) lines.push("- prior conversation:\n" + spec.prior.replace(/\n/g, "\n  "));
  return lines.join("\n");
}

function atomicWrite(file, content) {
  const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Read the canonical project syllabus. The server file is the write target;
 * plugin-only entries from the read-only `.zombiecoder/syllabus.md` are merged
 * into the returned view so the prompt sees both without copying them.
 */
function readSyllabus(projectDir) {
  const paths = ensureWorkspacePaths(projectDir);
  const merged = adapter.readMergedSyllabus(paths.root);
  if (merged.text) return merged.text;
  return readTextCached(paths.syllabus, SYLLABUS_MAX_BYTES).text.trim();
}

/** The first-run content of the canonical syllabus. */
function buildBootstrapTemplate(agents) {
  let fullInstructions = `# Mission Barisal — Complete Agent Syllabus

> Auto-generated from Evidence-Driven documentation.
> Agents MUST read this file before responding.
> Contains ALL rules, personas, and system knowledge.

---

## Latest Learnings

| \u09a4\u09be\u09b0\u09bf\u0996 | \u09b8\u09cb\u09b0\u09cd\u09b8 | \u099f\u09aa\u09bf\u0995 |
|------|-------|-------|
| — | — | Initial syllabus bootstrapped |

---

## 1. CORE SYSTEM IDENTITY

- **Name:** ZombieCoder Mission Barisal v3
- **Owner:** Sahon Srabon (Developer Zone) — Dhaka, Bangladesh
- **Architecture:** Multi-Agent Gateway with Zero Dependencies
- **MCP Protocol:** Model Context Protocol — JSON-RPC 2.0 over SSE/HTTP/UDS

## 2. EVIDENCE-DRIVEN PRINCIPLES

> "First Evidence, Then Conclusion. First Truth, Then Confidence."

### Universal Rules (ALL Agents MUST Follow)
1. **SSOT First** — Never assume. Read SSOT before making claims.
2. **Evidence Before Confidence** — Proof is mandatory. No proof = no answer.
3. **Web Search** — Search for facts when SSOT/syllabus lacks data.
4. **Tool Before Guess** — If a tool is available, USE IT. Don't guess.
5. **State Uncertainty** — If unsure, say it clearly. Never hallucinate.
6. **Normalize Everything** — All outputs must be in standard format.
7. **Respect Reality** — Facts matter more than impressions.
8. **Never Hide Errors** — Report errors transparently.
9. **Explain Reasoning** — Show your work. Explain your logic.
10. **Code in English** — All code, comments, and technical docs in English.
11. **Bengali for Users** — User-facing chat in Bangla (Barishali style).
12. **No Emojis in Code** — Emojis only in user-facing chat responses.

## 3. AGENT PERSONAS

| ID | Name | Role | Priority |
|----|------|------|----------|
`;

  if (Array.isArray(agents)) {
    for (const a of agents) {
      fullInstructions += `| ${a.id} | ${a.name} | ${a.role} | ${a.priority} |\n`;
    }
  }

  fullInstructions += `
### Agent Roles
- **code-guru (Monu):** System Architecture — design patterns, code structure, project organization
- **bug-hunter (Jewel):** Debugging — error handling, logic validation, root cause analysis
- **security-hero (Bablu):** Security — vulnerability assessment, data protection
- **perf-wizard (Rashed):** Performance — optimization, caching, resource management
- **doc-king (Halim):** Documentation — API specs, README, code comments
- **qa-tyrant (Mojnu):** Quality — final verification, consensus, release readiness

## 4. TYPE SAFETY (ANTI-DOTE) SYSTEM

Every execution goes through 6-step anti-dote chain:
1. **validateInput** — Schema enforcement
2. **checkProof** — Logical feasibility
3. **getUserConsent** — User permission
4. **setGoalContract** — Success metrics
5. **execute** — Run mission/task
6. **verifyOutput** — Check against contract

Anti-dote runs on ALL endpoints: /v1/chat/completions, /api/mission, MCP, /api/v1/anti-dote
Monitoring mode: Anti-dote NEVER blocks execution — only reports results.

## 5. CUSTOM PROVIDER SYSTEM

Providers are defined via env vars: CUSTOM_PROVIDER_N_NAME, URL, KEY, MODELS, PRIORITY, TYPE.
Priority-based fallback: If primary provider fails, next priority takes over.
Format normalization: Haq Mawla Normalizer converts ALL provider responses to OpenAI format.

## 6. SESSION & MEMORY

- Sessions auto-verify via /api/verify-session
- SSOT.md holds project state, syllabus.md holds knowledge; both are bounded
- Session archives live in SQLite (data/models.db); per-session transcripts stay JSON in data/
- SSOT, Memory, and Syllabus are BOUNDED parameters — if input falls outside them, agents say "\u0986\u09ae\u09be\u09b0 \u0995\u09be\u099b\u09c7 \u09aa\u09cd\u09b0\u09ae\u09be\u09a3 \u09a8\u09c7\u0987"

## 7. UNIVERSAL SOCKET ARCHITECTURE

Supports: HTTP, SSE, WebSocket, Unix Domain Socket (UDS_PATH / UDS_PORT)
Transport priority: UDS → HTTP → WS (auto-detected based on environment)
cPanel/LiteSpeed: Auto-bypass UDS, fallback to HTTP only

> **Transport scope (evidence-based):** Outbound provider API requests - provider/* adapters via provider/transport.js - use plain TCP http/https (hostname + port from baseUrl); UDS socketPath only when a provider config explicitly sets it. UDS, WebSocket, and SSE are **server-inbound** transports only (the MCP/broker socket and streaming responses), not used for outbound provider calls.

---

*Generated by Mission Barisal v3 — Evidence-Driven, Proof-First*
`;

  return fullInstructions;
}

/**
 * Create the canonical layout and seed the full syllabus when missing.
 * @param {string} projectDir
 * @param {{agents?: Array, log?: Function}} [opts]
 * @returns {{path: string, created: boolean, legacy: object|null}}
 */
function ensureSyllabus(projectDir, opts) {
  const o = opts || {};
  const dir = path.resolve(projectDir || process.cwd());
  const template = buildBootstrapTemplate(o.agents);
  const layout = ensureWorkspace(dir, {
    seedSyllabus: () => template,
  });
  let text = "";
  try {
    text = fs.existsSync(layout.syllabus)
      ? fs.readFileSync(layout.syllabus, "utf8")
      : "";
  } catch (_) {
    text = "";
  }
  let created = layout.created.includes(layout.syllabus);
  if (text.trim().length < 50) {
    fs.mkdirSync(path.dirname(layout.syllabus), { recursive: true });
    atomicWrite(layout.syllabus, template);
    created = true;
  }
  if (typeof o.log === "function") {
    o.log("INFO", created ? "SYLLABUS_BOOTSTRAPPED" : "SYLLABUS_EXISTS", {
      path: layout.syllabus,
      size: template.length,
      legacy_migrated: Boolean(layout.legacy && layout.legacy.migrated),
      legacy_duplicate: Boolean(layout.legacy && layout.legacy.duplicate),
    });
  }
  return { path: layout.syllabus, created, legacy: layout.legacy || null };
}

/**
 * Append a learning entry to the canonical syllabus and refresh the
 * "Latest Learnings" table. Returns false only on a write failure.
 */
function recordLearning(projectDir, topic, entry, opts) {
  const o = opts || {};
  const dir = path.resolve(projectDir || process.cwd());
  const layout = ensureWorkspace(dir);
  const file = layout.syllabus;
  const e = entry || {};
  const date = e.date || new Date().toISOString().slice(0, 10);
  const md = `
### ${topic}
- **Source:** ${e.source || "Unknown"}
- **Date:** ${date}
- **Summary:** ${e.summary || ""}
- **Key Points:**
${(e.keyPoints || []).map((kp) => `  - ${kp}`).join("\n")}
${e.gitHubLink ? `- **GitHub Skill Link:** ${e.gitHubLink}\n` : ""}${e.usedIn ? `- **Used In:** ${e.usedIn}\n` : ""}
`;
  try {
    fs.appendFileSync(file, md, "utf8");
    updateLatestLearnings(file, topic, date, e.source);
    if (typeof o.log === "function") {
      o.log("INFO", "SYLLABUS_UPDATED", { topic, date, path: file });
    }
    return true;
  } catch (err) {
    if (typeof o.log === "function") {
      o.log("WARN", "SYLLABUS_WRITE_FAIL", { error: err.message });
    }
    return false;
  }
}

/** Internal: prepend one row to the "Latest Learnings" table. */
function updateLatestLearnings(file, topic, date, source) {
  try {
    if (!fs.existsSync(file)) return;
    let content = fs.readFileSync(file, "utf8");
    const tableLine = `| ${date} | ${source || "—"} | ${topic} |\n`;
    const tableMarker =
      "| \u09a4\u09be\u09b0\u09bf\u0996 | \u09b8\u09cb\u09b0\u09cd\u09b8 | \u099f\u09aa\u09bf\u0995 |";

    if (content.includes(tableMarker)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(tableMarker)) {
          lines.splice(i + 2, 0, tableLine.trimEnd());
          break;
        }
      }
      fs.writeFileSync(file, lines.join("\n"), "utf8");
      return;
    }

    const tableSection =
      "## Latest Learnings\n\n" +
      "| \u09a4\u09be\u09b0\u09bf\u0996 | \u09b8\u09cb\u09b0\u09cd\u09b8 | \u099f\u09aa\u09bf\u0995 |\n" +
      "|------|-------|-------|\n" +
      tableLine.trimEnd() + "\n\n---";
    content = content.replace(/^---/m, tableSection);
    fs.writeFileSync(file, content, "utf8");
  } catch (_) {
    /* non-critical */
  }
}

/**
 * Append one syllabus entry unless it is already recorded.
 * @param {{dir: string, input: string, title?: string, intent?: object,
 *          conversation?: Array, source?: string, expectedFingerprint?: string}} spec
 */
function appendSyllabusEntry(spec) {
  const s = spec || {};
  const dir = path.resolve(s.dir || process.cwd());
  const input = normalize(s.input);
  if (!input) {
    return { written: false, skipped: true, reason: "empty-input" };
  }

  ensureWorkspace(dir);
  const paths = ensureWorkspacePaths(dir);
  const before = workspaceFingerprint(dir);
  if (s.expectedFingerprint && s.expectedFingerprint !== before.combined) {
    return {
      written: false,
      skipped: true,
      reason: "fingerprint-mismatch",
      expected: s.expectedFingerprint,
      actual: before.combined,
    };
  }

  const existing = fs.existsSync(paths.syllabus) ? fs.readFileSync(paths.syllabus, "utf8") : "";
  // Deduplicate against the merged view: an entry the plugin already wrote
  // must not be copied into the server file just because the server copy is new.
  const mergedExisting = adapter.readMergedSyllabus(dir).text || existing;
  const key = entryKey(input);
  if (mergedExisting.includes("zc-entry:" + key)) {
    return { written: false, skipped: true, reason: "duplicate", key, path: paths.syllabus };
  }

  const probe = input.slice(0, PLUGIN_PROBE_CHARS);
  if (probe.length >= 20 && mergedExisting.includes(probe)) {
    return { written: false, skipped: true, reason: "plugin-entry", key, path: paths.syllabus };
  }

  const title =
    normalize(s.title) ||
    (input.length > 80 ? input.slice(0, 77) + "..." : input);
  const entry = renderEntry(
    {
      title,
      input,
      intent: s.intent,
      prior: priorConversation(s.conversation),
      source: normalize(s.source) || "runtime",
    },
    key,
    before.combined,
  );

  const next = existing.replace(/\s*$/, "") + "\n\n" + entry + "\n";
  atomicWrite(paths.syllabus, next);
  const after = workspaceFingerprint(dir);

  return {
    written: true,
    skipped: false,
    key,
    path: paths.syllabus,
    fingerprint_before: before.combined,
    fingerprint_after: after.combined,
    chars_added: entry.length,
  };
}

module.exports = {
  PLUGIN_PROBE_CHARS,
  SYLLABUS_MAX_BYTES,
  entryKey,
  priorConversation,
  readSyllabus,
  buildBootstrapTemplate,
  ensureSyllabus,
  recordLearning,
  updateLatestLearnings,
  appendSyllabusEntry,
};
