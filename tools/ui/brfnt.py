"""BRFNT (NW4R resource font) -> atlas RGBA + metrics dict."""
import struct

from gx import decode, NAMES

MAPPING = {0: "direct", 1: "table", 2: "scan"}
ENCODING = {0: "UTF-8", 1: "UTF-16", 2: "SJIS", 3: "CP1252"}


def read_brfnt(data):
    assert data[:4] == b"RFNT", "not a BRFNT"
    version, = struct.unpack_from(">H", data, 6)
    hsize, nsec = struct.unpack_from(">HH", data, 12)
    o = hsize
    assert data[o:o + 4] == b"FINF"
    (ftype, linefeed, alt, dleft, dglyph, dchar, enc, pglyph, pwidth, pmap,
     height, width, ascent) = struct.unpack_from(">BbHbBbBIIIBBB", data, o + 8)
    info = {"version": version, "fontType": ftype, "lineFeed": linefeed,
            "alterCharIndex": alt, "defaultWidth": {"left": dleft, "glyphWidth": dglyph, "charWidth": dchar},
            "encoding": ENCODING.get(enc, enc), "height": height, "width": width, "ascent": ascent}

    # TGLP
    t = pglyph - 8
    assert data[t:t + 4] == b"TGLP"
    (cw, ch, baseline, maxw, ssize, snum, sfmt, srow, sline, sw, sh, soff) = \
        struct.unpack_from(">BBbBIHHHHHHI", data, t + 8)
    fmt = sfmt & 0x7FFF
    info.update({"cellWidth": cw, "cellHeight": ch, "baseline": baseline, "maxCharWidth": maxw,
                 "sheet": {"count": snum, "format": NAMES.get(fmt, fmt), "compressed": bool(sfmt & 0x8000),
                           "cols": srow, "rows": sline, "width": sw, "height": sh, "bytes": ssize}})
    atlas = bytearray()
    for s in range(snum):
        atlas += decode(data, soff + s * ssize, sw, sh, fmt)
    info["atlas"] = {"width": sw, "height": sh * snum}

    # CWDH chain
    widths = {}
    p = pwidth
    while p:
        b = p - 8
        assert data[b:b + 4] == b"CWDH"
        ib, ie, nxt = struct.unpack_from(">HHI", data, b + 8)
        for k in range(ie - ib + 1):
            l, g, c = struct.unpack_from(">bBb", data, b + 16 + 3 * k)
            widths[ib + k] = (l, g, c)
        p = nxt

    # CMAP chain
    cmap = {}
    blocks = []
    p = pmap
    while p:
        b = p - 8
        assert data[b:b + 4] == b"CMAP"
        cb, ce, method, nxt = struct.unpack_from(">HHHxxI", data, b + 8)
        d = b + 20
        blocks.append({"begin": cb, "end": ce, "method": MAPPING.get(method, method)})
        if method == 0:
            off, = struct.unpack_from(">H", data, d)
            for c in range(cb, ce + 1):
                cmap[c] = off + (c - cb)
        elif method == 1:
            for k, c in enumerate(range(cb, ce + 1)):
                idx, = struct.unpack_from(">H", data, d + 2 * k)
                if idx != 0xFFFF:
                    cmap[c] = idx
        elif method == 2:
            n, = struct.unpack_from(">H", data, d)
            for k in range(n):
                c, idx = struct.unpack_from(">HH", data, d + 2 + 4 * k)
                cmap[c] = idx
        p = nxt
    info["cmapBlocks"] = blocks

    per_sheet = srow * sline
    glyphs = {}
    for c in sorted(cmap):
        idx = cmap[c]
        s, r = divmod(idx, per_sheet)
        x = (r % srow) * (cw + 1)
        y = s * sh + (r // srow) * (ch + 1)
        l, g, w = widths.get(idx, (dleft, dglyph, dchar))
        glyphs[str(c)] = {"index": idx, "x": x, "y": y, "left": l, "glyphWidth": g, "charWidth": w}
    info["glyphCount"] = len(glyphs)
    info["glyphs"] = glyphs
    return info, atlas
