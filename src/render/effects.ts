/**
 * Particle effects: a port of the NintendoWare nw4r::ef runtime (as linked into
 * Wii Play, decomp in build/decomp/src/nw4r/ef) driving basic_tank.breff
 * (public/assets/effects/basic_tank.json + textures, see docs/models.md "Effects").
 *
 * Usage
 * ```ts
 * const fx = new Effects(sceneView.root)    // adds its meshes under root
 * await fx.load()
 * // RPTnkTank::PlayShotEffect: the cannon matrix (emitter adds +20.3 Z = barrel tip)
 * fx.spawn('Tnk_shot', { pos, matrix: cannonWorldMatrix })
 * // RPTnkMine::Explode
 * fx.spawn('Tnk_mine_bomb', { pos, scale: 1.6 })
 * // RPTnkTank::SpawnBombPieceEffect: pieces tinted by the tank livery
 * fx.spawn('Tnk_bomb01_piece', { pos, scale: 1.6, color: TANK_PIECE_COLORS[modelIdx] })
 * fx.spawn('Tnk_bomb01', { pos, scale: 1.6 })
 * // shell trail (RPTnkShell): spawn once, then follow the shell every frame
 * const trail = fx.spawn('Tnk_shellsmoke01', { pos, matrix: shellMatrix })
 * trail.setMatrix(shellMatrix)          // each frame (shell matrix incl. its 1.5238 scale)
 * trail.stop()                          // shell gone: stop emitting, smoke fades out
 * // every 60 Hz game frame, after the game logic:
 * fx.update()
 * ```
 *
 * spawn() follows RPSysEffect::create + set* + update: the root matrix is `matrix`
 * (or a Y rotation `rotY`, or identity), its columns scaled by `scale`, and its
 * translation replaced by `pos`. `color` is RPSysEffect::setColor (an ambient
 * modifier multiplied into every particle colour of the managers alive at spawn).
 *
 * Rendering: one mesh per emitter resource (CPU-built quads in world space, a TSL
 * TEV material). The quads are built in onBeforeRender against the camera being
 * rendered, so billboards face whatever camera draws the scene (orthographic or not).
 */

import * as THREE from 'three/webgpu'
import { Effect, EffectSystem, LS_ACTIVE, type ParticleManager } from './effects/core'
import { Sink, VERT_FLOATS, drawPM } from './effects/draw'
import { makeMaterial } from './effects/material'
import * as M from './effects/mtx'
import { CMN_DISABLE_DRAW, DF_HIDDEN, parseEmitter, type EmitterRes } from './effects/res'

export interface Vec3Like {
  x: number
  y: number
  z: number
}

export interface SpawnOptions {
  pos?: Vec3Like
  /** radians, rotation around +Y (ignored when `matrix` is given) */
  rotY?: number
  /** root transform (RPSysEffect::setMtx); `pos` still overrides its translation */
  matrix?: THREE.Matrix4
  /** uniform scale (RPSysEffect::setScale) */
  scale?: number
  /** RPSysEffect::setColor tint (0-255 per channel) */
  color?: [number, number, number] | [number, number, number, number]
}

export interface EffectHandle {
  /** move the effect (RPSysEffect::setPos + update) */
  setPos(p: Vec3Like): void
  /** replace the root transform (RPSysEffect::setMtx + update) */
  setMatrix(m: THREE.Matrix4): void
  setScale(s: number): void
  /** RPSysEffect::setColor */
  setColor(r: number, g: number, b: number, a?: number): void
  /** RPSysEffect::setDisableDraw(!visible) */
  setVisible(v: boolean): void
  /** RPSysEffect::fade: stop emitting, live particles finish */
  stop(): void
  /** RPSysEffect::forceKill: remove everything now */
  kill(): void
  readonly alive: boolean
}

/** RPTnkTank sTnkPieceColors: Tnk_bomb01_piece tint per tank model index */
export const TANK_PIECE_COLORS: [number, number, number][] = [
  [0x5d, 0x98, 0xe0],
  [0xde, 0x5b, 0x44],
  [0xbd, 0x93, 0x41],
  [0x9e, 0x96, 0x87],
  [0x5e, 0xa6, 0xad],
  [0xdb, 0x64, 0x8d],
  [0xed, 0xe2, 0x23],
  [0xb5, 0x6a, 0xc4],
  [0x6b, 0xc4, 0x71],
  [0xff, 0xff, 0xe8],
  [0x63, 0x63, 0x63],
]

const toM34 = (m: THREE.Matrix4, out = M.m34()) => {
  const e = m.elements
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = e[c * 4 + r]
  return out
}

class Handle implements EffectHandle {
  private transform: M.M34 | null = null
  private pos: Vec3Like | null = null
  private scale: number | null = null

  constructor(private fx: Effect) {}

  /** RPSysEffect::update: root = transform, columns * scale, translation = pos */
  apply() {
    const m = this.transform ? M.copy(M.m34(), this.transform) : M.m34()
    if (this.scale !== null) {
      const s = this.scale
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 4 + c] *= s
    }
    if (this.pos) {
      m[3] = this.pos.x
      m[7] = this.pos.y
      m[11] = this.pos.z
    }
    this.fx.root.set(m)
  }
  init(o: SpawnOptions) {
    if (o.matrix) this.transform = toM34(o.matrix)
    else if (o.rotY) {
      const c = Math.cos(o.rotY), s = Math.sin(o.rotY)
      this.transform = M.m34()
      this.transform.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0])
    }
    if (o.scale !== undefined) this.scale = o.scale
    if (o.pos) this.pos = { x: o.pos.x, y: o.pos.y, z: o.pos.z }
    this.apply()
    if (o.color) this.setColor(o.color[0], o.color[1], o.color[2], o.color[3] ?? 255)
  }
  setPos(p: Vec3Like) {
    this.pos = { x: p.x, y: p.y, z: p.z }
    this.apply()
  }
  setMatrix(m: THREE.Matrix4) {
    this.transform = toM34(m, this.transform ?? M.m34())
    this.apply()
  }
  setScale(s: number) {
    this.scale = s
    this.apply()
  }
  setColor(r: number, g: number, b: number, a = 255) {
    this.fx.setColor(r, g, b, a)
  }
  setVisible(v: boolean) {
    this.fx.disableDraw = !v
  }
  stop() {
    this.fx.retireEmitterAll()
  }
  kill() {
    this.fx.retireEmitterAll()
    this.fx.retireParticleAll()
    this.fx.prune()
  }
  get alive() {
    return this.fx.emitters.length > 0 && this.fx.sys.effects.includes(this.fx)
  }
}

const DEAD: EffectHandle = {
  setPos() {},
  setMatrix() {},
  setScale() {},
  setColor() {},
  setVisible() {},
  stop() {},
  kill() {},
  alive: false,
}

interface Batch {
  res: EmitterRes
  mesh: THREE.Mesh
  sink: Sink
  buf: THREE.InterleavedBuffer | null
}

export class Effects {
  private group = new THREE.Group()
  private res = new Map<string, EmitterRes>()
  private textures = new Map<string, THREE.Texture>()
  private sys: EffectSystem | null = null
  private batches = new Map<string, Batch>()
  private order = new Map<string, number>()
  private frame = 0
  private builtFrame = -1
  private builtView = new THREE.Matrix4()

  constructor(root: THREE.Object3D, private base = 'assets/effects/') {
    this.group.name = 'effects'
    root.add(this.group)
  }

  async load() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await (await fetch(this.base + 'basic_tank.json')).json()
    for (const e of json.emitters) this.res.set(e.name, parseEmitter(e))
    const loader = new THREE.TextureLoader()
    await Promise.all(
      Object.entries(json.texture_files as Record<string, string>).map(async ([n, path]) => {
        // '#1_2' (only used by hidden root emitters) is not served by the vite dev server
        const t = await loader.loadAsync(this.base + path.split('/').map(encodeURIComponent).join('/')).catch(() => null)
        if (!t) return
        t.flipY = false // GX t = 0 is the first row
        t.colorSpace = THREE.NoColorSpace
        t.generateMipmaps = false
        t.minFilter = THREE.LinearFilter
        t.magFilter = THREE.LinearFilter
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping // wrap is done in the shader
        t.needsUpdate = true
        this.textures.set(n, t)
      }),
    )
    this.computeOrder()
    this.sys = new EffectSystem(this.res)
  }

  /** static draw order: weight of the child key, then creation order in the effect tree */
  private computeOrder() {
    const children = new Map<string, { name: string; weight: number }[]>()
    const isChild = new Set<string>()
    for (const r of this.res.values()) {
      const list: { name: string; weight: number }[] = []
      for (const t of r.ptclTracks)
        if (t.ctype === 'child') for (const k of t.keys) if (k.child && k.setting) list.push({ name: k.child, weight: k.setting.weight }), isChild.add(k.child)
      children.set(r.name, list)
    }
    let seq = 0
    const weight = new Map<string, number>()
    const visit = (name: string, w: number) => {
      if (weight.has(name)) return
      weight.set(name, w)
      this.order.set(name, seq++)
      for (const c of children.get(name) ?? []) visit(c.name, c.weight)
    }
    for (const r of this.res.values()) if (!isChild.has(r.name)) visit(r.name, 128)
    for (const r of this.res.values()) visit(r.name, 128)
    for (const [n, s] of this.order) this.order.set(n, 1000 + (weight.get(n) ?? 128) * 64 + s)
  }

  get loaded() {
    return this.sys !== null
  }

  spawn(name: string, opts: SpawnOptions = {}): EffectHandle {
    if (!this.sys) return DEAD
    const fx = this.sys.createEffect(name)
    if (!fx) {
      console.warn('effects: unknown effect', name)
      return DEAD
    }
    const h = new Handle(fx)
    h.init(opts)
    return h
  }

  /** one 60 Hz frame (EffectSystem::Calc) */
  update() {
    if (!this.sys) return
    this.sys.calc()
    this.frame++
    // vertex budget per batch (geometry can only be swapped outside the render call)
    const used = new Map<string, number>()
    for (const e of this.sys.effects) {
      if (e.disableDraw) continue
      for (const pm of e.pmList) {
        if (!this.drawable(pm) || !pm.particles.length) continue
        used.set(pm.res.name, (used.get(pm.res.name) ?? 0) + pm.particles.length * 12 + 12)
      }
    }
    for (const n of used.keys()) if (!this.batches.has(n)) this.makeBatch(this.res.get(n)!)
    for (const [n, b] of this.batches) {
      const need = used.get(n)
      b.mesh.visible = need !== undefined
      if (need === undefined) continue
      b.sink.reserve(need)
      if (!b.buf || b.buf.array !== b.sink.data) this.makeGeometry(b)
    }
  }

  /** remove every effect */
  clear() {
    if (!this.sys) return
    for (const e of this.sys.effects) {
      e.retireEmitterAll()
      e.retireParticleAll()
    }
    this.sys.effects = []
    this.sys.queue = []
    for (const b of this.batches.values()) b.mesh.visible = false
  }

  /** live particle count (debug) */
  get particleCount() {
    let n = 0
    for (const e of this.sys?.effects ?? []) for (const pm of e.pmList) n += pm.particles.filter((p) => p.status === LS_ACTIVE).length
    return n
  }

  private drawable(pm: ParticleManager) {
    return !(pm.res.drawFlags & DF_HIDDEN) && !(pm.em.comFlags & CMN_DISABLE_DRAW)
  }

  private makeBatch(res: EmitterRes) {
    const t1 = res.textures[0] ? (this.textures.get(res.textures[0]) ?? null) : null
    const t2 = res.textures[1] ? (this.textures.get(res.textures[1]) ?? null) : null
    const mat = makeMaterial(res, t1, t2)
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat)
    mesh.name = res.name
    mesh.frustumCulled = false
    mesh.renderOrder = this.order.get(res.name) ?? 1000
    mesh.matrixAutoUpdate = false
    const b: Batch = { res, mesh, sink: new Sink(256), buf: null }
    mesh.onBeforeRender = (_r, _s, camera) => this.build(camera)
    this.batches.set(res.name, b)
    this.group.add(mesh)
  }

  /** build every batch's vertices for this camera (once per update / camera move) */
  private build(camera: THREE.Camera) {
    if (!this.sys) return
    if (this.builtFrame === this.frame && this.builtView.equals(camera.matrixWorldInverse)) return
    this.builtFrame = this.frame
    this.builtView.copy(camera.matrixWorldInverse)
    const view = toM34(camera.matrixWorldInverse)
    const invView = toM34(camera.matrixWorld)
    // world space of the group (normally identity)
    this.group.updateWorldMatrix(true, false)
    const g = toM34(this.group.matrixWorld)
    const gInv = M.m34()
    M.inv(gInv, g)
    const viewG = M.mult(M.m34(), view, g)
    const invViewG = M.mult(M.m34(), gInv, invView)
    this.sys.viewMtx.set(viewG)
    for (const b of this.batches.values()) b.sink.reset()
    for (const e of this.sys.effects) {
      if (e.disableDraw) continue
      for (const pm of e.pmList) {
        if (!this.drawable(pm)) continue
        const b = this.batches.get(pm.res.name)
        if (!b) continue
        drawPM(pm, viewG, invViewG, b.sink)
      }
    }
    for (const b of this.batches.values()) this.upload(b)
  }

  private makeGeometry(b: Batch) {
    const buf = new THREE.InterleavedBuffer(b.sink.data, VERT_FLOATS)
    buf.setUsage(THREE.DynamicDrawUsage)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(buf, 3, 0))
    g.setAttribute('fxUv', new THREE.InterleavedBufferAttribute(buf, 4, 3))
    g.setAttribute('fxC0', new THREE.InterleavedBufferAttribute(buf, 4, 7))
    g.setAttribute('fxC1', new THREE.InterleavedBufferAttribute(buf, 4, 11))
    g.setAttribute('fxC2', new THREE.InterleavedBufferAttribute(buf, 4, 15))
    g.setAttribute('fxC3', new THREE.InterleavedBufferAttribute(buf, 4, 19))
    g.setAttribute('fxExt', new THREE.InterleavedBufferAttribute(buf, 4, 23))
    g.setDrawRange(0, 0)
    b.mesh.geometry.dispose()
    b.mesh.geometry = g
    b.buf = buf
  }

  private upload(b: Batch) {
    const g = b.mesh.geometry
    if (!b.buf || b.buf.array !== b.sink.data) {
      // outgrew the budget inside the render call: skip this frame, regrow on the next update
      g.setDrawRange(0, 0)
      return
    }
    b.buf.needsUpdate = true
    g.setDrawRange(0, b.sink.n)
  }
}
