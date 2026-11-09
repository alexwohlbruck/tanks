"""Audio sanity statistics for rendered files (stdlib only)."""
import math

BARS = " ▁▂▃▄▅▆▇█"


def db(x):
    return round(20 * math.log10(x), 2) if x > 0 else None


def stats(chans, rate, clipped=0, loop=None, seam=None, buckets=48):
    n = len(chans[0])
    peak = 0.0
    sq = 0.0
    dc = 0.0
    zc = 0
    for c in chans:
        prev = 0.0
        for x in c:
            ax = abs(x)
            if ax > peak:
                peak = ax
            sq += x * x
            dc += x
            if (x >= 0) != (prev >= 0):
                zc += 1
            prev = x
    tot = max(1, n * len(chans))
    rms = math.sqrt(sq / tot)
    # waveform summary: per-bucket peak (max over channels), log-scaled to 0..8
    env = []
    if n:
        for b in range(buckets):
            a = b * n // buckets
            e = max(a + 1, (b + 1) * n // buckets)
            pk = max(max(abs(x) for x in c[a:e]) for c in chans)
            if pk <= 1e-4:
                env.append(BARS[0])
            else:
                lvl = (20 * math.log10(pk) + 60) / 60  # -60 dBFS .. 0 dBFS
                env.append(BARS[max(1, min(8, int(round(lvl * 8))))])
    out = {
        "peak": round(peak, 6),
        "peak_dbfs": db(peak),
        "rms_dbfs": db(rms),
        "dc_offset": round(dc / tot, 7),
        "zero_cross_rate": round(zc / tot, 5),
        "clipped_samples": clipped,
        "silent": peak < 1e-4,
        "waveform": "".join(env),
    }
    if loop:
        a, e = loop
        # discontinuity at the seam: jump from last loop sample back to loop start,
        # compared with typical sample-to-sample movement
        jump = max(abs(c[e - 1] - c[a]) for c in chans) if e - 1 < n else None
        typ = 0.0
        cnt = 0
        for c in chans:
            for i in range(max(a + 1, e - 2048), e):
                typ = max(typ, abs(c[i] - c[i - 1]))
                cnt += 1
        out["loop_seam_jump"] = round(jump, 6) if jump is not None else None
        out["loop_local_max_step"] = round(typ, 6)
        if seam is not None:
            out["loop_periodicity_error"] = round(seam, 8)
    return out
