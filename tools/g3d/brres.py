"""NW4R BRRES container + sub-file parsers (MDL0 v8, TEX0 v1, PLT0, SRT0 v4,
CLR0 v3, PAT0 v3, VIS0, CHR0, SCN0 v4).

Everything returns plain dicts/lists so the result can be dumped to JSON.
Offsets are absolute into the BRRES byte string unless noted.
"""
from binutil import u8, s8, u16, s16, u32, s32, f32, vec, cstr, rel_str
import gxtex


# ------------------------------------------------------------------ groups

def index_group(d, off):
    """Parse an NW4R 'ResDic' patricia index group. Returns [(name, abs_off)]."""
    if off <= 0:
        return []
    _total, count = u32(d, off), u32(d, off + 4)
    out = []
    for i in range(1, count + 1):
        e = off + 8 + i * 16
        name_off, data_off = u32(d, e + 8), u32(d, e + 12)
        name = cstr(d, off + name_off) if name_off else None
        out.append((name, off + data_off))
    return out


class Brres:
    def __init__(self, data, name="?"):
        self.d = data
        self.name = name
        assert data[:4] == b"bres", "not a BRRES"
        root = u16(data, 0x0C)
        assert data[root:root + 4] == b"root"
        self.folders = {}
        for fname, foff in index_group(data, root + 8):
            self.folders[fname] = index_group(data, foff)

    def items(self, folder):
        return self.folders.get(folder, [])

    def palettes(self):
        return {n: parse_plt0(self.d, o) for n, o in self.items("Palettes(NW4R)")}


# ------------------------------------------------------------------ TEX0/PLT0

def parse_plt0(d, o):
    assert d[o:o + 4] == b"PLT0"
    data_off = s32(d, o + 0x10)
    fmt = u32(d, o + 0x18)
    count = u16(d, o + 0x1C)
    return {"format": gxtex.PAL_NAMES.get(fmt, fmt), "format_id": fmt, "count": count,
            "colors": gxtex.decode_palette(d, o + data_off, fmt, count)}


def parse_tex0(d, o, palette=None, decode=True):
    assert d[o:o + 4] == b"TEX0"
    ver = u32(d, o + 8)
    data_off = s32(d, o + 0x10)
    flags = u32(d, o + 0x18)
    w, h = u16(d, o + 0x1C), u16(d, o + 0x1E)
    fmt = u32(d, o + 0x20)
    nimg = u32(d, o + 0x24)
    min_lod, max_lod = f32(d, o + 0x28), f32(d, o + 0x2C)
    t = {"version": ver, "width": w, "height": h, "format": gxtex.FMT_NAMES.get(fmt, fmt),
         "format_id": fmt, "levels": nimg, "min_lod": min_lod, "max_lod": max_lod,
         "is_ci": bool(flags & 1)}
    if decode:
        pal = palette["colors"] if palette else None
        t["images"] = gxtex.decode_mips(d, o + data_off, fmt, w, h, nimg, pal)
    return t


# ------------------------------------------------------------------ GX enums

WRAP = {0: "clamp", 1: "repeat", 2: "mirror"}
FILTER = {0: "nearest", 1: "linear", 2: "nearest_mip_nearest", 3: "linear_mip_nearest",
          4: "nearest_mip_linear", 5: "linear_mip_linear"}
CULL = {0: "none", 1: "front", 2: "back", 3: "all"}
BILLBOARD = {0: "none", 1: "standard", 2: "standard_persp", 3: "rotation",
             4: "rotation_persp", 5: "y", 6: "y_persp"}
COMP_FMT = {0: "u8", 1: "s8", 2: "u16", 3: "s16", 4: "f32"}
COMP_SIZE = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4}
CLR_FMT = {0: "RGB565", 1: "RGB8", 2: "RGBX8", 3: "RGBA4", 4: "RGBA6", 5: "RGBA8"}
CLR_SIZE = {0: 2, 1: 3, 2: 4, 3: 2, 4: 3, 5: 4}
MAP_MODE = {0: "texcoord", 1: "env_camera", 2: "projection", 3: "env_light", 4: "env_spec"}
TEXMTX_MODE = {0: "maya", 1: "xsi", 2: "3dsmax"}
SCALING_RULE = {0: "standard", 1: "softimage", 2: "maya"}


def _read_comp(d, o, fmt, shift):
    if fmt == 4:
        return f32(d, o)
    v = {0: u8, 1: s8, 2: u16, 3: s16}[fmt](d, o)
    return v / float(1 << shift)


def read_color(d, o, fmt):
    if fmt == 0:
        return list(gxtex.rgb565(u16(d, o)))
    if fmt == 1:
        return [d[o], d[o + 1], d[o + 2], 255]
    if fmt == 2:
        return [d[o], d[o + 1], d[o + 2], 255]
    if fmt == 3:
        v = u16(d, o)
        return [((v >> s) & 0xF) * 17 for s in (12, 8, 4, 0)]
    if fmt == 4:
        v = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]
        return [(((v >> s) & 0x3F) * 255 + 31) // 63 for s in (18, 12, 6, 0)]
    return [d[o], d[o + 1], d[o + 2], d[o + 3]]


# ------------------------------------------------------------------ MDL0

MDL0_SECTIONS_V8 = ["defs", "bones", "positions", "normals", "colors", "uvs",
                    "materials", "shaders", "objects", "textures", "palettes"]


def parse_mdl0(d, o):
    import gxdl
    assert d[o:o + 4] == b"MDL0"
    ver = u32(d, o + 8)
    if ver not in (8, 9):
        raise NotImplementedError("MDL0 v%d" % ver)
    sec = {}
    for i, n in enumerate(MDL0_SECTIONS_V8):
        so = s32(d, o + 0x10 + 4 * i)
        sec[n] = index_group(d, o + so) if so else []
    nsec = len(MDL0_SECTIONS_V8)
    name = rel_str(d, o, s32(d, o + 0x10 + 4 * nsec))
    info = o + 0x10 + 4 * nsec + 4
    m = {"name": name, "version": ver}
    m["info"] = {
        "scaling_rule": SCALING_RULE.get(u32(d, info + 0x08)),
        "texmtx_mode": TEXMTX_MODE.get(u32(d, info + 0x0C)),
        "vertex_count": u32(d, info + 0x10),
        "face_count": u32(d, info + 0x14),
        "node_count": u32(d, info + 0x1C),
        "need_nrm_mtx_array": d[info + 0x20], "need_tex_mtx_array": d[info + 0x21],
        "is_valid_volume": d[info + 0x22], "envelope_mtx_mode": d[info + 0x23],
    }
    bt = info + s32(d, info + 0x24)
    nmtx = u32(d, bt)
    m["mtx_to_node"] = [s32(d, bt + 4 + 4 * i) for i in range(nmtx)]

    # ---- bones
    bones = []
    off2idx = {}
    for bname, bo in sec["bones"]:
        b = {
            "name": rel_str(d, bo, s32(d, bo + 0x08)),
            "index": u32(d, bo + 0x0C), "mtx_id": u32(d, bo + 0x10),
            "flags": u32(d, bo + 0x14),
            "billboard": BILLBOARD.get(u32(d, bo + 0x18), u32(d, bo + 0x18)),
            "billboard_ref": s32(d, bo + 0x1C),
            "scale": vec(d, bo + 0x20, 3), "rotation_deg": vec(d, bo + 0x2C, 3),
            "translation": vec(d, bo + 0x38, 3),
            "box_min": vec(d, bo + 0x44, 3), "box_max": vec(d, bo + 0x50, 3),
            "_parent": s32(d, bo + 0x5C), "_off": bo,
            "world": vec(d, bo + 0x70, 12), "inv_world": vec(d, bo + 0xA0, 12),
        }
        f = b["flags"]
        b["flag_names"] = [n for bit, n in [
            (0x1, "identity"), (0x2, "trans_zero"), (0x4, "rot_zero"), (0x8, "scale_one"),
            (0x10, "scale_uniform"), (0x20, "ssc"), (0x40, "ssc_parent"), (0x80, "xsi_scaling"),
            (0x100, "visible"), (0x200, "has_geometry"), (0x400, "billboard_parent")] if f & bit]
        off2idx[bo] = b["index"]
        bones.append(b)
    for b in bones:
        p = b.pop("_parent")
        b["parent"] = off2idx.get(b["_off"] + p) if p else None
        del b["_off"]
    bones.sort(key=lambda b: b["index"])
    m["bones"] = bones

    # ---- definitions (bytecode)
    m["defs"] = {}
    for dname, do in sec["defs"]:
        m["defs"][dname] = parse_bytecode(d, do)

    # ---- vertex arrays
    def arr_common(ao):
        return {"name": rel_str(d, ao, s32(d, ao + 0x0C)), "index": u32(d, ao + 0x10),
                "_data": ao + s32(d, ao + 0x08)}

    m["positions"] = []
    for _, ao in sec["positions"]:
        a = arr_common(ao)
        ct, fmt, shift, stride, cnt = u32(d, ao + 0x14), u32(d, ao + 0x18), d[ao + 0x1C], d[ao + 0x1D], u16(d, ao + 0x1E)
        ncomp = 3 if ct == 1 else 2
        a.update({"components": "XYZ" if ct == 1 else "XY", "format": COMP_FMT[fmt],
                  "frac_bits": shift, "stride": stride, "count": cnt,
                  "min": vec(d, ao + 0x20, 3), "max": vec(d, ao + 0x2C, 3)})
        a["data"] = [[_read_comp(d, a["_data"] + i * stride + k * COMP_SIZE[fmt], fmt, shift)
                      for k in range(ncomp)] + ([0.0] if ncomp == 2 else []) for i in range(cnt)]
        m["positions"].append(a)
    m["normals"] = []
    for _, ao in sec["normals"]:
        a = arr_common(ao)
        ct, fmt, shift, stride, cnt = u32(d, ao + 0x14), u32(d, ao + 0x18), d[ao + 0x1C], d[ao + 0x1D], u16(d, ao + 0x1E)
        a.update({"components": {0: "N", 1: "NBT", 2: "NBT3"}.get(ct), "format": COMP_FMT[fmt],
                  "frac_bits": shift, "stride": stride, "count": cnt})
        a["data"] = [[_read_comp(d, a["_data"] + i * stride + k * COMP_SIZE[fmt], fmt, shift)
                      for k in range(3)] for i in range(cnt)]
        m["normals"].append(a)
    m["colors"] = []
    for _, ao in sec["colors"]:
        a = arr_common(ao)
        ct, fmt, stride, cnt = u32(d, ao + 0x14), u32(d, ao + 0x18), d[ao + 0x1C], u16(d, ao + 0x1E)
        a.update({"components": "RGBA" if ct == 1 else "RGB", "format": CLR_FMT[fmt],
                  "stride": stride, "count": cnt})
        a["data"] = [read_color(d, a["_data"] + i * stride, fmt) for i in range(cnt)]
        m["colors"].append(a)
    m["uvs"] = []
    for _, ao in sec["uvs"]:
        a = arr_common(ao)
        ct, fmt, shift, stride, cnt = u32(d, ao + 0x14), u32(d, ao + 0x18), d[ao + 0x1C], d[ao + 0x1D], u16(d, ao + 0x1E)
        ncomp = 2 if ct == 1 else 1
        a.update({"components": "ST" if ct == 1 else "S", "format": COMP_FMT[fmt],
                  "frac_bits": shift, "stride": stride, "count": cnt,
                  "min": vec(d, ao + 0x20, 2), "max": vec(d, ao + 0x28, 2)})
        a["data"] = [[_read_comp(d, a["_data"] + i * stride + k * COMP_SIZE[fmt], fmt, shift)
                      for k in range(ncomp)] + ([0.0] if ncomp == 1 else []) for i in range(cnt)]
        m["uvs"].append(a)
    for k in ("positions", "normals", "colors", "uvs"):
        m[k].sort(key=lambda a: a["index"])
        for a in m[k]:
            del a["_data"]

    # ---- shaders (TEV)
    shader_by_off = {}
    for _, so in sec["shaders"]:
        shader_by_off[so] = so
    # ---- materials
    mats = []
    for _, mo in sec["materials"]:
        mats.append(parse_material(d, mo))
    mats.sort(key=lambda x: x["index"])
    m["materials"] = mats

    # ---- objects (shapes)
    shapes = []
    for _, so in sec["objects"]:
        shapes.append(parse_shape(d, so, m))
    shapes.sort(key=lambda x: x["index"])
    m["shapes"] = shapes

    # texture -> material links
    m["texture_links"] = {}
    for tname, lo in sec["textures"]:
        n = u32(d, lo)
        m["texture_links"][tname] = n
    return m


def parse_bytecode(d, o):
    ops = []
    while True:
        op = d[o]
        if op == 0x01 or op > 0x06:
            break
        if op == 0x00:
            o += 1
            continue
        if op == 0x02:
            ops.append({"op": "node", "node": u16(d, o + 1), "parent_mtx": u16(d, o + 3)})
            o += 5
        elif op == 0x03:
            mid, n = u16(d, o + 1), d[o + 3]
            w = [(u16(d, o + 4 + 6 * i), f32(d, o + 6 + 6 * i)) for i in range(n)]
            ops.append({"op": "mix", "mtx": mid, "weights": [[a, b] for a, b in w]})
            o += 4 + 6 * n
        elif op == 0x04:
            ops.append({"op": "draw", "material": u16(d, o + 1), "shape": u16(d, o + 3),
                        "node": u16(d, o + 5), "priority": d[o + 7]})
            o += 8
        elif op == 0x05:
            ops.append({"op": "evp", "mtx": u16(d, o + 1), "node": u16(d, o + 3)})
            o += 5
        elif op == 0x06:
            ops.append({"op": "dup", "to": u16(d, o + 1), "from": u16(d, o + 3)})
            o += 5
    return ops


def parse_material(d, mo):
    import gxdl
    ver_hdr = {}
    mat = {
        "name": rel_str(d, mo, s32(d, mo + 0x08)),
        "index": u32(d, mo + 0x0C),
        "flags": u32(d, mo + 0x10),
        "num_texgens": d[mo + 0x14], "num_light_chans": d[mo + 0x15],
        "num_tev_stages": d[mo + 0x16], "num_ind_stages": d[mo + 0x17],
        "cull": CULL.get(u32(d, mo + 0x18)),
        "early_z": d[mo + 0x1C], "light_set": s8(d, mo + 0x1D), "fog_set": s8(d, mo + 0x1E),
        "ind_methods": list(d[mo + 0x20:mo + 0x24]),
        "normal_map_ref_light": [s8(d, mo + 0x24 + i) for i in range(4)],
    }
    mat["xlu"] = bool(mat["flags"] & 0x80000000)
    shader_off = mo + s32(d, mo + 0x28)
    ntex = u32(d, mo + 0x2C)
    layer_off = mo + s32(d, mo + 0x30)
    dl_off = mo + s32(d, mo + 0x38)
    # texture SRT / effect block (v8/v9 layout: +0x1A4)
    tb = mo + 0x1A4
    srt_flags, mtx_mode = u32(d, tb), u32(d, tb + 4)
    srts = []
    for i in range(8):
        so = tb + 8 + i * 20
        srts.append({"scale": vec(d, so, 2), "rotation_deg": f32(d, so + 8),
                     "translation": vec(d, so + 12, 2)})
    effects = []
    eb = tb + 8 + 160
    for i in range(8):
        eo = eb + i * 0x34
        effects.append({"scn_camera": s8(d, eo), "scn_light": s8(d, eo + 1),
                        "map_mode": MAP_MODE.get(d[eo + 2], d[eo + 2]),
                        "identity_effect_mtx": bool(d[eo + 3] & 1),
                        "effect_mtx": vec(d, eo + 4, 12)})
    lc = eb + 8 * 0x34
    chans = []
    for i in range(2):
        co = lc + i * 20
        chans.append({"flags": u32(d, co),
                      "mat_color": list(d[co + 4:co + 8]), "amb_color": list(d[co + 8:co + 12]),
                      "color_ctrl": gxdl.decode_chan_ctrl(u32(d, co + 12)),
                      "alpha_ctrl": gxdl.decode_chan_ctrl(u32(d, co + 16))})
    mat["light_channels"] = chans[:max(mat["num_light_chans"], 0)] if mat["num_light_chans"] else []
    mat["light_channels_raw"] = chans
    mat["texmtx_mode"] = TEXMTX_MODE.get(mtx_mode, mtx_mode)
    layers = []
    for i in range(ntex):
        lo = layer_off + i * 0x34
        enabled_flags = (srt_flags >> (4 * i)) & 0xF
        layers.append({
            "texture": rel_str(d, lo, s32(d, lo)),
            "palette": rel_str(d, lo, s32(d, lo + 4)),
            "texmap_id": u32(d, lo + 0x10), "tlut_id": u32(d, lo + 0x14),
            "wrap_s": WRAP.get(u32(d, lo + 0x18)), "wrap_t": WRAP.get(u32(d, lo + 0x1C)),
            "min_filter": FILTER.get(u32(d, lo + 0x20)), "mag_filter": FILTER.get(u32(d, lo + 0x24)),
            "lod_bias": f32(d, lo + 0x28), "max_aniso": u32(d, lo + 0x2C),
            "bias_clamp": bool(d[lo + 0x30]), "edge_lod": bool(d[lo + 0x31]),
            "srt": srts[i], "srt_flags": enabled_flags, "effect": effects[i],
        })
    mat["layers"] = layers
    # material display list: pixel engine (0x20) + TEV colours (0x80) + indirect (0x40) + texgen (0xA0)
    regs = gxdl.run_dl(d, dl_off, 0x180)
    # shader: header 0x20, display list 0x1E0
    sregs = gxdl.run_dl(d, shader_off + 0x20, 0x1E0)
    mat["shader"] = {"index": u32(d, shader_off + 0x08), "stages": d[shader_off + 0x0C],
                     "tex_refs": [s8(d, shader_off + 0x10 + i) for i in range(8)]}
    merged = gxdl.Regs()
    merged.bp.update(sregs.bp)
    merged.bp.update(regs.bp)
    merged.xf.update(regs.xf)
    merged.xf.update(sregs.xf)
    mat["pe"] = gxdl.decode_pe(merged)
    mat["tev"] = gxdl.decode_tev(merged, mat["num_tev_stages"])
    mat["tev_colors"] = gxdl.decode_tev_colors(regs)
    mat["texgens"] = gxdl.decode_texgens(merged, mat["num_texgens"])
    return mat


def parse_shape(d, so, mdl):
    import gxdl
    sh = {
        "single_bind_mtx": s32(d, so + 0x08),
        "vcd_lo": u32(d, so + 0x0C), "vcd_hi": u32(d, so + 0x10), "xf_spec": u32(d, so + 0x14),
    }
    def_size, def_off = u32(d, so + 0x18), s32(d, so + 0x20)
    prim_size, prim_off = u32(d, so + 0x28), s32(d, so + 0x2C)
    sh["array_flags"] = u32(d, so + 0x30)
    sh["flags"] = u32(d, so + 0x34)
    sh["name"] = rel_str(d, so, s32(d, so + 0x38))
    sh["index"] = u32(d, so + 0x3C)
    sh["vertex_count"] = u32(d, so + 0x40)
    sh["face_count"] = u32(d, so + 0x44)
    sh["pos_id"] = s16(d, so + 0x48)
    sh["nrm_id"] = s16(d, so + 0x4A)
    sh["clr_ids"] = [s16(d, so + 0x4C), s16(d, so + 0x4E)]
    sh["uv_ids"] = [s16(d, so + 0x50 + 2 * i) for i in range(8)]
    wg = so + s32(d, so + 0x60)
    n = u32(d, wg)
    sh["mtx_ids"] = [u16(d, wg + 4 + 2 * i) for i in range(n)]
    setup = gxdl.run_dl(d, so + 0x18 + def_off, def_size)
    sh["vcd"] = gxdl.decode_vcd(setup.cp.get(0x50, sh["vcd_lo"]), setup.cp.get(0x60, sh["vcd_hi"]))
    sh["vat"] = {k: v for k, v in setup.cp.items() if 0x70 <= k < 0xA0}
    sh["primitives"] = gxdl.parse_primitives(d, so + 0x24 + prim_off, prim_size, sh["vcd"])
    return sh


# ------------------------------------------------------------------ animation helpers

def hermite_keys(d, o, stride12=True):
    """NW4R float keyframe list: u16 count, pad, f32 frameScale, count*(frame, value, slope)."""
    n = u16(d, o)
    keys = []
    for i in range(n):
        k = o + 8 + 12 * i
        keys.append([f32(d, k), f32(d, k + 4), f32(d, k + 8)])
    return keys


def _anim_common(d, o, magic):
    assert d[o:o + 4] == magic, magic
    return u32(d, o + 8)


# ------------------------------------------------------------------ SRT0

def parse_srt0(d, o):
    ver = _anim_common(d, o, b"SRT0")
    base = o + 0x10
    if ver >= 5:
        base += 4  # user data
    data_off = s32(d, o + 0x10)
    name = rel_str(d, o, s32(d, base + 4))
    frames, nmat = u16(d, base + 0x0C), u16(d, base + 0x0E)
    mtx_mode, loop = u32(d, base + 0x10), u32(d, base + 0x14)
    anim = {"type": "SRT0", "version": ver, "name": name, "frames": frames,
            "texmtx_mode": TEXMTX_MODE.get(mtx_mode), "loop": bool(loop), "materials": []}
    for mname, mo in index_group(d, o + data_off):
        tex_flags, ind_flags = u32(d, mo + 4), u32(d, mo + 8)
        ent = {"material": mname, "textures": [], "indirect": []}
        p = mo + 12
        for slot in range(8 + 3):
            flagset = tex_flags if slot < 8 else ind_flags
            bit = slot if slot < 8 else slot - 8
            if not flagset & (1 << bit):
                continue
            to = mo + s32(d, p)
            p += 4
            tr = _srt_tex(d, to)
            tr["slot"] = bit
            (ent["textures"] if slot < 8 else ent["indirect"]).append(tr)
        anim["materials"].append(ent)
    return anim


def _srt_tex(d, to):
    code = u32(d, to)
    q = to + 4
    out = {"code": code}

    def take(fixed):
        nonlocal q
        if fixed:
            v = f32(d, q)
            q += 4
            return {"const": v}
        # key-list offsets are relative to the offset field itself
        kl = q + s32(d, q)
        q += 4
        return {"keys": hermite_keys(d, kl)}

    if not code & 0x2:  # scale not one
        if code & 0x10:  # isotropic
            s = take(code & 0x20)
            out["scale_s"] = out["scale_t"] = s
        else:
            out["scale_s"] = take(code & 0x20)
            out["scale_t"] = take(code & 0x40)
    if not code & 0x4:
        out["rotation_deg"] = take(code & 0x80)
    if not code & 0x8:
        out["translate_s"] = take(code & 0x100)
        out["translate_t"] = take(code & 0x200)
    return out


# ------------------------------------------------------------------ CLR0

CLR0_TARGETS = ["mat_color0", "mat_color1", "amb_color0", "amb_color1",
                "tev_color0", "tev_color1", "tev_color2",
                "tev_konst0", "tev_konst1", "tev_konst2", "tev_konst3"]


def parse_clr0(d, o):
    ver = _anim_common(d, o, b"CLR0")
    base = o + 0x10
    if ver >= 4:
        base += 4
    data_off = s32(d, o + 0x10)
    name = rel_str(d, o, s32(d, base + 4))
    frames, nmat = u16(d, base + 0x0C), u16(d, base + 0x0E)
    loop = u32(d, base + 0x10)
    anim = {"type": "CLR0", "version": ver, "name": name, "frames": frames,
            "loop": bool(loop), "materials": []}
    for mname, mo in index_group(d, o + data_off):
        flags = u32(d, mo + 4)
        p = mo + 8
        ent = {"material": mname, "targets": {}}
        for t, tname in enumerate(CLR0_TARGETS):
            f = (flags >> (2 * t)) & 3
            if not f & 1:
                continue
            mask = u32(d, p)
            if f & 2:
                val = {"const": list(d[p + 4:p + 8])}
            else:
                ao = p + 4 + s32(d, p + 4)
                n = frames + (0 if loop else 1)
                val = {"frames": [list(d[ao + 4 * i:ao + 4 * i + 4]) for i in range(frames + 1)]}
            val["keep_mask"] = "%08x" % mask
            ent["targets"][tname] = val
            p += 8
        anim["materials"].append(ent)
    return anim


# ------------------------------------------------------------------ PAT0

def parse_pat0(d, o):
    ver = _anim_common(d, o, b"PAT0")
    base = o + 0x10
    extra = 4 if ver >= 4 else 0
    data_off = s32(d, base)
    tex_tab, pal_tab = s32(d, base + 4), s32(d, base + 8)
    name = rel_str(d, o, s32(d, base + 0x14 + extra))
    hb = base + 0x1C + extra
    frames, nmat, ntex, npal = u16(d, hb), u16(d, hb + 2), u16(d, hb + 4), u16(d, hb + 6)
    loop = u32(d, hb + 8)
    texnames = [rel_str(d, o + tex_tab, s32(d, o + tex_tab + 4 * i)) for i in range(ntex)]
    palnames = [rel_str(d, o + pal_tab, s32(d, o + pal_tab + 4 * i)) for i in range(npal)]
    anim = {"type": "PAT0", "version": ver, "name": name, "frames": frames, "loop": bool(loop),
            "textures": texnames, "palettes": palnames, "materials": []}
    for mname, mo in index_group(d, o + data_off):
        flags = u32(d, mo + 4)
        p = mo + 8
        ent = {"material": mname, "slots": []}
        for slot in range(8):
            f = (flags >> (4 * slot)) & 0xF
            if not f & 1:
                continue
            s = {"slot": slot}
            if f & 2:
                ti, pi = u16(d, p), u16(d, p + 2)
                s["const"] = {"texture": texnames[ti] if f & 4 and ti < len(texnames) else None,
                              "palette": palnames[pi] if f & 8 and pi < len(palnames) else None}
            else:
                ko = mo + s32(d, p)
                n = u16(d, ko)
                keys = []
                for i in range(n):
                    k = ko + 8 + 8 * i
                    ti, pi = u16(d, k + 4), u16(d, k + 6)
                    keys.append({"frame": f32(d, k),
                                 "texture": texnames[ti] if f & 4 and ti < len(texnames) else None,
                                 "palette": palnames[pi] if f & 8 and pi < len(palnames) else None})
                s["keys"] = keys
            p += 4
            ent["slots"].append(s)
        anim["materials"].append(ent)
    return anim


# ------------------------------------------------------------------ VIS0

def parse_vis0(d, o):
    ver = _anim_common(d, o, b"VIS0")
    base = o + 0x10
    if ver >= 4:
        base += 4
    data_off = s32(d, o + 0x10)
    name = rel_str(d, o, s32(d, base + 4))
    frames, nb = u16(d, base + 0x0C), u16(d, base + 0x0E)
    loop = u32(d, base + 0x10)
    anim = {"type": "VIS0", "version": ver, "name": name, "frames": frames, "loop": bool(loop),
            "bones": []}
    for bname, bo in index_group(d, o + data_off):
        flags = u32(d, bo + 4)
        ent = {"bone": bname}
        if flags & 2:
            ent["const"] = bool(flags & 1)
        else:
            bits = []
            for f in range(frames):
                w = u32(d, bo + 8 + 4 * (f // 32))
                bits.append(bool(w & (0x80000000 >> (f % 32))))
            ent["frames"] = bits
        anim["bones"].append(ent)
    return anim


# ------------------------------------------------------------------ CHR0

def parse_chr0(d, o):
    """CHR0 v4/v5: bone SRT tracks (none in the Tanks! assets; minimal support)."""
    ver = _anim_common(d, o, b"CHR0")
    base = o + 0x10
    if ver >= 5:
        base += 4
    data_off = s32(d, o + 0x10)
    name = rel_str(d, o, s32(d, base + 4))
    frames, nb = u16(d, base + 0x0C), u16(d, base + 0x0E)
    loop = u32(d, base + 0x10)
    return {"type": "CHR0", "version": ver, "name": name, "frames": frames, "loop": bool(loop),
            "bones": [b for b, _ in index_group(d, o + data_off)],
            "note": "track decoding not implemented (no CHR0 in Tanks! data)"}
