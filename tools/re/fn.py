"""Print the annotated function containing ADDR:  python3 fn.py ADDR [OUTDIR]"""
import sys, bisect, os
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/tanks_re'
a = int(sys.argv[1], 16)
funcs = [int(l, 16) for l in open(os.path.join(out, 'funcs.txt'))]
i = bisect.bisect_right(funcs, a) - 1
start, end = funcs[i], funcs[i + 1] if i + 1 < len(funcs) else a + 0x1000
import pickle
calls = pickle.load(open(os.path.join(out, 'xrefs.pkl'), 'rb'))['calls']
print('# func %08x-%08x  callers: %s' % (start, end, ' '.join('%08x' % c for c in calls.get(start, [])[:12])))
with open(os.path.join(out, 'annot.txt')) as f:
    for ln in f:
        x = int(ln[:8], 16)
        if start <= x < end: sys.stdout.write(ln)
        elif x >= end: break
