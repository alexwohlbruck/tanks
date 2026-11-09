"""TPL (GX texture palette) container -> list of decoded images."""
import struct

from gx import decode, decode_palette, NAMES, PALETTE_NAMES

WRAP = {0: "clamp", 1: "repeat", 2: "mirror"}
FILTER = {0: "near", 1: "linear", 2: "near_mip_near", 3: "lin_mip_near",
          4: "near_mip_lin", 5: "lin_mip_lin"}


def read_tpl(data):
    magic, count, table = struct.unpack_from(">III", data, 0)
    if magic != 0x0020AF30:
        raise ValueError("not a TPL")
    images = []
    for i in range(count):
        img_off, pal_off = struct.unpack_from(">II", data, table + 8 * i)
        h, w, fmt, doff, ws, wt, minf, magf = struct.unpack_from(">HHIIIIII", data, img_off)
        lod_bias, = struct.unpack_from(">f", data, img_off + 0x20)
        edge_lod, min_lod, max_lod = struct.unpack_from(">BBB", data, img_off + 0x24)
        palette = None
        info = {"width": w, "height": h, "format": NAMES.get(fmt, fmt),
                "wrapS": WRAP.get(ws, ws), "wrapT": WRAP.get(wt, wt),
                "minFilter": FILTER.get(minf, minf), "magFilter": FILTER.get(magf, magf),
                "lodBias": lod_bias, "minLod": min_lod, "maxLod": max_lod}
        if pal_off:
            n, _unp, pfmt, poff = struct.unpack_from(">HBxII", data, pal_off)
            palette = decode_palette(data, poff, n, pfmt)
            info["palette"] = {"format": PALETTE_NAMES.get(pfmt, pfmt), "count": n}
        rgba = decode(data, doff, w, h, fmt, palette)
        images.append((info, rgba))
    return images
