#!/usr/bin/env python3
"""snd_ helper: per-track summary (first prg / volume / pan / note range) of a BGM sequence."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'audio'))
from nw4r import RSAR, RSEQ
import mml
name = sys.argv[1] if len(sys.argv) > 1 else 'RP_TNK_BGM_LOOP2'
r = RSAR(open(os.path.join(os.path.dirname(__file__), '../../build/rom/ext/files/Common/RPTnkScene/rp_Tnk_sound.brsar'), 'rb').read())
s = r.by_name[name]
main, _ = r.file_data(s['file_id'])
q = RSEQ(main)
start = s['seq']['data_offset']
ins0 = mml.disassemble(q.code, [start])
tracks = {0: start}
for i in ins0:
    if i['name'] == 'opentrack': tracks[i['args'][0]] = i['args'][1]
print(name, 'labels', q.labels)
for t, off in sorted(tracks.items()):
    inss = mml.disassemble(q.code, [off])
    summ = {}; notes = []
    for i in inss:
        n = i['name']
        if n in ('prg', 'volume', 'pan', 'main_volume', 'transpose', 'mute') and n not in summ: summ[n] = i['args']
        if n.startswith('note') or (isinstance(n, str) and n[:1] in 'CDEFGAB' and n[1:2] in '#-0123456789'):
            notes.append(n)
    print(t, hex(off), summ, len(inss), 'ins', (notes[:3] if notes else ''))
