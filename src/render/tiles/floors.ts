// Floor pieces of the Tanks+ tiles as TSL: lacquered ice panels, felt mud, the water channel,
// conveyor belts, teleporter pads and gravity wells. Floors that join their neighbours (ice,
// mud, water) read a small grid texture of the level, so a run of cells is one panel with
// frosted / cut / shore edges only where the region ends.

import * as THREE from 'three/webgpu'
import { abs, atan, cos, float, fract, length, log, max, min, mix, normalGeometry, normalize, positionGeometry, positionWorld, sin, smoothstep, step, texture, time, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { CELL, painted, rgb, type Kit, type N } from './kit'
import { PAINT, paintIce, paintMud } from './paint'

/** grid texture classes */
export const G = { none: 0, ice: 1, mud: 2, water: 3, solid: 9 } as const

/** level grid as a texture (r = class G per cell, up to 32 x 32); origin = corner of cell (0, 0) */
export class FloorGrid {
  static SIZE = 32
  tex: THREE.DataTexture
  private origin = uniform(new THREE.Vector2(0, 0))
  private data = new Uint8Array(FloorGrid.SIZE * FloorGrid.SIZE * 4)
  constructor() {
    this.tex = new THREE.DataTexture(this.data, FloorGrid.SIZE, FloorGrid.SIZE)
    this.tex.magFilter = this.tex.minFilter = THREE.NearestFilter
    this.tex.generateMipmaps = false
    this.tex.flipY = false
    this.tex.colorSpace = THREE.NoColorSpace
  }
  /** clear for a level whose cell (0, 0) has its corner at (ox, oz) */
  reset(ox: number, oz: number) {
    this.data.fill(0)
    this.origin.value.set(ox, oz)
  }
  set(c: number, r: number, k: number) {
    if (c >= 0 && r >= 0 && c < FloorGrid.SIZE && r < FloorGrid.SIZE) this.data[(r * FloorGrid.SIZE + c) * 4] = k
  }
  commit() {
    this.tex.needsUpdate = true
  }

  /** world xz in cells from the grid corner */
  cellPos(): N {
    return vec2(positionWorld.x, positionWorld.z).sub(this.origin).div(CELL)
  }

  private kindAt(cell: N): N {
    return texture(this.tex, cell.add(0.5).div(FloorGrid.SIZE)).r.mul(255)
  }

  /**
   * distance (world units) to where the region of class `k` ends, within this cell: the cell
   * sides / corners whose neighbour is another class. `north` = only the north side (-z).
   */
  edge(k: number): { d: N; north: N; south: N } {
    const p = this.cellPos()
    const cell = p.floor()
    const l = p.fract()
    const same = (dc: number, dr: number) => step(abs(this.kindAt(cell.add(vec2(dc, dr))).sub(k)), 0.5)
    const far = float(9)
    const dW = mix(l.x, far, same(-1, 0))
    const dE = mix(l.x.oneMinus(), far, same(1, 0))
    const dN = mix(l.y, far, same(0, -1))
    const dS = mix(l.y.oneMinus(), far, same(0, 1))
    const corner = (dc: number, dr: number) => mix(length(l.sub(vec2(dc > 0 ? 1 : 0, dr > 0 ? 1 : 0))), far, same(dc, dr))
    const d = min(min(min(dW, dE), min(dN, dS)), min(min(corner(-1, -1), corner(1, -1)), min(corner(-1, 1), corner(1, 1))))
    return { d: d.mul(CELL), north: dN.mul(CELL), south: dS.mul(CELL) }
  }
}

const band = (x: N, c: number, w: number) => smoothstep(w, 0, abs(x.sub(c)))

/** floor decal flags: drawn after the floor without writing depth, so shadows and marks stay on top */
function floorMat(m: THREE.Material, order = 1) {
  m.depthWrite = false
  m.userData.order = order
  return m
}

export function iceMaterial(kit: Kit, grid: FloorGrid) {
  const frostTex = kit.canvas('ice', 96, 96, paintIce)
  const p = grid.cellPos()
  const { d, north } = grid.edge(G.ice)
  const fx = texture(frostTex, p.mul(0.45))
  const cloud = fx.r
  const scratch = fx.g
  let col: N = mix(vec3(0.74, 0.88, 0.95), vec3(0.6, 0.8, 0.92), cloud.mul(0.6))
  // lacquer gloss: two still streaks and a slow glint along the diagonal
  const t = p.x.add(p.y.mul(0.7))
  const streak = band(fract(t.mul(0.3)), 0.5, 0.06).mul(0.5).add(band(fract(t.mul(0.3)), 0.62, 0.015).mul(0.5))
  const glint = band(fract(t.mul(0.12).sub(time.mul(0.05))), 0.5, 0.03)
  col = col.add(vec3(1, 1, 1).mul(streak.mul(0.14).add(glint.mul(0.2))))
  col = mix(col, vec3(0.97, 0.99, 1), scratch.mul(0.55))
  // frost creeping in from the edges, matte white
  const frost = smoothstep(10, 2.5, d.add(cloud.mul(6)).sub(scratch.mul(3)))
  col = mix(col, vec3(0.97, 0.99, 1), frost.mul(0.92))
  // inset: a shadowed lip under the north edge, a dark seam all round
  col = col.mul(mix(float(0.72), float(1), smoothstep(0.5, 4, north)))
  col = mix(vec3(0.36, 0.42, 0.48), col, smoothstep(0.4, 1.3, d))
  return floorMat(kit.mat(col, { spec: 0.12 }))
}

export function mudMaterial(kit: Kit, grid: FloorGrid) {
  const t = kit.canvas('mud', 128, 128, paintMud)
  const p = grid.cellPos()
  const { d } = grid.edge(G.mud)
  // cut felt: an irregular, hard edge (alpha tested)
  const wob = sin(p.x.mul(9.1).add(p.y.mul(3.7))).mul(0.9).add(sin(p.y.mul(12.3).sub(p.x.mul(4.9))).mul(0.6)).add(sin(p.x.mul(23).add(p.y.mul(19))).mul(0.3))
  const e = d.add(wob.mul(1.1))
  let col: N = texture(t, p.mul(0.5)).rgb
  // the cut edge catches the light, a soft dark line under it
  col = col.add(vec3(0.1, 0.07, 0.04).mul(smoothstep(3.2, 1.6, e)))
  col = col.mul(mix(float(0.7), float(1), smoothstep(1.1, 1.9, e)))
  const m = kit.mat(col, { alpha: smoothstep(0.6, 1.3, e) })
  m.alphaTest = 0.5
  if (kit.res > 1) m.alphaToCoverage = true
  return floorMat(m)
}

export function waterMaterial(kit: Kit, grid: FloorGrid) {
  const p = vec2(positionWorld.x, positionWorld.z)
  const cp = grid.cellPos()
  const { d, north } = grid.edge(G.water)
  // gentle crossing swells: analytic gradient of three sines (world units)
  const waves: [number, number, number, number][] = [
    [0.21, 0.12, 1.6, 1],
    [-0.09, 0.24, 1.25, 1],
    [0.33, -0.27, -2.1, 0.45],
    [0.05, 0.41, 2.6, 0.3],
  ]
  let gx: N = float(0)
  let gz: N = float(0)
  let h: N = float(0)
  for (const [kx, kz, w, a] of waves) {
    const ph = p.x.mul(kx).add(p.y.mul(kz)).add(time.mul(w))
    gx = gx.add(cos(ph).mul(kx * a))
    gz = gz.add(cos(ph).mul(kz * a))
    h = h.add(sin(ph).mul(a))
  }
  const n = normalize(vec3(gx.mul(-0.32), 1, gz.mul(-0.32)))
  const lam = n.dot(normalize(vec3(-0.3, 1, -0.5)))
  const spec = smoothstep(0.996, 0.9995, n.dot(normalize(vec3(0.28, 1, 0.42))))
  const deep = rgb(PAINT.water).mul(0.85)
  const light = vec3(0.4, 0.68, 0.9)
  let col: N = mix(deep, light, smoothstep(-1.6, 2.6, h).mul(0.55).add(smoothstep(0.97, 1, lam).mul(0.45)))
  col = col.add(vec3(0.95, 0.98, 1).mul(spec.mul(0.75)))
  // pale shallows and a foam line along the shore
  const shore = smoothstep(6, 1.5, d.add(h.mul(0.7)))
  col = mix(col, vec3(0.6, 0.8, 0.92), shore.mul(0.45))
  col = mix(col, vec3(0.92, 0.96, 0.98), band(d.add(h.mul(0.5)), 3.2, 0.9).mul(0.7))
  // the channel's far wall: painted wood above the waterline, its shadow on the water
  const wallH = 6.5
  const wallUv = vec2(cp.x.mul(0.8), north.div(wallH).mul(0.3))
  const wall = kit.woodGrain(wallUv, false).mul(mix(float(0.62), float(0.4), north.div(wallH)))
  col = col.mul(mix(float(0.62), float(1), smoothstep(wallH, wallH + 6, north)))
  col = mix(wall, col, step(wallH, north))
  return floorMat(kit.mat(col, { spec: 0.5 }))
}

/** belt of wooden slats with painted chevrons, scrolling at the push speed (0.9 units / frame) */
export function conveyorMaterial(kit: Kit, grid: FloorGrid, dirIndex: number) {
  const dir = [vec2(0, -1), vec2(1, 0), vec2(0, 1), vec2(-1, 0)][dirIndex]
  const across = vec2(dir.y, dir.x.negate())
  const p = grid.cellPos()
  const speed = (0.9 * 60) / CELL
  const a = p.dot(dir).sub(time.mul(speed))
  const q = fract(p.dot(across))
  const s = fract(a.mul(3))
  const body = smoothstep(0.02, 0.07, s).mul(smoothstep(0.98, 0.93, s))
  const round = float(1).sub(abs(s.sub(0.5)).mul(2).pow(3).mul(0.45))
  const grain = kit.woodGrain(vec2(q.mul(0.9).add(a.floor().mul(0.37)), s.mul(0.2).add(a.mul(3).floor().mul(0.23))), true)
  let col: N = grain.mul(round)
  // chevron painted across the slats, one per cell
  const ac = fract(a)
  const chev = ac.add(abs(q.sub(0.5)).mul(0.85))
  const arrow = smoothstep(0.5, 0.53, chev).mul(smoothstep(0.78, 0.75, chev)).mul(step(abs(q.sub(0.5)), 0.33))
  col = mix(col, painted(rgb(PAINT.red), grain, 0.3).mul(round), arrow)
  col = mix(vec3(0.24, 0.15, 0.08), col, body)
  return floorMat(kit.mat(col))
}

/** top of a teleporter pad (lathe disc, radius R): painted swirl in the pad colour */
export function teleportMaterial(kit: Kit, index: number, R: number) {
  const C = rgb(PAINT.teleport[index])
  const pl = positionGeometry.xz.div(R)
  const r = length(pl)
  const ang = atan(pl.y, pl.x)
  const grain = kit.woodGrain(pl.mul(0.5).add(0.5), true)
  const arms = smoothstep(0.1, 0.3, sin(ang.mul(3).add(r.mul(9)).sub(time.mul(2.2))))
  const inner = mix(C.mul(0.62), mix(C, vec3(1, 1, 1), 0.38), arms).mul(r.div(0.7).mul(0.35).add(0.65))
  let col: N = painted(inner, grain, 0.3)
  // hub, ink ring, cream rim with 1-4 pips naming the pair
  col = mix(col, rgb(PAINT.cream), step(r, 0.15))
  col = mix(col, rgb(PAINT.ink), band(r, 0.17, 0.03).max(band(r, 0.73, 0.035)))
  const rim = painted(rgb(PAINT.cream), grain, 0.35)
  col = mix(col, rim, step(0.76, r))
  let pips: N = float(0)
  for (let i = 0; i <= index; i++) {
    const a = -Math.PI / 2 + (i - index / 2) * 0.42
    pips = max(pips, smoothstep(0.075, 0.05, length(pl.sub(vec2(Math.cos(a) * 0.87, Math.sin(a) * 0.87)))))
  }
  col = mix(col, C.mul(0.75), pips)
  // the bevel / side: plain painted rim
  col = mix(rim.mul(0.92), col, step(0.9, normalGeometry.y))
  return kit.mat(col, { env: 0.12 })
}

/** gravity well: a recessed, painted log spiral turning inward, with sparkles drawn in */
export function wellMaterial(kit: Kit, R: number) {
  const pl = positionGeometry.xz.div(R)
  const r = length(pl)
  const ang = atan(pl.y, pl.x)
  const C = rgb(PAINT.well)
  let col: N = mix(C.mul(0.45), mix(C, vec3(1, 1, 1), 0.25), smoothstep(0.08, 1, r))
  const s = sin(ang.mul(2).sub(log(r.add(0.04)).mul(4.5)).add(time.mul(1.8)))
  const arm = smoothstep(0.35, 0.55, s).mul(smoothstep(0.1, 0.32, r))
  col = mix(col, mix(vec3(0.86, 0.78, 0.95), C, r.oneMinus().mul(0.5)), arm.mul(0.85))
  // the rim's shadow on the far (north) side of the bowl, light on the near side
  col = col.mul(float(1).sub(smoothstep(0.55, 1, length(pl.sub(vec2(0, 0.35)))).mul(0.55)))
  col = col.mul(mix(float(0.15), float(1), smoothstep(0.05, 0.16, r)))
  // sparkles spiralling in (the effect's kira sprite)
  let spark: N = float(0)
  for (let i = 0; i < 3; i++) {
    const k = fract(time.mul(0.32).add(i / 3))
    const rr = float(1).sub(k).mul(0.85)
    const aa = k.mul(5).add(i * 2.1)
    const at = pl.sub(vec2(cos(aa), sin(aa)).mul(rr)).div(0.32).add(0.5)
    const inside = step(abs(at.x.sub(0.5)), 0.5).mul(step(abs(at.y.sub(0.5)), 0.5))
    spark = spark.add(kit.sprite('kira', at).mul(inside).mul(rr.mul(1.4).min(1)))
  }
  col = col.add(vec3(1, 0.95, 1).mul(spark.mul(0.9)))
  const m = kit.mat(col, { alpha: step(r, 1) })
  m.alphaTest = 0.5
  return floorMat(m)
}

/** the shimmer over a teleporter pad: a soft column of light with sparkles rising (camera-facing quad, uv 0..1) */
export function shimmerMaterial(kit: Kit, index: number, phase: number) {
  const C = rgb(PAINT.teleport[index])
  const u = uv()
  const across = kit.sprite('glowSoft', vec2(u.x, 0.5))
  const fade = float(1).sub(u.y).pow(1.4)
  const pulse = sin(time.mul(2.4).add(phase)).mul(0.25).add(0.75)
  let a: N = across.mul(fade).mul(pulse).mul(0.4)
  for (let i = 0; i < 3; i++) {
    const k = fract(time.mul(0.45).add(i / 3 + phase * 0.1))
    const x = sin(float(i * 2.7 + phase).add(time.mul(0.7 + i * 0.2))).mul(0.22).add(0.5)
    const at = u.sub(vec2(x, k.mul(0.8).add(0.08))).mul(vec2(3.2, 4.4)).add(0.5)
    const inside = step(abs(at.x.sub(0.5)), 0.5).mul(step(abs(at.y.sub(0.5)), 0.5))
    a = a.add(kit.sprite('kira', at).mul(inside).mul(sin(k.mul(Math.PI))).mul(0.9))
  }
  return kit.glowMat(vec4(mix(C, vec3(1, 1, 1), 0.35).mul(a), float(1)))
}
