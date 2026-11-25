#!/usr/bin/env python3
"""Verify the Bengali audit-proposal audio and its provenance sidecar.

Prints AUDIT_AUDIO_OK only when every check passes. This is the literal
marker recorded in the active goal contract, so a partial file or a stale
sidecar must fail loudly.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.mp3"
TEXT = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.txt"
META = ROOT / "docs/audio/audit-apijs-2026-11-24-bn.json"
VOICE = "bn-BD-NabanitaNeural"
MIN_SECONDS = 300.0
MIN_BYTES = 500_000
MIN_TEXT_CHARS = 6_000
KEYWORDS = (
    "সহমত",
    "মডিউল",
    "ইমপোর্ট",
    "এপিআই ডট জেএস",
    "সার্ভার্স ডট জেসন",
)


def fail(message: str) -> "NoReturn":
    print("AUDIT_AUDIO_FAIL: " + message)
    raise SystemExit(1)


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
        fail("ffprobe rejected the file: " + result.stderr.strip())
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
        fail("ffprobe is not installed")
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


def main() -> int:
    for path in (AUDIO, TEXT, META):
        if not path.is_file():
            fail("missing file: " + str(path.relative_to(ROOT)))

    text = TEXT.read_text(encoding="utf-8")
    if len(text) < MIN_TEXT_CHARS:
        fail(f"narration is too short: {len(text)} chars")
    missing = [word for word in KEYWORDS if word not in text]
    if missing:
        fail("narration is missing required ideas: " + ", ".join(missing))

    meta = json.loads(META.read_text(encoding="utf-8"))
    narration_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    audio_sha = sha256_file(AUDIO)
    if meta.get("voice") != VOICE:
        fail("sidecar voice mismatch")
    if meta.get("narration_sha256") != narration_sha:
        fail("narration hash mismatch; the audio may be stale")
    if meta.get("audio_sha256") != audio_sha:
        fail("audio hash mismatch; the sidecar is stale")

    info = probe(AUDIO)
    streams = [item for item in info.get("streams", []) if item.get("codec_type") == "audio"]
    if not streams:
        fail("no audio stream in the MP3")
    if streams[0].get("codec_name") != "mp3":
        fail("audio codec is not mp3: " + str(streams[0].get("codec_name")))
    try:
        duration = float(info["format"]["duration"])
        size = int(info["format"]["size"])
    except (KeyError, TypeError, ValueError) as exc:
        fail("ffprobe output is missing duration/size: " + str(exc))
    if duration < MIN_SECONDS:
        fail(f"audio is too short: {duration:.1f}s < {MIN_SECONDS:.0f}s")
    if size < MIN_BYTES:
        fail(f"audio file is too small: {size} bytes")
    if abs(float(meta.get("duration_seconds", 0)) - duration) > 2.0:
        fail("sidecar duration does not match the audio")
    if int(meta.get("size_bytes", 0)) != size:
        fail("sidecar size does not match the audio")

    print(
        "AUDIT_AUDIO_OK "
        f"duration={duration:.1f}s size={size} voice={VOICE} "
        f"sha256={audio_sha[:16]}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
