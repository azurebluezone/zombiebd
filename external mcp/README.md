# External MCP — Mission Barisal

এই folder থেকে **আলাদা external MCP server** যোগ করা যায় — **`api.js` স্পর্শ করতে হয় না**।

## কিভাবে কাজ করে

1. `mcp-client.js` (MCPClientManager) এখানকার `servers.json` পড়ে
2. প্রতিটা `enabled` server-এ JSON-RPC 2.0 দিয়ে connect হয়
3. Discover করা tools `MCP_TOOLS`-এ merge হয়: **`<server>__<tool>`** নামে
4. Agent যেই tool call করে, সেটা external server-এ forward হয়

## নতুন service যোগ করার নিয়ম

`servers.json`-এ একটা entry যোগ করুন:

```json
{
  "name": "my-service",
  "url": "https://example.com/mcp",
  "transport": "http",
  "enabled": true,
  "autoConnect": true,
  "token": ""
}
```

- `name` — unique নাম (tool prefix হবে `my-service__`)
- `url` — MCP endpoint (JSON-RPC 2.0, POST)
- `enabled: false` — সাসপেন্ড করতে
- `token` — যদি server-এ auth লাগে

রিস্টার্ট করলেই কাজ করবে।

## URL থেকে সরাসরি load

`EXTERNAL_MCP_URLS` env var দিয়েও load করা যায় (কমা দিয়ে আলাদা):

```bash
EXTERNAL_MCP_URLS="https://b.zombiecoder.my.id/mcp,http://localhost:9100/mcp"
```

server name auto-generate হয় hostname থেকে (`b-zombiecoder-my-id`).

## কীভাবে চেক করবেন

- `GET /api/mcp-external` — সব external server-এর status
- `GET /api/mcp-clients` — connected clients
- tools list-এ `<server>__<tool>` দেখবেন

## মনে রাখবেন

- আপনার নিজের mini-service হলে transport `http` (localhost) — দ্রুত
- বাইরের server হলে `https` — secure
- Two-way: folder-এর `servers.json` **PLUS** `EXTERNAL_MCP_URLS` — দুইটা একসাথে work করে