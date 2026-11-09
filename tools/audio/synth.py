"""Offline renderer for NW4R sequences (RSEQ + RBNK) and wave sounds.

This is a port of the playback semantics of nw4r::snd (Wii Sports / Wii Play
generation): SeqPlayer / SeqTrack / MmlParser / Channel / EnvGenerator / Lfo /
Bank / Voice pan law.  Differences from hardware, all deliberate:

* Sequencer ticks are evaluated at their exact sample position instead of being
  batched at the start of each 3 ms AX frame.  This keeps loops exactly
  periodic (hardware jitter is < 3 ms).
* Envelope / LFO / sweep advance every 3 ms (96 samples at 32 kHz) on a per-
  channel grid, with the envelope gain ramped linearly across the frame, as
  the AX "VE" ramp does.
* Resampling uses 4-point Catmull-Rom interpolation (AX uses a 4-tap
  polyphase filter).  At a ratio of exactly 1.0 the source samples pass
  through bit-exact.
* AUX effect sends (reverb) are ignored; only the main (dry) mix is rendered.
"""
import math
from array import array
from fractions import Fraction

AX_FRAME_MS = 3
VOLUME_MIN_DB = -90.4
VOLUME_MAX_DB = 6.0

ATTACK_TABLE = [
    0.9992175, 0.9984326, 0.9976452, 0.9968553, 0.9960629, 0.9952679, 0.9944704, 0.9936704,
    0.9928677, 0.9920625, 0.9912546, 0.9904441, 0.9896309, 0.9888151, 0.9879965, 0.9871752,
    0.9863512, 0.9855244, 0.9846949, 0.9838625, 0.9830273, 0.9821893, 0.9813483, 0.9805045,
    0.9796578, 0.9788081, 0.9779555, 0.9770999, 0.9762413, 0.9753797, 0.9745150, 0.9736472,
    0.9727763, 0.9719023, 0.9710251, 0.9701448, 0.9692612, 0.9683744, 0.9674844, 0.9665910,
    0.9656944, 0.9647944, 0.9638910, 0.9629842, 0.9620740, 0.9611604, 0.9602433, 0.9593226,
    0.9583984, 0.9574706, 0.9565392, 0.9556042, 0.9546655, 0.9537231, 0.9527769, 0.9518270,
    0.9508732, 0.9499157, 0.9489542, 0.9479888, 0.9470195, 0.9460462, 0.9450689, 0.9440875,
    0.9431020, 0.9421124, 0.9411186, 0.9401206, 0.9391184, 0.9381118, 0.9371009, 0.9360856,
    0.9350659, 0.9340417, 0.9330131, 0.9319798, 0.9309420, 0.9298995, 0.9288523, 0.9278004,
    0.9267436, 0.9256821, 0.9246156, 0.9235442, 0.9224678, 0.9213864, 0.9202998, 0.9192081,
    0.9181112, 0.9170091, 0.9159016, 0.9147887, 0.9136703, 0.9125465, 0.9114171, 0.9102821,
    0.9091414, 0.9079949, 0.9068427, 0.9056845, 0.9045204, 0.9033502, 0.9021740, 0.9009916,
    0.8998029, 0.8986080, 0.8974066, 0.8961988, 0.8949844, 0.8900599, 0.8824622, 0.8759247,
    0.8691861, 0.8636406, 0.8535788, 0.8430189, 0.8286135, 0.8149099, 0.8002172, 0.7780663,
    0.7554750, 0.7242125, 0.6828239, 0.6329169, 0.5592135, 0.4551411, 0.3298770, 0.0000000]

DECIBEL_SQUARE_TABLE = [
    -723, -722, -721, -651, -601, -562, -530, -503, -480, -460, -442, -425,
    -410, -396, -383, -371, -360, -349, -339, -330, -321, -313, -305, -297,
    -289, -282, -276, -269, -263, -257, -251, -245, -239, -234, -229, -224,
    -219, -214, -210, -205, -201, -196, -192, -188, -184, -180, -176, -173,
    -169, -165, -162, -158, -155, -152, -149, -145, -142, -139, -136, -133,
    -130, -127, -125, -122, -119, -116, -114, -111, -109, -106, -103, -101,
    -99, -96, -94, -91, -89, -87, -85, -82, -80, -78, -76, -74,
    -72, -70, -68, -66, -64, -62, -60, -58, -56, -54, -52, -50,
    -49, -47, -45, -43, -42, -40, -38, -36, -35, -33, -31, -30,
    -28, -27, -25, -23, -22, -20, -19, -17, -16, -14, -13, -11,
    -10, -8, -7, -6, -4, -3, -1, 0]

LFO_SIN = [0, 6, 12, 19, 25, 31, 37, 43, 49, 54, 60, 65, 71, 76, 81, 85, 90, 94, 98,
           102, 106, 109, 112, 115, 117, 120, 122, 123, 125, 126, 126, 127, 127]

ST_ATTACK, ST_DECAY, ST_SUSTAIN, ST_RELEASE = 0, 1, 2, 3


def calc_release(r):
    if r == 127:
        return 65535.0
    if r == 126:
        return 24.0
    if r < 50:
        return (r * 2 + 1) / 128.0 / 5.0
    return 60.0 / (126 - r) / 5.0


def volume_ratio(db):
    if db <= VOLUME_MIN_DB:
        return 0.0
    if db > VOLUME_MAX_DB:
        db = VOLUME_MAX_DB
    # Decibel2RatioTable has 0.1 dB resolution
    return 10.0 ** (int(db * 10) / 200.0)


def pitch_ratio(cent):
    """Util::CalcPitchRatio(MICROTONE_MAX * cent)."""
    return 2.0 ** (int(256 * cent) / 3072.0)


def pan_ratio(pan):
    """Util::CalcPanRatio, PAN_CURVE_SQRT: tbl[idx] = sqrt(1 - idx/256)."""
    if pan < -1.0:
        pan = -1.0
    elif pan > 1.0:
        pan = 1.0
    idx = int((pan + 1.0) / 2.0 * 256 + 0.5)
    return math.sqrt(1.0 - idx / 256.0)


class Random:
    """Util::CalcRandom (static LCG, seed 0x12345678)."""

    def __init__(self, seed=0x12345678):
        self.u = seed

    def next(self):
        self.u = (self.u * 0x19660D + 0x3C6EF35F) & 0xFFFFFFFF
        return (self.u >> 16) & 0xFFFF


class Env:
    def __init__(self):
        self.set_attack(127)
        self.decay = calc_release(127)
        self.sustain = 127
        self.release = calc_release(127)
        self.reset()

    def set_attack(self, a):
        self.attack = ATTACK_TABLE[a]

    def reset(self):
        self.value = VOLUME_MIN_DB * 10.0
        self.status = ST_ATTACK

    def get(self):
        if self.status == ST_ATTACK and self.attack == 0.0:
            return 0.0
        return self.value / 10.0

    def update(self, msec):
        st = self.status
        if st == ST_ATTACK:
            while msec > 0:
                self.value *= self.attack
                msec -= 1
                if self.value > -(1.0 / 32.0):
                    self.value = 0.0
                    self.status = ST_DECAY
            if self.status != ST_DECAY:
                return
            st = ST_DECAY
        if st == ST_DECAY:
            sus = DECIBEL_SQUARE_TABLE[self.sustain]
            self.value -= self.decay * msec
            if self.value > sus:
                return
            self.value = sus
            self.status = ST_SUSTAIN
        elif st == ST_RELEASE:
            self.value -= self.release * msec


class LfoParam:
    __slots__ = ("depth", "range", "speed", "delay")

    def __init__(self):
        self.depth = 0.0
        self.range = 1
        self.speed = 6.25
        self.delay = 0

    def copy(self):
        p = LfoParam()
        p.depth, p.range, p.speed, p.delay = self.depth, self.range, self.speed, self.delay
        return p


class Lfo:
    def __init__(self):
        self.p = LfoParam()
        self.counter = 0.0
        self.delay_counter = 0

    def update(self, msec):
        p = self.p
        if self.delay_counter < p.delay:
            if self.delay_counter + msec <= p.delay:
                self.delay_counter += msec
                return
            msec -= p.delay - self.delay_counter
            self.delay_counter = p.delay
        self.counter += p.speed * msec / 1000.0
        self.counter -= int(self.counter)

    def value(self):
        p = self.p
        if p.depth == 0.0 or self.delay_counter < p.delay:
            return 0.0
        idx = int(4 * (32 * self.counter))
        if idx < 32:
            s = LFO_SIN[idx]
        elif idx < 64:
            s = LFO_SIN[32 - (idx - 32)]
        elif idx < 96:
            s = -LFO_SIN[idx - 64]
        else:
            s = -LFO_SIN[32 - (idx - 96)]
        return s / 127.0 * p.depth * p.range


class SrcWave:
    """Wave prepared for interpolation: per channel float arrays with guard samples."""

    def __init__(self, wave):
        self.rate = wave.rate
        self.loop = wave.loop
        self.ls = wave.loop_start
        self.le = wave.loop_end
        self.nch = len(wave.channels)
        self.data = []
        for ch in wave.channels:
            d = [x / 32768.0 for x in ch[:self.le]]
            if len(d) < self.le:
                d += [0.0] * (self.le - len(d))
            if self.loop:
                tail = d[self.ls:self.ls + 3]
                while len(tail) < 3:
                    tail += d[self.ls:self.ls + 3 - len(tail)] or [0.0]
            else:
                tail = [0.0, 0.0, 0.0]
            self.data.append([d[0] if d else 0.0] + d + tail)


class Channel:
    __slots__ = ("src", "out_rate", "track", "stem", "pos", "key", "orig_key", "init_volume",
                 "tune", "init_pan", "env", "lfo", "lfo_target", "sweep_pitch", "sweep_len",
                 "sweep_cnt", "auto_sweep", "length", "user_volume", "user_pitch",
                 "user_pitch_ratio", "user_pan", "user_lpf", "main_send", "active",
                 "frame_left", "g0", "g1", "pitch", "gains", "lpf_state", "lpf_coef",
                 "start_sample", "volume")

    def __init__(self, src, out_rate):
        self.src = src
        self.out_rate = out_rate
        self.track = None
        self.stem = 0
        self.pos = 0.0
        self.key = 60
        self.orig_key = 60
        self.init_volume = 1.0
        self.tune = 1.0
        self.init_pan = 0.0
        self.env = Env()
        self.lfo = Lfo()
        self.lfo_target = 0
        self.sweep_pitch = 0.0
        self.sweep_len = 0
        self.sweep_cnt = 0
        self.auto_sweep = True
        self.length = 0
        self.user_volume = 1.0
        self.user_pitch = 0.0
        self.user_pitch_ratio = 1.0
        self.user_pan = 0.0
        self.user_lpf = 0.0
        self.main_send = 1.0
        self.active = True
        self.frame_left = 0
        self.g0 = self.g1 = 0.0
        self.pitch = 1.0
        self.gains = []
        self.lpf_state = [0.0] * src.nch
        self.lpf_coef = None
        self.volume = 1.0
        self.start_sample = 0

    # --- Channel API used by tracks
    def release(self):
        if self.env.status != ST_RELEASE:
            self.env.status = ST_RELEASE

    def is_release(self):
        return self.env.status == ST_RELEASE

    def sweep_value(self):
        if self.sweep_pitch == 0.0 or self.sweep_cnt >= self.sweep_len:
            return 0.0
        return self.sweep_pitch * (self.sweep_len - self.sweep_cnt) / self.sweep_len

    def update_sweep(self, n):
        self.sweep_cnt += n
        if self.sweep_cnt > self.sweep_len:
            self.sweep_cnt = self.sweep_len

    def frame_update(self):
        """Channel::Update(periodic=true). Returns False if the channel stopped."""
        lfo_v = self.lfo.value()
        volume = self.init_volume * self.user_volume
        ve_init = volume_ratio(self.env.get())
        if self.lfo_target == 1:
            ve_init *= volume_ratio(VOLUME_MAX_DB * lfo_v)
        if self.env.status == ST_RELEASE and ve_init == 0.0:
            self.active = False
            return False
        cent = self.key - self.orig_key + self.sweep_value() + self.user_pitch
        if self.lfo_target == 0:
            cent += lfo_v
        pitch = pitch_ratio(cent) * self.tune * self.user_pitch_ratio
        pan = self.init_pan + self.user_pan
        if self.lfo_target == 2:
            pan += lfo_v
        if self.auto_sweep:
            self.update_sweep(AX_FRAME_MS)
        self.lfo.update(AX_FRAME_MS)
        self.env.update(AX_FRAME_MS)
        ve_t = volume_ratio(self.env.get())
        if self.lfo_target == 1:
            ve_t *= volume_ratio(VOLUME_MAX_DB * self.lfo.value())
        ms = self.main_send
        if ms < 0.0:
            ms = 0.0
        elif ms > 1.0:
            ms = 1.0
        v = volume * ms
        self.g0 = ve_init * v
        self.g1 = ve_t * v
        self.pitch = pitch * self.src.rate / self.out_rate
        src = self.src
        gains = []
        for c in range(src.nch):
            vp = 0.0
            if src.nch == 2:
                vp = -1.0 if c == 0 else 1.0
            p = pan + vp
            gains.append((pan_ratio(p), pan_ratio(-p)))
        self.gains = gains
        # LPF (Voice::CalcAxLpf): freq = 32000 * 2^(10*(scale-1)), off at >= 16 kHz
        scale = 1.0 + self.user_lpf
        scale = min(max(scale, 0.0), 1.0)
        freq = int(32000 * 2.0 ** (10.0 * (scale - 1.0)))
        if freq >= 16000:
            self.lpf_coef = None
        else:
            b0 = math.exp(-2.0 * math.pi * freq / 32000.0)
            self.lpf_coef = (1.0 - b0, b0)
        self.frame_left = self.out_rate * AX_FRAME_MS // 1000
        return True

    def render(self, outs, start, n):
        """Mix n samples into outs (list of [L, R] buffers per stem) from index start."""
        out_l, out_r = outs[self.stem]
        frame_len = self.out_rate * AX_FRAME_MS // 1000
        src = self.src
        le = src.le
        loop = src.loop
        loop_len = le - src.ls
        i = start
        end = start + n
        while i < end and self.active:
            if self.frame_left <= 0:
                if not self.frame_update():
                    return
            m = min(self.frame_left, end - i)
            # gain ramp across the frame
            done = frame_len - self.frame_left
            g0, g1 = self.g0, self.g1
            dg = (g1 - g0) / frame_len
            g = g0 + dg * done
            step = self.pitch
            pos0 = self.pos
            finished_at = None
            for c in range(src.nch):
                d = src.data[c]
                gl, gr = self.gains[c]
                pos = pos0
                gg = g
                lp = self.lpf_coef
                ys = self.lpf_state[c]
                j = i
                jend = i + m
                if step == 1.0 and pos == int(pos) and lp is None:
                    # bit-exact path
                    while j < jend:
                        ip = int(pos)
                        if ip >= le:
                            if loop:
                                pos -= loop_len
                                ip = int(pos)
                            else:
                                finished_at = j
                                break
                        s = d[ip + 1] * gg
                        out_l[j] += s * gl
                        out_r[j] += s * gr
                        gg += dg
                        pos += 1.0
                        j += 1
                else:
                    while j < jend:
                        ip = int(pos)
                        if ip >= le:
                            if loop:
                                pos -= loop_len
                                ip = int(pos)
                            else:
                                finished_at = j
                                break
                        t = pos - ip
                        y0 = d[ip]
                        y1 = d[ip + 1]
                        y2 = d[ip + 2]
                        y3 = d[ip + 3]
                        s = y1 + 0.5 * t * (y2 - y0 + t * (2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3
                                                           + t * (3.0 * (y1 - y2) + y3 - y0)))
                        if lp is not None:
                            ys = lp[0] * s + lp[1] * ys
                            s = ys
                        s *= gg
                        out_l[j] += s * gl
                        out_r[j] += s * gr
                        gg += dg
                        pos += step
                        j += 1
                self.lpf_state[c] = ys
                last_pos = pos
            self.pos = last_pos
            if finished_at is not None:
                self.active = False
                return
            self.frame_left -= m
            i += m


# ---------------------------------------------------------------------------
# Sequence player
# ---------------------------------------------------------------------------

class Track:
    def __init__(self, player, no):
        self.player = player
        self.no = no
        self.opened = False
        self.channels = []
        self.ext_volume = 1.0
        self.init_param()

    def init_param(self):
        self.base = None
        self.cur = 0
        self.wait = 0
        self.mute = False
        self.silence = False
        self.note_finish_wait = False
        self.porta_flag = False
        self.damper = False
        self.prg = 0
        self.lfo = LfoParam()
        self.lfo_target = 0
        self.sweep_pitch = 0.0
        self.volume = 127
        self.volume2 = 127
        self.pitchbend = 0
        self.bendrange = 2
        self.pan = 0
        self.init_pan = 0
        self.surround_pan = 0
        self.transpose = 0
        self.priority = 64
        self.porta_key = 60
        self.porta_time = 0
        self.attack = self.decay = self.sustain = self.release = 0xFF
        self.main_send = 127
        self.fx_send = [0, 0, 0]
        self.lpf = 64
        self.vars = [-1] * 16
        # MmlSeqTrack
        self.note_wait = True
        self.tie = False
        self.cmp = True
        self.stack = []  # [addr, loopcount]

    def close(self):
        self.release_all()
        self.channels = []
        self.opened = False

    def release_all(self, release=-1):
        self.update_channel_param()
        for ch in self.channels:
            if ch.active:
                if release >= 0:
                    ch.env.release = calc_release(release)
                ch.release()

    def update_channel_length(self):
        if not self.opened:
            return
        for ch in self.channels:
            if ch.length > 0:
                ch.length -= 1
            if ch.length == 0 and not ch.is_release() and not self.damper:
                ch.release()
            if not ch.auto_sweep:
                ch.update_sweep(1)

    def prune(self):
        self.channels = [c for c in self.channels if c.active]

    def update_channel_param(self):
        if not self.opened or not self.channels:
            return
        p = self.player
        v = (self.volume / 127.0) ** 2 * (self.volume2 / 127.0) ** 2 * (p.volume / 127.0) ** 2
        v *= self.ext_volume * p.ext_volume
        pitch = (self.pitchbend / 128.0) * self.bendrange
        pan = min(max(self.pan / 63.0, -1.0), 1.0)
        lpf = (self.lpf - 64) / 64.0
        ms = (self.main_send / 127.0) - 1.0
        for ch in self.channels:
            ch.user_volume = v
            ch.user_pitch = pitch
            ch.user_pan = pan
            ch.user_lpf = lpf
            ch.main_send = 1.0 + ms
            ch.lfo.p = self.lfo.copy()
            ch.lfo_target = self.lfo_target

    def var_ptr(self, idx):
        if idx < 32:
            return self.player.var_ref(idx)
        if idx < 48:
            return (self.vars, idx - 32)
        return None

    def get_var(self, idx):
        r = self.var_ptr(idx)
        return r[0][r[1]] if r else 0

    def set_var(self, idx, val):
        r = self.var_ptr(idx)
        if r:
            val &= 0xFFFF
            r[0][r[1]] = val - 65536 if val >= 32768 else val

    def parse_next_tick(self, do_note_on=True):
        if not self.opened:
            return 0
        if self.note_finish_wait:
            self.prune()
            if self.channels:
                return 1
            self.note_finish_wait = False
        if self.wait > 0:
            self.wait -= 1
            if self.wait > 0:
                return 1
        guard = 0
        while self.wait == 0 and not self.note_finish_wait:
            if self.parse(do_note_on) == "finish":
                return -1
            guard += 1
            if guard > 100000:
                raise RuntimeError("sequence stuck in zero-wait loop")
        return 1

    # --- MmlParser::Parse
    def parse(self, do_note_on):
        c = self.base
        p = self.cur
        pl = self.player

        def rd():
            nonlocal p
            v = c[p]
            p += 1
            return v

        def rd16():
            return (rd() << 8) | rd()

        def rd24():
            return (rd() << 16) | (rd() << 8) | rd()

        def rdvar():
            v = 0
            while True:
                b = rd()
                v = (v << 7) | (b & 0x7F)
                if not b & 0x80:
                    return v

        argtype = None
        cmd = rd()
        do_exec = True
        if cmd == 0xA2:
            cmd = rd()
            do_exec = self.cmp
        if cmd == 0xA0:
            cmd = rd()
            argtype = "rand"
        if cmd == 0xA1:
            cmd = rd()
            argtype = "var"

        def arg(default):
            t = argtype or default
            if t == "u8":
                return rd()
            if t == "s16":
                return rd16()
            if t == "vlq":
                return rdvar()
            if t == "var":
                i = rd()
                return self.get_var(i)
            if t == "rand":
                mn = rd16()
                mx = rd16()
                mn = mn - 65536 if mn >= 32768 else mn
                mx = mx - 65536 if mx >= 32768 else mx
                return pl.random_arg(self, cmd, mn, mx)

        if not cmd & 0x80:
            vel = rd()
            length = arg("vlq")
            key = cmd + self.transpose
            self.cur = p
            if not do_exec:
                return "continue"
            key = min(max(key, 0), 127)
            if not self.mute and do_note_on:
                self.note_on(key, vel, length if length > 0 else -1, self.tie)
            if self.note_wait:
                self.wait = length
                if length == 0:
                    self.note_finish_wait = True
            return "continue"

        a1 = a2 = 0
        g = cmd & 0xF0
        if g == 0x80:
            if cmd == 0x80:
                t = arg("vlq")
                self.cur = p
                if do_exec:
                    self.wait = t
            elif cmd == 0x81:
                a1 = arg("vlq")
                self.cur = p
                if do_exec:
                    self.command(cmd, a1, 0)
            elif cmd == 0x88:
                tr = rd()
                off = rd24()
                self.cur = p
                if do_exec:
                    self.command(cmd, tr, off)
            elif cmd in (0x89, 0x8A):
                off = rd24()
                self.cur = p
                if do_exec:
                    self.command(cmd, off, 0)
            else:
                self.cur = p
        elif g in (0xB0, 0xC0, 0xD0):
            v = arg("u8") & 0xFF
            self.cur = p
            if do_exec:
                if cmd in (0xC3, 0xC4) and v >= 128:
                    v -= 256
                self.command(cmd, v, 0)
        elif g == 0x90:
            self.cur = p
            if do_exec:
                self.command(cmd, 0, 0)
        elif g == 0xE0:
            v = arg("s16") & 0xFFFF
            v = v - 65536 if v >= 32768 else v
            self.cur = p
            if do_exec:
                self.command(cmd, v, 0)
        elif g == 0xF0:
            if cmd == 0xFE:
                rd16()
                self.cur = p
            elif cmd == 0xFF:
                self.cur = p
                return "finish"
            elif cmd == 0xF0:
                ex = rd()
                if ex & 0xF0 == 0xE0:
                    a1 = arg("s16")
                    self.cur = p
                elif ex & 0xF0 in (0x80, 0x90):
                    a1 = rd()
                    a2 = arg("s16") & 0xFFFF
                    a2 = a2 - 65536 if a2 >= 32768 else a2
                    self.cur = p
                    if do_exec:
                        self.ex_command(ex, a1, a2)
                else:
                    self.cur = p
            else:
                self.cur = p
                if do_exec:
                    self.command(cmd, 0, 0)
        else:
            self.cur = p
        return "continue"

    def ex_command(self, ex, a1, a2):
        if self.var_ptr(a1) is None:
            return
        v = self.get_var(a1)
        if ex == 0x80:
            self.set_var(a1, a2)
        elif ex == 0x81:
            self.set_var(a1, v + a2)
        elif ex == 0x82:
            self.set_var(a1, v - a2)
        elif ex == 0x83:
            self.set_var(a1, v * a2)
        elif ex == 0x84:
            if a2:
                self.set_var(a1, int(v / a2))
        elif ex == 0x85:
            self.set_var(a1, v << a2 if a2 >= 0 else v >> -a2)
        elif ex == 0x86:
            r = self.player.random_var(self, a1, a2)
            self.set_var(a1, r)
        elif ex == 0x87:
            self.set_var(a1, v & a2)
        elif ex == 0x88:
            self.set_var(a1, v | a2)
        elif ex == 0x89:
            self.set_var(a1, v ^ a2)
        elif ex == 0x8A:
            self.set_var(a1, ~(a2 & 0xFFFF))
        elif ex == 0x8B:
            if a2:
                self.set_var(a1, int(math.fmod(v, a2)))
        elif ex == 0x90:
            self.cmp = v == a2
        elif ex == 0x91:
            self.cmp = v >= a2
        elif ex == 0x92:
            self.cmp = v > a2
        elif ex == 0x93:
            self.cmp = v <= a2
        elif ex == 0x94:
            self.cmp = v < a2
        elif ex == 0x95:
            self.cmp = v != a2
        self.player.log.append((self.player.tick, self.no, "ex%02X" % ex, a1, a2))

    def command(self, cmd, a1, a2):
        pl = self.player
        if cmd == 0xE1:
            pl.tempo = a1
        elif cmd == 0xB0:
            pl.timebase = a1
        elif cmd == 0x81:
            if a1 < 128:
                self.prg = a1 & 127
        elif cmd == 0xDD:
            self.set_mute(a1)
        elif cmd == 0xC1:
            self.volume = a1
        elif cmd == 0xD5:
            self.volume2 = a1
        elif cmd == 0xC2:
            pl.volume = a1
        elif cmd == 0xC3:
            self.transpose = a1
        elif cmd == 0xC4:
            self.pitchbend = a1
        elif cmd == 0xC5:
            self.bendrange = a1
        elif cmd == 0xC0:
            self.pan = a1 - 64
        elif cmd == 0xDC:
            self.init_pan = a1 - 64
        elif cmd == 0xD7:
            self.surround_pan = a1
        elif cmd == 0xC6:
            self.priority = a1
        elif cmd == 0xC7:
            self.note_wait = bool(a1)
        elif cmd == 0xCF:
            self.porta_time = a1
        elif cmd == 0xCA:
            self.lfo.depth = (a1 & 0xFF) / 128.0
        elif cmd == 0xCB:
            self.lfo.speed = (a1 & 0xFF) * (100.0 / 256.0)
        elif cmd == 0xCC:
            self.lfo_target = a1
        elif cmd == 0xCD:
            self.lfo.range = a1
        elif cmd == 0xE0:
            self.lfo.delay = a1 * 5
        elif cmd == 0xE3:
            self.sweep_pitch = a1 / 32.0
        elif cmd == 0xD0:
            self.attack = a1
        elif cmd == 0xD1:
            self.decay = a1
        elif cmd == 0xD2:
            self.sustain = a1
        elif cmd == 0xD3:
            self.release = a1
        elif cmd == 0xDF:
            self.damper = (a1 & 0xFF) >= 64
        elif cmd == 0xC8:
            self.tie = bool(a1)
            self.release_all()
            self.channels = []
        elif cmd == 0xC9:
            self.porta_key = (a1 + self.transpose) & 0xFF
            self.porta_flag = True
        elif cmd == 0xCE:
            self.porta_flag = a1 != 0
        elif cmd == 0xD8:
            self.lpf = a1
        elif cmd == 0xD9:
            self.fx_send[0] = a1
        elif cmd == 0xDA:
            self.fx_send[1] = a1
        elif cmd == 0xDE:
            self.fx_send[2] = a1
        elif cmd == 0xDB:
            self.main_send = a1
        elif cmd == 0x88:
            t = pl.tracks[a1] if a1 < 16 else None
            if t is not None and t is not self:
                t.close()
                t.init_param()
                t.base = self.base
                t.cur = a2
                t.opened = True
        elif cmd == 0x89:
            pl.jump_log.append((pl.tick, self.no, self.cur, a1))
            self.cur = a1
        elif cmd == 0x8A:
            if len(self.stack) < 3:
                self.stack.append([self.cur, 0])
                self.cur = a1
        elif cmd == 0xFD:
            if self.stack:
                self.cur = self.stack.pop()[0]
        elif cmd == 0xD4:
            if len(self.stack) < 3:
                self.stack.append([self.cur, a1])
        elif cmd == 0xFC:
            if self.stack:
                top = self.stack[-1]
                cnt = top[1]
                if cnt != 0:
                    cnt -= 1
                    if cnt == 0:
                        self.stack.pop()
                        return
                top[1] = cnt
                self.cur = top[0]

    def set_mute(self, m):
        if m == 0:
            self.mute = False
        elif m == 1:  # MUTE_STOP
            for ch in self.channels:
                ch.active = False
            self.channels = []
            self.mute = True
        elif m == 2:  # MUTE_RELEASE
            self.release_all()
            self.channels = []
            self.mute = True
        elif m == 3:
            self.mute = True

    def note_on(self, key, vel, length, tie):
        pl = self.player
        ch = None
        if tie and self.channels:
            ch = self.channels[-1]
            ch.key = key
            ch.init_volume = (vel / 127.0) ** 2
        if ch is None:
            ch = pl.bank_note_on(self, key, vel, -1 if tie else length)
            if ch is None:
                return
            self.channels.append(ch)
        if self.attack != 0xFF:
            ch.env.set_attack(self.attack)
        if self.decay != 0xFF:
            ch.env.decay = calc_release(self.decay)
        if self.sustain != 0xFF:
            ch.env.sustain = self.sustain
        if self.release != 0xFF:
            ch.env.release = calc_release(self.release)
        sweep = self.sweep_pitch
        if self.porta_flag:
            sweep += self.porta_key - key
        if self.porta_time == 0:
            ch.sweep_pitch, ch.sweep_len, ch.auto_sweep = sweep, length, False
        else:
            t = self.porta_time * self.porta_time
            t = int(t * abs(sweep))
            t = t >> 5
            t = (t << 2) + t
            ch.sweep_pitch, ch.sweep_len, ch.auto_sweep = sweep, t, True
        ch.sweep_cnt = 0
        self.porta_key = key


class SeqPlayer:
    """Plays one sequence sound. Each track's channels are routed to stem[track_no]."""

    def __init__(self, code, start, bank, alloc_track, out_rate=32000, rand_policy="lcg",
                 rand_seed=0x12345678, rand_overrides=None, global_vars=None):
        self.code = code
        self.bank = bank
        self.out_rate = out_rate
        self.tempo = 120
        self.timebase = 48
        self.volume = 127
        self.ext_volume = 1.0
        self.local_vars = [-1] * 16
        self.global_vars = global_vars if global_vars is not None else [-1] * 16
        self.tracks = [None] * 16
        self.rng = Random(rand_seed)
        self.rand_policy = rand_policy
        self.rand_overrides = rand_overrides or {}
        self.random_events = []
        self.log = []
        self.jump_log = []
        self.tick = 0
        self.notes = []  # (tick, track, prg, key, vel, length)
        self.waves_used = set()
        for i in range(16):
            if alloc_track & (1 << i):
                self.tracks[i] = Track(self, i)
        t0 = self.tracks[0]
        t0.base = code
        t0.cur = start
        t0.opened = True
        self.finished = False
        self.all_channels = []

    def var_ref(self, idx):
        if idx < 16:
            return (self.local_vars, idx)
        return (self.global_vars, idx - 16)

    def random_arg(self, track, cmd, mn, mx):
        r = self.rng.next()
        v_lcg = ((r * ((mx - mn) + 1)) >> 16) + mn
        pol = self.rand_overrides.get(cmd, self.rand_policy)
        if pol == "center":
            v = (mn + mx) // 2 if (mn + mx) >= 0 else -((-(mn + mx)) // 2)
        elif pol == "min":
            v = mn
        elif pol == "max":
            v = mx
        elif isinstance(pol, int):
            v = pol
        else:
            v = v_lcg
        self.random_events.append({"tick": self.tick, "track": track.no, "cmd": cmd,
                                   "min": mn, "max": mx, "value": v})
        return v

    def random_var(self, track, var, a2):
        minus = a2 < 0
        if minus:
            a2 = -a2
        r = (self.rng.next() * (a2 + 1)) >> 16
        if self.rand_policy == "center":
            r = a2 // 2
        if minus:
            r = -r
        self.random_events.append({"tick": self.tick, "track": track.no, "cmd": "randvar",
                                   "min": -a2 if minus else 0, "max": 0 if minus else a2, "value": r})
        return r

    def bank_note_on(self, track, key, vel, length):
        inst = self.bank.lookup(track.prg, key, vel)
        self.notes.append((self.tick, track.no, track.prg, key, vel, length))
        if inst is None:
            return None
        wave_idx = inst["wave_index"]
        self.waves_used.add(wave_idx)
        src = self.bank.src_wave(wave_idx)
        ch = Channel(src, self.out_rate)
        ch.track = track
        ch.stem = track.no
        ch.key = key
        ch.orig_key = inst["original_key"]
        ch.init_volume = (vel / 127.0) ** 2 * inst["volume"] / 127.0
        ch.tune = inst["tune"]
        ch.env.set_attack(inst["attack"])
        ch.env.decay = calc_release(inst["decay"])
        ch.env.sustain = inst["sustain"]
        ch.env.release = calc_release(inst["release"])
        ch.init_pan = (inst["pan"] - 64) / 63.0 + track.init_pan / 63.0
        ch.length = length
        self.all_channels.append(ch)
        return ch

    def base_tempo(self):
        return self.timebase * self.tempo / 60000.0  # ticks per msec

    def parse_tick(self):
        """SeqPlayer::ParseNextTick. Returns True if the player finished."""
        active = False
        for i in range(16):
            t = self.tracks[i]
            if t is None:
                continue
            t.prune()
            t.update_channel_length()
            if t.parse_next_tick(True) < 0:
                t.close()
                self.tracks[i] = None
                continue
            if t.opened:
                active = True
        self.tick += 1
        return not active

    def update_params(self):
        for t in self.tracks:
            if t is not None:
                t.update_channel_param()


def render_sequence(player, nstems, max_seconds, stop_when_idle=True, idle_ticks=None,
                    tick_limit=None, progress=None):
    """Run a SeqPlayer to completion (or limit). Returns (stems, total_samples, info)."""
    rate = player.out_rate
    total = int(max_seconds * rate)
    outs = [(array("d", bytes(8 * total)), array("d", bytes(8 * total))) for _ in range(nstems)]
    t_next = Fraction(0)  # time of next tick, in samples (exact)
    pos = 0
    live = []
    finished_at = None
    last_note_tick = 0
    tick_times = []
    while pos < total:
        # process all ticks due at or before pos
        while not player.finished and t_next <= pos:
            n_before = len(player.all_channels)
            done = player.parse_tick()
            tick_times.append(int(math.ceil(t_next)))
            player.update_params()
            if len(player.all_channels) != n_before:
                for c in player.all_channels[n_before:]:
                    c.start_sample = pos
                live.extend(player.all_channels[n_before:])
                last_note_tick = player.tick
            if done:
                player.finished = True
                finished_at = pos
                for t in player.tracks:
                    if t is not None:
                        t.close()
                break
            if player.timebase * player.tempo == 0:
                player.finished = True
                break
            t_next += Fraction(rate * 60, player.timebase * player.tempo)
            if tick_limit is not None and player.tick >= tick_limit:
                player.finished = True
                finished_at = pos
                break
        # stop conditions
        live = [c for c in live if c.active]
        if player.finished and not live:
            break
        if (stop_when_idle and idle_ticks is not None and not live
                and player.tick - last_note_tick > idle_ticks):
            break
        # render to next tick
        if player.finished:
            nxt = min(total, pos + 4096)
        else:
            nxt = min(total, max(pos + 1, int(math.ceil(t_next))))
        n = nxt - pos
        for ch in live:
            ch.render(outs, pos, n)
        pos = nxt
        if progress:
            progress(pos, total)
    length = pos
    for l, r in outs:
        del l[length:]
        del r[length:]
    return outs, length, {"finished_at": finished_at, "ticks": player.tick, "tick_times": tick_times}


class BankSampler:
    """Adapts an RBNK for the player (instrument lookup + prepared waves)."""

    def __init__(self, rbnk):
        self.rbnk = rbnk
        self._src = {}

    def lookup(self, prg, key, vel):
        return self.rbnk.lookup(prg, key, vel)

    def src_wave(self, idx):
        if idx not in self._src:
            self._src[idx] = SrcWave(self.rbnk.wave(idx))
        return self._src[idx]
