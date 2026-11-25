"use strict";

/**
 * modules/mcp-protocol.js — the MCP wire contract for this gateway.
 *
 * Three jobs, all deterministic:
 *
 *   1. Version negotiation. The client sends the protocol version it wants in
 *      `initialize`; the server echoes it when supported, otherwise it answers
 *      with the newest version it supports (MCP lifecycle rule). A response can
 *      never name a version this server does not implement.
 *
 *   2. Client identity. The six editors we support each have a small profile
 *      (transport, notes) so logs and the client registry can say which editor
 *      connected instead of "unknown". Detection is name/header based; an
 *      unknown client is `null`, never a guessed profile.
 *
 *   3. Header + workspace bootstrap. `validateMcpHeaders` rejects a version
 *      header older than the oldest supported release, a malformed session id,
 *      and an Accept that cannot receive JSON. A date NEWER than the newest
 *      supported release is accepted with `forwardProtocol: true`: clients such
 *      as opencode send a future date after negotiating an older version, and
 *      the JSON-RPC methods here are additive, so hard-failing strands the
 *      editor. The response still names a version this server implements.
 *      `bootstrapWorkspace` resolves the client workspace
 *      (roots → header → env → cwd) and creates the `.zombiecoder/` layout on
 *      first connect, so an editor never has to call `set_working_dir` just to
 *      get a working directory.
 *
 * Supported versions are ordered newest first. `PROTOCOL_VERSION` is the
 * fallback and must always be `SUPPORTED_PROTOCOL_VERSIONS[0]`.
 */

const crypto = require("crypto");
const path = require("path");

const {
  MARKER_DIR,
  fileUriToPath,
  resolveWorkspace,
  ensureWorkspace,
  ensureWorkspacePaths,
  workspaceFingerprint,
} = require("./workspace");

const PROTOCOL_VERSION = "2025-06-18";

const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const SERVER_NAME = "mission-barisal";

// Header names are matched case-insensitively because Node lowercases incoming
// headers while test doubles and other runtimes may not.
const HEADER_PROTOCOL = "mcp-protocol-version";
const HEADER_SESSION = "mcp-session-id";
const HEADER_ACCEPT = "accept";
const HEADER_CLIENT_DIR = "x-mcp-client-dir";
const HEADER_CLIENT_NAME = "x-mcp-client-name";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const JSON_ACCEPT_PATTERN = /(application\/json|\*\/\*)/i;
const PROTOCOL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ISO dates compare lexicographically. A newer date is forward-compatible; an
// unknown OLD date is not, because required fields may have been removed since.
function isForwardProtocolVersion(version) {
  if (!PROTOCOL_DATE_PATTERN.test(version)) return false;
  // Reject impossible dates such as 2026-13-99 before comparing strings.
  const parsed = Date.parse(version + "T00:00:00Z");
  if (!Number.isFinite(parsed)) return false;
  if (new Date(parsed).toISOString().slice(0, 10) !== version) return false;
  return version > SUPPORTED_PROTOCOL_VERSIONS[0];
}

/**
 * Editor profiles. `match` patterns are tested against the client name,
 * title, user-agent and the X-MCP-Client-Name header.
 */
const EDITOR_PROFILES = Object.freeze([
  Object.freeze({
    id: "opencode",
    label: "OpenCode",
    transport: "stdio+http",
    match: [/opencode/i],
    notes: "Sends initialize over HTTP/UDS; workspace comes from the session directory.",
  }),
  Object.freeze({
    id: "hermes-vscode",
    label: "Hermes Agent (VS Code)",
    transport: "stdio",
    match: [/hermes/i],
    notes: "VS Code extension; X-MCP-Client-Dir is expanded from ${workspaceFolder}.",
  }),
  Object.freeze({
    id: "cursor",
    label: "Cursor",
    transport: "stdio+http",
    match: [/cursor/i],
    notes: "Expands ${workspaceFolder} in headers; roots are preferred over the header.",
  }),
  Object.freeze({
    id: "plot",
    label: "Plot",
    transport: "http",
    match: [/\bplot\b/i],
    notes: "HTTP client; expects a JSON initialize response.",
  }),
  Object.freeze({
    id: "jetbrains",
    label: "JetBrains",
    transport: "stdio+uds",
    match: [
      /(jetbrains|intellij|webstorm|pycharm|goland|rubymine|phpstorm|clion|rider|datagrip|appcode)/i,
    ],
    notes: "JetBrains MCP plugin; may use the Unix domain socket transport.",
  }),
  Object.freeze({
    id: "windsurf",
    label: "Windsurf",
    transport: "stdio+http",
    match: [/windsurf/i],
    notes: "HTTP client; sends initialize with clientInfo and optional roots.",
  }),
]);

function clean(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const value = headers[key];
    return Array.isArray(value) ? value.join(", ") : clean(value);
  }
  return "";
}

/**
 * Negotiate the protocol version for one initialize call.
 * @param {string} requested
 * @returns {{version: string, requested: string, supported: boolean, fallback: boolean}}
 */
function negotiateProtocolVersion(requested) {
  const raw = clean(requested);
  if (raw && SUPPORTED_PROTOCOL_VERSIONS.includes(raw)) {
    return { version: raw, requested: raw, supported: true, fallback: false };
  }
  return {
    version: PROTOCOL_VERSION,
    requested: raw,
    supported: false,
    fallback: raw.length > 0,
  };
}

/**
 * Identify the editor from clientInfo plus headers.
 * @param {{name?: string, title?: string, version?: string}} [clientInfo]
 * @param {object} [headers]
 * @returns {{id: string, label: string, transport: string, notes: string}|null}
 */
function detectEditor(clientInfo, headers) {
  const info = clientInfo || {};
  const haystack = [
    info.name,
    info.title,
    info.description,
    headerValue(headers, HEADER_CLIENT_NAME),
    headerValue(headers, "user-agent"),
  ]
    .map(clean)
    .filter(Boolean)
    .join(" ");
  if (!haystack) return null;
  for (const profile of EDITOR_PROFILES) {
    if (profile.match.some((pattern) => pattern.test(haystack))) {
      return {
        id: profile.id,
        label: profile.label,
        transport: profile.transport,
        notes: profile.notes,
      };
    }
  }
  return null;
}

/**
 * Validate the MCP HTTP headers we understand. Missing headers are allowed so
 * older JSON-RPC clients keep working; a present-but-wrong header is rejected.
 * @param {object} headers
 * @returns {{ok: boolean, errors: Array, protocolVersion: string,
 *            sessionId: string, accept: string, clientDir: string}}
 */
// The forward-compat notice is emitted once per client+version, not once per
// request: a broken client can send hundreds of tool calls in a minute.
const _forwardProtocolLogged = new Set();

function noteForwardProtocol(check, clientName) {
  if (!check || !check.forwardProtocol) return null;
  const key = (clientName || "unknown") + "|" + check.protocolVersion;
  if (_forwardProtocolLogged.has(key) || _forwardProtocolLogged.size >= 100) {
    return null;
  }
  _forwardProtocolLogged.add(key);
  return {
    client: clientName || "unknown",
    requested: check.protocolVersion,
    negotiated: PROTOCOL_VERSION,
    note: "accepted; response names a supported version",
  };
}
function validateMcpHeaders(headers) {
  const errors = [];
  const protocolVersion = headerValue(headers, HEADER_PROTOCOL);
  const sessionId = headerValue(headers, HEADER_SESSION);
  const accept = headerValue(headers, HEADER_ACCEPT);
  const clientDir = headerValue(headers, HEADER_CLIENT_DIR);
  const forwardProtocol =
    !!protocolVersion &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion) &&
    isForwardProtocolVersion(protocolVersion);

  if (
    protocolVersion &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion) &&
    !forwardProtocol
  ) {
    errors.push({
      code: "ZC_MCP_VERSION",
      field: "MCP-Protocol-Version",
      value: protocolVersion,
      message: "is not a supported protocol version (" + SUPPORTED_PROTOCOL_VERSIONS.join(", ") + ")",
    });
  }
  if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) {
    errors.push({
      code: "ZC_MCP_SESSION",
      field: "Mcp-Session-Id",
      value: sessionId.slice(0, 64),
      message: "is not a valid session id",
    });
  }
  if (accept && !JSON_ACCEPT_PATTERN.test(accept)) {
    errors.push({
      code: "ZC_MCP_ACCEPT",
      field: "Accept",
      value: accept.slice(0, 120),
      message: "must allow application/json",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    protocolVersion,
    // True when the client named a date newer than this server implements.
    // The call is accepted, but the negotiated version in the response is
    // still one of SUPPORTED_PROTOCOL_VERSIONS.
    forwardProtocol,
    sessionId,
    accept,
    clientDir,
  };
}

/**
 * A stable session id for one editor + workspace pair. Re-initializing the same
 * editor on the same workspace keeps the id, so a client can reuse it across
 * reconnects without the server storing per-connection state.
 */
function sessionIdFor(spec) {
  const s = spec || {};
  const editorId = s.editor && s.editor.id ? s.editor.id : clean(s.editor) || "client";
  const workspaceDir = clean(s.workspaceDir) || "no-workspace";
  const digest = crypto
    .createHash("sha256")
    .update(editorId + "\u0000" + workspaceDir)
    .digest("hex")
    .slice(0, 24);
  return "zc-" + digest;
}

/**
 * Resolve the client workspace and create the server-owned `.zombie/` layout.
 *
 * Layout creation is opt-in by evidence: only `roots`, the compact workspace
 * id, the client-directory header or an explicit workspace env key prove which
 * project the request belongs to. A bare `cwd` fallback must not bootstrap a
 * tree — the mutable MCP working directory used to leak into `cwd` and create a
 * full duplicate workspace inside whatever directory a previous request had
 * selected.
 *
 * Existing SSOT/syllabus files are never overwritten by the layout itself.
 * @param {{roots?: Array, workspaceId?: string, headerDir?: string,
 *          env?: object, cwd?: string, seedSSOT?: Function}} [spec]
 */
function bootstrapWorkspace(spec) {
  const s = spec || {};
  const resolved = resolveWorkspace({
    roots: s.roots,
    workspaceId: s.workspaceId,
    headerDir: s.headerDir,
    env: s.env,
    cwd: s.cwd,
  });
  const paths = ensureWorkspacePaths(resolved.dir);
  let layout = null;
  if (resolved.source !== "cwd") {
    layout = ensureWorkspace(resolved.dir, { seedSSOT: s.seedSSOT });
  }
  const fingerprint = workspaceFingerprint(resolved.dir);
  return {
    dir: resolved.dir,
    source: resolved.source,
    marker: paths.dir,
    paths: {
      marker: paths.dir,
      ssot: paths.ssot,
      syllabus: paths.syllabus,
      memory: paths.memory,
      state: paths.state,
      legacySyllabus: paths.legacy_syllabus,
      legacySessions: paths.legacy_sessions,
    },
    created: layout ? layout.created : [],
    legacy: layout ? layout.legacy : null,
    fingerprint: fingerprint.combined,
  };
}

/**
 * Build the JSON-RPC initialize result.
 * @param {{requestedVersion?: string, clientInfo?: object, headers?: object,
 *          workspace?: {dir?: string}, rootsDetected?: boolean,
 *          serverVersion?: string, domain?: string, serverType?: string,
 *          capabilities?: object, serverInfo?: object, editor?: object}} [spec]
 */
function buildInitializeResult(spec) {
  const s = spec || {};
  const negotiated = negotiateProtocolVersion(s.requestedVersion);
  const editor = s.editor || detectEditor(s.clientInfo, s.headers);
  const workspaceDir = s.workspace && s.workspace.dir ? path.resolve(s.workspace.dir) : "";

  const serverInfo = Object.assign(
    {
      name: SERVER_NAME,
      version: clean(s.serverVersion) || "3.2.1",
      domain: clean(s.domain),
      serverType: clean(s.serverType),
      working_dir: workspaceDir,
      zombiecoder_dir: workspaceDir ? path.join(workspaceDir, MARKER_DIR) : "",
      roots_detected: Boolean(s.rootsDetected),
      editor: editor ? editor.id : "",
    },
    s.serverInfo || {},
  );

  return {
    protocolVersion: negotiated.version,
    capabilities: s.capabilities || { tools: {} },
    serverInfo,
    _meta: {
      requestedProtocolVersion: negotiated.requested,
      protocolFallback: negotiated.fallback,
      editor: editor ? editor.id : "",
      transport: clean(s.transport),
    },
  };
}

/** Response headers for an initialize reply. */
function initializeHeaders(spec) {
  const s = spec || {};
  const version = clean(s.protocolVersion) || negotiateProtocolVersion(s.requestedVersion).version;
  const sessionId =
    clean(s.sessionId) ||
    sessionIdFor({ editor: s.editor, workspaceDir: s.workspaceDir });
  return {
    "MCP-Protocol-Version": version,
    "Mcp-Session-Id": sessionId,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_NAME,
  EDITOR_PROFILES,
  SESSION_ID_PATTERN,
  headerValue,
  negotiateProtocolVersion,
  detectEditor,
  validateMcpHeaders,
  noteForwardProtocol,
  sessionIdFor,
  bootstrapWorkspace,
  buildInitializeResult,
  initializeHeaders,
  fileUriToPath,
};
