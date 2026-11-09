"""MDL0 (parsed dict) -> glTF 2.0 binary + manifest summary."""
import math

import gltf as G
import gxdl
import gxtex
from binutil import rf, rlist


# ------------------------------------------------------------------ math

def mat_identity():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]


def mat_mul(a, b):
    """3x4 row-major affine multiply a*b."""
    r = [0.0] * 12
    for i in range(3):
        for j in range(4):
            v = sum(a[i * 4 + k] * b[k * 4 + j] for k in range(3))
            if j == 3:
                v += a[i * 4 + 3]
            r[i * 4 + j] = v
    return r


def mat_trs(t, r_deg, s):
    rx, ry, rz = (math.radians(x) for x in r_deg)
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    # R = Rz * Ry * Rx  (X applied first) – NW4R "standard"/maya rotation order
    R = [
        cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz,
        cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - cz * sx,
        -sy, cy * sx, cx * cy,
    ]
    m = [R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0],
         R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1],
         R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2]]
    return m


def quat_from_euler_deg(r):
    hx, hy, hz = (math.radians(a) / 2 for a in r)
    qx = (math.sin(hx), 0, 0, math.cos(hx))
    qy = (0, math.sin(hy), 0, math.cos(hy))
    qz = (0, 0, math.sin(hz), math.cos(hz))

    def qm(a, b):
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return (aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
                aw * bw - ax * bx - ay * by - az * bz)
    return qm(qz, qm(qy, qx))


def xform(m, p):
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]]


def xform_dir(m, p):
    return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
            m[4] * p[0] + m[5] * p[1] + m[6] * p[2],
            m[8] * p[0] + m[9] * p[1] + m[10] * p[2]]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def normalize(v):
    l = math.sqrt(dot(v, v))
    return [x / l for x in v] if l > 1e-12 else [0.0, 1.0, 0.0]


# ------------------------------------------------------------------ TEV analysis

def konst_value(sel, konst):
    """Resolve a KCSEL/KASEL name to an RGBA 0..1 tuple."""
    fr = {"1": 1, "7/8": .875, "3/4": .75, "5/8": .625, "1/2": .5, "3/8": .375, "1/4": .25, "1/8": .125}
    if sel in fr:
        v = fr[sel]
        return [v, v, v, v]
    k = konst.get(sel[:2], [0, 0, 0, 0])
    if len(sel) == 2:
        return [c / 255 for c in k]
    comp = {"R": 0, "G": 1, "B": 2, "A": 3}[sel[3]]
    v = k[comp] / 255
    return [v, v, v, v]


def analyze_material(mat, model_has_color):
    """Pick the closest glTF representation for a TEV material.

    Returns dict with glTF-relevant decisions plus a list of things a custom
    shader would need to replicate exactly.
    """
    layers_by_map = {l["texmap_id"]: l for l in mat["layers"]}
    konst = mat["tev_colors"]["konst"]
    regs = mat["tev_colors"]["registers"]
    chan0 = mat["light_channels"][0] if mat["light_channels"] else None
    res = {"base_texture": None, "base_factor": [1, 1, 1, 1], "use_vertex_color": False,
           "unlit": False, "env_textures": [], "custom": [], "alpha_mode": "OPAQUE",
           "alpha_cutoff": None, "double_sided": mat["cull"] == "none"}
    uses_ras = False
    for st in mat["tev"]["stages"]:
        c, a = st["color"], st["alpha"]
        lay = layers_by_map.get(st["texmap"]) if st["texmap"] is not None else None
        ins = [c["a"], c["b"], c["c"], c["d"]]
        ains = [a["a"], a["b"], a["c"], a["d"]]
        if "RASC" in ins or "RASA" in ins or "RASA" in ains:
            uses_ras = True
        kc = konst_value(st["konst_color_sel"], konst)
        ka = konst_value(st["konst_alpha_sel"], konst)
        is_env = lay is not None and lay["effect"]["map_mode"] != "texcoord"
        # colour
        if c["d"] == "CPREV" and c["a"] == "ZERO" and c["b"] == "TEXC" and lay is not None:
            scale = kc[:3] if c["c"] == "KONST" else ([1, 1, 1] if c["c"] == "ONE" else None)
            res["env_textures" if is_env else "custom"].append(
                {"op": "add", "texture": lay["texture"], "map_mode": lay["effect"]["map_mode"],
                 "scale_rgb": [rf(x, 4) for x in scale] if scale else c["c"]}
                if is_env else "stage %d adds texture %s" % (st["stage"], lay["texture"]))
        elif c["d"] == "ZERO" and c["a"] == "ZERO" and "TEXC" in (c["b"], c["c"]) and lay is not None and res["base_texture"] is None and not is_env:
            res["base_texture"] = lay["texture"]
            other = c["c"] if c["b"] == "TEXC" else c["b"]
            if other == "KONST":
                res["base_factor"][:3] = kc[:3]
        elif c["a"] == "ZERO" and c["d"] == "ZERO" and c["b"] in ("C0", "C1", "C2") and c["c"] in ("RASC", "ONE"):
            reg = regs.get(c["b"], [255, 255, 255, 255])
            res["base_factor"][:3] = [max(0, min(255, x)) / 255 for x in reg[:3]]
            res["base_from_register"] = c["b"]
        elif c["d"] == "ZERO" and c["a"] == "ZERO" and c["b"] == "TEXC" and c["c"] == "ONE" and c["dest"] != "PREV":
            pass  # texture stored into a register for a later stage
        elif c["b"] == "TEXC" and c["c"] == "ONE":
            pass
        elif "lerp" in c["expr"]:
            res["custom"].append("stage %d: %s (texmap %s=%s)" % (
                st["stage"], c["expr"], st["texmap"], lay["texture"] if lay else None))
        # alpha
        if st["stage"] == 0 or a["dest"] == "PREV":
            if a["b"] == "TEXA" and a["c"] == "KONST" and a["a"] == "ZERO":
                res["base_factor"][3] = ka[3]
    # register-to-register stages (e.g. the field blend) -> use first texture as a fallback base
    if res["base_texture"] is None:
        for l in mat["layers"]:
            if l["effect"]["map_mode"] == "texcoord":
                res["base_texture"] = l["texture"]
                break
    if mat["tev"]["stages"] and "lerp" in mat["tev"]["stages"][-1]["color"]["expr"]:
        # field: PREV = lerp(C0, C1, TEX2): pick the 'C1' (face) texture as base
        st = mat["tev"]["stages"]
        names = [layers_by_map[s["texmap"]]["texture"] for s in st if s["texmap"] in layers_by_map]
        if len(names) >= 2:
            res["base_texture"] = names[1]
    if chan0:
        cc = chan0["color_ctrl"]
        if uses_ras and cc["mat_src"] == "vertex" and model_has_color:
            res["use_vertex_color"] = True
        if uses_ras and cc["mat_src"] == "register":
            mc = chan0["mat_color"]
            res["base_factor"][:3] = [res["base_factor"][i] * mc[i] / 255 for i in range(3)]
        if not cc["lighting"] or not uses_ras:
            res["unlit"] = True
    pe = mat["pe"]
    at = pe.get("alpha_test", {})
    if pe.get("blend", {}).get("enable"):
        res["alpha_mode"] = "BLEND"
        b = pe["blend"]
        if (b["src"], b["dst"]) != ("src_alpha", "inv_src_alpha") or b["subtract"]:
            res["custom"].append("blend %s/%s%s" % (b["src"], b["dst"], " subtract" if b["subtract"] else ""))
    elif at and not (at["comp0"] == "always" and (at["op"] in ("and",) and at["comp1"] == "always")):
        res["alpha_mode"] = "MASK"
        if at["comp0"] in ("gequal", "greater"):
            res["alpha_cutoff"] = at["ref0"] / 255
        else:
            res["alpha_cutoff"] = 0.5
            res["custom"].append("alpha test %s" % at)
    if mat["cull"] == "front":
        res["custom"].append("cull front faces (render BackSide)")
    if mat["cull"] == "all":
        res["custom"].append("cull all (invisible)")
    if res["env_textures"]:
        res["custom"].append("additive sphere-env map (%s) – see docs/models.md" %
                             ", ".join(e["texture"] for e in res["env_textures"]))
    if not pe.get("z", {}).get("write", True) and res["alpha_mode"] != "BLEND":
        res["custom"].append("depthWrite=false")
    if res["alpha_mode"] == "OPAQUE":
        res["base_factor"][3] = 1.0  # alpha is ignored by GX here (no blend / alpha test)
    res["base_factor"] = [rf(x, 4) for x in res["base_factor"]]
    return res


# ------------------------------------------------------------------ conversion

def bone_world_matrices(bones):
    worlds = {}
    for b in sorted(bones, key=lambda x: x["index"]):
        local = mat_trs(b["translation"], b["rotation_deg"], b["scale"])
        p = b["parent"]
        worlds[b["index"]] = mat_mul(worlds[p], local) if p is not None else local
    return worlds


def convert_model(mdl, brres_name, tex_lookup, png_lookup, warnings, reg_overrides=None):
    """Build a GLB for one MDL0. Returns (glb_bytes, manifest_entry)."""
    gb = G.GltfBuilder()
    bones = mdl["bones"]
    worlds = bone_world_matrices(bones)
    # sanity: compare against the bind matrices stored in the file
    max_err = 0.0
    for b in bones:
        w = worlds[b["index"]]
        max_err = max(max_err, max(abs(w[i] - b["world"][i]) for i in range(12)))
    if max_err > 1e-3:
        warnings.append("%s: bone TRS vs stored world matrix differ by %.4g" % (mdl["name"], max_err))

    node_of_bone = {}
    for b in bones:
        n = {"name": b["name"]}
        t, r, s = b["translation"], b["rotation_deg"], b["scale"]
        if any(abs(x) > 0 for x in t):
            n["translation"] = rlist(t)
        if any(abs(x) > 0 for x in r):
            n["rotation"] = rlist(quat_from_euler_deg(r), 7)
        if any(abs(x - 1) > 0 for x in s):
            n["scale"] = rlist(s)
        n["extras"] = {"g3d_bone": True, "billboard": b["billboard"], "flags": b["flag_names"],
                       "rotation_euler_deg_xyz": rlist(r)}
        node_of_bone[b["index"]] = gb.add("nodes", n)
    for b in bones:
        if b["parent"] is not None:
            gb.j["nodes"][node_of_bone[b["parent"]]].setdefault("children", []).append(node_of_bone[b["index"]])
        else:
            gb.j["scenes"][0]["nodes"].append(node_of_bone[b["index"]])

    # ---- textures / materials
    tex_index = {}

    def get_tex(name, layer):
        key = (name, layer["wrap_s"], layer["wrap_t"], layer["min_filter"], layer["mag_filter"])
        if key in tex_index:
            return tex_index[key]
        if name not in png_lookup:
            warnings.append("%s: missing texture %s" % (mdl["name"], name))
            return None
        img_key = ("img", name)
        if img_key not in tex_index:
            tex_index[img_key] = gb.image_png(name, png_lookup[name])
        # mip filters only make sense if mips are generated; three.js does that for PNGs
        smp = gb.sampler(layer["wrap_s"], layer["wrap_t"], layer["mag_filter"], layer["min_filter"])
        tex_index[key] = gb.texture(tex_index[img_key], smp, name)
        return tex_index[key]

    model_has_color = bool(mdl["colors"])
    mat_info = []
    for mat in mdl["materials"]:
        ov = (reg_overrides or {}).get(mat["name"])
        if ov:
            # CLR0 animates a TEV colour register that is 0 in the material itself
            # (e.g. the mine's C0); use animation frame 0 as the static glTF colour.
            mat = dict(mat, tev_colors={"registers": dict(mat["tev_colors"]["registers"], **ov),
                                        "konst": mat["tev_colors"]["konst"]})
        an = analyze_material(mat, model_has_color)
        if ov:
            an["base_factor_from_clr0_frame0"] = ov
        gm = {"name": mat["name"],
              "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 1.0}}
        if an["base_factor"] != [1, 1, 1, 1]:
            gm["pbrMetallicRoughness"]["baseColorFactor"] = an["base_factor"]
        if an["base_texture"]:
            lay = next(l for l in mat["layers"] if l["texture"] == an["base_texture"])
            ti = get_tex(an["base_texture"], lay)
            if ti is not None:
                ref = {"index": ti, "texCoord": 0}
                srt = lay["srt"]
                if srt["scale"] != [1.0, 1.0] or srt["rotation_deg"] or srt["translation"] != [0.0, 0.0]:
                    gb.ext_used.add("KHR_texture_transform")
                    ref["extensions"] = {"KHR_texture_transform": {
                        "scale": rlist(srt["scale"]), "rotation": rf(math.radians(srt["rotation_deg"])),
                        "offset": rlist(srt["translation"])}}
                gm["pbrMetallicRoughness"]["baseColorTexture"] = ref
        if an["alpha_mode"] != "OPAQUE":
            gm["alphaMode"] = an["alpha_mode"]
        if an["alpha_cutoff"] is not None:
            gm["alphaCutoff"] = rf(an["alpha_cutoff"], 4)
        if an["double_sided"]:
            gm["doubleSided"] = True
        if an["unlit"]:
            gm["extensions"] = {"KHR_materials_unlit": {}}
            gb.ext_used.add("KHR_materials_unlit")
        env = []
        for e in an["env_textures"]:
            lay = next(l for l in mat["layers"] if l["texture"] == e["texture"])
            env.append(dict(e, gltf_texture=get_tex(e["texture"], lay)))
        extra_tex = []
        for l in mat["layers"]:
            if l["texture"] not in (an["base_texture"],) and l["texture"] not in [e["texture"] for e in env]:
                extra_tex.append({"texture": l["texture"], "gltf_texture": get_tex(l["texture"], l)})
        gm["extras"] = {"g3d_material": mat["name"], "env_add": env, "other_textures": extra_tex,
                        "custom_shader_needed": an["custom"], "light_set": mat["light_set"],
                        "fog_set": mat["fog_set"], "xlu": mat["xlu"]}
        gb.add("materials", gm)
        mat_info.append(an)

    # ---- draw lists
    draws = []
    for pass_name in ("DrawOpa", "DrawXlu"):
        ops = [o for o in mdl["defs"].get(pass_name, []) if o["op"] == "draw"]
        if pass_name == "DrawXlu":
            ops = sorted(ops, key=lambda o: o["priority"])  # stable
        for o in ops:
            draws.append(dict(o, **{"pass": "opa" if pass_name == "DrawOpa" else "xlu"}))
    drawn = {d["shape"] for d in draws}
    for sh in mdl["shapes"]:
        if sh["index"] not in drawn:
            warnings.append("%s: shape %s not in any draw list" % (mdl["name"], sh["name"]))

    shapes = {s["index"]: s for s in mdl["shapes"]}
    mtx_to_node = mdl["mtx_to_node"]
    pos_arr = {a["index"]: a for a in mdl["positions"]}
    nrm_arr = {a["index"]: a for a in mdl["normals"]}
    clr_arr = {a["index"]: a for a in mdl["colors"]}
    uv_arr = {a["index"]: a for a in mdl["uvs"]}

    bounds_min = [1e30] * 3
    bounds_max = [-1e30] * 3
    mesh_entries = []
    winding = [0, 0]
    for order, dr in enumerate(draws):
        sh = shapes[dr["shape"]]
        mat = mdl["materials"][dr["material"]]
        an = mat_info[dr["material"]]
        pa = pos_arr[sh["pos_id"]]
        na = nrm_arr.get(sh["nrm_id"]) if sh["vcd"]["nrm"] != "none" else None
        ca = clr_arr.get(sh["clr_ids"][0]) if sh["vcd"]["clr0"] != "none" else None
        uvs = [(i, uv_arr[sh["uv_ids"][i]]) for i in range(8) if sh["vcd"]["tex%d" % i] != "none"]
        groups = {}  # node -> (vert map, vert list, indices)
        for prim in sh["primitives"]:
            if prim["type"] in ("lines", "linestrip", "points"):
                warnings.append("%s: %s primitives skipped" % (sh["name"], prim["type"]))
                continue
            vnode = []
            for v in prim["verts"]:
                if sh["single_bind_mtx"] >= 0:
                    mid = sh["single_bind_mtx"]
                else:
                    mid = prim["pos_slots"].get(v.get("pnmtx", 0) // 3)
                node = mtx_to_node[mid] if mid is not None and mid < len(mtx_to_node) else -1
                if node < 0:
                    raise NotImplementedError("envelope (weighted) matrices are not supported")
                vnode.append(node)
            for tri in gxdl.triangulate(prim):
                ns = {vnode[i] for i in tri}
                if len(ns) != 1:
                    raise NotImplementedError("triangle spans several bones")
                node = vnode[tri[0]]
                g = groups.setdefault(node, ({}, [], []))
                pts = [pa["data"][prim["verts"][i]["pos"]] for i in tri]
                fn = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))
                if na is not None:
                    vn = [0.0, 0.0, 0.0]
                    for i in tri:
                        n_ = na["data"][prim["verts"][i]["nrm"]]
                        vn = [vn[k] + n_[k] for k in range(3)]
                    winding[0 if dot(fn, vn) >= 0 else 1] += 1
                # GX triangles are clockwise-front; glTF wants counter-clockwise
                for i in (tri[0], tri[2], tri[1]):
                    v = prim["verts"][i]
                    key = tuple(sorted(v.items()))
                    if key not in g[0]:
                        g[0][key] = len(g[1])
                        g[1].append(v)
                    g[2].append(g[0][key])
        for node, (vmap, verts, idx) in sorted(groups.items()):
            w = worlds[node]
            P, N, C, T = [], [], [], {i: [] for i, _ in uvs}
            for v in verts:
                p = pa["data"][v["pos"]]
                P += p
                wp = xform(w, p)
                for k in range(3):
                    bounds_min[k] = min(bounds_min[k], wp[k])
                    bounds_max[k] = max(bounds_max[k], wp[k])
                if na is not None:
                    N += normalize(na["data"][v["nrm"]])
                if ca is not None:
                    C += ca["data"][v["clr0"]]
                for i, ua in uvs:
                    T[i] += ua["data"][v["tex%d" % i]][:2]
            attrs = {"POSITION": gb.accessor(P, G.FLOAT, "VEC3")}
            if N:
                attrs["NORMAL"] = gb.accessor(N, G.FLOAT, "VEC3")
            if C and an["use_vertex_color"]:
                attrs["COLOR_0"] = gb.accessor(C, G.UBYTE, "VEC4", normalized=True)
            elif C:
                # keep the data around for custom shaders without three.js applying it
                attrs["_COLOR_G3D"] = gb.accessor(C, G.UBYTE, "VEC4", normalized=True)
            for n_, (i, _) in enumerate(uvs):
                attrs["TEXCOORD_%d" % i] = gb.accessor(T[i], G.FLOAT, "VEC2")
            ityp = G.USHORT if len(verts) < 65536 else G.UINT
            if ityp == G.USHORT and len(idx) % 2:
                pass
            ia = gb.accessor(idx, ityp, "SCALAR", target=G.ELEMENT_ARRAY_BUFFER)
            prim_j = {"attributes": attrs, "indices": ia, "material": dr["material"], "mode": 4}
            bone_name = next(b["name"] for b in bones if b["index"] == node)
            mname = "%s__%s" % (sh["name"], mat["name"])
            mi = gb.add("meshes", {"name": mname, "primitives": [prim_j]})
            nn = {"name": mname if len(groups) == 1 else "%s__%s" % (mname, bone_name), "mesh": mi,
                  "extras": {"renderOrder": order, "pass": dr["pass"], "priority": dr["priority"],
                             "shape": sh["name"], "material": mat["name"],
                             "visibility_bone": next(b["name"] for b in bones if b["index"] == dr["node"])}}
            ni = gb.add("nodes", nn)
            gb.j["nodes"][node_of_bone[node]].setdefault("children", []).append(ni)
            mesh_entries.append({"node": nn["name"], "bone": bone_name, "shape": sh["name"],
                                 "material": mat["name"], "pass": dr["pass"], "render_order": order,
                                 "vertices": len(verts), "triangles": len(idx) // 3,
                                 "attributes": sorted(attrs.keys())})
    if winding[0] > 0.02 * (winding[0] + winding[1]):
        warnings.append("%s: mixed winding vs normals (%d agree / %d disagree)" % (mdl["name"], winding[0], winding[1]))
    return gb.glb(), {
        "bounds": {"min": rlist(bounds_min, 4), "max": rlist(bounds_max, 4),
                   "size": rlist([bounds_max[i] - bounds_min[i] for i in range(3)], 4)},
        "meshes": mesh_entries, "material_analysis": mat_info, "winding_check": winding,
        "bone_matrix_max_error": rf(max_err, 6),
        "bone_world_matrices": {b["name"]: rlist(worlds[b["index"]], 5) for b in bones},
    }
