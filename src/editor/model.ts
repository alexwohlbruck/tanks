// Editing operations on a LevelDef: painting with spawn bookkeeping, shapes, flood fill,
// symmetry, clipboard and per-level undo history.

import { LEVEL_H, LEVEL_W, MAX_ENEMY_SLOTS, type EnemySlot, type LevelDef } from '../levels/format'
import { blockCode, isEnemy, isPlayer, isSpawn, type Material } from './catalog'

export type Paint =
  | { kind: 'block'; material: Material; height: number }
  | { kind: 'hole' }
  | { kind: 'erase' }
  | { kind: 'tile'; code: number }
  | { kind: 'player'; index: number }
  | { kind: 'enemy'; type: EnemySlot }

export type Pt = { x: number; y: number }

export const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < LEVEL_W && y < LEVEL_H

/** paints that cover areas (spawns are placed one at a time) */
export const isAreaPaint = (p: Paint) => p.kind !== 'player' && p.kind !== 'enemy'

export function areaCode(p: Paint): number {
  switch (p.kind) {
    case 'block':
      return blockCode(p.material, p.height)
    case 'hole':
      return 200
    case 'tile':
      return p.code
    default:
      return 0
  }
}

export function cloneLevel(l: LevelDef): LevelDef {
  return JSON.parse(JSON.stringify(l))
}

/** write a cell; overwriting an enemy spawn frees its slot */
export function setCell(l: LevelDef, x: number, y: number, code: number) {
  if (!inside(x, y)) return
  const old = l.cells[y][x]
  if (old === code) return
  if (isEnemy(old)) l.enemies[old - 400] = 0
  l.cells[y][x] = code
}

export function trimEnemies(l: LevelDef) {
  while (l.enemies.length && !l.enemies[l.enemies.length - 1]) l.enemies.pop()
}

export function findCode(l: LevelDef, code: number): Pt | null {
  for (let y = 0; y < LEVEL_H; y++) for (let x = 0; x < LEVEL_W; x++) if (l.cells[y][x] === code) return { x, y }
  return null
}

export function freeSlot(l: LevelDef): number {
  const used = new Set(l.cells.flat().filter(isEnemy))
  for (let i = 0; i < MAX_ENEMY_SLOTS; i++) if (!used.has(400 + i)) return i
  return -1
}

/** enemy spawn with a new slot; -1 when all 12 are used */
export function placeEnemy(l: LevelDef, x: number, y: number, type: EnemySlot): number {
  const old = l.cells[y][x]
  if (isEnemy(old)) {
    l.enemies[old - 400] = type
    return old - 400
  }
  const i = freeSlot(l)
  if (i < 0) return -1
  setCell(l, x, y, 400 + i)
  while (l.enemies.length <= i) l.enemies.push(0)
  l.enemies[i] = type
  return i
}

/** players are unique: the spawn moves */
export function placePlayer(l: LevelDef, x: number, y: number, p: number) {
  const old = findCode(l, 300 + p)
  if (old) l.cells[old.y][old.x] = 0
  setCell(l, x, y, 300 + p)
}

export function mirrorPoints(p: Pt, mx: boolean, my: boolean): Pt[] {
  const out = [p]
  if (mx) out.push({ x: LEVEL_W - 1 - p.x, y: p.y })
  if (my) out.push({ x: p.x, y: LEVEL_H - 1 - p.y })
  if (mx && my) out.push({ x: LEVEL_W - 1 - p.x, y: LEVEL_H - 1 - p.y })
  return out.filter((q, i) => out.findIndex((r) => r.x === q.x && r.y === q.y) === i)
}

/** apply a paint at one point (with symmetry); returns false when nothing could be placed */
export function paintAt(l: LevelDef, p: Pt, paint: Paint, mx: boolean, my: boolean): boolean {
  if (!inside(p.x, p.y)) return false
  if (paint.kind === 'player') {
    placePlayer(l, p.x, p.y, paint.index)
    return true
  }
  let ok = true
  for (const q of mirrorPoints(p, mx, my)) {
    if (paint.kind === 'enemy') {
      if (isPlayer(l.cells[q.y][q.x])) continue
      ok = placeEnemy(l, q.x, q.y, paint.type) >= 0 && ok
    } else {
      // spawns are only removed by erasing, not painted over by blocks / holes / tiles
      if (paint.kind !== 'erase' && isSpawn(l.cells[q.y][q.x])) continue
      setCell(l, q.x, q.y, areaCode(paint))
    }
  }
  return ok
}

export function linePoints(a: Pt, b: Pt): Pt[] {
  const out: Pt[] = []
  let x = a.x
  let y = a.y
  const dx = Math.abs(b.x - a.x)
  const dy = -Math.abs(b.y - a.y)
  const sx = a.x < b.x ? 1 : -1
  const sy = a.y < b.y ? 1 : -1
  let err = dx + dy
  for (;;) {
    out.push({ x, y })
    if (x === b.x && y === b.y) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
  return out
}

export type Rect = { x0: number; y0: number; x1: number; y1: number }
export const normRect = (a: Pt, b: Pt): Rect => ({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) })

export function rectPoints(a: Pt, b: Pt, outline: boolean): Pt[] {
  const r = normRect(a, b)
  const out: Pt[] = []
  for (let y = r.y0; y <= r.y1; y++)
    for (let x = r.x0; x <= r.x1; x++) if (!outline || x === r.x0 || x === r.x1 || y === r.y0 || y === r.y1) out.push({ x, y })
  return out
}

export function floodPoints(l: LevelDef, s: Pt): Pt[] {
  if (!inside(s.x, s.y)) return []
  const target = l.cells[s.y][s.x]
  const seen = new Set<number>()
  const out: Pt[] = []
  const stack = [s]
  while (stack.length) {
    const p = stack.pop()!
    const k = p.y * LEVEL_W + p.x
    if (!inside(p.x, p.y) || seen.has(k) || l.cells[p.y][p.x] !== target) continue
    seen.add(k)
    out.push(p)
    stack.push({ x: p.x + 1, y: p.y }, { x: p.x - 1, y: p.y }, { x: p.x, y: p.y + 1 }, { x: p.x, y: p.y - 1 })
  }
  return out
}

/** an area paint over many points (with symmetry) */
export function paintPoints(l: LevelDef, pts: Pt[], paint: Paint, mx: boolean, my: boolean) {
  for (const p of pts) paintAt(l, p, paint, mx, my)
}

// ---- clipboard -------------------------------------------------------------------------

export type Clip = { w: number; h: number; cells: number[][]; types: EnemySlot[][] }

export function copyRect(l: LevelDef, r: Rect): Clip {
  const cells: number[][] = []
  const types: EnemySlot[][] = []
  for (let y = r.y0; y <= r.y1; y++) {
    cells.push(l.cells[y].slice(r.x0, r.x1 + 1))
    types.push(l.cells[y].slice(r.x0, r.x1 + 1).map((c) => (isEnemy(c) ? l.enemies[c - 400] || 0 : 0)))
  }
  return { w: r.x1 - r.x0 + 1, h: r.y1 - r.y0 + 1, cells, types }
}

export function clearRect(l: LevelDef, r: Rect) {
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) setCell(l, x, y, 0)
}

/** stamp the clipboard with its top-left at `at`; enemy spawns get new slots, players are skipped */
export function pasteClip(l: LevelDef, c: Clip, at: Pt): number {
  let dropped = 0
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++) {
      const px = at.x + x
      const py = at.y + y
      if (!inside(px, py)) continue
      const code = c.cells[y][x]
      if (isPlayer(code)) continue
      if (isPlayer(l.cells[py][px])) continue
      if (isEnemy(code)) {
        setCell(l, px, py, 0)
        if (placeEnemy(l, px, py, c.types[y][x] || 1) < 0) dropped++
      } else setCell(l, px, py, code)
    }
  return dropped
}

export function flipClip(c: Clip, horizontal: boolean): Clip {
  const flip = <T,>(rows: T[][]) => (horizontal ? rows.map((r) => [...r].reverse()) : [...rows].reverse())
  return { ...c, cells: flip(c.cells), types: flip(c.types) }
}

// ---- undo history (per level object) ---------------------------------------------------

type History = { undo: string[]; redo: string[] }
const histories = new WeakMap<LevelDef, History>()
const LIMIT = 200

function hist(l: LevelDef) {
  let h = histories.get(l)
  if (!h) histories.set(l, (h = { undo: [], redo: [] }))
  return h
}

/** record `before` (a JSON snapshot taken before the change) if the level changed */
export function commit(l: LevelDef, before: string) {
  if (JSON.stringify(l) === before) return false
  const h = hist(l)
  h.undo.push(before)
  if (h.undo.length > LIMIT) h.undo.shift()
  h.redo = []
  return true
}

function restore(l: LevelDef, json: string) {
  const v = JSON.parse(json) as LevelDef
  for (const k of Object.keys(l)) delete (l as Record<string, unknown>)[k]
  Object.assign(l, v)
}

export function undo(l: LevelDef) {
  const h = hist(l)
  const s = h.undo.pop()
  if (!s) return false
  h.redo.push(JSON.stringify(l))
  restore(l, s)
  return true
}

export function redo(l: LevelDef) {
  const h = hist(l)
  const s = h.redo.pop()
  if (!s) return false
  h.undo.push(JSON.stringify(l))
  restore(l, s)
  return true
}

export const canUndo = (l: LevelDef) => !!histories.get(l)?.undo.length
export const canRedo = (l: LevelDef) => !!histories.get(l)?.redo.length
