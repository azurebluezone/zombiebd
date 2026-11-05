"use strict";
/**
 * Agent Loader — Mission Barisal v3
 * Loads agent/*.js — the SINGLE source of truth for agent definitions.
 *
 * Priority order:
 *   1. SQLite DB (MODELS_DB) — runtime admin edits
 *   2. agent/*.js — this module (curated defaults; persona lives inline)
 *   3. .zombiecoder/agents/*.md — custom YAML frontmatter overrides
 *   4. DEFAULT_AGENTS — hardcoded minimal fallback (api.js)
 *
 * PERSONAS.md is NO LONGER read. Every agent carries its own `persona`
 * inline, so a missing or stale markdown file can never drop an agent.
 *
 * MODEL RESOLUTION (see resolveAgentModel):
 *   DB model → agent file `fallbackModel` → env AGENT_MODEL → null
 *   A null result is a hard stop: the caller must answer honestly instead
 *   of silently routing the request to an unrelated provider.
 *
 * Zero external dependencies. Pure Node.js fs + path + vm.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/**
 * Resolve which model an agent should run on.
 *
 * @param {object} agent   agent definition (from an agent/*.js file)
 * @param {string} [dbModel] model read from the agents/models table, if any
 * @returns {string|null} canonical model name, or null when nothing resolves.
 *                        null is INTENTIONAL — callers must refuse politely
 *                        rather than guess a provider.
 */
function resolveAgentModel(agent, dbModel) {
  // 1. Runtime DB value (admin-selected) wins when it names a real model.
  if (dbModel && dbModel !== "MODELS_DB") return dbModel;

  // 2. A literal model baked into the agent file.
  if (agent && agent.model && agent.model !== "MODELS_DB") return agent.model;

  // 3. Agent-file fallback — present when the DB has no catalog yet.
  if (agent && agent.fallbackModel) return agent.fallbackModel;

  // 4. Global env escape hatch: one knob for every agent.
  if (process.env.AGENT_MODEL) return process.env.AGENT_MODEL;

  // 5. Nothing. The caller reports this honestly — no silent substitution.
  return null;
}

/**
 * Load all agent config files from this directory (agent/*.js).
 * Returns a sorted array of agent objects. If loading fails, returns an
 * empty array (safe fallback) — never throws into the caller.
 */
function loadAgentFiles() {
  const agentsDir = __dirname;
  const agents = [];

  try {
    const files = fs.readdirSync(agentsDir).filter((f) => {
      return (
        f.endsWith(".js") &&
        f !== "index.js" &&
        !f.startsWith(".") &&
        !f.startsWith("_")
      );
    });

    for (const file of files) {
      try {
        const agentPath = path.join(agentsDir, file);

        // 1. Read file content as a raw string
        let code = fs.readFileSync(agentPath, "utf8");

        // 2. Strip a BOM if one is present at the very start
        if (code.charCodeAt(0) === 0xFEFF) {
          code = code.slice(1);
        }

        // 3. Execute in a sandboxed context to extract exports. This avoids
        //    require() caching issues and parses the clean string directly.
        const sandbox = {
          module: { exports: {} },
          exports: {},
          require: require, // agent files may require other modules
          __filename: agentPath,
          __dirname: agentsDir,
        };

        vm.runInNewContext(code, sandbox, { filename: file, displayErrors: true });

        const agent = sandbox.module.exports || sandbox.exports;

        // Persona lives IN the agent file. A file without one is invalid —
        // we never fall back to an external markdown document.
        const persona = (agent && agent.persona) || "";

        if (agent && agent.id && persona) {
          agents.push({
            id: agent.id,
            name: agent.name || agent.id,
            // "MODELS_DB" is the sentinel meaning "resolve later via the
            // provider ladder" — a literal here would pin the agent forever.
            model: agent.model || "MODELS_DB",
            // Concrete name used only when the DB catalog is unavailable.
            fallbackModel: agent.fallbackModel || "",
            role: agent.role || "general",
            expertise: agent.expertise || "",
            priority: parseInt(agent.priority || "99", 10),
            enabled: agent.enabled !== undefined ? (agent.enabled ? 1 : 0) : 1,
            persona: persona,
            mission: agent.mission || "",
            decisionRule: agent.decisionRule || "",
            corePersona: agent.corePersona || "",
            tags: agent.tags || [],
            source: "agent/*.js",
          });
        } else {
          console.warn(
            `[AGENT_LOADER] Invalid agent structure in ${file} ` +
              `(missing ${!agent ? "module" : !agent.id ? "id" : "persona"})`,
          );
        }
      } catch (e) {
        // Skip individual file errors — never crash the loader
        console.error(`[AGENT_LOADER] Skip ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[AGENT_LOADER] Directory read failed: ${e.message}`);
  }

  // Sort by priority (lower = higher priority)
  agents.sort((a, b) => (a.priority || 99) - (b.priority || 99));

  return agents;
}

/**
 * Get a single agent config by ID from the file system.
 * Returns the agent object, or null when not found.
 */
function getAgentById(agentId) {
  const filePath = path.join(__dirname, `${agentId}.js`);
  if (fs.existsSync(filePath)) {
    try {
      delete require.cache[require.resolve(filePath)];
      return require(filePath);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * Get all agent IDs from the file system.
 */
function listAgentIds() {
  try {
    return fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith(".js") && f !== "index.js" && !f.startsWith(".") && !f.startsWith("_"))
      .map((f) => f.replace(".js", ""));
  } catch (e) {
    return [];
  }
}

module.exports = {
  loadAgentFiles,
  getAgentById,
  listAgentIds,
  resolveAgentModel,
};
