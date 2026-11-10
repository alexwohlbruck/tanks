#!/usr/bin/env python3
"""Build every Tanks! audio asset from the extracted ROM.

usage: python3 tools/audio/build_audio.py [--only NAME_SUBSTRING] [--jobs N]

Reads  build/rom/ext/files/Common/RPTnkScene/rp_Tnk_sound.brsar
       build/rom/ext/files/Common/RPPartyCommon/rp_Common_Party.brsar (+ STRM/)
Writes public/assets/audio/{se,bgm,bgm/stems}/... and manifest.json

Stdlib only. See docs/audio.md for formats, the manifest schema and findings.
"""
import argparse
import json
import math
import os
import sys
import time
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import mml  # noqa: E402
import nw4r  # noqa: E402
import qc  # noqa: E402
import synth  # noqa: E402
import wavio  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
ROM = os.path.join(ROOT, "build", "rom", "ext", "files")
OUT = os.path.join(ROOT, "public", "assets", "audio")

ARCHIVES = [
    ("tnk", "Common/RPTnkScene/rp_Tnk_sound.brsar", ""),
    ("common", "Common/RPPartyCommon/rp_Common_Party.brsar", "common/"),
]

SEQ_RATE = 32000          # AX mixer output rate (all sequenced BGM is rendered at this rate)
SE_MAX_SECONDS = 30.0
IDLE_TICKS = 96 * 3       # stop an SE render after 3 s with no voices and no new notes

# Gameplay BGM: stems per sequence track (layering is done with SetTrackMute at runtime)
STEM_SOUNDS = {"RP_TNK_BGM_LOOP2"}

# RPTnkBgmMix::sTrackMasks (decomp src/Pack/RPParty/RPTnkScene/RPTnkBgmMix.cpp,
# DOL 0x802F73C0): [strongest enemy type - 1][min(enemies left, 4) - 1]
TNK_TRACK_MASKS = [
    [0x411, 0x411, 0x411, 0x411], [0x491, 0x491, 0x493, 0x493], [0x4C3, 0x4D3, 0x4D3, 0x4D9],
    [0x419, 0x459, 0x4D9, 0x4D9], [0x4E3, 0x4F3, 0x4F9, 0x4F9], [0x543, 0x573, 0x5F9, 0x5F9],
    [0x547, 0x567, 0x5F7, 0x5FD], [0x713, 0x7B9, 0x7F9, 0x7F9], [0x7ED, 0x7ED, 0x7ED, 0x7ED],
]
TNK_ENEMY_TYPES = ["brown", "ash", "marine", "pink", "yellow", "violet", "green", "white", "black"]

# Instrument names for the Tank_bgm_play2 bank programs (inferred from the samples' key
# splits/usage and the in-game layer behaviour; the bank itself carries no names).
TNK_BGM_PROGRAMS = {
    0: "piccolo",
    1: "snare drum",
    2: "marching percussion (C1 bass drum, F#1-E2 timpani, G2 cymbals)",
    3: "metronome (A0 tick / A#0 tock)",
    4: "tuba",
    5: "synthesizer",
    6: "tubular bells (stereo)",
}
# Per-track role in RP_TNK_BGM_LOOP2 (track numbers are nw4r sequence track numbers;
# bit n of a track mask == track n).
TNK_LOOP2_TRACKS = {
    0: ("piccolo", "melody: two piccolos (always on)"),
    1: ("timpani_a", "timpani, short phrase (variant A)"),
    2: ("tubular_bells", "tubular bells - green tank (and black)"),
    3: ("timpani_b", "timpani, extended phrase (variant B) - pink tank"),
    4: ("snare", "snare drum - brown tank"),
    5: ("bass_drum", "bass drum - yellow tank"),
    6: ("cymbals", "cymbals - marine (teal) tank"),
    7: ("metronome", "metronome - ash (grey) tank"),
    8: ("tuba", "tuba - violet (purple) tank"),
    9: ("synth", "synthesizer - white tank (and black)"),
    10: ("intro_snare", "mission-intro snare roll; plays only before the loop point"),
}


# ---------------------------------------------------------------------------

class Archive:
    def __init__(self, key, relpath, prefix):
        self.key = key
        self.relpath = relpath
        self.prefix = prefix
        self.path = os.path.join(ROM, relpath)
        self.dir = os.path.dirname(self.path)
        self.rsar = nw4r.RSAR(open(self.path, "rb").read())
        self._banks = {}
        self._seqs = {}

    def bank(self, bank_id):
        if bank_id not in self._banks:
            b = self.rsar.banks[bank_id]
            m, w = self.rsar.file_data(b["file_id"])
            self._banks[bank_id] = synth.BankSampler(nw4r.RBNK(m, w))
        return self._banks[bank_id]

    def seq(self, file_id):
        if file_id not in self._seqs:
            m, _ = self.rsar.file_data(file_id)
            self._seqs[file_id] = nw4r.RSEQ(m)
        return self._seqs[file_id]


_ARCH = {}


def archive(key):
    if key not in _ARCH:
        for k, rel, pre in ARCHIVES:
            if k == key:
                _ARCH[k] = Archive(k, rel, pre)
    return _ARCH[key]


def category(name):
    return "bgm" if "_BGM_" in name else "se"


def out_path(arc, name, sub=""):
    cat = category(name)
    return os.path.join(cat, arc.prefix.rstrip("/"), sub, name + ".wav").replace("//", "/").lstrip("/")


def mix_stems(outs, tracks, a, b):
    n = b - a
    L = [0.0] * n
    R = [0.0] * n
    for t in tracks:
        l, r = outs[t]
        for i in range(n):
            L[i] += l[a + i]
            R[i] += r[a + i]
    return L, R


def concat(parts):
    L, R = [], []
    for l, r in parts:
        L.extend(l)
        R.extend(r)
    return L, R


def trim_tail(L, R, thresh=1.0 / 65536):
    n = len(L)
    while n > 1 and abs(L[n - 1]) < thresh and abs(R[n - 1]) < thresh:
        n -= 1
    return L[:n], R[:n]


def scaled(chans, g):
    if g == 1.0:
        return chans
    return [[x * g for x in c] for c in chans]


def headroom_gain(peak):
    """Uniform render gain so nothing clips. 1.0 unless the peak exceeds -0.1 dBFS."""
    if peak <= 0.9886:
        return 1.0
    return math.floor(0.98 / peak * 1000) / 1000.0


def seq_labels_at(rseq, off):
    return sorted(n for n, o in rseq.labels.items() if o == off)


def describe_random(events):
    seen = {}
    for e in events:
        k = (e["cmd"], e["min"], e["max"])
        if k not in seen:
            cmd = e["cmd"]
            nm = cmd if isinstance(cmd, str) else mml.NAMES.get(cmd, "cmd_%02X" % cmd)
            seen[k] = {"command": nm, "min": e["min"], "max": e["max"], "rendered_value": e["value"],
                       "occurrences": 0}
        seen[k]["occurrences"] += 1
    return list(seen.values())


def common_info(arc, s):
    r = arc.rsar
    info = {
        "archive": arc.key,
        "id": s["id"],
        "type": s["type"],
        "category": category(s["name"]),
        "volume": s["volume"],
        "gain": round(s["volume"] / 127.0, 6),
        "player": r.players[s["player_id"]]["name"] if s["player_id"] < len(r.players) else None,
        "player_id": s["player_id"],
        "player_priority": s["player_priority"],
        "player_max_sounds": r.players[s["player_id"]]["playable_sound_count"]
        if s["player_id"] < len(r.players) else None,
        "actor_player_id": s["actor_player_id"],
        "pan_mode": s["pan_mode"],
        "pan_curve": s["pan_curve"],
        "remote_filter": s["remote_filter"],
        "user_param": s["user_param"],
        "param3d": s.get("param3d"),
    }
    if s["type"] == "SEQ":
        q = s["seq"]
        info["seq"] = {
            "file_id": s["file_id"],
            "offset": q["data_offset"],
            "labels": seq_labels_at(arc.seq(s["file_id"]), q["data_offset"]),
            "bank": r.banks[q["bank_id"]]["name"],
            "bank_id": q["bank_id"],
            "alloc_track": q["alloc_track"],
            "channel_priority": q["channel_priority"],
            "release_priority_fix": q["release_priority_fix"],
        }
    elif s["type"] == "WAVE":
        q = s["wave"]
        info["wave"] = {"file_id": s["file_id"], "index": q["sub_no"], "alloc_track": q["alloc_track"],
                        "channel_priority": q["channel_priority"],
                        "release_priority_fix": q["release_priority_fix"]}
    elif s["type"] == "STRM":
        info["strm"] = {"file": arc.rsar.files[s["file_id"]]["ext"], **s["strm"]}
    return info


def write_out(relpath, rate, chans, loop=None):
    path = os.path.join(OUT, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clipped = wavio.write_wav(path, rate, chans, smpl_loop=loop)
    return clipped


def file_entry(relpath, rate, chans, loop=None, clipped=0, seam=None):
    n = len(chans[0])
    e = {"file": relpath, "sample_rate": rate, "channels": len(chans), "samples": n,
         "duration": round(n / rate, 6)}
    if loop:
        e["loop"] = {"start": loop[0], "end": loop[1], "start_sec": round(loop[0] / rate, 6),
                     "end_sec": round(loop[1] / rate, 6)}
    else:
        e["loop"] = None
    e["qc"] = qc.stats(chans, rate, clipped=clipped, loop=loop, seam=seam)
    return e


# ---------------------------------------------------------------------------
# SE (sequence) rendering

def run_se(arc, s, rate, policy="center", overrides=None, max_seconds=SE_MAX_SECONDS):
    q = s["seq"]
    rs = arc.seq(s["file_id"])
    pl = synth.SeqPlayer(rs.code, q["data_offset"], arc.bank(q["bank_id"]), q["alloc_track"],
                         out_rate=rate, rand_policy=policy, rand_overrides=overrides)
    outs, n, info = synth.render_sequence(pl, 16, max_seconds, stop_when_idle=True,
                                          idle_ticks=IDLE_TICKS)
    return pl, outs, n, info


def se_loop_region(pl, outs, n, rate):
    """For an SE that never ends (a held note on a looping wave), find an exact
    output loop. Returns (start, end) or None."""
    live = [c for c in pl.all_channels if c.active]
    if len(live) != 1:
        return None
    ch = live[0]
    if ch.length != -1 or not ch.src.loop:
        return None
    step = ch.pitch
    loop_len_src = ch.src.le - ch.src.ls
    L = loop_len_src / step
    if abs(L - round(L)) > 1e-6:
        return None
    L = int(round(L))
    # sample index at which the channel started
    start = None
    for i, c in enumerate(pl.all_channels):
        if c is ch:
            start = getattr(c, "start_sample", None)
    if start is None:
        return None
    k = int(math.ceil(ch.src.ls / step - 1e-9))
    ls = start + k
    # envelope settles within a few frames; leave >= 50 ms after the channel start
    while ls - start < rate // 20:
        ls += L
    if ls + L > n:
        return None
    return ls, ls + L


def build_se(arc_key, name):
    arc = archive(arc_key)
    s = arc.rsar.by_name[name]
    entry = common_info(arc, s)
    t0 = time.time()
    # pass 1 at 32 kHz: which waves are used -> output rate = highest native rate
    pl, outs, n, info = run_se(arc, s, SEQ_RATE, overrides={0x81: "lcg"})
    rates = sorted({arc.bank(s["seq"]["bank_id"]).src_wave(w).rate for w in pl.waves_used})
    rate = rates[-1] if rates else SEQ_RATE
    if rate != SEQ_RATE:
        pl, outs, n, info = run_se(arc, s, rate, overrides={0x81: "lcg"})
    used_tracks = sorted({c.stem for c in pl.all_channels})
    L, R = mix_stems(outs, range(16), 0, n)
    loop = None
    hit_limit = n >= int(SE_MAX_SECONDS * rate)
    if hit_limit:
        loop = se_loop_region(pl, outs, n, rate)
    seam = None
    loop_kind = None
    if loop:
        loop_kind = "wave"
        a, b = loop
        m = min(4096, n - b)
        seam = max([abs(L[a + i] - L[b + i]) for i in range(m)] + [0.0])
        L, R = L[:b], R[:b]
    elif hit_limit:
        # sequence-level loop (e.g. a jump back to a note); cut one steady-state period
        loopinfo, _, dry = analyze_loop(arc, s)
        if loopinfo:
            ls_t, P = loopinfo
            q = s["seq"]
            rs = arc.seq(s["file_id"])
            pl = synth.SeqPlayer(rs.code, q["data_offset"], arc.bank(q["bank_id"]),
                                 q["alloc_track"], out_rate=rate, rand_policy="center",
                                 rand_overrides={0x81: "lcg"})
            outs, n, info = synth.render_sequence(pl, 16, SE_MAX_SECONDS * 4, stop_when_idle=False,
                                                  tick_limit=ls_t + 2 * P + 96)
            tt = info["tick_times"]
            S0, S1, S2 = tt[ls_t], tt[ls_t + P], tt[ls_t + 2 * P]
            m = min(4096, n - S2)
            A = mix_stems(outs, range(16), 0, S0)
            B = mix_stems(outs, range(16), S1, S2)
            C1 = mix_stems(outs, range(16), S1, S1 + m)
            C2 = mix_stems(outs, range(16), S2, S2 + m)
            seam = max([abs(x - y) for x, y in zip(C1[0] + C1[1], C2[0] + C2[1])] + [0.0])
            L, R = concat([A, B])
            loop = (S0, S0 + (S2 - S1))
            loop_kind = "sequence"
            entry["sequence"] = {"loop_start_tick": ls_t, "loop_period_ticks": P,
                                 "tempo": dry.tempo, "timebase": dry.timebase}
    else:
        L, R = trim_tail(L, R)
    if not pl.notes:
        entry["empty"] = True
        entry["file"] = None
        entry["render"] = {"renderer": "seq", "note": "sequence plays no notes (fin only)",
                           "ticks": pl.tick}
        return name, entry
    peak = max(max(map(abs, L)), max(map(abs, R)))
    g = headroom_gain(peak)
    chans = scaled([L, R], g)
    rel = out_path(arc, name)
    clipped = write_out(rel, rate, chans, loop)
    entry.update(file_entry(rel, rate, chans, loop, clipped, seam * g if seam is not None else None))
    entry["render"] = {
        "renderer": "seq",
        "source_rates": rates,
        "tracks_used": used_tracks,
        "voices": len(pl.all_channels),
        "notes": len(pl.notes),
        "ticks": pl.tick,
        "random": describe_random(pl.random_events),
        "random_policy": "range centre for pitch/volume/wait/transpose; LCG (nw4r seed) for prg",
        "infinite": bool(hit_limit),
        "loop_kind": loop_kind,
        "render_gain": g,
        "playback_gain": round(s["volume"] / 127.0 / g, 6),
    }
    if hit_limit and not loop:
        entry["render"]["note"] = "sound never ends on its own; truncated at %.0f s" % SE_MAX_SECONDS
    # variants for a single random program choice (e.g. tread clicks pick 1 of 4 samples)
    prg_rand = [e for e in pl.random_events if e["cmd"] == 0x81]
    variants = []
    if len(prg_rand) == 1:
        mn, mx = prg_rand[0]["min"], prg_rand[0]["max"]
        for v in range(mn, mx + 1):
            vpl, vouts, vn, _ = run_se(arc, s, rate, overrides={0x81: v})
            vL, vR = scaled(trim_tail(*mix_stems(vouts, range(16), 0, vn)), g)
            vrel = out_path(arc, name + "__prg%d" % v, "variants")
            vc = write_out(vrel, rate, [vL, vR])
            ve = file_entry(vrel, rate, [vL, vR], None, vc)
            ve["prg"] = v
            variants.append(ve)
    if variants:
        entry["variants"] = variants
    entry["render"]["seconds"] = round(time.time() - t0, 2)
    return name, entry


# ---------------------------------------------------------------------------
# BGM rendering

class _NullBank:
    def lookup(self, *a):
        return None


def analyze_loop(arc, s, max_ticks=20000):
    q = s["seq"]
    rs = arc.seq(s["file_id"])
    pl = synth.SeqPlayer(rs.code, q["data_offset"], _NullBank(), q["alloc_track"])
    while pl.tick < max_ticks:
        if pl.parse_tick():
            return None, pl.tick, pl
    by = {}
    for tick, tr, frm, to in pl.jump_log:
        by.setdefault((tr, to), []).append(tick)
    periods, starts = [], []
    for (tr, to), ticks in by.items():
        if len(ticks) < 3:
            continue
        d = {b - a for a, b in zip(ticks, ticks[1:])}
        if len(d) != 1:
            continue
        p = d.pop()
        periods.append(p)
        starts.append(ticks[0] - p)
    if not periods:
        return None, None, pl
    P = 1
    for p in periods:
        P = P * p // math.gcd(P, p)
    return (max(starts), P), None, pl


def track_summary(notes, track, lo, hi):
    ns = [n for n in notes if n[1] == track and lo <= n[0] < hi]
    if not ns:
        return {"notes": 0}
    keys = [n[3] for n in ns]
    vels = [n[4] for n in ns]
    prgs = sorted({n[2] for n in ns})
    return {"notes": len(ns), "programs": prgs, "key_min": min(keys), "key_max": max(keys),
            "key_range": "%s-%s" % (mml.note_name(min(keys)), mml.note_name(max(keys))),
            "velocity_min": min(vels), "velocity_max": max(vels)}


def build_bgm_seq(arc_key, name):
    arc = archive(arc_key)
    s = arc.rsar.by_name[name]
    entry = common_info(arc, s)
    t0 = time.time()
    q = s["seq"]
    rs = arc.seq(s["file_id"])
    bank = arc.bank(q["bank_id"])
    rate = SEQ_RATE
    loopinfo, end_tick, dry = analyze_loop(arc, s)
    alloc = [i for i in range(16) if q["alloc_track"] >> i & 1]
    # sequence-variable / conditional usage (game-side layering hooks)
    ents = [q["data_offset"]]
    inss = mml.disassemble(rs.code, ents)
    cond = [mml.fmt(i) for i in inss if i["prefix"] and "if" in i["prefix"]
            or i["name"] in mml.EX_NAMES.values() or i["name"] == "mute"
            or (i["prefix"] and "var" in i["prefix"])]
    pl = synth.SeqPlayer(rs.code, q["data_offset"], bank, q["alloc_track"], out_rate=rate,
                         rand_policy="center")
    seam = None
    if loopinfo:
        ls_t, P = loopinfo
        limit = ls_t + 2 * P + 96
        est = limit * rate * 60.0 / (dry.timebase * max(1, dry.tempo)) / rate * 1.5 + 5
        outs, n, info = synth.render_sequence(pl, 16, est, stop_when_idle=False, tick_limit=limit)
        tt = info["tick_times"]
        S0, S1, S2 = tt[ls_t], tt[ls_t + P], tt[ls_t + 2 * P]
        m = min(4096, n - S2)
        loop = (S0, S0 + (S2 - S1))

        def seg(tracks):
            a = mix_stems(outs, tracks, 0, S0)
            b = mix_stems(outs, tracks, S1, S2)
            return concat([a, b])

        def seam_err(tracks):
            a = mix_stems(outs, tracks, S1, S1 + m)
            b = mix_stems(outs, tracks, S2, S2 + m)
            return max([abs(x - y) for x, y in zip(a[0] + a[1], b[0] + b[1])] + [0.0])
        # intro tails cut at the loop point (energy that rang past S0 in the real first pass)
        intro_tail = mix_stems(outs, range(16), S0, S1)
        steady = mix_stems(outs, range(16), S1, S2)
        diff = max([abs(a - b) for a, b in zip(intro_tail[0][:rate], steady[0][:rate])] + [0.0])
        mixL, mixR = seg(range(16))
        seam = seam_err(range(16))
        bpm = dry.tempo
        entry["sequence"] = {
            "tempo": bpm, "timebase": dry.timebase,
            "ticks_per_second": dry.timebase * bpm / 60.0,
            "loop_start_tick": ls_t, "loop_end_tick": ls_t + P, "loop_period_ticks": P,
            "first_pass_vs_steady_loop_max_diff": round(diff, 6),
            "tracks_allocated": alloc,
            "variables_or_conditionals": cond,
        }
    else:
        outs, n, info = synth.render_sequence(pl, 16, 120, stop_when_idle=False)
        mixL, mixR = trim_tail(*mix_stems(outs, range(16), 0, n))
        loop = None
        entry["sequence"] = {"tempo": dry.tempo, "timebase": dry.timebase,
                             "ticks_per_second": dry.timebase * dry.tempo / 60.0,
                             "length_ticks": end_tick, "tracks_allocated": alloc,
                             "variables_or_conditionals": cond}
    peak = max(max(map(abs, mixL)), max(map(abs, mixR)))
    g = headroom_gain(peak)
    chans = scaled([mixL, mixR], g)
    rel = out_path(arc, name)
    clipped = write_out(rel, rate, chans, loop)
    entry.update(file_entry(rel, rate, chans, loop, clipped, seam * g if seam is not None else None))
    entry["render"] = {"renderer": "seq", "render_gain": g,
                       "playback_gain": round(s["volume"] / 127.0 / g, 6),
                       "voices": len(pl.all_channels), "notes": len(pl.notes),
                       "seconds": None}
    # per-track info
    lo, hi = (loopinfo[0], loopinfo[0] + loopinfo[1]) if loopinfo else (0, 1 << 30)
    tracks = []
    used = sorted({c.stem for c in pl.all_channels} | set(alloc))
    is_loop2 = arc.key == "tnk" and name == "RP_TNK_BGM_LOOP2"
    for t in used:
        ti = {"track": t}
        ti["intro"] = track_summary(pl.notes, t, 0, lo) if loopinfo else None
        ti["loop"] = track_summary(pl.notes, t, lo, hi) if loopinfo else track_summary(pl.notes, t, 0, hi)
        prgs = sorted(set((ti["loop"] or {}).get("programs", []) + ((ti["intro"] or {}).get("programs", []))))
        ti["programs"] = prgs
        if arc.key == "tnk" and q["bank_id"] == 1:
            ti["instruments"] = [TNK_BGM_PROGRAMS.get(p, "?") for p in prgs]
        if is_loop2 and t in TNK_LOOP2_TRACKS:
            ti["layer"], ti["role"] = TNK_LOOP2_TRACKS[t]
        tracks.append(ti)
    entry["tracks"] = tracks
    if name in STEM_SOUNDS and loopinfo:
        stems = []
        for ti in tracks:
            t = ti["track"]
            sl, sr = seg([t])
            sc = scaled([sl, sr], g)
            srel = os.path.join("bgm", arc.prefix.rstrip("/"), "stems", name,
                                "track_%02d.wav" % t).replace("//", "/")
            c = write_out(srel, rate, sc, loop)
            se = file_entry(srel, rate, sc, loop, c, seam_err([t]) * g)
            se["track"] = t
            lp = max(max(abs(x) for x in c[S0:]) for c in sc)
            ip = max([abs(x) for c in sc for x in c[:S0]] + [0.0])
            se["loop_peak"] = round(lp, 6)
            se["intro_peak"] = round(ip, 6)
            if "layer" in ti:
                se["layer"] = ti["layer"]
            stems.append(se)
            ti["stem"] = srel
        entry["stems"] = stems
        entry["stems_note"] = ("Stems are sample-aligned, identical length and share the loop "
                               "points of the mix; mix == sum(stems) (before 16-bit rounding).")
    entry["render"]["seconds"] = round(time.time() - t0, 2)
    return name, entry


def build_wave(arc_key, name):
    """WAVE sound (RWSD): one channel, note 0 of the wsd entry (WsdPlayer::StartChannel)."""
    arc = archive(arc_key)
    s = arc.rsar.by_name[name]
    entry = common_info(arc, s)
    m, w = arc.rsar.file_data(s["file_id"])
    rw = nw4r.RWSD(m, w)
    e = rw.entries[s["wave"]["sub_no"]]
    note = e["notes"][0]
    wv = rw.wave(note["wave_index"])
    src = synth.SrcWave(wv)
    rate = wv.rate
    ch = synth.Channel(src, rate)
    ch.env.set_attack(note["attack"])
    ch.env.decay = synth.calc_release(note["decay"])
    ch.env.sustain = note["sustain"]
    ch.env.release = synth.calc_release(note["release"])
    ch.length = -1
    info = e["info"]
    ch.user_pitch_ratio = info["pitch"]
    p = info["pan"]
    ch.user_pan = (p - 63) / 63.0 if p <= 1 else (p - 64) / 63.0
    ch.main_send = info["main_send"] / 127.0
    loop = None
    if wv.loop and ch.user_pitch_ratio == 1.0:
        n = wv.loop_end
        loop = (wv.loop_start, wv.loop_end)
    else:
        n = int(math.ceil(wv.loop_end / ch.user_pitch_ratio)) + rate
    outs = [(synth.array("d", bytes(8 * n)), synth.array("d", bytes(8 * n)))]
    ch.render(outs, 0, n)
    L, R = list(outs[0][0]), list(outs[0][1])
    if not loop:
        L, R = trim_tail(L, R)
    rel = out_path(arc, name)
    clipped = write_out(rel, rate, [L, R], loop)
    entry.update(file_entry(rel, rate, [L, R], loop, clipped))
    entry["render"] = {"renderer": "wsd", "wsd_info": info, "note": note, "render_gain": 1.0,
                       "source": {"rate": wv.rate, "channels": len(wv.channels), "format": wv.format,
                                  "loop": wv.loop, "loop_start": wv.loop_start,
                                  "loop_end": wv.loop_end}}
    return name, entry


def build_strm(arc_key, name):
    arc = archive(arc_key)
    s = arc.rsar.by_name[name]
    entry = common_info(arc, s)
    ext = arc.rsar.files[s["file_id"]]["ext"]
    wv = nw4r.parse_rstm(open(os.path.join(arc.dir, ext), "rb").read())
    chans = [[x / 32768.0 for x in c] for c in wv.channels]
    loop = (wv.loop_start, wv.loop_end) if wv.loop else None
    rel = out_path(arc, name)
    # write the decoded PCM directly (bit-exact)
    from array import array
    nch = len(wv.channels)
    pcm = array("h", bytes(2 * nch * wv.loop_end))
    for c in range(nch):
        pcm[c::nch] = array("h", wv.channels[c])
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wavio.write_wav(path, wv.rate, pcm=pcm, nch=nch, smpl_loop=loop)
    entry.update(file_entry(rel, wv.rate, chans, loop, 0))
    entry["render"] = {"renderer": "strm", "source_file": ext, "format": wv.format,
                       "render_gain": 1.0}
    return name, entry


# ---------------------------------------------------------------------------

def job(args):
    kind, arc_key, name = args
    fn = {"se": build_se, "bgm": build_bgm_seq, "wave": build_wave, "strm": build_strm}[kind]
    try:
        return arc_key, fn(arc_key, name)
    except Exception as ex:  # keep going; report at the end
        import traceback
        return arc_key, (name, {"error": "%s: %s" % (type(ex).__name__, ex),
                                "traceback": traceback.format_exc()})


def plan(only=None):
    jobs = []
    for key, rel, pre in ARCHIVES:
        arc = archive(key)
        for s in arc.rsar.sounds:
            n = s["name"]
            if only and only not in n:
                continue
            if s["type"] == "SEQ":
                kind = "bgm" if category(n) == "bgm" else "se"
            elif s["type"] == "WAVE":
                kind = "wave"
            else:
                kind = "strm"
            jobs.append((kind, key, n))
    # longest first for better parallel packing
    order = {"strm": 0, "bgm": 1, "wave": 2, "se": 3}
    jobs.sort(key=lambda j: (order[j[0]], j[2] not in STEM_SOUNDS))
    return jobs


def archive_info(arc):
    r = arc.rsar
    return {
        "path": "build/rom/ext/files/" + arc.relpath,
        "rsar_version": "%d.%d" % (r.version >> 8, r.version & 0xFF),
        "output_prefix": arc.prefix,
        "players": [{"id": p["id"], "name": p["name"], "max_sounds": p["playable_sound_count"]}
                    for p in r.players],
        "banks": [{"id": b["id"], "name": b["name"], "file_id": b["file_id"]} for b in r.banks],
        "sound_count": len(r.sounds),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="only build sounds whose name contains this")
    ap.add_argument("--jobs", type=int, default=os.cpu_count() or 1)
    a = ap.parse_args()
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    jobs = plan(a.only)
    print("building %d sounds with %d jobs" % (len(jobs), a.jobs))
    results = {k: {} for k, _, _ in ARCHIVES}
    errors = []
    if a.jobs > 1:
        with Pool(a.jobs) as pool:
            it = pool.imap_unordered(job, jobs)
            for i, (key, (name, entry)) in enumerate(it):
                results[key][name] = entry
                status = "ERROR " + entry["error"] if "error" in entry else "%.1fs" % entry.get(
                    "duration", 0)
                print("[%3d/%d] %s/%s %s" % (i + 1, len(jobs), key, name, status), flush=True)
                if "error" in entry:
                    errors.append((key, name, entry["traceback"]))
    else:
        for i, j in enumerate(jobs):
            key, (name, entry) = job(j)
            results[key][name] = entry
            print("[%3d/%d] %s/%s" % (i + 1, len(jobs), key, name), flush=True)
            if "error" in entry:
                errors.append((key, name, entry["traceback"]))
    man_path = os.path.join(OUT, "manifest.json")
    full_path = os.path.join(OUT, "build_details.json")
    if a.only and os.path.exists(full_path):
        details = json.load(open(full_path))
        for key in results:
            details["sounds"].setdefault(key, {}).update(results[key])
    else:
        details = {
            "schema_version": 1,
            "generator": "tools/audio/build_audio.py",
            "notes": [
                "Files are rendered at unity sound volume. Play each sound at manifest 'gain' "
                "(= INFO volume / 127, linear) or, when render_gain != 1, at render.playback_gain.",
                "Sequenced BGM is rendered at 32000 Hz (the AX mixer rate); SEs at the highest "
                "native rate of the samples they use; streams and wave sounds at their native rate.",
                "Loop points are sample indices: loop.start inclusive, loop.end exclusive. WAVs "
                "also carry a RIFF 'smpl' loop.",
            ],
            "archives": {k: archive_info(archive(k)) for k, _, _ in ARCHIVES},
            "tnk_bgm_layers": tnk_layers(),
            "sounds": results,
        }
    for key in details["sounds"]:
        details["sounds"][key] = dict(sorted(details["sounds"][key].items(),
                                             key=lambda kv: kv[1].get("id", 9999)))
    manifest = public_manifest(details)
    with open(man_path, "w") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
    with open(full_path, "w") as f:
        json.dump(details, f, indent=1, ensure_ascii=False)
    print("wrote %s (%.0f s)" % (man_path, time.time() - t0))
    for key, name, tb in errors:
        print("ERROR in %s/%s:\n%s" % (key, name, tb))
    return 1 if errors else 0


PUBLIC_KEYS = ("id", "file", "volume", "loop", "loopStart", "loopEnd", "sampleRate")


def public_entry(e):
    """Flatten a detailed build entry into the shape the game reads."""
    if "error" in e:
        return {"error": e["error"]}
    r = e.get("render", {})
    g = r.get("render_gain", 1.0) or 1.0
    out = {"id": e["id"], "file": e.get("file"), "volume": round(e["volume"] / 127.0 / g, 6)}
    lp = e.get("loop")
    out["loop"] = bool(lp)
    if lp:
        out["loopStart"] = lp["start"]
        out["loopEnd"] = lp["end"]
    if e.get("file"):
        out["sampleRate"] = e["sample_rate"]
        out["channels"] = e["channels"]
        out["samples"] = e["samples"]
        out["duration"] = e["duration"]
    out["type"] = e["type"]
    out["category"] = e["category"]
    if e.get("empty"):
        out["empty"] = True
    if e["volume"] == 0:
        out["runtimeVolume"] = True
    if e.get("variants"):
        out["variants"] = [{"file": v["file"], "prg": v["prg"], "samples": v["samples"],
                            "duration": v["duration"]} for v in e["variants"]]
    meta = {k: v for k, v in e.items() if k not in ("file", "loop", "sample_rate", "channels",
                                                     "samples", "duration", "id", "variants",
                                                     "stems", "tracks", "type", "category")}
    meta["volumeRaw"] = e["volume"]
    meta.pop("volume", None)
    meta.pop("gain", None)
    out["meta"] = meta
    return out


def public_bgm(e):
    b = public_entry(e)
    b.pop("meta", None)
    b.pop("category", None)
    b["volumeRaw"] = e["volume"]
    if "sequence" in e:
        b["sequence"] = e["sequence"]
    if e.get("render"):
        b["renderGain"] = e["render"].get("render_gain", 1.0)
    if e.get("tracks"):
        b["tracks"] = e["tracks"]
    if e.get("stems"):
        b["stems"] = [{"track": st["track"], "file": st["file"], "layer": st.get("layer"),
                       "samples": st["samples"],
                       "silentInIntro": st.get("intro_peak", 0) < 1e-4,
                       "silentInLoop": st.get("loop_peak", 0) < 1e-4}
                      for st in e["stems"]]
        b["stemsNote"] = e.get("stems_note")
    return b


def public_manifest(details):
    tnk = details["sounds"].get("tnk", {})
    com = details["sounds"].get("common", {})
    return {
        "schemaVersion": 2,
        "generator": details["generator"],
        "notes": details["notes"] + [
            "sounds/bgm: Tanks archive (rp_Tnk_sound.brsar), keyed by exact brsar label. "
            "commonSounds/commonBgm: party-common archive (rp_Common_Party.brsar).",
            "volume is the linear playback gain (INFO volume / 127, divided by renderGain when a "
            "render had to be attenuated to avoid clipping). runtimeVolume=true: INFO volume is 0 "
            "and the game is expected to set the level itself.",
            "Full per-sound details (QC, random parameters, sequence info): build_details.json.",
        ],
        "sounds": {n: public_entry(e) for n, e in tnk.items()},
        "bgm": {n: public_bgm(e) for n, e in tnk.items() if e.get("category") == "bgm"},
        "commonSounds": {n: public_entry(e) for n, e in com.items()},
        "commonBgm": {n: public_bgm(e) for n, e in com.items() if e.get("category") == "bgm"},
        "tnkBgmLayers": details["tnk_bgm_layers"],
    }


def tnk_layers():
    tracks = {str(t): {"layer": l, "role": r} for t, (l, r) in TNK_LOOP2_TRACKS.items()}
    configs = []
    for ti, row in enumerate(TNK_TRACK_MASKS):
        for ci, mask in enumerate(row):
            configs.append({
                "strongest_enemy_type": ti + 1, "enemy": TNK_ENEMY_TYPES[ti],
                "enemies_left": ci + 1 if ci < 3 else "4+",
                "mask": mask, "mask_hex": "0x%03X" % mask,
                "tracks": [b for b in range(16) if mask >> b & 1],
                "layers": [TNK_LOOP2_TRACKS[b][0] for b in range(11) if mask >> b & 1],
            })
    return {
        "sound": "RP_TNK_BGM_LOOP2",
        "source": "RPTnkBgmMix::sTrackMasks (decomp src/Pack/RPParty/RPTnkScene/RPTnkBgmMix.cpp; "
                  "main.dol 0x802F73C0)",
        "lookup": "mask = masks[clamp(strongestEnemyType,1,9)-1][min(clamp(enemiesLeft,1,8),4)-1]",
        "apply": "SeqSoundHandle::SetTrackMute(0xFFFF, MUTE_NO_STOP) then "
                 "SetTrackMute(mask, MUTE_OFF). MUTE_NO_STOP: a muted track stops starting "
                 "new notes but notes already sounding ring out; unmuting takes effect at the "
                 "track's next note-on. Default mask before the first update: 0x411.",
        "masks": TNK_TRACK_MASKS,
        "enemy_types": TNK_ENEMY_TYPES,
        "tracks": tracks,
        "configs": configs,
    }


if __name__ == "__main__":
    sys.exit(main())
