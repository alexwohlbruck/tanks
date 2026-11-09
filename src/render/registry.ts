/**
 * Render extension points for content the disc does not have.
 *
 * ## New tank types (enemy type ids >= 10)
 *
 * ```ts
 * import { registerTankVisual } from './render/registry'
 * registerTankVisual(10, {
 *   baseModel: 'e_3',          // 'e_1'..'e_9' (wooden enemy shapes) or '1p' / '2p' (rounded player shape)
 *   livery: 0xff8800,          // hex colour: recolours the base livery (enemy: the coloured band,
 *                              //   player shape: the whole body) keeping its shading and grain
 *                              // or a texture URL (same UV layout as the base model's livery)
 *   accent: 0x333333,          // optional: recolours the rest (enemy: the wood trim; 1p/2p: unused)
 *   scale: 1.2,                // optional: model scale on top of the game's 1.6 (visual only)
 *   emissive: 0xff2200,        // optional: glow added to the lit colour (emissiveIntensity, default 0.35)
 *   tread: 'e_8',              // optional: tread mark ('1p', '2p', 'p3', 'p4', 'e_1'..'e_9'), default base model's
 *   pieceColor: 0xff8800,      // optional: Tnk_bomb01_piece debris tint, default the livery colour
 * })
 * ```
 * Types that are never registered still render: the e_1 model with a livery hue picked from
 * the type id. Registration may happen at any time; tanks pick it up when (re)spawned.
 *
 * ## Special floor tiles (map cell codes 500-599)
 *
 * ```ts
 * import { registerTileRenderer } from './render/registry'
 * registerTileRenderer([500, 509], (ctx) => {
 *   const m = new THREE.Mesh(new THREE.PlaneGeometry(35, 35).rotateX(-Math.PI / 2), mat)
 *   m.position.y = 0.3                     // just above the floor (decals use 0.05-0.25)
 *   return { object: m, update: (frame) => { m.rotation.y = frame / 60 } }
 * })
 * ```
 * The factory runs whenever the stage's static geometry is (re)built; `ctx.x/z` is where the
 * returned object is placed (the cell centre, on the floor), so build it around the origin.
 * Return an Object3D, `{ object, update?, dispose? }`, or null to draw nothing. `update` is
 * called once per rendered frame with the world frame counter. Later registrations win
 * over earlier ones for overlapping codes. Cell size is 35 x 35 world units, +y up.
 */

import type * as THREE from 'three/webgpu'
import type { Quality } from './quality'

export type BaseModel = '1p' | '2p' | 'e_1' | 'e_2' | 'e_3' | 'e_4' | 'e_5' | 'e_6' | 'e_7' | 'e_8' | 'e_9'
export type TreadMark = BaseModel | 'p3' | 'p4'

export interface TankVisual {
  baseModel: BaseModel
  /** hex colour (0xRRGGBB or '#rrggbb') or texture URL */
  livery: number | string
  accent?: number | string
  scale?: number
  emissive?: number | string
  emissiveIntensity?: number
  tread?: TreadMark
  pieceColor?: number | string
}

export interface TileContext {
  code: number
  col: number
  row: number
  /** cell centre in world units */
  x: number
  z: number
  quality: Quality
  /** the stage's grid (read-only) */
  grid: readonly (readonly { code: number }[])[]
}

export type TileResult = THREE.Object3D | { object: THREE.Object3D; update?: (frame: number) => void; dispose?: () => void } | null

export type TileFactory = (ctx: TileContext) => TileResult

const tanks = new Map<number, TankVisual>()
const tiles: { lo: number; hi: number; factory: TileFactory }[] = []
let version = 0

export function registerTankVisual(type: number, visual: TankVisual) {
  tanks.set(type, { ...visual })
  version++
}

/** `codes`: a single code or an inclusive [lo, hi] range (500-599) */
export function registerTileRenderer(codes: number | [number, number], factory: TileFactory) {
  const [lo, hi] = typeof codes === 'number' ? [codes, codes] : codes
  tiles.push({ lo, hi, factory })
  version++
}

export function tankVisual(type: number): TankVisual | undefined {
  return tanks.get(type)
}

export function tileFactory(code: number): TileFactory | undefined {
  for (let i = tiles.length - 1; i >= 0; i--) if (code >= tiles[i].lo && code <= tiles[i].hi) return tiles[i].factory
  return undefined
}

/** bumps on every registration (scene caches key on it) */
export function registryVersion() {
  return version
}

/** fallback for unregistered types >= 10: e_1 with a hue from the golden angle */
export function defaultTankVisual(type: number): TankVisual {
  const h = ((type * 137.508) % 360) / 360
  return { baseModel: 'e_1', livery: hslHex(h, 0.55, 0.5) }
}

function hslHex(h: number, s: number, l: number) {
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return (f(0) << 16) | (f(8) << 8) | f(4)
}
