"""Parsers for NintendoWare for Revolution (NW4R) sound formats.

Stdlib-only. Covers the formats found in Wii Play's sound archives:

  RSAR  sound archive (SYMB / INFO / FILE)
  RWSD  wave sound data (DATA + WAVE info blocks, sample data in the group's
        wave-data area)
  RBNK  instrument bank (DATA + WAVE info blocks)
  RSEQ  sequence (DATA bytecode + LABL)
  RSTM  stream (HEAD / ADPC / DATA)
  WaveInfo + DSP-ADPCM decoding

Layouts follow nw4r::snd (see the Wii Sports decompilation, kiwi515/ogws,
include/nw4r/snd/snd_*File.h), which is the same NW4R generation as Wii Play.
"""
import struct

SOUND_TYPE = {1: "SEQ", 2: "STRM", 3: "WAVE"}


def u8(d, o):
    return d[o]


def s8(d, o):
    v = d[o]
    return v - 256 if v >= 128 else v


def u16(d, o):
    return struct.unpack_from(">H", d, o)[0]


def s16(d, o):
    return struct.unpack_from(">h", d, o)[0]


def u32(d, o):
    return struct.unpack_from(">I", d, o)[0]


def s32(d, o):
    return struct.unpack_from(">i", d, o)[0]


def f32(d, o):
    return struct.unpack_from(">f", d, o)[0]


def cstr(d, o):
    e = d.index(b"\0", o)
    return d[o:e].decode("ascii", "replace")


def dataref(d, o):
    """Util::DataRef -> (refType, dataType, value)."""
    return d[o], d[o + 1], u32(d, o + 4)


def ref_addr(d, o, base):
    """Resolve an offset DataRef at d[o] relative to base. None if null."""
    rt, dt, v = dataref(d, o)
    if rt != 1 or (v == 0 and dt == 0):
        return None
    return base + v


def table_refs(d, o, base):
    """Util::Table<DataRef>: count then refs. Returns list of (dataType, abs offset|None)."""
    n = u32(d, o)
    out = []
    for i in range(n):
        rt, dt, v = dataref(d, o + 4 + 8 * i)
        out.append((dt, base + v if rt == 1 else None))
    return out


# ---------------------------------------------------------------------------
# DSP-ADPCM / PCM decoding
# ---------------------------------------------------------------------------

def decode_adpcm(data, off, nsamples, coefs, hist1=0, hist2=0):
    """Decode GameCube/Wii DSP-ADPCM. Frames are 8 bytes / 14 samples."""
    out = [0] * nsamples
    c = coefs
    i = 0
    p = off
    while i < nsamples:
        ps = data[p]
        scale = 1 << (ps & 0xF)
        ci = (ps >> 4) & 7
        c1 = c[ci * 2]
        c2 = c[ci * 2 + 1]
        p += 1
        for b in range(7):
            byte = data[p + b]
            for nib in (byte >> 4, byte & 0xF):
                if i >= nsamples:
                    break
                if nib >= 8:
                    nib -= 16
                v = ((nib * scale) << 11) + 1024 + c1 * hist1 + c2 * hist2
                v >>= 11
                if v > 32767:
                    v = 32767
                elif v < -32768:
                    v = -32768
                out[i] = v
                hist2 = hist1
                hist1 = v
                i += 1
        p += 7
    return out


def adpcm_nibble_to_sample(addr):
    """AxVoice::GetSampleByDspAddress for ADPCM (base 0)."""
    return (addr % 16) + (addr // 16) * 14 - 2


class Wave:
    """Decoded wave: list of channels (lists of int16), rate, loop info."""

    def __init__(self, rate, channels, loop, loop_start, loop_end, fmt, ch_vol=None):
        self.rate = rate
        self.channels = channels
        self.loop = loop
        self.loop_start = loop_start
        self.loop_end = loop_end  # exclusive end sample (== length of playable data)
        self.format = fmt
        self.ch_vol = ch_vol or []

    @property
    def nsamples(self):
        return len(self.channels[0]) if self.channels else 0


def parse_waveinfo(d, wi, wave_data, wave_data_off=0):
    """Parse WaveFile::WaveInfo at d[wi]; sample data in wave_data at
    wave_data_off + dataOffset + channelDataOffset."""
    fmt = d[wi]
    loop = d[wi + 1]
    nch = d[wi + 2]
    rate = (d[wi + 3] << 16) + u16(d, wi + 4)
    loop_start_a = u32(d, wi + 8)
    loop_end_a = u32(d, wi + 0xC)
    cit = wi + u32(d, wi + 0x10)
    data_off = u32(d, wi + 0x14)
    if fmt == 2:
        ls = adpcm_nibble_to_sample(loop_start_a)
        le = adpcm_nibble_to_sample(loop_end_a) + 1
    else:
        ls = loop_start_a
        le = loop_end_a + 1
    chans = []
    ch_vol = []
    for c in range(nch):
        ci = wi + u32(d, cit + 4 * c)
        cdo = u32(d, ci)
        adpcm_o = u32(d, ci + 4)
        vols = [u32(d, ci + 8 + 4 * k) for k in range(4)]
        ch_vol.append(vols)
        src = wave_data_off + data_off + cdo
        if fmt == 2:
            ao = wi + adpcm_o
            coefs = [s16(d, ao + 2 * k) for k in range(16)]
            yn1 = s16(d, ao + 0x24)
            yn2 = s16(d, ao + 0x26)
            # initial history from the ADPCM info (normally 0)
            samples = decode_adpcm(wave_data, src, le, coefs, yn1, yn2)
        elif fmt == 1:
            samples = list(struct.unpack_from(">%dh" % le, wave_data, src))
        else:
            samples = [(b - 256 if b >= 128 else b) << 8 for b in wave_data[src:src + le]]
        chans.append(samples)
    return Wave(rate, chans, bool(loop), ls, le, fmt, ch_vol)


# ---------------------------------------------------------------------------
# RSAR
# ---------------------------------------------------------------------------

class RSAR:
    def __init__(self, data):
        d = self.d = data
        assert d[:4] == b"RSAR", "not an RSAR"
        self.version = u16(d, 6)
        symb = u32(d, 0x10)
        info = u32(d, 0x18)
        self.file_image = u32(d, 0x20)
        # --- SYMB
        sb = symb + 8
        strtab = sb + u32(d, sb)
        n = u32(d, strtab)
        self.strings = [cstr(d, sb + u32(d, strtab + 4 + 4 * i)) for i in range(n)]
        # --- INFO
        ib = self.ib = info + 8

        def tbl(k):
            o = ref_addr(d, ib + 8 * k, ib)
            return table_refs(d, o, ib) if o is not None else []

        self.sounds = [self._sound(i, o) for i, (_, o) in enumerate(tbl(0))]
        self.banks = []
        for i, (_, o) in enumerate(tbl(1)):
            self.banks.append({"id": i, "name": self._s(u32(d, o)), "file_id": u32(d, o + 4)})
        self.players = []
        for i, (_, o) in enumerate(tbl(2)):
            self.players.append({"id": i, "name": self._s(u32(d, o)),
                                 "playable_sound_count": d[o + 4], "heap_size": u32(d, o + 8)})
        self.files = []
        for i, (_, o) in enumerate(tbl(3)):
            ext = ref_addr(d, o + 0xC, ib)
            pos = []
            pt = ref_addr(d, o + 0x14, ib)
            if pt is not None:
                for _, po in table_refs(d, pt, ib):
                    pos.append((u32(d, po), u32(d, po + 4)))
            self.files.append({"id": i, "size": u32(d, o), "wave_size": u32(d, o + 4),
                               "entry": s32(d, o + 8),
                               "ext": cstr(d, ext) if ext is not None else None, "pos": pos})
        self.groups = []
        for i, (_, o) in enumerate(tbl(4)):
            items = []
            it = ref_addr(d, o + 0x20, ib)
            if it is not None:
                for _, io in table_refs(d, it, ib):
                    items.append({"file_id": u32(d, io), "offset": u32(d, io + 4),
                                  "size": u32(d, io + 8), "wave_offset": u32(d, io + 0xC),
                                  "wave_size": u32(d, io + 0x10)})
            sid = u32(d, o)
            self.groups.append({"id": i, "name": self._s(sid), "offset": u32(d, o + 0x10),
                                "size": u32(d, o + 0x14), "wave_offset": u32(d, o + 0x18),
                                "wave_size": u32(d, o + 0x1C), "items": items})
        self.by_name = {s["name"]: s for s in self.sounds}

    def _s(self, sid):
        if sid == 0xFFFFFFFF or sid >= len(self.strings):
            return None
        return self.strings[sid]

    def _sound(self, idx, o):
        d, ib = self.d, self.ib
        s = {"id": idx, "name": self._s(u32(d, o)), "file_id": u32(d, o + 4),
             "player_id": u32(d, o + 8), "volume": d[o + 0x14],
             "player_priority": d[o + 0x15], "type": SOUND_TYPE.get(d[o + 0x16], d[o + 0x16]),
             "remote_filter": d[o + 0x17],
             "user_param": [u32(d, o + 0x20), u32(d, o + 0x24)],
             "pan_mode": d[o + 0x28], "pan_curve": d[o + 0x29],
             "actor_player_id": d[o + 0x2A]}
        p3 = ref_addr(d, o + 0xC, ib)
        if p3 is not None:
            s["param3d"] = {"flags": u32(d, p3), "decay_curve": d[p3 + 4],
                            "decay_ratio": d[p3 + 5], "doppler_factor": d[p3 + 6]}
        si = ref_addr(d, o + 0x18, ib)
        if si is not None:
            t = s["type"]
            if t == "SEQ":
                s["seq"] = {"data_offset": u32(d, si), "bank_id": u32(d, si + 4),
                            "alloc_track": u32(d, si + 8), "channel_priority": d[si + 0xC],
                            "release_priority_fix": d[si + 0xD]}
            elif t == "WAVE":
                s["wave"] = {"sub_no": s32(d, si), "alloc_track": u32(d, si + 4),
                             "channel_priority": d[si + 8], "release_priority_fix": d[si + 9]}
            elif t == "STRM":
                s["strm"] = {"start_position": u32(d, si), "alloc_channel_count": u16(d, si + 4),
                             "alloc_track_flag": u16(d, si + 6)}
        return s

    def file_data(self, file_id):
        """Return (file bytes, wave-data bytes) for an internal file, or (None, None)."""
        f = self.files[file_id]
        for gid, idx in f["pos"]:
            g = self.groups[gid]
            it = g["items"][idx]
            a = g["offset"] + it["offset"]
            main = self.d[a:a + it["size"]]
            w = g["wave_offset"] + it["wave_offset"]
            wave = self.d[w:w + it["wave_size"]]
            return main, wave
        return None, None


# ---------------------------------------------------------------------------
# RWSD
# ---------------------------------------------------------------------------

class RWSD:
    def __init__(self, data, wave_data):
        d = self.d = data
        assert d[:4] == b"RWSD"
        self.version = u16(d, 6)
        self.wave_data = wave_data
        data_blk = u32(d, 0x10)
        wave_blk = u32(d, 0x18)
        base = data_blk + 8  # &wsdCount
        self.entries = []
        for _, wo in table_refs(d, base, base):
            info_o = ref_addr(d, wo, base)
            info = {"pitch": f32(d, info_o), "pan": d[info_o + 4], "surround_pan": d[info_o + 5],
                    "fx_send": [d[info_o + 6], d[info_o + 7], d[info_o + 8]],
                    "main_send": d[info_o + 9]}
            tracks = []
            tt = ref_addr(d, wo + 8, base)
            if tt is not None:
                for _, to in table_refs(d, tt, base):
                    evs = []
                    et = ref_addr(d, to, base)
                    if et is not None:
                        for _, eo in table_refs(d, et, base):
                            evs.append({"position": f32(d, eo), "length": f32(d, eo + 4),
                                        "note_index": u32(d, eo + 8)})
                    tracks.append(evs)
            notes = []
            nt = ref_addr(d, wo + 0x10, base)
            for _, no in table_refs(d, nt, base):
                notes.append({"wave_index": s32(d, no), "attack": d[no + 4], "decay": d[no + 5],
                              "sustain": d[no + 6], "release": d[no + 7], "hold": u16(d, no + 8),
                              "original_key": d[no + 0xC], "volume": d[no + 0xD],
                              "pan": d[no + 0xE], "surround_pan": d[no + 0xF],
                              "pitch": f32(d, no + 0x10)})
            self.entries.append({"info": info, "tracks": tracks, "notes": notes})
        wb = wave_blk
        self.wave_offsets = []
        if self.version >= 0x0101:
            n = u32(d, wb + 8)
            self.wave_offsets = [wb + u32(d, wb + 0xC + 4 * i) for i in range(n)]
        else:
            # old layout: offset table directly after header; count unknown
            i = 0
            while wb + 8 + 4 * i < wb + u32(d, wb + 4):
                self.wave_offsets.append(wb + u32(d, wb + 8 + 4 * i))
                i += 1

    def wave(self, idx):
        return parse_waveinfo(self.d, self.wave_offsets[idx], self.wave_data)


# ---------------------------------------------------------------------------
# RBNK
# ---------------------------------------------------------------------------

DT_NONE, DT_INST, DT_RANGE, DT_INDEX = 0, 1, 2, 3


class RBNK:
    def __init__(self, data, wave_data):
        d = self.d = data
        assert d[:4] == b"RBNK"
        self.version = u16(d, 6)
        self.wave_data = wave_data
        self.base = u32(d, 0x10) + 8
        wb = u32(d, 0x18) + 8
        self.inst = []
        n = u32(d, self.base)
        for i in range(n):
            self.inst.append(dataref(d, self.base + 4 + 8 * i))
        self.wave_offsets = [o for _, o in table_refs(d, wb, wb)]
        self._wave_cache = {}

    def _inst_param(self, o):
        d = self.d
        p = {"wave_index": s32(d, o), "attack": d[o + 4], "decay": d[o + 5],
             "sustain": d[o + 6], "release": d[o + 7], "hold": d[o + 8],
             "wave_data_location_type": d[o + 9], "note_off_type": d[o + 0xA],
             "alternate_assign": d[o + 0xB], "original_key": d[o + 0xC]}
        if self.version >= 0x0101:
            p["volume"] = d[o + 0xD]
            p["pan"] = d[o + 0xE]
            p["surround_pan"] = d[o + 0xF]
            p["tune"] = f32(d, o + 0x10)
        else:
            p["volume"] = 127
            p["pan"] = d[o + 0xE]
            p["tune"] = 1.0
        return p

    def _sub(self, ref, split):
        rt, dt, v = ref
        d = self.d
        if dt == DT_INST:
            return ref
        if dt == DT_RANGE:
            o = self.base + v
            n = d[o]
            i = 0
            while split > d[o + 1 + i]:
                i += 1
                if i >= n:
                    return None
            start = (n + 1 + 3) & ~3
            return dataref(d, o + start + 8 * i)
        if dt == DT_INDEX:
            o = self.base + v
            lo, hi = d[o], d[o + 1]
            if split < lo or split > hi:
                return None
            return dataref(d, o + 4 + 8 * (split - lo))
        return None

    def lookup(self, prg, key, vel):
        """BankFileReader::ReadInstInfo."""
        if prg < 0 or prg >= len(self.inst):
            return None
        ref = self.inst[prg]
        if ref[1] >= 4:
            return None
        if ref[1] != DT_INST:
            ref = self._sub(ref, key)
            if ref is None:
                return None
        if ref[1] >= 4:
            return None
        if ref[1] != DT_INST:
            ref = self._sub(ref, vel)
            if ref is None:
                return None
        if ref[1] != DT_INST:
            return None
        p = self._inst_param(self.base + ref[2])
        if p["wave_index"] < 0:
            return None
        return p

    def describe(self, prg):
        """List of regions (key_lo, key_hi, vel_lo, vel_hi, params) for a program."""
        out = []
        if prg >= len(self.inst):
            return out

        def expand(ref):
            rt, dt, v = ref
            d = self.d
            if dt == DT_INST:
                return [(0, 127, self._inst_param(self.base + v))]
            if dt == DT_RANGE:
                o = self.base + v
                n = d[o]
                start = (n + 1 + 3) & ~3
                res, lo = [], 0
                for i in range(n):
                    hi = d[o + 1 + i]
                    res.append((lo, hi, dataref(d, o + start + 8 * i)))
                    lo = hi + 1
                return res
            if dt == DT_INDEX:
                o = self.base + v
                lo, hi = d[o], d[o + 1]
                return [(k, k, dataref(d, o + 4 + 8 * (k - lo))) for k in range(lo, hi + 1)]
            return []

        for klo, khi, kref in expand(self.inst[prg]):
            if not isinstance(kref, tuple) or len(kref) != 3 or isinstance(kref[2], dict):
                out.append((klo, khi, 0, 127, kref))
                continue
            for vlo, vhi, vref in expand(kref):
                if isinstance(vref, dict):
                    out.append((klo, khi, vlo, vhi, vref))
                elif vref[1] == DT_INST:
                    out.append((klo, khi, vlo, vhi, self._inst_param(self.base + vref[2])))
        return out

    def wave(self, idx):
        if idx not in self._wave_cache:
            self._wave_cache[idx] = parse_waveinfo(self.d, self.wave_offsets[idx], self.wave_data)
        return self._wave_cache[idx]


# ---------------------------------------------------------------------------
# RSEQ
# ---------------------------------------------------------------------------

class RSEQ:
    def __init__(self, data):
        d = self.d = data
        assert d[:4] == b"RSEQ"
        data_blk = u32(d, 0x10)
        self.base = data_blk + u32(d, data_blk + 8)
        self.code = d[self.base:data_blk + u32(d, data_blk + 4)]
        self.labels = {}
        lb = u32(d, 0x18)
        if lb:
            n = u32(d, lb + 8)
            for i in range(n):
                lo = lb + 8 + u32(d, lb + 0xC + 4 * i)
                off = u32(d, lo)
                ln = u32(d, lo + 4)
                self.labels[d[lo + 8:lo + 8 + ln].decode()] = off


# ---------------------------------------------------------------------------
# RSTM
# ---------------------------------------------------------------------------

def parse_rstm(d):
    assert d[:4] == b"RSTM"
    head = u32(d, 0x10)
    data_blk = u32(d, 0x20)
    hb = head + 8
    s1 = hb + u32(d, hb + 4)  # StrmDataInfo
    codec = d[s1]
    loop = d[s1 + 1]
    nch = d[s1 + 2]
    rate = (d[s1 + 3] << 16) + u16(d, s1 + 4)
    loop_start = u32(d, s1 + 8)
    nsamples = u32(d, s1 + 0xC)
    data_off = u32(d, s1 + 0x10)
    nblocks = u32(d, s1 + 0x14)
    block_size = u32(d, s1 + 0x18)
    block_samples = u32(d, s1 + 0x1C)
    last_block_size = u32(d, s1 + 0x20)
    last_block_samples = u32(d, s1 + 0x24)
    last_block_padded = u32(d, s1 + 0x28)
    # channel info
    s3 = hb + u32(d, hb + 0x14)
    ncht = d[s3]
    coefs = []
    for c in range(ncht):
        rt, dt, v = dataref(d, s3 + 4 + 8 * c)
        co = hb + v
        ao = hb + u32(d, co + 4) if d[co] == 1 else co + 8
        # ChannelInfo: DataRef<AdpcmInfo>
        ao = hb + u32(d, co + 4)
        coefs.append(([s16(d, ao + 2 * k) for k in range(16)], s16(d, ao + 0x24), s16(d, ao + 0x26)))
    start = data_off if data_off else data_blk + 0x20
    # DATA block: header 0x8 + u32 offset to data
    dstart = data_blk + 8 + u32(d, data_blk + 8)
    chans = [[] for _ in range(nch)]
    hist = [(0, 0)] * nch
    p = dstart
    for b in range(nblocks):
        last = b == nblocks - 1
        bs = last_block_padded if last else block_size
        bsmp = last_block_samples if last else block_samples
        for c in range(nch):
            if codec == 2:
                co, h1, h2 = coefs[c]
                if b == 0:
                    hist[c] = (h1, h2)
                out = decode_adpcm(d, p, bsmp, co, hist[c][0], hist[c][1])
                hist[c] = (out[-1], out[-2] if len(out) > 1 else hist[c][0])
            elif codec == 1:
                out = list(struct.unpack_from(">%dh" % bsmp, d, p))
            else:
                out = [(x - 256 if x >= 128 else x) << 8 for x in d[p:p + bsmp]]
            chans[c].extend(out)
            p += bs
    for c in range(nch):
        del chans[c][nsamples:]
    return Wave(rate, chans, bool(loop), loop_start, nsamples, codec)
