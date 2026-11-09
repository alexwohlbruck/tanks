#!/bin/sh
# Disassemble main.dol text sections and build annotated listing into $1 (default /tmp/tanks_re)
set -e
OUT=${1:-/tmp/tanks_re}; HERE=$(dirname "$0"); mkdir -p $OUT
python3 - "$OUT" <<PY
import sys; sys.path.insert(0,'$HERE')
from dol import Dol
d=Dol()
for s in d.sections:
    if s[0].startswith('T'):
        open('%s/%s.bin'%(sys.argv[1],s[0]),'wb').write(d.data[s[3]:s[3]+s[2]])
        open('%s/%s.addr'%(sys.argv[1],s[0]),'w').write(hex(s[1]))
PY
for f in $OUT/T*.bin; do t=${f%.bin}; "$HERE/objdump.sh" -D -z -b binary -m powerpc:750 -M broadway -EB --adjust-vma=$(cat $t.addr) $f > $t.raw.txt; done
python3 "$HERE/annotate.py" $OUT
