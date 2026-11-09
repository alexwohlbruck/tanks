#!/usr/bin/env python3
"""Tanks! 3D asset pipeline entry point.

    python3 tools/g3d/build_models.py [--rom build/rom/x] [--out public/assets]

Reads the extracted ROM tree and writes:
  public/assets/models/<brres>__<mdl0>.glb      one GLB per MDL0
  public/assets/models/textures/<brres>/*.png    every TEX0 (base level; mips in mips/)
  public/assets/models/animations/*.json         SRT0 / CLR0 / PAT0 / VIS0 / CHR0 sidecars
  public/assets/models/scene.json                SCN0 (sceneFile.brres) + RP light files
  public/assets/models/manifest.json             index of everything above
  public/assets/effects/...                      tread marks, REFT textures, REFF emitters
"""
import argparse
import json
import os
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import brres  # noqa: E402
import convert  # noqa: E402
import gxtex  # noqa: E402
import scn0  # noqa: E402
import effects  # noqa: E402
from binutil import rlist  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
G3D_DIR = "Common/RPTnkScene/common/G3D"
MODEL_FILES = ["tnk_tank", "tnk_block", "tnk_block_shadow", "tnk_field_16_9", "tnk_field_4_3",
               "tnk_mine", "shell", "tnk_check", "sceneFile"]
ANIM_FOLDERS = {
    "AnmChr(NW4R)": brres.parse_chr0, "AnmTexSrt(NW4R)": brres.parse_srt0,
    "AnmClr(NW4R)": brres.parse_clr0, "AnmTexPat(NW4R)": brres.parse_pat0,
    "AnmVis(NW4R)": brres.parse_vis0,
}


def jdump(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, sort_keys=False)
        f.write("\n")


def wbin(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def round_floats(o, n=5):
    if isinstance(o, float):
        r = round(o, n)
        return 0.0 if r == 0 else r
    if isinstance(o, list):
        return [round_floats(x, n) for x in o]
    if isinstance(o, tuple):
        return [round_floats(x, n) for x in o]
    if isinstance(o, dict):
        return {k: round_floats(v, n) for k, v in o.items()}
    return o


def model_anims(anims, mname, mat_names, bone_names, all_models):
    """Animations of the same BRRES that drive this model.

    NW4R binds by material/bone name, so a PAT0 named after a *different*
    model with the same material name would also bind; the game pairs them by
    name (tnk_block_7 <-> PAT0 tnk_block_7), so prefer exact name matches.
    """
    out = []
    for a in anims:
        if not (set(a["targets"]) & set(mat_names) or set(a["targets"]) & set(bone_names)):
            continue
        if a["name"] in all_models and a["name"] != mname:
            continue
        out.append(a["file"])
    return out


def material_summary(mat, an):
    """Manifest record for one material (TEV config + chosen glTF mapping)."""
    return {
        "name": mat["name"], "index": mat["index"], "pass": "xlu" if mat["xlu"] else "opa",
        "cull": mat["cull"], "light_set": mat["light_set"], "fog_set": mat["fog_set"],
        "textures": [{k: l[k] for k in ("texture", "palette", "texmap_id", "wrap_s", "wrap_t",
                                        "min_filter", "mag_filter", "lod_bias", "max_aniso")}
                     | {"map_mode": l["effect"]["map_mode"], "srt": l["srt"]}
                     for l in mat["layers"]],
        "texgens": mat["texgens"],
        "light_channels": mat["light_channels"],
        "tev": {
            "stages": [{
                "texmap": s["texmap"], "texcoord": s["texcoord"], "raster": s["raster"],
                "konst_color_sel": s["konst_color_sel"], "konst_alpha_sel": s["konst_alpha_sel"],
                "color": s["color"]["expr"], "alpha": s["alpha"]["expr"],
                "color_detail": s["color"], "alpha_detail": s["alpha"]}
                for s in mat["tev"]["stages"]],
            "swap_tables": mat["tev"]["swap_tables"],
            "color_registers": mat["tev_colors"]["registers"],
            "konst_colors": mat["tev_colors"]["konst"],
        },
        "pixel_engine": mat["pe"],
        "gltf": {k: an[k] for k in ("base_texture", "base_factor", "use_vertex_color", "unlit",
                                    "alpha_mode", "alpha_cutoff", "double_sided")},
        "env_add": an["env_textures"],
        "custom_shader_needed": an["custom"],
    }


def build(rom, out):
    t0 = time.time()
    models_dir = os.path.join(out, "models")
    warnings = []
    manifest = {
        "generated_by": "tools/g3d/build_models.py",
        "units": {"up_axis": "+Y", "handedness": "right", "unit": "G3D model units (1 map cell = 35)",
                  "grid_cell": 35.0},
        "models": [], "textures": {}, "animations": [], "scene": "scene.json",
    }
    stats = []
    for fname in MODEL_FILES:
        path = os.path.join(rom, G3D_DIR, fname + ".brres")
        b = brres.Brres(open(path, "rb").read(), fname)
        d = b.d
        pals = b.palettes()
        # ---- textures
        pngs, texinfo = {}, {}
        for tname, to in b.items("Textures(NW4R)"):
            t = brres.parse_tex0(d, to, None, decode=False)
            pal = pals.get(tname) if t["is_ci"] else None
            t = brres.parse_tex0(d, to, pal)
            w, h, rgba = t["images"][0]
            png = gxtex.png_rgba(w, h, rgba)
            pngs[tname] = png
            rel = "textures/%s/%s.png" % (fname, tname)
            wbin(os.path.join(models_dir, rel), png)
            mips = []
            for li, (mw, mh, mrgba) in enumerate(t["images"][1:], 1):
                mrel = "textures/%s/mips/%s.mip%d.png" % (fname, tname, li)
                wbin(os.path.join(models_dir, mrel), gxtex.png_rgba(mw, mh, mrgba))
                mips.append(mrel)
            texinfo[tname] = {"file": rel, "width": w, "height": h, "format": t["format"],
                              "levels": t["levels"], "alpha": gxtex.alpha_kind(rgba),
                              "mips": mips, "palette": pal["format"] if pal else None}
        if texinfo:
            manifest["textures"][fname] = texinfo
        # ---- animations
        anims_here = []
        for folder, fn in ANIM_FOLDERS.items():
            for aname, ao in b.items(folder):
                a = fn(d, ao)
                rel = "animations/%s__%s.%s.json" % (fname, aname, a["type"].lower())
                jdump(os.path.join(models_dir, rel), round_floats(a))
                ent = {"file": rel, "brres": fname, "name": aname, "type": a["type"],
                       "frames": a["frames"], "loop": a["loop"],
                       "targets": [m["material"] for m in a.get("materials", [])]
                       + [x["bone"] if isinstance(x, dict) else x for x in a.get("bones", [])]}
                anims_here.append(ent)
                manifest["animations"].append(ent)
        # CLR0 register defaults (frame 0) keyed by material name
        reg_over = {}
        for aname, ao in b.items("AnmClr(NW4R)"):
            a = brres.parse_clr0(d, ao)
            for m in a["materials"]:
                for tgt, val in m["targets"].items():
                    if tgt.startswith("tev_color"):
                        c = val["const"] if "const" in val else val["frames"][0]
                        reg_over.setdefault(m["material"], {})["C%s" % tgt[-1]] = c
        # ---- models
        for mname, mo in b.items("3DModels(NW4R)"):
            mdl = brres.parse_mdl0(d, mo)
            glb, info = convert.convert_model(mdl, fname, texinfo, pngs, warnings, reg_over)
            rel = "%s__%s.glb" % (fname, mname)
            wbin(os.path.join(models_dir, rel), glb)
            mat_names = [m["name"] for m in mdl["materials"]]
            entry = {
                "file": rel, "brres": fname, "mdl0": mname,
                "nodes": [{"name": bo["name"], "index": bo["index"],
                           "parent": next((x["name"] for x in mdl["bones"] if x["index"] == bo["parent"]), None),
                           "translation": rlist(bo["translation"], 5),
                           "rotation_deg_xyz": rlist(bo["rotation_deg"], 5),
                           "scale": rlist(bo["scale"], 5), "billboard": bo["billboard"],
                           "flags": bo["flag_names"],
                           "box_min": rlist(bo["box_min"], 4), "box_max": rlist(bo["box_max"], 4),
                           "world": info["bone_world_matrices"][bo["name"]]}
                          for bo in mdl["bones"]],
                "meshes": info["meshes"],
                "materials": [material_summary(m, a) for m, a in zip(mdl["materials"], info["material_analysis"])],
                "textures": sorted({l["texture"] for m in mdl["materials"] for l in m["layers"]}),
                "animations": model_anims(anims_here, mname, mat_names, [bo["name"] for bo in mdl["bones"]],
                                          [x for x, _ in b.items("3DModels(NW4R)")]),
                "bounds": info["bounds"],
                "counts": {"vertices_header": mdl["info"]["vertex_count"],
                           "faces_header": mdl["info"]["face_count"],
                           "vertices_out": sum(m["vertices"] for m in info["meshes"]),
                           "triangles_out": sum(m["triangles"] for m in info["meshes"])},
                "vertex_arrays": {k: [{x: a[x] for x in a if x != "data"} for a in mdl[k]]
                                  for k in ("positions", "normals", "colors", "uvs")},
                "draw_lists": {k: v for k, v in mdl["defs"].items() if k.startswith("Draw")},
                "info": mdl["info"],
                "winding_check": info["winding_check"],
            }
            manifest["models"].append(round_floats(entry))
            stats.append((rel, entry["counts"], info["bounds"]))
        # ---- scene
        for sname, so in b.items("AnmScn(NW4R)"):
            pass
    # SCN0 + RP environment files
    scene = scn0.build_scene(rom)
    jdump(os.path.join(models_dir, "scene.json"), round_floats(scene))
    # effects
    eff = effects.build_effects(rom, os.path.join(out, "effects"), warnings)
    manifest["effects"] = eff
    manifest["warnings"] = warnings
    jdump(os.path.join(models_dir, "manifest.json"), manifest)
    for rel, c, bnd in stats:
        print("%-44s verts %5d tris %5d  min %s max %s" % (rel, c["vertices_out"], c["triangles_out"],
                                                          bnd["min"], bnd["max"]))
    for w in warnings:
        print("WARN", w)
    print("done in %.1fs" % (time.time() - t0))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rom", default=os.path.join(ROOT, "build/rom/x"))
    ap.add_argument("--out", default=os.path.join(ROOT, "public/assets"))
    ap.add_argument("--debug", action="store_true",
                    help="also write texture contact sheets and software renders to models/_debug/")
    args = ap.parse_args()
    build(args.rom, args.out)
    if args.debug:
        debug_sheets(args.out)


def debug_sheets(out):
    """Contact sheets of every decoded texture + headless renders of the GLBs."""
    import contact_sheet
    import preview_render
    dbg = os.path.join(out, "models", "_debug")
    os.makedirs(dbg, exist_ok=True)
    tex_root = os.path.join(out, "models", "textures")
    for b in sorted(os.listdir(tex_root)):
        d = os.path.join(tex_root, b)
        files = sorted(os.path.join(d, f) for f in os.listdir(d) if f.endswith(".png"))
        with open(os.path.join(dbg, "contact_%s.png" % b), "wb") as f:
            f.write(contact_sheet.sheet(files, 96, 8))
        with open(os.path.join(dbg, "contact_%s.txt" % b), "w") as f:
            f.write("\n".join("%d %s" % (i, os.path.basename(x)) for i, x in enumerate(files)) + "\n")
    eff = os.path.join(out, "effects")
    files = sorted(os.path.join(eff, "textures", f) for f in os.listdir(os.path.join(eff, "textures")))
    files += sorted(os.path.join(eff, "tread_marks", f) for f in os.listdir(os.path.join(eff, "tread_marks")))
    with open(os.path.join(dbg, "contact_effects.png"), "wb") as f:
        f.write(contact_sheet.sheet(files, 96, 8))
    with open(os.path.join(dbg, "contact_effects.txt"), "w") as f:
        f.write("\n".join("%d %s" % (i, os.path.relpath(x, eff)) for i, x in enumerate(files)) + "\n")
    m = os.path.join(out, "models")
    groups = {
        "render_units": ["tnk_tank__tnk_tank_1p", "tnk_tank__tnk_tank_2p", "tnk_tank__tnk_tank_e_1",
                         "tnk_mine__tnk_mine", "shell__shell", "tnk_check__tnk_check_red"],
        "render_blocks": ["tnk_block__tnk_block_1", "tnk_block__tnk_block_7", "tnk_block__tnk_block_8",
                          "tnk_block_shadow__tnk_block_shadow"],
        "render_fields": ["tnk_field_16_9__tnk_field_16_9_out", "tnk_field_4_3__tnk_field_4_3_out"],
    }
    for name, models in groups.items():
        tiles = [preview_render.render(preview_render.tris_of(os.path.join(m, x + ".glb"), {}), 200,
                                       35 if name != "render_fields" else 0,
                                       30 if name != "render_fields" else 50) for x in models]
        W = 200 * len(tiles)
        img = bytearray(W * 200 * 4)
        for n, t in enumerate(tiles):
            for y in range(200):
                img[(y * W + n * 200) * 4:(y * W + (n + 1) * 200) * 4] = t[y * 800:(y + 1) * 800]
        with open(os.path.join(dbg, name + ".png"), "wb") as f:
            f.write(gxtex.png_rgba(W, 200, img))


if __name__ == "__main__":
    main()
