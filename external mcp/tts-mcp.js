#!/usr/bin/env node
// =============================================================================
// TTS MCP Tool — Mission Barisal v3
// Uses Microsoft Edge TTS (free, zero API key needed)
// Voice: bn-BD-NabanitaNeural (Bengali female, natural)
//
// Tools:
//   tts_speak     — Convert text to speech audio file
//   tts_voices    — List available voices
//   tts_play      — Convert text to speech AND play it
//
// Usage: node "external mcp/tts-mcp.js"
// =============================================================================

const { spawn } = require("child_process"); // NOTE: no execSync — all child procs are async (spawnAsync)
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const PORT = parseInt(process.env.TTS_MCP_PORT || "3102", 10);
const OUTPUT_DIR = process.env.TTS_OUTPUT_DIR || path.join(os.homedir(), "zombie-tts");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const DEFAULT_VOICE = process.env.TTS_VOICE || "bn-BD-NabanitaNeural";
const DEFAULT_RATE = process.env.TTS_RATE || "+0%";

const EDGE_TTS = process.env.EDGE_TTS_PATH || "edge-tts";

// ─── Helpers ──────────────────────────────────────────────
function spawnAsync(cmd, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let killed = false;
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout?.on("data", d => stdout += d);
    proc.stderr?.on("data", d => stderr += d);
    
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill("SIGTERM"); } catch {}
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    
    proc.on("close", code => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Exit ${code}: ${stderr.trim()}`));
    });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

function makeArgs(args) {
  // Build edge-tts args safely — no shell interpretation
  const result = [];
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null && v !== "") {
      result.push(`--${k}`, String(v));
    }
  }
  return result;
}

// ─── Tool Definitions ─────────────────────────────────────
const TOOLS = [
  {
    name: "tts_speak",
    description: "Convert text to speech audio file. Uses Microsoft Edge TTS (free, no API key). Default voice: Bengali female (bn-BD-NabanitaNeural).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        voice: { type: "string", description: "Voice name (default: bn-BD-NabanitaNeural)" },
        rate: { type: "string", description: "Speech rate (default: '+0%')" },
        output: { type: "string", description: "Custom output path (optional)" }
      },
      required: ["text"]
    }
  },
  {
    name: "tts_voices",
    description: "List available TTS voices. Filter by language.",
    inputSchema: {
      type: "object",
      properties: {
        lang: { type: "string", description: "Filter by language code (e.g. 'bn', 'en')" }
      },
      required: []
    }
  },
  {
    name: "tts_play",
    description: "Convert text to speech AND play it immediately.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to speak" },
        voice: { type: "string", description: "Voice name" },
        rate: { type: "string", description: "Speech rate" }
      },
      required: ["text"]
    }
  }
];

// ─── Tool Execution ───────────────────────────────────────
// aplay/paplay take no "-q" style flag we want to rely on; keep args simple
// and portable across both.
function cmdArgsForPcm(cmd, file) {
  return cmd === "aplay" ? ["-q", file] : [file];
}

async function executeTool(name, args) {
  const startTime = Date.now();

  switch (name) {
    case "tts_speak": {
      const text = args.text || "";
      const voice = args.voice || DEFAULT_VOICE;
      const rate = args.rate || DEFAULT_RATE;
      const outputPath = args.output || path.join(OUTPUT_DIR, `tts-${Date.now()}.mp3`);

      if (!text.trim()) {
        return { content: [{ type: "text", text: "Error: text is required" }] };
      }

      try {
        // Use spawn — no shell interpretation, safe with any text content
        const cliArgs = makeArgs({ voice, rate, text, "write-media": outputPath });
        await spawnAsync(EDGE_TTS, cliArgs, 60000);

        const stat = fs.statSync(outputPath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              path: outputPath,
              voice,
              rate,
              text_length: text.length,
              size_kb: Math.round(stat.size / 1024),
              elapsed_ms: Date.now() - startTime,
              message: `Audio saved. Play with: mpv "${outputPath}" or aplay "${outputPath}"`
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `TTS error: ${e.message}` }] };
      }
    }

    case "tts_voices": {
      const lang = args.lang || "";
      try {
        const raw = await spawnAsync(EDGE_TTS, ["--list-voices"], 15000);
        const voices = [];
        // edge-tts outputs blocks like:
        //   Name: xxx
        //   ShortName: xxx
        //   Gender: xxx
        //   Locale: xx-XX
        // separated by blank lines
        let current = {};
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) {
            if (current.short_name) {
              if (!lang || current.locale.startsWith(lang)) {
                voices.push(current);
              }
              current = {};
            }
            continue;
          }
          if (trimmed.startsWith("Name: ")) current.name = trimmed.slice(6);
          else if (trimmed.startsWith("ShortName: ")) current.short_name = trimmed.slice(11);
          else if (trimmed.startsWith("Gender: ")) current.gender = trimmed.slice(8);
          else if (trimmed.startsWith("Locale: ")) current.locale = trimmed.slice(8);
        }
        // Push last entry
        if (current.short_name && (!lang || current.locale.startsWith(lang))) {
          voices.push(current);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              count: voices.length,
              default_voice: DEFAULT_VOICE,
              voices: voices.slice(0, 50)
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Voice list error: ${e.message}` }] };
      }
    }

    case "tts_play": {
      const text = args.text || "";
      const voice = args.voice || DEFAULT_VOICE;
      const rate = args.rate || DEFAULT_RATE;

      if (!text.trim()) {
        return { content: [{ type: "text", text: "Error: text is required" }] };
      }

      const tmpFile = path.join(OUTPUT_DIR, `tts-play-${Date.now()}.mp3`);

      try {
        // Generate audio
        const cliArgs = makeArgs({ voice, rate, text, "write-media": tmpFile });
        await spawnAsync(EDGE_TTS, cliArgs, 60000);

        // ── Player selection is FORMAT-AWARE ───────────────────────────
        // Bug this replaces: paplay/aplay were tried first with an MP3.
        // They accept raw PCM/WAV only and treat the MP3 bytes as samples:
        //     aplay -> "Playing raw data '<file>.mp3' : Unsigned 8 bit,
        //                Rate 8000 Hz, Mono"
        // They exit 0, so the old code reported "Audio played successfully"
        // while the listener heard noise. Ordering alone hid the failure.
        //
        // ffplay (ffmpeg) decodes MP3 properly and is first. The raw-PCM
        // players are only reached after converting to WAV, and only when
        // ffplay/mpv/mplayer are all unavailable.
        let played = false;
        const players = [
          ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", tmpFile]],
          ["mpv", ["--no-video", tmpFile]],
          ["mplayer", tmpFile && [tmpFile]],
          ["afplay", [tmpFile]],
          ["canberra-gtk-play", ["-f", tmpFile]],
        ];
        for (const [cmd, cmdArgs] of players) {
          if (!cmdArgs) continue;
          try {
            await spawnAsync(cmd, cmdArgs, 30000);
            played = true;
            break;
          } catch {}
        }

        // ── Last resort: decode to WAV, then use a raw-PCM player ────────
        // paplay/aplay cannot read MP3. Giving them an MP3 "works" (exit 0)
        // and produces noise, so they are only used on a real WAV.
        if (!played) {
          const wavFile = tmpFile.replace(/\.mp3$/, ".wav");
          try {
            await spawnAsync("ffmpeg", ["-y", "-loglevel", "error", "-i", tmpFile, wavFile], 30000);
            for (const cmd of ["paplay", "aplay"]) {
              try {
                await spawnAsync(cmd, cmdArgsForPcm(cmd, wavFile), 30000);
                played = true;
                break;
              } catch {}
            }
            try { fs.unlinkSync(wavFile); } catch {}
          } catch {}
        }

        // Cleanup
        try { fs.unlinkSync(tmpFile); } catch {}

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              played,
              voice,
              rate,
              text_length: text.length,
              elapsed_ms: Date.now() - startTime,
              message: played ? "Audio played successfully" : "Audio generated but no player found (install mpv or paplay)"
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: "text", text: `TTS play error: ${e.message}` }] };
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

// ─── Process Error Handlers (prevent crashes) ─────────────
process.on("uncaughtException", (e) => {
  console.error(`[TTS-MCP] Uncaught exception: ${e.message}`);
});
process.on("unhandledRejection", (e) => {
  console.error(`[TTS-MCP] Unhandled rejection: ${e}`);
});

// ─── MCP JSON-RPC Server (HTTP) ──────────────────────────
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
        serverInfo: { name: "tts-mcp", version: "1.1.0" }
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
  serveStdio(handleRpc, "TTS-MCP");
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
  console.log(`[TTS-MCP] Running on http://127.0.0.1:${PORT}`);
  console.log(`[TTS-MCP] Tools: ${TOOLS.map(t => t.name).join(", ")}`);
  console.log(`[TTS-MCP] Default voice: ${DEFAULT_VOICE}`);
  console.log(`[TTS-MCP] Output dir: ${OUTPUT_DIR}`);
});
