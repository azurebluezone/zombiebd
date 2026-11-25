"use strict";

/**
 * lib/fs-scope.js — one decision for the agent filesystem scope.
 *
 *   session      (default) workspace + ALLOWED_DIRS only
 *   restricted   legacy: workspace + ALLOWED_DIRS + $HOME
 *   unrestricted explicit opt-in only (AGENT_FS_SCOPE=unrestricted)
 *
 * Before this module the default was unrestricted, so a fresh checkout had no
 * filesystem boundary at all. The shell still runs as the gateway OS user;
 * that deployment boundary is recorded in the runbook, not silently claimed.
 */

const path = require("path");

const UNRESTRICTED = new Set(["unrestricted", "root", "any"]);

function mode(env) {
  const source = env || process.env;
  const raw = String(source.AGENT_FS_SCOPE || "").trim().toLowerCase();
  if (UNRESTRICTED.has(raw)) return "unrestricted";
  if (raw === "restricted") return "restricted";
  return "session";
}

function isUnrestricted(value) {
  return (value || mode()) === "unrestricted";
}

function rootsFor(spec) {
  const s = spec || {};
  const current = s.mode || mode();
  if (current === "unrestricted") return null;
  const roots = [];
  const workDir = s.workingDir ? path.resolve(String(s.workingDir)) : "";
  if (workDir) roots.push(workDir);
  for (const dir of s.allowedDirs || []) {
    if (!dir) continue;
    const resolved = path.resolve(String(dir));
    // A root directory ("/" or "C:\\") would allow everything; never add it
    // implicitly. Unrestricted is the explicit way to say that.
    if (resolved === path.sep || resolved === path.parse(resolved).root) continue;
    roots.push(resolved);
  }
  if (current === "restricted" && s.homeDir) {
    const home = path.resolve(String(s.homeDir));
    if (home !== path.sep && home !== path.parse(home).root) roots.push(home);
  }
  return Array.from(new Set(roots));
}

function within(target, roots) {
  if (!roots || roots.length === 0) return false;
  const resolved = path.resolve(String(target));
  return roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

/**
 * Detect the classic `cd /outside && cat secret` escape at the command level.
 * This is a narrow guard: it only rejects an explicit `cd` to an absolute path
 * outside the roots. Relative traversal is resolved against cwd by the shell,
 * and the cwd itself is checked before the spawn.
 */
function commandEscapes(command, spec) {
  const s = spec || {};
  if (s.mode === "unrestricted" || isUnrestricted(s.mode)) return false;
  const roots = Array.isArray(s.roots) ? s.roots : rootsFor(s);
  if (!roots || !roots.length) return false;
  const text = String(command || "");
  const cd = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let match;
  while ((match = cd.exec(text)) !== null) {
    const target = match[1] || match[2] || match[3] || "";
    if (!target || target === "-" || target.startsWith("$")) continue;
    if (!path.isAbsolute(target)) continue;
    if (!within(target, roots)) return true;
  }
  return false;
}

module.exports = { mode, isUnrestricted, rootsFor, within, commandEscapes };
