// Tanks+ rendering: special tiles, power-ups, lasers, fog of war and the per-tank extras
// (shields, boss hit points, sniper sights, fuses, teleport flicker), plus the liveries of the
// added tank types. Procedural three.js meshes with TSL node materials. SceneView calls this
// through a handful of one-line hooks; it does nothing for worlds without `plus`.

import * as THREE from 'three/webgpu'
import { abs, atan, clamp, dot, float, fract, length, max, min, mix, normalView, normalWorld, positionWorld, sin, smoothstep, step, time, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import type { Plus } from '../sim/plus'
import { powerUpTypes } from '../sim/powerups'
import { tankMeta, tankTypes } from '../sim/stats'
import type { Tile } from '../sim/tiles'
import type { SimEvent, Tank, World } from '../sim/world'
import type { Effects } from './effects'
import { registerTankVisual } from './registry'

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
    registerTankVisual(t.id, { baseModel: l.base ?? 8, livery: t.colour, accent: l.accent ?? t.colour, scale: l.scale ?? 1, emissive: l.emissive ?? null })
  }

/** CSS colour of the explosion pieces of an added type */
export function pieceColour(type: number): [number, number, number] | null {
  const m = tankMeta(type)
  if (!m) return null
  const c = new THREE.Color(m.colour)
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)]
}

// ---- materials --------------------------------------------------------------------------

const CELL = 35
/** fake top light like the GX lit channel: ambient + N.y, a touch of front light */
const shade = () => clamp(max(normalWorld.y, 0).mul(0.45).add(0.55).add(normalWorld.z.mul(0.1)), 0, 1.1)
const col = (c: string) => uniform(new THREE.Color(c))

type ColorNode = NonNullable<THREE.MeshBasicNodeMaterial['colorNode']>

function basic(colorNode: ColorNode, opts: { transparent?: boolean; depthWrite?: boolean; blending?: THREE.Blending; side?: THREE.Side } = {}) {
  const m = new THREE.MeshBasicNodeMaterial()
  m.colorNode = colorNode
  m.transparent = !!opts.transparent
  m.depthWrite = opts.depthWrite ?? !opts.transparent
  if (opts.blending !== undefined) m.blending = opts.blending
  if (opts.side !== undefined) m.side = opts.side
  return m
}

const wpos = () => vec2(positionWorld.x, positionWorld.z).div(CELL)

function makeMaterials() {
  const ice = basic(
    vec4(
      mix(vec3(0.72, 0.88, 0.97), vec3(0.95, 0.99, 1), smoothstep(0.6, 1, sin(wpos().x.mul(2.1).add(wpos().y.mul(1.3))).mul(0.5).add(0.5))),
      float(0.82),
    ),
    { transparent: true },
  )
  const mudN = sin(wpos().x.mul(3.1)).mul(sin(wpos().y.mul(2.7))).add(sin(wpos().x.mul(1.3).add(wpos().y.mul(1.9))).mul(0.6))
  const mud = basic(vec4(mix(vec3(0.3, 0.2, 0.11), vec3(0.42, 0.29, 0.16), smoothstep(-0.4, 0.6, mudN)), float(0.95)), { transparent: true })
  const wave = sin(wpos().x.mul(2.2).add(time.mul(1.6))).mul(sin(wpos().y.mul(2.6).sub(time.mul(1.1))))
  const water = basic(vec4(mix(vec3(0.08, 0.3, 0.62), vec3(0.3, 0.62, 0.9), smoothstep(-0.2, 0.9, wave)), float(1)))
  const conveyor = [0, 1, 2, 3].map((d) => {
    const dir = [vec2(0, -1), vec2(1, 0), vec2(0, 1), vec2(-1, 0)][d]
    const across = vec2(dir.y, dir.x.negate())
    const a = dot(wpos(), dir)
    const q = fract(dot(wpos(), across))
    // arrows: one chevron per cell, scrolling with the belt; dark rubber, light rails
    const stripe = fract(a.sub(time.mul(0.9)).sub(abs(q.sub(0.5)).mul(1.1)))
    const chevron = step(0.66, stripe).mul(step(abs(q.sub(0.5)), 0.36))
    const rib = step(0.5, fract(a.mul(6).sub(time.mul(5.4)))).mul(0.04)
    const rail = step(0.4, abs(q.sub(0.5)))
    const rubber = vec3(0.13, 0.13, 0.14).add(rib)
    return basic(vec4(mix(mix(rubber, vec3(0.98, 0.78, 0.2), chevron), vec3(0.55, 0.56, 0.6), rail), float(1)))
  })
  // radial swirl for teleporters / wells: uv in [0, 1]^2
  const swirl = (c: string, speed: number, arms: number) => {
    const p = uv().sub(0.5).mul(2)
    const r = length(p)
    const a = atan(p.y, p.x)
    const s = sin(a.mul(arms).add(r.mul(9)).sub(time.mul(speed))).mul(0.5).add(0.5)
    const rgb = mix(col(c).mul(0.25), col(c), s.mul(float(1).sub(r.mul(0.5))))
    return basic(vec4(rgb.add(vec3(1, 1, 1).mul(smoothstep(0.82, 0.95, r).mul(0.6))), smoothstep(1, 0.92, r)), { transparent: true })
  }
  const stripes = (a: string, b: string) => {
    const s = step(0.5, fract(positionWorld.x.add(positionWorld.y).add(positionWorld.z).div(10)))
    return basic(vec4(mix(col(a), col(b), s).mul(shade()), float(1)))
  }
  const plankU = uv()
  const border = max(step(0.86, max(plankU.x, plankU.y)), step(max(plankU.x.oneMinus(), plankU.y.oneMinus()), 0.14))
  const cross = step(abs(plankU.x.sub(plankU.y)), 0.08).add(step(abs(plankU.x.add(plankU.y).sub(1)), 0.08)).min(1)
  const crate = basic(vec4(mix(vec3(0.72, 0.48, 0.24), vec3(0.45, 0.28, 0.12), max(border, cross)).mul(shade()), float(1)))
  // box faces: uv 0..1 per face, `edge` = 1 on a rim around each face
  const edge = (w: number) => max(step(1 - w, max(plankU.x, plankU.y)), step(max(plankU.x.oneMinus(), plankU.y.oneMinus()), w))
  const bumperPulse = uniform(0)
  const bumperBase = mix(vec3(0.95, 0.32, 0.58), vec3(1, 0.62, 0.8), edge(0.16))
  const bumper = basic(vec4(mix(bumperBase, vec3(1, 0.9, 0.97), bumperPulse).mul(shade()), float(1)))
  const fres = float(1).sub(abs(normalView.z))
  const glass = basic(vec4(mix(vec3(0.7, 0.93, 1), vec3(0.95, 1, 1), edge(0.08)).mul(shade()), fres.mul(0.4).add(0.18).add(edge(0.08).mul(0.5))), { transparent: true })
  const emitter = basic(vec4(vec3(0.22, 0.22, 0.25).mul(shade()), float(1)))
  const lens = basic(vec4(1, 0.15, 0.1, 1))
  const shield = basic(vec4(vec3(0.5, 1, 0.85), fres.mul(fres).mul(0.75).add(0.08)), { transparent: true, blending: THREE.AdditiveBlending })
  return {
    ice,
    mud,
    water,
    conveyor,
    teleport: ['#38c8ff', '#ff8a2a', '#9cff3a', '#ff4ad0'].map((c) => swirl(c, 3, 3)),
    well: swirl('#7a40ff', -4, 2),
    gate: stripes('#e8b820', '#202020'),
    gateOpen: basic(vec4(mix(vec3(0.25, 0.2, 0.05), vec3(0.12, 0.12, 0.12), step(0.5, fract(positionWorld.x.add(positionWorld.z).div(10)))), float(1))),
    crate,
    bumper,
    bumperPulse,
    glass,
    emitter,
    lens,
    shield,
    dark: basic(vec4(0.15, 0.15, 0.16, 1)),
    switchOn: basic(vec4(vec3(1, 0.82, 0.2).mul(shade()), float(1))),
    switchOff: basic(vec4(vec3(1, 0.5, 0.15).mul(shade()), float(1))),
  }
}
type Mats = ReturnType<typeof makeMaterials>

const flat = (w: number, d: number) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2)

const POWERUP_GEOMS = [
  () => new THREE.OctahedronGeometry(9),
  () => new THREE.TorusGeometry(7, 2.6, 8, 20),
  () => new THREE.IcosahedronGeometry(8.5),
  () => new THREE.ConeGeometry(7, 15, 3).rotateZ(-Math.PI / 2),
  () => new THREE.CylinderGeometry(8, 8, 5, 16),
  () => new THREE.ConeGeometry(5, 18, 8).rotateZ(-Math.PI / 2),
]

type TankExtra = { group: THREE.Group; shield: THREE.Mesh; hpBg: THREE.Mesh; hpFill: THREE.Mesh; fuse: THREE.Mesh; sight: THREE.Mesh }

export class TilesView {
  private root = new THREE.Group()
  private statics = new THREE.Group()
  private items = new Map<number, THREE.Object3D>()
  private beams = new Map<number, THREE.Mesh>()
  private extras = new Map<Tank, TankExtra>()
  private mats: Mats | null = null
  private world: World | null = null
  private version = -1
  private fog: THREE.Mesh | null = null
  private fogPlayers = [0, 1, 2, 3].map(() => uniform(new THREE.Vector2(1e5, 1e5)))
  private fogRadius = uniform(150)
  private frame = 0
  private pulse = 0

  constructor(
    parent: THREE.Object3D,
    private fx: Effects,
  ) {
    parent.add(this.root)
    this.root.add(this.statics)
  }

  private get m() {
    return (this.mats ??= makeMaterials())
  }

  setWorld(w: World) {
    this.world = w
    this.version = -1
    for (const o of this.items.values()) this.root.remove(o)
    this.items.clear()
    for (const b of this.beams.values()) this.root.remove(b)
    this.beams.clear()
    for (const e of this.extras.values()) this.root.remove(e.group)
    this.extras.clear()
    if (this.fog) this.root.remove(this.fog)
    this.fog = null
    this.statics.clear()
  }

  /** the grid cells drawn here instead of by Models.block (tile cells) */
  ownsCell(code: number) {
    return code >= 500 && code <= 599
  }

  private rebuild(p: Plus) {
    this.statics.clear()
    const m = this.m
    for (const t of p.tiles.list) this.statics.add(this.tileMesh(t, m))
  }

  private tileMesh(t: Tile, m: Mats): THREE.Object3D {
    const g = new THREE.Group()
    g.position.set(t.x, 0, t.z)
    const code = t.code
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y = 0, order = 0) => {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.y = y
      mesh.renderOrder = order
      g.add(mesh)
      return mesh
    }
    if (code >= 500 && code <= 503) {
      add(flat(32, 32), m.teleport[code - 500], 0.6, 2)
    } else if (code >= 510 && code <= 513) add(flat(CELL, CELL), m.conveyor[code - 510], 0.4)
    else if (code === 520) add(flat(CELL, CELL), m.ice, 0.4, 1)
    else if (code === 521) add(flat(CELL, CELL), m.mud, 0.4, 1)
    else if (code === 550) add(flat(CELL, CELL), m.water, 0.5)
    else if (code === 530) {
      if (t.block) add(new THREE.BoxGeometry(33, 32, 33), m.bumper, 16)
    } else if (code === 531) {
      if (t.block) add(new THREE.BoxGeometry(34, 34, 34), m.glass, 17, 3)
    } else if (code === 532) {
      if (t.block) add(new THREE.BoxGeometry(31, 31, 31), m.crate, 15.5)
    } else if (code === 541 || code === 542) {
      if (t.block) add(new THREE.BoxGeometry(CELL, 34, CELL), m.gate, 17)
      else add(flat(CELL, CELL), m.gateOpen, 0.4)
    } else if (code === 540) {
      add(new THREE.BoxGeometry(28, 2, 28), m.dark, 1)
      add(new THREE.CylinderGeometry(9, 10, t.open ? 2 : 5, 20), t.open ? m.switchOff : m.switchOn, t.open ? 3 : 4.5)
    } else if (code >= 560 && code <= 567) {
      if (t.block) {
        add(new THREE.BoxGeometry(CELL, 26, CELL), m.emitter, 13)
        const d = [
          [0, -1],
          [1, 0],
          [0, 1],
          [-1, 0],
        ][(code - 560) % 4]
        const lens = add(new THREE.BoxGeometry(d[0] ? 4 : 12, 8, d[1] ? 4 : 12), m.lens, 13)
        lens.position.x = d[0] * 17.5
        lens.position.z = d[1] * 17.5
      }
    } else if (code === 570) {
      add(flat(44, 44), m.well, 0.7, 2)
    } else if (code >= 580 && code <= 585) {
      const c = powerUpTypes()[code - 580].colour
      add(new THREE.RingGeometry(12, 15, 24).rotateX(-Math.PI / 2), basic(vec4(col(c), float(0.9)), { transparent: true }), 0.6, 2)
    }
    return g
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
        case 'bumper':
          this.pulse = 1
          break
      }
    }
  }

  /** per rendered frame, after SceneView.sync posed the tanks */
  sync(tankRoots: Map<Tank, { root: THREE.Object3D }>) {
    const w = this.world
    const p = w?.plus
    if (!w || !p) return
    this.frame++
    const m = this.m
    if (p.tiles.version !== this.version) {
      this.version = p.tiles.version
      this.rebuild(p)
    }
    this.pulse *= 0.9
    m.bumperPulse.value = this.pulse
    // lasers
    for (const t of p.tiles.list) {
      if (t.code < 560 || t.code > 567) continue
      let b = this.beams.get(t.index)
      if (!b) {
        // white-hot core inside a red glow
        b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), basic(vec4(1, 0.12, 0.08, 0.55), { transparent: true }))
        const core = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 1), basic(vec4(1, 0.85, 0.8, 1)))
        b.add(core)
        b.renderOrder = 4
        this.root.add(b)
        this.beams.set(t.index, b)
      }
      const on = t.beam && (t.laser === 2 || (t.laser === 1 && this.frame % 8 < 4))
      b.visible = !!on
      if (on && t.beam) {
        const { x0, z0, x1, z1 } = t.beam
        const len = Math.hypot(x1 - x0, z1 - z0)
        const width = t.laser === 2 ? 6 + Math.sin(this.frame * 0.6) : 2
        b.position.set((x0 + x1) / 2, 13, (z0 + z1) / 2)
        b.rotation.y = Math.atan2(x1 - x0, z1 - z0)
        b.scale.set(width, t.laser === 2 ? 6 : 2, Math.max(1, len))
      }
    }
    // power-ups
    const seen = new Set<number>()
    for (const it of p.powerups.items) {
      seen.add(it.id)
      let o = this.items.get(it.id)
      if (!o) {
        o = this.makeItem(it.kind)
        this.items.set(it.id, o)
        this.root.add(o)
      }
      o.position.set(it.pos.x, 16 + Math.sin((it.age + it.id * 13) * 0.08) * 3, it.pos.z)
      o.rotation.y = it.age * 0.05
      o.visible = !(it.life > 0 && it.life < 180 && it.life % 12 < 6)
    }
    for (const [id, o] of this.items)
      if (!seen.has(id)) {
        this.root.remove(o)
        this.items.delete(id)
      }
    // per-tank extras
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
      const boss = x.maxHp > 1
      e.hpBg.visible = e.hpFill.visible = boss
      if (boss) {
        const f = Math.max(0, t.lives / x.maxHp)
        e.hpFill.scale.x = Math.max(0.001, f)
        e.hpFill.position.x = -20 * (1 - f)
      }
      e.fuse.visible = x.fuse > 0 && this.frame % (x.fuse > 15 ? 10 : 4) < (x.fuse > 15 ? 5 : 2)
      e.sight.visible = !!x.laser
      if (x.laser) {
        const { x0, z0, x1, z1 } = x.laser
        const len = Math.hypot(x1 - x0, z1 - z0)
        e.sight.position.set((x0 + x1) / 2 - t.pos.x, 17.6, (z0 + z1) / 2 - t.pos.z)
        e.sight.rotation.y = Math.atan2(x1 - x0, z1 - z0)
        const k = x.charge ? 1 - x.charge.frames / 55 : 1
        e.sight.scale.set(0.8 + 2.2 * k, 0.8 + 2.2 * k, Math.max(1, len))
      }
      // teleport warning / invulnerability flicker
      if (obj && alive && !t.invisible && ((x.warn > 0 && this.frame % 6 < 3) || (x.iframes > 0 && boss && this.frame % 4 < 2))) obj.visible = false
    }
    for (const [t, e] of this.extras)
      if (!w.tanks.includes(t) || !t.ext) {
        this.root.remove(e.group)
        this.extras.delete(t)
      }
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

  private makeItem(kind: number) {
    const g = new THREE.Group()
    const c = powerUpTypes()[kind].colour
    const body = new THREE.Mesh(POWERUP_GEOMS[kind](), basic(vec4(col(c).mul(shade()).add(0.15), float(1))))
    g.add(body)
    const halo = new THREE.Mesh(new THREE.SphereGeometry(13, 16, 12), basic(vec4(col(c), float(1).sub(abs(normalView.z)).mul(0.6)), { transparent: true, blending: THREE.AdditiveBlending }))
    g.add(halo)
    return g
  }

  private makeExtra(): TankExtra {
    const m = this.m
    const group = new THREE.Group()
    const shield = new THREE.Mesh(new THREE.SphereGeometry(26, 20, 14), m.shield)
    shield.position.y = 14
    shield.renderOrder = 5
    const hpBg = new THREE.Mesh(new THREE.BoxGeometry(42, 4, 4), basic(vec4(0.1, 0.1, 0.1, 1)))
    hpBg.position.set(0, 58, 0)
    const hpFill = new THREE.Mesh(new THREE.BoxGeometry(40, 4.6, 4.6), basic(vec4(0.95, 0.25, 0.2, 1)))
    hpFill.position.set(0, 58, 0)
    const fuse = new THREE.Mesh(new THREE.SphereGeometry(7, 12, 8), basic(vec4(1, 0.15, 0.1, 1)))
    fuse.position.y = 36
    const sight = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), basic(vec4(1, 0.1, 0.1, 0.8), { transparent: true, blending: THREE.AdditiveBlending }))
    sight.renderOrder = 4
    group.add(shield, hpBg, hpFill, fuse, sight)
    return { group, shield, hpBg, hpFill, fuse, sight }
  }

  private makeFog(w: World) {
    const at = vec2(positionWorld.x, positionWorld.z)
    const [a0, a1, a2, a3] = this.fogPlayers.map((u) => length(at.sub(u)))
    const d = min(min(a0, a1), min(a2, a3))
    const r = this.fogRadius
    const a = smoothstep(r.mul(0.7), r.mul(1.05), d).mul(0.86)
    const mat = basic(vec4(0.02, 0.03, 0.07, a), { transparent: true })
    mat.depthTest = false
    const fog = new THREE.Mesh(flat(w.field.width + 60, w.field.depth + 60), mat)
    fog.position.y = 1.5
    fog.renderOrder = 10
    this.root.add(fog)
    return fog
  }
}
