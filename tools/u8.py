#!/usr/bin/env python3
"""Yaz0 decompression and U8 archive extraction for .carc/.arc/.szs files.

usage: u8.py <archive> <outdir>
"""
import os
import struct
import sys


def yaz0_decompress(data: bytes) -> bytes:
    if data[:4] != b"Yaz0":
        return data
    size = struct.unpack_from(">I", data, 4)[0]
    out = bytearray(size)
    src, dst = 16, 0
    while dst < size:
        code = data[src]
        src += 1
        for bit in range(8):
            if dst >= size:
                break
            if code & (0x80 >> bit):
                out[dst] = data[src]
                dst += 1
                src += 1
            else:
                b1, b2 = data[src], data[src + 1]
                src += 2
                dist = ((b1 & 0xF) << 8 | b2) + 1
                n = b1 >> 4
                if n == 0:
                    n = data[src] + 0x12
                    src += 1
                else:
                    n += 2
                for _ in range(n):
                    out[dst] = out[dst - dist]
                    dst += 1
    return bytes(out)


def u8_entries(data: bytes):
    """Yield (path, offset, size, is_dir) for every node in a U8 archive."""
    magic, root_off, _hdr_size, _data_off = struct.unpack_from(">IIII", data, 0)
    assert magic == 0x55AA382D, "not a U8 archive"
    total = struct.unpack_from(">I", data, root_off + 8)[0]
    str_base = root_off + total * 12

    def name_at(off):
        end = data.index(b"\0", str_base + off)
        return data[str_base + off:end].decode("ascii", "replace")

    # Directory stack of (path, end_index)
    stack = [("", total)]
    for i in range(1, total):
        while i >= stack[-1][1]:
            stack.pop()
        word, off, size = struct.unpack_from(">III", data, root_off + i * 12)
        is_dir = word >> 24
        name = name_at(word & 0xFFFFFF)
        path = os.path.join(stack[-1][0], name)
        if is_dir:
            stack.append((path, size))
            yield path, 0, 0, True
        else:
            yield path, off, size, False


def extract(path, outdir):
    data = yaz0_decompress(open(path, "rb").read())
    for p, off, size, is_dir in u8_entries(data):
        dest = os.path.join(outdir, p.lstrip("./"))
        if is_dir:
            os.makedirs(dest, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data[off:off + size])


if __name__ == "__main__":
    extract(sys.argv[1], sys.argv[2])
