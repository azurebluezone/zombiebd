#!/usr/bin/env python3
"""Generate the Bengali ZombieCoder system brief with edge-tts.

Why a script instead of one long shell command:
  - the narration is versioned with the project, so a future change is a diff;
  - --check validates the sections, voice and output path without network;
  - the real run writes to a .part file first, then atomically replaces the MP3.

Usage:
  python3 scripts/audio-brief.py --check
  python3 scripts/audio-brief.py
  python3 scripts/audio-brief.py --out /tmp/brief.mp3 --voice bn-BD-PradeepNeural
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import hashlib
import json
import os
import sys
from pathlib import Path

VOICE = "bn-BD-NabanitaNeural"
DEFAULT_OUT = os.path.expanduser("~/Music/mp3/zbd/today/fday/zombiecoder-brief-bn.mp3")

# (section title, narration) — kept as data so --check can validate the whole
# brief without synthesizing it. Facts here mirror the runbook and the live
# /health + /api/agents responses from 2026-11-20.
SECTIONS: list[tuple[str, str]] = [
    (
        "ভূমিকা",
        "ভাইয়া, এই অডিওটি জম্বি কোডার মিশন বরিশাল গেটওয়ের একটি সংক্ষিপ্ত কিন্তু বিস্তারিত অবস্থা প্রতিবেদন। "
        "তারিখ বিশ নভেম্বর, দুই হাজার ছাব্বিশ। সিস্টেমের ভার্সন তিন পয়েন্ট দুই পয়েন্ট এক। "
        "এটি একটি নোড জেএস গেটওয়ে, যা পাঁচ হাজার পঞ্চাশ পোর্টে চলে, এবং এডিটর, এমসিপি ক্লায়েন্ট আর ওয়েব চ্যাটকে একই এপিআই দিয়ে সেবা দেয়।",
    ),
    (
        "এখন পর্যন্ত কী হয়েছে",
        "প্রথমে, এখন পর্যন্ত কী কী করা হয়েছে। রানবুকের আটটি ধাপ সম্পূর্ণ। "
        "এক, প্রোভাইডার হেলথ আর পুরোনো এরর পরিষ্কার করা হয়েছে। "
        "দুই, টেস্টের সময় গেটওয়ে যেন আসল মিশন ডিরেক্টরি নোংরা না করে, সেই আলাদা করা হয়েছে। "
        "তিন, ব্রিজ আর ওলামার মধ্যে প্রোভাইডার অ্যাট্রিবিউশন ঠিক করা হয়েছে। "
        "চার, লোকাল টুল ক্যাপের পুরোনো টেস্ট ঠিক করা হয়েছে। "
        "পাঁচ, সব সাইজ বাজেট এক জায়গায় আনা হয়েছে এবং রিকোয়েস্ট লগে রাউটিং ট্রেস যোগ হয়েছে। "
        "ছয়, আরটুটি ফলব্যাক এখন লগ এবং রেসপন্স হেডারে দেখা যায়। "
        "সাত, এক কমান্ডে নিরাপদ রিবিল্ড আর রিস্টার্ট। "
        "আট, প্যাকেজ ডট জেসন এবং এপ্ট, ডিএনএফ, প্যাকম্যান, ব্রিউ চার প্যাকেজ ম্যানেজারের ইনস্টল প্ল্যান। "
        "প্রতিটির আলাদা গেট আর বাস্তব প্রমাণ আছে।",
    ),
    (
        "চলমান কাজ",
        "নবম ধাপ হিসেবে এখন দুটি কাজ চলছে। এক, লগ এবং এজেন্ট ব্যাকআপের জন্য সীমিত রিটেনশন, যাতে চলতি লগ বা ডাটাবেস কখনো না মোছে। "
        "দুই, ত্রিশটি নির্দিষ্ট কেসের একটি কোয়ালিটি ইভাল হারনেস, যা ইন্টেন্ট, চ্যাট টুল অনুমতি, সাইজ বাজেট, আইডেন্টিটি, ভার্সন, আরটুটি ট্রেস এবং স্বাস্থ্য পরীক্ষা করে। "
        "এই ধাপের গেট কিউলিটি ইভাল ওকে।",
    ),
    (
        "কীভাবে কাজ করে",
        "সিস্টেম কীভাবে কাজ করে। এডিটর বা এমসিপি ক্লায়েন্ট প্রথমে গেটওয়ের পাঁচ হাজার পঞ্চাশ পোর্টে অনুরোধ পাঠায়। "
        "গেটওয়ে ইন্টেন্ট ক্লাসিফায়ার দিয়ে বোঝে এটি চ্যাট, প্রশ্ন, রিভিউ, ডিবাগ, পরিবর্তন, এক্সিকিউট, সার্চ নাকি রিলিজ। "
        "তারপর সিস্টেম প্রম্পট তৈরি হয়। আইডেন্টিটি ফাইল থেকে নাম, মালিক, ভার্সন আর আইডেন্টিটি অ্যাংকর আসে। "
        "এরপর প্রোভাইডার অ্যাডাপ্টার সঠিক মডেল ও প্রোভাইডার বেছে নেয়। "
        "মডেল টুল চাইলে গেটওয়ে টুল চালায়, ফলাফল সীমিত করে আবার মডেলে পাঠায়। "
        "প্রতিটি অনুরোধ এসকিউলাইট ডাটাবেসে লগ হয়। "
        "লোকাল ব্রিজ এগারো হাজার চারশ পঁয়ত্রিশ পোর্টে, ওলামা এগারো হাজার চারশ চৌত্রিশ পোর্টে। "
        "আরটুটি রুট আলাদা ইঞ্জিন আর ফলব্যাক হেডার দেয়।",
    ),
    (
        "সীমা ও বাজেট",
        "সীমা বা বাজেটগুলো। এইচটিটিপি বডি সর্বোচ্চ দশ মেগাবাইট। "
        "হিস্টোরি দশটি মেসেজ, সর্বোচ্চ ছয় হাজার অক্ষর। "
        "এক প্রোভাইডার কল সর্বোচ্চ দুই মেগাবাইট। "
        "ওয়েব ইউআইয়ের এক পেলোড পাঁচশ বারো কিলোবাইট। "
        "এক স্ট্রিম ফ্রেম আট মেগাবাইট। "
        "এক টুল ফলাফল চৌষট্টি কিলোবাইট। "
        "সীমা ছাড়ালে চুপচাপ কাটা হয় না, বাজেট এক্সিডেড লগ হয়।",
    ),
    (
        "প্রোভাইডার",
        "প্রোভাইডার। গেটওয়েতে ওপেনএআই-সদৃশ, জেমিনি, গ্রোভ, ওলামা, লামা সিপিপি, ওপেনকোড এবং কাস্টম অ্যাডাপ্টার আছে। "
        "এনভায়রনমেন্টে অ্যাডমিন, কাস্টম প্রক্সি, জেমিনি, গ্রোভ, ওলামা, ওলামা ক্লাউড এবং ওপেনকোড কী আছে। "
        "লাইভ ক্যাটালগে দুইশ তেষট্টি মডেল দেখা যায়। "
        "কোন প্রোভাইডার আসলে উত্তর দিয়েছে, তা রিকোয়েস্ট লগের আপস্ট্রিম প্রোভাইডার কলামে থাকে।",
    ),
    (
        "এজেন্ট",
        "এজেন্ট। গেটওয়ের এজেন্ট রেজিস্ট্রিতে নয়টি প্রোফাইল আছে: কোড গুরু, বাগ হান্টার, সিকিউরিটি হিরো, পারফ উইজার্ড, ডক কিং, কিউএ টাইর্যান্ট, টিম হার্ট, কাস্টমার এক্সপেরিয়েন্স স্পেশালিস্ট এবং ইকমার্স অপারেশন্স অ্যানালিস্ট। "
        "অর্কেস্ট্রেশনে আরও নয়টি ভূমিকা আছে: মানু আর্কিটেক্ট, নিলা ইউআই, ব্রিষ্টি সিকিউরিটি, জারিন ডিবাগ, রাশেদ পারফরম্যান্স, হালিম ডকুমেন্টেশন, তুহিন মডেল ও এমসিপি, মজনু কিউএ, এবং জম্বি কোডার আরবিটার। "
        "প্রত্যেকে নিজের সীমিত কাজ করে, আর মূল এজেন্ট ফলাফল একত্র করে।",
    ),
    (
        "কে কার সাথে কথা বলে",
        "কে কার সাথে কথা বলে। এডিটর বা ক্লায়েন্ট কথা বলে গেটওয়ের সাথে। "
        "গেটওয়ে কথা বলে প্রোভাইডার, লোকাল ব্রিজ, ওলামা, এমসিপি সার্ভার এবং ডাটাবেসের সাথে। "
        "ব্রিজ কথা বলে ওলামার সাথে। "
        "ওয়েব চ্যাট গেটওয়ের ভেতরের ইন্টারপ্রিটারের সাথে, যার টুল অনুমতি শুধু ওয়েব সার্চ, সময় এবং ক্যালকুলেটর। "
        "মিশন বা এডিটর রুটে ফাইল, শেল আর এমসিপি টুল বেশি, কিন্তু প্রমাণের নিয়ম একই।",
    ),
    (
        "আচরণ",
        "আচরণ। সিস্টেম কখনো মানুষ বলে দাবি করে না। "
        "প্রমাণ ছাড়া কিছু সত্য বলে না, আনভেরিফাইড বলে থামে। "
        "বড় কাজের আগে গোল কনট্র্যাক্ট খোলে, সত্যিকারের চেক চালায়, পাস হলেই কাজ শেষ বলে। "
        "কোনো মক বা ডেমো লজিক উৎপাদনে যায় না।",
    ),
    (
        "কী বাকি",
        "কী বাকি। ডকুমেন্টেশনের পুরোনো স্ন্যাপশট ঠিক করা, স্কিল এমসিপি ইন্টিগ্রেশন, সারফেস পলিসি টেবিল, এবং চ্যাট আপলোড। "
        "এছাড়া তিনটি পুরোনো লাল টেস্ট আছে: ট্রান্সপোর্ট এইচটিটিপিএস সার্টিফিকেট, সিভিডি ডাটাবেস রিপেয়ার লগ, এবং প্রোভাইডার ম্যাট্রিক্সে টুলকল শূন্য।",
    ),
    (
        "পরবর্তী ধাপ",
        "পরবর্তী ধাপ। প্রথমে ডকুমেন্টেশন কারেন্ট গেট, তারপর স্কিল এমসিপি গেট, তারপর সারফেস পলিসি এবং চ্যাট আপলোড। "
        "প্রতিটি ধাপে আগে কনট্র্যাক্ট, তারপর বাস্তব চেক, তারপর প্রমাণ, তারপর পুশ। "
        "এই অডিওটি এজ টিটিএস পাইথন দিয়ে বাংলা ভয়েসে তৈরি। ধন্যবাদ।",
    ),
]


def full_text() -> str:
    return "\n\n".join(body for _, body in SECTIONS)


def validate(out: Path, voice: str) -> list[str]:
    errors: list[str] = []
    text = full_text()
    if len(SECTIONS) < 8:
        errors.append(f"expected at least 8 sections, got {len(SECTIONS)}")
    if len(text) < 1500:
        errors.append(f"narration is too short: {len(text)} chars")
    if "\ufffd" in text:
        errors.append("narration contains a Unicode replacement character")
    if not voice.startswith("bn-"):
        errors.append(f"voice is not Bengali: {voice}")
    if out.suffix.lower() != ".mp3":
        errors.append(f"output must be .mp3: {out}")
    parent = out.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    if not os.access(parent, os.W_OK):
        errors.append(f"output directory is not writable: {parent}")
    return errors


async def synthesize(out: Path, voice: str, rate: str) -> None:
    try:
        import edge_tts  # type: ignore
    except Exception as exc:  # noqa: BLE001 - report the real import error
        raise SystemExit(f"AUDIO_BRIEF_FAIL edge_tts_missing: {exc}") from exc

    text = full_text()
    out.parent.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    await edge_tts.Communicate(text, voice, rate=rate).save(str(part))
    part.replace(out)

    sidecar = out.with_suffix(".json")
    sidecar.write_text(
        json.dumps(
            {
                "voice": voice,
                "rate": rate,
                "chars": len(text),
                "sections": [title for title, _ in SECTIONS],
                "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "bytes": out.stat().st_size,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Bengali system brief with edge-tts")
    parser.add_argument("--out", default=os.environ.get("AUDIO_BRIEF_OUT", DEFAULT_OUT))
    parser.add_argument("--voice", default=os.environ.get("AUDIO_BRIEF_VOICE", VOICE))
    parser.add_argument("--rate", default=os.environ.get("AUDIO_BRIEF_RATE", "+0%"))
    parser.add_argument("--check", action="store_true", help="validate without network")
    args = parser.parse_args()

    out = Path(args.out).expanduser().resolve()
    errors = validate(out, args.voice)
    if errors:
        for error in errors:
            print(f"AUDIO_BRIEF_FAIL {error}", file=sys.stderr)
        return 2

    if args.check:
        print(
            "AUDIO_BRIEF_CHECK_OK "
            f"sections={len(SECTIONS)} chars={len(full_text())} voice={args.voice} out={out}"
        )
        return 0

    asyncio.run(synthesize(out, args.voice, args.rate))
    print(
        "AUDIO_BRIEF_OK "
        f"out={out} chars={len(full_text())} bytes={out.stat().st_size} voice={args.voice}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
