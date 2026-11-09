"""Minimal PNG encoder (stdlib only: zlib + struct)."""
import struct
import zlib

# PNG colour types we emit
GRAY, RGB, GRAY_ALPHA, RGBA = 0, 2, 4, 6
_CHANNELS = {GRAY: 1, RGB: 3, GRAY_ALPHA: 2, RGBA: 4}


def _chunk(tag: bytes, data: bytes) -> bytes:
    crc = zlib.crc32(tag + data) & 0xFFFFFFFF
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)


def encode(width: int, height: int, pixels, color_type: int = RGBA) -> bytes:
    """Encode 8-bit pixels (bytes/bytearray, row-major, no padding) as PNG.

    Filter type 0 (None) on every row; zlib does the work.
    """
    ch = _CHANNELS[color_type]
    stride = width * ch
    if len(pixels) != stride * height:
        raise ValueError(f"pixel buffer {len(pixels)} != {stride}*{height}")
    raw = bytearray()
    mv = memoryview(bytes(pixels))
    for y in range(height):
        raw.append(0)
        raw += mv[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + _chunk(b"IEND", b""))


def write(path: str, width: int, height: int, pixels, color_type: int = RGBA):
    with open(path, "wb") as f:
        f.write(encode(width, height, pixels, color_type))
