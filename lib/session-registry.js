"use strict";

/**
 * lib/session-registry.js — the API session registry.
 *
 * modules/sessions.js is the agent-turn SessionStore (bounded RAM + JSONL
 * archive). This is the HTTP/MCP client registry: sessions.json, the
 * per-session workspace map, the client→session reuse map, and the expiry
 * sweep. They are deliberately different stores, so the API one now lives in
 * this module rather than as a 270-line block inside api.js.
 */

module.exports = function createSessionRegistry(deps) {
  const d = deps || {};
  const fs = d.fs || require("fs");
  const path = d.path || require("path");
  const crypto = d.crypto || require("crypto");
  const dataDir = d.dataDir;
  const log = d.log || (() => {});
  const SESSION_TTL_MS = d.sessionTtlMs || 24 * 60 * 60 * 1000;
  const archiveSession = d.archiveSession || (() => {});
  const identityMetadata = d.identityMetadata || (() => ({}));
  const systemIdentityCore = d.systemIdentityCore || (() => ({}));
  const writeLockLog = d.writeLockLog || (() => {});
  const workingDir = d.workingDir || (() => process.cwd());

  const SESSIONS_FILE = path.join(dataDir, "sessions.json");
  const activeSessions = new Map(); // in-memory cache (id → session)
  const clientSessions = new Map(); // client_id → session_id (for same-client reuse)
  const sessionDirs = new Map(); // sessionId → workingDir (per-session workspace)
  const sessionBuffer = new Map(); // sessionId → data (batch update buffer)
  
  function readSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    try {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || [];
    } catch (e) {
      return [];
    }
  }
  
  function writeSessions(sessions) {
    try {
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      // Synchronous + atomic. The old fs.promises.writeFile let two
      // createSession calls race: B read sessions.json before A's async write
      // landed and then overwrote the file with only B. Session writes are rare
      // (create, expire, flush) and the file is small, so sync is the safe trade.
      const tmp = SESSIONS_FILE + ".tmp-" + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2));
      fs.renameSync(tmp, SESSIONS_FILE);
    } catch (e) {
      log("ERROR", "WRITE_SESSIONS_FAILED", { error: e.message });
    }
  }
  
  function cleanExpired() {
    const sessions = readSessions();
    const now = Date.now();
    const expired = sessions.filter(
      (s) => new Date(s.expires_at).getTime() <= now,
    );
    const active = sessions.filter((s) => new Date(s.expires_at).getTime() > now);
  
    if (expired.length > 0) {
      // Archive expired sessions before removing them
      for (const s of expired) {
        // Clean up clientSessions mapping
        for (const [key, sid] of clientSessions) {
          if (sid === s.id) {
            clientSessions.delete(key);
            break;
          }
        }
        try {
          archiveSession(
            workingDir(),
            s.id,
            [],
            `Session expired after ${s.messages || 0} messages [${s.model || "unknown"}@${s.provider || "unknown"}]`,
          );
        } catch (_) {
          /* single archive fail should not block cleanup */
        }
      }
      writeSessions(active);
    }
    // Sync in-memory cache
    for (const s of active) activeSessions.set(s.id, s);
  
    try {
      const dataDir = dataDir;
      if (fs.existsSync(dataDir)) {
        const entries = fs.readdirSync(dataDir);
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
        for (const entry of entries) {
          if (uuidPattern.test(entry)) {
            const entryPath = path.join(dataDir, entry);
            try {
              const stat = fs.statSync(entryPath);
              if (
                stat.isDirectory() &&
                Date.now() - stat.mtimeMs > SEVEN_DAYS_MS
              ) {
                fs.rmSync(entryPath, { recursive: true, force: true });
                log("INFO", "DATA_CLEANED", { path: entryPath });
              }
            } catch (_) {
              /* individual folder cleanup failure should not block */
            }
          }
        }
      }
    } catch (_) {
      /* data cleanup is best-effort */
    }
  
    return active;
  }
  
  function createSession(clientId, editor, ip, customId, extraMeta) {
    // ── Session Reuse: if same client has an active session, return it ──
    if (!customId) {
      const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
      const existingId = clientSessions.get(clientKey);
      if (existingId) {
        const existing = getSession(existingId);
        if (existing) {
          // Touch: extend expiry on reuse
          existing.expires_at = new Date(
            Date.now() + SESSION_TTL_MS,
          ).toISOString();
          if (editor && editor !== "unknown") existing.editor = editor;
          // Merge any new metadata
          if (extraMeta) {
            existing.metadata = { ...(existing.metadata || {}), ...extraMeta };
          }
          if (existing.metadata && !existing.metadata.system_identity) {
            existing.metadata.system_identity = identityMetadata(systemIdentityCore());
          }
          activeSessions.set(existing.id, existing);
          log("INFO", "SESSION_REUSE", {
            id: existing.id.slice(0, 8),
            client_id: clientKey,
            client_id_source: (extraMeta && extraMeta.client_id_source) || "unknown",
            messages: existing.messages,
          });
          return existing;
        }
        // Stale entry — remove and fall through to create
        clientSessions.delete(clientKey);
      }
    }
  
    const sessions = cleanExpired();
    const id = customId || crypto.randomUUID();
    const now = Date.now();
    const session = {
      id,
      conversation_id: id, // each session has its own conversation_id
      client_id: clientId || "anonymous",
      editor: editor || "unknown",
      ip: ip || "",
      model: "",
      provider: "",
      messages: 0,
      status: "active",
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
      // ── Extended metadata from headers ──
      metadata: {
        agent_id: extraMeta?.agent_id || "",
        user_agent: extraMeta?.user_agent || "",
        device_info: extraMeta?.device_info || "",
        editor_version: extraMeta?.editor_version || "",
        os_platform: extraMeta?.os_platform || "",
        client_version: extraMeta?.client_version || "",
        session_source: extraMeta?.session_source || "mcp",
        // The user's chosen workspace. Persisted so a restart can rebuild the
        // in-memory sessionDirs map instead of silently falling back to the
        // server checkout.
        working_dir: extraMeta?.working_dir || "",
        // Every session carries the immutable system identity, so an archived
        // session can never lose track of which system produced it.
        system_identity: identityMetadata(systemIdentityCore()),
      },
    };
    sessions.push(session);
    activeSessions.set(id, session);
    writeSessions(sessions);
    // Register client → session mapping for reuse
    if (!customId) {
      const clientKey = (clientId || "anonymous") + ":" + (editor || "unknown");
      clientSessions.set(clientKey, id);
    }
    log("INFO", "SESSION_CREATE", {
      id: id.slice(0, 8),
      editor,
      client_id_source: (extraMeta && extraMeta.client_id_source) || "unknown",
    });
    // Lock log: session created
    writeLockLog({
      lock_id: "sess-" + id.slice(0, 12),
      agent: "system",
      operation: "session_create",
      status: "success",
      duration_ms: Date.now() - now,
      details: { client_id: clientId, editor },
      session_id: id,
    });
    return session;
  }
  
  /**
   * Create or reuse a session and bind its working directory.
   *
   * `sessionDirs` is the in-memory source for the agent tool loop; the same value
   * is persisted in `session.metadata.working_dir` so `/api/sessions` and a
   * restart can see it. This is the one place that turns "the user picked a
   * folder" into "a real session owns that folder".
   */
  function ensureSessionForDir(opts) {
    const o = opts || {};
    const dir = o.workingDir ? path.resolve(String(o.workingDir)) : "";
    const wanted = o.sessionId ? String(o.sessionId).trim() : "";
    let session = wanted ? getSession(wanted) : null;
  
    if (session) {
      if (dir) {
        session.metadata = { ...(session.metadata || {}), working_dir: dir };
        session.expires_at = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        activeSessions.set(session.id, session);
        sessionDirs.set(session.id, dir);
        updateSession(session.id, {
          metadata: session.metadata,
          expires_at: session.expires_at,
        });
        flushAllSessions();
      }
      return session;
    }
  
    session = createSession(
      o.clientId || "mcp",
      o.editor || "mcp",
      o.ip || "",
      wanted || crypto.randomUUID(),
      {
        session_source: o.source || "mcp",
        working_dir: dir,
        agent_id: o.agentId || "",
      },
    );
    if (dir) sessionDirs.set(session.id, dir);
    return session;
  }
  
  function getSession(id) {
    // Check in-memory first
    if (activeSessions.has(id)) {
      const s = activeSessions.get(id);
      if (new Date(s.expires_at).getTime() > Date.now() && s.status === "active")
        return s;
      activeSessions.delete(id);
    }
    const sessions = cleanExpired();
    const session = sessions.find((s) => s.id === id && s.status === "active");
    if (session) activeSessions.set(id, session);
    return session || null;
  }
  
  function updateSession(id, data) {
    // Buffer session updates to prevent read-modify-write race conditions
    // Same pattern as memoryBuffer — batch flush for thread safety
    const existing = sessionBuffer.get(id) || {};
    const merged = { ...existing, ...data };
    sessionBuffer.set(id, merged);
  }
  
  function flushAllSessions() {
    for (const [id, data] of sessionBuffer) {
      if (Object.keys(data).length === 0) continue;
      try {
        const sessions = readSessions();
        const idx = sessions.findIndex((s) => s.id === id);
        if (idx === -1) continue;
        Object.assign(sessions[idx], data);
        activeSessions.set(id, sessions[idx]);
        writeSessions(sessions);
      } catch (e) {
        log("ERROR", "FLUSH_SESSION_FAILED", { id, error: e.message });
      }
    }
    sessionBuffer.clear();
  }

  return {
    SESSIONS_FILE,
    activeSessions,
    clientSessions,
    sessionDirs,
    sessionBuffer,
    readSessions,
    writeSessions,
    cleanExpired,
    createSession,
    ensureSessionForDir,
    getSession,
    updateSession,
    flushAllSessions,
  };
};
