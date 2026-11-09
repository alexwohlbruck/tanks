"""Find loads from TnkGameParam: global *(r13-25208) -> +52 = file data.
Tank record n at data+4+n*168 (42 words); mission rec m at data+1684+m*88.
Linear per-function register tag tracking (approximate)."""
import re, sys, os, bisect
out = '/tmp/tanks_re'
funcs = [int(l, 16) for l in open(os.path.join(out, 'funcs.txt'))]
lr = re.compile(r'^([0-9a-f]{8}): ([0-9a-f]{8})  (\S+)\s+(\S*)')
tags = {}
res = []
cur = None
for ln in open(os.path.join(out, 'annot.txt')):
    m = lr.match(ln)
    if not m: continue
    a = int(m.group(1), 16); mn = m.group(3); ops = m.group(4).split(',')
    i = bisect.bisect_right(funcs, a) - 1
    if funcs[i] != cur: cur = funcs[i]; tags = {}
    def T(r): return tags.get(r)
    mm = re.match(r'^(-?\d+)\((r\d+)\)$', ops[-1]) if ops else None
    if mn in ('lwz', 'lfs', 'lha', 'lhz', 'lbz', 'lwzu', 'lfd', 'psq_l') and len(ops) >= 2 and re.match(r'-?\d+\(', ops[1]):
        mo = re.match(r'^(-?\d+)\((r\d+)\)$', ops[1])
        if not mo: continue
        off, base = mo.groups(); off = int(off)
        rd = ops[0]; t = T(base)
        if base == 'r13' and off == -25208: tags[rd] = ('G',)
        elif t == ('G',) and off == 52: tags[rd] = ('P', 0)
        elif t and t[0] == 'P':
            res.append((a, cur, 'hdr/abs', t[1] + off, mn, rd)); tags.pop(rd, None)
        elif t and t[0] == 'R':
            o = t[1] + off
            res.append((a, cur, 'tank k%d' % ((o - 4) // 4) if (o - 4) % 4 == 0 else 'tank +%d' % o, o, mn, rd)); tags.pop(rd, None)
        elif t and t[0] == 'MR':
            o = t[1] + off
            res.append((a, cur, 'mission w%d' % ((o - 1684) // 4), o, mn, rd)); tags.pop(rd, None)
        else:
            tags.pop(rd, None)
        if mn.endswith('u'): tags.pop(base, None)
    elif mn == 'mulli':
        rd, ra, imm = ops; imm = int(imm)
        tags[rd] = ('M', imm) if imm in (168, 88) else None
    elif mn == 'add' and len(ops) == 3:
        rd, ra, rb = ops; ta, tb = T(ra), T(rb)
        if ta and tb and {ta[0], tb[0]} == {'P', 'M'}:
            pm = ta if ta[0] == 'P' else tb; mm_ = tb if ta[0] == 'P' else ta
            tags[rd] = ('R', pm[1]) if mm_[1] == 168 else ('MR', pm[1])
        else: tags.pop(rd, None)
    elif mn == 'addi' and len(ops) == 3 and T(ops[1]) and T(ops[1])[0] in ('P', 'R', 'MR'):
        t = T(ops[1]); tags[ops[0]] = (t[0], t[1] + int(ops[2]))
    elif mn == 'mr' and len(ops) == 2:
        tags[ops[0]] = T(ops[1])
    elif mn in ('bl', 'bctrl', 'blrl'):
        for r in ('r0', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12'): tags.pop(r, None)
    else:
        if ops and re.match(r'^r\d+$', ops[0]) and not mn.startswith(('st', 'cmp', 'b', 'mt')): tags.pop(ops[0], None)
for r in res: print('%08x fn %08x  %-12s off %4d %-5s %s' % r)
