#!/usr/bin/env python3
"""Tile decoded PNG textures onto a checkerboard so alpha is visible.

    python3 tools/g3d/contact_sheet.py OUT.png DIR_OR_PNG... [--cell 128]

Only reads PNGs written by gxtex.png_rgba (8-bit RGBA, filter type 0 rows),
which is all this pipeline emits.  Prints the tile order.
"""
import argparse
import os
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gxtex  # noqa: E402


def read_png(path):
    d = open(path, "rb").read()
    assert d[:8] == b"\x89PNG\r\n\x1a\n"
    p, idat, w, h = 8, b"", 0, 0
    while p < len(d):
        n, tag = struct.unpack(">I4s", d[p:p + 8])
        body = d[p + 8:p + 8 + n]
        if tag == b"IHDR":
            w, h, bd, ct = struct.unpack(">IIBB", body[:10])
            assert (bd, ct) == (8, 6), "only RGBA8 PNGs supported"
        elif tag == b"IDAT":
            idat += body
        p += 12 + n
    raw = zlib.decompress(idat)
    out = bytearray()
    stride = w * 4
    for y in range(h):
        row = raw[y * (stride + 1):(y + 1) * (stride + 1)]
        assert row[0] == 0, "only filter 0 supported"
        out += row[1:]
    return w, h, out


def sheet(files, cell=128, cols=8):
    rows = (len(files) + cols - 1) // cols
    W, H = cols * (cell + 4) + 4, rows * (cell + 4) + 4
    img = bytearray(b"\x30\x30\x30\xff" * (W * H))
    for n, f in enumerate(files):
        w, h, px = read_png(f)
        s = min(cell / w, cell / h)
        tw, th = max(1, int(w * s)), max(1, int(h * s))
        ox, oy = 4 + (n % cols) * (cell + 4), 4 + (n // cols) * (cell + 4)
        for y in range(th):
            for x in range(tw):
                sx, sy = min(w - 1, int(x / s)), min(h - 1, int(y / s))
                i = (sy * w + sx) * 4
                r, g, b, a = px[i:i + 4]
                chk = 200 if ((x // 8) + (y // 8)) % 2 else 140
                r = (r * a + chk * (255 - a)) // 255
                g = (g * a + chk * (255 - a)) // 255
                b = (b * a + chk * (255 - a)) // 255
                j = ((oy + y) * W + ox + x) * 4
                img[j:j + 4] = bytes((r, g, b, 255))
    return gxtex.png_rgba(W, H, img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--cell", type=int, default=128)
    ap.add_argument("--cols", type=int, default=8)
    a = ap.parse_args()
    files = []
    for i in a.inputs:
        if os.path.isdir(i):
            files += sorted(os.path.join(i, f) for f in os.listdir(i) if f.endswith(".png"))
        else:
            files.append(i)
    for n, f in enumerate(files):
        print(n, os.path.relpath(f))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    open(a.out, "wb").write(sheet(files, a.cell, a.cols))


if __name__ == "__main__":
    main()
