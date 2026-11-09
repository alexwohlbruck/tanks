"""BRLAN (NW4R layout animation, pai1) -> JSON-able dict."""
import struct

from brlyt import cstr, _round

TARGETS = {
    "RLPA": ["transX", "transY", "transZ", "rotX", "rotY", "rotZ", "scaleX", "scaleY", "sizeW", "sizeH"],
    "RLVC": ["tlR", "tlG", "tlB", "tlA", "trR", "trG", "trB", "trA",
             "blR", "blG", "blB", "blA", "brR", "brG", "brB", "brA", "alpha"],
    "RLMC": ["matR", "matG", "matB", "matA",
             "c0R", "c0G", "c0B", "c0A", "c1R", "c1G", "c1B", "c1A", "c2R", "c2G", "c2B", "c2A",
             "k0R", "k0G", "k0B", "k0A", "k1R", "k1G", "k1B", "k1A",
             "k2R", "k2G", "k2B", "k2A", "k3R", "k3G", "k3B", "k3A"],
    "RLTS": ["transS", "transT", "rotate", "scaleS", "scaleT"],
    "RLTP": ["texture"],
    "RLVI": ["visible"],
    "RLIM": ["transS", "transT", "rotate", "scaleS", "scaleT"],
}
CURVE = {0: "constant", 1: "step", 2: "hermite"}


def read_brlan(data):
    assert data[:4] == b"RLAN", "not a BRLAN"
    version, = struct.unpack_from(">H", data, 6)
    hsize, nsec = struct.unpack_from(">HH", data, 12)
    out = {"version": version}
    o = hsize
    for _ in range(nsec):
        magic = data[o:o + 4].decode("ascii")
        size, = struct.unpack_from(">I", data, o + 4)
        if magic == "pai1":
            frame_size, loop, ntex, nent, ent_tbl = struct.unpack_from(">HBxHHI", data, o + 8)
            out["frameSize"] = frame_size
            out["loop"] = bool(loop)
            tex = []
            tbase = o + 20
            for k in range(ntex):
                no, = struct.unpack_from(">I", data, tbase + 4 * k)
                end = data.index(b"\0", tbase + no)
                tex.append(data[tbase + no:end].decode("ascii"))
            out["textures"] = tex
            entries = []
            for k in range(nent):
                eo, = struct.unpack_from(">I", data, o + ent_tbl + 4 * k)
                e = o + eo
                name = cstr(data[e:e + 20])
                ntag, kind = struct.unpack_from(">BB", data, e + 20)
                tags = []
                for t in range(ntag):
                    to, = struct.unpack_from(">I", data, e + 24 + 4 * t)
                    tags.append(_read_tag(data, e + to))
                entries.append({"name": name, "kind": "material" if kind == 1 else "pane", "tags": tags})
            out["entries"] = entries
        else:
            out.setdefault("unknownSections", []).append(magic)
        o += size
    return _round(out)


def _read_tag(data, t):
    kind = data[t:t + 4].decode("ascii")
    n, = struct.unpack_from(">B", data, t + 4)
    names = TARGETS.get(kind, [])
    infos = []
    for i in range(n):
        io, = struct.unpack_from(">I", data, t + 8 + 4 * i)
        a = t + io
        idx, target, curve, nkeys, koff = struct.unpack_from(">BBBxHxxI", data, a)
        keys = []
        k = a + koff
        for _ in range(nkeys):
            if curve == 2:
                f, v, s = struct.unpack_from(">fff", data, k)
                keys.append([f, v, s])
                k += 12
            else:
                f, v = struct.unpack_from(">fH", data, k)
                keys.append([f, v])
                k += 8
        infos.append({"index": idx, "target": target,
                      "targetName": names[target] if target < len(names) else target,
                      "curve": CURVE.get(curve, curve), "keys": keys})
    return {"type": kind, "targets": infos}
