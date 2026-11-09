#!/usr/bin/env python3
"""Losslessly re-encode public/assets/audio/**/*.wav to FLAC and point the manifest at them.

FLAC keeps every sample (loop points stay exact) and is decoded natively by
Chrome, Firefox and Safari. Needs ffmpeg (FFMPEG env var or ~/.local/opt/ffmpeg-static/ffmpeg).
usage: python3 tools/audio/compress.py
"""
import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../public/assets/audio")
FFMPEG = os.environ.get("FFMPEG") or os.path.expanduser("~/.local/opt/ffmpeg-static/ffmpeg")


def encode(wav):
    flac = wav[:-4] + ".flac"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", wav, "-compression_level", "8", flac], check=True)
    os.remove(wav)


def main():
    wavs = [os.path.join(d, f) for d, _, fs in os.walk(ROOT) for f in fs if f.endswith(".wav")]
    with ThreadPoolExecutor(os.cpu_count()) as ex:
        list(ex.map(encode, wavs))
    path = os.path.join(ROOT, "manifest.json")
    text = open(path).read().replace('.wav"', '.flac"')
    json.loads(text)
    open(path, "w").write(text)
    print("encoded", len(wavs), "files")


if __name__ == "__main__":
    main()
