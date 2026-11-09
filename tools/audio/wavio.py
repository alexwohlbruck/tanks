"""Minimal WAV (PCM16) writer/reader, stdlib only."""
import struct
from array import array
import sys


def to_pcm16(chans, gain=1.0):
    n = len(chans[0])
    nch = len(chans)
    out = array("h", bytes(2 * n * nch))
    clipped = 0
    for c, ch in enumerate(chans):
        for i in range(n):
            v = int(round(ch[i] * gain * 32768.0))
            if v > 32767:
                v = 32767
                clipped += 1
            elif v < -32768:
                v = -32768
                clipped += 1
            out[i * nch + c] = v
    return out, clipped


def write_wav(path, rate, chans=None, pcm=None, nch=None, smpl_loop=None):
    """Write 16-bit WAV. chans: list of float sequences (-1..1), or pcm (interleaved int16 array).
    smpl_loop: (start, end_exclusive) adds a RIFF 'smpl' chunk loop."""
    clipped = 0
    if pcm is None:
        pcm, clipped = to_pcm16(chans)
        nch = len(chans)
    if sys.byteorder != "little":
        pcm = array("h", pcm)
        pcm.byteswap()
    data = pcm.tobytes()
    chunks = b""
    fmt = struct.pack("<HHIIHH", 1, nch, rate, rate * nch * 2, nch * 2, 16)
    chunks += b"fmt " + struct.pack("<I", len(fmt)) + fmt
    if smpl_loop is not None:
        s, e = smpl_loop
        smpl = struct.pack("<9I", 0, 0, int(1e9 / rate), 60, 0, 0, 0, 1, 0)
        smpl += struct.pack("<6I", 0, 0, s, e - 1, 0, 0)
        chunks += b"smpl" + struct.pack("<I", len(smpl)) + smpl
    chunks += b"data" + struct.pack("<I", len(data)) + data
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks)
    return clipped


def read_wav(path):
    d = open(path, "rb").read()
    assert d[:4] == b"RIFF" and d[8:12] == b"WAVE"
    p = 12
    rate = nch = None
    pcm = None
    while p < len(d):
        cid = d[p:p + 4]
        ln = struct.unpack_from("<I", d, p + 4)[0]
        body = d[p + 8:p + 8 + ln]
        if cid == b"fmt ":
            _, nch, rate = struct.unpack_from("<HHI", body, 0)
        elif cid == b"data":
            pcm = array("h")
            pcm.frombytes(body)
            if sys.byteorder != "little":
                pcm.byteswap()
        p += 8 + ln + (ln & 1)
    chans = [pcm[c::nch] for c in range(nch)]
    return rate, chans
