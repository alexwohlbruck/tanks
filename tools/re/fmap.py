"""Summarise functions in [lo,hi): size, callers, strings, globals, calls.
python3 fmap.py 8023c000 8025c000"""
import sys, re, os, bisect, pickle
out = '/tmp/tanks_re'
lo, hi = int(sys.argv[1], 16), int(sys.argv[2], 16)
funcs = [int(l, 16) for l in open(os.path.join(out, 'funcs.txt'))]
calls = pickle.load(open(os.path.join(out, 'xrefs.pkl'), 'rb'))['calls']
info = {}
for ln in open(os.path.join(out, 'annot.txt')):
    a = int(ln[:8], 16)
    if a < lo: continue
    if a >= hi: break
    f = funcs[bisect.bisect_right(funcs, a) - 1]
    I = info.setdefault(f, {'n': 0, 's': [], 'g': set(), 'c': [], 'fl': []})
    I['n'] += 1
    m = re.search(r"; [0-9a-f]{8} (?:w=\S+ ->)?('.*')", ln)
    if m and m.group(1) not in I['s']: I['s'].append(m.group(1))
    m = re.search(r'\(r13\)\s+; (bss_\w+|\S+)', ln)
    if m: I['g'].add(m.group(1).replace('bss_', ''))
    m = re.search(r'bl\s+0x([0-9a-f]+)', ln)
    if m: I['c'].append(m.group(1))
    m = re.search(r'\(r2\)\s+; \S+ .*?f=(\S+)', ln)
    if m and m.group(1) not in I['fl']: I['fl'].append(m.group(1))
for f in sorted(info):
    I = info[f]
    print('%08x n=%-4d callers=%-2d %s%s%s' % (f, I['n'], len(calls.get(f, [])),
          ('G[' + ','.join(sorted(I['g'])) + '] ') if I['g'] else '',
          ('S' + ' '.join(I['s'])[:150] + ' ') if I['s'] else '',
          ('F[' + ','.join(I['fl'][:12]) + ']') if I['fl'] else ''))
