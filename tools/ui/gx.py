"""GX texture decoders -> RGBA8 bytearrays.

All formats from the GX texture spec: I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8,
C4, C8, C14X2 (with IA8/RGB565/RGB5A3 palettes) and CMPR.

GX semantics are kept: intensity formats replicate I into all four channels
(I4/I8 -> RGBA = I,I,I,I), IA formats give RGB = I, A = A. This is what the TEV
sees, so the layout renderer can apply material colours exactly like the console.
"""
import struct

I4, I8, IA4, IA8, RGB565, RGB5A3, RGBA8 = 0, 1, 2, 3, 4, 5, 6
C4, C8, C14X2, CMPR = 8, 9, 10, 14

NAMES = {I4: "I4", I8: "I8", IA4: "IA4", IA8: "IA8", RGB565: "RGB565",
         RGB5A3: "RGB5A3", RGBA8: "RGBA8", C4: "C4", C8: "C8",
         C14X2: "C14X2", CMPR: "CMPR"}
PALETTE_NAMES = {0: "IA8", 1: "RGB565", 2: "RGB5A3"}

# (block width, block height, bits per pixel)
BLOCK = {I4: (8, 8, 4), I8: (8, 4, 8), IA4: (8, 4, 8), IA8: (4, 4, 16),
         RGB565: (4, 4, 16), RGB5A3: (4, 4, 16), RGBA8: (4, 4, 32),
         C4: (8, 8, 4), C8: (8, 4, 8), C14X2: (4, 4, 16), CMPR: (8, 8, 4)}


def data_size(w, h, fmt):
    bw, bh, bpp = BLOCK[fmt]
    bx = (w + bw - 1) // bw
    by = (h + bh - 1) // bh
    return bx * by * bw * bh * bpp // 8


def _c565(v):
    r = (v >> 11) & 0x1F
    g = (v >> 5) & 0x3F
    b = v & 0x1F
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255)


def _c5a3(v):
    if v & 0x8000:
        r = (v >> 10) & 0x1F
        g = (v >> 5) & 0x1F
        b = v & 0x1F
        return ((r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), 255)
    a = (v >> 12) & 7
    r = (v >> 8) & 0xF
    g = (v >> 4) & 0xF
    b = v & 0xF
    return (r * 17, g * 17, b * 17, (a << 5) | (a << 2) | (a >> 1))


def _cia8(v):
    a = v >> 8
    i = v & 0xFF
    return (i, i, i, a)


_LUT565 = None
_LUT5A3 = None


def _lut(kind):
    global _LUT565, _LUT5A3
    if kind == RGB565:
        if _LUT565 is None:
            _LUT565 = [bytes(_c565(v)) for v in range(65536)]
        return _LUT565
    if _LUT5A3 is None:
        _LUT5A3 = [bytes(_c5a3(v)) for v in range(65536)]
    return _LUT5A3


def decode_palette(data, off, count, pfmt):
    out = []
    for k in range(count):
        v = struct.unpack_from(">H", data, off + 2 * k)[0]
        out.append(bytes(_cia8(v) if pfmt == 0 else _c565(v) if pfmt == 1 else _c5a3(v)))
    return out


def decode(data, off, w, h, fmt, palette=None):
    """Decode a GX texture at data[off:] into an RGBA8 bytearray of w*h*4."""
    if fmt in (I4, C4):
        return _decode_4bpp(data, off, w, h, fmt, palette)
    bw, bh, bpp = BLOCK[fmt]
    out = bytearray(w * h * 4)
    src = off

    def put(x, y, px):
        if x < w and y < h:
            o = (y * w + x) * 4
            out[o:o + 4] = px

    if fmt == CMPR:
        for by in range(0, h, 8):
            for bx in range(0, w, 8):
                for sub in range(4):
                    sx = bx + (sub & 1) * 4
                    sy = by + (sub >> 1) * 4
                    c0, c1, bits = struct.unpack_from(">HHI", data, src)
                    src += 8
                    p0 = _c565(c0)
                    p1 = _c565(c1)
                    if c0 > c1:
                        p2 = tuple((2 * a + b) // 3 for a, b in zip(p0, p1))
                        p3 = tuple((a + 2 * b) // 3 for a, b in zip(p0, p1))
                    else:
                        p2 = tuple((a + b) // 2 for a, b in zip(p0, p1))
                        p3 = (p2[0], p2[1], p2[2], 0)
                    pal = (bytes(p0), bytes(p1), bytes(p2), bytes(p3))
                    for py in range(4):
                        for px in range(4):
                            idx = (bits >> (30 - 2 * (py * 4 + px))) & 3
                            put(sx + px, sy + py, pal[idx])
        return out

    for by in range(0, h, bh):
        for bx in range(0, w, bw):
            if fmt == RGBA8:
                blk = data[src:src + 64]
                src += 64
                for k in range(16):
                    a, r = blk[2 * k], blk[2 * k + 1]
                    g, b = blk[32 + 2 * k], blk[33 + 2 * k]
                    put(bx + (k & 3), by + (k >> 2), bytes((r, g, b, a)))
                continue
            for py in range(bh):
                for px in range(bw):
                    x, y = bx + px, by + py
                    if bpp == 8:
                        v = data[src]
                        src += 1
                        if fmt == I8:
                            put(x, y, bytes((v, v, v, v)))
                        elif fmt == IA4:
                            i = (v & 0xF) * 17
                            a = (v >> 4) * 17
                            put(x, y, bytes((i, i, i, a)))
                        else:  # C8
                            put(x, y, palette[v] if palette and v < len(palette) else b"\0\0\0\0")
                        continue
                    v = (data[src] << 8) | data[src + 1]
                    src += 2
                    if fmt == IA8:
                        put(x, y, bytes(_cia8(v)))
                    elif fmt == RGB565:
                        put(x, y, _lut(RGB565)[v])
                    elif fmt == RGB5A3:
                        put(x, y, _lut(RGB5A3)[v])
                    else:  # C14X2
                        v &= 0x3FFF
                        put(x, y, palette[v] if palette and v < len(palette) else b"\0\0\0\0")
    return out


def _decode_4bpp(data, off, w, h, fmt, palette):
    out = bytearray(w * h * 4)
    src = off
    if fmt == I4:
        lut = [bytes((v * 17,) * 4) for v in range(16)]
    else:
        lut = [(palette[v] if palette and v < len(palette) else b"\0\0\0\0") for v in range(16)]
    for by in range(0, h, 8):
        for bx in range(0, w, 8):
            for py in range(8):
                y = by + py
                row = data[src:src + 4]
                src += 4
                if y >= h:
                    continue
                for k in range(4):
                    byte = row[k]
                    x = bx + 2 * k
                    if x < w:
                        o = (y * w + x) * 4
                        out[o:o + 4] = lut[byte >> 4]
                    if x + 1 < w:
                        o = (y * w + x + 1) * 4
                        out[o:o + 4] = lut[byte & 0xF]
    return out
