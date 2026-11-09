#!/usr/bin/env python3
"""Build the 2D/UI assets for the Tanks! port.

Reads the extracted ROM under build/rom/x and writes public/assets/ui/:
  textures/<archive>/<name>.png   every TPL image (RGBA, GX channel semantics)
  textures/index.json             per-texture format / wrap / filter info
  layouts/<layout>.json           BRLYT -> JSON
  anims/<anim>.json               BRLAN -> JSON
  fonts/<font>.png + .json        BRFNT glyph atlas + metrics
  messages/<bmg>.json             BMG -> JSON; messages/tanks.json = curated subset
  index.json                      manifest used by preview.html
  preview.html                    (copied from tools/ui/preview.html)

usage: python3 tools/ui/build_ui.py [--rom build/rom/x] [--out public/assets/ui]
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import png  # noqa: E402
from tpl import read_tpl  # noqa: E402
from brlyt import read_brlyt  # noqa: E402
from brlan import read_brlan  # noqa: E402
from brfnt import read_brfnt  # noqa: E402
from bmg import read_bmg  # noqa: E402
from tanks_text import TANKS_MESSAGES, TEXT_BINDINGS, LAYOUT_INFO  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", ".."))

# archive key -> (directory under rom root, group shown in the preview)
ARCHIVES = [
    ("tank", ["US/RPTnkScene/local/tank", "US/RPTnkScene/tank"], "tanks"),
    ("pause", ["US/PartyStatic/local/pause"], "shared"),
    ("ptPauseText", ["US/PartyStatic/local/ptPauseText"], "shared"),
    ("messageWindow", ["US/PartyStatic/local/messageWindow"], "shared"),
    ("myRecord", ["US/PartyStatic/local/myRecord"], "shared"),
    ("ptVsResult", ["US/PartyStatic/local/ptVsResult"], "shared"),
    ("AButton", ["US/PartyStatic/local/AButton"], "shared"),
    ("cCursorCircle", ["US/PartyStatic/local/cCursorCircle"], "shared"),
    ("cPadCursor", ["US/PartyStatic/local/cPadCursor"], "shared"),
    ("leadCursor", ["US/PartyStatic/local/leadCursor"], "shared"),
    ("backCommon", ["US/RPCommon/local/backCommon"], "shared"),
    ("menuCommon", ["US/RPCommon/local/menuCommon", "US/RPPartyCommon/local/menuCommon"], "shared"),
    ("nunchukCheck", ["US/RPCommon/local/nunchukCheck"], "shared"),
    ("playAdvice", ["US/RPCommon/local/playAdvice"], "shared"),
    ("playerSelect", ["US/RPCommon/local/playerSelect"], "shared"),
    ("rimoconEntry", ["US/RPCommon/local/rimoconEntry"], "shared"),
    ("ptSelectGame", ["US/RPPartyCommon/local/ptSelectGame"], "shared"),
]
FONT_DIR = "US/PartyStatic/local"
BMG_FILES = ["US/PartyStatic/local/party_message.bmg", "US/PartyStatic/local/common_message.bmg"]


def wjson(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        else:
            json.dump(obj, f, ensure_ascii=False, indent=1)


def find_dir(rom, cands):
    for c in cands:
        p = os.path.join(rom, c)
        if os.path.isdir(p):
            return p
    return None


def layout_for_anim(anim, layouts):
    best = None
    for l in layouts:
        if anim.startswith(l + "_") and (best is None or len(l) > len(best)):
            best = l
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rom", default=os.path.join(REPO, "build/rom/x"))
    ap.add_argument("--out", default=os.path.join(REPO, "public/assets/ui"))
    args = ap.parse_args()
    rom, out = args.rom, args.out
    t0 = time.time()
    os.makedirs(out, exist_ok=True)

    manifest = {"canvas": None, "layouts": {}, "fonts": {}, "textures": {}, "archives": {}}
    tex_index = {}
    seen_layout_hash = {}

    for key, cands, group in ARCHIVES:
        d = find_dir(rom, cands)
        if not d:
            print("missing archive", key, file=sys.stderr)
            continue
        manifest["archives"][key] = {"source": os.path.relpath(d, rom), "group": group}
        # textures
        tdir = os.path.join(d, "timg")
        names = sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []
        tex_index[key] = {}
        for fn in names:
            if not fn.endswith(".tpl"):
                continue
            imgs = read_tpl(open(os.path.join(tdir, fn), "rb").read())
            for i, (info, rgba) in enumerate(imgs):
                stem = fn[:-4] + ("" if i == 0 else "_%d" % i)
                rel = "textures/%s/%s.png" % (key, stem)
                os.makedirs(os.path.join(out, "textures", key), exist_ok=True)
                png.write(os.path.join(out, rel), info["width"], info["height"], rgba)
                info["file"] = rel
                tex_index[key][fn if i == 0 else "%s#%d" % (fn, i)] = info
        # layouts
        bdir = os.path.join(d, "blyt")
        lnames = []
        for fn in sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []:
            if not fn.endswith(".brlyt"):
                continue
            raw = open(os.path.join(bdir, fn), "rb").read()
            name = fn[:-6]
            h = hashlib.sha1(raw).hexdigest()
            if name in seen_layout_hash:
                if seen_layout_hash[name] == h:
                    continue
                name = key + "." + name
            seen_layout_hash[name] = h
            lay = read_brlyt(raw)
            lay["name"] = name
            lay["archive"] = key
            lay["source"] = os.path.relpath(os.path.join(bdir, fn), rom)
            lay["textureFiles"] = [tex_index[key].get(t, {}).get("file") for t in lay["textures"]]
            lay["fontFiles"] = ["fonts/%s.json" % f[:-6] for f in lay["fonts"]]
            if name in LAYOUT_INFO:
                lay["purpose"] = LAYOUT_INFO[name]
            if name in TEXT_BINDINGS:
                lay["textBindings"] = TEXT_BINDINGS[name]
            wjson(os.path.join(out, "layouts", name + ".json"), lay)
            manifest["canvas"] = manifest["canvas"] or lay["layout"]
            manifest["layouts"][name] = {"file": "layouts/%s.json" % name, "archive": key,
                                         "group": group, "anims": [],
                                         "purpose": LAYOUT_INFO.get(name, "")}
            lnames.append(name)
        # anims
        adir = os.path.join(d, "anim")
        for fn in sorted(os.listdir(adir)) if os.path.isdir(adir) else []:
            if not fn.endswith(".brlan"):
                continue
            name = fn[:-6]
            an = read_brlan(open(os.path.join(adir, fn), "rb").read())
            an["name"] = name
            an["source"] = os.path.relpath(os.path.join(adir, fn), rom)
            lay = layout_for_anim(name, lnames) or layout_for_anim(name, list(manifest["layouts"]))
            an["layout"] = lay
            # texture-pattern anims reference textures by name: resolve to files
            an["textureFiles"] = [tex_index[key].get(t, {}).get("file") for t in an.get("textures", [])]
            wjson(os.path.join(out, "anims", name + ".json"), an, compact=True)
            if lay and name not in manifest["layouts"][lay]["anims"]:
                manifest["layouts"][lay]["anims"].append(name)
    wjson(os.path.join(out, "textures", "index.json"), tex_index)

    # fonts
    os.makedirs(os.path.join(out, "fonts"), exist_ok=True)
    for fn in sorted(os.listdir(os.path.join(rom, FONT_DIR))):
        if not fn.endswith(".brfnt"):
            continue
        name = fn[:-6]
        info, atlas = read_brfnt(open(os.path.join(rom, FONT_DIR, fn), "rb").read())
        info, atlas = regrid_atlas(info, atlas)
        info["name"] = name
        info["image"] = "fonts/%s.png" % name
        png.write(os.path.join(out, "fonts", name + ".png"), info["atlas"]["width"], info["atlas"]["height"], atlas)
        wjson(os.path.join(out, "fonts", name + ".json"), info, compact=True)
        manifest["fonts"][name + ".brfnt"] = "fonts/%s.json" % name

    # messages
    all_msgs = {}
    for rel in BMG_FILES:
        name = os.path.basename(rel)[:-4]
        b = read_bmg(open(os.path.join(rom, rel), "rb").read())
        b["source"] = rel
        wjson(os.path.join(out, "messages", name + ".json"), b)
        for m in b["messages"]:
            all_msgs.setdefault(m["idHex"], m)
    tanks = {}
    for mid, meta in TANKS_MESSAGES.items():
        m = all_msgs.get(mid)
        if not m:
            print("missing message", mid, file=sys.stderr)
            continue
        e = {"text": m["text"], "use": meta}
        if m.get("tags"):
            e["tags"] = [{k: t[k] for k in ("group", "id", "params", "raw", "placeholder")} for t in m["tags"]]
        tanks[mid] = e
    wjson(os.path.join(out, "messages", "tanks.json"), tanks)

    shutil.copy(os.path.join(HERE, "preview.html"), os.path.join(out, "preview.html"))
    wjson(os.path.join(out, "index.json"), manifest)
    print("ui assets -> %s (%.1fs): %d layouts, %d fonts, %d texture archives"
          % (os.path.relpath(out, REPO), time.time() - t0, len(manifest["layouts"]),
             len(manifest["fonts"]), len(tex_index)))


def regrid_atlas(info, atlas):
    """Re-pack the vertically stacked sheets into a near-square grid of sheets
    so tall fonts (e.g. 64x512 x32) stay within texture limits."""
    sh = info["sheet"]
    n, sw, shh = sh["count"], sh["width"], sh["height"]
    import math
    per_row = max(1, min(n, int(math.ceil(math.sqrt(n * shh / sw)))))
    rows = (n + per_row - 1) // per_row
    W, H = per_row * sw, rows * shh
    out = bytearray(W * H * 4)
    for s in range(n):
        ox, oy = (s % per_row) * sw, (s // per_row) * shh
        for y in range(shh):
            src = ((s * shh + y) * sw) * 4
            dst = ((oy + y) * W + ox) * 4
            out[dst:dst + sw * 4] = atlas[src:src + sw * 4]
    for g in info["glyphs"].values():
        s, y = divmod(g["y"], shh)
        g["sheet"] = s
        g["x"] += (s % per_row) * sw
        g["y"] = (s // per_row) * shh + y
    info["atlas"] = {"width": W, "height": H, "sheetsPerRow": per_row}
    return info, out


if __name__ == "__main__":
    main()
