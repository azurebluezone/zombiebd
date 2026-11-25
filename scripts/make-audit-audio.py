#!/usr/bin/env python3
"""Render the Bengali audit-proposal narration with edge-tts.

The narration text is the source of truth. The MP3 is written atomically and
a JSON sidecar records the voice, hashes and measured duration so the
companion checker can prove the file is current.

Usage:
  python3 scripts/make-audit-audio.py --check
  python3 scripts/make-audit-audio.py
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEXT = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.txt"
AUDIO = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.mp3"
META = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.json"
VOICE = "bn-BD-NabanitaNeural"
RATE = "-5%"
MIN_TEXT_CHARS = 6_000
KEYWORDS = (
    "সহমত",
    "মডিউল",
    "ইমপোর্ট",
    "এপিআই ডট জেএস",
    "সার্ভার্স ডট জেসন",
)

EVIDENCE = [
    {
        "claim": "HTTP mission uses executeSingleAgent while MCP mission uses executeMission",
        "path": "api.js",
        "lines": "19245-19252, 11006, 8782, 9313",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "The /v1 agent branch bypasses handleMessage",
        "path": "api.js",
        "lines": "16469, 19131",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "write_file reports success without compiling the written file",
        "path": "api.js",
        "lines": "10687-10702, 19304; modules/compiler.js:53",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "verifyGoalOutput replaces failed content with a canned message and ignores userInput",
        "path": "api.js",
        "lines": "9646-9652, 12336-12435",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "shutdown is synchronous and misses HTTPS, h2c, gRPC and watchdog",
        "path": "api.js",
        "lines": "19622-19683",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "registering modules/config.js and modules/sessions.js is absent",
        "path": "api.js",
        "lines": "no require for either module",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "servers.json exists here and enables tts, ocr and screen-recorder",
        "path": "external mcp/servers.json",
        "lines": "1-40",
        "label": "CONFIG_VALIDATED",
    },
    {
        "claim": "the /api/connect agent branch passes arguments in the wrong order",
        "path": "api.js",
        "lines": "17705-17709 vs signature 9313-9320",
        "label": "SOURCE_VERIFIED",
    },
    {
        "claim": "handleMessage passes a params object into the boolean stream parameter",
        "path": "api.js",
        "lines": "19234, 19247, 19280, 9515-9566",
        "label": "SOURCE_VERIFIED",
    },
]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_text(ffprobe: str, path: Path, entries: str) -> str:
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        entries,
        "-of",
        "default=nw=1",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise SystemExit("ffprobe failed: " + result.stderr.strip())
    return result.stdout.strip()


def key_values(text: str) -> dict:
    data = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "=" in line:
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip()
        else:
            data["value"] = line
    return data


def probe(path: Path) -> dict:
    """Read format and codec facts from ffprobe or the project's shim."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise SystemExit("ffprobe is not installed")
    fmt = key_values(probe_text(ffprobe, path, "format=format_name,duration,size"))
    codec_raw = probe_text(ffprobe, path, "stream=codec_name")
    codec = (
        key_values(codec_raw).get("codec_name")
        or key_values(codec_raw).get("value")
        or codec_raw.splitlines()[0].strip()
    )
    return {
        "format": fmt,
        "streams": [{"codec_type": "audio", "codec_name": codec}],
    }


async def render(text: str, destination: Path) -> None:
    try:
        import edge_tts
    except ImportError as exc:
        raise SystemExit("edge-tts is not installed: " + str(exc))
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE)
    await communicate.save(str(destination))


def write_sidecar(text: str) -> None:
    if not AUDIO.is_file():
        raise SystemExit("missing audio: " + str(AUDIO))
    info = probe(AUDIO)
    duration = float(info["format"]["duration"])
    size = int(info["format"]["size"])
    meta = {
        "title": "অডিট রিপোর্ট পর্যালোচনা এবং মডিউল ইমপোর্ট প্রস্তাবনা",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "voice": VOICE,
        "rate": RATE,
        "audio_file": str(AUDIO.relative_to(ROOT)),
        "narration_file": str(TEXT.relative_to(ROOT)),
        "audio_sha256": sha256_file(AUDIO),
        "narration_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "duration_seconds": round(duration, 3),
        "size_bytes": size,
        "format": info["format"].get("format_name"),
        "streams": info.get("streams", []),
        "verdict": "core agree; details conditional; module-import proposal approved",
        "evidence": EVIDENCE,
    }
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"AUDIO_READY {AUDIO.relative_to(ROOT)} duration={duration:.1f}s size={size}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate the narration only")
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="probe an existing MP3 and rewrite the sidecar",
    )
    args = parser.parse_args()

    if not TEXT.is_file():
        raise SystemExit("missing narration: " + str(TEXT))
    text = TEXT.read_text(encoding="utf-8")
    if len(text) < MIN_TEXT_CHARS:
        raise SystemExit(f"narration is too short: {len(text)} chars")
    missing = [word for word in KEYWORDS if word not in text]
    if missing:
        raise SystemExit("narration is missing: " + ", ".join(missing))
    print(f"NARRATION_OK chars={len(text)} sha256={hashlib.sha256(text.encode()).hexdigest()[:16]}")
    if args.check:
        return 0
    if args.metadata_only:
        write_sidecar(text)
        return 0

    AUDIO.parent.mkdir(parents=True, exist_ok=True)
    temporary = AUDIO.with_name(AUDIO.name + ".part")
    try:
        asyncio.run(render(text, temporary))
        os.replace(temporary, AUDIO)
    finally:
        if temporary.exists():
            temporary.unlink()

    write_sidecar(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
