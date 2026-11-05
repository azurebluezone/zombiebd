// =============================================================================
// Combined MCP Gateway — ONE port, BOTH tool sets
// -----------------------------------------------------------------------------
// Exposes Facebook Ads MCP (3001) + Public API MCP (3002) behind a SINGLE port.
// The gateway proxies MCP JSON-RPC to the correct backend based on tool name.
//
// Usage:
//   node combined.js                     → listens on 3105 (default)
//   node combined.js 4000                → listens on 4000
//   COMBINED_MCP_PORT=3200 node combined.js → listens on 3200
//
// Zero dependencies — uses only Node.js built-in modules.
// Backends (3001/3002) must be started first via `node start.js`.
// =============================================================================

const http = require("http");

// ─── Configuration ──────────────────────────────────────────────────────────
// Port precedence: argv[2] → COMBINED_MCP_PORT → 3105.
//
// NOTE: the generic `process.env.PORT` is deliberately NOT consulted here.
// start.js loads .env (PORT=3000 = main server) into process.env and spawns
// children with that env, so falling back to PORT would make this gateway
// try to bind the MAIN SERVER's port and crash with EADDRINUSE. Default is
// 3105 (not 3100) because ocr-mcp.js owns 3100 by default — they must be
// able to run at the same time. Use the dedicated COMBINED_MCP_PORT (or an
// argv port) instead of PORT if you need a different port.
const GATEWAY_PORT = parseInt(
    process.argv[2] || process.env.COMBINED_MCP_PORT || "3105",
    10,
);
const BACKENDS = {
    // Ports come from the environment so a second deployment can run beside
    // the first. Hardcoding 3001/3002 made this gateway always point at
    // whatever instance owned those defaults.
    "facebook-ads": {
      host: process.env.FB_ADS_MCP_HOST || "127.0.0.1",
      port: parseInt(process.env.FB_ADS_MCP_PORT || "3001", 10),
      prefix: "ads_",
    },
    "public-api": {
      host: process.env.PUBLIC_API_MCP_HOST || "127.0.0.1",
      port: parseInt(process.env.PUBLIC_API_MCP_PORT || "3002", 10),
      prefix: "public",
    },
};

// ─── MCP Proxy Helper (POST /mcp to a backend) ─────────────────────────────
function mcpRequest(backend, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
            {
                hostname: backend.host,
                port: backend.port,
                path: "/mcp",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(payload),
                },
                timeout: 15000,
            },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    try {
                        resolve({ status: res.statusCode, json: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode, json: null });
                    }
                });
            },
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy();
            reject(new Error("Backend timeout"));
        });
        req.write(payload);
        req.end();
    });
}

// ─── Route a tools/call to the correct backend ─────────────────────────────
function routeBackend(toolName) {
    if (toolName.startsWith("ads_")) return "facebook-ads";
    return "public-api";
}

// ─── Handle JSON-RPC on the gateway ────────────────────────────────────────
async function handleGatewayRPC(body) {
    const { id, method, params } = body;
    if (id === undefined || id === null) return null;

    switch (method) {
        case "initialize": {
            // Ask Facebook backend (primary) for protocol info
            const res = await mcpRequest(BACKENDS["facebook-ads"], body);
            if (res.json?.result) {
                return {
                    jsonrpc: "2.0",
                    id,
                    result: {
                        protocolVersion: res.json.result.protocolVersion,
                        capabilities: res.json.result.capabilities,
                        serverInfo: { name: "combined-mcp", version: "1.0.0" },
                    },
                };
            }
            return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "combined-mcp", version: "1.0.0" } } };
        }

        case "notifications/initialized":
            // Fire-and-forget to both backends
            await Promise.allSettled([
                mcpRequest(BACKENDS["facebook-ads"], body),
                mcpRequest(BACKENDS["public-api"], body),
            ]);
            return null;

        case "ping":
            return { jsonrpc: "2.0", id, result: {} };

        case "tools/list": {
            // Fetch tools from BOTH backends and merge
            const [fb, pub] = await Promise.allSettled([
                mcpRequest(BACKENDS["facebook-ads"], body),
                mcpRequest(BACKENDS["public-api"], body),
            ]);
            const tools = [];
            if (fb.status === "fulfilled" && fb.value.json?.result?.tools) {
                tools.push(...fb.value.json.result.tools);
            }
            if (pub.status === "fulfilled" && pub.value.json?.result?.tools) {
                tools.push(...pub.value.json.result.tools);
            }
            return { jsonrpc: "2.0", id, result: { tools } };
        }

        case "tools/call": {
            const { name, arguments: args } = params || {};
            const backend = BACKENDS[routeBackend(name || "")];
            const res = await mcpRequest(backend, body);
            if (res.json) return { jsonrpc: "2.0", id, ...res.json };
            return {
                jsonrpc: "2.0",
                id,
                error: { code: -32000, message: `Backend ${backend.port} unreachable` },
            };
        }

        default:
            return {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `Method not found: ${method}` },
            };
    }
}

// ─── Health check all backends ─────────────────────────────────────────────
async function healthStatus() {
    const results = {};
    for (const [name, b] of Object.entries(BACKENDS)) {
        try {
            const res = await mcpRequest(b, {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
            });
            results[name] = {
                port: b.port,
                status: "ok",
                tools: res.json?.result?.tools?.length || 0,
            };
        } catch (e) {
            results[name] = { port: b.port, status: "error", error: e.message };
        }
    }
    return results;
}

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    // GET / — status page
    if (req.method === "GET" && req.url === "/") {
        const health = await healthStatus();
        const totalTools = Object.values(health).reduce(
            (sum, h) => sum + (h.tools || 0),
            0,
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Combined MCP Gateway</title>
<style>body{font-family:system-ui;background:#0a0a0f;color:#e0e0e0;padding:40px;text-align:center}
.card{max-width:560px;margin:0 auto;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px}
h1{font-size:22px;margin-bottom:8px}.ok{color:#66bb6a}.err{color:#ef5350}
.mono{font-family:monospace;background:rgba(255,255,255,.08);padding:4px 10px;border-radius:6px}
li{list-style:none;text-align:left;margin:8px 0}</style></head><body>
<div class="card">
<h1>Combined MCP Gateway</h1>
<p>One port, both tool sets — Mission Barisal</p>
<br>
<ul>
${Object.entries(health)
                .map(
                    ([n, h]) =>
                        `<li>${n}: <span class="${h.status === "ok" ? "ok" : "err"}">${h.status}</span> — ${h.tools || 0} tools (port ${h.port})</li>`,
                )
                .join("")}
</ul>
<h3>Total: ${totalTools} tools</h3>
<br>
<p>MCP Endpoint: <span class="mono">POST http://localhost:${GATEWAY_PORT}/mcp</span></p>
<p>Add to main server .env:<br>
<span class="mono">MCP_ADD_1=combined|http://localhost:${GATEWAY_PORT}</span></p>
</div></body></html>`);
        return;
    }

    // GET /health — JSON status
    if (req.method === "GET" && req.url === "/health") {
        const health = await healthStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ gateway: "combined-mcp", port: GATEWAY_PORT, backends: health }));
        return;
    }

    // POST /mcp — MCP protocol (the main event)
    if (req.method === "POST" && req.url === "/mcp") {
        let body = "";
        for await (const chunk of req) body += chunk;
        try {
            const parsed = JSON.parse(body);
            const response = await handleGatewayRPC(parsed);
            if (response === null) {
                res.writeHead(204);
                res.end();
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
        } catch (e) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: null,
                    error: { code: -32700, message: "Parse error: " + e.message },
                }),
            );
        }
        return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /mcp for MCP protocol." }));
});

// Loopback-only bind: this gateway is an unauthenticated local tool backend
// reached by the main server on the same machine — never expose it on LAN.
server.listen(GATEWAY_PORT, "127.0.0.1", () => {
    console.log(`[Combined MCP Gateway] http://127.0.0.1:${GATEWAY_PORT}/mcp`);
    console.log(`[Backends] facebook-ads:${process.env.FB_ADS_MCP_PORT || "3001"} + public-api:${process.env.PUBLIC_API_MCP_PORT || "3002"} → merged`);
    console.log(`[Usage] node combined.js [PORT]`);
});
