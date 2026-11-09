// Strict level / pack checks shared by the level editor (src/editor) and the store server
// (server/modules/levels.ts). Additive to format.ts: validateLevel covers the structure, this
// adds value ranges, size limits and a normaliser that drops unknown fields.
// (owned by the level editor / store; see docs/levels.md)

import { LEVEL_H, LEVEL_W, MAX_ENEMY_SLOTS, validateLevel, type EnemySlot, type LevelDef, type LevelPack } from './format'

export const LIMITS = {
  name: 48,
  author: 32,
  description: 400,
  levels: 100,
  /** tank type ids accepted (1-9 original, 10+ added types) */
  maxTankType: 99,
  lives: [1, 99] as [number, number],
  /** serialized pack JSON */
  bytes: 512 * 1024,
}

/** cell codes a level may contain */
export function validCell(c: number): boolean {
  return (
    c === 0 ||
    (c >= 100 && c <= 107) ||
    (c >= 200 && c <= 207) ||
    (c >= 300 && c <= 303) ||
    (c >= 400 && c < 400 + MAX_ENEMY_SLOTS) ||
    (c >= 500 && c <= 599)
  )
}

const validType = (t: unknown) => Number.isInteger(t) && (t as number) >= 1 && (t as number) <= LIMITS.maxTankType

export type Check = { errors: string[]; warnings: string[] }

/** everything validateLevel checks, plus ranges; `where` prefixes the messages ("Level 2: ") */
export function checkLevel(l: LevelDef, where = ''): Check {
  const errors: string[] = []
  const warnings: string[] = []
  if (!l || typeof l !== 'object') return { errors: [`${where}not a level`], warnings }
  for (const e of validateLevel(l)) errors.push(where + e)
  if (typeof l.name === 'string' && l.name.length > LIMITS.name) errors.push(`${where}name is longer than ${LIMITS.name} characters`)
  if (l.description != null && (typeof l.description !== 'string' || l.description.length > LIMITS.description))
    errors.push(`${where}description is longer than ${LIMITS.description} characters`)
  if (!Array.isArray(l.enemies) || l.enemies.length > MAX_ENEMY_SLOTS) errors.push(`${where}enemies must be a list of at most ${MAX_ENEMY_SLOTS} slots`)
  else
    l.enemies.forEach((e, i) => {
      if (e === 0 || e == null) return
      if (Array.isArray(e)) {
        if (e.length !== 2 || !validType(e[0]) || !validType(e[1]) || e[0] > e[1]) errors.push(`${where}enemy ${i + 1}: bad random range`)
      } else if (!validType(e)) errors.push(`${where}enemy ${i + 1}: bad tank type ${e}`)
    })
  if (Array.isArray(l.cells) && l.cells.length === LEVEL_H && l.cells.every((r) => Array.isArray(r) && r.length === LEVEL_W)) {
    const flat = l.cells.flat()
    const bad = flat.filter((c) => !Number.isInteger(c) || !validCell(c))
    if (bad.length) errors.push(`${where}unknown cell codes: ${[...new Set(bad)].slice(0, 5).join(', ')}`)
    const counts = new Map<number, number>()
    for (const c of flat) counts.set(c, (counts.get(c) ?? 0) + 1)
    for (let p = 0; p < 4; p++) if ((counts.get(300 + p) ?? 0) > 1) errors.push(`${where}player ${p + 1} spawn is placed more than once`)
    for (let s = 0; s < MAX_ENEMY_SLOTS; s++) if ((counts.get(400 + s) ?? 0) > 1) errors.push(`${where}enemy spawn ${s + 1} is placed more than once`)
    for (let p = 1; p < 4; p++)
      if (!counts.get(300 + p)) {
        warnings.push(`${where}no player ${p + 1} spawn: in ${p + 1}+ player games that tank starts next to player 1`)
        break
      }
    l.enemies?.forEach((e, i) => {
      if (e && !counts.get(400 + i)) warnings.push(`${where}enemy ${i + 1} has a tank type but no spawn on the map`)
    })
  }
  if (l.facing != null && (!Array.isArray(l.facing) || l.facing.length !== 2 || l.facing.some((f) => ![0, 1, 2, 3].includes(f))))
    errors.push(`${where}facing must be two values 0-3`)
  return { errors, warnings }
}

export function checkPack(p: LevelPack): Check {
  const errors: string[] = []
  const warnings: string[] = []
  if (!p || typeof p !== 'object') return { errors: ['not a level pack'], warnings }
  if (p.v !== 1) errors.push('unsupported pack version')
  if (!p.name || typeof p.name !== 'string' || !p.name.trim()) errors.push('the pack needs a name')
  else if (p.name.length > LIMITS.name) errors.push(`pack name is longer than ${LIMITS.name} characters`)
  if (p.author != null && (typeof p.author !== 'string' || p.author.length > LIMITS.author)) errors.push(`author is longer than ${LIMITS.author} characters`)
  if (p.description != null && (typeof p.description !== 'string' || p.description.length > LIMITS.description))
    errors.push(`pack description is longer than ${LIMITS.description} characters`)
  if (p.lives != null && (!Number.isInteger(p.lives) || p.lives < LIMITS.lives[0] || p.lives > LIMITS.lives[1]))
    errors.push(`starting lives must be ${LIMITS.lives[0]}-${LIMITS.lives[1]}`)
  if (!Array.isArray(p.levels) || !p.levels.length) errors.push('the pack has no levels')
  else if (p.levels.length > LIMITS.levels) errors.push(`at most ${LIMITS.levels} levels per pack`)
  else
    p.levels.forEach((l, i) => {
      const c = checkLevel(l, `Level ${i + 1}: `)
      errors.push(...c.errors)
      warnings.push(...c.warnings)
    })
  return { errors, warnings }
}

const str = (s: unknown, max: number) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : undefined)

/** a clean copy with only the known fields (call after checkLevel passes) */
export function normalizeLevel(l: LevelDef): LevelDef {
  const out: LevelDef = {
    v: 1,
    name: str(l.name, LIMITS.name) ?? 'Untitled',
    cells: l.cells.map((r) => r.map((c) => c | 0)),
    enemies: (l.enemies ?? []).map((e): EnemySlot => (Array.isArray(e) ? [e[0] | 0, e[1] | 0] : (e as number) | 0)),
  }
  while (out.enemies.length && !out.enemies[out.enemies.length - 1]) out.enemies.pop()
  const d = str(l.description, LIMITS.description)
  if (d) out.description = d
  const a = str(l.author, LIMITS.author)
  if (a) out.author = a
  if (l.facing) out.facing = [l.facing[0] | 0, l.facing[1] | 0]
  if (l.bonus) out.bonus = true
  if (l.rules && typeof l.rules === 'object' && !Array.isArray(l.rules)) out.rules = l.rules
  return out
}

export function normalizePack(p: LevelPack): LevelPack {
  const out: LevelPack = { v: 1, name: str(p.name, LIMITS.name) ?? 'Untitled pack', levels: p.levels.map(normalizeLevel) }
  const a = str(p.author, LIMITS.author)
  if (a) out.author = a
  const d = str(p.description, LIMITS.description)
  if (d) out.description = d
  if (p.lives != null) out.lives = p.lives | 0
  return out
}
