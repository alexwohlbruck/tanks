// Tanks+ rendering: special tiles, power-ups, lasers, fog of war and the per-tank extras
// (shields, boss hit points, sniper sights, fuses, teleport flicker), plus the liveries of the
// added tank types. SceneView calls this through a handful of one-line hooks; it does nothing
// for worlds without `plus`.
//
// The tiles are toy pieces made to sit next to the disc's blocks: block-textured wood with the
// blocks' bevels, painted wood, felt, rubber and acrylic, shaded like models.ts (GX light +
// env shine, or Phong at 'ultra'), with the blocks' decal shadows and the effect sprites for
// glows. Pieces: tiles/pieces.ts, floors: tiles/floors.ts, paints / icons: tiles/paint.ts,
// textures and shading per render quality: tiles/kit.ts.

import * as THREE from 'three/webgpu'
import { length, min, positionWorld, smoothstep, uniform, vec2, vec4 } from 'three/tsl'
import type { Plus } from '../sim/plus'
import { tankMeta, tankTypes } from '../sim/stats'
import type { Tile } from '../sim/tiles'
import { Cell, type SimEvent, type Tank, type World } from '../sim/world'
import type { Effects } from './effects'
import type { HiresTextures } from './hires'
import { QUALITY_PRESETS, type RenderOptions } from './quality'
import { registerTankVisual, type BaseModel } from './registry'
import { FloorGrid, G } from './tiles/floors'
import { CELL, Kit } from './tiles/kit'
import { PAINT } from './tiles/paint'
import { Batch, FACE_CAMERA, Pieces, shadowFrame } from './tiles/pieces'

// ---- liveries of the added tank types (base model: 8 = White, the plainest texture) -------

const LIVERY: Record<number, { accent?: string; scale?: number; emissive?: string; base?: number }> = {
  10: { accent: '#ffd080' },
  11: { accent: '#c8d8e8' },
  12: { accent: '#ffb0ff', emissive: '#501060' },
  13: { accent: '#ffcc40' },
  14: { accent: '#4a5020' },
  15: { accent: '#ff7060', emissive: '#300000' },
  16: { accent: '#202818' },
  17: { accent: '#e02020' },
  18: { accent: '#c8a0ff', scale: 1.2 },
  19: { accent: '#607020', scale: 0.72 },
  20: { accent: '#e0f0ff', emissive: '#102028' },
  21: { accent: '#d0a030', scale: 1.4 },
  22: { accent: '#40e0ff', scale: 1.45, emissive: '#200838' },
}
for (const t of tankTypes())
  if (!t.original) {
    const l = LIVERY[t.id] ?? {}
    registerTankVisual(t.id, {
      baseModel: `e_${l.base ?? 8}` as BaseModel,
      livery: t.colour,
      accent: l.accent ?? t.colour,
      scale: l.scale ?? 1,
      emissive: l.emissive ?? undefined,
      pieceColor: t.colour,
    })
  }

/** CSS colour of the explosion pieces of an added type */
export function pieceColour(type: number): [number, number, number] | null {
  const m = tankMeta(type)
  if (!m) return null
  const c = new THREE.Color(m.colour)
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
}

// ---- the view -----------------------------------------------------------------------------

/** north (-z), east, south, west as [dc, dr] */
const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]
const UP = new THREE.Vector3(0, 1, 0)
const isConveyor = (code: number) => code >= 510 && code <= 513
const isLaser = (code: number) => code >= 560 && code <= 567
/** gate panel height when closed / slid into the floor */
const GATE_UP = 17
const GATE_DOWN = -16

type Gate = { panel: THREE.Object3D; y: number }
type Switch = { lever: THREE.Object3D; a: number }
type Beam = { glow: THREE.Group; ends: THREE.Mesh[] }
type Item = { obj: THREE.Group; pivot: THREE.Object3D; glow: THREE.Mesh; shadow: THREE.Mesh; kira: THREE.Object3D }
type TankExtra = {
  group: THREE.Group
  shield: THREE.Mesh
  bar: THREE.Group
  pips: THREE.Mesh[]
  fuse: THREE.Group
  spark: THREE.Object3D
  sight: THREE.Group
  sightEnd: THREE.Mesh
}

export class TilesView {
  private root = new THREE.Group()
  private statics = new THREE.Group()
  private dynamic = new THREE.Group()
  private items = new Map<number, Item>()
  private beams = new Map<number, Beam>()
  private extras = new Map<Tank, TankExtra>()
  private gates = new Map<number, Gate>()
  private switches = new Map<number, Switch>()
  private world: World | null = null
  private version = -1
  private fog: THREE.Mesh | null = null
  private fogPlayers = [0, 1, 2, 3].map(() => uniform(new THREE.Vector2(1e5, 1e5)))
  private fogRadius = uniform(150)
  private frame = 0
  private pulse = 0
  private grid = new FloorGrid()
  private opts: RenderOptions = QUALITY_PRESETS.classic
  private hires: HiresTextures | null = null
  private pieces: Pieces | null = null
  private kitJob: Promise<void> | null = null
  private kitSerial = 0

  constructor(
    parent: THREE.Object3D,
    private fx: Effects,
  ) {
    parent.add(this.root)
    this.root.add(this.statics, this.dynamic)
  }

  /** SceneView.applyQuality: rebuild the pieces for the new textures / lighting */
  setOptions(o: RenderOptions, hires: HiresTextures | null) {
    this.opts = o
    this.hires = hires
    this.kitJob = this.loadKit()
    return this.kitJob
  }

  private async loadKit() {
    const serial = ++this.kitSerial
    const kit = new Kit(this.opts, this.hires)
    await kit.load()
    if (serial !== this.kitSerial) return kit.dispose()
    this.clearVisuals()
    if (this.pieces) {
      this.pieces.kit.dispose()
      this.pieces.dispose()
    }
    this.pieces = new Pieces(kit, this.grid)
  }

  setWorld(w: World) {
    this.world = w
    this.clearVisuals()
    if (this.fog) this.root.remove(this.fog)
    this.fog = null
    // floor classes for the joined floors (ice / mud / water panels)
    const o = w.cellCenter(0, 0)
    this.grid.reset(o.x - CELL / 2, o.z - CELL / 2)
    for (let r = 0; r < w.height; r++)
      for (let c = 0; c < w.width; c++) {
        const code = w.grid[r][c].code
        this.grid.set(c, r, code === 520 ? G.ice : code === 521 ? G.mud : code === 550 ? G.water : G.none)
      }
    this.grid.commit()
  }

  private clearVisuals() {
    this.version = -1
    for (const o of this.items.values()) this.root.remove(o.obj)
    this.items.clear()
    for (const b of this.beams.values()) this.root.remove(b.glow, ...b.ends)
    this.beams.clear()
    for (const e of this.extras.values()) this.root.remove(e.group)
    this.extras.clear()
    this.dynamic.clear()
    this.gates.clear()
    this.switches.clear()
    this.clearStatics()
  }

  private clearStatics() {
    for (const g of this.statics.children) for (const c of g.children) (c as THREE.InstancedMesh).dispose?.()
    this.statics.clear()
  }

  /** the grid cells drawn here instead of by Models.block (tile cells) */
  ownsCell(code: number) {
    return code >= 500 && code <= 599
  }

  // ---- static pieces (rebuilt when a tile block appears / goes) ------------------------------

  private rebuild(w: World, p: Plus) {
    this.clearStatics()
    const P = this.pieces!
    const kit = P.kit
    const b = new Batch()
    const M = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const v = new THREE.Vector3()
    const one = new THREE.Vector3(1, 1, 1)
    const at = (x: number, y: number, z: number, ry = 0) => M.compose(v.set(x, y, z), q.setFromAxisAngle(UP, ry), one)
    const atE = (x: number, y: number, z: number, e: THREE.Euler) => M.compose(v.set(x, y, z), q.setFromEuler(e), one)
    const code = (c: number, r: number) => w.grid[r]?.[c]?.code ?? -1
    const solid = (c: number, r: number) => {
      const k = w.grid[r]?.[c]?.kind
      return k === Cell.Block || k === Cell.Cork
    }
    const shadow = (t: Tile, k = 1) => {
      if (!kit.decals) return
      const s = shadowFrame(solid(t.c, t.r - 1), solid(t.c, t.r + 1), solid(t.c - 1, t.r), solid(t.c + 1, t.r))
      b.add(P.squareShadow(s.frame), P.shadowMat(k), at(t.x, 0.6, t.z, Math.atan2(s.forward.x, s.forward.z)), { decal: true, order: 2 })
    }
    const round = (x: number, z: number, size: number, k: number) => {
      if (kit.decals) b.add(P.flat(size, size), P.roundShadowMat(k), at(x, 0.6, z), { decal: true, order: 2 })
    }
    for (const t of p.tiles.list) {
      const { x, z } = t
      const c = t.code
      if (c >= 500 && c <= 503) {
        // painted wooden pad with a turning swirl, a soft column of light above it
        round(x, z, 40, 0.3)
        b.add(P.disc(15, 2.4, 1.2), P.teleport(c - 500), at(x, 0, z), { cast: true })
        b.add(P.billboard(34, 48), P.shimmer(c - 500, t.index % 2), at(x, 1, z), { order: 6 })
      } else if (isConveyor(c)) {
        // belt of slats; wooden side rails where the belt ends across, iron rollers at its ends
        const d = c - 510
        const [dx, dz] = DIRS[d]
        b.add(P.flat(CELL, CELL), P.conveyor(d), at(x, 0.35, z))
        for (const s of [-1, 1]) {
          const ax = -dz * s
          const az = dx * s
          if (code(t.c + ax, t.r + az) !== c) b.add(P.box(CELL, 3.2, 3.6, 1.2), P.woodPlain(false), at(x + ax * 15.7, 1.6, z + az * 15.7, Math.atan2(dx, dz) + Math.PI / 2), { cast: true })
          if (code(t.c + dx * s, t.r + dz * s) !== c) b.add(P.cyl(2.2, 30, 10), P.iron(), atE(x + dx * s * 15.5, 1.6, z + dz * s * 15.5, new THREE.Euler(0, Math.atan2(dx, dz), Math.PI / 2, 'YXZ')), { cast: true })
        }
      } else if (c === 520) b.add(P.flat(CELL, CELL), P.ice(), at(x, 0.3, z))
      else if (c === 521) b.add(P.flat(CELL, CELL), P.mud(), at(x, 0.32, z))
      else if (c === 550) {
        // channel: water surface with a wooden edging round the region
        b.add(P.flat(CELL, CELL), P.water(), at(x, 0.3, z))
        for (const [dc, dr] of DIRS)
          if (code(t.c + dc, t.r + dr) !== 550) b.add(P.box(CELL + 3.6, 3, 3.6, 1.2), P.woodPlain(false, '#f0d8a8'), at(x + dc * 17.5, 1.5, z + dr * 17.5, dc ? Math.PI / 2 : 0), { cast: true })
      } else if (c === 530) {
        if (!t.block) continue
        // wooden post in a fat rubber cushion
        shadow(t)
        b.add(P.box(30, 34, 30, 3), P.wood(true), at(x, 17, z), { cast: true })
        b.add(P.box(36, 12, 36, 5.5), P.rubber(), at(x, 16, z), { cast: true })
        b.add(P.disc(9, 2.2, 1.1), P.rubber(), at(x, 33.6, z), { cast: true })
      } else if (c === 531) {
        if (!t.block) continue
        shadow(t, 0.45)
        b.add(P.box(34, 34, 34, 3), P.glass(true), at(x, 17, z), { order: 3 })
        b.add(P.box(34, 34, 34, 3), P.glass(false), at(x, 17, z), { order: 4 })
      } else if (c === 532) {
        if (!t.block) continue
        shadow(t)
        b.add(P.box(31, 31, 31, 1.6), P.crate(), at(x, 15.5, z, ((t.index * 7) % 4) * (Math.PI / 2)), { cast: true })
      } else if (c === 541 || c === 542) {
        if (t.block) shadow(t)
      } else if (isLaser(c)) {
        if (!t.block) continue
        // wooden base, iron collar, painted dome, barrel with a glass lens
        shadow(t)
        const phase = c >= 564 ? 1 : 0
        const [dx, dz] = DIRS[(c - 560) % 4]
        const yaw = Math.atan2(dx, dz)
        b.add(P.box(33, 22, 33, 2.5), P.wood(true), at(x, 11, z), { cast: true })
        b.add(P.cyl(12.5, 2.4, 24), P.iron(), at(x, 23, z), { cast: true })
        b.add(P.dome(10.5), P.laserPaint(phase), at(x, 24, z), { cast: true })
        b.add(P.cyl(3.4, 12, 12), P.iron(), atE(x + dx * 13, 13, z + dz * 13, new THREE.Euler(Math.PI / 2, yaw, 0, 'YXZ')), { cast: true })
        b.add(P.sphere(3.7, 12), P.lensMat(phase), at(x + dx * 19.5, 13, z + dz * 19.5))
      } else if (c === 570) {
        b.add(P.flat(42, 42), P.well(), at(x, 0.3, z))
        b.add(P.torus(20.6, 1.8), P.woodPlain(true), at(x, 0.9, z), { cast: true })
      } else if (c >= 580 && c <= 585) {
        round(x, z, 36, 0.3)
        b.add(P.disc(13.5, 2.2, 1), P.padTop(c - 580), at(x, 0, z), { cast: true })
      }
    }
    this.statics.add(b.build(this.opts.shadows))
    this.buildDynamic(w, p)
  }

  /** gates and switches: animated, kept across rebuilds */
  private buildDynamic(w: World, p: Plus) {
    const P = this.pieces!
    const sh = this.opts.shadows
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m)
      o.position.set(x, y, z)
      o.castShadow = sh
      o.receiveShadow = sh
      return o
    }
    const wallish = (c: number, r: number) => {
      const g = w.grid[r]?.[c]
      return !!g && (g.kind === Cell.Block || g.kind === Cell.Cork || g.code === 541 || g.code === 542)
    }
    for (const t of p.tiles.list) {
      if ((t.code === 541 || t.code === 542) && !this.gates.has(t.index)) {
        // painted barn-door panel between two posts; it slides down into a slot in the floor
        const obj = new THREE.Group()
        obj.position.set(t.x, 0, t.z)
        const alongX = wallish(t.c - 1, t.r) || wallish(t.c + 1, t.r) || !(wallish(t.c, t.r - 1) || wallish(t.c, t.r + 1))
        obj.rotation.y = alongX ? 0 : Math.PI / 2
        const slot = mesh(P.flat(33, 7), P.slot(), 0, 0.3, 0)
        slot.renderOrder = 1
        slot.receiveShadow = false
        const y = t.block ? GATE_UP : GATE_DOWN
        const panel = mesh(P.box(32, 34, 18, 2), P.gate(), 0, y, 0)
        const cap = P.paint(PAINT.red, 0.3, 0)
        obj.add(slot, panel)
        for (const s of [-1, 1]) obj.add(mesh(P.box(5, 40, 7, 1.5), P.wood(false), s * 16, 20, 0), mesh(P.disc(2.6, 3, 1.2), cap, s * 16, 40, 0))
        this.gates.set(t.index, { panel, y })
        this.dynamic.add(obj)
      } else if (t.code === 540 && !this.switches.has(t.index)) {
        // toy lever on a wooden plate with a painted dial
        const obj = new THREE.Group()
        obj.position.set(t.x, 0, t.z)
        const hub = mesh(P.cyl(2.8, 10, 12), P.iron(), 0, 5, 0)
        hub.rotation.z = Math.PI / 2
        const lever = new THREE.Group()
        lever.position.y = 5
        lever.add(mesh(P.cyl(1.6, 15, 8), P.woodPlain(true), 0, 7.5, 0), mesh(P.sphere(5, 16), P.paint(PAINT.red, 0.32, 0), 0, 15.5, 0))
        obj.add(mesh(P.box(29, 3, 29, 1.2), P.switchPlate(), 0, 1.5, 0), hub, lever)
        const a = t.open ? 0.6 : -0.6
        lever.rotation.x = a
        this.switches.set(t.index, { lever, a })
        this.dynamic.add(obj)
      }
    }
  }

  onEvents(ev: SimEvent[]) {
    for (const e of ev) {
      if (e.t !== 'plus' || !e.pos) continue
      switch (e.kind) {
        case 'teleport':
        case 'teleportIn':
        case 'spawn':
          this.fx.spawn('Tnk_stealth_change', { pos: e.pos, scale: 1.2 })
          break
        case 'hit':
        case 'pickup':
        case 'deflect':
          this.fx.spawn('Tnk_shell_crash', { pos: { x: e.pos.x, y: 17.6, z: e.pos.z }, scale: 2 })
          break
        case 'shieldPop':
          this.fx.spawn('Tnk_shell_bomb', { pos: { x: e.pos.x, y: 17.6, z: e.pos.z }, scale: 2.5 })
          break
        case 'glass':
          this.fx.spawn('Tnk_shell_crash', { pos: { x: e.pos.x, y: 17.5, z: e.pos.z }, scale: 2.4 })
          break
        case 'crate':
          // splinters (the block break effect itself comes from SceneView)
          this.fx.spawn('Tnk_bomb01_piece', { pos: { x: e.pos.x, y: 8, z: e.pos.z }, scale: 1.2, color: [196, 140, 80] })
          break
        case 'switch':
          this.fx.spawn('Tnk_shell_crash', { pos: { x: e.pos.x, y: 10, z: e.pos.z }, scale: 1 })
          break
        case 'bumper':
          this.pulse = 1
          this.pieces?.bumperHit.value.set(e.pos.x, e.pos.z)
          break
      }
    }
  }

  /** per rendered frame, after SceneView.sync posed the tanks */
  sync(tankRoots: Map<Tank, { root: THREE.Object3D }>) {
    const w = this.world
    const p = w?.plus
    if (!w || !p) return
    if (!this.pieces) {
      this.kitJob ??= this.loadKit()
      return
    }
    const P = this.pieces
    this.frame++
    if (p.tiles.version !== this.version) {
      this.version = p.tiles.version
      this.rebuild(w, p)
    }
    this.pulse *= 0.88
    P.bumperPulse.value = this.pulse
    // gates slide, levers swing
    for (const [i, g] of this.gates) {
      g.y += ((p.tiles.list[i].block ? GATE_UP : GATE_DOWN) - g.y) * 0.2
      g.panel.position.y = g.y
    }
    for (const [i, s] of this.switches) {
      s.a += ((p.tiles.list[i].open ? 0.6 : -0.6) - s.a) * 0.25
      s.lever.rotation.x = s.a
    }
    this.syncLasers(p)
    this.syncItems(p)
    this.syncExtras(w, tankRoots)
    // fog of war
    if (p.fog > 0) {
      if (!this.fog) this.fog = this.makeFog(w)
      this.fogRadius.value = p.fog
      for (let i = 0; i < 4; i++) {
        const k = w.playerTanks[i]
        const on = i < w.players && k.active && k.lives > 0
        this.fogPlayers[i].value.set(on ? k.pos.x : 1e5, on ? k.pos.z : 1e5)
      }
    }
  }

  private syncLasers(p: Plus) {
    const P = this.pieces!
    const glow = [0, 0]
    for (const t of p.tiles.list) {
      if (!isLaser(t.code)) continue
      const phase = t.code >= 564 ? 1 : 0
      const lit = t.laser === 2
      const warn = t.laser === 1
      const blink = this.frame % 8 < 4
      glow[phase] = Math.max(glow[phase], lit ? 1.1 : warn ? (blink ? 0.9 : 0.15) : 0.12)
      let b = this.beams.get(t.index)
      if (!b) {
        b = this.makeBeam(phase)
        this.beams.set(t.index, b)
      }
      const on = !!t.beam && (lit || (warn && blink))
      b.glow.visible = on
      for (const e of b.ends) e.visible = on
      if (on && t.beam) {
        const { x0, z0, x1, z1 } = t.beam
        const len = Math.max(1, Math.hypot(x1 - x0, z1 - z0))
        const wob = lit ? 1 + Math.sin(this.frame * 0.5 + t.index) * 0.08 : 0.3
        b.glow.position.set((x0 + x1) / 2, 13, (z0 + z1) / 2)
        b.glow.rotation.y = Math.atan2(x1 - x0, z1 - z0)
        b.glow.scale.set(wob, wob, len)
        b.ends[0].position.set(x0, 13, z0)
        b.ends[1].position.set(x1, 13, z1)
        b.ends[0].scale.setScalar(lit ? 1 : 0.5)
        b.ends[1].scale.setScalar(lit ? 0.8 + Math.sin(this.frame * 0.7 + t.index) * 0.15 : 0.4)
      }
    }
    P.lens[0].value = glow[0]
    P.lens[1].value = glow[1]
  }

  /** crossed glow ribbons with a white-hot core, glow sprites at both ends */
  private makeBeam(phase: number): Beam {
    const P = this.pieces!
    const hex = phase ? '#ff4aa8' : '#ff4a26'
    const glow = new THREE.Group()
    const flat = new THREE.Mesh(this.ribbon(), P.beam(hex, 0.9, 14))
    flat.scale.set(16, 1, 1)
    const vert = new THREE.Mesh(
      P.geo('ribbonVert', () => new THREE.PlaneGeometry(1, 1).rotateZ(Math.PI / 2).rotateY(Math.PI / 2)),
      P.beam(hex, 0.7, 11),
    )
    vert.scale.set(1, 12, 1)
    const core = new THREE.Mesh(flat.geometry, P.beam('#fff0e0', 1, 20))
    core.scale.set(4, 1, 1)
    core.position.y = 0.2
    glow.add(flat, vert, core)
    for (const m of [flat, vert, core]) m.renderOrder = 7
    const ends = [0, 1].map(() => {
      const e = new THREE.Mesh(this.endGlow(), P.glowSprite(hex, 1.3))
      e.renderOrder = 7
      this.root.add(e)
      return e
    })
    this.root.add(glow)
    return { glow, ends }
  }

  private ribbon() {
    return this.pieces!.geo('ribbonFlat', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
  }
  private endGlow() {
    return this.pieces!.geo('endGlow', () => new THREE.PlaneGeometry(30, 30).rotateX(FACE_CAMERA))
  }
  private kiraQuad() {
    return this.pieces!.geo('kira', () => new THREE.PlaneGeometry(14, 14))
  }

  private syncItems(p: Plus) {
    const seen = new Set<number>()
    for (const it of p.powerups.items) {
      seen.add(it.id)
      let o = this.items.get(it.id)
      if (!o) {
        o = this.makeItem(it.kind)
        this.items.set(it.id, o)
        this.root.add(o.obj)
      }
      const t = it.age + it.id * 13
      const bob = 15 + Math.sin(t * 0.07) * 2.5
      o.obj.position.set(it.pos.x, 0, it.pos.z)
      o.pivot.position.y = bob
      o.pivot.rotation.y = Math.sin(t * 0.035) * 0.55
      o.glow.position.y = bob - 16
      o.shadow.scale.setScalar(1.15 - (bob - 12.5) * 0.03)
      // a glint every couple of seconds
      const k = (t % 140) / 22
      o.kira.visible = k < 1
      o.kira.scale.setScalar(Math.sin(Math.min(1, k) * Math.PI) * 1.2 + 0.001)
      o.kira.rotation.z = t * 0.05
      o.obj.visible = !(it.life > 0 && it.life < 180 && it.life % 12 < 6)
    }
    for (const [id, o] of this.items)
      if (!seen.has(id)) {
        this.root.remove(o.obj)
        this.items.delete(id)
      }
  }

  /** a painted toy token, leaning back toward the camera, rocking gently above its shadow */
  private makeItem(kind: number): Item {
    const P = this.pieces!
    const obj = new THREE.Group()
    const shadow = new THREE.Mesh(P.flat(26, 26), P.roundShadowMat(0.45))
    shadow.position.y = 0.7
    shadow.renderOrder = 2
    shadow.userData.decal = true
    shadow.visible = P.kit.decals
    const glow = new THREE.Mesh(P.billboard(44, 44), P.glowSprite(PAINT.power[kind], 0.55, true))
    glow.renderOrder = 6
    const pivot = new THREE.Group()
    const coin = new THREE.Mesh(
      P.geo('coin', () => new THREE.CylinderGeometry(10, 10, 3.6, 32).rotateX(Math.PI / 2)),
      P.coin(kind),
    )
    coin.rotation.x = -0.5
    coin.castShadow = this.opts.shadows
    const face = new THREE.Group()
    face.rotation.x = FACE_CAMERA
    face.position.set(6, 7, 6)
    const kira = new THREE.Mesh(this.kiraQuad(), P.sparkle(1.4))
    kira.renderOrder = 7
    face.add(kira)
    pivot.add(coin, face)
    obj.add(shadow, glow, pivot)
    return { obj, pivot, glow, shadow, kira }
  }

  private syncExtras(w: World, tankRoots: Map<Tank, { root: THREE.Object3D }>) {
    const P = this.pieces!
    for (const t of w.tanks) {
      const x = t.ext
      if (!x) continue
      let e = this.extras.get(t)
      if (!e) {
        e = this.makeExtra()
        this.extras.set(t, e)
        this.root.add(e.group)
      }
      const alive = t.alive
      const obj = tankRoots.get(t)?.root
      e.group.visible = alive && !t.invisible
      e.group.position.set(t.pos.x, 0, t.pos.z)
      e.shield.visible = x.shield > 0
      if (x.shield > 0) e.shield.scale.setScalar(1 + Math.sin(this.frame * 0.12) * 0.025)
      const boss = x.maxHp > 1
      e.bar.visible = boss
      if (boss) {
        if (e.pips.length !== x.maxHp) this.makePips(e, x.maxHp)
        e.pips.forEach((m, i) => (m.material = P.pip(i < t.lives)))
      }
      e.fuse.visible = x.fuse > 0 && this.frame % (x.fuse > 15 ? 10 : 4) < (x.fuse > 15 ? 5 : 2)
      e.spark.rotation.z = this.frame * 0.3
      e.sight.visible = e.sightEnd.visible = !!x.laser
      if (x.laser) {
        const { x0, z0, x1, z1 } = x.laser
        const len = Math.hypot(x1 - x0, z1 - z0)
        e.sight.position.set((x0 + x1) / 2 - t.pos.x, 17.6, (z0 + z1) / 2 - t.pos.z)
        e.sight.rotation.y = Math.atan2(x1 - x0, z1 - z0)
        const k = x.charge ? 1 - x.charge.frames / 55 : 1
        e.sight.scale.set(0.4 + 1.1 * k, 1, Math.max(1, len))
        e.sightEnd.position.set(x1 - t.pos.x, 17.6, z1 - t.pos.z)
        e.sightEnd.scale.setScalar(0.3 + 0.3 * k)
      }
      // teleport warning / invulnerability flicker
      if (obj && alive && !t.invisible && ((x.warn > 0 && this.frame % 6 < 3) || (x.iframes > 0 && boss && this.frame % 4 < 2))) obj.visible = false
    }
    for (const [t, e] of this.extras)
      if (!w.tanks.includes(t) || !t.ext) {
        this.root.remove(e.group)
        this.extras.delete(t)
      }
  }

  private makeExtra(): TankExtra {
    const P = this.pieces!
    const group = new THREE.Group()
    const shield = new THREE.Mesh(P.sphere(26, 28), P.shield())
    shield.position.y = 14
    shield.renderOrder = 5
    // boss bar: a little wooden plank of red enamel pips, facing the camera
    const bar = new THREE.Group()
    bar.position.y = 60
    bar.rotation.x = FACE_CAMERA
    bar.add(new THREE.Mesh(P.box(48, 8, 4, 1.6), P.barWood()))
    // rammer fuse: a spitting spark over the hull
    const fuse = new THREE.Group()
    fuse.position.y = 34
    const fglow = new THREE.Mesh(P.billboard(30, 30), P.glowSprite('#ff7a20', 1.4))
    fglow.position.y = -15
    fglow.renderOrder = 7
    const face = new THREE.Group()
    face.rotation.x = FACE_CAMERA
    const spark = new THREE.Mesh(this.kiraQuad(), P.sparkle(1.4))
    spark.scale.setScalar(1.3)
    spark.renderOrder = 8
    face.add(spark)
    fuse.add(fglow, face)
    // sniper sight: a thin glowing ribbon with a dot where it lands
    const sight = new THREE.Group()
    const ribbon = new THREE.Mesh(this.ribbon(), P.beam('#ff3020', 0.9, 16))
    ribbon.scale.set(5, 1, 1)
    ribbon.renderOrder = 7
    sight.add(ribbon)
    const sightEnd = new THREE.Mesh(this.endGlow(), P.glowSprite('#ff3020', 1.2))
    sightEnd.renderOrder = 7
    group.add(shield, bar, fuse, sight, sightEnd)
    return { group, shield, bar, pips: [], fuse, spark, sight, sightEnd }
  }

  private makePips(e: TankExtra, n: number) {
    const P = this.pieces!
    for (const m of e.pips) e.bar.remove(m)
    const gap = 0.8
    const pw = +((44 - gap * (n - 1)) / n).toFixed(2)
    const g = P.box(pw, 5, 2.4, Math.min(1, pw / 3))
    e.pips = Array.from({ length: n }, (_, i) => {
      const m = new THREE.Mesh(g, P.pip(true))
      m.position.set(-22 + pw / 2 + i * (pw + gap), 0, 2.2)
      e.bar.add(m)
      return m
    })
  }

  private makeFog(w: World) {
    const at = vec2(positionWorld.x, positionWorld.z)
    const [a0, a1, a2, a3] = this.fogPlayers.map((u) => length(at.sub(u)))
    const d = min(min(a0, a1), min(a2, a3))
    const r = this.fogRadius
    const a = smoothstep(r.mul(0.7), r.mul(1.05), d).mul(0.84)
    const mat = new THREE.MeshBasicNodeMaterial()
    mat.colorNode = vec4(0.05, 0.04, 0.09, a)
    mat.transparent = true
    mat.depthWrite = false
    mat.depthTest = false
    const fog = new THREE.Mesh(new THREE.PlaneGeometry(w.field.width + 60, w.field.depth + 60).rotateX(-Math.PI / 2), mat)
    fog.position.y = 1.5
    fog.renderOrder = 10
    this.root.add(fog)
    return fog
  }
}
