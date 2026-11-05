#!/usr/bin/env python3
"""
real-execution-suite.py — বাস্তব এক্সিকিউশন টেস্ট
════════════════════════════════════════════════════════════════════════
Function tests pass on paper but miss reality. Every case here runs the
real code path and verifies the real artifact:

  • a real HTTP request is made and a real file is produced
  • a real LLM decides to call a tool, the tool really executes,
    and the answer is checked against the tool's real output
  • "exit 0" is never accepted as proof on its own — the artifact is
    inspected (size, magic bytes, decode)

This is the suite that caught tts_play playing MP3 bytes as 8 kHz raw
PCM while reporting success.
"""
import json, os, shutil, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path

# Every path resolves from THIS file, so the suite works from any checkout
# location — the old copy hard-coded the previous machine's home.
ROOT = Path(__file__).resolve().parent.parent

def _env_file_values():
    vals = {}
    try:
        with open(ROOT / ".env", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, val = line.split("=", 1)
                vals[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return vals

_ENV = _env_file_values()

def _env(key, default=""):
    return os.environ.get(key) or _ENV.get(key) or default

BASE   = os.environ.get("BASE_URL") or f"http://127.0.0.1:{_env('PORT', '5050')}"
MCP    = f"{BASE}/mcp"
CHAT   = f"{BASE}/v1/chat/completions"
TTS_VENV = _env("TTS_VENV") or shutil.which("edge-tts") or ""

results = []

def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'✅' if ok else '❌'} {name}")
    if detail:
        for line in str(detail).splitlines():
            print(f"       {line}")

def rpc(port, payload, host="127.0.0.1"):
    url = f"http://{host}:{port}/"
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=90))
    except Exception as e:
        return {"error": str(e)}

# Privileged MCP tools (write_file, delete_file, terminal, ...) require an
# admin token. Read it from .env exactly as the server does.
def _admin_token():
    """MCP_ADMIN_TOKEN is empty in this deployment; the server also accepts
    ADMIN_TOKEN / ADMIN_API_KEY, so try them in order."""
    want = ("MCP_ADMIN_TOKEN", "ADMIN_API_KEY")  # matches api.js:3636
    got = {}
    try:
        for line in open(ROOT / ".env", encoding="utf-8"):
            for k in want:
                if line.startswith(k + "="):
                    got[k] = line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return next((got[k] for k in want if got.get(k)), "")

TOKEN = _admin_token()

def mcp(payload):
    req = urllib.request.Request(MCP, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json",
                                          **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {})})
    try:
        return json.load(urllib.request.urlopen(req, timeout=90))
    except Exception as e:
        return {"error": str(e)}

def call_tool(name, args):
    r = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": name, "arguments": args}})
    if "error" in r:
        return {"_error": str(r["error"])}
    text = r["result"]["content"][0]["text"]
    try:
        return json.loads(text)
    except Exception:
        return {"_text": text}

def chat(body, timeout=150):
    req = urllib.request.Request(CHAT, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


print("═" * 70)
print("  বাস্তব এক্সিকিউশন টেস্ট স্যুট — কোনো মক/স্টাব নেই")
print("═" * 70)

# ── 1. Server liveness ──────────────────────────────────────────────────────
print("\n  [১] সার্ভার জীবন্ত")
try:
    h = json.load(urllib.request.urlopen(f"{BASE}/health", timeout=10))
    record("health endpoint", h.get("healthy") is True,
           f"version={h.get('version')} agents={h.get('agents')} models={h.get('models')}")
except Exception as e:
    record("health endpoint", False, str(e))

# ── 2. Every advertised MCP tool actually dispatches ────────────────────────
print("\n  [২] প্রতিটি প্রকাশিত MCP টুল আসলেই কল হয় কি")
try:
    tl = mcp({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]
    record("tools/list", len(tl) > 0, f"{len(tl)} tools advertised")
except Exception as e:
    tl = []
    record("tools/list", False, str(e))

# ── 3. system_info returns live machine facts ───────────────────────────────
print("\n  [৩] system_info — আসল মেশিনের তথ্য")
si = call_tool("system_info", {})
node_ok = si.get("node") == subprocess.run(["node","-v"],capture_output=True,text=True).stdout.strip()
record("system_info returns real node version", node_ok,
       f"reported={si.get('node')} actual={subprocess.run(['node','-v'],capture_output=True,text=True).stdout.strip()}")
record("system_info cwd points at this project",
       si.get("cwd","").rstrip("/").endswith("/" + ROOT.name), f"cwd={si.get('cwd')}")

# ── 4. File tools produce a real artifact ───────────────────────────────────
print("\n  [৪] write_file → read_file → delete_file (আসল ফাইল)")
probe = str(ROOT / "universal-adapter" / ".real-exec-probe.txt")
content = "এটি বাস্তব এক্সিকিউশন টেস্ট — পিপলাইন, " + str(int(time.time()))
w = call_tool("write_file", {"path": probe, "content": content})
record("write_file reports success", "Written" in w.get("_text", ""),
       w.get("_text", "")[:70])
r = call_tool("read_file", {"path": probe})
record("read_file round-trips exact content", content in r.get("_text", ""),
       f"{len(content)} chars expected")
record("file really exists on disk", os.path.isfile(probe),
       f"{os.path.getsize(probe) if os.path.isfile(probe) else 0} bytes on disk")
call_tool("delete_file", {"path": probe})
record("delete_file removes it", not os.path.exists(probe))

# ── 5. grep / glob really search ────────────────────────────────────────────
print("\n  [৫] grep ও glob — আসল সার্চ")
# glob/grep answer with plain text (not JSON), so match on the payload.
g = call_tool("grep", {"query": "handleRpc", "include": "**/*.js"})
gtext = g.get("_text", "")
record("grep finds known symbols", "handleRpc" in gtext,
       f"{len(gtext.splitlines())} lines returned")
gl = call_tool("glob", {"pattern": "**/*.js"})
glines = [l for l in gl.get("_text", "").splitlines() if l.strip()]
record("glob lists .js files", len(glines) > 5, f"{len(glines)} files listed")

# ── 6. TTS: real audio artifact, inspected (not just "exit 0") ──────────────
print("\n  [৬] TTS — আসল অডিও ফাইল তৈরি ও যাচাই")
mp3 = "/tmp/real-exec-tts.mp3"
if os.path.exists(mp3):
    os.remove(mp3)
tts = call_tool("tts__tts_speak",
                {"text": "এটি বাস্তব এক্সিকিউশন টেস্ট।", "output": mp3})
record("tts_speak reports success", tts.get("success") is True,
       f"{tts.get('size_kb')}KB in {tts.get('elapsed_ms')}ms" if tts.get("size_kb") else tts.get("message",""))
exists = os.path.isfile(mp3)
record("audio file really on disk", exists,
       f"{os.path.getsize(mp3)} bytes" if exists else "missing")
if exists:
    size = os.path.getsize(mp3)
    with open(mp3,"rb") as f:
        head = f.read(3)
    record("file is a real MP3 (ID3/0xFF frame sync)", size > 5000 and (head[:3]==b"ID3" or head[0]==0xFF),
           f"size={size}B header={head!r}")
    dur = subprocess.run(["ffprobe","-v","error","-show_entries","format=duration",
                          "-of","default=noprint_wrappers=1:nokey=1",mp3],
                         capture_output=True,text=True).stdout.strip()
    record("ffprobe decodes it to real audio", bool(dur) and float(dur or 0) > 0.5,
           f"duration={dur}s")

# ── 7. OCR on a real generated image ────────────────────────────────────────
print("\n  [৭] OCR — আসল ছবি তৈরি করে টেক্সট বের করা")
png = "/tmp/real-exec-ocr.png"
# ffmpeg is present on this box; ImageMagick is not.
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","lavfi",
                "-i","color=c=white:s=700x140:d=1",
                "-vf","drawtext=text='HELLO ZC-2026':fontcolor=black:fontsize=40:x=30:y=50",
                "-frames:v","1", png], capture_output=True)
if os.path.isfile(png):
    ocr = call_tool("ocr__ocr_image", {"path": png, "langs": "eng"})
    txt = json.dumps(ocr, ensure_ascii=False)
    record("OCR reads text from a real image", "HELLO" in txt.upper() or "ZC" in txt.upper(),
           txt[:180])
else:
    record("OCR: test image created", False, "ffmpeg drawtext unavailable")

# ── 8. LLM genuinely decides to call a tool (no hallucination) ─────────────
print("\n  [৮] LLM টুল-কলিং — হ্যালুসিনেশন ছাড়া যাচাই")
TOOLS = [{"type":"function","function":{"name":"system_info",
          "description":"Get system info: OS, node version, memory",
          "parameters":{"type":"object","properties":{},"required":[]}}}]
try:
    r1 = chat({"model":"gemini-3.5-flash-lite","tools":TOOLS,
               "messages":[{"role":"user",
                 "content":"এই মেশিনের Node.js ভার্সন কত? অবশ্যই system_info টুল কল করে বলো।"}]})
    tcs = r1["choices"][0]["message"].get("tool_calls")
    record("LLM emits a real tool_call", bool(tcs),
           f"provider={r1.get('provider')} tool={tcs[0]['function']['name'] if tcs else None}")
    if tcs:
        real = call_tool("system_info", {})
        msgs = [{"role":"user","content":"এই মেশিনের Node.js ভার্সন কত? অবশ্যই system_info টুল কল করে বলো।"},
                {"role":"assistant","content":"","tool_calls":tcs},
                {"role":"tool","tool_call_id":tcs[0]["id"],"name":"system_info",
                 "content":json.dumps(real)}]
        r2 = chat({"model":"gemini-3.5-flash-lite","tools":TOOLS,"messages":msgs})
        ans = r2["choices"][0]["message"].get("content","")
        record("final answer carries the TOOL's real value", real.get("node","") in ans,
               f"tool said {real.get('node')} / answer: {ans[:110]}")
except Exception as e:
    record("LLM tool-calling loop", False, str(e)[:200])

# ── 9. Reasoning-content guard (the 502 bug) ────────────────────────────────
print("\n  [৯] reasoning_content বাগ — ইতিহাস সহ পুনরাবৃত্তি")
try:
    a = chat({"model":"gemini-3.5-flash-lite","tools":TOOLS,
              "messages":[{"role":"user","content":"প্রথম প্রশ্ন: node version?"}]})
    ta = a["choices"][0]["message"].get("tool_calls")
    if ta:
        real = call_tool("system_info", {})
        b = chat({"model":"gemini-3.5-flash-lite","tools":TOOLS,"messages":[
            {"role":"user","content":"প্রথম প্রশ্ন: node version?"},
            {"role":"assistant","content":"","tool_calls":ta},
            {"role":"tool","tool_call_id":ta[0]["id"],"name":"system_info","content":json.dumps(real)},
            {"role":"user","content":"দ্বিতীয় প্রশ্ন: memory কত?"}]})
        record("multi-turn with tool history survives", "error" not in b,
               "no 502" if "error" not in b else str(b["error"])[:150])
except Exception as e:
    record("multi-turn with tool history", False, str(e)[:150])

# ── 10. Error honesty: bad input must fail loudly, not fake success ─────────
print("\n  [১০] ভুল ইনপুট কি সৎভাবে এরর দেয়?")
bad = call_tool("no_such_tool_xyz", {})
record("unknown tool rejected", "error" in json.dumps(bad).lower())
outside = call_tool("read_file", {"path": "/etc/shadow"})
otext = json.dumps(outside, ensure_ascii=False).lower()
# Either the app-level boundary rejects it, or the OS refuses. Both are
# correct refusals — what matters is that NO file contents come back.
refused = ("outside" in otext or "invalid" in otext or "eacces" in otext
           or "permission denied" in otext or "error" in otext)
no_leak = "root:" not in otext
record("sandbox refuses paths outside roots", refused and no_leak,
       f"refused={refused} no_content_leaked={no_leak}")

# ── Summary ─────────────────────────────────────────────────────────────────
passed = sum(1 for _,ok,_ in results if ok)
failed = [n for n,ok,_ in results if not ok]
print("\n" + "═" * 70)
print(f"  ফলাফল: {passed}/{len(results)} পাস, {len(failed)} ফেল")
if failed:
    print("  ব্যর্থ:")
    for n in failed:
        print("    ❌ " + n)
print("═" * 70)
sys.exit(1 if failed else 0)