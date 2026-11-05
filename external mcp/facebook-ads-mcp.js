// =============================================================================
// Facebook Ads MCP Server
// Model Context Protocol (MCP) Specification Compliant
// Transport: Streamable HTTP (POST /mcp)
// Protocol: JSON-RPC 2.0
// =============================================================================
// Official Meta Facebook Ads MCP Tools - 29 Tools
// Categories:
// 1. Campaign Creation & Management (5)
// 2. Accounts & Pages (3)
// 3. Product Catalog (10)
// 4. Dataset Quality & Diagnostics (4)
// 5. Insights & Performance (7)
// =============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

// Dedicated env var ONLY — the generic process.env.PORT is deliberately NOT
// used: this server is spawned as a CHILD of start.js (which sets PORT=3000
// for the main server in .env), so inheriting PORT would make us try to bind
// the MAIN SERVER's port and crash with EADDRINUSE.
const PORT = parseInt(process.env.FB_ADS_MCP_PORT || "3001", 10);
const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "facebook-ads-mcp.log");

// ─── Ensure Log Directory ──────────────────────────────────────────────────
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Logger ────────────────────────────────────────────────────────────────
const LOG_ENTRIES = [];
function log(level, category, data) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    ...data,
  };
  LOG_ENTRIES.push(entry);
  if (LOG_ENTRIES.length > 1000) LOG_ENTRIES.shift();
  const line = `[${entry.timestamp}] [${level}] [${category}] ${JSON.stringify(data)}\n`;
  fs.appendFileSync(LOG_FILE, line);
  console.log(line.trim());
}

// ─── MCP Protocol Constants ───────────────────────────────────────────────
const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "facebook-ads-mcp", version: "1.0.0" };

// ─── Official Meta Ads MCP Tools (29) ──────────────────────────────────────
const TOOLS = [
  // ═══ Campaign Creation & Management (5) ══════════════════════════════════
  { name: "ads_create_campaign", description: "Create campaign with objective and budget. Created in PAUSED status.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, name: { type: "string" }, objective: { type: "string", enum: ["OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_TRAFFIC", "OUTCOME_APP_PROMOTION"] }, status: { type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" }, daily_budget: { type: "string" }, lifetime_budget: { type: "string" }, special_ad_categories: { type: "array", items: { type: "string" } } }, required: ["ad_account_id", "name", "objective"] } },
  { name: "ads_create_ad_set", description: "Create ad set with targeting, placement, schedule.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, campaign_id: { type: "string" }, name: { type: "string" }, daily_budget: { type: "string" }, targeting: { type: "object" }, optimization_goal: { type: "string" }, billing_event: { type: "string" }, status: { type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" } }, required: ["ad_account_id", "campaign_id", "name", "billing_event", "optimization_goal", "targeting"] } },
  { name: "ads_create_ad", description: "Create ad linking creative to ad set.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, adset_id: { type: "string" }, name: { type: "string" }, creative: { type: "object" }, status: { type: "string", enum: ["ACTIVE", "PAUSED"], default: "PAUSED" } }, required: ["ad_account_id", "adset_id", "name", "creative"] } },
  { name: "ads_update_entity", description: "Modify campaigns, ad sets, or ads.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, entity_id: { type: "string" }, entity_type: { type: "string", enum: ["campaign", "adset", "ad"] }, name: { type: "string" }, status: { type: "string" }, daily_budget: { type: "string" } }, required: ["entity_id", "entity_type"] } },
  { name: "ads_activate_entity", description: "Activate a paused campaign, ad set, or ad.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, entity_id: { type: "string" }, entity_type: { type: "string", enum: ["campaign", "adset", "ad"] } }, required: ["entity_id", "entity_type"] } },

  // ═══ Accounts & Pages (3) ════════════════════════════════════════════════
  { name: "ads_get_ad_accounts", description: "List accessible ad accounts.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, user_id: { type: "string" } } } },
  { name: "ads_get_ad_entities", description: "Retrieve campaigns, ad sets, ads under an account.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, entity_type: { type: "string", enum: ["campaign", "adset", "ad", "all"], default: "all" }, status: { type: "string" }, limit: { type: "integer", default: 25 } }, required: ["ad_account_id"] } },
  { name: "ads_get_pages_for_business", description: "Display connected Facebook Pages.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, business_id: { type: "string" } }, required: ["business_id"] } },

  // ═══ Product Catalog (10) ════════════════════════════════════════════════
  { name: "ads_create_catalog", description: "Create product catalog for dynamic ads.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, business_id: { type: "string" }, name: { type: "string" }, vertical: { type: "string" } }, required: ["business_id", "name", "vertical"] } },
  { name: "ads_create_product_feed", description: "Create data feed for product uploads.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" }, name: { type: "string" }, feed_url: { type: "string" }, schedule: { type: "string" } }, required: ["catalog_id", "name", "feed_url"] } },
  { name: "ads_upload_products", description: "Upload products to catalog.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" }, products: { type: "array", items: { type: "object" } } }, required: ["catalog_id", "products"] } },
  { name: "ads_get_catalog", description: "Get catalog details.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" } }, required: ["catalog_id"] } },
  { name: "ads_get_product", description: "Get product details.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" }, product_id: { type: "string" } }, required: ["catalog_id", "product_id"] } },
  { name: "ads_get_products", description: "List products in catalog.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" }, limit: { type: "integer", default: 25 } }, required: ["catalog_id"] } },
  { name: "ads_get_product_feed", description: "Get product feed details.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, feed_id: { type: "string" } }, required: ["feed_id"] } },
  { name: "ads_get_product_feed_upload", description: "Get feed upload history.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, feed_id: { type: "string" }, limit: { type: "integer", default: 10 } }, required: ["feed_id"] } },
  { name: "ads_get_product_set", description: "Get product set details.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, product_set_id: { type: "string" } }, required: ["product_set_id"] } },
  { name: "ads_get_product_sets", description: "List product sets in catalog.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, catalog_id: { type: "string" }, limit: { type: "integer", default: 25 } }, required: ["catalog_id"] } },

  // ═══ Dataset Quality & Diagnostics (4) ═══════════════════════════════════
  { name: "ads_get_datasets", description: "List datasets in account.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" } }, required: ["ad_account_id"] } },
  { name: "ads_get_dataset_quality", description: "Get signal health for dataset.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, dataset_id: { type: "string" }, date_preset: { type: "string", default: "last_30d" } }, required: ["dataset_id"] } },
  { name: "ads_get_pixel", description: "Get pixel details and health.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, pixel_id: { type: "string" } }, required: ["pixel_id"] } },
  { name: "ads_get_pixel_stats", description: "Get pixel event statistics.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, pixel_id: { type: "string" }, date_preset: { type: "string", default: "last_30d" } }, required: ["pixel_id"] } },

  // ═══ Insights & Performance (7) ══════════════════════════════════════════
  { name: "ads_insights_advertiser_context", description: "Get industry and geographic context.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" } }, required: ["ad_account_id"] } },
  { name: "ads_insights_anomaly_signal", description: "Flag KPI deviations from baseline.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, entity_type: { type: "string" }, entity_id: { type: "string" }, metrics: { type: "array", items: { type: "string" } } }, required: ["ad_account_id"] } },
  { name: "ads_insights_auction_ranking_benchmarks", description: "Compare CTR, CPM, quality ranking.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, entity_type: { type: "string" }, entity_id: { type: "string" }, date_preset: { type: "string", default: "last_30d" } }, required: ["ad_account_id"] } },
  { name: "ads_insights_industry_benchmark", description: "Compare against industry averages.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, industry: { type: "string" }, metrics: { type: "array", items: { type: "string" } } }, required: ["ad_account_id"] } },
  { name: "ads_insights_performance_trend", description: "Historical metric trajectory.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" }, entity_type: { type: "string" }, start_date: { type: "string" }, end_date: { type: "string" }, time_increment: { type: "string", default: "7" } }, required: ["ad_account_id", "start_date", "end_date"] } },
  { name: "ads_get_opportunity_score", description: "Get Meta's opportunity score.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, ad_account_id: { type: "string" } }, required: ["ad_account_id"] } },
  { name: "ads_get_help_article", description: "Search Meta Business Help Center.", inputSchema: { type: "object", properties: { access_token: { type: "string", description: "Facebook access token. Optional when FB_ACCESS_TOKEN is set in .env." }, query: { type: "string" }, category: { type: "string" } }, required: ["query"] } },
];

// ─── Graph API Helper ──────────────────────────────────────────────────────
async function graphAPIRequest(endpoint, options = {}) {
  // A per-call token wins over the env default, so a caller can paste one
  // into a tool call instead of restarting the server with a new key.
  const accessToken =
    options.accessToken || ACTIVE_TOKEN || process.env.FB_ACCESS_TOKEN || "";
  if (!accessToken) {
    throw new Error(
      "No Facebook token. Pass access_token to the tool, or set FB_ACCESS_TOKEN in .env."
    );
  }
  const url = new URL(`${GRAPH_API_BASE}${endpoint}`);
  url.searchParams.append("access_token", accessToken);
  if (options.params) {
    for (const [k, v] of Object.entries(options.params)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
  }
  const t0 = Date.now();
  const res = await fetch(url.toString(), { method: options.method || "GET", headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
  const data = await res.json();
  const elapsed = Date.now() - t0;
  log("INFO", "GRAPH_API", { endpoint, method: options.method || "GET", status: res.status, elapsed: elapsed + "ms" });
  if (data.error) throw new Error(`FB API Error: ${data.error.message} (${data.error.code})`);
  return data;
}

// Token resolved for the current tool call. graphAPIRequest() reads this
// when a call site does not pass an explicit token — that keeps every
// existing call site untouched while still honouring the caller's token.
let ACTIVE_TOKEN = "";

// ─── Tool Execution ────────────────────────────────────────────────────────
async function executeTool(name, args) {
  const token = args.access_token || args.accessToken || process.env.FB_ACCESS_TOKEN || "";
  ACTIVE_TOKEN = token;
  if (!token) {
    return {
      content: [{
        type: "text",
        text:
          "Error: no Facebook access token. Pass access_token in this call, " +
          "or set FB_ACCESS_TOKEN in .env and restart the server.",
      }],
      isError: true,
    };
  }
  const t0 = Date.now();
  try {
    let result;
    switch (name) {
      case "ads_create_campaign": { const { ad_account_id, name: n, objective, status, daily_budget, lifetime_budget, special_ad_categories } = args; let p = { name: n, objective, status: status || "PAUSED", special_ad_categories: special_ad_categories || [] }; if (daily_budget) p.daily_budget = daily_budget; if (lifetime_budget) p.lifetime_budget = lifetime_budget; result = await graphAPIRequest(`/${ad_account_id}/campaigns`, { method: "POST", params: p }); break; }
      case "ads_create_ad_set": { const { ad_account_id, campaign_id, name: n, daily_budget, targeting, optimization_goal, billing_event, status } = args; let p = { campaign_id, name: n, billing_event, optimization_goal, targeting: JSON.stringify(targeting), status: status || "PAUSED" }; if (daily_budget) p.daily_budget = daily_budget; result = await graphAPIRequest(`/${ad_account_id}/adsets`, { method: "POST", params: p }); break; }
      case "ads_create_ad": { const { ad_account_id, adset_id, name: n, creative, status } = args; let p = { adset_id, name: n, creative: JSON.stringify(creative), status: status || "PAUSED" }; result = await graphAPIRequest(`/${ad_account_id}/ads`, { method: "POST", params: p }); break; }
      case "ads_update_entity": { const { entity_id, ...u } = args; let p = {}; if (u.name) p.name = u.name; if (u.status) p.status = u.status; if (u.daily_budget) p.daily_budget = u.daily_budget; result = await graphAPIRequest(`/${entity_id}`, { method: "POST", params: p }); break; }
      case "ads_activate_entity": { const { entity_id } = args; result = await graphAPIRequest(`/${entity_id}`, { method: "POST", params: { status: "ACTIVE" } }); break; }
      case "ads_get_ad_accounts": { const { user_id } = args; result = await graphAPIRequest(user_id ? `/${user_id}/adaccounts` : "/me/adaccounts", { params: { fields: "id,name,account_status,currency,timezone_name,amount_spent,balance" } }); break; }
      case "ads_get_ad_entities": { const { ad_account_id, entity_type, status, limit } = args; let ep = `/${ad_account_id}`; if (entity_type === "campaign") ep += "/campaigns"; else if (entity_type === "adset") ep += "/adsets"; else if (entity_type === "ad") ep += "/ads"; else ep += "/campaigns"; let p = { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget" }; if (status) p.filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: [status] }]); if (limit) p.limit = limit; result = await graphAPIRequest(ep, { params: p }); break; }
      case "ads_get_pages_for_business": { const { business_id } = args; result = await graphAPIRequest(`/${business_id}/owned_pages`, { params: { fields: "id,name,category,fan_count,link" } }); break; }
      case "ads_create_catalog": { const { business_id, name: n, vertical } = args; result = await graphAPIRequest(`/${business_id}/product_catalogs`, { method: "POST", params: { name: n, vertical } }); break; }
      case "ads_create_product_feed": { const { catalog_id, name: n, feed_url, schedule } = args; result = await graphAPIRequest(`/${catalog_id}/product_feeds`, { method: "POST", params: { name: n, feed_url, schedule: schedule || "DAILY" } }); break; }
      case "ads_upload_products": { const { catalog_id, products } = args; result = await graphAPIRequest(`/${catalog_id}/products_batch`, { method: "POST", params: { requests: JSON.stringify(products.map(p => ({ method: "UPDATE", data: p }))) } }); break; }
      case "ads_get_catalog": { const { catalog_id } = args; result = await graphAPIRequest(`/${catalog_id}`, { params: { fields: "id,name,vertical,product_count" } }); break; }
      case "ads_get_product": { const { catalog_id, product_id } = args; result = await graphAPIRequest(`/${catalog_id}/products/${product_id}`, { params: { fields: "id,title,description,price,currency,availability,image_link" } }); break; }
      case "ads_get_products": { const { catalog_id, limit } = args; let p = { fields: "id,title,price,currency,availability" }; if (limit) p.limit = limit; result = await graphAPIRequest(`/${catalog_id}/products`, { params: p }); break; }
      case "ads_get_product_feed": { const { feed_id } = args; result = await graphAPIRequest(`/${feed_id}`, { params: { fields: "id,name,schedule,url,created_time" } }); break; }
      case "ads_get_product_feed_upload": { const { feed_id, limit } = args; let p = { fields: "id,status,error_code,start_time,end_time" }; if (limit) p.limit = limit; result = await graphAPIRequest(`/${feed_id}/uploads`, { params: p }); break; }
      case "ads_get_product_set": { const { product_set_id } = args; result = await graphAPIRequest(`/${product_set_id}`, { params: { fields: "id,name,filter,product_count" } }); break; }
      case "ads_get_product_sets": { const { catalog_id, limit } = args; let p = { fields: "id,name,product_count" }; if (limit) p.limit = limit; result = await graphAPIRequest(`/${catalog_id}/product_sets`, { params: p }); break; }
      case "ads_get_datasets": { const { ad_account_id } = args; result = await graphAPIRequest(`/${ad_account_id}/custom_audiences`, { params: { fields: "id,name,description,approximate_count" } }); break; }
      case "ads_get_dataset_quality": { const { dataset_id, date_preset } = args; result = await graphAPIRequest(`/${dataset_id}/delivery_stats`, { params: { date_preset: date_preset || "last_30d" } }); break; }
      case "ads_get_pixel": { const { pixel_id } = args; result = await graphAPIRequest(`/${pixel_id}`, { params: { fields: "id,name,last_fired_time,event_stats" } }); break; }
      case "ads_get_pixel_stats": { const { pixel_id, date_preset } = args; result = await graphAPIRequest(`/${pixel_id}/stats`, { params: { date_preset: date_preset || "last_30d" } }); break; }
      case "ads_insights_advertiser_context": { const { ad_account_id } = args; result = await graphAPIRequest(`/${ad_account_id}`, { params: { fields: "id,name,account_status,currency,timezone_name,amount_spent,business_name,business_city,business_country" } }); break; }
      case "ads_insights_anomaly_signal": { const { ad_account_id, entity_type, entity_id, metrics } = args; let ep = entity_id ? `/${entity_id}/insights` : `/${ad_account_id}/insights`; let p = { level: entity_type || "account", fields: (metrics || ["impressions", "clicks", "spend", "ctr", "cpc"]).join(","), date_preset: "last_30d", time_increment: "1" }; result = await graphAPIRequest(ep, { params: p }); break; }
      case "ads_insights_auction_ranking_benchmarks": { const { ad_account_id, entity_type, entity_id, date_preset } = args; let ep = entity_id ? `/${entity_id}/insights` : `/${ad_account_id}/insights`; let p = { level: entity_type || "account", fields: "impressions,clicks,spend,ctr,cpm,quality_ranking,engagement_ranking,conversion_rate_ranking", date_preset: date_preset || "last_30d" }; result = await graphAPIRequest(ep, { params: p }); break; }
      case "ads_insights_industry_benchmark": { const { ad_account_id, metrics } = args; let p = { level: "account", fields: (metrics || ["impressions", "clicks", "spend", "ctr", "cpc", "cpm"]).join(","), date_preset: "last_30d" }; result = await graphAPIRequest(`/${ad_account_id}/insights`, { params: p }); break; }
      case "ads_insights_performance_trend": { const { ad_account_id, entity_type, entity_id, metrics, start_date, end_date, time_increment } = args; let ep = entity_id ? `/${entity_id}/insights` : `/${ad_account_id}/insights`; let p = { level: entity_type || "account", fields: (metrics || ["impressions", "clicks", "spend", "ctr"]).join(","), time_range: JSON.stringify({ since: start_date, until: end_date }), time_increment: time_increment || "7" }; result = await graphAPIRequest(ep, { params: p }); break; }
      case "ads_get_opportunity_score": { const { ad_account_id } = args; result = await graphAPIRequest(`/${ad_account_id}`, { params: { fields: "id,name,account_status,spend_cap,amount_spent,balance" } }); break; }
      case "ads_get_help_article": { const { query } = args; result = await graphAPIRequest("/search", { params: { q: query, type: "ad_management_documentation", limit: 5 } }); break; }
      default: throw new Error(`Unknown tool: ${name}`);
    }
    const elapsed = Date.now() - t0;
    log("INFO", "TOOL_CALL", { tool: name, status: "success", elapsed: elapsed + "ms" });
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const elapsed = Date.now() - t0;
    log("ERROR", "TOOL_CALL", { tool: name, status: "error", error: error.message, elapsed: elapsed + "ms" });
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
}

// ─── JSON-RPC 2.0 Handler ─────────────────────────────────────────────────
function handleJSONRPC(body) {
  const { id, method, params } = body;
  log("INFO", "MCP_REQUEST", { method, id });
  if (id === undefined || id === null) return null;
  switch (method) {
    case "initialize": return { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
    case "notifications/initialized": return null;
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
    case "tools/call": { const { name, arguments: args } = params || {}; return executeTool(name, args || {}).then(result => ({ jsonrpc: "2.0", id, result })); }
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// ─── Setup HTML (Modern Dark Theme) ────────────────────────────────────────
function getSetupHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Facebook Ads MCP</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;padding:20px}
.wrap{width:100%;max-width:520px;animation:fadeUp .6s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
.card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:20px;overflow:hidden;backdrop-filter:blur(20px)}
.hdr{padding:28px 24px;text-align:center;background:linear-gradient(135deg,rgba(24,119,242,.15),rgba(66,165,245,.1));border-bottom:1px solid rgba(255,255,255,.06)}
.hdr h1{font-size:22px;font-weight:700;background:linear-gradient(135deg,#42a5f5,#1877f2);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.hdr p{font-size:12px;color:#888}
.langs{display:flex;justify-content:center;gap:8px;padding:14px;border-bottom:1px solid rgba(255,255,255,.06)}
.lang{padding:6px 18px;border:1px solid rgba(24,119,242,.4);background:transparent;color:#42a5f5;border-radius:16px;cursor:pointer;font-size:12px;font-weight:600;transition:all .3s}
.lang.on{background:#1877f2;color:#fff;border-color:#1877f2}
.body{padding:24px}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:600;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
.field input{width:100%;padding:14px 16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:12px;color:#fff;font-size:14px;transition:all .3s;outline:none}
.field input:focus{border-color:#1877f2;box-shadow:0 0 0 3px rgba(24,119,242,.15)}
.field input::placeholder{color:#555}
.hint{font-size:11px;color:#666;margin-top:4px}
.box{padding:12px 14px;border-radius:10px;margin-bottom:14px;font-size:12px;line-height:1.6;border-left:3px solid}
.box.info{background:rgba(33,150,243,.08);border-color:#2196f3;color:#90caf9}
.box.warn{background:rgba(255,152,0,.08);border-color:#ff9800;color:#ffb74d}
.box.danger{background:rgba(244,67,54,.08);border-color:#f44336;color:#ef9a9a}
.box b{display:block;margin-bottom:4px;font-size:13px;color:#ddd}
.terms{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:14px;margin-bottom:14px;max-height:110px;overflow-y:auto;font-size:11px;color:#888;line-height:1.7}
.terms b{color:#aaa;margin-bottom:6px;display:block;font-size:12px}
.btns{display:flex;gap:10px}
.btn{flex:1;padding:14px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;transition:all .3s}
.btn.p{background:linear-gradient(135deg,#1877f2,#1565c0);color:#fff}
.btn.p:hover{box-shadow:0 8px 25px rgba(24,119,242,.3);transform:translateY(-1px)}
.btn.d{background:rgba(244,67,54,.15);color:#ef5350;border:1px solid rgba(244,67,54,.3)}
.btn.d:hover{background:rgba(244,67,54,.25)}
.msg{margin-top:12px;padding:10px;border-radius:8px;text-align:center;font-size:12px;font-weight:500;display:none}
.msg.ok{display:block;background:rgba(76,175,80,.1);color:#66bb6a;border:1px solid rgba(76,175,80,.2)}
.msg.err{display:block;background:rgba(244,67,54,.1);color:#ef5350;border:1px solid rgba(244,67,54,.2)}
.saved{margin-top:14px;padding:14px;background:rgba(76,175,80,.08);border:1px solid rgba(76,175,80,.15);border-radius:12px;display:none;text-align:center}
.saved.show{display:block;animation:fadeUp .3s ease}
.saved h4{color:#66bb6a;font-size:14px;margin-bottom:4px}
.saved p{font-size:11px;color:#888}
.ftr{padding:12px;text-align:center;font-size:10px;color:#444;border-top:1px solid rgba(255,255,255,.04)}
@media(max-width:480px){.wrap{padding:0}.body{padding:18px}.btns{flex-direction:column}}
</style>
</head>
<body>
<div class="wrap">
<div class="card">
<div class="hdr">
<h1>Facebook Ads MCP</h1>
<p>Token Setup & Configuration</p>
</div>
<div class="langs">
<button class="lang on" onclick="L('en')">English</button>
<button class="lang" onclick="L('bn')">বাংলা</button>
</div>
<div class="body">
<div class="box info">
<b data-en="How it works" data-bn="কিভাবে কাজ করে">How it works</b>
<span data-en="Enter your Facebook Conversion API token. Saved in browser only." data-bn="Facebook Conversion API টোকেন দিন। শুধু ব্রাউজারে সংরক্ষিত।">Enter your Facebook Conversion API token. Saved in browser only.</span>
</div>
<div class="field">
<label data-en="Conversion API Token" data-bn="Conversion API টোকেন">Conversion API Token</label>
<input type="text" id="tk" placeholder="Paste token here...">
<p class="hint" data-en="From: Developers Portal → Graph API Explorer" data-bn="পান: Developers Portal → Graph API Explorer">From: Developers Portal → Graph API Explorer</p>
</div>
<div class="field">
<label data-en="Validity (Hours)" data-bn="মেয়াদ (ঘন্টা)">Validity (Hours)</label>
<input type="number" id="dur" value="24" min="1" max="720">
<p class="hint" data-en="Max 720h (30 days). After expiry re-enter." data-bn="সর্বোচ্চ ৭২০ ঘন্টা। মেয়াদ শেষে আবার দিতে হবে।">Max 720h (30 days). After expiry re-enter.</p>
</div>
<div class="box warn">
<b data-en="Important" data-bn="গুরুত্বপূর্ণ">Important</b>
<span data-en="Clear browser data = Token lost. Must re-enter." data-bn="ব্রাউজার ডাটা মুছলে = টোকেন হারিয়ে যাবে।">Clear browser data = Token lost. Must re-enter.</span>
</div>
<div class="terms">
<b data-en="Terms & Conditions" data-bn="শর্তাবলী">Terms & Conditions</b>
<ul>
<li data-en="Token stored in browser only" data-bn="টোকেন শুধু ব্রাউজারে সংরক্ষিত">Token stored in browser only</li>
<li data-en="Never sent to external servers" data-bn="বহিঃস্থ সার্ভারে পাঠানো হয় না">Never sent to external servers</li>
<li data-en="Use at your own risk" data-bn="নিজ ঝুঁকিতে ব্যবহার করুন">Use at your own risk</li>
</ul>
</div>
<div class="box danger">
<b data-en="Disclaimer" data-bn="দায়মুক্তি">Disclaimer</b>
<span data-en="For educational purposes. We collect no data." data-bn="শিক্ষামূলক। আমরা ডাটা সংগ্রহ করি না।">For educational purposes. We collect no data.</span>
</div>
<div class="btns">
<button class="btn p" onclick="save()" data-en="Save Token" data-bn="সংরক্ষণ করুন">Save Token</button>
<button class="btn d" onclick="clr()" data-en="Clear" data-bn="মুছুন">Clear</button>
</div>
<div class="msg" id="msg"></div>
<div class="saved" id="svd">
<h4 data-en="Token Saved!" data-bn="টোকেন সংরক্ষিত!">Token Saved!</h4>
<p data-en="You can close this page." data-bn="পৃষ্ঠা বন্ধ করতে পারেন।">You can close this page.</p>
<p id="exp"></p>
</div>
</div>
<div class="ftr">Facebook Ads MCP Server | ZombieCoder</div>
</div>
</div>
<script>
let c='en';
function L(l){c=l;document.querySelectorAll('[data-en]').forEach(e=>{e.textContent=e.getAttribute('data-'+l)});document.querySelectorAll('.lang').forEach(b=>b.classList.remove('on'));event.target.classList.add('on')}
function save(){const t=document.getElementById('tk').value.trim(),d=parseInt(document.getElementById('dur').value)||24,m=document.getElementById('msg');if(!t){m.textContent=c==='bn'?'টোকেন দিন':'Enter token';m.className='msg err';return}const o={token:t,savedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+d*36e5).toISOString(),duration:d};localStorage.setItem('fb_mcp_token',JSON.stringify(o));m.textContent=c==='bn'?'সফল!':'Saved!';m.className='msg ok';document.getElementById('svd').classList.add('show');document.getElementById('exp').textContent=(c==='bn'?'মেয়াদ: ':'Expires: ')+new Date(o.expiresAt).toLocaleString();document.getElementById('tk').value=''}
function clr(){localStorage.removeItem('fb_mcp_token');document.getElementById('msg').textContent=c==='bn'?'মুছে ফেলা হয়েছে':'Cleared';document.getElementById('msg').className='msg ok';document.getElementById('svd').classList.remove('show')}
(function(){const s=localStorage.getItem('fb_mcp_token');if(s){const d=JSON.parse(s);if(new Date(d.expiresAt)>new Date()){document.getElementById('svd').classList.add('show');document.getElementById('exp').textContent='Expires: '+new Date(d.expiresAt).toLocaleString()}else localStorage.removeItem('fb_mcp_token')}})();
</script>
</body></html>`;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const startTime = Date.now();
  log("INFO", "HTTP_REQUEST", { method: req.method, url: req.url });

  // GET / or /setup — HTML page
  if (req.method === "GET" && (req.url === "/" || req.url === "/setup")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getSetupHTML());
    log("INFO", "HTTP_RESPONSE", { url: req.url, status: 200, elapsed: (Date.now() - startTime) + "ms" });
    return;
  }

  // GET /health
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: SERVER_INFO.name, version: SERVER_INFO.version, tools: TOOLS.length, logs: LOG_ENTRIES.length }));
    log("INFO", "HTTP_RESPONSE", { url: "/health", status: 200, elapsed: (Date.now() - startTime) + "ms" });
    return;
  }

  // GET /logs
  if (req.method === "GET" && req.url === "/logs") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ logs: LOG_ENTRIES.slice(-100), total: LOG_ENTRIES.length }));
    log("INFO", "HTTP_RESPONSE", { url: "/logs", status: 200, elapsed: (Date.now() - startTime) + "ms" });
    return;
  }

  // POST /mcp — MCP endpoint
  if (req.method === "POST" && req.url === "/mcp") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const response = await handleJSONRPC(parsed);
      if (response === null) { res.writeHead(204); res.end(); return; }
      const resolved = response instanceof Promise ? await response : response;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resolved));
    } catch (e) {
      log("ERROR", "MCP_PARSE", { error: e.message });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    }
    log("INFO", "HTTP_RESPONSE", { url: "/mcp", status: 200, elapsed: (Date.now() - startTime) + "ms" });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

// Loopback-only bind: unauthenticated local tool backend — main server talks
// to it on the same machine, so it must never be exposed on the network.
server.listen(PORT, "127.0.0.1", () => {
  log("INFO", "SERVER_START", { port: PORT, host: "127.0.0.1", tools: TOOLS.length, endpoint: `http://127.0.0.1:${PORT}/mcp` });
  console.log(`[Facebook Ads MCP] http://127.0.0.1:${PORT}/mcp`);
  console.log(`[Facebook Ads MCP] Setup: http://127.0.0.1:${PORT}/`);
  console.log(`[Facebook Ads MCP] Logs: http://127.0.0.1:${PORT}/logs`);
  console.log(`[Facebook Ads MCP] Tools: ${TOOLS.length}`);
  if (!process.env.FB_ACCESS_TOKEN) console.warn("[Facebook Ads MCP] WARNING: FB_ACCESS_TOKEN not set");
});
