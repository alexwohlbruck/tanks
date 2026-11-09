"""For a function that copies a 42-word tank record to the stack (bdnz loop) and
then stores fields into an object, print k-index -> destination offset."""
import sys, re, subprocess, os
fn = sys.argv[1]; kbase = int(sys.argv[2])  # stack offset of k0
lines = subprocess.run(['python3', os.path.join(os.path.dirname(__file__), 'fn.py'), fn], capture_output=True, text=True).stdout.splitlines()
reg = {}
for ln in lines[1:]:
    p = ln.split()
    if len(p) < 4: continue
    mn, ops = p[2], p[3].split(',')
    if len(ops) < 2: continue
    mo = re.match(r'^(-?\d+)\((r\d+)\)$', ops[1])
    if not mo: 
        continue
    off, base = int(mo.group(1)), mo.group(2)
    if mn in ('lwz', 'lfs') and base == 'r1' and kbase <= off < kbase + 168:
        reg[ops[0]] = (off - kbase) // 4
    elif mn in ('stw', 'stfs', 'stb', 'sth') and base != 'r1' and ops[0] in reg:
        print('k%-2d -> %s+%d (0x%x)   [%s %s]' % (reg[ops[0]], base, off, off, p[0], mn))
