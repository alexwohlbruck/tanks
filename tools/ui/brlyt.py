"""BRLYT (NW4R layout, version 8 as used by this game) -> JSON-able dict."""
import struct

from tpl import WRAP

ORIGINS = ["top-left", "top-center", "top-right",
           "center-left", "center", "center-right",
           "bottom-left", "bottom-center", "bottom-right"]

TEXGEN_TYPE = {0: "mtx3x4", 1: "mtx2x4", 10: "srtg"}
BLEND_TYPE = {0: "none", 1: "blend", 2: "logic", 3: "subtract"}
BLEND_FACTOR = {0: "zero", 1: "one", 2: "srcclr", 3: "invsrcclr", 4: "srcalpha",
                5: "invsrcalpha", 6: "dstalpha", 7: "invdstalpha"}
COMPARE = {0: "never", 1: "less", 2: "equal", 3: "lequal", 4: "greater",
           5: "nequal", 6: "gequal", 7: "always"}
ALPHA_OP = {0: "and", 1: "or", 2: "xor", 3: "xnor"}
TEXFLIP = {0: "none", 1: "h", 2: "v", 3: "rot90", 4: "rot180", 5: "rot270"}


def cstr(b):
    return b.split(b"\0", 1)[0].decode("ascii", "replace")


def f32s(data, off, n):
    return list(struct.unpack_from(">%df" % n, data, off))


def rgba32(data, off):
    return list(data[off:off + 4])


def _round(v):
    if isinstance(v, float):
        r = round(v, 6)
        return int(r) if r == int(r) and abs(r) < 1e15 else r
    if isinstance(v, list):
        return [_round(x) for x in v]
    if isinstance(v, dict):
        return {k: _round(x) for k, x in v.items()}
    return v


def read_name_table(data, off):
    """txl1/fnl1 body: u16 count, u16 pad, {u32 nameOff, u32 pad}[] (rel. to table)."""
    n, = struct.unpack_from(">H", data, off)
    base = off + 4
    names = []
    for i in range(n):
        no, = struct.unpack_from(">I", data, base + 8 * i)
        end = data.index(b"\0", base + no)
        names.append(data[base + no:end].decode("ascii"))
    return names


def parse_material(data, off):
    m = {"name": cstr(data[off:off + 20])}
    o = off + 20
    c = struct.unpack_from(">12h", data, o)
    o += 24
    m["tevColors"] = [list(c[0:4]), list(c[4:8]), list(c[8:12])]  # C0(black) C1(white) C2
    m["konstColors"] = [rgba32(data, o + 4 * k) for k in range(4)]
    o += 16
    flags, = struct.unpack_from(">I", data, o)
    o += 4
    m["flags"] = "0x%08x" % flags
    n_tex = flags & 0xF
    n_srt = (flags >> 4) & 0xF
    n_gen = (flags >> 8) & 0xF
    has_swap = (flags >> 12) & 1
    n_ind_srt = (flags >> 13) & 3
    n_ind_stage = (flags >> 15) & 7
    n_tev = (flags >> 18) & 0x1F
    has_acmp = (flags >> 23) & 1
    has_blend = (flags >> 24) & 1
    n_chan = (flags >> 25) & 1
    n_matcol = (flags >> 27) & 1

    m["texMaps"] = []
    for _ in range(n_tex):
        idx, ws, wt = struct.unpack_from(">HBB", data, o)
        o += 4
        m["texMaps"].append({"texture": idx, "wrapS": WRAP.get(ws & 3, ws & 3),
                             "wrapT": WRAP.get(wt & 3, wt & 3),
                             "minFilter": ws >> 2, "magFilter": wt >> 2})
    m["texSRT"] = []
    for _ in range(n_srt):
        tx, ty, r, sx, sy = f32s(data, o, 5)
        o += 20
        m["texSRT"].append({"translate": [tx, ty], "rotate": r, "scale": [sx, sy]})
    m["texCoordGens"] = []
    for _ in range(n_gen):
        t, s, mtx = struct.unpack_from(">BBB", data, o)
        o += 4
        m["texCoordGens"].append({"type": TEXGEN_TYPE.get(t, t), "src": s, "mtx": mtx})
    if n_chan:
        cs, as_ = struct.unpack_from(">BB", data, o)
        o += 4
        m["chanCtrl"] = {"colorSrc": "vtx" if cs else "reg", "alphaSrc": "vtx" if as_ else "reg"}
    m["materialColor"] = [255, 255, 255, 255]
    if n_matcol:
        m["materialColor"] = rgba32(data, o)
        o += 4
    if has_swap:
        tbl = []
        for k in range(4):
            b = data[o + k]
            tbl.append([b & 3, (b >> 2) & 3, (b >> 4) & 3, (b >> 6) & 3])
        m["tevSwapTable"] = tbl
        o += 4
    if n_ind_srt:
        m["indTexSRT"] = []
        for _ in range(n_ind_srt):
            tx, ty, r, sx, sy = f32s(data, o, 5)
            o += 20
            m["indTexSRT"].append({"translate": [tx, ty], "rotate": r, "scale": [sx, sy]})
    if n_ind_stage:
        m["indTexStages"] = []
        for _ in range(n_ind_stage):
            gen, tmap, ss, st = struct.unpack_from(">BBBB", data, o)
            o += 4
            m["indTexStages"].append({"texCoordGen": gen, "texMap": tmap, "scaleS": ss, "scaleT": st})
    if n_tev:
        m["tevStages"] = []
        for _ in range(n_tev):
            b = data[o:o + 16]
            o += 16
            m["tevStages"].append(_tev_stage(b))
    if has_acmp:
        comp, op, r0, r1 = struct.unpack_from(">BBBB", data, o)
        o += 4
        m["alphaCompare"] = {"comp0": COMPARE[comp & 7], "ref0": r0, "op": ALPHA_OP.get(op, op),
                             "comp1": COMPARE[(comp >> 4) & 7], "ref1": r1}
    if has_blend:
        t, s, d, lop = struct.unpack_from(">BBBB", data, o)
        o += 4
        m["blendMode"] = {"type": BLEND_TYPE.get(t, t), "src": BLEND_FACTOR.get(s, s),
                          "dst": BLEND_FACTOR.get(d, d), "logicOp": lop}
    return m


TEV_CARG = ["cprev", "aprev", "c0", "a0", "c1", "a1", "c2", "a2", "texc", "texa",
            "rasc", "rasa", "one", "half", "konst", "zero"]
TEV_AARG = ["aprev", "a0", "a1", "a2", "texa", "rasa", "konst", "zero"]


def _tev_stage(b):
    """nw4r::lyt::res::TevStage (16 bytes)."""
    def inop(ab, cd, op, cl, args):
        def arg(v):
            return args[v] if v < len(args) else v
        return {"a": arg(ab & 0xF), "b": arg(ab >> 4), "c": arg(cd & 0xF), "d": arg(cd >> 4),
                "op": op & 0xF, "bias": (op >> 4) & 3, "scale": (op >> 6) & 3,
                "clamp": cl & 1, "outReg": (cl >> 1) & 3, "konstSel": cl >> 3}
    return {"texCoord": b[0], "colorChan": b[1], "texMap": b[2] | ((b[3] & 1) << 8),
            "rasSwap": (b[3] >> 1) & 3, "texSwap": (b[3] >> 3) & 3,
            "color": inop(b[4], b[5], b[6], b[7], TEV_CARG),
            "alpha": inop(b[8], b[9], b[10], b[11], TEV_AARG),
            "ind": {"stage": b[12], "biasMtx": b[13], "wrap": b[14], "foAdUtAl": b[15]}}


def parse_pane(data, off):
    flags, origin, alpha = struct.unpack_from(">BBB", data, off + 8)
    name = cstr(data[off + 12:off + 28])
    user = cstr(data[off + 28:off + 36])
    v = f32s(data, off + 36, 10)
    p = {"name": name, "visible": bool(flags & 1), "influencedAlpha": bool(flags & 2),
         "locationAdjust": bool(flags & 4), "origin": origin, "originName": ORIGINS[origin] if origin < 9 else origin,
         "alpha": alpha, "translate": v[0:3], "rotate": v[3:6], "scale": v[6:8], "size": v[8:10]}
    if user:
        p["userData"] = user
    return p, off + 0x4C


def parse_texcoords(data, o, n):
    tcs = []
    for _ in range(n):
        f = f32s(data, o, 8)
        tcs.append([f[0:2], f[2:4], f[4:6], f[6:8]])  # TL TR BL BR
        o += 32
    return tcs, o


def read_brlyt(data):
    assert data[:4] == b"RLYT", "not a BRLYT"
    version, = struct.unpack_from(">H", data, 6)
    hsize, nsec = struct.unpack_from(">HH", data, 12)
    out = {"version": version, "textures": [], "fonts": [], "materials": []}
    root = None
    stack = []
    last = None
    groups_root = None
    gstack = []
    glast = None
    o = hsize
    for _ in range(nsec):
        magic = data[o:o + 4].decode("ascii")
        size, = struct.unpack_from(">I", data, o + 4)
        if magic == "lyt1":
            center, = struct.unpack_from(">B", data, o + 8)
            w, h = f32s(data, o + 12, 2)
            out["layout"] = {"drawFromCenter": bool(center), "width": w, "height": h}
        elif magic == "txl1":
            out["textures"] = read_name_table(data, o + 8)
        elif magic == "fnl1":
            out["fonts"] = read_name_table(data, o + 8)
        elif magic == "mat1":
            n, = struct.unpack_from(">H", data, o + 8)
            for i in range(n):
                mo, = struct.unpack_from(">I", data, o + 12 + 4 * i)
                out["materials"].append(parse_material(data, o + mo))
        elif magic in ("pan1", "pic1", "txt1", "wnd1", "bnd1"):
            p, po = parse_pane(data, o)
            p = {"type": magic[:3], **p}
            if magic == "pic1":
                p["vertexColors"] = [rgba32(data, po + 4 * k) for k in range(4)]
                mat, ntc = struct.unpack_from(">HB", data, po + 16)
                p["material"] = mat
                p["texCoords"], _ = parse_texcoords(data, po + 20, ntc)
            elif magic == "txt1":
                buf, slen, mat, font, tpos, talign = struct.unpack_from(">HHHHBB", data, po)
                soff, = struct.unpack_from(">I", data, po + 12)
                top = rgba32(data, po + 16)
                bot = rgba32(data, po + 20)
                fsx, fsy, csp, lsp = f32s(data, po + 24, 4)
                s = data[o + soff:o + soff + slen].decode("utf-16-be").rstrip("\0")
                p.update({"material": mat, "font": font, "textBufBytes": buf, "textStrBytes": slen,
                          "textPosition": tpos, "textPositionName": ORIGINS[tpos] if tpos < 9 else tpos,
                          "textAlignment": talign, "text": s, "topColor": top, "bottomColor": bot,
                          "fontSize": [fsx, fsy], "charSpace": csp, "lineSpace": lsp})
            elif magic == "wnd1":
                l, r, t, b = f32s(data, po, 4)
                nframe, = struct.unpack_from(">B", data, po + 16)
                coff, ftoff = struct.unpack_from(">II", data, po + 20)
                c = o + coff
                content = {"vertexColors": [rgba32(data, c + 4 * k) for k in range(4)]}
                mat, ntc = struct.unpack_from(">HB", data, c + 16)
                content["material"] = mat
                content["texCoords"], _ = parse_texcoords(data, c + 20, ntc)
                frames = []
                for k in range(nframe):
                    fo, = struct.unpack_from(">I", data, o + ftoff + 4 * k)
                    fm, flip = struct.unpack_from(">HB", data, o + fo)
                    frames.append({"material": fm, "flip": TEXFLIP.get(flip, flip)})
                p.update({"inflation": {"l": l, "r": r, "t": t, "b": b},
                          "content": content, "frames": frames})
            p["children"] = []
            if stack:
                stack[-1]["children"].append(p)
            else:
                root = p
            last = p
        elif magic == "pas1":
            stack.append(last)
        elif magic == "pae1":
            stack.pop()
        elif magic == "grp1":
            name = cstr(data[o + 8:o + 24])
            n, = struct.unpack_from(">H", data, o + 24)
            panes = [cstr(data[o + 28 + 16 * k:o + 44 + 16 * k]) for k in range(n)]
            g = {"name": name, "panes": panes, "children": []}
            if gstack:
                gstack[-1]["children"].append(g)
            else:
                groups_root = g
            glast = g
        elif magic == "grs1":
            gstack.append(glast)
        elif magic == "gre1":
            gstack.pop()
        else:
            out.setdefault("unknownSections", []).append(magic)
        o += size
    out["root"] = root
    out["groups"] = groups_root
    return _round(out)
