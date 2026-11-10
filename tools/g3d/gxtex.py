"""GX texture decoding (all GX formats) and a minimal PNG encoder.

Decoders return a bytearray of RGBA8 pixels, row-major, top row first.
"""
import struct
import zlib

FMT_NAMES = {
    0x0: "I4", 0x1: "I8", 0x2: "IA4", 0x3: "IA8", 0x4: "RGB565", 0x5: "RGB5A3",
    0x6: "RGBA8", 0x8: "CI4", 0x9: "CI8", 0xA: "CI14X2", 0xE: "CMPR",
}
# (block width, block height, bits per pixel)
FMT_BLOCK = {
    0x0: (8, 8, 4), 0x1: (8, 4, 8), 0x2: (8, 4, 8), 0x3: (4, 4, 16),
    0x4: (4, 4, 16), 0x5: (4, 4, 16), 0x6: (4, 4, 32), 0x8: (8, 8, 4),
    0x9: (8, 4, 8), 0xA: (4, 4, 16), 0xE: (8, 8, 4),
}
PAL_NAMES = {0: "IA8", 1: "RGB565", 2: "RGB5A3"}


def image_size(fmt, w, h):
    bw, bh, bpp = FMT_BLOCK[fmt]
    return ((w + bw - 1) // bw) * ((h + bh - 1) // bh) * bw * bh * bpp // 8


def _x5(v):
    return (v << 3) | (v >> 2)


def _x6(v):
    return (v << 2) | (v >> 4)


def _x4(v):
    return (v << 4) | v


def _x3(v):
    return (v << 5) | (v << 2) | (v >> 1)


def rgb565(v):
    return (_x5(v >> 11), _x6((v >> 5) & 0x3F), _x5(v & 0x1F), 255)


def rgb5a3(v):
    if v & 0x8000:
        return (_x5((v >> 10) & 0x1F), _x5((v >> 5) & 0x1F), _x5(v & 0x1F), 255)
    return (_x4((v >> 8) & 0xF), _x4((v >> 4) & 0xF), _x4(v & 0xF), _x3((v >> 12) & 0x7))


def ia8(v):
    a, i = v >> 8, v & 0xFF
    return (i, i, i, a)


def decode_palette(data, off, pal_fmt, count):
    conv = {0: ia8, 1: rgb565, 2: rgb5a3}[pal_fmt]
    return [conv(struct.unpack_from(">H", data, off + 2 * i)[0]) for i in range(count)]


def decode(data, off, fmt, w, h, palette=None):
    """Decode one image level. palette: list of RGBA tuples for CI formats."""
    out = bytearray(w * h * 4)
    bw, bh, bpp = FMT_BLOCK[fmt]
    bx_n = (w + bw - 1) // bw
    by_n = (h + bh - 1) // bh
    p = off

    def put(x, y, c):
        if x < w and y < h:
            i = (y * w + x) * 4
            out[i:i + 4] = bytes(c)

    if bpp == 4 and fmt != 0xE:
        return _decode_4bpp(data, off, fmt, w, h, palette)
    if fmt == 0xE:  # CMPR: 8x8 blocks of 2x2 DXT1 sub-blocks
        for by in range(by_n):
            for bx in range(bx_n):
                for sub in range(4):
                    c0, c1 = struct.unpack_from(">HH", data, p)
                    bits = struct.unpack_from(">I", data, p + 4)[0]
                    p += 8
                    a = rgb565(c0)
                    b = rgb565(c1)
                    if c0 > c1:
                        pal = [a, b,
                               tuple((2 * a[k] + b[k]) // 3 for k in range(3)) + (255,),
                               tuple((a[k] + 2 * b[k]) // 3 for k in range(3)) + (255,)]
                    else:
                        pal = [a, b, tuple((a[k] + b[k]) // 2 for k in range(3)) + (255,),
                               (0, 0, 0, 0)]
                    ox = bx * 8 + (sub & 1) * 4
                    oy = by * 8 + (sub >> 1) * 4
                    for py in range(4):
                        for px in range(4):
                            idx = (bits >> (30 - 2 * (py * 4 + px))) & 3
                            put(ox + px, oy + py, pal[idx])
        return out

    for by in range(by_n):
        for bx in range(bx_n):
            if fmt == 0x6:  # RGBA8: AR plane then GB plane
                for i in range(16):
                    a_, r_ = data[p + 2 * i], data[p + 2 * i + 1]
                    g_, b_ = data[p + 32 + 2 * i], data[p + 33 + 2 * i]
                    put(bx * 4 + (i & 3), by * 4 + (i >> 2), (r_, g_, b_, a_))
                p += 64
                continue
            for py in range(bh):
                for px in range(bw):
                    x, y = bx * bw + px, by * bh + py
                    if bpp == 8:
                        v = data[p]
                        p += 1
                    else:
                        v = (data[p] << 8) | data[p + 1]
                        p += 2
                    if fmt == 0x0:
                        i = _x4(v)
                        c = (i, i, i, i)
                    elif fmt == 0x1:
                        c = (v, v, v, v)
                    elif fmt == 0x2:
                        i = _x4(v & 0xF)
                        c = (i, i, i, _x4(v >> 4))
                    elif fmt == 0x3:
                        c = ia8(v)
                    elif fmt == 0x4:
                        c = rgb565(v)
                    elif fmt == 0x5:
                        c = rgb5a3(v)
                    elif fmt in (0x8, 0x9, 0xA):
                        idx = v & 0x3FFF
                        c = palette[idx] if palette and idx < len(palette) else (255, 0, 255, 255)
                    else:
                        raise ValueError("format %d" % fmt)
                    put(x, y, c)
    return out


def _decode_4bpp(data, off, fmt, w, h, palette):
    out = bytearray(w * h * 4)
    bx_n, by_n = (w + 7) // 8, (h + 7) // 8
    p = off
    for by in range(by_n):
        for bx in range(bx_n):
            for py in range(8):
                for pxb in range(4):
                    byte = data[p]
                    p += 1
                    for half, v in ((0, byte >> 4), (1, byte & 0xF)):
                        x, y = bx * 8 + pxb * 2 + half, by * 8 + py
                        if x >= w or y >= h:
                            continue
                        if fmt == 0x0:
                            i = _x4(v)
                            c = (i, i, i, i)
                        else:
                            c = palette[v] if palette and v < len(palette) else (255, 0, 255, 255)
                        i4 = (y * w + x) * 4
                        out[i4:i4 + 4] = bytes(c)
    return out


def decode_image(data, off, fmt, w, h, palette=None):
    return decode(data, off, fmt, w, h, palette)


def decode_mips(data, off, fmt, w, h, count, palette=None):
    """Decode `count` levels (base + mips). Returns list of (w, h, rgba)."""
    levels = []
    for _ in range(max(1, count)):
        levels.append((w, h, decode_image(data, off, fmt, w, h, palette)))
        off += image_size(fmt, w, h)
        w, h = max(1, w // 2), max(1, h // 2)
    return levels


# ---------------------------------------------------------------- PNG

def _chunk(tag, payload):
    c = struct.pack(">I", len(payload)) + tag + payload
    return c + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)


def png_rgba(w, h, rgba):
    """Encode RGBA8 pixels as PNG (colour type 6, filter 0 rows)."""
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b""))


def has_alpha(rgba):
    return any(rgba[i] != 255 for i in range(3, len(rgba), 4))


def alpha_kind(rgba):
    """'opaque', 'binary' (only 0/255) or 'blend'."""
    vals = set(rgba[3::4])
    if vals <= {255}:
        return "opaque"
    if vals <= {0, 255}:
        return "binary"
    return "blend"
