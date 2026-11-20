"use strict";

/**
 * lib/admin-routes.js - gateway-owned DB mutation routes.
 *
 * Scope: provider registry, model enable/disable and agent-to-model routing.
 * This module owns no socket, opens no polling loop, and loads no UI file.
 * The admin page is only one client: the same routes serve curl, scripts or
 * any future panel. api.js mounts the module and supplies auth, response and
 * DB helpers through ctx, so there is one implementation, not a second copy.
 */

function isRoutingRoute(url, method) {
  if (url === "/api/admin/providers" && (method === "GET" || method === "POST")) {
    return true;
  }
  if (url.startsWith("/api/admin/providers/") && method === "DELETE") return true;
  if (url === "/api/admin/models" && method === "POST") return true;
  if (url === "/api/admin/agents" && (method === "GET" || method === "POST")) {
    return true;
  }
  if (url.startsWith("/api/admin/agents/") && method === "DELETE") return true;
  return false;
}

async function readJson(ctx, req, res) {
  const body = await ctx.readBody(req);
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (_) {
    ctx.jsonResponse(res, 400, { error: "Invalid JSON" });
    return { ok: false };
  }
}

async function handle(ctx, req, res, url, method) {
  if (!isRoutingRoute(url, method)) return false;

  if (!ctx.adminAuthorized(req)) {
    ctx.jsonResponse(res, 401, { error: "Unauthorized: ADMIN_TOKEN required" });
    return true;
  }

  // ─── Agents: DB-first routing table ─────────────────────────
  if (url === "/api/admin/agents" && method === "GET") {
    const db = ctx.db;
    if (!db) {
      ctx.jsonResponse(res, 503, { error: "sqlite unavailable" });
      return true;
    }
    const rows = db.prepare(
      "SELECT id, name, role, model, expertise, persona, enabled, priority, updated_at FROM agents ORDER BY priority ASC, name ASC",
    ).all();
    ctx.jsonResponse(res, 200, { count: rows.length, agents: rows });
    return true;
  }

  if (url === "/api/admin/agents" && method === "POST") {
    const db = ctx.db;
    if (!db) {
      ctx.jsonResponse(res, 503, { error: "sqlite unavailable" });
      return true;
    }
    const parsed = await readJson(ctx, req, res);
    if (!parsed.ok) return true;
    const a = parsed.value;
    if (!a || !a.id) {
      ctx.jsonResponse(res, 400, { error: "id is required" });
      return true;
    }
    const existing = db.prepare(
      "SELECT name, role, model, expertise, persona, enabled, priority FROM agents WHERE id = ?",
    ).get(a.id);
    // persona required only when CREATING — updates (model mapping,
    // enable/disable) may omit it and inherit the stored persona.
    if (!a.persona && !existing) {
      ctx.jsonResponse(res, 400, { error: "id and persona are required" });
      return true;
    }
    const now = Date.now();
    db.prepare(`
      INSERT INTO agents (id, name, role, model, expertise, persona, enabled, priority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        model = excluded.model,
        expertise = excluded.expertise,
        persona = excluded.persona,
        enabled = excluded.enabled,
        priority = excluded.priority,
        updated_at = excluded.updated_at
    `).run(
      a.id,
      a.name || existing?.name || a.id,
      a.role || existing?.role || "general",
      a.model || existing?.model || "",
      a.expertise || existing?.expertise || "",
      a.persona || existing?.persona || "Agent",
      a.enabled === undefined
        ? (existing?.enabled === undefined ? 1 : existing.enabled)
        : a.enabled ? 1 : 0,
      a.priority || existing?.priority || 99,
      now,
    );
    await ctx.refreshAgents();
    ctx.jsonResponse(res, 200, { ok: true, id: a.id, totalAgents: ctx.agents.length });
    return true;
  }

  if (url.startsWith("/api/admin/agents/") && method === "DELETE") {
    const db = ctx.db;
    if (!db) {
      ctx.jsonResponse(res, 503, { error: "sqlite unavailable" });
      return true;
    }
    const id = decodeURIComponent(url.slice("/api/admin/agents/".length));
    db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    await ctx.refreshAgents();
    ctx.jsonResponse(res, 200, { ok: true, id, totalAgents: ctx.agents.length });
    return true;
  }

  // ─── Providers: DB/env key origin, enable/disable, save, delete ──
  if (url === "/api/admin/providers" && method === "GET") {
    ctx.jsonResponse(res, 200, {
      ok: true,
      providers: Object.entries(ctx.PROVIDER_CONFIG)
        .sort(
          ([, a], [, b]) =>
            ctx.providerPriority(a) - ctx.providerPriority(b) ||
            String(a.name || "").localeCompare(String(b.name || "")),
        )
        .map(([id, p]) => ctx.providerSummary(id, p)),
    });
    return true;
  }

  if (url === "/api/admin/providers" && method === "POST") {
    const parsed = await readJson(ctx, req, res);
    if (!parsed.ok) return true;
    const b = parsed.value;
    const action = String((b && b.action) || "").toLowerCase();
    const isToggle =
      action === "toggle" ||
      (!action &&
        b &&
        b.id &&
        b.enabled !== undefined &&
        b.name === undefined &&
        b.baseUrl === undefined &&
        b.socketPath === undefined &&
        b.apiKey === undefined &&
        b.type === undefined);
    if (isToggle) {
      if (!b || !b.id || !ctx.PROVIDER_CONFIG[b.id]) {
        ctx.jsonResponse(res, 404, { error: "Unknown provider: " + (b && b.id) });
        return true;
      }
      const provider = ctx.PROVIDER_CONFIG[b.id];
      // Env is the off switch of last resort. A runtime toggle must not reopen
      // a provider that OPENCODE_ENABLED=false (or an equivalent env flag)
      // closed; only changing the env flag and restarting can do that.
      if (b.enabled && provider.envDisabled === true) {
        ctx.log("WARN", "ADMIN_PROVIDER_TOGGLE_REFUSED", {
          provider: b.id,
          reason: "env-disabled",
        });
        ctx.jsonResponse(res, 409, {
          ok: false,
          id: b.id,
          enabled: false,
          envDisabled: true,
          error:
            "Provider " +
            b.id +
            " is disabled by the environment (envDisabled). " +
            "Change its env flag and restart instead of toggling it.",
        });
        return true;
      }
      provider.enabled = b.enabled ? true : false;
      const off = ctx.persistProviderDisabled();
      ctx.normalizeProviderPriorities("providerToggle");
      ctx.refreshFreeModels();
      ctx.log("INFO", "ADMIN_PROVIDER_TOGGLE", {
        provider: b.id,
        enabled: ctx.PROVIDER_CONFIG[b.id].enabled,
        disabled_list: off,
      });
      ctx.jsonResponse(res, 200, {
        ok: true,
        id: b.id,
        enabled: ctx.PROVIDER_CONFIG[b.id].enabled,
        disabledProviders: off,
      });
      return true;
    }
    if (
      action === "save" ||
      (b &&
        (b.name !== undefined ||
          b.baseUrl !== undefined ||
          b.socketPath !== undefined ||
          b.type !== undefined ||
          b.apiKey !== undefined))
    ) {
      const saved = await ctx.saveProviderFromAdmin(b);
      ctx.jsonResponse(res, saved.status, saved.payload);
      return true;
    }
    ctx.jsonResponse(res, 400, { error: "Unsupported provider action" });
    return true;
  }

  if (url.startsWith("/api/admin/providers/") && method === "DELETE") {
    const providerId = decodeURIComponent(
      url.slice("/api/admin/providers/".length),
    );
    const removed = ctx.deleteProviderFromAdmin(providerId);
    ctx.jsonResponse(res, removed.status, removed.payload);
    return true;
  }

  // ─── Models: per-model enable/disable ───────────────────────
  if (url === "/api/admin/models" && method === "POST") {
    const db = ctx.db;
    if (!db) {
      ctx.jsonResponse(res, 503, { error: "sqlite unavailable" });
      return true;
    }
    const parsed = await readJson(ctx, req, res);
    if (!parsed.ok) return true;
    const b = parsed.value;
    if (!b || !b.provider || !b.name) {
      ctx.jsonResponse(res, 400, { error: "provider and name are required" });
      return true;
    }
    const r = db.prepare(
      "UPDATE models SET enabled = ? WHERE provider = ? AND name = ?",
    ).run(b.enabled ? 1 : 0, b.provider, b.name);
    if (r.changes === 0) {
      ctx.jsonResponse(res, 404, { error: "Model not found in DB" });
      return true;
    }
    if (b.enabled) ctx.DISABLED_MODELS.delete(b.provider + "::" + b.name);
    else ctx.DISABLED_MODELS.add(b.provider + "::" + b.name);
    ctx.log("INFO", "ADMIN_MODEL_TOGGLE", {
      provider: b.provider,
      name: b.name,
      enabled: !!b.enabled,
    });
    ctx.jsonResponse(res, 200, {
      ok: true,
      provider: b.provider,
      name: b.name,
      enabled: !!b.enabled,
      disabledCount: ctx.DISABLED_MODELS.size,
    });
    return true;
  }

  return false;
}

module.exports = { handle, isRoutingRoute };
