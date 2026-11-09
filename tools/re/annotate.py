"""Build an annotated listing of main.dol.

  python3 annotate.py OUTDIR
writes OUTDIR/annot.txt  (one line per instruction, with resolved constants:
  lis/addi|ori pairs, r2 (SDA2) and r13 (SDA) relative refs -> address, plus the
  string / float found there), OUTDIR/funcs.txt (function starts), and
  OUTDIR/xrefs.pkl {target_addr: [insn_addr,...]} and calls {callee:[caller insn]}.
Requires the raw objdump output OUTDIR/T*.raw.txt (see disasm.sh)."""
import sys, re, os, struct, pickle, glob
sys.path.insert(0, os.path.dirname(__file__))
from dol import Dol
R2 = 0x804818e0; R13 = 0x8047f980
d = Dol()
out = sys.argv[1]
line_re = re.compile(r'^([0-9a-f]{8}):\t([0-9a-f ]{11}) \t(\S+)\s*(.*)$')
insns = []
for f in sorted(glob.glob(os.path.join(out, 'T*.raw.txt'))):
    for ln in open(f):
        m = line_re.match(ln)
        if not m: continue
        a = int(m.group(1), 16); w = int(m.group(2).replace(' ', ''), 16)
        insns.append((a, w, m.group(3), m.group(4).strip()))
insns.sort()

def s16(x): return x - 0x10000 if x & 0x8000 else x

def describe(addr, loadkind=None):
    if addr is None: return ''
    s = d.sec(addr)
    if not s:
        if d.bss_addr <= addr < d.bss_addr + d.bss_size: return 'bss_%08x' % addr
        return ''
    st = d.cstr(addr)
    parts = ['%08x' % addr]
    if st and len(st) >= 2 and not d.is_text(addr):
        parts.append(repr(st[:80]))
    if loadkind in ('lfs', 'lfsu', 'lfsx', 'psq_l', 'psq_lx'):
        parts.append('f=%g' % d.f32(addr))
    elif loadkind in ('lfd', 'lfdu'):
        parts.append('d=%g' % d.f64(addr))
    elif loadkind in ('lwz', 'lwzu'):
        v = d.u32(addr)
        if v is not None:
            parts.append('w=%08x' % v)
            if not d.is_text(addr) and d.sec(v):
                st2 = d.cstr(v)
                if st2 and len(st2) >= 2: parts.append('->%r' % st2[:60])
    return ' '.join(parts)

xrefs = {}; calls = {}
funcs = set()
lisv = {}  # reg -> (value, insn index)
outl = []
mem_re = re.compile(r'^(\w+),(-?\d+)\((r\d+)\)$')
for i, (a, w, mn, ops) in enumerate(insns):
    op = w >> 26
    cmt = ''
    rD = (w >> 21) & 31; rA = (w >> 16) & 31; imm = w & 0xffff
    if i and insns[i-1][0] != a - 4: lisv.clear()
    if mn == 'blr' or (mn == 'b' ) or mn == 'bctr':
        pass
    tgt = None
    if op == 15:  # addis
        if rA == 0:
            lisv[rD] = ((imm << 16) & 0xffffffff, i)
        else:
            lisv.pop(rD, None)
    elif op in (14, 24) and rA in lisv:  # addi / ori from lis
        base = lisv[rA][0]
        tgt = (base + (s16(imm) if op == 14 else imm)) & 0xffffffff
        cmt = describe(tgt)
        if op == 14 and d.sec(tgt) and not d.is_text(tgt): lisv[rD] = (tgt, i)
        else: lisv.pop(rD, None)
    elif op in (32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,60,61):
        # D-form load/store; psq_l(56)/psq_st(60) have 12-bit displacement
        disp = s16(imm) if op not in (56, 57, 60, 61) else ((w & 0xfff) - 0x1000 if w & 0x800 else (w & 0xfff))
        if rA == 2: tgt = R2 + disp
        elif rA == 13: tgt = R13 + disp
        elif rA in lisv: tgt = (lisv[rA][0] + disp) & 0xffffffff
        if tgt is not None: cmt = describe(tgt, mn.rstrip('.'))
        if op in (32, 33, 34, 35, 40, 41, 42, 43, 48, 49, 50, 51) and rD in lisv: lisv.pop(rD, None)
    elif op == 14 and rA in (2, 13):
        tgt = (R2 if rA == 2 else R13) + s16(imm); cmt = describe(tgt)
        lisv.pop(rD, None)
    else:
        # any other write to rD kills lis tracking (approximate)
        if op in (14, 24, 21, 31, 7, 10, 11, 12, 13, 20, 23, 25, 26, 27, 28, 29):
            dreg = rA if op in (24, 25, 26, 27, 28, 29, 21, 20, 23) else rD
            if op == 31:
                dreg = rA if ((w >> 1) & 0x3ff) in (28, 60, 124, 284, 316, 412, 444, 476, 24, 536, 792, 824, 26, 954, 922) else rD
            lisv.pop(dreg, None)
    if op == 18 and (w & 1) or mn in ('bctrl', 'blrl'):
        for r in (0, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12): lisv.pop(r, None)
    if mn.startswith('bl') and op == 18 and (w & 1):
        t = int(ops, 16); calls.setdefault(t, []).append(a); funcs.add(t)
        cmt = 'call'
    elif op == 18:
        tgt = None
    if tgt is not None:
        xrefs.setdefault(tgt, []).append(a)
    if (w & 0xffff0000) == 0x94210000 and (w & 0x8000):  # stwu r1,-X(r1)
        funcs.add(a)
    outl.append('%08x: %08x  %-8s %-28s%s' % (a, w, mn, ops, ('; ' + cmt) if cmt else ''))
open(os.path.join(out, 'annot.txt'), 'w').write('\n'.join(outl) + '\n')
open(os.path.join(out, 'funcs.txt'), 'w').write('\n'.join('%08x' % f for f in sorted(funcs)) + '\n')
pickle.dump({'xrefs': xrefs, 'calls': calls}, open(os.path.join(out, 'xrefs.pkl'), 'wb'))
print(len(insns), 'insns', len(funcs), 'funcs', len(xrefs), 'xref targets')
