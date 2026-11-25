"use strict";

/**
 * lib/mission-privilege.js — the /api/mission privilege decision.
 *
 * Surface policy: mission sees the full catalog, so a model can call
 * terminal/exec/write_file/... in-process. Those tools are allowed only when
 *   - the request carries an admin credential, or
 *   - the operator explicitly accepts the risk with MISSION_ALLOW_PRIVILEGED=true.
 * The request body itself can never opt in.
 */

function privilegedToolNames(tools, isPrivileged) {
  const check = typeof isPrivileged === "function" ? isPrivileged : () => false;
  const list = Array.isArray(tools) ? tools : [];
  const names = [];
  for (const item of list) {
    const name = typeof item === "string" ? item : (item && (item.name || (item.function && item.function.name))) || "";
    if (name && check(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * Decide whether privileged mission tools may run. `accept` is the
 * server-side MISSION_ALLOW_PRIVILEGED flag, never a client field.
 */
function decide(spec) {
  const s = spec || {};
  const privileged = privilegedToolNames(s.tools, s.isPrivileged);
  if (s.adminAuthorized === true) {
    return { allowed: true, via: "admin-token", privileged, reason: "admin_token" };
  }
  if (s.accept === true) {
    return { allowed: true, via: "explicit-accept", privileged, reason: "operator_accept" };
  }
  if (!privileged.length) {
    // The auto-injected catalog still contains privileged names, so an empty
    // request list is not a reason to allow execution. `allowed:false` keeps
    // the execution gate closed; only an empty *effective* catalog is safe.
    return { allowed: false, via: "denied", privileged, reason: "no_admin_token" };
  }
  return { allowed: false, via: "denied", privileged, reason: "mission_privileged_requires_admin" };
}

module.exports = { privilegedToolNames, decide };
