#!/usr/bin/env node
"use strict";

// Local skill CLI. Read-only; resolves skills/skills.db relative to this repo,
// so it works from any editor or working directory.
//
//   node scripts/skill.js route <query>
//   node scripts/skill.js get <slug>
//   node scripts/skill.js doctor

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "skills", "skills.db");
const { openStore } = require(path.join(ROOT, "modules", "skill-db.js"));
const { compactCard } = require(path.join(ROOT, "modules", "skill-parser.js"));

function usage() {
  console.error("usage: node scripts/skill.js route <query> | get <slug> | doctor");
  process.exitCode = 2;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") return usage();
  const store = openStore(DB);
  try {
    if (command === "route") {
      const query = rest.join(" ").trim();
      if (!query) return usage();
      const matches = store.route(query, 5, 3.0);
      if (!matches.length) {
        console.error("no matching skill for: " + query);
        process.exitCode = 1;
        return;
      }
      for (const match of matches) console.log(match.slug);
      return;
    }
    if (command === "get") {
      const slug = String(rest[0] || "").trim();
      if (!slug) return usage();
      const skill = store.get(slug);
      if (!skill) {
        console.error("skill not found: " + slug);
        process.exitCode = 1;
        return;
      }
      console.log(compactCard(skill, 1200));
      return;
    }
    if (command === "doctor") {
      const stats = store.stats();
      console.log("SKILLS_DB " + DB);
      console.log("SKILLS_STATS active=" + stats.active + " terms=" + stats.terms);
      if (!(stats.active > 0)) {
        console.error("SKILLS_DOCTOR_FAIL active=" + stats.active);
        process.exitCode = 1;
        return;
      }
      console.log("SKILLS_DOCTOR_OK");
      return;
    }
    usage();
  } finally {
    store.close();
  }
}

try {
  main();
} catch (error) {
  console.error("SKILLS_CLI_ERROR " + (error && error.message));
  process.exitCode = 1;
}