#!/usr/bin/env node
// =============================================================================
// Screen Recorder MCP Tool — Mission Barisal v3
// Zero dependency (uses system ffmpeg for recording + screenshot)
//
// Tools:
//   screen_screenshot  — Take a screenshot
//   screen_record_start — Start screen recording
//   screen_record_stop  — Stop recording + return file path
//   screen_record_status — Check if recording is active
//
// Usage: node "external mcp/screen-recorder-mcp.js"
// =============================================================================

const { exec, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.SCREEN_MCP_PORT || "3101", 10);
const RECORDINGS_DIR = process.env.SCREEN_RECORDINGS_DIR || path.join(os.homedir(), "zombie-recordings");
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let activeRecordings = new Map(); // id → { process, outputPath, startedAt }

// ─── Helpers ──────────────────────────────────────────────
// ASYNC on purpose: the previous execSync version froze the WHOLE process for
// up to `timeoutMs` (15s) per call (screenshot/ffmpeg) — no other MCP request
// could be served meanwhile. Same timeout + stderr semantics; ALL call sites
// must `await run(...)`.
function run(cmd, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

async function getScreenSize() {
  try {
    const out = await run("xdpyinfo | grep dimensions | awk '{print $2}'");
    const [w, h] = out.split("x").map(Number);
    return { width: w || 1920, height: h || 1080 };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Tool Definitions ─────────────────────────────────────
const TOOLS = [
  {
    name: "screen_screenshot",
    description: "Take a screenshot of the entire screen or a specific region. Returns file path.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Capture region: 'full' (default) or 'WxH+X+Y' (e.g. '800x600+100+200')"
        },
        format: {
          type: "string",
          enum: ["png", "jpg"],
          description: "Output format (default: png)"
        },
        output: {
          type: "string",
          description: "Custom output path (optional, auto-generated if empty)"
        }
      },
      required: []
    }
  },
  {
    name: "screen_record_start",
    description: "Start recording the screen. Returns recording ID. Use screen_record_stop to stop.",
    inputSchema: {
      type: "object",
      properties: {
        duration: {
          type: "number",
          description: "Max recording duration in seconds (default: 300 = 5 min). Auto-stops."
        },
        fps: {
          type: "number",
          description: "Frames per second (default: 15). Lower = smaller file."
        },
        region: {
          type: "string",
          description: "Record region: 'full' (default) or 'WxH+X+Y'"
        },
        format: {
          type: "string",
          enum: ["mp4", "webm", "mkv"],
          description: "Output format (default: mp4)"
        },
        output: {
          type: "string",
          description: "Custom output path (optional)"
        },
        audio: {
          type: "boolean",
          description: "Record system audio (default: false). Requires PulseAudio."
        }
      },
      required: []
    }
  },
  {
    name: "screen_record_stop",
    description: "Stop the active screen recording. Returns the file path and duration.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "Recording ID to stop (from screen_record_start). If empty, stops the most recent."
        }
      },
      required: []
    }
  },
  {
    name: "screen_record_status",
    description: "Check if a screen recording is active. Lists all active recordings.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

// ─── Tool Execution ───────────────────────────────────────
async function executeTool(name, args) {
  const startTime = Date.now();

  switch (name) {
    case "screen_screenshot": {
      const region = args.region || "full";
      const format = args.format || "png";
      const ext = format === "jpg" ? "jpg" : "png";
      const outputPath = args.output || path.join(RECORDINGS_DIR, `screenshot-${Date.now()}.${ext}`);

      try {
        const size = await getScreenSize();
        if (region === "full") {
          await run(`ffmpeg -f x11grab -video_size ${size.width}x${size.height} -i :0.0 -frames:v 1 "${outputPath}" -y 2>/dev/null`);
        } else {
          await run(`ffmpeg -f x11grab -video_size ${region} -i :0.0 -frames:v 1 "${outputPath}" -y 2>/dev/null`);
        }

        const stat = fs.statSync(outputPath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              path: outputPath,
              size_kb: Math.round(stat.size / 1024),
              format,
              elapsed_ms: Date.now() - startTime
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Screenshot error: ${e.message}` }] };
      }
    }

    case "screen_record_start": {
      const duration = args.duration || 300;
      const fps = args.fps || 15;
      const region = args.region || "full";
      const format = args.format || "mp4";
      const audio = args.audio || false;
      const recId = generateId();
      const outputPath = args.output || path.join(RECORDINGS_DIR, `recording-${recId}.${format}`);

      try {
        const size = await getScreenSize();
        let videoSize = region === "full" ? `${size.width}x${size.height}` : region;

        const ffmpegArgs = [
          "-f", "x11grab",
          "-video_size", videoSize,
          "-framerate", String(fps),
          "-i", ":0.0",
          "-t", String(duration),
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-pix_fmt", "yuv420p",
        ];

        if (audio) {
          ffmpegArgs.push("-f", "pulse", "-i", "default");
        }

        ffmpegArgs.push("-y", outputPath);

        const proc = spawn("ffmpeg", ffmpegArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          detached: false
        });

        activeRecordings.set(recId, {
          process: proc,
          outputPath,
          startedAt: Date.now(),
          duration,
          fps,
          region,
          format
        });

        proc.on("exit", (code) => {
          const rec = activeRecordings.get(recId);
          if (rec) {
            rec.endedAt = Date.now();
            rec.exitCode = code;
          }
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              recording_id: recId,
              output: outputPath,
              max_duration_sec: duration,
              fps,
              video_size: videoSize,
              audio,
              message: `Recording started. Use screen_record_stop(id: "${recId}") to stop.`,
              elapsed_ms: Date.now() - startTime
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Record start error: ${e.message}` }] };
      }
    }

    case "screen_record_stop": {
      const recId = args.recording_id;

      // Find recording
      let targetId = recId;
      if (!targetId) {
        // Get the most recent active recording
        let latest = null;
        for (const [id, rec] of activeRecordings) {
          if (!latest || rec.startedAt > latest.startedAt) {
            latest = { id, ...rec };
          }
        }
        if (!latest) {
          return { content: [{ type: "text", text: "No active recording found." }] };
        }
        targetId = latest.id;
      }

      const rec = activeRecordings.get(targetId);
      if (!rec) {
        return { content: [{ type: "text", text: `Recording not found: ${targetId}` }] };
      }

      // Send SIGINT to stop ffmpeg gracefully
      try {
        rec.process.kill("SIGINT");
        // Wait up to 5 seconds for graceful exit
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try { rec.process.kill("SIGKILL"); } catch {}
            resolve();
          }, 5000);
          rec.process.on("exit", () => { clearTimeout(timeout); resolve(); });
          // If already dead
          if (rec.process.exitCode !== null) { clearTimeout(timeout); resolve(); }
        });
      } catch {}

      const elapsed = Math.round((Date.now() - rec.startedAt) / 1000);
      let fileSize = 0;
      try { fileSize = fs.statSync(rec.outputPath).size; } catch {}

      activeRecordings.delete(targetId);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            recording_id: targetId,
            path: rec.outputPath,
            duration_sec: elapsed,
            size_mb: Math.round(fileSize / 1024 / 1024 * 100) / 100,
            format: rec.format,
            fps: rec.fps
          }, null, 2)
        }]
      };
    }

    case "screen_record_status": {
      const recordings = [];
      for (const [id, rec] of activeRecordings) {
        recordings.push({
          recording_id: id,
          started_at: new Date(rec.startedAt).toISOString(),
          elapsed_sec: Math.round((Date.now() - rec.startedAt) / 1000),
          max_duration_sec: rec.duration,
          fps: rec.fps,
          region: rec.region,
          format: rec.format,
          output: rec.outputPath,
          pid: rec.process.pid,
          alive: rec.process.exitCode === null
        });
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            active_count: recordings.length,
            recordings,
            recordings_dir: RECORDINGS_DIR
          }, null, 2)
        }]
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ─── MCP JSON-RPC Server (HTTP) ──────────────────────────
const http = require("http");

// ─── MCP JSON-RPC dispatch ───────────────────────────────────────────
// Extracted from the original inline HTTP handler so one implementation
// serves both transports. Behaviour unchanged.
async function handleRpc(request) {
const { id, method, params } = request;

  if (method === "initialize") {
    return ({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "screen-recorder-mcp", version: "1.0.0" }
      }
    });
  }

  if (method === "tools/list") {
    return ({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await executeTool(toolName, args);
      return ({ jsonrpc: "2.0", id, result });
    } catch (e) {
      return ({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }
      });
    }
  }

  return ({ error: "Method not found: " + method });
}

// ─── Transport: stdio (child process — no TCP port) ──────────────────
const { serveStdio, wantsStdio } = require("./stdio-transport.js");
if (wantsStdio()) {
  serveStdio(handleRpc, "SCREEN-MCP");
  return; // never open a socket in stdio mode
}

// ─── Transport: HTTP (standalone / legacy) ──────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") { res.writeHead(405); res.end("Only POST"); return; }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let request;
  try { request = JSON.parse(raw); } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return;
  }
  const reply = await handleRpc(request);
  if (reply === null || reply === undefined) { res.writeHead(202); res.end(); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(reply));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[SCREEN-MCP] Running on http://127.0.0.1:${PORT}`);
  console.log(`[SCREEN-MCP] Tools: ${TOOLS.map(t => t.name).join(", ")}`);
  console.log(`[SCREEN-MCP] Recordings dir: ${RECORDINGS_DIR}`);
});
