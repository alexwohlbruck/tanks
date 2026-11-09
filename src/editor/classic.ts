// Original disc maps (public/assets/data/maps.json, P1_00..P1_29 in 16:9) and the 1P mission
// table (params.json) as editor starting points.

import type { GameData } from '../data'
import { LEVEL_H, LEVEL_W, type EnemySlot, type LevelDef } from '../levels/format'

export type DiscMap = { variant: number; key: string; missions: number[] }

/** a disc mission slot: 1-9 a type, two digits `ab` a random type in a..b */
export const discSlot = (v: number): EnemySlot => (v < 10 ? v : [Math.trunc(v / 10), v % 10])

export function discMaps(data: GameData): DiscMap[] {
  const out: DiscMap[] = []
  for (let v = 0; v < 30; v++) {
    const key = `P1_${String(v).padStart(2, '0')}_16_9`
    const m = data.maps[key]
    if (!m || m.width !== LEVEL_W || m.height !== LEVEL_H) continue
    const missions: number[] = []
    data.params.missions.forEach((mi, i) => {
      if (v >= mi.map1P[0] && v <= mi.map1P[1]) missions.push(i + 1)
    })
    out.push({ variant: v, key, missions })
  }
  return out
}

/** map `variant` with the enemies of `mission` (1-based; 0 = keep every spawn as Brown) */
export function discLevel(data: GameData, variant: number, mission: number): LevelDef {
  const m = data.maps[`P1_${String(variant).padStart(2, '0')}_16_9`]
  const mi = mission ? data.params.missions[mission - 1] : null
  const enemies: EnemySlot[] = mi ? mi.slots1P.map(discSlot) : Array.from({ length: 8 }, () => 1)
  const cells = m.cells.map((r) => r.map((c) => (c >= 400 && c < 412 && !enemies[c - 400] ? 0 : c)))
  const level: LevelDef = {
    v: 1,
    name: mi ? `Mission ${mission}` : `Disc map ${variant + 1}`,
    cells,
    enemies,
    facing: [m.facing[0], m.facing[1]],
  }
  if (mi && mi.bonus > 0) level.bonus = true
  while (level.enemies.length && !level.enemies[level.enemies.length - 1]) level.enemies.pop()
  return level
}
