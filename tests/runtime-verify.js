"use strict";
// ─── runtime-verify.js ────────────────────────────────────────────────
// Post-restart runtime verification (2026-10-11, user request):
//   1. Models auto-added from every provider into the DB (no hardcoding)
//   2. Cloudflare removed entirely; dead custom_3 tunnel disabled
//   3. Personas (9 agents) intact
//   4. Tools available via MCP
//   5. REAL call through local Ollama (llama3.2:latest) via the gateway
//
// Run:  node tests/runtime-verify.js
//       (server must be running on http://127.0.0.1:3000)

const BASE = "http://127.0.0.1:" + (process.env.PORT || "3000");
const CHAT_TIMEOUT_MS = 150000;

let pass = 0, fail = 0;
function ok(name, detail) { pass++; console.log("  ✅ " + name + (detail ? " — " + detail : "")); }
function bad(name, detail) { fail++; console.log("  ❌ " + name + (detail ? " — " + detail : "")); }
function section(t) { console.log("\n" + t + "\n" + "─".repeat(Math.min(72, t.length + 6))); }

async function getJson(path, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(BASE + path, { signal: ctrl.signal });
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  } finally { clearTimeout(t); }
}

async function postChat(body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const r = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

// Parse a streamable-HTTP MCP response (pure JSON or SSE frame)
function parseMcpResponse(res) {
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream") || res.body.startsWith("event:")) {
    // SSE: lines "event: message" / "data: {...}" separated by blank lines
    const frames = res.body.split(/\r?\n\r?\n/);
    for (const frame of frames) {
      const dataLine = frame.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try { const j = JSON.parse(payload); if (j.result || j.error) return j; } catch { /* skip */ }
      }
    }
    return null;
  }
  try { return JSON.parse(res.body); } catch { return null; }
}

async function mcpToolsList() {
  // Streamable HTTP MCP: initialize → initialized → tools/list (session id forwarded)
  let sessionId = "";
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  const req = async (body) => {
    const h = Object.assign({}, headers);
    if (sessionId) h["mcp-session-id"] = sessionId;
    const r = await fetch(BASE + "/mcp", { method: "POST", headers: h, body: JSON.stringify(body) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    return { status: r.status, body: await r.text(), headers: r.headers };
  };
  const init = await req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "runtime-verify", version: "1.0" } } });
  const initJson = parseMcpResponse({ headers: init.headers, body: init.body });
  if (!initJson || initJson.error) return { ok: false, error: "initialize failed: " + JSON.stringify(initJson || init.body).slice(0, 200) };
  await req({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
  const tools = await req({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsJson = parseMcpResponse({ headers: tools.headers, body: tools.body });
  if (!toolsJson || toolsJson.error) return { ok: false, error: "tools/list failed: " + JSON.stringify(toolsJson || tools.body).slice(0, 200) };
  const list = (toolsJson.result && toolsJson.result.tools) || [];
  return { ok: true, count: list.length, tools: list.map((t) => t.name) };
}

(async () => {
  console.log("ZombieCoder/Mission Barisal — Runtime Verification");
  console.log("Target: " + BASE + "   (" + new Date().toISOString() + ")\n");

  // ── 1. Health: version + agents + DB-sourced models ─────────────
  section("1. Health — version / agents / models (DB)");
  const h = await getJson("/health");
  if (h.status === 200 && h.json) {
    ok("version = " + h.json.version);
    ok("agents = " + h.json.agents);
    ok("models  = " + h.json.models);
    if (h.json.version && h.json.version !== "3.2.1") bad("version is " + h.json.version + " (expected 3.2.1)");
  } else bad("GET /health", "HTTP " + h.status);

  // ── 2. Personas ────────────────────────────────────────────────
  section("2. Personas (agents)");
  const ag = await getJson("/api/agents");
  if (ag.status === 200 && ag.json) {
    ok("count = " + ag.json.count + " (source " + ag.json.source + ")");
    for (const a of ag.json.agents || []) console.log("      · " + a.id + " — " + (a.name || "") + " [" + (a.role || "").slice(0, 40) + "]");
    if (ag.json.count !== 9) bad("expected 9 personas, got " + ag.json.count);
  } else bad("GET /api/agents", "HTTP " + ag.status);

  // ── 3. Providers in /api/v1/models — no cloudflare/custom_3 ─────
  section("3. Providers & auto-added models (no Cloudflare, no dead tunnel)");
  const pm = await getJson("/api/v1/models");
  if (pm.status === 200 && pm.json && Array.isArray(pm.json.data)) {
    const byProv = {};
    for (const m of pm.json.data) { const p = m.provider || "?"; (byProv[p] = byProv[p] || []).push(m.id); }
    const provs = Object.keys(byProv).sort();
    console.log("      providers: " + provs.join(", "));
    for (const p of provs) console.log("      · " + p + " → " + byProv[p].length + " models" + (byProv[p].slice(0, 4).join(", ") ? "  e.g. " + byProv[p].slice(0, 4).join(", ") : "") + (byProv[p].length > 4 ? " …" : ""));
    if (byProv.cloudflare) bad("cloudflare still present as a provider!");
    else ok("no cloudflare provider");
    if (byProv.custom_3) bad("custom_3 (dead tunnel) still present!");
    else ok("no custom_3 (dead trycloudflare tunnel)");
    if (!byProv.ollama) bad("ollama provider missing!");
    else ok("ollama present (" + byProv.ollama.length + " model)");
    // Every active provider has ≥1 model → auto-add worked from DB/env
    const emptyProvs = Object.entries(byProv).filter(([, m]) => m.length === 0).map(([p]) => p);
    if (emptyProvs.length) bad("providers with 0 models: " + emptyProvs.join(", "));
    else ok("every provider has models (all DB-sourced)");
  } else bad("GET /api/v1/models", "HTTP " + pm.status + " (shape " + (pm.json ? Object.keys(pm.json).join(",") : "none") + ")");

  // ── 4. DB sanity — no cloudflare/custom_3 rows ─────────────────
  section("4. SQLite models.db — DB is the model source of truth");
  try {
    const { DatabaseSync } = require("node:sqlite");
    const s = new DatabaseSync(require("path").join(__dirname, "..", "data", "models.db"));
    const rows = s.prepare("SELECT provider, COUNT(*) c FROM models GROUP BY provider ORDER BY c DESC").all();
    console.log("      " + JSON.stringify(rows));
    const cf = s.prepare("SELECT COUNT(*) c FROM models WHERE provider LIKE ?").get("%cloudflare%").c;
    const ct = s.prepare("SELECT COUNT(*) c FROM models WHERE provider LIKE ?").get("%custom_%").c;
    if (cf > 0 || ct > 0) bad("cloudflare/custom rows still in DB (cf=" + cf + ", custom=" + ct + ")");
    else ok("no cloudflare/custom rows in DB (" + s.prepare("SELECT COUNT(*) c FROM models").get().c + " total)");
  } catch (e) { bad("DB check", e.message); }

  // ── 5. Tools via MCP ───────────────────────────────────────────
  section("5. MCP tools");
  const mcp = await mcpToolsList();
  if (mcp.ok) {
    ok("tools/list → " + mcp.count + " tools");
    console.log("      " + (mcp.tools.slice(0, 12).join(", ") + (mcp.count > 12 ? " …" : "")));
    if (mcp.count === 0) bad("0 tools returned!");
  } else {
    bad("MCP tools/list", mcp.error);
    const info = await getJson("/api/mcp");
    if (info.status === 200 && info.json && info.json.servers) {
      const names = info.json.servers.map((s) => s.name).join(", ");
      console.log("      fallback: /api/mcp servers = " + names);
    }
  }

  // ── 6. REAL call through local Ollama ──────────────────────────
  section("6. Real chat via local Ollama (llama3.2:latest)");
  const started = Date.now();
  const chat = await postChat({
    model: "llama3.2:latest",
    messages: [{ role: "user", content: "এক লাইনে উত্তর দাও: ২+২ কত? (শুধু সংখ্যা)" }],
    max_tokens: 24,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (chat.status === 200 && chat.json && chat.json.choices && chat.json.choices[0] && chat.json.choices[0].message) {
    const content = chat.json.choices[0].message.content || "";
    ok("ollama replied in " + elapsed + "s — model=" + (chat.json.model || "?"));
    console.log("      reply: " + JSON.stringify(content).slice(0, 120));
    if (!content.trim()) bad("empty content from ollama");
  } else {
    bad("ollama chat call", "HTTP " + chat.status + " in " + elapsed + "s — " + (chat.text || JSON.stringify(chat.json)).slice(0, 200));
  }

  console.log("\n" + "═".repeat(36));
  console.log("RESULT: " + pass + " passed, " + fail + " failed");
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("SCRIPT ERROR:", e); process.exit(2); });