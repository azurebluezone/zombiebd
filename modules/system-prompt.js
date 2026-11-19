"use strict";

/**
 * modules/system-prompt.js — one prompt, one budget.
 *
 * Sections, in order:
 *   1. agent header        (who answers)
 *   2. system identity     (server/domain/type — injected by the caller)
 *   3. runtime facts       (OS, arch, node, workspace)
 *   4. session metadata    (session id, client, editor, source)
 *   5. persona             (resolved agent persona)
 *   6. rules               (short, non-negotiable)
 *   7. project context     (already-bounded excerpt from modules/context.js)
 *   8. tool note / code safety / mission format
 *
 * The assembled prompt is cut to `maxChars` deterministically: context shrinks
 * first, persona second. A model never receives a megabyte of hidden context.
 */

const { renderRuntimeFacts } = require("./agents");
const { stripInvisible } = require("../lib/text-integrity.js");

const DEFAULT_MAX_CHARS = 6000;

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function identityBlock(identity, detail) {
  const i = identity || {};
  const full = detail !== false;
  const lines = [];
  if (i.name) lines.push("system: " + i.name + (i.version ? " " + i.version : ""));
  if (i.product) lines.push("product: " + i.product);
  if (i.type) lines.push("type: " + i.type);
  if (i.domain) lines.push("domain: " + i.domain);
  if (full && i.runtime) lines.push("runtime: " + i.runtime);
  if (full && i.tagline) lines.push("tagline: " + i.tagline);
  if (full && i.owner) {
    lines.push("owner: " + i.owner + (i.organization ? " (" + i.organization + ")" : ""));
  }
  if (full && i.location) lines.push("location: " + i.location);
  if (full && i.license) lines.push("license: " + i.license);
  const anchor = full ? clean(i.anchor) : "";
  if (!lines.length && !anchor) return "";
  const block = ["SYSTEM IDENTITY", lines.join("\n")].filter(Boolean).join("\n");
  if (!anchor) return block;
  return (
    block +
    "\nIdentity anchor (state this exactly when asked who you are):\n" +
    anchor
  );
}

function metadataBlock(metadata, detail) {
  const m = metadata || {};
  const known = ["session_id", "client", "client_version", "editor", "editor_version", "source", "os_platform"];
  const lines = [];
  for (const key of known) {
    const value = clean(m[key]);
    if (value) lines.push(key + ": " + value);
  }
  const extra = {};
  for (const [key, value] of Object.entries(m)) {
    if (known.includes(key) || value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      extra[key] = value;
    }
  }
  const extraKeys = detail === false ? [] : Object.keys(extra);
  if (extraKeys.length) {
    const bounded = JSON.stringify(extra).slice(0, 400);
    lines.push("extra: " + bounded);
  }
  return lines.length ? "SESSION METADATA\n" + lines.join("\n") : "";
}

function buildSystemPrompt(spec) {
  const s = spec || {};
  const maxChars = Number.isFinite(s.maxChars) ? s.maxChars : DEFAULT_MAX_CHARS;
  const agent = s.agent || {};
  const session = s.session || {};
  const persona = stripInvisible(
    clean(s.persona) || clean(session.persona) || clean(agent.persona),
  );
  if (!agent.id || !persona) {
    throw new Error("buildSystemPrompt needs a resolved agent (id + persona)");
  }

  const header =
    "You are " +
    (agent.name || agent.id) +
    " (agent id: " +
    agent.id +
    ", role: " +
    (agent.role || "general") +
    ").";

  const compact = s.compact === true;
  const rules = [
    "Rules: answer directly in the user's language.",
    "Never present an assumption as fact; if you cannot prove it, say UNVERIFIED and stop.",
    "Never reveal model or provider names.",
  ].join(" ");

  const fixed = [header, identityBlock(session.system_identity, !compact), "RUNTIME FACTS\n" + renderRuntimeFacts(session, { compact }), metadataBlock(session.metadata, !compact), rules]
    .filter(Boolean)
    .join("\n\n");

  const tail = [];
  if (Number.isInteger(s.toolsCount) && s.toolsCount > 0) {
    tail.push(
      s.toolsCount +
        " tools are available in the function definitions. Call them directly; do not describe them in prose.",
    );
  }
  if (s.involvesCode) {
    tail.push(
      "Code safety: state the exact file and lines; never claim a change works without test evidence; say UNTESTED when it is not verified.",
    );
  }
  if (s.mission) {
    tail.push("Output format: plain text, concise. You may request a web search with: web_search: <query>");
  }
  const tailText = tail.join("\n\n");

  const contextText = stripInvisible(clean(s.context));
  const fixedChars = fixed.length + tailText.length + 4;
  let remaining = maxChars - fixedChars;

  // Persona is the agent's identity; context is optional. Reserve at least
  // 60% of the free room for the persona and give the rest to context.
  const personaFloor = Math.min(persona.length, Math.max(200, Math.floor(remaining * 0.6)));
  const contextBudget = Math.max(0, Math.min(contextText.length, remaining - personaFloor));

  let personaOut = persona;
  if (persona.length > remaining - contextBudget) {
    const room = Math.max(120, remaining - contextBudget);
    personaOut = persona.slice(0, room) + " ...";
  }

  const contextOut = contextBudget > 0 ? contextText.slice(0, contextBudget) : "";
  const parts = [fixed];
  parts.push("PERSONA\n" + personaOut);
  if (contextOut) parts.push(contextOut);
  if (tailText) parts.push(tailText);

  let content = parts.join("\n\n");
  if (content.length > maxChars) {
    const suffix = "\n...[prompt cut]";
    content = content.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
  }

  return content;
}

// Conservative token estimate: ASCII ~4 chars/token, non-ASCII (Bengali,
// CJK) ~1.5 chars/token. Overestimating is safer than an upstream overflow.
function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let ascii = 0;
  let wide = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide / 1.5);
}

function estimateMessages(messages) {
  let total = 0;
  for (const m of messages || []) total += estimateTokens(JSON.stringify(m));
  return total;
}

// Fit messages + tools into a provider budget without breaking the
// assistant.tool_calls -> tool result pairing. Trims tool results first,
// then drops the oldest complete turns, then shrinks the tool catalog.
function fitPrompt(spec) {
  const s = spec || {};
  const maxTokens = Number(s.maxTokens) || 0;
  const maxToolChars = Number.isFinite(s.maxToolChars) ? s.maxToolChars : 3000;
  const maxMessageChars = Number.isFinite(s.maxMessageChars) ? s.maxMessageChars : 4000;
  const messages = (Array.isArray(s.messages) ? s.messages : []).map((m) => ({ ...m }));
  const tools = Array.isArray(s.tools) ? s.tools.slice() : [];
  const count = () => estimateMessages(messages) + estimateTokens(JSON.stringify(tools));
  if (!maxTokens) return { messages, tools, tokens: count(), trimmed: false };

  let trimmed = false;
  for (const m of messages) {
    if (typeof m.content !== "string") continue;
    const cap = m.role === "tool" ? maxToolChars : maxMessageChars;
    if (m.content.length > cap) {
      m.content = m.content.slice(0, Math.max(0, cap - 16)) + "\n...[truncated]";
      trimmed = true;
    }
  }

  while (count() > maxTokens && messages.length > 2) {
    const firstNonSystem = messages.findIndex((m) => m.role !== "system");
    if (firstNonSystem < 0) break;
    const lastUser = messages.reduce((acc, m, i) => (m.role === "user" ? i : acc), -1);
    if (lastUser <= firstNonSystem) break;
    messages.splice(firstNonSystem, lastUser - firstNonSystem);
    trimmed = true;
  }

  while (count() > maxTokens && tools.length > 1) {
    tools.pop();
    trimmed = true;
  }

  return { messages, tools, tokens: count(), trimmed };
}

module.exports = {
  buildSystemPrompt,
  estimateTokens,
  estimateMessages,
  fitPrompt,
  DEFAULT_MAX_CHARS,
};
