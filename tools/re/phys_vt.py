"""Dump vtables in data 8032d000-8032f000 referencing Tanks code. python3 phys_vt.py"""
import sys; sys.path.insert(0, __import__('os').path.dirname(__file__))
from dol import Dol
d = Dol()
lo, hi = int(sys.argv[1],16) if len(sys.argv)>1 else 0x8032d000, int(sys.argv[2],16) if len(sys.argv)>2 else 0x8032f000
a = lo
while a < hi:
    v = d.u32(a)
    tag = ''
    if v and 0x80004000 <= v < 0x802d0000: tag = 'FN'
    elif v and 0x802d0000 <= v < 0x80480000:
        s = d.cstr(v); tag = repr(s) if s else ''
    print('%08x +%3d: %08x %s' % (a, (a-lo), v or 0, tag))
    a += 4
