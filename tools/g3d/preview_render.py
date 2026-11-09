#!/usr/bin/env python3
"""Headless sanity render of the GLBs this pipeline writes (pure Python).

    python3 tools/g3d/preview_render.py OUT.png model.glb [model.glb ...]
        [--size 256] [--yaw 35] [--pitch 30] [--node cannon=0,45,0]

Orthographic, z-buffered, base-colour texture x vertex colour x simple
lambert (unlit materials skip the lambert).  One tile per model, side by side.
--node NAME=rx,ry,rz adds an extra local rotation (degrees) to a node, to
check that e.g. the turret rotates independently of the body.
"""
import argparse
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gxtex  # noqa: E402
from contact_sheet import read_png  # noqa: E402
import zlib  # noqa: E402,F401


def load_glb(path):
    d = open(path, "rb").read()
    jl = struct.unpack_from("<I", d, 12)[0]
    j = json.loads(d[20:20 + jl])
    b0 = 20 + jl
    bl = struct.unpack_from("<I", d, b0)[0]
    return j, d[b0 + 8:b0 + 8 + bl]


def accessor(j, bin_, i):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
    f = {5126: "f", 5121: "B", 5123: "H", 5125: "I"}[a["componentType"]]
    vals = struct.unpack_from("<%d%s" % (a["count"] * n, f), bin_, bv.get("byteOffset", 0))
    if a.get("normalized"):
        vals = [v / 255.0 for v in vals]
    return [vals[k * n:(k + 1) * n] for k in range(a["count"])]


def qmat(q):
    x, y, z, w = q
    return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]


def euler_q(r):
    hx, hy, hz = (math.radians(a) / 2 for a in r)
    from convert import quat_from_euler_deg
    return quat_from_euler_deg(r)


def mmul(a, b):
    r = [0.0] * 12
    for i in range(3):
        for k in range(4):
            r[i * 4 + k] = sum(a[i * 4 + m] * b[m * 4 + k] for m in range(3)) + (a[i * 4 + 3] if k == 3 else 0)
    return r


def node_mat(n, extra):
    t = n.get("translation", [0, 0, 0])
    q = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    R = qmat(q)
    m = [R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0],
         R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1],
         R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2]]
    if n.get("name") in extra:
        E = qmat(euler_q(extra[n["name"]]))
        m = mmul(m, [E[0], E[1], E[2], 0, E[3], E[4], E[5], 0, E[6], E[7], E[8], 0])
    return m


def tris_of(path, extra):
    j, b = load_glb(path)
    imgs = {}
    out = []

    def walk(ni, parent):
        n = j["nodes"][ni]
        w = mmul(parent, node_mat(n, extra))
        if "mesh" in n:
            for p in j["meshes"][n["mesh"]]["primitives"]:
                mat = j["materials"][p["material"]]
                pbr = mat.get("pbrMetallicRoughness", {})
                fac = pbr.get("baseColorFactor", [1, 1, 1, 1])
                tex = None
                if "baseColorTexture" in pbr:
                    ti = pbr["baseColorTexture"]["index"]
                    ii = j["textures"][ti]["source"]
                    if ii not in imgs:
                        bv = j["bufferViews"][j["images"][ii]["bufferView"]]
                        tmp = "/tmp/_pv_%d_%d.png" % (os.getpid(), ii)
                        open(tmp, "wb").write(b[bv["byteOffset"]:bv["byteOffset"] + bv["byteLength"]])
                        imgs[ii] = read_png(tmp)
                        os.remove(tmp)
                    tex = imgs[ii]
                unlit = "KHR_materials_unlit" in mat.get("extensions", {})
                blend = mat.get("alphaMode") == "BLEND"
                P = accessor(j, b, p["attributes"]["POSITION"])
                N = accessor(j, b, p["attributes"]["NORMAL"]) if "NORMAL" in p["attributes"] else None
                C = accessor(j, b, p["attributes"]["COLOR_0"]) if "COLOR_0" in p["attributes"] else None
                T = accessor(j, b, p["attributes"]["TEXCOORD_0"]) if "TEXCOORD_0" in p["attributes"] else None
                I = [x[0] for x in accessor(j, b, p["indices"])]
                Pw = [[w[0] * v[0] + w[1] * v[1] + w[2] * v[2] + w[3],
                       w[4] * v[0] + w[5] * v[1] + w[6] * v[2] + w[7],
                       w[8] * v[0] + w[9] * v[1] + w[10] * v[2] + w[11]] for v in P]
                Nw = [[w[0] * v[0] + w[1] * v[1] + w[2] * v[2],
                       w[4] * v[0] + w[5] * v[1] + w[6] * v[2],
                       w[8] * v[0] + w[9] * v[1] + w[10] * v[2]] for v in N] if N else None
                for k in range(0, len(I), 3):
                    ids = I[k:k + 3]
                    out.append({"p": [Pw[i] for i in ids], "n": [Nw[i] for i in ids] if Nw else None,
                                "c": [C[i] for i in ids] if C else None,
                                "t": [T[i] for i in ids] if T else None,
                                "tex": tex, "fac": fac, "unlit": unlit, "blend": blend,
                                "double": mat.get("doubleSided", False)})
        for c in n.get("children", []):
            walk(c, w)

    for r in j["scenes"][0]["nodes"]:
        walk(r, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    return out


def render(tris, size, yaw, pitch):
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    cp, sp = math.cos(math.radians(pitch)), math.sin(math.radians(pitch))

    def view(v):  # rotate world so camera looks along -Z
        x, y, z = v
        x, z = cy * x - sy * z, sy * x + cy * z
        y, z = cp * y - sp * z, sp * y + cp * z
        return [x, y, z]
    vt = [[view(p) for p in t["p"]] for t in tris]
    xs = [p[0] for t in vt for p in t]
    ys = [p[1] for t in vt for p in t]
    cx, cyy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    ext = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.05 or 1
    sc = size / ext
    img = bytearray(b"\x40\x48\x58\xff" * size * size)
    zb = [-1e30] * (size * size)
    L = [0.4, 0.8, 0.45]
    order = sorted(range(len(tris)), key=lambda i: tris[i]["blend"])
    for ti in order:
        t, v = tris[ti], vt[ti]
        s = [((p[0] - cx) * sc + size / 2, size / 2 - (p[1] - cyy) * sc, p[2]) for p in v]
        area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1])
        if abs(area) < 1e-9:
            continue
        if area > 0 and not t["double"]:
            continue  # back face (screen y is down, so CCW-front gives area < 0)
        x0, x1 = max(0, int(min(q[0] for q in s))), min(size - 1, int(max(q[0] for q in s)) + 1)
        y0, y1 = max(0, int(min(q[1] for q in s))), min(size - 1, int(max(q[1] for q in s)) + 1)
        for py in range(y0, y1 + 1):
            for px in range(x0, x1 + 1):
                fx, fy = px + 0.5, py + 0.5
                w0 = ((s[1][0] - fx) * (s[2][1] - fy) - (s[2][0] - fx) * (s[1][1] - fy)) / area
                w1 = ((s[2][0] - fx) * (s[0][1] - fy) - (s[0][0] - fx) * (s[2][1] - fy)) / area
                w2 = 1 - w0 - w1
                if w0 < 0 or w1 < 0 or w2 < 0:
                    continue
                z = w0 * s[0][2] + w1 * s[1][2] + w2 * s[2][2]
                idx = py * size + px
                if z < zb[idx]:
                    continue
                col = list(t["fac"])
                if t["tex"] and t["t"]:
                    u = w0 * t["t"][0][0] + w1 * t["t"][1][0] + w2 * t["t"][2][0]
                    vv = w0 * t["t"][0][1] + w1 * t["t"][1][1] + w2 * t["t"][2][1]
                    tw, th, tp = t["tex"]
                    ix, iy = int(u * tw) % tw, int(vv * th) % th
                    k = (iy * tw + ix) * 4
                    col = [col[c] * tp[k + c] / 255 for c in range(4)]
                if t["c"]:
                    col = [col[c] * (w0 * t["c"][0][c] + w1 * t["c"][1][c] + w2 * t["c"][2][c]) for c in range(4)]
                if t["n"] and not t["unlit"]:
                    n = [w0 * t["n"][0][c] + w1 * t["n"][1][c] + w2 * t["n"][2][c] for c in range(3)]
                    ln = math.sqrt(sum(x * x for x in n)) or 1
                    lam = max(0.0, sum(n[c] * L[c] for c in range(3)) / ln / 1.0)
                    sh = 0.45 + 0.55 * lam
                    col = [col[0] * sh, col[1] * sh, col[2] * sh, col[3]]
                a = col[3] if t["blend"] else 1.0
                k = idx * 4
                for c in range(3):
                    img[k + c] = max(0, min(255, int(col[c] * 255 * a + img[k + c] * (1 - a))))
                if not t["blend"]:
                    zb[idx] = z
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("glbs", nargs="+")
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--yaw", type=float, default=35)
    ap.add_argument("--pitch", type=float, default=30)
    ap.add_argument("--node", action="append", default=[])
    a = ap.parse_args()
    extra = {}
    for s in a.node:
        k, v = s.split("=")
        extra[k] = [float(x) for x in v.split(",")]
    tiles = [render(tris_of(g, extra), a.size, a.yaw, a.pitch) for g in a.glbs]
    W = a.size * len(tiles)
    img = bytearray(W * a.size * 4)
    for n, t in enumerate(tiles):
        for y in range(a.size):
            img[(y * W + n * a.size) * 4:(y * W + (n + 1) * a.size) * 4] = t[y * a.size * 4:(y + 1) * a.size * 4]
    open(a.out, "wb").write(gxtex.png_rgba(W, a.size, img))


if __name__ == "__main__":
    main()
