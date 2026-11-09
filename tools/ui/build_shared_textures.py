#!/usr/bin/env python3
"""Textures of the 3D result-screen models that the shared screens draw in 2D
(src/ui/shared/medal.ts, vsResult.ts): medal_model -> ui/textures/medal,
win_1P/win_2P/tie_model -> ui/textures/vsWinner.

usage: python3 tools/ui/build_shared_textures.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "tools/g3d"))
import brres  # noqa: E402
import gxtex  # noqa: E402

X = os.path.join(ROOT, "build/rom/x")
OUT = os.path.join(ROOT, "public/assets/ui/textures")
SOURCES = {
    "medal": ["Common/PartyStatic/common/G3D/medal_model.brres"],
    "vsWinner": [
        "US/PartyStatic/local/G3D/win_1P_model.brres",
        "US/PartyStatic/local/G3D/win_2P_model.brres",
        "US/PartyStatic/local/G3D/tie_model.brres",
    ],
}


def main():
    for folder, files in SOURCES.items():
        os.makedirs(os.path.join(OUT, folder), exist_ok=True)
        for f in files:
            b = brres.Brres(open(os.path.join(X, f), "rb").read(), f)
            pals = b.palettes()
            for name, off in b.items("Textures(NW4R)"):
                t = brres.parse_tex0(b.d, off, pals.get(name))
                w, h, rgba = t["images"][0]  # (width, height, RGBA8) of mip 0
                with open(os.path.join(OUT, folder, name + ".png"), "wb") as fh:
                    fh.write(gxtex.png_rgba(w, h, rgba))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
