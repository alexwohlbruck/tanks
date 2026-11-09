"""Effect assets: BTI tread marks, REFT effect textures, REFF emitters.

REFF/REFT layout (NW4R ef, file version 5 as shipped in Wii Play):

  FileHeader 0x10: magic 'REFF'/'REFT', u16 BOM, u16 version, u32 size,
                   u16 header size, u16 block count
  BlockHeader 0x08: magic, u32 size
  Project:   u32 header size, 8 bytes runtime link, u16 name len, pad, name
  NameTable (at project + header size): u32 table size, u16 count, pad,
             then per entry: u16 len, name (len bytes incl. NUL),
             u32 offset (from the name table), u32 size
  REFT entry: TextureData 0x20 header (see parse_reft) + GX image (+ TLUT)
  REFF entry: EmitterResource: u32 name ptr (runtime), u32 desc size (0x140),
             EmitterDesc (0xA0 common + 0xA0 draw setting),
             u32 particle size, ParticleParameterDesc (incl. texture names),
             u16 nPtclTrack, u16 nPtclInitTrack, u32 ptr[n], u32 size[n],
             u16 nEmitTrack, u16 nEmitInitTrack, u32 ptr[m], u32 size[m],
             track data (AnimCurve, see parse_track).
Field offsets follow nw4r/ef headers from the Wii Play decompilation; the
v5 data differs from the decomp's v7 structs in two places (documented in
docs/models.md): EmitterDesc has 0xC extra bytes before the draw setting and
the draw setting is 0xC shorter; ParticleParameterDesc stores its texture
names at +0x7A.
"""
import os
import struct

import gxtex
from binutil import u8, s8, u16, s16, u32, s32, f32, vec, rlist, rf
import gxdl

FORM = {0: "disc", 1: "line", 5: "cube", 7: "cylinder", 8: "sphere", 9: "point", 10: "torus"}
FORM_PARAMS = {
    "disc": ["size_x", "inner_pct", "angle_start_rad", "angle_end_rad", "size_z", "unused"],
    "line": ["length", "rot_x_rad", "rot_y_rad", "rot_z_rad", "unused4", "unused5"],
    "cube": ["size_x", "size_y", "size_z", "inner_pct", "unused4", "unused5"],
    "cylinder": ["size_x", "inner_pct", "angle_start_rad", "angle_end_rad", "height", "size_z"],
    "sphere": ["size_x", "inner_pct", "angle_start_rad", "angle_end_rad", "size_y", "size_z"],
    "torus": ["size_x", "tube_inner_ratio", "angle_start_rad", "angle_end_rad", "size_y", "size_z"],
    "point": ["p0", "p1", "p2", "p3", "p4", "p5"],
}
PTCL_TYPE = {0: "point", 1: "line", 2: "free", 3: "billboard", 4: "directional", 5: "stripe",
             6: "smooth_stripe"}
BLEND_TYPE = {0: "none", 1: "blend", 2: "logic", 3: "subtract"}
TEVCOLOR_SRC = {0: "null", 1: "color1_primary", 2: "color1_secondary", 3: "color2_primary?",
                4: "color2_secondary", 5: "color1_mult", 6: "color2_mult"}
COMMON_FLAGS = [(1, "sync_life"), (2, "disable_draw"), (4, "max_life"), (0x20, "inherit_ptcl_scale"),
                (0x40, "inherit_ptcl_rot"), (0x80, "emit_inherit_scale"), (0x100, "emit_inherit_rot"),
                (0x200, "disable_calc")]
DRAW_FLAGS = [(1, "zcomp_test"), (2, "zcomp_update"), (4, "zcomp_before_tex"), (8, "clip_disable"),
              (0x10, "tex1_enable"), (0x20, "tex2_enable"), (0x40, "texind_enable"),
              (0x80, "tex1_proj"), (0x100, "tex2_proj"), (0x200, "texind_proj"), (0x400, "hidden"),
              (0x800, "draw_order"), (0x1000, "fog_enable"), (0x2000, "xy_same_size"),
              (0x4000, "xy_same_scale")]
TRACK_KIND = {
    0: "color0_primary", 1: "alpha0_primary", 2: "color0_secondary", 3: "alpha0_secondary",
    4: "color1_primary", 5: "alpha1_primary", 6: "color1_secondary", 7: "alpha1_secondary",
    8: "acmp_ref0", 9: "acmp_ref1", 10: "size", 11: "scale", 12: "rotate",
    14: "texture1", 15: "texture2", 16: "texture_ind",
    17: "texture1_scale", 18: "texture1_rotate", 19: "texture1_translate",
    20: "texture2_scale", 21: "texture2_rotate", 22: "texture2_translate",
    23: "texind_scale", 24: "texind_rotate", 25: "texind_translate", 26: "child",
    32: "field_gravity", 33: "field_speed", 34: "field_magnet", 35: "field_newton",
    36: "field_vortex", 38: "field_spin", 39: "field_random",
    64: "emit_common_param", 65: "emit_scale", 66: "emit_rotate", 67: "emit_translate",
    68: "emit_speed_radiation", 69: "emit_speed_yaxis", 70: "emit_speed_random",
    71: "emit_speed_normal", 72: "emit_speed_specdir", 73: "emit_emission",
}
CURVE_TYPE = {0: "u8", 3: "f32", 4: "texture", 5: "child", 6: "rotate"}
PROC_FLAGS = [(4, "sync"), (8, "stop"), (0x10, "timing"), (0x20, "infinite_loop"), (0x40, "turn"),
              (0x80, "fitting")]
INTERP = {0: "linear", 1: "smooth", 2: "step"}
WRAP = {0: "clamp", 1: "repeat", 2: "mirror", 3: "?"}


def flags(v, table):
    return [n for b, n in table if v & b]


# ------------------------------------------------------------------ BTI

def parse_bti(d, o=0):
    fmt, alpha, w, h = d[o], d[o + 1], u16(d, o + 2), u16(d, o + 4)
    wrap_s, wrap_t = d[o + 6], d[o + 7]
    pal_fmt, pal_cnt, pal_off = d[o + 9], u16(d, o + 0xA), u32(d, o + 0xC)
    mip_en, min_f, mag_f = d[o + 0x10], d[o + 0x14], d[o + 0x15]
    nimg = d[o + 0x18]
    data_off = u32(d, o + 0x1C)
    pal = gxtex.decode_palette(d, o + pal_off, pal_fmt, pal_cnt) if fmt in (8, 9, 10) else None
    levels = gxtex.decode_mips(d, o + data_off, fmt, w, h, max(1, nimg), pal)
    return {"format": gxtex.FMT_NAMES.get(fmt, fmt), "width": w, "height": h,
            "alpha_flag": alpha, "wrap_s": {0: "clamp", 1: "repeat", 2: "mirror"}.get(wrap_s),
            "wrap_t": {0: "clamp", 1: "repeat", 2: "mirror"}.get(wrap_t),
            "mipmap": bool(mip_en), "levels": max(1, nimg), "min_filter": min_f, "mag_filter": mag_f,
            "images": levels}


# ------------------------------------------------------------------ name tables

def _project_entries(d, magic):
    assert d[:4] == magic, magic
    ver = u16(d, 6)
    hsize = u16(d, 0xC)
    blk = hsize
    assert d[blk:blk + 4] == magic
    proj = blk + 8
    phs = u32(d, proj)
    nlen = u16(d, proj + 0xC)
    pname = d[proj + 0x10:proj + 0x10 + nlen].split(b"\0")[0].decode()
    nt = proj + phs
    cnt = u16(d, nt + 4)
    p = nt + 8
    out = []
    for _ in range(cnt):
        ln = u16(d, p)
        name = d[p + 2:p + 2 + ln].split(b"\0")[0].decode()
        p += 2 + ln
        off, size = u32(d, p), u32(d, p + 4)
        p += 8
        out.append((name, nt + off, size))
    return ver, pname, out


def parse_reft(d):
    ver, pname, ents = _project_entries(d, b"REFT")
    texs = []
    for name, o, size in ents:
        w, h, dsize = u16(d, o + 4), u16(d, o + 6), u32(d, o + 8)
        fmt, tfmt, tcnt, tsize = d[o + 0xC], d[o + 0xD], u16(d, o + 0xE), u32(d, o + 0x10)
        mip, minf, magf = d[o + 0x14], d[o + 0x15], d[o + 0x16]
        pal = gxtex.decode_palette(d, o + 0x20 + dsize, tfmt, tcnt) if fmt in (8, 9, 10) else None
        nlev = 1
        # count levels that fit in dataSize
        tw, th, acc = w, h, 0
        while True:
            acc += gxtex.image_size(fmt, tw, th)
            if acc >= dsize or tw == 1 and th == 1:
                break
            tw, th = max(1, tw // 2), max(1, th // 2)
            nlev += 1
        imgs = gxtex.decode_mips(d, o + 0x20, fmt, w, h, nlev, pal)
        texs.append({"name": name, "width": w, "height": h, "format": gxtex.FMT_NAMES.get(fmt, fmt),
                     "data_size": dsize, "mipmap_flag": mip, "levels": nlev,
                     "min_filter": minf, "mag_filter": magf,
                     "tlut_format": gxtex.PAL_NAMES.get(tfmt) if tcnt else None, "tlut_entries": tcnt,
                     "images": imgs})
    return {"version": ver, "project": pname, "textures": texs}


# ------------------------------------------------------------------ REFF emitters

def _tev_stage_color(b):
    return [gxdl.CC[x] if x < 16 else x for x in b]


def _tev_stage_alpha(b):
    return [gxdl.CA[x] if x < 8 else x for x in b]


def parse_draw_setting(d, o):
    fl = u16(d, o)
    ds = {"flags_raw": "%04x" % fl, "flags": flags(fl, DRAW_FLAGS),
          "alpha_compare": {"comp0": gxdl.COMPARE[d[o + 2] & 7], "comp1": gxdl.COMPARE[d[o + 3] & 7],
                            "op": gxdl.ALOGIC[d[o + 4] & 3]},
          "num_tev_stages": d[o + 5], "flag_clamp": d[o + 6], "indirect_target_stage": d[o + 7]}
    n = max(1, min(4, d[o + 5]))
    stages = []
    for i in range(n):
        c = list(d[o + 0x08 + 4 * i:o + 0x0C + 4 * i])
        cop = list(d[o + 0x18 + 5 * i:o + 0x1D + 5 * i])
        a = list(d[o + 0x2C + 4 * i:o + 0x30 + 4 * i])
        aop = list(d[o + 0x3C + 5 * i:o + 0x41 + 5 * i])
        kc, ka = d[o + 0x50 + i], d[o + 0x54 + i]
        ce = _tev_stage_color(c)
        ae = _tev_stage_alpha(a)
        stages.append({
            "color_in": ce, "color_op": {"op": "sub" if cop[0] else "add", "bias": gxdl.BIAS[cop[1] & 3],
                                         "scale": gxdl.SCALE[cop[2] & 3], "clamp": bool(cop[3]),
                                         "dest": gxdl.DEST[cop[4] & 3]},
            "alpha_in": ae, "alpha_op_stored": {"op": "sub" if aop[0] else "add", "bias": gxdl.BIAS[aop[1] & 3],
                                                "scale": gxdl.SCALE[aop[2] & 3], "clamp": bool(aop[3]),
                                                "dest": gxdl.DEST[aop[4] & 3]},
            "konst_color_sel": gxdl.KCSEL.get(kc, kc), "konst_alpha_sel": gxdl.KASEL.get(ka, ka),
            "color_expr": gxdl._expr(*ce, cop[0], gxdl.BIAS[cop[1] & 3], gxdl.SCALE[cop[2] & 3], "ZERO", "ONE"),
            "alpha_expr": gxdl._expr(*ae, cop[0], gxdl.BIAS[cop[1] & 3], gxdl.SCALE[cop[2] & 3], "ZERO", "ONE"),
        })
    ds["tev_stages"] = stages
    ds["tev_note"] = ("runtime applies color_op to the alpha stage too (nw4r ef bug); "
                      "alpha_op_stored is what the file holds")
    bt, bs, bd, bo = d[o + 0x58:o + 0x5C]
    ds["blend"] = {"type": BLEND_TYPE.get(bt, bt), "src": gxdl.BLEND_SRC[bs & 7],
                   "dst": gxdl.BLEND_DST[bd & 7], "logic_op": gxdl.LOGIC_OPS[bo & 15]}
    ds["color_input"] = {"raster": {0: "null", 1: "lighting"}.get(d[o + 0x5C], d[o + 0x5C]),
                         "tev_registers_C0_C2": [TEVCOLOR_SRC.get(x, x) for x in d[o + 0x5D:o + 0x60]],
                         "tev_konst_K0_K3": [TEVCOLOR_SRC.get(x, x) for x in d[o + 0x60:o + 0x64]]}
    ds["z_compare"] = gxdl.COMPARE[d[o + 0x64] & 7]
    ds["alpha_flick"] = {"type": {0: "none", 1: "triangle", 2: "sawtooth_inv", 3: "sawtooth", 4: "square",
                                  5: "sine"}.get(d[o + 0x65], d[o + 0x65]),
                         "cycle": u16(d, o + 0x66), "random": d[o + 0x68], "amplitude": d[o + 0x69]}
    lo = o + 0x6A
    ds["lighting"] = {"mode": {0: "off", 1: "simple", 2: "hardware"}.get(d[lo], d[lo]),
                      "type": {0: "none", 1: "ambient", 2: "point"}.get(d[lo + 1], d[lo + 1]),
                      "ambient": list(d[lo + 2:lo + 6]), "diffuse": list(d[lo + 6:lo + 10]),
                      "radius": f32(d, lo + 10), "position": vec(d, lo + 14, 3)}
    ds["ind_tex_offset_mtx"] = [vec(d, o + 0x80, 3), vec(d, o + 0x8C, 3)]
    ds["tail_raw_98_9f"] = d[o + 0x98:o + 0xA0].hex()
    return ds


def parse_emitter_desc(d, o):
    cf, ef = u32(d, o), u32(d, o + 4)
    form = FORM.get(ef & 0xFF, ef & 0xFF)
    params = vec(d, o + 0x1C, 6)
    e = {
        "common_flags_raw": "%08x" % cf, "common_flags": flags(cf, COMMON_FLAGS),
        "emit_flags_raw": "%08x" % ef, "form": form,
        "form_params": dict(zip(FORM_PARAMS.get(form, ["p%d" % i for i in range(6)]), rlist(params))),
        "emitter_life": u16(d, o + 8), "emitter_life_note": "65535 = infinite",
        "particle_life": u16(d, o + 0xA), "particle_life_random_pct": s8(d, o + 0xC),
        "inherit_child_ptcl_translate": s8(d, o + 0xD),
        "emit_interval_random_pct": s8(d, o + 0xE), "emit_count_random_pct": s8(d, o + 0xF),
        "emit_count": f32(d, o + 0x10), "emit_start_frame": u16(d, o + 0x14),
        "emit_past": u16(d, o + 0x16), "emit_interval": u16(d, o + 0x18),
        "inherit_ptcl_translate": s8(d, o + 0x1A), "inherit_child_emit_translate": s8(d, o + 0x1B),
        "emit_div": u16(d, o + 0x34),
        "velocity": {
            "init_random_pct": s8(d, o + 0x36), "momentum_random_pct": s8(d, o + 0x37),
            "radiation_power": f32(d, o + 0x38), "y_axis_power": f32(d, o + 0x3C),
            "random_dir_power": f32(d, o + 0x40), "normal_dir_power": f32(d, o + 0x44),
            "normal_diffusion": f32(d, o + 0x48), "spec_dir_power": f32(d, o + 0x4C),
            "spec_dir_diffusion": f32(d, o + 0x50), "spec_dir": vec(d, o + 0x54, 3)},
        "emitter_scale": vec(d, o + 0x60, 3), "emitter_rotate_rad": vec(d, o + 0x6C, 3),
        "emitter_translate": vec(d, o + 0x78, 3),
        "lod": {"near": d[o + 0x84], "far": d[o + 0x85], "min_emit": d[o + 0x86], "alpha": d[o + 0x87]},
        "random_seed": u32(d, o + 0x88),
        # v5 keeps the particle shape here (the v7 decomp has it at the end of the draw setting)
        "particle_type": PTCL_TYPE.get(d[o + 0x8C], d[o + 0x8C]),
        "type_option": d[o + 0x8D], "type_dir": d[o + 0x8E], "type_axis": d[o + 0x8F],
        "type_option012": list(d[o + 0x90:o + 0x93]),
        "ind_tex_scale_exp": s8(d, o + 0x94),
        "pivot_pct": [s8(d, o + 0x95), s8(d, o + 0x96)],
        "raw_97_9f": d[o + 0x97:o + 0xA0].hex(),
    }
    e["draw"] = parse_draw_setting(d, o + 0xA0)
    return e


def parse_particle(d, o, size):
    p = {
        "colors": {"layer1_primary": list(d[o:o + 4]), "layer1_secondary": list(d[o + 4:o + 8]),
                   "layer2_primary": list(d[o + 8:o + 12]), "layer2_secondary": list(d[o + 12:o + 16])},
        "size": vec(d, o + 0x10, 2), "scale": vec(d, o + 0x18, 2), "rotate_rad": vec(d, o + 0x20, 3),
        "texture_scale": [vec(d, o + 0x2C + 8 * i, 2) for i in range(3)],
        "texture_rotate": vec(d, o + 0x44, 3),
        "texture_translate": [vec(d, o + 0x50 + 8 * i, 2) for i in range(3)],
        "texture_wrap_raw": "%04x" % u16(d, o + 0x74),
        "texture_wrap": [{"s": WRAP.get((u16(d, o + 0x74) >> (4 * L)) & 3), "t": WRAP.get((u16(d, o + 0x74) >> (4 * L + 2)) & 3)}
                         for L in range(3)],
        "texture_reverse_raw": d[o + 0x76],
        "acmp_ref0": d[o + 0x77], "acmp_ref1": d[o + 0x78], "raw_79": d[o + 0x79],
    }
    q = o + 0x7A
    names = []
    for _ in range(3):
        ln = u16(d, q)
        names.append(d[q + 2:q + 2 + ln].split(b"\0")[0].decode("ascii", "replace") or None)
        q += 2 + ln
    p["textures"] = {"layer1": names[0], "layer2": names[1], "indirect": names[2]}
    return p


def _track_keys(d, kt, ctype, enable):
    """Decode a key table (file version 5 layout).

    Every key starts with an 8-byte prefix: u16 frame, u16 interp (2 bits per
    component: 0 linear, 1 smooth, 2 step), u16 pad, u8 random flag, u8 pad.
    Payload at +8: u8 curves -> packed bytes for the enabled components
    (key padded to 2 bytes); f32 -> one f32 per component up to the highest
    enabled bit; rotate -> 3 f32; texture -> u8 wrap, u8 reverse, u16 name
    index; child -> 8-byte inherit setting, u16 name index.  When the random
    flag is set the payload starts with a u16 index into the range table.
    """
    cnt = u16(d, kt)
    keys = []
    num = 0
    for bit in range(7, -1, -1):
        if enable & (1 << bit):
            num = bit + 1
            break
    q = kt + 4
    for _ in range(cnt):
        fr, interp, rnd = u16(d, q), u16(d, q + 2), d[q + 6]
        k = {"frame": fr, "random": rnd}
        if ctype in ("u8", "f32", "rotate"):
            n = 3 if ctype == "rotate" else num
            k["interp"] = [INTERP.get((interp >> (2 * c)) & 3, (interp >> (2 * c)) & 3) for c in range(n)]
            if interp:
                k["interp_raw"] = "%04x" % interp
        if ctype == "u8":
            npacked = bin(enable & 0xFF).count("1")
            ksz = (8 + npacked + 1) & ~1
            if rnd:
                k["value"] = {"random_range_index": u16(d, q + 8)}
            else:
                vals, vi = [], 0
                for c in range(num):
                    # component c <-> bit (num-1-c), e.g. RGB mask 0b111 -> R,G,B
                    if enable & (1 << (num - 1 - c)):
                        vals.append(d[q + 8 + vi])
                        vi += 1
                    else:
                        vals.append(None)
                k["value"] = vals
        elif ctype in ("f32", "rotate"):
            n = 3 if ctype == "rotate" else num
            ksz = 8 + 4 * n
            k["value"] = ({"random_range_index": u16(d, q + 8)} if rnd
                          else [rf(f32(d, q + 8 + 4 * c)) for c in range(n)])
        elif ctype == "texture":
            ksz = 12
            if rnd:
                k["random_range_index"] = u16(d, q + 8)
            else:
                k.update({"wrap": d[q + 8], "reverse": d[q + 9], "name_index": u16(d, q + 10)})
        elif ctype == "child":
            ksz = 18
            ih = d[q + 8:q + 16]
            k["inherit"] = {"raw": ih.hex(), "speed": s16(d, q + 8), "scale": ih[2], "alpha": ih[3],
                            "color": ih[4], "weight": ih[5], "type": ih[6], "flag": ih[7]}
            k["child_index"] = u16(d, q + 16)
        else:
            break
        keys.append(k)
        q += ksz
    return keys, num


def _name_table(d, o, size):
    """u16 count, pad, count x u32 runtime pointer slots, then (u16 len, name)."""
    if size < 4:
        return []
    cnt = u16(d, o)
    q = o + 4 + 4 * cnt
    out = []
    for _ in range(cnt):
        if q + 2 > o + size:
            break
        ln = u16(d, q)
        out.append(d[q + 2:q + 2 + ln].split(b"\0")[0].decode("ascii", "replace"))
        q += 2 + ln
    return out


def parse_track(d, o, size):
    magic, kind, cflag, enable, proc, loops = d[o:o + 6]
    seed, flen = u16(d, o + 6), u16(d, o + 8)
    kt_s, rt_s, rnd_s, nt_s, info_s = (u32(d, o + 0xC + 4 * i) for i in range(5))
    ctype = CURVE_TYPE.get(cflag, cflag)
    t = {"magic": "%02x" % magic, "baked": magic == 0xAB, "target": TRACK_KIND.get(kind, kind),
         "target_id": kind, "curve_type": ctype, "component_mask": "{:08b}".format(enable),
         "process_flags": flags(proc, PROC_FLAGS), "loop_count": loops, "random_seed": seed,
         "frame_length": flen}
    kt = o + 0x20
    rt = kt + kt_s
    rnt = rt + rt_s
    nt = rnt + rnd_s
    it = nt + nt_s
    if magic == 0xAB:
        t["raw"] = d[kt:o + size].hex()
        return t
    try:
        keys, num = _track_keys(d, kt, ctype, enable)
        t["keys"] = keys
    except Exception as ex:  # pragma: no cover - keep going on odd data
        t["keys_error"] = str(ex)
        num = 0
    # random ranges
    if rt_s >= 4 and u16(d, rt) and ctype in ("u8", "f32", "rotate"):
        cnt = u16(d, rt)
        rngs = []
        q = rt + 4
        for _ in range(cnt):
            if ctype == "u8":
                rngs.append([[d[q + 2 * c], d[q + 2 * c + 1]] for c in range(num)])
                q += 2 * num
            elif ctype == "f32":
                rngs.append([[rf(f32(d, q + 8 * c)), rf(f32(d, q + 8 * c + 4))] for c in range(num)])
                q += 8 * num
            else:
                rngs.append({"base_width": [[rf(f32(d, q + 8 * c)), rf(f32(d, q + 8 * c + 4))] for c in range(3)],
                             "random_sign": d[q + 0x18]})
                q += 0x1C
        t["random_ranges"] = rngs
        t["random_range_note"] = "value = base + width * rand  (u8 width scaled by signed rand in [-1,1))"
    if rnd_s >= 4 and u16(d, rnt):
        t["random_table_raw"] = d[rnt:rnt + rnd_s].hex()
    if nt_s:
        t["names"] = _name_table(d, nt, nt_s)
        for k in t.get("keys", []):
            for fld, dst in (("child_index", "child"), ("name_index", "texture")):
                if fld in k and k[fld] < len(t["names"]):
                    k[dst] = t["names"][k[fld]]
    if info_s and kind == 33:
        t["field"] = {"base_speed": f32(d, it), "note": "velocity *= speed each frame (curve overrides)"}
    elif info_s:
        ip = it
        if kind == 32:
            t["field"] = {"power": f32(d, ip), "dir": vec(d, ip + 4, 3),
                          "space": "emitter" if d[ip + 0x10] else "global",
                          "apply": "velocity" if d[ip + 0x11] == 0 else "position"}
        elif kind == 39:
            t["field"] = {"power": f32(d, ip), "diffuse": f32(d, ip + 4), "interval": u16(d, ip + 8),
                          "flags": d[ip + 0xA], "apply": "velocity" if d[ip + 0xB] == 0 else "position"}
        elif kind == 38:
            t["field"] = {"speed": f32(d, ip), "axis_rot": vec(d, ip + 4, 3),
                          "space": "emitter" if d[ip + 0x10] else "global", "type": d[ip + 0x11]}
        elif kind == 34:
            t["field"] = {"power": f32(d, ip), "pos": vec(d, ip + 4, 3),
                          "space": "emitter" if d[ip + 0x10] else "global", "type": d[ip + 0x11]}
        elif kind == 35:
            t["field"] = {"power": f32(d, ip), "range": f32(d, ip + 4), "pos": vec(d, ip + 8, 3),
                          "space": "emitter" if d[ip + 0x14] else "global", "type": d[ip + 0x15]}
        elif kind == 36:
            t["field"] = {"inner_speed": f32(d, ip), "outer_speed": f32(d, ip + 4), "radius": f32(d, ip + 8),
                          "axis_rot": vec(d, ip + 0xC, 3), "space": "emitter" if d[ip + 0x18] else "global",
                          "type": d[ip + 0x19]}
        else:
            t["info_raw"] = d[ip:ip + info_s].hex()
    return t


def parse_reff(d):
    ver, pname, ents = _project_entries(d, b"REFF")
    ems = []
    for name, o, size in ents:
        dsz = u32(d, o + 4)
        desc = o + 8
        e = {"name": name, "desc_size": dsz}
        e.update(parse_emitter_desc(d, desc))
        po = desc + dsz
        psz = u32(d, po)
        e["particle"] = parse_particle(d, po + 4, psz)
        q = po + 4 + psz
        npt, npti = u16(d, q), u16(d, q + 2)
        psizes = [u32(d, q + 4 + 4 * npt + 4 * i) for i in range(npt)]
        q2 = q + 4 + 8 * npt
        net, neti = u16(d, q2), u16(d, q2 + 2)
        esizes = [u32(d, q2 + 4 + 4 * net + 4 * i) for i in range(net)]
        t = q2 + 4 + 8 * net
        ptracks, etracks = [], []
        for i, s in enumerate(psizes):
            tr = parse_track(d, t, s)
            tr["init_only"] = i < npti
            ptracks.append(tr)
            t += s
        for i, s in enumerate(esizes):
            tr = parse_track(d, t, s)
            tr["init_only"] = i < neti
            etracks.append(tr)
            t += s
        e["particle_tracks"] = ptracks
        e["emitter_tracks"] = etracks
        if t != o + size:
            e["parse_warning"] = "consumed %d of %d bytes" % (t - o, size)
        ems.append(e)
    return {"version": ver, "project": pname, "emitters": ems}


# ------------------------------------------------------------------ build

def _round(o):
    if isinstance(o, float):
        r = round(o, 5)
        return 0.0 if r == 0 else r
    if isinstance(o, list):
        return [_round(x) for x in o]
    if isinstance(o, dict):
        return {k: _round(v) for k, v in o.items()}
    return o


def build_effects(rom, out, warnings):
    import json
    common = os.path.join(rom, "Common/RPTnkScene/common")
    res = {"tread_marks": [], "textures": [], "emitters_json": "effects/basic_tank.json"}
    # tread marks
    fm = os.path.join(common, "tnk_footmark")
    for f in sorted(os.listdir(fm)):
        if not f.endswith(".bti"):
            continue
        b = parse_bti(open(os.path.join(fm, f), "rb").read())
        w, h, rgba = b["images"][0]
        rel = "tread_marks/%s.png" % f[:-4]
        os.makedirs(os.path.join(out, "tread_marks"), exist_ok=True)
        open(os.path.join(out, rel), "wb").write(gxtex.png_rgba(w, h, rgba))
        res["tread_marks"].append({"file": "effects/" + rel, "source": "tnk_footmark/" + f,
                                   **{k: v for k, v in b.items() if k != "images"},
                                   "alpha": gxtex.alpha_kind(rgba)})
    # REFT
    reft = parse_reft(open(os.path.join(common, "basic_tank.breft"), "rb").read())
    os.makedirs(os.path.join(out, "textures"), exist_ok=True)
    for t in reft["textures"]:
        w, h, rgba = t["images"][0]
        rel = "textures/%s.png" % t["name"]
        open(os.path.join(out, rel), "wb").write(gxtex.png_rgba(w, h, rgba))
        res["textures"].append({"file": "effects/" + rel, **{k: v for k, v in t.items() if k != "images"},
                                "alpha": gxtex.alpha_kind(rgba)})
    # REFF
    reff = parse_reff(open(os.path.join(common, "basic_tank.breff"), "rb").read())
    for e in reff["emitters"]:
        if "parse_warning" in e:
            warnings.append("REFF %s: %s" % (e["name"], e["parse_warning"]))
    reff["texture_files"] = {t["name"]: "textures/%s.png" % t["name"] for t in reft["textures"]}
    with open(os.path.join(out, "basic_tank.json"), "w") as f:
        json.dump(_round(reff), f, indent=1)
        f.write("\n")
    res["emitter_count"] = len(reff["emitters"])
    return res
