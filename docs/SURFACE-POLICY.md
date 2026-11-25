# Surface policy

**Status:** `ACTIVE` — runbook row 13 (`SURFACE_POLICY_OK`).
**Source of truth:** `modules/surface-policy.js`. The table below is generated
from that module; `tests/surface-policy-check.js` fails when the two drift.

## Trust boundaries

- **web-chat** is the browser chat window (`channel=web-chat`). It only sees
  `web_search`, `get_time` and `calculate`; file, shell and privileged tools
  are never offered to it. The channel check is a hard error, not a warning.
- **mission** (`POST /api/mission`, `agent_mission`, `agent_single`) sees the
  full tool catalog. Privileged tools (`terminal`, `write_file`, ...) require
  `ADMIN_TOKEN`/`MCP_ADMIN_TOKEN` at the request gate, and `executeMcpTool`
  blocks them again if the context did not pass. `MISSION_ALLOW_PRIVILEGED=true`
  is the explicit development opt-out. The MCP `agent_mission` path still runs
  in-process: it is called by local clients without a credential, so its
  privileged boundary remains the deployment OS user.
- **editor** (`POST /mcp`, `/v1/chat/completions`, UDS) sees the full catalog.
  Privileged tools require `MCP_ADMIN_TOKEN` / `ADMIN_API_KEY` at `mcpGate`.
- No surface is an admin surface. The admin panel is separate from all three.

## Table

<!-- SURFACE_POLICY_TABLE_START -->
| Surface | Entry | Tools | Privileged | File write | Shell | Web | Auth |
|---|---|---|---|---|---|---|---|
| web-chat | POST /v1/chat/completions (channel=web-chat), WS chat | web_search, get_time, calculate | deny | deny | deny | allow | none |
| mission | POST /api/mission, agent_mission, agent_single | full catalog | admin-token | admin-token | admin-token | allow | optional user session; admin token for privileged tools |
| editor | POST /mcp, /v1/chat/completions, UDS | full catalog | admin-token | admin-token | admin-token | allow | admin token for privileged tools |
<!-- SURFACE_POLICY_TABLE_END -->

## Verification

```bash
node tests/surface-policy-check.js   # exit 0 + SURFACE_POLICY_OK
```
