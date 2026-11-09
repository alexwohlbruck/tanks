// The Tanks+ toy pieces: geometry and materials per Kit (render quality). Wooden parts use the
// block textures with the blocks' rounded bevels; painted parts multiply a toy paint over the
// grain; rubber, iron and acrylic get their own small shaders. Everything is created on first
// use, so a level only compiles what it shows.

import * as THREE from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { abs, float, length, max, mix, normalGeometry, normalView, normalWorld, positionGeometry, positionWorld, sin, smoothstep, step, texture, time, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { conveyorMaterial, iceMaterial, mudMaterial, shimmerMaterial, teleportMaterial, waterMaterial, wellMaterial, type FloorGrid } from './floors'
import { CELL, painted, rgb, type Kit, type N } from './kit'
import { PAINT, paintCrate, paintGate, paintTokens } from './paint'

/** rotation that turns an XY quad toward the fixed 42-degree gameplay camera */
export const FACE_CAMERA = (-42 * Math.PI) / 180

/** tnk_shadow_animation SRT0 offsets per frame (models.ts) */
const SHADOW_SRT: [number, number][] = [
  [0, 0],
  [-0.5, 0],
  [0, 0.5],
  [0.5, -0.5],
]

const band = (x: N, c: number, w: number) => smoothstep(w, 0, abs(x.sub(c)))

export class Pieces {
  private geos = new Map<string, THREE.BufferGeometry>()
  private mats = new Map<string, THREE.Material | THREE.Material[]>()
  /** bumper hit flash: world xz of the last hit and its strength */
  bumperHit = uniform(new THREE.Vector2(1e5, 1e5))
  bumperPulse = uniform(0)
  /** laser lens glow per phase group (0 normal, 1 alternate) */
  lens = [uniform(0), uniform(0)]

  constructor(
    public kit: Kit,
    public grid: FloorGrid,
  ) {}

  dispose() {
    for (const g of this.geos.values()) g.dispose()
    for (const m of this.mats.values()) for (const x of Array.isArray(m) ? m : [m]) x.dispose()
    this.geos.clear()
    this.mats.clear()
  }

  geo(key: string, make: () => THREE.BufferGeometry) {
    let g = this.geos.get(key)
    if (!g) this.geos.set(key, (g = make()))
    return g
  }
  mat<T extends THREE.Material | THREE.Material[] = THREE.Material>(key: string, make: () => T): T {
    let m = this.mats.get(key) as T | undefined
    if (!m) this.mats.set(key, (m = make()))
    return m
  }

  // ---- geometry -------------------------------------------------------------------------

  box(w: number, h: number, d: number, r: number) {
    return this.geo(`box${w},${h},${d},${r}`, () => {
      const g = new RoundedBoxGeometry(w, h, d, 2, r)
      g.clearGroups()
      return g
    })
  }
  flat(w: number, d: number) {
    return this.geo(`flat${w},${d}`, () => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2))
  }
  /** camera-facing quad, origin at its bottom centre */
  billboard(w: number, h: number) {
    return this.geo(`bb${w},${h}`, () => new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0).rotateX(FACE_CAMERA))
  }
  /** a wooden disc with a rounded top edge (radius R, height H) */
  disc(R: number, H: number, b: number) {
    return this.geo(`disc${R},${H},${b}`, () => {
      // bottom edge up to the top centre (outward-facing winding)
      const pts = [new THREE.Vector2(R, 0)]
      for (let i = 4; i >= 0; i--) {
        const a = (i / 4) * (Math.PI / 2)
        pts.push(new THREE.Vector2(R - b + Math.sin(a) * b, H - b + Math.cos(a) * b))
      }
      pts.push(new THREE.Vector2(0.001, H))
      return new THREE.LatheGeometry(pts, 32)
    })
  }
  cyl(r: number, h: number, seg = 12) {
    return this.geo(`cyl${r},${h},${seg}`, () => new THREE.CylinderGeometry(r, r, h, seg))
  }
  sphere(r: number, seg = 16) {
    return this.geo(`sph${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)))
  }
  dome(r: number) {
    return this.geo(`dome${r}`, () => new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2))
  }
  torus(R: number, t: number) {
    return this.geo(`torus${R},${t}`, () => new THREE.TorusGeometry(R, t, 8, 40).rotateX(Math.PI / 2))
  }
  /** decal shadow of a block (frame per neighbours, like RPTnkBlock::UpdateShadow) */
  squareShadow(frame: number) {
    return this.geo(`sq${frame}`, () => {
      const g = new THREE.PlaneGeometry(70, 70).rotateX(-Math.PI / 2)
      const p = g.attributes.position
      const t = g.attributes.uv
      const [ou, ov] = SHADOW_SRT[frame]
      for (let i = 0; i < p.count; i++) t.setXY(i, (35 - p.getX(i)) / 140 + ou, (35 - p.getZ(i)) / 140 + ov)
      return g
    })
  }

  // ---- materials ------------------------------------------------------------------------

  /** a block-textured face (RoundedBox uv per face): the upper / lower cube's half */
  wood(upper = true, cork = false) {
    return this.mat(`wood${upper}${cork}`, () => this.kit.mat(this.kit.woodFace(uv(), upper, cork), { env: 0.157 }))
  }
  /** plain grain mapped in world space (rails, posts, rims): no block frame */
  woodPlain(upper = true, tint: string | null = null) {
    return this.mat(`woodPlain${upper}${tint}`, () => {
      const p = positionWorld.div(CELL)
      const top = step(0.7, abs(normalWorld.y))
      const side = vec2(p.x.add(p.z), p.y.mul(2.5))
      const g = this.kit.woodGrain(mix(side, vec2(p.x, p.z), top).mul(0.8), upper)
      return this.kit.mat(tint ? g.mul(rgb(tint)) : g, { env: 0.157 })
    })
  }
  paint(hex: string, env = 0.12, grain = 0.3) {
    return this.mat(`paint${hex}${env}${grain}`, () => {
      const p = positionWorld.div(CELL)
      const g = this.kit.woodGrain(vec2(p.x.add(p.z), p.y.add(p.z.mul(0.5))), true)
      return this.kit.mat(painted(rgb(hex), g, grain), { env })
    })
  }
  iron() {
    return this.mat('iron', () => this.kit.mat(rgb(PAINT.iron), { env: 0.3, spec: 0.3 }))
  }

  ice() {
    return this.mat('ice', () => iceMaterial(this.kit, this.grid))
  }
  mud() {
    return this.mat('mud', () => mudMaterial(this.kit, this.grid))
  }
  water() {
    return this.mat('water', () => waterMaterial(this.kit, this.grid))
  }
  conveyor(dir: number) {
    return this.mat(`conv${dir}`, () => conveyorMaterial(this.kit, this.grid, dir))
  }
  teleport(i: number) {
    return this.mat(`tp${i}`, () => teleportMaterial(this.kit, i, 15))
  }
  shimmer(i: number, phase: number) {
    return this.mat(`shim${i},${phase}`, () => shimmerMaterial(this.kit, i, phase))
  }
  well() {
    return this.mat('well', () => wellMaterial(this.kit, 20))
  }

  /** pink rubber cushion, flashing white where a shell just bounced */
  rubber() {
    return this.mat('rubber', () => {
      const y = positionGeometry.y
      const C = rgb(PAINT.rubber)
      const stripe = band(y, 0, 0.7)
      const col = mix(C, rgb(PAINT.cream), stripe.mul(0.85))
      const near = smoothstep(32, 14, length(vec2(positionWorld.x, positionWorld.z).sub(this.bumperHit)))
      return this.kit.mat(col, { env: 0.2, emissive: vec3(1, 0.85, 0.9).mul(this.bumperPulse.mul(near).mul(0.6)), spec: 0.25 })
    })
  }

  /** clear acrylic: faint faces, bright bevels and two highlight streaks */
  glass(inner: boolean) {
    return this.mat(`glass${inner}`, () => {
      const n = normalGeometry
      const bev = float(1).sub(max(max(abs(n.x), abs(n.y)), abs(n.z)))
      const edge = smoothstep(0.03, 0.18, bev)
      const p = positionGeometry.div(17)
      const t = p.x.mul(0.7).add(p.y.mul(0.7)).sub(p.z.mul(0.35))
      const streak = band(t, 0.3, 0.1).add(band(t, 0.62, 0.035).mul(0.8))
      const fres = float(1).sub(abs(normalView.z))
      const tint = inner ? vec3(0.5, 0.75, 0.78) : vec3(0.78, 0.94, 0.96)
      const lit = normalWorld.y.max(0).mul(0.25).add(0.75)
      const col = mix(tint, vec3(1, 1, 1), edge.mul(0.75).add(streak.mul(inner ? 0 : 0.7)).min(1)).mul(lit)
      const a = inner ? float(0.1).add(edge.mul(0.3)) : float(0.12).add(fres.mul(0.22)).add(edge.mul(0.5)).add(streak.mul(0.32)).add(step(0.9, n.y).mul(0.06))
      return this.kit.mat(col, { unlit: true, transparent: true, alpha: a.min(0.95), side: inner ? THREE.BackSide : THREE.FrontSide })
    })
  }

  /** crate atlas: sides / lid */
  crate() {
    return this.mat('crate', () => {
      const t = this.kit.canvas('crate', 128, 64, (c, w, h) => paintCrate(c, w, h, this.kit.img.wood), false)
      const top = step(0.7, normalGeometry.y)
      const at = vec2(uv().x.mul(0.5).add(top.mul(0.5)), uv().y)
      return this.kit.mat(texture(t, at).rgb, { env: 0.12 })
    })
  }

  /** gate panel (thickness along local z): door face on the broad sides, plain board elsewhere */
  gate() {
    return this.mat('gate', () => {
      const t = this.kit.canvas('gate', 128, 64, (c, w, h) => paintGate(c, w, h, this.kit.img.wood), false)
      const face = step(0.7, abs(normalGeometry.z))
      const at = vec2(uv().x.mul(0.5).add(face.oneMinus().mul(0.5)), uv().y)
      return this.kit.mat(texture(t, at).rgb, { env: 0.12 })
    })
  }
  slot() {
    return this.mat('slot', () => {
      const m = this.kit.mat(vec3(0.13, 0.08, 0.05))
      m.depthWrite = false
      m.userData.order = 1
      return m
    })
  }

  /** switch base plate: wood with a painted two-tone dial */
  switchPlate() {
    return this.mat('swplate', () => {
      const p = uv().sub(0.5)
      const r = length(p)
      const top = step(0.9, normalGeometry.y)
      const wood = this.kit.woodFace(uv(), true)
      const dial = mix(rgb(PAINT.red), rgb('#4f9a3c'), step(0, p.y))
      let col: N = mix(wood, painted(dial, wood, 0.3), step(r, 0.36).mul(top))
      col = mix(col, rgb(PAINT.ink), band(r, 0.36, 0.025).mul(top))
      return this.kit.mat(col, { env: 0.157 })
    })
  }

  /** emitter dome / paint per phase */
  laserPaint(phase: number) {
    return this.paint(PAINT.laser[phase], 0.32, 0.15)
  }
  /** the lens: dark glass, glowing while the phase group is lit */
  lensMat(phase: number) {
    return this.mat(`lens${phase}`, () => {
      const C = phase ? vec3(1, 0.35, 0.75) : vec3(1, 0.3, 0.2)
      return this.kit.mat(vec3(0.3, 0.05, 0.05), { env: 0.35, emissive: C.mul(this.lens[phase]) })
    })
  }

  /** pad top: the token face painted on the disc (power-up kind) */
  padTop(kind: number) {
    return this.mat(`pad${kind}`, () => {
      const t = this.tokens()
      const pl = positionGeometry.xz.div(13.5)
      const at = vec2(pl.x.mul(0.5).add(0.5).add(kind).div(6), pl.y.mul(0.5).add(0.5))
      const top = step(0.9, normalGeometry.y)
      const face = texture(t, at).rgb.mul(0.92)
      const rim = painted(rgb(PAINT.cream), this.kit.woodGrain(pl, true), 0.4).mul(0.9)
      return this.kit.mat(mix(rim, face, top), { env: 0.1 })
    })
  }
  tokens() {
    return this.kit.canvas('tokens', 384, 64, (c, w, h) => paintTokens(c, w, h, this.kit.img.wood), false)
  }
  /** token coin: [rim, face, back] */
  coin(kind: number): THREE.Material[] {
    return this.mat(`coin${kind}`, () => {
      const t = this.tokens()
      const rim = this.kit.mat(rgb(PAINT.creamDark).mul(sin(uv().x.mul(Math.PI * 2 * 36)).mul(0.08).add(0.92)), { env: 0.3 })
      const face = (flip: boolean) => this.kit.mat(texture(t, vec2((flip ? uv().y.oneMinus() : uv().y).add(kind).div(6), uv().x)).rgb, { env: 0.22 })
      return [rim, face(false), face(true)]
    })
  }

  // ---- shadows / glows --------------------------------------------------------------------

  /** decal shadow of a block: the block shadow texture (opacity 0.392 like block_shadow_mat) */
  shadowMat(k = 1) {
    return this.mat(`shadow${k}`, () => {
      const m = this.kit.glowMat(vec4(0, 0, 0, texture(this.kit.tex.blockShadow, uv()).a.mul(0.392 * k)), false)
      m.side = THREE.FrontSide
      return m
    })
  }
  /** round decal shadow (tank_shadow), opacity in a uniform */
  roundShadowMat(opacity = 0.5) {
    return this.mat(`rshadow${opacity}`, () => {
      const m = this.kit.glowMat(vec4(0, 0, 0, texture(this.kit.tex.roundShadow, uv()).a.mul(opacity)), false)
      m.side = THREE.FrontSide
      return m
    })
  }
  /** soft additive glow sprite (effect texture), colour * k */
  glowSprite(hex: string, k = 1, soft = false) {
    return this.mat(`glow${hex}${k}${soft}`, () => this.kit.glowMat(vec4(rgb(hex).mul(this.kit.sprite(soft ? 'glowSoft' : 'glow').mul(k)), 1)))
  }
  sparkle(k = 1) {
    return this.mat(`kira${k}`, () => this.kit.glowMat(vec4(vec3(1, 0.97, 0.9).mul(this.kit.sprite('kira').mul(k)), 1)))
  }
  /** beam ribbon: across-profile from the effect's vertical gradient, shimmering along the length */
  beam(hex: string, k: number, scroll: number) {
    return this.mat(`beam${hex}${k}${scroll}`, () => {
      const across = texture(this.kit.tex.grad, vec2(0.5, uv().x)).a
      const along = positionWorld.x.add(positionWorld.z)
      const flick = sin(along.mul(0.35).sub(time.mul(scroll))).mul(0.15).add(0.85)
      return this.kit.glowMat(vec4(rgb(hex).mul(across.mul(across).mul(k).mul(flick)), 1))
    })
  }

  /** shield bubble: clear plastic with a mint rim, a painted gloss spot and a soft sheen */
  shield() {
    return this.mat('shield', () => {
      const n = normalView.normalize()
      const fres = float(1).sub(abs(n.z))
      const spot = smoothstep(0.86, 0.95, n.dot(vec3(-0.45, 0.55, 0.7).normalize()))
      const spot2 = smoothstep(0.93, 0.97, n.dot(vec3(0.5, -0.45, 0.74).normalize())).mul(0.5)
      const hue = sin(fres.mul(7).add(time.mul(1.5))).mul(0.5).add(0.5)
      const rim = mix(vec3(0.5, 0.95, 0.8), vec3(0.7, 0.85, 1), hue.mul(0.5))
      const col = mix(rim, vec3(1, 1, 1), spot.add(spot2).min(1))
      const a = fres.pow(2.2).mul(0.55).add(0.05).add(spot.mul(0.7)).add(spot2.mul(0.4))
      return this.kit.mat(col, { unlit: true, transparent: true, alpha: a.min(0.9) })
    })
  }
  /** boss hit-point pip: lit red enamel / empty */
  pip(on: boolean) {
    return this.mat(`pip${on}`, () => (on ? this.kit.mat(rgb('#d8342a'), { env: 0.3, unlit: true, emissive: vec3(0.1, 0.02, 0) }) : this.kit.mat(vec3(0.22, 0.15, 0.1), { unlit: true, env: 0.1 })))
  }
  /** unlit wood for the boss bar (faces the camera, so the GX light would leave it dark) */
  barWood() {
    return this.mat('barWood', () => this.kit.mat(this.kit.woodFace(uv(), false).mul(0.95), { unlit: true, env: 0.1 }))
  }
}

/** the frame / orientation of a block decal shadow for its solid neighbours (scene.ts blockShadowFor) */
export function shadowFrame(up: boolean, down: boolean, left: boolean, right: boolean) {
  const f = [true, true, true, true, true, true, true, true]
  if (up) f[0] = f[6] = false
  if (down) f[2] = f[4] = false
  if (left) f[0] = f[2] = false
  if (right) f[4] = f[6] = false
  const fwd = { x: 0, z: 1 }
  const back = { x: 0, z: -1 }
  const l = { x: -1, z: 0 }
  const r = { x: 1, z: 0 }
  const count = [0, 2, 4, 6].filter((i) => !f[i]).length
  switch (count) {
    case 2:
      if (!f[0] && !f[2]) return { frame: 1, forward: l }
      if (!f[2] && !f[4]) return { frame: 1, forward: fwd }
      if (!f[4] && !f[6]) return { frame: 1, forward: r }
      return { frame: 1, forward: back }
    case 3:
      if (f[0]) return { frame: 2, forward: fwd }
      if (f[2]) return { frame: 2, forward: r }
      if (f[4]) return { frame: 2, forward: back }
      return { frame: 2, forward: l }
    case 4:
      return { frame: 3, forward: fwd }
    default:
      return { frame: 0, forward: fwd }
  }
}

/** static meshes collected by (geometry, material) and drawn as instanced meshes */
export class Batch {
  private groups = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; list: THREE.Matrix4[]; o: BatchOpts }>()
  add(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], m: THREE.Matrix4, o: BatchOpts = {}) {
    const id = Array.isArray(mat) ? mat.map((x) => x.uuid).join() : mat.uuid
    const k = `${geo.uuid}|${id}`
    let e = this.groups.get(k)
    if (!e) this.groups.set(k, (e = { geo, mat, list: [], o }))
    e.list.push(m.clone())
    return e.list.length - 1
  }
  build(shadows: boolean) {
    const g = new THREE.Group()
    for (const e of this.groups.values()) {
      const im = new THREE.InstancedMesh(e.geo, e.mat, e.list.length)
      e.list.forEach((m, i) => im.setMatrixAt(i, m))
      const ud = (Array.isArray(e.mat) ? e.mat[0] : e.mat).userData
      im.renderOrder = e.o.order ?? (ud.order as number) ?? 0
      im.castShadow = shadows && !!e.o.cast
      im.receiveShadow = shadows && !e.o.decal
      if (e.o.decal) {
        im.userData.decal = true
        im.visible = !shadows
      }
      im.frustumCulled = false
      g.add(im)
    }
    return g
  }
}
export type BatchOpts = { cast?: boolean; decal?: boolean; order?: number }

