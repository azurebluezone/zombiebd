"use strict";

// Agent lookup and session injection: DB row, agent file, then a loud error.

const fs = require("fs");
const os = require("os");
const path = require("path");

const agentFiles = require("../agent");
const { compactSystemInfo, collectSystemInfo } = require("../lib/system-info");

class AgentError extends Error {
  constructor(id, detail) {
    super(
      'Agent "' +
        (id || "<empty>") +
        '" could not be resolved from the database or agent/*.js.' +
        (detail ? " " + detail : ""),
    );
    this.name = "AgentError";
    this.code = "ZC_AGENT_NOT_FOUND";
    this.agentId = id || "";
  }
}

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function readAgentRow(db, id) {
  if (!db || typeof db.prepare !== "function") return null;
  try {
    const row = db.prepare("SELECT * FROM agents WHERE id = ? LIMIT 1").get(id);
    return row || null;
  } catch (_) {
    return null;
  }
}

function fileAgent(id, loader) {
  const fn = typeof loader === "function" ? loader : agentFiles.getAgentById;
  try {
    const agent = fn(id);
    return agent && agent.id ? agent : null;
  } catch (_) {
    return null;
  }
}

/**
 * Repair the agents table from agent/*.js.
 *
 * The known corruption is a row whose `persona` column contains the
 * `expertise` text (the old seed copied the wrong field). This function
 * repairs only that deterministic shape, plus an empty persona. It never
 * overwrites a real admin-edited persona, and it never touches model,
 * priority or enabled — those are runtime operator choices.
 *
 * @param {object} db
 * @param {Array} fileAgents
 * @param {{log?: Function}} [opts]
 * @returns {{ok:boolean, inserted:number, repaired:number, kept:number, error?:string}}
 */
function syncAgentPersonas(db, fileAgents, opts) {
  const o = opts || {};
  const log = typeof o.log === "function" ? o.log : function () {};
  const result = { ok: false, inserted: 0, repaired: 0, kept: 0 };
  if (!db || typeof db.prepare !== "function") {
    result.error = "sqlite unavailable";
    return result;
  }
  const list = Array.isArray(fileAgents) ? fileAgents : [];
  try {
    const select = db.prepare(
      "SELECT id, persona, expertise FROM agents WHERE id = ? LIMIT 1",
    );
    const insert = db.prepare(`
      INSERT INTO agents
        (id, name, role, model, expertise, persona, enabled, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const update = db.prepare(
      "UPDATE agents SET persona = ?, updated_at = ? WHERE id = ?",
    );
    const now = Date.now();

    for (const agent of list) {
      if (!agent || !agent.id) continue;
      const persona = clean(agent.persona);
      if (!persona) continue;
      const row = select.get(agent.id);
      if (!row) {
        insert.run(
          agent.id,
          clean(agent.name) || agent.id,
          clean(agent.role) || "general",
          clean(agent.model),
          clean(agent.expertise),
          persona,
          Number.isFinite(Number(agent.priority)) ? Number(agent.priority) : 99,
          now,
        );
        result.inserted++;
        continue;
      }
      const dbPersona = clean(row.persona);
      const expertise = clean(row.expertise);
      const corrupt = !dbPersona || (expertise && dbPersona === expertise);
      if (corrupt) {
        update.run(persona, now, agent.id);
        result.repaired++;
        log("INFO", "AGENT_PERSONA_REPAIRED", {
          id: agent.id,
          from_chars: dbPersona.length,
          to_chars: persona.length,
          reason: dbPersona ? "persona_equals_expertise" : "empty_persona",
        });
      } else {
        result.kept++;
      }
    }
    result.ok = true;
    if (result.inserted || result.repaired) {
      log("INFO", "AGENT_PERSONA_SYNC", {
        inserted: result.inserted,
        repaired: result.repaired,
        kept: result.kept,
      });
    }
    return result;
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
    log("WARN", "AGENT_PERSONA_SYNC_FAIL", { error: result.error });
    return result;
  }
}

/**
 * Resolve one agent definition.
 * @param {string} id
 * @param {{db?: object, fileLoader?: Function}} [opts]
 * @returns {{id, name, role, model, persona, expertise, priority, enabled, source}}
 */
function resolveAgent(id, opts) {
  const o = opts || {};
  const agentId = clean(id);
  if (!agentId) throw new AgentError(agentId, "No agent id was supplied.");

  const fromFile = fileAgent(agentId, o.fileLoader);
  const row = readAgentRow(o.db, agentId);

  if (row) {
    if (Number(row.enabled) === 0) {
      const error = new AgentError(agentId, "This agent is disabled in the database.");
      error.code = "ZC_AGENT_DISABLED";
      throw error;
    }
    const dbPersona = clean(row.persona);
    const persona = dbPersona || clean(fromFile && fromFile.persona);
    if (!persona) {
      throw new AgentError(agentId, "The database row and the agent file both have an empty persona.");
    }
    return {
      id: agentId,
      name: clean(row.name) || clean(fromFile && fromFile.name) || agentId,
      role: clean(row.role) || clean(fromFile && fromFile.role) || "general",
      model: agentFiles.resolveAgentModel(fromFile || { id: agentId }, clean(row.model)),
      persona,
      persona_source: dbPersona ? "db" : "agent/*.js",
      expertise: clean(row.expertise) || clean(fromFile && fromFile.expertise),
      priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 99,
      enabled: 1,
      source: "db",
    };
  }

  if (fromFile) {
    const persona = clean(fromFile.persona);
    if (!persona) throw new AgentError(agentId, "The agent file has an empty persona.");
    return {
      id: agentId,
      name: clean(fromFile.name) || agentId,
      role: clean(fromFile.role) || "general",
      model: agentFiles.resolveAgentModel(fromFile),
      persona,
      expertise: clean(fromFile.expertise),
      priority: Number.isFinite(Number(fromFile.priority)) ? Number(fromFile.priority) : 99,
      enabled: 1,
      source: "persona-default",
    };
  }

  throw new AgentError(agentId, "No database row and no agent/*.js file exist for this id.");
}

/** Default identity when the caller has no domain configuration at hand. */
function defaultAgentId(agents, env) {
  const e = env || process.env;
  const configured = clean(e.DEFAULT_AGENT_ID);
  if (configured) return configured;
  const list = Array.isArray(agents) ? agents : [];
  return list.length > 0 && list[0].id ? list[0].id : "";
}

function defaultSystemIdentity(env) {
  const e = env || process.env;
  return {
    name: clean(e.SERVER_NAME) || "ZombieCoder",
    version: clean(e.SERVER_VERSION) || "",
    type: clean(e.SERVER_TYPE) || "development",
    domain: clean(e.DEPLOY_DOMAIN) || clean(e.MAIN_HOST) || "localhost",
    runtime: "node",
  };
}

/**
 * Build the session object injected into every model call.
 * OS facts are read live; identity/metadata are request-scoped facts.
 */
function buildAgentSession(agent, opts) {
  const o = opts || {};
  if (!agent || !agent.id || !clean(agent.persona)) {
    throw new AgentError(agent && agent.id, "buildAgentSession needs a resolved agent with a persona.");
  }
  const rawInfo = o.osInfo || collectSystemInfo();
  const info = compactSystemInfo(rawInfo);
  const metadata = Object.assign({}, o.metadata || {});
  const workspace = clean(o.workspace) || clean(metadata.workspace);

  return {
    session_id: clean(metadata.session_id) || clean(o.sessionId),
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      source: agent.source,
      model: agent.model || "",
    },
    persona: clean(agent.persona),
    system_identity: o.identity || defaultSystemIdentity(o.env),
    os: info,
    workspace,
    metadata,
    created_at: new Date().toISOString(),
  };
}

/** Workspace label for a model prompt: the project name, never the host path. */
function workspaceLabel(value, opts) {
  const raw = clean(value);
  if (!raw) return "(unset)";
  if (opts && opts.absolutePaths === true) return raw;
  const parts = raw.replace(/[\\/]+$/, "").split(/[\\/]+/);
  return parts[parts.length - 1] || raw;
}

/** Render the compact runtime facts (one line each, no hidden context). */
function renderRuntimeFacts(session, opts) {
  const s = session || {};
  const compact = opts && opts.compact === true;
  const info = s.os || {};
  const memory = info.memory || {};
  const lines = [];
  lines.push(
    "os: " +
      (info.os || os.type()) +
      " " +
      (info.kernel || os.release()) +
      " (" +
      (info.arch || os.arch()) +
      ") platform=" +
      (info.platform || os.platform()),
  );
  if (!compact) {
    if (opts && opts.includeHost === true) {
      // Hostname and pid are host-internal identifiers. They are opt-in so a
      // provider prompt does not leak the machine identity by default.
      lines.push("host: " + (info.hostname || os.hostname()));
      lines.push("runtime: node " + (info.node || process.version) + " pid " + (info.pid || process.pid));
    }
    const cpuRaw = info.cpu;
    const cpuModel =
      cpuRaw && typeof cpuRaw === "object" ? cpuRaw.model : cpuRaw;
    const cpuCores = Number(
      info.cores || (cpuRaw && typeof cpuRaw === "object" ? cpuRaw.cores : 0),
    );
    lines.push(
      "cpu: " +
        (cpuModel || (os.cpus()[0] && os.cpus()[0].model) || "unknown") +
        " x" +
        (cpuCores || os.cpus().length),
    );
    lines.push("memory: " + (memory.free_gb || 0) + "/" + (memory.total_gb || 0) + " GB free");
  }
  lines.push("workspace: " + workspaceLabel(s.workspace, opts));
  return lines.join("\n");
}


function loadAgents(opts) {
  const o = opts || {};
  const db = o.db || null;
  const log = typeof o.log === "function" ? o.log : function () {};
  const resolveModel =
    typeof o.resolveModel === "function" ? o.resolveModel : agentFiles.resolveAgentModel;
  const fileAgents =
    typeof o.fileAgents === "function"
      ? o.fileAgents()
      : Array.isArray(o.fileAgents)
        ? o.fileAgents
        : [];
  const fileAgentById = new Map(fileAgents.map((a) => [a.id, a]));
  const merged = [];
  const seen = new Set();

  if (db && typeof db.prepare === "function") {
    try {
      const rows = db
        .prepare(
          "SELECT id, name, role, model, expertise, persona, enabled, priority FROM agents ORDER BY priority ASC, name ASC",
        )
        .all();
      for (const r of rows) {
        if (!r.id) continue;
        seen.add(r.id);
        if (Number(r.enabled) === 0) {
          // A DB-disabled agent must not be resurrected from agent/*.js.
          log("INFO", "AGENT_DISABLED_DB", { id: r.id });
          continue;
        }
        const fallback = fileAgentById.get(r.id);
        const dbPersona = clean(r.persona);
        merged.push({
          id: r.id,
          name: r.name || r.id,
          model: resolveModel(fallback, r.model) || "",
          role: r.role || "general",
          expertise: r.expertise || "",
          priority: r.priority || 99,
          persona: dbPersona || clean(fallback && fallback.persona),
          persona_source: dbPersona ? "db" : "agent/*.js",
          source: "db",
        });
      }
      if (rows.length > 0) log("INFO", "PERSONAS_DB_LOADED", { count: rows.length });
    } catch (e) {
      log("WARN", "PERSONAS_DB_READ_FAIL", { error: e.message });
    }
  }

  for (const a of fileAgents) {
    if (!a || !a.id) continue;
    if (!seen.has(a.id)) {
      seen.add(a.id);
      merged.push(a);
    }
  }
  if (fileAgents.length > 0) {
    log("INFO", "AGENTS_FILE_LOADED", { source: "agent/*.js", count: fileAgents.length });
  }

  const customDir = o.customDir || "";
  const parseCustom = typeof o.parseCustom === "function" ? o.parseCustom : null;
  if (customDir && parseCustom && fs.existsSync(customDir)) {
    try {
      const files = fs
        .readdirSync(customDir)
        .filter(
          (f) =>
            f.endsWith(".md") &&
            f !== "syllabus.md" &&
            f !== "SSOT.md" &&
            f !== "PERSONAS.md",
        );
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(customDir, f), "utf8");
          const custom = parseCustom(content);
          if (custom && custom.id) {
            if (seen.has(custom.id)) {
              const existing = merged.find((a) => a.id === custom.id);
              const idx = merged.findIndex((a) => a.id === custom.id);
              if (existing && existing.source === "db") {
                // The DB row is the SSOT; a custom markdown file may add a
                // new agent, never replace a stored persona.
                log("INFO", "CUSTOM_AGENT_DB_WINS", { id: custom.id, file: f });
                continue;
              }
              if (idx >= 0) merged[idx] = custom;
            } else {
              seen.add(custom.id);
              merged.push(custom);
            }
          }
        } catch (e) {
          log("WARN", "CUSTOM_AGENT_PARSE_FAIL", { file: f, error: e.message });
        }
      }
    } catch (e) {
      log("WARN", "CUSTOM_AGENTS_SCAN_FAIL", { error: e.message });
    }
  }

  const valid = [];
  for (const a of merged) {
    if (a && a.id && String(a.persona || "").trim()) {
      valid.push(a);
    } else {
      log("WARN", "AGENT_DROPPED_NO_PERSONA", {
        id: (a && a.id) || "(no id)",
        source: (a && a.source) || "unknown",
      });
    }
  }
  return valid;
}

module.exports = {
  AgentError,
  loadAgents,
  syncAgentPersonas,
  defaultAgentId,
  resolveAgent,
  buildAgentSession,
  defaultSystemIdentity,
  renderRuntimeFacts,
  WORKSPACE_MARKER: path.join(".zombiecoder"),
};
