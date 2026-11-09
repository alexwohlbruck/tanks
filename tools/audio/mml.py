"""RSEQ (NW4R MML sequence) bytecode decoding and disassembly.

Command set follows nw4r::snd::detail::MmlParser (Wii Sports / Wii Play era).
"""

NAMES = {
    0x80: "wait", 0x81: "prg", 0x88: "opentrack", 0x89: "jump", 0x8A: "call",
    0xB0: "timebase", 0xB1: "env_hold", 0xB2: "monophonic", 0xB3: "velocity_range",
    0xC0: "pan", 0xC1: "volume", 0xC2: "main_volume", 0xC3: "transpose",
    0xC4: "pitchbend", 0xC5: "bendrange", 0xC6: "prio", 0xC7: "notewait",
    0xC8: "tie", 0xC9: "porta", 0xCA: "mod_depth", 0xCB: "mod_speed",
    0xCC: "mod_type", 0xCD: "mod_range", 0xCE: "porta_sw", 0xCF: "porta_time",
    0xD0: "attack", 0xD1: "decay", 0xD2: "sustain", 0xD3: "release",
    0xD4: "loop_start", 0xD5: "volume2", 0xD6: "printvar", 0xD7: "surround_pan",
    0xD8: "lpf_cutoff", 0xD9: "fxsend_a", 0xDA: "fxsend_b", 0xDB: "mainsend",
    0xDC: "init_pan", 0xDD: "mute", 0xDE: "fxsend_c", 0xDF: "damper",
    0xE0: "mod_delay", 0xE1: "tempo", 0xE3: "sweep_pitch",
    0xFC: "loop_end", 0xFD: "ret", 0xFE: "alloctrack", 0xFF: "fin",
}
EX_NAMES = {
    0x80: "setvar", 0x81: "addvar", 0x82: "subvar", 0x83: "mulvar", 0x84: "divvar",
    0x85: "shiftvar", 0x86: "randvar", 0x87: "andvar", 0x88: "orvar", 0x89: "xorvar",
    0x8A: "notvar", 0x8B: "modvar", 0x90: "cmp_eq", 0x91: "cmp_ge", 0x92: "cmp_gt",
    0x93: "cmp_le", 0x94: "cmp_lt", 0x95: "cmp_ne", 0xE0: "userproc",
}
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note_name(k):
    return "%s%d" % (NOTE_NAMES[k % 12], k // 12 - 1)


def var_name(i):
    if i < 16:
        return "VAR_%d" % i
    if i < 32:
        return "GVAR_%d" % (i - 16)
    return "TVAR_%d" % (i - 32)


def read_vlq(c, p):
    v = 0
    while True:
        b = c[p]
        p += 1
        v = (v << 7) | (b & 0x7F)
        if not b & 0x80:
            return v, p


def decode(c, p):
    """Decode one instruction at p. Returns dict with keys:
    off, len, prefix (list), cmd, name, args, targets (code offsets), end (bool)."""
    start = p
    prefix = []
    cmd = c[p]
    p += 1
    if cmd == 0xA2:
        prefix.append("if")
        cmd = c[p]
        p += 1
    argtype = None
    if cmd == 0xA0:
        prefix.append("rand")
        argtype = "rand"
        cmd = c[p]
        p += 1
    if cmd == 0xA1:
        prefix.append("var")
        argtype = "var"
        cmd = c[p]
        p += 1

    def arg(default):
        nonlocal p
        t = argtype or default
        if t == "u8":
            v = c[p]; p += 1
            return v
        if t == "s16":
            v = (c[p] << 8) | c[p + 1]; p += 2
            return v - 65536 if v >= 32768 else v
        if t == "vlq":
            v, p = read_vlq(c, p)
            return v
        if t == "var":
            v = c[p]; p += 1
            return var_name(v)
        if t == "rand":
            a = (c[p] << 8) | c[p + 1]
            b = (c[p + 2] << 8) | c[p + 3]
            p += 4
            a = a - 65536 if a >= 32768 else a
            b = b - 65536 if b >= 32768 else b
            return "rand(%d,%d)" % (a, b)

    ins = {"off": start, "prefix": prefix, "cmd": cmd, "targets": [], "end": False}
    if cmd < 0x80:
        vel = c[p]
        p += 1
        ln = arg("vlq")
        ins.update(name="note", args=[note_name(cmd), cmd, vel, ln])
    else:
        grp = cmd & 0xF0
        name = NAMES.get(cmd, "cmd_%02X" % cmd)
        args = []
        if cmd in (0x80, 0x81):
            args = [arg("vlq")]
        elif cmd == 0x88:
            tr = c[p]
            off = (c[p + 1] << 16) | (c[p + 2] << 8) | c[p + 3]
            p += 4
            args = [tr, off]
            ins["targets"] = [off]
            ins["open"] = (tr, off)
        elif cmd in (0x89, 0x8A):
            off = (c[p] << 16) | (c[p + 1] << 8) | c[p + 2]
            p += 3
            args = [off]
            ins["targets"] = [off]
            if cmd == 0x89 and "if" not in prefix:
                ins["end"] = True
        elif grp in (0xB0, 0xC0, 0xD0):
            v = arg("u8")
            if cmd in (0xC3, 0xC4) and isinstance(v, int) and v >= 128:
                v -= 256
            args = [v]
        elif grp == 0x90:
            args = []
        elif grp == 0xE0:
            args = [arg("s16")]
        elif cmd == 0xFE:
            args = ["0x%04X" % ((c[p] << 8) | c[p + 1])]
            p += 2
        elif cmd == 0xFF:
            ins["end"] = True
        elif cmd == 0xFD:
            if "if" not in prefix:
                ins["end"] = True
        elif cmd == 0xF0:
            ex = c[p]
            p += 1
            name = EX_NAMES.get(ex, "ex_%02X" % ex)
            if ex & 0xF0 == 0xE0:
                args = [arg("s16")]
            elif ex & 0xF0 in (0x80, 0x90):
                vi = c[p]
                p += 1
                args = [var_name(vi), arg("s16")]
            ins["ex"] = ex
        ins.update(name=name, args=args)
    ins["len"] = p - start
    return ins


def fmt(ins):
    pre = "".join(x + " " for x in ins["prefix"])
    a = ", ".join(str(x) for x in ins["args"])
    if ins["name"] in ("jump", "call"):
        a = "0x%04X" % ins["args"][0]
    if ins["name"] == "opentrack":
        a = "%d, 0x%04X" % (ins["args"][0], ins["args"][1])
    return "%s%s %s" % (pre, ins["name"], a)


def disassemble(code, entries):
    """Recursive-descent disassembly from entry offsets. Returns sorted list of instructions."""
    seen = {}
    work = list(entries)
    while work:
        p = work.pop()
        while 0 <= p < len(code) and p not in seen:
            ins = decode(code, p)
            seen[p] = ins
            work.extend(ins["targets"])
            if ins["end"]:
                break
            p += ins["len"]
    return [seen[k] for k in sorted(seen)]


def listing(code, entries, labels=None):
    labels = labels or {}
    lab_at = {}
    for n, o in labels.items():
        lab_at.setdefault(o, []).append(n)
    tgt = set()
    inss = disassemble(code, entries)
    for i in inss:
        tgt.update(i["targets"])
    lines = []
    prev_end = None
    for i in inss:
        if prev_end is not None and i["off"] != prev_end:
            lines.append("")
        for n in lab_at.get(i["off"], []):
            lines.append("%s:" % n)
        if i["off"] in tgt and i["off"] not in lab_at:
            lines.append("_%04X:" % i["off"])
        lines.append("  %04X  %s" % (i["off"], fmt(i)))
        prev_end = i["off"] + i["len"]
    return "\n".join(lines)
