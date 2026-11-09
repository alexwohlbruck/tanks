// ASCII-art level authoring: 17 rows of 22 characters -> LevelDef (src/levels/format.ts).
// Spaces inside a row are ignored, so rows may be written spaced out for readability.
//
// Default legend (override or extend per level with `legend`):
//   .  empty             #  wood block (202, 1.5 cells tall)   =  low wood block (201)
//   H  tall wood (204)   x  cork block (102)                   -  low cork block (101)
//   o  hole (200)        1-4  player 1-4 spawn                 a-l  enemy spawn slot 0-11
//   special tiles (src/sim/tiles.ts): their `icon`, e.g.
//   T U V W teleporters A-D   ^ > v < conveyors      * ice   % mud   ~ water
//   B bumper   G glass   C crate   S switch   D gate (closed)   O gate (open)   @ gravity well
//   N L Z J laser emitters firing north/east/south/west; 5 6 7 8 the alternate-phase ones
//   R K Q F M X power-up pads: rapid / ricochet / shield / speed / mines / rockets

import { tileTypes } from '../sim/tiles'
import { LEVEL_H, LEVEL_W, type EnemySlot, type LevelDef } from './format'

export const LEGEND: Record<string, number> = {
  '.': 0,
  '#': 202,
  '=': 201,
  H: 204,
  x: 102,
  '-': 101,
  o: 200,
  ...Object.fromEntries([1, 2, 3, 4].map((n) => [String(n), 299 + n])),
  ...Object.fromEntries('abcdefghijkl'.split('').map((ch, i) => [ch, 400 + i])),
  ...Object.fromEntries(tileTypes().map((t) => [t.icon, t.code])),
}

export type AsciiLevel = {
  name: string
  description?: string
  author?: string
  /** 17 lines of 22 cells (a template string or an array of rows) */
  map: string | string[]
  /** tank type per enemy slot a, b, c, ... (0 = unused) */
  enemies: EnemySlot[]
  legend?: Record<string, number>
  rules?: Record<string, unknown>
  bonus?: boolean
  facing?: [number, number]
}

/** parses the map; throws with the row / column of the first problem */
export function asciiLevel(a: AsciiLevel): LevelDef {
  const legend = { ...LEGEND, ...(a.legend ?? {}) }
  const lines = (Array.isArray(a.map) ? a.map : a.map.split('\n')).map((l) => l.replace(/\s+/g, '')).filter((l) => l.length)
  if (lines.length !== LEVEL_H) throw new Error(`${a.name}: ${lines.length} rows, need ${LEVEL_H}`)
  const cells = lines.map((line, r) => {
    if (line.length !== LEVEL_W) throw new Error(`${a.name}: row ${r} has ${line.length} cells, need ${LEVEL_W}: ${line}`)
    return [...line].map((ch, c) => {
      const code = legend[ch]
      if (code === undefined) throw new Error(`${a.name}: unknown cell '${ch}' at row ${r}, column ${c}`)
      return code
    })
  })
  const level: LevelDef = { v: 1, name: a.name, cells, enemies: a.enemies }
  if (a.description) level.description = a.description
  if (a.author) level.author = a.author
  if (a.rules) level.rules = a.rules
  if (a.bonus) level.bonus = true
  if (a.facing) level.facing = a.facing
  return level
}

/** LevelDef -> ASCII rows (debugging, round trips); unknown codes print as '?' */
export function levelToAscii(l: LevelDef, legend = LEGEND): string[] {
  const back = new Map<number, string>()
  for (const [ch, code] of Object.entries(legend)) if (!back.has(code)) back.set(code, ch)
  return l.cells.map((row) => row.map((c) => back.get(c) ?? '?').join(''))
}
