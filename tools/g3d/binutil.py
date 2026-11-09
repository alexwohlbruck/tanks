"""Big-endian binary reading helpers shared by the G3D / effect parsers."""
import struct

_u8 = struct.Struct(">B")
_s8 = struct.Struct(">b")
_u16 = struct.Struct(">H")
_s16 = struct.Struct(">h")
_u32 = struct.Struct(">I")
_s32 = struct.Struct(">i")
_f32 = struct.Struct(">f")


def u8(d, o):
    return d[o]


def s8(d, o):
    return _s8.unpack_from(d, o)[0]


def u16(d, o):
    return _u16.unpack_from(d, o)[0]


def s16(d, o):
    return _s16.unpack_from(d, o)[0]


def u32(d, o):
    return _u32.unpack_from(d, o)[0]


def s32(d, o):
    return _s32.unpack_from(d, o)[0]


def f32(d, o):
    return _f32.unpack_from(d, o)[0]


def vec(d, o, n):
    return list(struct.unpack_from(">%df" % n, d, o))


def cstr(d, o):
    """NUL-terminated ASCII/Shift-JIS string starting at absolute offset o."""
    if o <= 0 or o >= len(d):
        return None
    e = d.index(b"\0", o)
    raw = d[o:e]
    try:
        return raw.decode("ascii")
    except UnicodeDecodeError:
        return raw.decode("shift_jis", "replace")


def rel_str(d, base, off):
    """BRRES-style string: offset relative to `base`; 0 means none."""
    if off == 0:
        return None
    return cstr(d, base + off)


def rf(x, n=6):
    """Round a float for JSON output (keeps files readable)."""
    if isinstance(x, float):
        r = round(x, n)
        return 0.0 if r == 0 else r
    return x


def rlist(v, n=6):
    return [rf(float(x), n) for x in v]


def rgba_hex(c):
    return "#%02x%02x%02x%02x" % tuple(c)
