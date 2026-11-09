#!/usr/bin/env python3
"""Convert Tanks! map files and TnkGameParam.bin to JSON for the web build.

Reads build/rom/x/Common/RPTnkScene/common, writes public/assets/data/.
See docs/rom-notes.md for the formats.
"""
import glob
import json
import os
import re
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "build/rom/x/Common/RPTnkScene/common")
OUT = os.path.join(ROOT, "public/assets/data")

TANK_WORDS = 42
MISSION_WORDS = 22


def words(path):
    d = open(path, "rb").read()
    n = len(d) // 4
    return list(struct.unpack(">%di" % n, d)), list(struct.unpack(">%df" % n, d))


def as_number(i, f):
    """Params mix ints and floats; anything that isn't a small int is a float."""
    return i if -100000 < i < 100000 else round(f, 6)


def build_maps():
    maps = {}
    for path in sorted(glob.glob(os.path.join(SRC, "MapData/TnkMapData_P*_*_*.bin"))):
        players, idx, aspect = re.search(r"P(\d)_(\d+)_(\d)", path).groups()
        w, _ = words(path)
        # [W, H, P1 facing, P2 facing, cells...]; facing 0/1/2/3 = 0/180/90/270 degrees
        width, height = w[0], w[1]
        cells = w[4:4 + width * height]
        assert len(w) == 4 + width * height, path
        rows = [cells[r * width:(r + 1) * width] for r in range(height)]
        key = "P%s_%s_%s" % (players, idx, "16_9" if aspect == "1" else "4_3")
        maps[key] = {"width": width, "height": height, "facing": w[2:4], "cells": rows}
    return maps


def build_params():
    wi, wf = words(os.path.join(SRC, "param/TnkGameParam.bin"))
    vals = [as_number(i, f) for i, f in zip(wi, wf)]
    header = vals[0]
    tanks = [vals[1 + t * TANK_WORDS:1 + (t + 1) * TANK_WORDS] for t in range(10)]
    base = 1 + 10 * TANK_WORDS
    missions = []
    for m in range(100):
        r = wi[base + m * MISSION_WORDS:base + (m + 1) * MISSION_WORDS]
        missions.append({
            "bonus": r[0],
            "bonus2P": r[1],
            "slots1P": r[2:10],
            "slots2P": r[10:18],
            "map1P": r[18:20],
            "map2P": r[20:22],
        })
    return {"header": header, "tanks": tanks, "missions": missions}


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "maps.json"), "w") as f:
        json.dump(build_maps(), f, separators=(",", ":"))
    with open(os.path.join(OUT, "params.json"), "w") as f:
        json.dump(build_params(), f, indent=1)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
