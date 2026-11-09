"""GX display-list interpretation: register writes (BP/CP/XF), primitive
streams, and decoding of TEV / pixel-engine / texgen / lighting-channel state.
"""
from binutil import u16, u32


class Regs:
    def __init__(self):
        self.bp = {}
        self.cp = {}
        self.xf = {}
        self.bp_log = []  # ordered (reg, value) – TEV colour regs share addresses


def run_dl(d, o, size):
    """Execute register-setting commands of a display list; stops at a draw."""
    r = Regs()
    end = o + size
    mask = 0xFFFFFF
    while o < end:
        op = d[o]
        if op == 0x00:
            o += 1
        elif op == 0x08:
            r.cp[d[o + 1]] = u32(d, o + 2)
            o += 6
        elif op == 0x10:
            n = u16(d, o + 1) + 1
            addr = u16(d, o + 3)
            for i in range(n):
                r.xf[addr + i] = u32(d, o + 5 + 4 * i)
            o += 5 + 4 * n
        elif op == 0x61:
            v = u32(d, o + 1)
            reg, val = v >> 24, v & 0xFFFFFF
            if reg == 0xFE:
                mask = val
            else:
                old = r.bp.get(reg, 0)
                val = (old & ~mask & 0xFFFFFF) | (val & mask)
                r.bp[reg] = val
                r.bp_log.append((reg, val))
                mask = 0xFFFFFF
            o += 5
        elif op in (0x20, 0x28, 0x30, 0x38):
            o += 5
        else:
            break
    return r


# ------------------------------------------------------------------ vertex descriptors

ATTR_NAMES = (["pnmtx"] + ["tex%dmtx" % i for i in range(8)] + ["pos", "nrm", "clr0", "clr1"]
              + ["tex%d" % i for i in range(8)])
VCD_KIND = {0: "none", 1: "direct", 2: "index8", 3: "index16"}


def decode_vcd(lo, hi):
    v = {}
    v["pnmtx"] = "direct" if lo & 1 else "none"
    for i in range(8):
        v["tex%dmtx" % i] = "direct" if lo & (2 << i) else "none"
    v["pos"] = VCD_KIND[(lo >> 9) & 3]
    v["nrm"] = VCD_KIND[(lo >> 11) & 3]
    v["clr0"] = VCD_KIND[(lo >> 13) & 3]
    v["clr1"] = VCD_KIND[(lo >> 15) & 3]
    for i in range(8):
        v["tex%d" % i] = VCD_KIND[(hi >> (2 * i)) & 3]
    return v


PRIM = {0x80: "quads", 0x88: "quads2", 0x90: "triangles", 0x98: "tristrip", 0xA0: "trifan",
        0xA8: "lines", 0xB0: "linestrip", 0xB8: "points"}


def parse_primitives(d, o, size, vcd):
    """Return list of {type, verts:[{attr: index}], pos_slots:{slot: mtxid}}."""
    end = o + size
    prims = []
    slots = {}
    order = [a for a in ATTR_NAMES if vcd[a] != "none"]
    for a in order:
        if vcd[a] == "direct" and not (a == "pnmtx" or a.endswith("mtx")):
            raise NotImplementedError("direct vertex attribute %s" % a)
    while o < end:
        op = d[o]
        if op == 0x00:
            o += 1
            continue
        if op in (0x20, 0x28, 0x30, 0x38):
            idx = u16(d, o + 1)
            w = u16(d, o + 3)
            addr = w & 0xFFF
            if op == 0x20:
                slots[addr // 12] = idx
            o += 5
            continue
        if op == 0x08:
            o += 6
            continue
        if op == 0x10:
            o += 5 + 4 * (u16(d, o + 1) + 1)
            continue
        if op == 0x61:
            o += 5
            continue
        kind = PRIM.get(op & 0xF8)
        if kind is None:
            break
        n = u16(d, o + 1)
        o += 3
        verts = []
        for _ in range(n):
            vtx = {}
            for a in order:
                k = vcd[a]
                if k == "direct" or k == "index8":
                    vtx[a] = d[o]
                    o += 1
                else:
                    vtx[a] = u16(d, o)
                    o += 2
            verts.append(vtx)
        prims.append({"type": kind, "vat": op & 7, "verts": verts, "pos_slots": dict(slots)})
    return prims


def triangulate(prim):
    """Yield index triples in GX winding order (clockwise-front)."""
    t, n = prim["type"], len(prim["verts"])
    if t == "triangles":
        for i in range(0, n - 2, 3):
            yield (i, i + 1, i + 2)
    elif t == "tristrip":
        for i in range(n - 2):
            yield (i, i + 1, i + 2) if i % 2 == 0 else (i + 1, i, i + 2)
    elif t == "trifan":
        for i in range(1, n - 1):
            yield (0, i, i + 1)
    elif t in ("quads", "quads2"):
        for i in range(0, n - 3, 4):
            yield (i, i + 1, i + 2)
            yield (i, i + 2, i + 3)


# ------------------------------------------------------------------ lighting channels

def decode_chan_ctrl(v):
    mask = ((v >> 2) & 0xF) | (((v >> 11) & 0xF) << 4)
    return {
        "raw": "%08x" % v,
        "mat_src": "vertex" if v & 1 else "register",
        "lighting": bool(v & 2),
        "light_mask": "%02x" % mask,
        "amb_src": "vertex" if v & 0x40 else "register",
        "diffuse_fn": {0: "none", 1: "sign", 2: "clamp"}.get((v >> 7) & 3, "?"),
        "attn_fn": ("spot" if v & 0x400 else "spec") if v & 0x200 else "none",
    }


# ------------------------------------------------------------------ pixel engine

COMPARE = ["never", "less", "equal", "lequal", "greater", "nequal", "gequal", "always"]
ALOGIC = ["and", "or", "xor", "xnor"]
BLEND_SRC = ["zero", "one", "dst_color", "inv_dst_color", "src_alpha", "inv_src_alpha",
             "dst_alpha", "inv_dst_alpha"]
BLEND_DST = ["zero", "one", "src_color", "inv_src_color", "src_alpha", "inv_src_alpha",
             "dst_alpha", "inv_dst_alpha"]
LOGIC_OPS = ["clear", "and", "rev_and", "copy", "inv_and", "noop", "xor", "or", "nor", "equiv",
             "inv", "rev_or", "inv_copy", "inv_or", "nand", "set"]


def decode_pe(r):
    pe = {}
    ac = r.bp.get(0xF3)
    if ac is not None:
        pe["alpha_test"] = {"ref0": ac & 0xFF, "ref1": (ac >> 8) & 0xFF,
                            "comp0": COMPARE[(ac >> 16) & 7], "comp1": COMPARE[(ac >> 19) & 7],
                            "op": ALOGIC[(ac >> 22) & 3]}
    z = r.bp.get(0x40)
    if z is not None:
        pe["z"] = {"test": bool(z & 1), "func": COMPARE[(z >> 1) & 7], "write": bool(z & 0x10)}
    b = r.bp.get(0x41)
    if b is not None:
        pe["blend"] = {"enable": bool(b & 1), "logic_enable": bool(b & 2),
                       "subtract": bool(b & 0x800),
                       "src": BLEND_SRC[(b >> 8) & 7], "dst": BLEND_DST[(b >> 5) & 7],
                       "logic_op": LOGIC_OPS[(b >> 12) & 0xF]}
    c1 = r.bp.get(0x42)
    if c1 is not None:
        pe["const_alpha"] = {"enable": bool(c1 & 0x100), "value": c1 & 0xFF}
    return pe


# ------------------------------------------------------------------ TEV

CC = ["CPREV", "APREV", "C0", "A0", "C1", "A1", "C2", "A2", "TEXC", "TEXA", "RASC", "RASA",
      "ONE", "HALF", "KONST", "ZERO"]
CA = ["APREV", "A0", "A1", "A2", "TEXA", "RASA", "KONST", "ZERO"]
BIAS = ["0", "+0.5", "-0.5", "compare"]
SCALE = ["1", "2", "4", "0.5"]
DEST = ["PREV", "REG0", "REG1", "REG2"]
CHANNEL = {0: "COLOR0A0", 1: "COLOR1A1", 5: "ALPHA_BUMP", 6: "ALPHA_BUMPN", 7: "ZERO"}
KCSEL = {0: "1", 1: "7/8", 2: "3/4", 3: "5/8", 4: "1/2", 5: "3/8", 6: "1/4", 7: "1/8"}
for _i in range(4):
    KCSEL[12 + _i] = "K%d" % _i
    KCSEL[16 + _i] = "K%d_R" % _i
    KCSEL[20 + _i] = "K%d_G" % _i
    KCSEL[24 + _i] = "K%d_B" % _i
    KCSEL[28 + _i] = "K%d_A" % _i
KASEL = {k: v for k, v in KCSEL.items() if k < 8 or k >= 16}


def _expr(a, b, c, d, op_sub, bias, scale, zero, one):
    """Human-readable form of  d (+|-) lerp(a, b, c)  with bias/scale."""
    if c == zero:
        lerp = a
    elif c == one:
        lerp = b
    elif a == zero:
        lerp = zero if b == zero else ("%s*%s" % (b, c))
    else:
        lerp = "lerp(%s,%s,%s)" % (a, b, c)
    if lerp == zero:
        e = d
    elif d == zero:
        e = ("-" + lerp) if op_sub else lerp
    else:
        e = "%s %s %s" % (d, "-" if op_sub else "+", lerp)
    if bias not in ("0", "compare"):
        e = "(%s)%s" % (e, bias)
    if scale != "1":
        e = "(%s)*%s" % (e, scale)
    return e


def decode_tev(r, nstages):
    stages = []
    swaps = []
    for i in range(4):
        lo = r.bp.get(0xF6 + 2 * i, 0)
        hi = r.bp.get(0xF7 + 2 * i, 0)
        swaps.append("RGBA"[lo & 3] + "RGBA"[(lo >> 2) & 3] + "RGBA"[hi & 3] + "RGBA"[(hi >> 2) & 3])
    for s in range(nstages):
        tref = r.bp.get(0x28 + s // 2, 0)
        sh = 12 if s & 1 else 0
        tmap, tcoord, ten, chan = (tref >> sh) & 7, (tref >> (sh + 3)) & 7, (tref >> (sh + 6)) & 1, (tref >> (sh + 7)) & 7
        ksel = r.bp.get(0xF6 + s // 2, 0)
        ks = 14 if s & 1 else 4
        kc, ka = (ksel >> ks) & 0x1F, (ksel >> (ks + 5)) & 0x1F
        ce = r.bp.get(0xC0 + 2 * s, 0)
        ae = r.bp.get(0xC1 + 2 * s, 0)
        ci = [CC[(ce >> sh_) & 0xF] for sh_ in (12, 8, 4, 0)]  # a b c d
        ai = [CA[(ae >> sh_) & 7] for sh_ in (13, 10, 7, 4)]
        cbias, cscale = (ce >> 16) & 3, (ce >> 20) & 3
        abias, ascale = (ae >> 16) & 3, (ae >> 20) & 3
        st = {
            "stage": s,
            "texmap": tmap if ten else None, "texcoord": tcoord if ten else None,
            "raster": CHANNEL.get(chan, chan),
            "konst_color_sel": KCSEL.get(kc, kc), "konst_alpha_sel": KASEL.get(ka, ka),
            "color": {"a": ci[0], "b": ci[1], "c": ci[2], "d": ci[3],
                      "op": "sub" if ce & 0x40000 else "add", "bias": BIAS[cbias],
                      "scale": SCALE[cscale], "clamp": bool(ce & 0x80000),
                      "dest": DEST[(ce >> 22) & 3]},
            "alpha": {"a": ai[0], "b": ai[1], "c": ai[2], "d": ai[3],
                      "op": "sub" if ae & 0x40000 else "add", "bias": BIAS[abias],
                      "scale": SCALE[ascale], "clamp": bool(ae & 0x80000),
                      "dest": DEST[(ae >> 22) & 3],
                      "ras_swap": ae & 3, "tex_swap": (ae >> 2) & 3},
        }
        st["color"]["expr"] = "%s = %s" % (st["color"]["dest"], _expr(
            ci[0], ci[1], ci[2], ci[3], ce & 0x40000, BIAS[cbias], SCALE[cscale], "ZERO", "ONE"))
        st["alpha"]["expr"] = "%s = %s" % (st["alpha"]["dest"], _expr(
            ai[0], ai[1], ai[2], ai[3], ae & 0x40000, BIAS[abias], SCALE[ascale], "ZERO", "ONE"))
        stages.append(st)
    return {"stages": stages, "swap_tables": swaps}


def _s11(v):
    v &= 0x7FF
    return v - 0x800 if v & 0x400 else v


def decode_tev_colors(r):
    color = {}
    konst = {}
    for reg, val in r.bp_log:
        if not 0xE0 <= reg <= 0xE7:
            continue
        idx = (reg - 0xE0) // 2
        is_k = bool(val & 0x800000)
        tgt = konst if is_k else color
        c = tgt.setdefault(idx, [0, 0, 0, 0])
        lo_, hi_ = (val & 0x7FF), ((val >> 12) & 0x7FF)
        if not is_k:
            lo_, hi_ = _s11(lo_), _s11(hi_)
        if reg & 1 == 0:
            c[0], c[3] = lo_, hi_
        else:
            c[2], c[1] = lo_, hi_
    names = {0: "PREV", 1: "C0", 2: "C1", 3: "C2"}
    return {"registers": {names[k]: v for k, v in sorted(color.items())},
            "konst": {"K%d" % k: v for k, v in sorted(konst.items())}}


# ------------------------------------------------------------------ texgens (XF)

TG_SRC = {0: "position", 1: "normal", 2: "colors", 3: "binormal_t", 4: "binormal_b"}
for _i in range(8):
    TG_SRC[5 + _i] = "tex%d" % _i
TG_TYPE = {0: "regular", 1: "emboss", 2: "color0", 3: "color1"}


def decode_texgens(r, n):
    out = []
    for i in range(n):
        v = r.xf.get(0x1040 + i)
        p = r.xf.get(0x1050 + i)
        if v is None:
            out.append(None)
            continue
        out.append({"projection": "stq" if v & 2 else "st",
                    "input_form": "abc1" if v & 4 else "ab11",
                    "type": TG_TYPE.get((v >> 4) & 7, (v >> 4) & 7),
                    "source": TG_SRC.get((v >> 7) & 0x1F, (v >> 7) & 0x1F),
                    "emboss_source": (v >> 12) & 7, "emboss_light": (v >> 15) & 7,
                    "post_normalize": bool(p & 0x100) if p is not None else None,
                    "post_mtx": (p & 0x3F) if p is not None else None})
    return out
