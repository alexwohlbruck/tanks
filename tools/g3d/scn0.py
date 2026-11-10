"""SCN0 (NW4R scene animation: light sets, ambient lights, lights, fog,
cameras) and the RP/EGG environment files scene_Light.plight (LGHT) and
scene_Lm.plmap (LMAP).  Produces the dict written to models/scene.json.
"""
import os

import brres
from binutil import u8, u16, s16, u32, s32, f32, vec, cstr

LIGHT_TYPE = {0: "point", 1: "directional", 2: "spot"}
DIST_FN = {0: "off", 1: "gentle", 2: "medium", 3: "steep"}
SPOT_FN = {0: "off", 1: "flat", 2: "cos", 3: "cos2", 4: "sharp", 5: "ring1", 6: "ring2"}
FOG_TYPE = {0: "none", 2: "perspective_linear", 3: "perspective_exp", 4: "perspective_exp2",
            5: "perspective_revexp", 6: "perspective_revexp2", 10: "ortho_linear",
            11: "ortho_exp", 12: "ortho_exp2", 13: "ortho_revexp", 14: "ortho_revexp2"}


def _hdr(d, o):
    return {"name": cstr(d, o + s32(d, o + 8)), "node_index": u32(d, o + 12), "real_id": u32(d, o + 16)}


def _fval(d, o, fixed, frames):
    """Fixed float, or offset (relative to the field) to a hermite key list."""
    if fixed:
        return f32(d, o)
    ko = o + s32(d, o)
    return {"keys": brres.hermite_keys(d, ko)}


def _cval(d, o, fixed, frames):
    if fixed:
        return list(d[o:o + 4])
    ao = o + s32(d, o)
    return {"frames": [list(d[ao + 4 * i:ao + 4 * i + 4]) for i in range(frames + 1)]}


def parse_scn0(d, o):
    assert d[o:o + 4] == b"SCN0"
    ver = u32(d, o + 8)
    base = o + 0x10 + (4 if ver >= 5 else 0)
    offs = [s32(d, base + 4 * i) for i in range(6)]  # data, lightset, amb, light, fog, camera
    name = cstr(d, o + s32(d, base + 0x18))
    frames, nspec = u16(d, base + 0x20), u16(d, base + 0x22)
    loop = u32(d, base + 0x24)
    nls, namb, nlight, nfog, ncam = (u16(d, base + 0x28 + 2 * i) for i in range(5))
    sc = {"type": "SCN0", "version": ver, "name": name, "frames": frames, "loop": bool(loop),
          "specular_light_count": nspec, "light_sets": [], "ambient_lights": [], "lights": [],
          "fogs": [], "cameras": []}

    # light sets (0x4C)
    for i in range(nls):
        e = o + offs[1] + i * 0x4C
        ls = _hdr(d, e)
        amb_off = s32(d, e + 0x14)
        # ambient name: relative to the light-set start; light names: relative to the name array
        ls["ambient"] = cstr(d, e + amb_off) if amb_off else None
        n = d[e + 0x1A]
        ls["lights"] = [cstr(d, e + 0x1C + s32(d, e + 0x1C + 4 * k)) for k in range(n)]
        sc["light_sets"].append(ls)
    # ambient lights (0x1C)
    for i in range(namb):
        e = o + offs[2] + i * 0x1C
        a = _hdr(d, e)
        fixed = d[e + 0x14]
        flags = d[e + 0x17]
        a["enable_color"] = bool(flags & 1)
        a["enable_alpha"] = bool(flags & 2)
        a["color"] = _cval(d, e + 0x18, fixed & 0x80, frames)
        sc["ambient_lights"].append(a)
    # lights (0x5C)
    for i in range(nlight):
        e = o + offs[3] + i * 0x5C
        L = _hdr(d, e)
        fixed = u16(d, e + 0x1C)
        usage = u16(d, e + 0x1E)
        L["spec_light_index"] = s32(d, e + 0x14)
        L["fixed_flags"] = "%04x" % fixed
        L["usage_flags"] = "%04x" % usage
        L["type"] = LIGHT_TYPE.get(usage & 3, usage & 3)
        L["enable_color"] = bool(usage & 4)
        L["enable_alpha"] = bool(usage & 8)
        L["enabled"] = bool(usage & 0x10)
        L["specular"] = bool(usage & 0x20)
        allfixed = fixed == 0xFFF8 or frames <= 1
        L["position"] = [_fval(d, e + 0x24 + 4 * k, allfixed, frames) for k in range(3)]
        L["color"] = _cval(d, e + 0x30, allfixed, frames)
        L["aim"] = [_fval(d, e + 0x34 + 4 * k, allfixed, frames) for k in range(3)]
        L["dist_fn"] = DIST_FN.get(u32(d, e + 0x40), u32(d, e + 0x40))
        L["ref_distance"] = f32(d, e + 0x44)
        L["ref_brightness"] = f32(d, e + 0x48)
        L["spot_cutoff_deg"] = f32(d, e + 0x4C)
        L["spot_fn"] = SPOT_FN.get(u32(d, e + 0x50), u32(d, e + 0x50))
        L["specular_color"] = list(d[e + 0x54:e + 0x58])
        L["shininess"] = f32(d, e + 0x58)
        if L["type"] == "directional":
            p = L["position"]
            a = L["aim"]
            if all(isinstance(x, float) for x in p + a):
                dv = [a[k] - p[k] for k in range(3)]
                ln = sum(x * x for x in dv) ** 0.5 or 1
                L["direction"] = [x / ln for x in dv]
        sc["lights"].append(L)
    # fog (0x20?)
    for i in range(nfog):
        e = o + offs[4] + i * 0x24
        F = _hdr(d, e)
        F["flags"] = "%08x" % u32(d, e + 0x14)
        F["type"] = FOG_TYPE.get(u32(d, e + 0x18), u32(d, e + 0x18))
        F["start"] = f32(d, e + 0x1C)
        F["end"] = f32(d, e + 0x20)
        sc["fogs"].append(F)
    # cameras (0x5C)
    for i in range(ncam):
        e = o + offs[5] + i * 0x5C
        C = _hdr(d, e)
        C["projection"] = "orthographic" if u32(d, e + 0x14) == 1 else "perspective"
        C["fixed_flags"] = "%04x" % u16(d, e + 0x18)
        fl2 = u16(d, e + 0x1A)
        C["flags2"] = "%04x" % fl2
        C["mode"] = "aim" if fl2 & 1 else "rotate"
        C["position"] = vec(d, e + 0x20, 3)
        C["aspect"] = f32(d, e + 0x2C)
        C["near"] = f32(d, e + 0x30)
        C["far"] = f32(d, e + 0x34)
        C["rotation_deg"] = vec(d, e + 0x38, 3)
        C["aim"] = vec(d, e + 0x44, 3)
        C["twist_deg"] = f32(d, e + 0x50)
        C["fovy_deg"] = f32(d, e + 0x54)
        C["ortho_height"] = f32(d, e + 0x58)
        C["up_note"] = "aim cameras use world +Y up rotated by twist"
        sc["cameras"].append(C)
    return sc


# ------------------------------------------------------------------ EGG / RP light files

def parse_plight(d):
    """scene_Light.plight: EGG LightManager binary ('LGHT', version 1).

    Header 0x48: magic, size, u8 version, ..., u16 lobj count @0x10,
    global ambient RGBA @0x14, 8 ambient RGBA colours @0x18.
    LOBJ (0x50 each): position @0x18, aim @0x24, intensity @0x30, colour @0x34,
    specular colour @0x38, spot cutoff @0x3C, ref distance @0x40,
    ref brightness @0x44, spot fn u8 @0x48, dist fn u8 @0x49.
    Bytes 0x10-0x17 are reported raw (index / flags; meaning partly unknown).
    """
    assert d[:4] == b"LGHT"
    out = {"magic": "LGHT", "size": u32(d, 4), "version": d[8], "lobj_count": u16(d, 0x10),
           "unk_12": u16(d, 0x12), "global_ambient": list(d[0x14:0x18]),
           "ambient_colors": [list(d[0x18 + 4 * i:0x1C + 4 * i]) for i in range(8)], "lights": []}
    p = 0x48
    while p + 0x50 <= len(d) and d[p:p + 4] == b"LOBJ":
        e = p
        out["lights"].append({
            "raw_10_17": d[e + 0x10:e + 0x18].hex(),
            "ambient_or_type_byte": d[e + 0x12], "kind_byte": d[e + 0x13],
            "index": u16(d, e + 0x14), "flags": "%04x" % u16(d, e + 0x16),
            "position": vec(d, e + 0x18, 3), "aim": vec(d, e + 0x24, 3),
            "intensity": f32(d, e + 0x30), "color": list(d[e + 0x34:e + 0x38]),
            "specular_color": list(d[e + 0x38:e + 0x3C]), "spot_cutoff_deg": f32(d, e + 0x3C),
            "ref_distance": f32(d, e + 0x40), "ref_brightness": f32(d, e + 0x44),
            "spot_fn": SPOT_FN.get(d[e + 0x48], d[e + 0x48]),
            "dist_fn": DIST_FN.get(d[e + 0x49], d[e + 0x49]),
            "raw_4c": "%08x" % u32(d, e + 0x4C),
        })
        p += 0x50
    return out


def parse_plmap(d):
    """scene_Lm.plmap: EGG LightTextureManager binary ('LMAP').

    Only the header and the LTEX (light texture) names/colours are decoded;
    the per-texture light-binding tables are dumped as hex.
    """
    assert d[:4] == b"LMAP"
    out = {"magic": "LMAP", "size": u32(d, 4), "ltex_count": u16(d, 0x10),
           "header_colors": [list(d[0x14 + 4 * i:0x18 + 4 * i]) for i in range(3)], "textures": []}
    p = 0x20
    while p + 8 <= len(d) and d[p:p + 4] == b"LTEX":
        size = u32(d, p + 4)
        out["textures"].append({"offset": p, "size": size,
                                "colors": [list(d[p + 8 + 4 * i:p + 12 + 4 * i]) for i in range(3)],
                                "name": cstr(d, p + 0x14), "raw": d[p + 0x20:p + size].hex()})
        p += size
    return out


def build_scene(rom):
    scene = {"notes": [
        "SCN0 from Common/*/common/G3D/sceneFile.brres (identical in RPTnkScene, RPPartyCommon,",
        "PartyStatic). Its single camera is a generic default; the Tanks arena camera is set in code.",
        "Light sets: material light_set index N selects scene light_sets[N] (G3D binds the",
        "set's lights to GX light slots 0..7 and its ambient to the channel ambient colour).",
    ]}
    import math
    s42, c42 = math.sin(math.radians(42)), math.cos(math.radians(42))
    scene["tanks_runtime"] = {
        "source": "the decompilation (build/decomp): RPTnkScene.cpp, RPTnkCamera.cpp, "
                  "RPTnkField.cpp, RPGrpRenderer.cpp, egg/gfxe/eggFrustum.cpp - code constants, "
                  "not ROM data",
        "field_camera": {
            "projection": "orthographic (RPGrpView::EProjType_Ortho, canvas CC = centred)",
            "position": [0.0, round(2000 * s42, 4), round(2000 * c42 - 14.0, 4)],
            "target": [0.0, 0.0, -14.0],
            "up": [0.0, round(c42, 6), round(-s42, 6)],
            "elevation_deg": 42.0,
            "screen_scale": 1.125,
            "ortho_extent_note": "visible half-extents = 1.125 * 0.5 * screen size; screen size is "
                                 "the RP root screen: width 608 (4:3) or 832 (16:9), height = EFB "
                                 "height passed to RPGrpScreen::Initialize (RPGrpRenderer.cpp)",
            "intro_flyin": {"start": [0, 5, 120], "path": [[0, 5, 155], [0, 8, 175], [0, 10, 190], [0, 2000, 0]],
                            "target_start": [0, 15, 0], "speed_per_frame": 1.0 / 150,
                            "slowdown": "after t>=0.9 speed *= 0.94 per frame (min 0.002)"},
        },
        "main_light": {"note": "RPTnkScene::LoadResource loads SCN0 'RPScene' then moves light 0 "
                               "(Main_Light) to (0, 10000, 0): a straight-down directional light",
                       "position": [0.0, 10000.0, 0.0], "aim": [0.0, 0.0, 0.0]},
        "field": {"16_9": {"width": 770.0, "depth": 595.0, "cols": 22, "rows": 17},
                  "4_3": {"width": 560.0, "depth": 595.0, "cols": 16, "rows": 17},
                  "cell": 35.0, "world_scale": 0.742857},
    }
    p = os.path.join(rom, "Common/RPTnkScene/common/G3D/sceneFile.brres")
    b = brres.Brres(open(p, "rb").read())
    scene["scn0"] = [parse_scn0(b.d, o) for _, o in b.items("AnmScn(NW4R)")]
    scene["rp_environment"] = {}
    for pkg in ("RPCommon", "RPPartyCommon", "PartyStatic"):
        ed = os.path.join(rom, "Common", pkg, "common", "Environment")
        ent = {}
        lp = os.path.join(ed, "scene_Light.plight")
        mp = os.path.join(ed, "scene_Lm.plmap")
        if os.path.exists(lp):
            ent["plight"] = parse_plight(open(lp, "rb").read())
        if os.path.exists(mp):
            ent["plmap"] = parse_plmap(open(mp, "rb").read())
        if ent:
            scene["rp_environment"][pkg] = ent
    return scene
