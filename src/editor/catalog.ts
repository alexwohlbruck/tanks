// What the editor can place: tank types (the original 9 plus any registered added types) and
// special tiles (codes 500-599). Added types and tiles live in src/sim modules other features
// may add; they are discovered with an eager glob so this builds whether or not they exist.

import { LEVEL_H, LEVEL_W } from '../levels/format'

export type TankType = { id: number; name: string; color: string; extra?: boolean }
export type TileType = { code: number; name: string; color: string; description?: string }

/** body colours of the tank models (render/effects.ts TANK_PIECE_COLORS) */
export const PLAYER_COLORS = ['#5d98e0', '#de5b44', '#4fb067', '#e8a33a']
export const PLAYER_NAMES = ['P1', 'P2', 'P3', 'P4']

const ORIGINAL: TankType[] = [
  { id: 1, name: 'Brown', color: '#bd9341' },
  { id: 2, name: 'Ash', color: '#9e9687' },
  { id: 3, name: 'Marine', color: '#5ea6ad' },
  { id: 4, name: 'Pink', color: '#db648d' },
  { id: 5, name: 'Yellow', color: '#ede223' },
  { id: 6, name: 'Violet', color: '#b56ac4' },
  { id: 7, name: 'Green', color: '#6bc471' },
  { id: 8, name: 'White', color: '#ffffe8' },
  { id: 9, name: 'Black', color: '#636363' },
]

// modules that may export registries (missing files are simply absent from the glob)
const mods = import.meta.glob(['../sim/stats.ts', '../sim/tanks.ts', '../sim/types.ts', '../sim/tanktypes.ts', '../sim/tiles.ts'], { eager: true }) as Record<
  string,
  Record<string, unknown>
>

function collect(names: string[]): unknown[] {
  const out: unknown[] = []
  for (const m of Object.values(mods))
    for (const n of names) {
      let v = m[n]
      if (typeof v === 'function') {
        try {
          v = (v as () => unknown)()
        } catch {
          continue
        }
      }
      if (v instanceof Map) v = [...v.values()]
      else if (v && typeof v === 'object' && !Array.isArray(v)) v = Object.values(v)
      if (Array.isArray(v)) out.push(...v)
    }
  return out
}

const hashColor = (n: number) => `hsl(${(n * 137) % 360} 55% 55%)`

function asColor(c: unknown, fallback: string) {
  if (typeof c === 'string') return c
  if (typeof c === 'number') return '#' + (c & 0xffffff).toString(16).padStart(6, '0')
  if (Array.isArray(c) && c.length >= 3) return `rgb(${c.slice(0, 3).map((v) => (v <= 1 ? Math.round(v * 255) : v)).join(',')})`
  return fallback
}

let tankCache: TankType[] | null = null
export function tankTypes(): TankType[] {
  if (tankCache) return tankCache
  const list = [...ORIGINAL]
  for (const e of collect(['tankTypes', 'TANK_TYPES', 'tankTypeList', 'EXTRA_TANKS', 'extraTankTypes'])) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    const id = Number(o.id ?? o.type)
    if (!Number.isInteger(id) || id < 1 || id > 99 || list.some((t) => t.id === id)) continue
    list.push({ id, name: String(o.name ?? `Type ${id}`), color: asColor(o.color ?? o.colour, hashColor(id)), extra: true })
  }
  return (tankCache = list.sort((a, b) => a.id - b.id))
}

export function tankType(id: number): TankType {
  return tankTypes().find((t) => t.id === id) ?? { id, name: `Type ${id}`, color: hashColor(id), extra: true }
}

let tileCache: TileType[] | null = null
export function tileTypes(): TileType[] {
  if (tileCache) return tileCache
  const list: TileType[] = []
  for (const e of collect(['tiles', 'TILES', 'tileTypes', 'TILE_TYPES', 'tileList', 'TILE_REGISTRY'])) {
    if (!e || typeof e !== 'object') continue
    const o = e as Record<string, unknown>
    let code = Number(o.code ?? o.id)
    if (Number.isInteger(code) && code >= 0 && code < 100) code += 500
    if (!Number.isInteger(code) || code < 500 || code > 599 || list.some((t) => t.code === code)) continue
    list.push({
      code,
      name: String(o.name ?? o.label ?? `Tile ${code}`),
      color: asColor(o.color ?? o.colour, hashColor(code)),
      description: typeof o.description === 'string' ? o.description : undefined,
    })
  }
  return (tileCache = list.sort((a, b) => a.code - b.code))
}

export function tileType(code: number): TileType {
  return tileTypes().find((t) => t.code === code) ?? { code, name: `Tile ${code}`, color: hashColor(code) }
}

// ---- cell codes ------------------------------------------------------------------------

export type Material = 'wood' | 'cork'
export const blockCode = (m: Material, height: number) => (m === 'wood' ? 200 : 100) + Math.max(1, Math.min(7, height - 1))
export const isWood = (c: number) => c >= 201 && c <= 207
export const isCork = (c: number) => c >= 100 && c <= 107
export const isBlock = (c: number) => isWood(c) || isCork(c)
export const blockHeight = (c: number) => (c % 100) + 1
export const isHole = (c: number) => c === 200
export const isPlayer = (c: number) => c >= 300 && c <= 303
export const isEnemy = (c: number) => c >= 400 && c <= 411
export const isTile = (c: number) => c >= 500 && c <= 599
export const isSpawn = (c: number) => isPlayer(c) || isEnemy(c)

export function describeCell(c: number): string {
  if (c === 0) return 'Empty'
  if (isWood(c)) return `Wood block, height ${blockHeight(c)}`
  if (isCork(c)) return `Cork block, height ${blockHeight(c)}`
  if (isHole(c)) return 'Hole'
  if (isPlayer(c)) return `Player ${c - 299} spawn`
  if (isEnemy(c)) return `Enemy ${c - 399} spawn`
  if (isTile(c)) return tileType(c).name
  return `Code ${c}`
}

export const GRID = { w: LEVEL_W, h: LEVEL_H }
