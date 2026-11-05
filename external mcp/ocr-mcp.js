#!/usr/bin/env node
// =============================================================================
// OCR MCP Tool — Mission Barisal v3
// Zero npm dependencies — uses the native system tools: tesseract + ffmpeg.
//
// Tools:
//   ocr_image      — extract text from an image (any format). Supports crop,
//                    upscale, preprocessing and page-segmentation control.
//   ocr_crop       — crop a region then OCR (ffmpeg, NOT ImageMagick).
//   ocr_screenshot — capture the X11 screen (ffmpeg x11grab) then OCR.
//   ocr_batch      — OCR many images in one call.
//
// Two real bugs fixed here (both were proven against real files):
//   1. ImageMagick was missing on this machine, so every `preprocess` mode and
//      `ocr_crop` call died with `convert: not found`. All image work now uses
//      ffmpeg (crop / scale / format=gray / lutyuv threshold / unsharp /
//      hqdn3d denoise), which IS installed.
//   2. Default language was "eng", which turned Bengali titles into garbage.
//      Evidence, same cover file:
//        eng       -> "A523 Clad PATAo prt"
//        eng+ben   -> "এসইও শেখার কমপ্লিট কোর্স"
//      The default is now "eng+ben" (override with the OCR_LANGS env or the
//      per-call `langs` argument).
//
// Usage: node "external mcp/ocr-mcp.js"          (MCP server: stdio or HTTP)
//        node "external mcp/ocr-mcp.js" <image>  (quick CLI self-test)
// =============================================================================

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = parseInt(process.env.OCR_MCP_PORT || "3110", 10);
const TMP_DIR = process.env.OCR_TMP_DIR || path.join(os.tmpdir(), "ocr-mcp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// Bengali is the platform's primary language — default to a mixed run.
const DEFAULT_LANGS = process.env.OCR_LANGS || "eng+ben";
const DEFAULT_SCALE = parseFloat(process.env.OCR_SCALE || "2"); // 2x upscale helps small text a lot

// ─── Helpers ──────────────────────────────────────────────────────────────
// execFile (no shell) — argument arrays mean file names with spaces/quotes/
// semicolons can never break out into a shell. Async so the MCP event loop
// keeps serving other requests while tesseract/ffmpeg run.
function run(file, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `${path.basename(file)} failed: ${(stderr || err.message || "").trim()}`,
            ),
          );
          return;
        }
        resolve(String(stdout || ""));
      },
    );
  });
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function tmpFile(prefix, ext) {
  return path.join(
    TMP_DIR,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
  );
}

function cleanup(...paths) {
  for (const p of paths) {
    try {
      if (p) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

// Installed tesseract language packs (cached after first probe).
let _installedLangs = null;
async function installedLangs() {
  if (_installedLangs) return _installedLangs;
  try {
    const out = await run("tesseract", ["--list-langs"], 10000);
    _installedLangs = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^List of available/i.test(l))
      .filter((l) => /^[a-z_]{2,}$/.test(l));
  } catch {
    _installedLangs = [];
  }
  return _installedLangs;
}

// Drop requested codes that are not installed; keep the set valid so tesseract
// does not hard-fail. Returns { langs, dropped }.
async function normalizeLangs(requested) {
  const want = String(requested || DEFAULT_LANGS)
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const have = await installedLangs();
  if (!have.length) return { langs: want.join("+"), dropped: [] };
  const ok = want.filter((l) => have.includes(l));
  const dropped = want.filter((l) => !have.includes(l));
  return { langs: (ok.length ? ok : ["eng"]).join("+"), dropped };
}

// ─── Image pipeline (ffmpeg) ──────────────────────────────────────────────
// Build the -vf filter chain. Order: crop -> upscale -> gray -> effects.
function buildFilters({ crop, scale, preprocess }) {
  const vf = [];
  if (crop && crop.width > 0 && crop.height > 0) {
    vf.push(
      `crop=${Math.round(crop.width)}:${Math.round(crop.height)}:` +
        `${Math.round(crop.x || 0)}:${Math.round(crop.y || 0)}`,
    );
  }
  const s = Number(scale);
  if (s && s > 0 && s !== 1) {
    vf.push(`scale=iw*${s}:ih*${s}:flags=lanczos`);
  }
  switch (preprocess) {
    case "gray":
      vf.push("format=gray", "eq=contrast=1.2");
      break;
    case "threshold":
      // commas inside the expression MUST be escaped for ffmpeg's filtergraph.
      vf.push("format=gray", "lutyuv=y=if(gt(val\\,128)\\,255\\,0)");
      break;
    case "sharpen":
      vf.push("unsharp=5:5:1.0:5:5:0.0");
      break;
    case "denoise":
      vf.push("hqdn3d=1.5:1.5:6:6");
      break;
    default:
      break; // "none"
  }
  return vf;
}

// Produce a processed PNG via ffmpeg when any filter is requested; otherwise
// return the source path untouched (no needless re-encode).
async function prepareImage(inputPath, opts) {
  const vf = buildFilters(opts);
  if (!vf.length) return { path: inputPath, temp: false, filters: [] };
  const out = tmpFile("prep", "png");
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-vf",
    vf.join(","),
    "-frames:v",
    "1",
    out,
  ]);
  return { path: out, temp: true, filters: vf };
}

// ─── Tesseract ────────────────────────────────────────────────────────────
async function tesseractText(imgPath, { langs, psm }) {
  const base = tmpFile("ocr", "txt").replace(/\.txt$/, "");
  const args = [imgPath, base, "-l", langs];
  if (psm) args.push("--psm", String(psm));
  await run("tesseract", args);
  let text = "";
  try {
    text = fs.readFileSync(base + ".txt", "utf8").trim();
  } catch {
    /* empty result */
  }
  cleanup(base + ".txt");
  return text;
}

// Mean word confidence + top words via tesseract TSV output.
async function tesseractConfidence(imgPath, { langs, psm }) {
  const base = tmpFile("ocr", "tsv").replace(/\.tsv$/, "");
  const args = [imgPath, base, "-l", langs, "tsv"];
  if (psm) args.push("--psm", String(psm));
  await run("tesseract", args);
  let tsv = "";
  try {
    tsv = fs.readFileSync(base + ".tsv", "utf8");
  } catch {
    /* ignore */
  }
  cleanup(base + ".tsv");
  const words = [];
  const lines = tsv.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length < 12) continue;
    const conf = parseFloat(cols[10]);
    const txt = (cols[11] || "").trim();
    if (!txt || Number.isNaN(conf) || conf < 0) continue;
    words.push({ text: txt, conf: Math.round(conf) });
  }
  const mean = words.length
    ? Math.round(words.reduce((a, w) => a + w.conf, 0) / words.length)
    : 0;
  const low = words.filter((w) => w.conf < 60).slice(0, 15);
  return { mean_confidence: mean, word_count: words.length, low_confidence_words: low };
}

// Full ocr_image pipeline shared by ocr_image / ocr_batch.
async function ocrImage(args) {
  const imgPath = path.resolve(String(args.path || ""));
  if (!fileExists(imgPath)) {
    return { success: false, error: `File not found: ${imgPath}` };
  }
  const { langs, dropped } = await normalizeLangs(args.langs);
  let psm = args.psm;
  if (psm && !/^\d{1,2}$/.test(String(psm))) psm = undefined; // tesseract wants 0..13

  const crop =
    args.crop && typeof args.crop === "object"
      ? args.crop
      : args.x != null && args.y != null && args.width && args.height
        ? { x: args.x, y: args.y, width: args.width, height: args.height }
        : null;

  const scale = args.scale != null ? args.scale : DEFAULT_SCALE;
  const preprocess = args.preprocess || (args.grayscale ? "gray" : "none");

  const t0 = Date.now();
  let prepared = { path: imgPath, temp: false, filters: [] };
  try {
    prepared = await prepareImage(imgPath, { crop, scale, preprocess });
    const text = await tesseractText(prepared.path, { langs, psm });
    const out = {
      success: true,
      text,
      chars: text.length,
      lines: text.split("\n").filter((l) => l.trim()).length,
      langs,
      preprocess,
      scale,
      crop: crop || undefined,
      psm: psm || undefined,
      filters: prepared.filters,
      elapsed_ms: Date.now() - t0,
      source: imgPath,
    };
    if (dropped.length) out.dropped_langs = dropped;
    if (args.with_confidence) {
      out.confidence = await tesseractConfidence(prepared.path, { langs, psm });
    }
    return out;
  } catch (e) {
    const have = await installedLangs();
    return {
      success: false,
      error: e.message,
      installed_langs: have,
      source: imgPath,
      elapsed_ms: Date.now() - t0,
    };
  } finally {
    if (prepared.temp) cleanup(prepared.path);
  }
}

// ─── Tool Definitions ─────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "ocr_image",
    description:
      "Extract text from an image file (PNG, JPG, BMP, TIFF, PDF). Bengali+English by default. " +
      "Use `crop` to read a region, `scale` to enlarge small text, `preprocess` for hard scans, " +
      "`psm` for layout modes, `with_confidence` for a quality score.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the image file" },
        langs: {
          type: "string",
          description: "Tesseract language codes. Default 'eng+ben'. e.g. 'eng', 'ben', 'eng+ben'",
        },
        preprocess: {
          type: "string",
          enum: ["none", "gray", "threshold", "sharpen", "denoise"],
          description: "Image enhancement before OCR (default none). ffmpeg-backed.",
        },
        scale: {
          type: "number",
          description: "Upscale factor before OCR (default 2). 1 disables. 3-4 for tiny text.",
        },
        psm: {
          type: "string",
          description: "Tesseract page segmentation mode 0-13 (e.g. '6' single block, '11' sparse text)",
        },
        crop: {
          type: "object",
          description: "Optional {x,y,width,height} region to OCR",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
        },
        with_confidence: {
          type: "boolean",
          description: "Also return mean word confidence and low-confidence words",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "ocr_crop",
    description:
      "Crop a region from an image and extract text (ffmpeg based — no ImageMagick needed).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to source image" },
        x: { type: "number", description: "X offset (pixels)" },
        y: { type: "number", description: "Y offset (pixels)" },
        width: { type: "number", description: "Crop width (pixels)" },
        height: { type: "number", description: "Crop height (pixels)" },
        langs: { type: "string", description: "Tesseract language codes (default eng+ben)" },
        scale: { type: "number", description: "Upscale factor after crop (default 2)" },
        preprocess: {
          type: "string",
          enum: ["none", "gray", "threshold", "sharpen", "denoise"],
        },
      },
      required: ["path", "x", "y", "width", "height"],
    },
  },
  {
    name: "ocr_screenshot",
    description:
      "Screenshot the X11 display (ffmpeg x11grab) and OCR it. Region 'full' or 'WxH+X+Y'.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "string",
          description: "Capture region: 'full' (default) or 'WxH+X+Y' (e.g. '1920x1080+0+0')",
        },
        langs: { type: "string", description: "Tesseract language codes (default eng+ben)" },
        scale: { type: "number", description: "Upscale factor (default 2)" },
        preprocess: {
          type: "string",
          enum: ["none", "gray", "threshold", "sharpen", "denoise"],
        },
      },
      required: [],
    },
  },
  {
    name: "ocr_batch",
    description: "OCR many images in one call (max 50). Same options as ocr_image.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Image paths" },
        langs: { type: "string", description: "Tesseract language codes (default eng+ben)" },
        preprocess: {
          type: "string",
          enum: ["none", "gray", "threshold", "sharpen", "denoise"],
        },
        scale: { type: "number", description: "Upscale factor (default 2)" },
      },
      required: ["paths"],
    },
  },
];

// ─── Tool Execution ───────────────────────────────────────────────────────
async function executeTool(name, args) {
  const startTime = Date.now();

  switch (name) {
    case "ocr_image": {
      return json(await ocrImage(args));
    }

    case "ocr_crop": {
      return json(
        await ocrImage({
          path: args.path,
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          langs: args.langs,
          scale: args.scale,
          preprocess: args.preprocess,
        }),
      );
    }

    case "ocr_screenshot": {
      const region = args.region || "full";
      const shot = tmpFile("screenshot", "png");
      try {
        if (region === "full") {
          const dims = (await run("xdpyinfo", [], 10000)) || "";
          const m = dims.match(/dimensions:\s+(\d+)x(\d+)/);
          const size = m ? `${m[1]}x${m[2]}` : "1920x1080";
          await run(
            "ffmpeg",
            [
              "-hide_banner", "-loglevel", "error", "-y",
              "-f", "x11grab", "-video_size", size, "-i", (process.env.DISPLAY || ":0.0"),
              "-frames:v", "1", shot,
            ],
            20000,
          );
        } else {
          await run(
            "ffmpeg",
            [
              "-hide_banner", "-loglevel", "error", "-y",
              "-f", "x11grab", "-video_size", region, "-i", (process.env.DISPLAY || ":0.0"),
              "-frames:v", "1", shot,
            ],
            20000,
          );
        }
        if (!fileExists(shot)) {
          return json({
            success: false,
            error: "Failed to capture screenshot. Check DISPLAY / X11 availability.",
          });
        }
        const result = await ocrImage({
          path: shot,
          langs: args.langs,
          scale: args.scale,
          preprocess: args.preprocess,
        });
        result.source = "screenshot:" + region;
        // Keep the PNG so the caller can re-OCR / crop it or view it later.
        result.screenshot_path = shot;
        return json(result);
      } catch (e) {
        cleanup(shot);
        return json({
          success: false,
          error: `Screenshot error: ${e.message}. Make sure X11/DISPLAY is available.`,
        });
      }
    }

    case "ocr_batch": {
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, 50) : [];
      if (!paths.length) return json({ success: false, error: "paths[] is required" });
      const results = [];
      for (const p of paths) {
        results.push(
          await ocrImage({
            path: p,
            langs: args.langs,
            scale: args.scale,
            preprocess: args.preprocess,
          }),
        );
      }
      return json({
        success: true,
        count: results.length,
        elapsed_ms: Date.now() - startTime,
        results,
      });
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
}

function json(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

// ─── MCP JSON-RPC dispatch ────────────────────────────────────────────────
async function handleRpc(request) {
  const { id, method, params } = request;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ocr-mcp", version: "2.0.0" },
      },
    };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const toolName = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const result = await executeTool(toolName, args);
      return { jsonrpc: "2.0", id, result };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        },
      };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } };
}

// ─── CLI self-test ────────────────────────────────────────────────────────
// `node "external mcp/ocr-mcp.js" <image> [langs] [preprocess]`
if (require.main === module && process.argv[2]) {
  (async () => {
    const r = await ocrImage({
      path: process.argv[2],
      langs: process.argv[3] || DEFAULT_LANGS,
      preprocess: process.argv[4] || "none",
    });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.success ? 0 : 1);
  })();
  return;
}

// ─── Transport: stdio (child process — no TCP port) ───────────────────────
const { serveStdio, wantsStdio } = require("./stdio-transport.js");
if (wantsStdio()) {
  serveStdio(handleRpc, "OCR-MCP");
  return; // never open a socket in stdio mode
}

// ─── Transport: HTTP (standalone / gateway-routed) ────────────────────────
// Only bind a port when THIS file is the entry point. Requiring the module
// (tests, CLI helpers) must never start a listener.
if (require.main === module) {
  const http = require("http");
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Only POST");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let request;
    try {
      request = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const reply = await handleRpc(request);
    if (reply === null || reply === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply));
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[OCR-MCP] v2 running on http://127.0.0.1:${PORT}`);
    console.log(`[OCR-MCP] default langs=${DEFAULT_LANGS} scale=${DEFAULT_SCALE}x`);
    console.log(`[OCR-MCP] Tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  });
}

module.exports = { ocrImage, executeTool, TOOLS, handleRpc };
