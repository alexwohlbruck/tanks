"""Tiny glTF 2.0 / GLB builder (no dependencies)."""
import json
import struct

FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963
WRAP_GL = {"clamp": 33071, "repeat": 10497, "mirror": 33648}
FILTER_GL = {"nearest": 9728, "linear": 9729, "nearest_mip_nearest": 9984,
             "linear_mip_nearest": 9985, "nearest_mip_linear": 9986, "linear_mip_linear": 9987}


class GltfBuilder:
    def __init__(self, generator="tanks tools/g3d"):
        self.j = {"asset": {"version": "2.0", "generator": generator},
                  "scenes": [{"nodes": []}], "scene": 0, "nodes": [], "meshes": [],
                  "materials": [], "textures": [], "images": [], "samplers": [],
                  "accessors": [], "bufferViews": [], "buffers": []}
        self.bin = bytearray()
        self.ext_used = set()
        self._samplers = {}

    def _view(self, data, target=None, align=4):
        while len(self.bin) % align:
            self.bin.append(0)
        v = {"buffer": 0, "byteOffset": len(self.bin), "byteLength": len(data)}
        if target:
            v["target"] = target
        self.bin += data
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def accessor(self, values, ctype, atype, target=ARRAY_BUFFER, normalized=False, minmax=False):
        """values: flat list."""
        ncomp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[atype]
        fmt = {FLOAT: "f", UBYTE: "B", USHORT: "H", UINT: "I"}[ctype]
        data = struct.pack("<%d%s" % (len(values), fmt), *values)
        if ctype in (UBYTE, USHORT) and target == ARRAY_BUFFER:
            # vertex attribute elements must be 4-byte aligned per element
            esize = {UBYTE: 1, USHORT: 2}[ctype] * ncomp
            if esize % 4:
                raise ValueError("unaligned vertex attribute")
        bv = self._view(data, target)
        a = {"bufferView": bv, "componentType": ctype, "count": len(values) // ncomp, "type": atype}
        if normalized:
            a["normalized"] = True
        if minmax or atype == "VEC3" and target == ARRAY_BUFFER and ctype == FLOAT:
            a["min"] = [min(values[i::ncomp]) for i in range(ncomp)]
            a["max"] = [max(values[i::ncomp]) for i in range(ncomp)]
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def sampler(self, wrap_s, wrap_t, mag, minf):
        key = (wrap_s, wrap_t, mag, minf)
        if key not in self._samplers:
            mag_gl = 9729 if mag not in ("nearest",) else 9728
            self.j["samplers"].append({"wrapS": WRAP_GL[wrap_s], "wrapT": WRAP_GL[wrap_t],
                                       "magFilter": mag_gl, "minFilter": FILTER_GL.get(minf, 9729)})
            self._samplers[key] = len(self.j["samplers"]) - 1
        return self._samplers[key]

    def image_png(self, name, png):
        bv = self._view(png, None)
        self.j["images"].append({"name": name, "mimeType": "image/png", "bufferView": bv})
        return len(self.j["images"]) - 1

    def texture(self, image, sampler, name=None):
        t = {"source": image, "sampler": sampler}
        if name:
            t["name"] = name
        self.j["textures"].append(t)
        return len(self.j["textures"]) - 1

    def add(self, kind, obj):
        self.j[kind].append(obj)
        return len(self.j[kind]) - 1

    def glb(self):
        j = dict(self.j)
        for k in ("meshes", "materials", "textures", "images", "samplers", "accessors",
                  "bufferViews"):
            if not j[k]:
                del j[k]
        while len(self.bin) % 4:
            self.bin.append(0)
        j["buffers"] = [{"byteLength": len(self.bin)}]
        if self.ext_used:
            j["extensionsUsed"] = sorted(self.ext_used)
        js = json.dumps(j, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        out = struct.pack("<III", 0x46546C67, 2, total)
        out += struct.pack("<II", len(js), 0x4E4F534A) + js
        out += struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin)
        return out
