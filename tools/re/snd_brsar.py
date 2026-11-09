#!/usr/bin/env python3
"""Dump Tanks BRSAR sound id -> name table (snd_ area helper)."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'audio'))
from nw4r import RSAR
p = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '../../build/rom/ext/files/Common/RPTnkScene/rp_Tnk_sound.brsar')
r = RSAR(open(p, 'rb').read())
for s in r.sounds:
    extra = s.get('seq') or s.get('strm') or s.get('wave') or {}
    print(f"{s['id']:4d} 0x{s['id']:03x} {s['type']:4} vol={s['volume']:3d} pl={s['player_id']} {s['name']} {extra}")
for pl in r.players: print('player', pl)
