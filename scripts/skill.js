#!/usr/bin/env node
"use strict";

// =============================================================================
// scripts/skill.js — portable CLI for the local skill library
// =============================================================================
// Reads skills/skills.db relative to this repository, so it works from any
// editor, folder or working directory:
//
//   node scripts/skill.js stats
//   node scripts/skill.js route "debug a failing playwright test"
//   node scripts/skill.js get cdp-operations
//   node scripts/skill.js get cdp-operations --full
//
// The database is read-only; no skill body is executed.
// =============================================================================

const path = require("path");
const {
  DEFAULT_DB,
  openStore,
  tokenize,
} = require(path.join(__dirname, "..", "modules", "skill-db.js"));
const {
  DEFAULT_CARD_CHARS,
  compactCard,
  publicMatch,
  fullBody,
} = require(path.join(__dirname, "..", "modules", "skill-parser.js"));

function valueOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
}

function has(flag) {
  return process.argv.includes(flag);
}

function restAfter(command) {
  const index = process.argv.indexOf(command);
  const out = [];
  for (let i = index + 1; i < process.argv.length; i += 1) {
    const value = process.argv[i];
    if (value === "--db" || value === "--limit" || value === "--min-score" || value === "--max-chars") {
      i += 1;
      continue;
    }
    if (value.startsWith("--")) continue;
    out.push(value);
  }
  return out;
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function main() {
  const command = process.argv[2] || "stats";
  const dbPath = valueOf("--db", "");
  const json = has("--json");
  const store = openStore(dbPath || undefined);

  try {
    if (command === "stats") {
      const stats = store.stats();
      if (json) return printJson(stats);
      console.log("database : " + stats.db + " (" + stats.db_bytes + " bytes)");
      console.log("skills   : " + stats.active + " active / " + stats.total + " total");
      console.log("terms    : " + stats.terms);
      console.log("bodies   : " + stats.bytes + " bytes");
      for (const source of stats.sources) {
        console.log("  - " + source.source + ": " + source.skill_count + " skills");
      }
      return;
    }

    if (command === "list") {
      const query = valueOf("--q", "");
      const limit = Number(valueOf("--limit", "50"));
      const items = store.list(query, limit);
      if (json) return printJson(items);
      for (const item of items) {
        console.log(item.slug.padEnd(40) + " " + String(item.source).padEnd(34) + " " + item.name);
      }
      return;
    }

    if (command === "get") {
      const slug = restAfter("get")[0];
      if (!slug) {
        console.error("usage: node scripts/skill.js get <slug> [--full]");
        process.exitCode = 2;
        return;
      }
      const skill = store.get(slug);
      if (!skill) {
        console.error("skill not found: " + slug);
        process.exitCode = 1;
        return;
      }
      if (json) return printJson(skill);
      if (has("--full")) {
        const full = fullBody(skill, Number(valueOf("--max-chars", "0")) || undefined);
        console.log("# " + full.name);
        console.log(
          "slug: " + full.slug + "  source: " + skill.source + "  license: " + (skill.license || "—"),
        );
        console.log("");
        console.log(full.body);
        return;
      }
      console.log(compactCard(skill, Number(valueOf("--max-chars", String(DEFAULT_CARD_CHARS)))));
      return;
    }

    if (command === "route") {
      const text = restAfter("route").join(" ").trim();
      if (!text) {
        console.error("usage: node scripts/skill.js route <text>");
        process.exitCode = 2;
        return;
      }
      const limit = Number(valueOf("--limit", "2"));
      const minScore = Number(valueOf("--min-score", "3"));
      const matches = store.route(text, limit, minScore);
      if (json) {
        return printJson({ text, tokens: tokenize(text).slice(0, 20), matches: matches.map(publicMatch) });
      }
      if (!matches.length) {
        console.log("no match above threshold");
        return;
      }
      for (const match of matches) {
        console.log(String(match.score).padStart(6) + "  " + String(match.slug).padEnd(34) + " " + match.source);
        console.log("        " + (match.description || ""));
      }
      return;
    }

    if (command === "doctor") {
      const stats = store.stats();
      const failures = [];
      if (stats.active < 1) failures.push("database has no active skills");
      if (stats.terms < 100) failures.push("term index looks empty");
      const sample = store.route("debug a failing playwright test", 2, 3.0);
      if (!sample.length) failures.push("sample route returned no match");
      console.log("db        : " + stats.db);
      console.log("skills    : " + stats.active + " active / " + stats.total + " total");
      console.log("terms     : " + stats.terms);
      console.log("sample    : " + (sample.map((match) => match.slug).join(", ") || "none"));
      if (failures.length) {
        for (const failure of failures) console.error("FAIL: " + failure);
        process.exitCode = 1;
        return;
      }
      console.log("SKILLS_DOCTOR_OK");
      return;
    }

    console.error("unknown command: " + command);
    console.error("commands: stats, list, get, route, doctor");
    process.exitCode = 2;
  } finally {
    store.close();
  }
}

if (require.main === module) main();

module.exports = { DEFAULT_DB };
