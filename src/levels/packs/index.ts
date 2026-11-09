// Built-in level packs for the menu. The Tanks+ campaign is authored as ASCII maps per world
// (./tanksplus/world*.ts, src/levels/ascii.ts); tools/levels/export.ts writes the same pack as
// LevelPack JSON (./tanksplus.json) for the editor / store.

import type { LevelPack } from '../format'
import { world1 } from './tanksplus/world1'
import { world2 } from './tanksplus/world2'
import { world3 } from './tanksplus/world3'
import { world4 } from './tanksplus/world4'

export const tanksPlus: LevelPack = {
  v: 1,
  id: 'tanksplus',
  name: 'Tanks+',
  author: 'Tanks! web port',
  description: 'A new campaign: new enemy tanks, special tiles, power-ups and a boss every ten levels. 1-4 players.',
  lives: 3,
  levels: [...world1, ...world2, ...world3, ...world4],
}

/** worlds of the Tanks+ campaign (level indices are 0-based) */
export const TANKS_PLUS_WORLDS = [
  { name: 'Workshop', first: 0, count: world1.length },
  { name: 'Frozen Works', first: 10, count: world2.length },
  { name: 'Night Ops', first: 20, count: world3.length },
  { name: 'Overdrive', first: 30, count: world4.length },
]
