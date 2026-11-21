# Surface policy

**Status:** `ACTIVE` — runbook row 13 (`SURFACE_POLICY_OK`).
**Source of truth:** `modules/surface-policy.js`. The table below is generated
from that module; `tests/surface-policy-check.js` fails when the two drift.

## Trust boundaries

- **web-chat** is the browser chat window (`channel=web-chat`). It only sees
  `web_search`, `get_time` and `calculate`; file, shell and privileged tools
  are never offered to it. The channel check is a hard error, not a warning.
- **mission** (`POST /api/mission`, `agent_mission`, `agent_single`) sees the
  full tool catalog. Its tool calls run **in-process** through
  `executeMcpTool`, so the transport-level admin gate does not apply. This is
  recorded as `in-process`, never as `admin-token`.
- **editor** (`POST /mcp`, `/v1/chat/completions`, UDS) sees the full catalog.
  Privileged tools require `MCP_ADMIN_TOKEN` / `ADMIN_API_KEY` at `mcpGate`.
- No surface is an admin surface. The admin panel is separate from all three.

## Table

<!-- SURFACE_POLICY_TABLE_START -->
| Surface | Entry | Tools | Privileged | File write | Shell | Web | Auth |
|---|---|---|---|---|---|---|---|
| web-chat | POST /v1/chat/completions (channel=web-chat), WS chat | web_search, get_time, calculate | deny | deny | deny | allow | none |
| mission | POST /api/mission, agent_mission, agent_single | full catalog | in-process | in-process | in-process | allow | optional user session |
| editor | POST /mcp, /v1/chat/completions, UDS | full catalog | admin-token | admin-token | admin-token | allow | admin token for privileged tools |
<!-- SURFACE_POLICY_TABLE_END -->

## Verification

```bash
node tests/surface-policy-check.js   # exit 0 + SURFACE_POLICY_OK
```
