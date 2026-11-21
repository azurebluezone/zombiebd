"use strict";

/**
 * lib/admin-panel.js — the self-contained admin panel.
 *
 * Everything the browser needs (document, CSS, client JS) is rendered from
 * this one module. The server prefers the optional public/admin.html page and
 * falls back to renderAdminPanel() when that file is absent, so deleting
 * either one never blocks boot.
 *
 * The panel route also sets the HttpOnly zc_panel session cookie. Every admin
 * method below requires that cookie in addition to x-admin-token:
 *   GET    /api/admin/providers
 *   POST   /api/admin/providers   {action:"save", ...}
 *   DELETE /api/admin/providers/<id>
 *
 * It verifies the admin credential once on load, stores it in sessionStorage,
 * and then polls GET /api/admin/providers with the x-admin-token header in
 * the background. A 401/403 stops the poll and asks for a new token.
 */

const PANEL_MARKER = "zc-admin-panel";

const PANEL_STYLE = `
:root{
  --bg:#0b0f14;--bg2:#121820;--bg3:#18212b;--line:#263241;
  --text:#e6edf3;--muted:#8b9bb0;--blue:#4ea1ff;--green:#3fb950;
  --red:#f85149;--orange:#d29922;--radius:10px;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header.top{display:flex;gap:16px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:18px 22px;border-bottom:1px solid var(--line);background:var(--bg2)}
h1{font-size:17px;margin:0}
h2{font-size:14px;margin:0}
.sub{color:var(--muted);font-size:12px}
.auth{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
main{max-width:1180px;margin:0 auto;padding:20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--bg2);border:1px solid var(--line);border-radius:var(--radius);padding:14px}
.stat b{display:block;font-size:22px;margin-top:4px}
.card{background:var(--bg2);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.card-head{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line)}
.card-head .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 10px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle;font-size:12px}
th{color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.03em;font-size:10px}
tbody tr:hover{background:rgba(78,161,255,.05)}
tbody tr.draft{background:rgba(210,153,34,.06)}
td.actions{white-space:nowrap;text-align:right}
td.empty{text-align:center;color:var(--muted);padding:22px}
input,select{background:var(--bg3);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 8px;font-size:12px;min-width:0}
input[data-field="id"]{width:100px}
input[data-field="name"]{width:130px}
input[data-field="baseUrl"]{width:100%;min-width:180px}
input[data-field="apiKey"]{width:100%;min-width:180px;margin-top:5px}
input[data-field="models"]{width:150px}
input[data-field="priority"]{width:64px}
button{background:var(--bg3);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
button:hover{border-color:var(--blue)}
button.primary{background:var(--blue);border-color:var(--blue);color:#03111f;font-weight:700}
button.danger{color:var(--red);border-color:rgba(248,81,73,.5)}
.badge{display:inline-block;border-radius:999px;padding:2px 8px;font-size:10px;border:1px solid var(--line);color:var(--muted)}
.badge.ok{color:var(--green);border-color:rgba(63,185,80,.45)}
.badge.bad{color:var(--red);border-color:rgba(248,81,73,.45)}
.badge.warn{color:var(--orange);border-color:rgba(210,153,34,.45)}
.note{color:var(--muted);font-size:11px;padding:10px 14px;margin:0;border-top:1px solid var(--line)}
.toast{position:fixed;right:18px;bottom:18px;background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:10px 14px;font-size:12px;opacity:0;pointer-events:none;transition:opacity .2s}
.toast.show{opacity:1}
.check{display:flex;gap:5px;align-items:center;white-space:nowrap}
.model-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 14px;padding:4px 0}
tr.models-row>td{background:rgba(78,161,255,.03)}
`;

function clientMain() {
  "use strict";

  var API = "";
  var TOKEN_KEY = "zc_admin_token";
  var SESSION_KEY = "zc_session_id";
  var POLL_MS = 10000;
  var state = {
    token: "",
    verified: false,
    timer: null,
    dirty: false,
    providers: [],
    modelsOpen: {},
  };

  function $(id) {
    return document.getElementById(id);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function headers(extra) {
    var out = {};
    var key;
    if (extra) for (key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
    if (state.token) out["x-admin-token"] = state.token;
    return out;
  }

  function setAuth(ok, text) {
    var badge = $("authStatus");
    if (!badge) return;
    badge.textContent = text;
    badge.className = "badge " + (ok ? "ok" : "bad");
  }

  function toast(text) {
    var el = $("toast");
    if (!el) return;
    el.textContent = text;
    el.className = "toast show";
    setTimeout(function () { el.className = "toast"; }, 4000);
  }

  function stopPolling() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(pollHeaders, POLL_MS);
  }

  async function request(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET", cache: "no-store", headers: headers(opts.headers) };
    if (opts.body !== undefined) {
      init.body = opts.body;
      if (!init.headers["content-type"]) init.headers["content-type"] = "application/json";
    }
    var res = await fetch(API + path, init);
    if (res.status === 401 || res.status === 403) {
      stopPolling();
      state.verified = false;
      state.token = "";
      sessionStorage.removeItem(TOKEN_KEY);
      setAuth(false, "token rejected — paste ADMIN_TOKEN and Verify");
      throw new Error("Unauthorized");
    }
    var data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) {
      var message = data && data.error;
      if (message && typeof message === "object") message = message.message || JSON.stringify(message);
      throw new Error(message || ("HTTP " + res.status));
    }
    return data || {};
  }

  function field(tr, name) {
    var el = tr.querySelector('[data-field="' + name + '"]');
    return el ? el.value : "";
  }

  function modelText(p) {
    if (Array.isArray(p.modelList)) return p.modelList.join(", ");
    if (typeof p.models === "number") return String(p.models);
    return "";
  }

  function modelCount(p) {
    if (Array.isArray(p.modelList)) return p.modelList.length;
    if (typeof p.models === "number") return p.models;
    return 0;
  }

  function nextCustomId() {
    var max = 0;
    for (var i = 0; i < state.providers.length; i++) {
      var m = /^custom_(\d+)$/i.exec(state.providers[i].id || "");
      if (m) max = Math.max(max, Number(m[1]));
    }
    return "custom_" + (max + 1);
  }

  function statusBadge(p) {
    if (p.enabled === false) return '<span class="badge bad">off</span>';
    var status = p.status || "unknown";
    if (status === "up") return '<span class="badge ok">up</span>';
    if (status === "down") return '<span class="badge bad">down</span>';
    if (status === "degraded") return '<span class="badge warn">degraded</span>';
    if (status === "stale") return '<span class="badge warn">stale</span>';
    return '<span class="badge">unknown</span>';
  }

  function modelRows(p) {
    if (!state.modelsOpen[p.id]) return "";
    var states = p.modelStates || (p.modelList || []).map(function (name) {
      return { name: name, enabled: true };
    });
    if (!states.length) {
      return '<tr class="models-row" data-parent="' + esc(p.id) +
        '"><td colspan="8" class="sub">No models yet — Test or Sync reads /v1/models.</td></tr>';
    }
    var html = '<tr class="models-row" data-parent="' + esc(p.id) +
      '"><td colspan="8"><div class="model-grid">';
    for (var i = 0; i < states.length; i++) {
      var m = states[i];
      html += '<label class="check model"><input type="checkbox" data-action="toggle-model" data-provider="' +
        esc(p.id) + '" data-model="' + esc(m.name) + '"' +
        (m.enabled === false ? "" : " checked") + '> <span class="mono">' +
        esc(m.name) + "</span></label>";
    }
    html += '</div><div class="sub" style="margin-top:6px">' +
      "Toggle persists models.enabled immediately; the router skips off models.</div></td></tr>";
    return html;
  }

  function rowDisplay(p) {
    var endpoint = p.socketPath ? "UDS " + p.socketPath : (p.baseUrl || "");
    var key = p.keySource && p.keySource !== "none" ? "key: " + p.keySource : "no key";
    var deleteButton = p.source === "db"
      ? '<button data-action="delete" class="danger">Delete</button>'
      : "";
    var syncButton = p.enabled === false
      ? ""
      : '<button data-action="sync">Sync</button>';
    return '<tr data-id="' + esc(p.id) + '" data-type="' + esc(p.type || "openai") + '">' +
      "<td><code>" + esc(p.id) + "</code></td>" +
      "<td><strong>" + esc(p.name || p.id) + "</strong>" +
      '<div class="sub">' + esc(p.source || "env") + " · " + esc(key) + "</div></td>" +
      "<td>" + esc(p.type || "openai") + "</td>" +
      '<td class="mono">' + esc(endpoint) + "</td>" +
      '<td><button data-action="models">' + modelCount(p) + " models</button></td>" +
      "<td>" + (p.priority == null ? "—" : esc(p.priority)) + "</td>" +
      '<td><label class="check"><input type="checkbox" data-action="toggle-provider" data-provider="' +
      esc(p.id) + '"' + (p.enabled === false ? "" : " checked") + "> on " +
      statusBadge(p) + "</label></td>" +
      '<td class="actions">' +
      '<button data-action="edit">Edit</button> ' +
      syncButton + " " +
      deleteButton +
      "</td></tr>" + modelRows(p);
  }

  function rowDraft(p) {
    p = p || {};
    var id = p.id || nextCustomId();
    var type = p.type || "openai";
    var models = modelText(p);
    return '<tr class="draft" data-id="' + esc(p.id || "") + '" data-type="' + esc(type) + '">' +
      '<td><input data-field="id" value="' + esc(id) +
      '" readonly title="Auto-generated: the server assigns the next free custom_N"></td>' +
      '<td><input data-field="name" value="' + esc(p.name || "") + '" placeholder="Display name"></td>' +
      "<td>" + esc(type) + "</td>" +
      '<td><input data-field="baseUrl" value="' + esc(p.baseUrl || "") + '" placeholder="http://host:port/v1">' +
      '<input data-field="apiKey" type="password" placeholder="' +
      (p.id ? "API key (leave blank to keep the saved key)" : "API key (optional)") +
      '" autocomplete="new-password"></td>' +
      '<td><input data-field="models" value="' + esc(models) + '" placeholder="Test, or public=>api">' +
      '<div style="margin-top:6px"><button data-action="test">Test /v1/models</button> ' +
      '<span class="sub" data-test-result></span></div></td>' +
      '<td><input data-field="priority" type="number" min="0" value="' +
      (p.priority == null ? "" : esc(p.priority)) + '" placeholder="auto"></td>' +
      '<td><label class="check"><input data-field="enabled" type="checkbox" ' +
      (p.enabled === false ? "" : "checked") + "> on</label></td>" +
      '<td class="actions"><button data-action="save" class="primary">Save</button> ' +
      '<button data-action="cancel">Cancel</button></td>' +
      "</tr>";
  }

  function renderStats() {
    var models = 0;
    for (var i = 0; i < state.providers.length; i++) models += modelCount(state.providers[i]);
    $("providerCount").textContent = String(state.providers.length);
    $("modelCount").textContent = String(models);
  }

  function renderRows() {
    var tbody = $("providerRows");
    if (!state.providers.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No providers yet — add the first row.</td></tr>';
      return;
    }
    var html = "";
    for (var i = 0; i < state.providers.length; i++) html += rowDisplay(state.providers[i]);
    tbody.innerHTML = html;
  }

  async function loadProviders(force) {
    if (!state.verified) return;
    if (state.dirty && !force) return;
    var data = await request("/api/admin/providers");
    state.providers = data.providers || [];
    renderStats();
    renderRows();
  }

  function beginEdit(id) {
    var rows = $("providerRows").querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute("data-id") === id) {
        var found = null;
        for (var j = 0; j < state.providers.length; j++) {
          if (state.providers[j].id === id) found = state.providers[j];
        }
        if (!found) return;
        rows[i].outerHTML = rowDraft(found);
        state.dirty = true;
        return;
      }
    }
  }

  function addDraft() {
    state.dirty = true;
    $("providerRows").insertAdjacentHTML("afterbegin", rowDraft(null));
    var input = $("providerRows").querySelector('tr.draft input[data-field="name"]');
    if (input) input.focus();
  }

  async function saveDraft(tr) {
    var id = field(tr, "id").trim();
    if (!id) {
      setAuth(true, "provider id required");
      return;
    }
    var payload = {
      action: "save",
      id: id,
      name: field(tr, "name").trim() || id,
      type: tr.getAttribute("data-type") || "openai",
      baseUrl: field(tr, "baseUrl").trim(),
      apiKey: field(tr, "apiKey").trim(),
      models: field(tr, "models").trim(),
      enabled: !!tr.querySelector('[data-field="enabled"]').checked,
    };
    var priority = field(tr, "priority").trim();
    if (priority !== "") payload.priority = priority;
    try {
      await request("/api/admin/providers", { method: "POST", body: JSON.stringify(payload) });
      state.dirty = false;
      toast("Saved " + id);
      await loadProviders(true);
    } catch (error) {
      setAuth(true, "save failed: " + error.message);
    }
  }

  async function removeProvider(id) {
    if (!window.confirm("Delete provider " + id + "?")) return;
    try {
      await request("/api/admin/providers/" + encodeURIComponent(id), { method: "DELETE" });
      state.dirty = false;
      toast("Deleted " + id);
      await loadProviders(true);
    } catch (error) {
      setAuth(true, "delete failed: " + error.message);
    }
  }

  function existingProvider(id) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === id) return state.providers[i];
    }
    return null;
  }

  async function testDraft(tr) {
    var id = field(tr, "id").trim();
    var savedRow = existingProvider(id);
    var status = tr.querySelector("[data-test-result]");
    if (status) status.textContent = "testing…";
    var payload = {
      action: "test",
      id: id || undefined,
      type: tr.getAttribute("data-type") || "openai",
      baseUrl: field(tr, "baseUrl").trim(),
      apiKey: field(tr, "apiKey").trim(),
      // A saved DB row stores the discovery immediately; a new draft keeps it
      // in the row until Save, so a failed save cannot leave half a provider.
      persist: !!(savedRow && savedRow.source === "db"),
    };
    try {
      var res = await request("/api/admin/providers", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      var models = res.models || [];
      var input = tr.querySelector('[data-field="models"]');
      if (input) input.value = models.join(", ");
      if (status) {
        status.textContent = res.count + " models" +
          (res.persisted ? " · stored in SQLite" : " · Save to store");
      }
      toast("Test " + id + ": " + res.count + " models");
    } catch (error) {
      if (status) status.textContent = "failed";
      setAuth(false, "test failed: " + error.message);
    }
  }

  async function syncProvider(id) {
    try {
      var res = await request("/api/admin/providers", {
        method: "POST",
        body: JSON.stringify({ action: "sync", id: id }),
      });
      var result = res.results && res.results[id];
      if (result && result.ok) {
        toast("Synced " + id + ": +" + result.added.length + " / -" + result.removed.length +
          " · " + result.total + " total");
      } else {
        toast("Sync " + id + ": " + ((result && (result.error || result.reason)) || "no change"));
      }
      await loadProviders(true);
    } catch (error) {
      setAuth(false, "sync failed: " + error.message);
    }
  }

  async function syncAll() {
    try {
      var res = await request("/api/admin/providers", {
        method: "POST",
        body: JSON.stringify({ action: "sync" }),
      });
      var ids = Object.keys(res.results || {});
      var failed = ids.filter(function (id) { return !res.results[id].ok; });
      toast("Synced " + (ids.length - failed.length) + "/" + ids.length +
        " providers · changed " + res.changed + (failed.length ? " · " + failed.join(",") : ""));
      await loadProviders(true);
    } catch (error) {
      setAuth(false, "sync all failed: " + error.message);
    }
  }

  async function toggleProvider(id, enabled) {
    try {
      await request("/api/admin/providers", {
        method: "POST",
        body: JSON.stringify({ action: "toggle", id: id, enabled: !!enabled }),
      });
      toast((enabled ? "Enabled " : "Disabled ") + id);
      await loadProviders(true);
    } catch (error) {
      setAuth(false, "toggle failed: " + error.message);
      await loadProviders(true).catch(function () {});
    }
  }

  async function toggleModel(providerId, name, enabled) {
    try {
      await request("/api/admin/models", {
        method: "POST",
        body: JSON.stringify({ provider: providerId, name: name, enabled: !!enabled }),
      });
      toast((enabled ? "Enabled " : "Disabled ") + providerId + "::" + name);
      await loadProviders(true);
    } catch (error) {
      setAuth(false, "model toggle failed: " + error.message);
      await loadProviders(true).catch(function () {});
    }
  }

  async function verifyBrowserSessionOnce() {
    var sid = "";
    try {
      sid = new URLSearchParams(window.location.search).get("session_id") || "";
    } catch (_) {
      sid = "";
    }
    if (!sid) sid = sessionStorage.getItem(SESSION_KEY) || "";
    if (!sid) return;
    try {
      var res = await fetch(API + "/api/verify-session?session_id=" + encodeURIComponent(sid), {
        headers: headers(),
        cache: "no-store",
      });
      var data = await res.json().catch(function () { return {}; });
      if (!data || !data.verified) setAuth(true, "token ok · session unverified");
      else sessionStorage.setItem(SESSION_KEY, sid);
    } catch (_) {
      setAuth(true, "token ok · session check failed");
    }
  }

  async function verifyOnce() {
    var input = $("tokenInput");
    var token = ((input && input.value) || sessionStorage.getItem(TOKEN_KEY) || "").trim();
    if (!token) {
      setAuth(false, "token required");
      return false;
    }
    state.token = token;
    try {
      await request("/api/admin/providers");
    } catch (error) {
      if (!/Unauthorized/.test(error.message)) setAuth(false, "verify failed: " + error.message);
      return false;
    }
    state.verified = true;
    sessionStorage.setItem(TOKEN_KEY, token);
    setAuth(true, "verified");
    await verifyBrowserSessionOnce();
    return true;
  }

  async function pollHeaders() {
    if (!state.verified || state.dirty || document.hidden) return;
    try {
      await loadProviders(true);
      var stamp = $("lastPoll");
      if (stamp) stamp.textContent = "polled " + new Date().toLocaleTimeString();
    } catch (error) {
      if (!/Unauthorized/.test(error.message)) setAuth(true, "poll failed: " + error.message);
    }
  }

  function bindEvents() {
    $("verifyBtn").addEventListener("click", async function () {
      stopPolling();
      if (await verifyOnce()) {
        await loadProviders(true).catch(function (error) {
          setAuth(true, "load failed: " + error.message);
        });
        startPolling();
      }
    });
    $("tokenInput").addEventListener("keydown", function (event) {
      if (event.key === "Enter") $("verifyBtn").click();
    });
    $("addRowBtn").addEventListener("click", addDraft);
    $("refreshBtn").addEventListener("click", function () {
      loadProviders(true).catch(function (error) {
        setAuth(true, "refresh failed: " + error.message);
      });
    });
    $("syncAllBtn").addEventListener("click", syncAll);
    $("providerRows").addEventListener("click", function (event) {
      var button = event.target.closest("button[data-action]");
      if (!button) return;
      var tr = button.closest("tr");
      var action = button.getAttribute("data-action");
      if (action === "edit") beginEdit(tr.getAttribute("data-id"));
      else if (action === "delete") removeProvider(tr.getAttribute("data-id"));
      else if (action === "save") saveDraft(tr);
      else if (action === "test") testDraft(tr);
      else if (action === "sync") syncProvider(button.getAttribute("data-provider") || tr.getAttribute("data-id"));
      else if (action === "models") {
        var providerId = tr.getAttribute("data-id");
        state.modelsOpen[providerId] = !state.modelsOpen[providerId];
        renderRows();
      } else if (action === "cancel") {
        state.dirty = false;
        loadProviders(true).catch(function () {});
      }
    });
    $("providerRows").addEventListener("change", function (event) {
      var input = event.target;
      if (!input || input.tagName !== "INPUT") return;
      var action = input.getAttribute("data-action");
      if (action === "toggle-provider") {
        toggleProvider(input.getAttribute("data-provider"), input.checked);
      } else if (action === "toggle-model") {
        toggleModel(input.getAttribute("data-provider"), input.getAttribute("data-model"), input.checked);
      }
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.verified) pollHeaders();
    });
  }

  async function boot() {
    var meta = window.__ZC_ADMIN || {};
    var server = $("serverMode");
    if (server) server.textContent = (meta.domain || "localhost") + " · v" + (meta.version || "?");
    var saved = sessionStorage.getItem(TOKEN_KEY) || "";
    if (saved) $("tokenInput").value = saved;
    bindEvents();
    if (saved) {
      if (await verifyOnce()) {
        try {
          await loadProviders(true);
        } catch (_) {
          /* status already explains the failure */
        }
        startPolling();
      }
    } else {
      setAuth(false, "not verified");
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
}

function renderAdminPanel(config) {
  const cfg = config || {};
  const boot = {
    domain: cfg.domain || "",
    version: cfg.version || "",
    serverType: cfg.serverType || "",
  };
  return [
    "<!doctype html>",
    '<html lang="en" data-panel="self-contained" id="' + PANEL_MARKER + '">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>ZombieCoder Admin</title>",
    "<style>" + PANEL_STYLE + "</style>",
    "</head>",
    "<body>",
    '<header class="top">',
    "<div><h1>ZombieCoder Admin</h1>",
    '<div class="sub">Self-contained panel · plain GET/POST/DELETE · no admin.html</div></div>',
    '<div class="auth">',
    '<input id="tokenInput" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password">',
    '<button id="verifyBtn" class="primary">Verify</button>',
    '<span id="authStatus" class="badge">not verified</span>',
    "</div>",
    "</header>",
    "<main>",
    '<section class="stats">',
    '<div class="stat"><span class="sub">Providers</span><b id="providerCount">0</b></div>',
    '<div class="stat"><span class="sub">Models</span><b id="modelCount">0</b></div>',
    '<div class="stat"><span class="sub">Server</span><b id="serverMode" style="font-size:14px">—</b></div>',
    '<div class="stat"><span class="sub">Last poll</span><b id="lastPoll" style="font-size:14px">—</b></div>',
    "</section>",
    '<section class="card">',
    '<div class="card-head">',
    "<h2>Providers</h2>",
    '<div class="tools"><span class="sub" id="providerHint">verify once, then polling runs in the background</span>',
    '<button id="refreshBtn">Refresh</button>',
    '<button id="syncAllBtn">Provider &amp; model sync</button>',
    '<button id="addRowBtn" class="primary">+ Add provider row</button></div>',
    "</div>",
    "<table>",
    "<thead><tr><th>ID</th><th>Name</th><th>Type</th><th>Endpoint</th><th>Models</th><th>Priority</th><th>State</th><th></th></tr></thead>",
    '<tbody id="providerRows"><tr><td colspan="8" class="empty">Verify to load providers.</td></tr></tbody>',
    "</table>",
    '<p class="note">Every action is a plain request to <code>/api/admin/providers</code> — the same call as curl. ' +
    "ID is auto (<code>custom_N</code>), priority is auto/swap, Test reads <code>/v1/models</code>, " +
    "Sync re-reads it and stores the result in SQLite, and the provider/model switches are persisted.</p>",
    "</section>",
    "</main>",
    '<div id="toast" class="toast"></div>',
    "<script>window.__ZC_ADMIN = " +
    JSON.stringify(boot).replace(/</g, "\\u003c") +
    ";</script>",
    "<script>(" + clientMain.toString() + ")();</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

module.exports = { PANEL_MARKER, PANEL_STYLE, renderAdminPanel };
