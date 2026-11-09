// Custom level format (level editor, community store, Tanks+ campaign).
//
// A level is one arena on the original 22 x 17 grid (16:9), using the same cell codes as the
// disc's map files plus new ones:
//   0          empty
//   101-107    cork block (destroyed by mines), stack height = low digit + 1 half-cells
//   200        hole (tanks stop, shells fly over); 201-207 wood block stacks
//   300-303    player 1-4 spawn
//   400-411    enemy spawn slot 0-11; the tank type comes from `enemies[slot]`
//   500-599    special tiles (src/sim/tiles.ts registry; ignored by builds that lack them)
// `enemies[i]` is a tank type id (1-9 original, 10+ added types) or a [lo, hi] random range.

export const LEVEL_W = 22
export const LEVEL_H = 17
export const MAX_ENEMY_SLOTS = 12

export type EnemySlot = number | [number, number]

export type LevelDef = {
  v: 1
  /** store id (absent until published) */
  id?: string
  name: string
  author?: string
  description?: string
  /** LEVEL_H rows of LEVEL_W cell codes */
  cells: number[][]
  /** tank type per enemy spawn slot (cell 400 + i); 0 / missing = none */
  enemies: EnemySlot[]
  /** P1/P2 start balloon facing (0/1/2/3 = 0/180/90/270 degrees), like the disc maps */
  facing?: [number, number]
  /** clearing this level awards an extra life (the original: every 5th mission) */
  bonus?: boolean
  /** extra rules for added mechanics (src/sim registry); unknown keys are ignored */
  rules?: Record<string, unknown>
}

/** a sequence of levels played like the original campaign */
export type LevelPack = {
  v: 1
  id?: string
  name: string
  author?: string
  description?: string
  levels: LevelDef[]
  /** starting lives (default: the original's 3) */
  lives?: number
}

export function emptyLevel(name = 'Untitled'): LevelDef {
  const cells = Array.from({ length: LEVEL_H }, () => new Array(LEVEL_W).fill(0))
  cells[8][2] = 300
  cells[8][19] = 400
  return { v: 1, name, cells, enemies: [1] }
}

/** basic structural validation; returns a list of problems (empty = ok) */
export function validateLevel(l: LevelDef): string[] {
  const errs: string[] = []
  if (l.v !== 1) errs.push('unsupported version')
  if (!l.name || typeof l.name !== 'string') errs.push('missing name')
  if (!Array.isArray(l.cells) || l.cells.length !== LEVEL_H || l.cells.some((r) => !Array.isArray(r) || r.length !== LEVEL_W))
    errs.push(`cells must be ${LEVEL_H} rows of ${LEVEL_W}`)
  else {
    const flat = l.cells.flat()
    if (!flat.includes(300)) errs.push('needs a player 1 spawn (300)')
    const slots = flat.filter((c) => c >= 400 && c < 400 + MAX_ENEMY_SLOTS)
    if (!slots.length) errs.push('needs at least one enemy spawn')
    for (const c of slots) if (!l.enemies?.[c - 400]) errs.push(`enemy spawn ${c - 400} has no tank type`)
  }
  return errs
}
