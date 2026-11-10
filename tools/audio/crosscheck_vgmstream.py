#!/usr/bin/env python3
"""Optional cross-check of our decoders against vgmstream-cli.

usage: python3 tools/audio/crosscheck_vgmstream.py [path/to/vgmstream-cli]

Not part of the build. Compares, sample by sample:
  * the RSTM stream (PartyPackTitle_2Mix.44.brstm) decoded by nw4r.parse_rstm
  * individual DSP-ADPCM bank/RWSD waves, wrapped in a standard .dsp header
Writes temporary files to $TMPDIR/tanks_vgms_check.
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nw4r  # noqa: E402
import wavio  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ROM = os.path.join(ROOT, "build", "rom", "ext", "files")


def find_vgmstream(arg):
    for c in [arg, os.environ.get("VGMSTREAM"), shutil.which("vgmstream-cli"),
              os.path.expanduser("~/.local/bin/vgmstream-cli"), "/tmp/vgms/vgmstream-cli"]:
        if c and os.path.exists(c):
            return c
    return None


def dsp_header(d, wi, nsamples_override=None):
    """Build a 0x60-byte .dsp header for the WaveInfo at d[wi] (mono)."""
    loop = d[wi + 1]
    rate = (d[wi + 3] << 16) + nw4r.u16(d, wi + 4)
    ls = nw4r.u32(d, wi + 8)
    le = nw4r.u32(d, wi + 0xC)
    cit = wi + nw4r.u32(d, wi + 0x10)
    ci = wi + nw4r.u32(d, cit)
    ao = wi + nw4r.u32(d, ci + 4)
    nsamp = nw4r.adpcm_nibble_to_sample(le) + 1
    coefs = d[ao:ao + 32]
    gain_ps_yn = d[ao + 32:ao + 32 + 14]
    h = struct.pack(">IIIHHIII", nsamp, le + 1, rate, loop, 0, ls, le, 2)
    h += coefs + gain_ps_yn
    h += b"\0" * (0x60 - len(h))
    return h, nsamp


def run(vg, path, outwav):
    subprocess.run([vg, "-o", outwav, "-i", path], check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    return wavio.read_wav(outwav)


def compare(a, b):
    n = min(len(a), len(b))
    diff = max((abs(a[i] - b[i]) for i in range(n)), default=0)
    return n, len(a), len(b), diff


def main():
    vg = find_vgmstream(sys.argv[1] if len(sys.argv) > 1 else None)
    if not vg:
        print("vgmstream-cli not found; pass its path as an argument")
        return 2
    tmp = os.path.join(tempfile.gettempdir(), "tanks_vgms_check")
    os.makedirs(tmp, exist_ok=True)
    ok = True
    # 1. stream
    strm = os.path.join(ROM, "Common/RPPartyCommon/STRM/PartyPackTitle_2Mix.44.brstm")
    ours = nw4r.parse_rstm(open(strm, "rb").read())
    rate, ref = run(vg, strm, os.path.join(tmp, "strm.wav"))
    for c in range(len(ours.channels)):
        n, la, lb, diff = compare(ours.channels[c], ref[c])
        print("RSTM ch%d: ours %d samples @%d, vgmstream %d @%d, max |diff| = %d"
              % (c, la, ours.rate, lb, rate, diff))
        ok &= diff == 0 and la == lb
    print("RSTM loop: ours start=%d end=%d" % (ours.loop_start, ours.loop_end))
    # 2. bank / wsd waves as .dsp
    for arc_rel in ("Common/RPTnkScene/rp_Tnk_sound.brsar",):
        r = nw4r.RSAR(open(os.path.join(ROM, arc_rel), "rb").read())
        for b in r.banks:
            m, w = r.file_data(b["file_id"])
            bank = nw4r.RBNK(m, w)
            for wi_idx in range(0, len(bank.wave_offsets), max(1, len(bank.wave_offsets) // 4)):
                wi = bank.wave_offsets[wi_idx]
                if m[wi] != 2 or m[wi + 2] != 1:
                    continue  # mono ADPCM only for the .dsp wrapper
                hdr, nsamp = dsp_header(m, wi)
                data_off = nw4r.u32(m, wi + 0x14)
                cit = wi + nw4r.u32(m, wi + 0x10)
                cdo = nw4r.u32(m, wi + nw4r.u32(m, cit))
                nbytes = (nsamp + 13) // 14 * 8
                raw = w[data_off + cdo:data_off + cdo + nbytes]
                p = os.path.join(tmp, "%s_%d.dsp" % (b["name"], wi_idx))
                open(p, "wb").write(hdr + raw)
                _, refc = run(vg, p, p + ".wav")
                mine = bank.wave(wi_idx).channels[0]
                n, la, lb, diff = compare(mine, refc[0])
                print("%-32s wave %2d: %6d samples, vgmstream %6d, max |diff| = %d"
                      % (b["name"], wi_idx, la, lb, diff))
                ok &= diff == 0
    print("ALL MATCH" if ok else "MISMATCHES FOUND")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
