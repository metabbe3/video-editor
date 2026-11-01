#!/usr/bin/env python3
"""Build test/fixture/ — an A-roll with REAL speech (macOS `say`) at exactly
known word times, a long-pause structure, fillers, and a B-roll pool.
Writes ground-truth.json alongside. Stdlib only. Run: python3 scripts/make_fixture.py
"""
import json, subprocess, wave, sys, os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "test" / "fixture"
FIX.mkdir(parents=True, exist_ok=True)
TMP = FIX / ".tmp"
TMP.mkdir(exist_ok=True)
RATE = 22050

# (word, gap_after_seconds). Long gaps = the pauses the engine must trim.
SCRIPT = [
    ("hey", 0.25), ("so", 0.25), ("um", 0.30), ("I", 0.15), ("built", 0.15),
    ("this", 0.15), ("editor", 0.40), ("it", 0.25), ("cuts", 0.20), ("filler", 0.25),
    ("words", 0.60), ("and", 0.20), ("dead", 0.20), ("air", 0.60),
    ("you", 0.12), ("know", 0.35), ("it", 0.15), ("runs", 0.20), ("in", 0.12),
    ("your", 0.12), ("browser", 0.50), ("uh", 0.30), ("nothing", 0.20),
    ("leaves", 0.20), ("your", 0.20), ("machine", 0.60),
    ("export", 0.25), ("takes", 0.20), ("one", 0.20), ("click", 0.60),
    ("pretty", 0.20), ("wild", 0.40), ("right", 0.30),
]
LONG_PAUSES_AFTER = {"words": 1.7, "air": 1.9, "machine": 1.5}  # word -> pause before the NEXT word
LEAD_SILENCE = 0.8
TAIL_SILENCE = 0.8


def say_word(text: str) -> tuple[bytes, int]:
    aiff = TMP / "w.aiff"
    wav = TMP / "w.wav"
    subprocess.run(["say", "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(aiff), "-ar", str(RATE), "-ac", "1",
                    "-c:a", "pcm_s16le", str(wav)], check=True)
    with wave.open(str(wav)) as w:
        return w.readframes(w.getnframes()), w.getnframes()


def main():
    parts, words, t = [], [], LEAD_SILENCE
    pcm = bytearray()
    silence = lambda sec: b"\x00\x00" * int(sec * RATE)

    pcm += silence(LEAD_SILENCE)
    for i, (word, gap) in enumerate(SCRIPT):
        data, n = say_word(word)
        start = len(pcm) / 2 / RATE
        pcm += data
        words.append({"i": len(words), "w": word, "start": round(start, 3),
                      "end": round(start + n / RATE, 3)})
        pause = LONG_PAUSES_AFTER.get(word, gap)
        pcm += silence(pause)
    pcm += silence(TAIL_SILENCE)

    voice = FIX / ".voice.wav"
    with wave.open(str(voice), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(bytes(pcm))
    dur = len(pcm) / 2 / RATE

    subprocess.run(["ffmpeg", "-y", "-v", "error",
                    "-f", "lavfi", "-i", f"testsrc2=size=1080x1920:rate=30:duration={dur:.2f}",
                    "-i", str(voice),
                    "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p", "-crf", "23",
                    "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart",
                    str(FIX / "a-roll.mp4")], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error",
                    "-f", "lavfi", "-i", f"testsrc2=size=720x1280:rate=30:duration=5",
                    "-c:v", "libx264", "-preset", "fast", "-pix_fmt", "yuv420p",
                    str(FIX / "b-roll-city.mp4")], check=True)
    subprocess.run(["ffmpeg", "-y", "-v", "error",
                    "-f", "lavfi", "-i", "testsrc2=size=1080x1350:rate=1",
                    "-frames:v", "1", str(FIX / "poster.jpg")], check=True)

    fillers = [w for w in words if w["w"] in ("um", "uh")]
    pauses = []
    for i, w in enumerate(words):
        if w["w"] in LONG_PAUSES_AFTER and i + 1 < len(words):
            pauses.append({"start": w["end"], "end": words[i + 1]["start"]})
    (FIX / "ground-truth.json").write_text(json.dumps({
        "duration": round(dur, 3), "words": words, "fillers": fillers, "longPauses": pauses,
    }, indent=1))
    for f in TMP.iterdir(): f.unlink()
    TMP.rmdir()
    print(f"fixture ready: {dur:.1f}s, {len(words)} words, {len(fillers)} fillers, {len(pauses)} long pauses -> {FIX}")


if __name__ == "__main__":
    sys.exit(main())
