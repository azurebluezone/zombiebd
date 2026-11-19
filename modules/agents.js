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

  if (row && Number(row.enabled) !== 0) {
    const persona = clean(row.persona) || clean(fromFile && fromFile.persona);
    if (!persona) {
      throw new AgentError(agentId, "The database row and the agent file both have an empty persona.");
    }
    return {
      id: agentId,
      name: clean(row.name) || clean(fromFile && fromFile.name) || agentId,
      role: clean(row.role) || clean(fromFile && fromFile.role) || "general",
      model: agentFiles.resolveAgentModel(fromFile || { id: agentId }, clean(row.model)),
      persona,
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
    lines.push("host: " + (info.hostname || os.hostname()));
    lines.push("runtime: node " + (info.node || process.version) + " pid " + (info.pid || process.pid));
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
  lines.push("workspace: " + (s.workspace || "(unset)"));
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
          "SELECT id, name, role, model, expertise, persona, enabled, priority FROM agents WHERE enabled = 1 ORDER BY priority ASC, name ASC",
        )
        .all();
      for (const r of rows) {
        if (!r.id) continue;
        seen.add(r.id);
        merged.push({
          id: r.id,
          name: r.name || r.id,
          model: resolveModel(fileAgentById.get(r.id), r.model) || "",
          role: r.role || "general",
          expertise: r.expertise || "",
          priority: r.priority || 99,
          persona: r.persona || "",
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
      continue;
    }
    if (a.persona) {
      const existing = merged.find((m) => m.id === a.id);
      const dbLen = (existing && existing.persona ? existing.persona : "").trim().length;
      const fileLen = a.persona.trim().length;
      if (existing && (!dbLen || (fileLen > dbLen && fileLen > 200))) {
        existing.persona = a.persona;
        existing.persona_source = "agent/*.js";
        log("INFO", "PERSONA_BACKFILL_FROM_FILE", {
          id: a.id,
          from_chars: dbLen,
          to_chars: fileLen,
        });
      }
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
              const idx = merged.findIndex((a) => a.id === custom.id);
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
  defaultAgentId,
  resolveAgent,
  buildAgentSession,
  defaultSystemIdentity,
  renderRuntimeFacts,
  WORKSPACE_MARKER: path.join(".zombiecoder"),
};
