// three.js (WebGPU renderer, WebGL2 fallback) view of a World, built from the
// converted ROM models. Observes the simulation; never mutates it.

import * as THREE from 'three/webgpu'
import { Cell, type SimEvent, type Tank, type World } from '../sim/world'
import { Effects, TANK_PIECE_COLORS, type EffectHandle } from './effects'
import { Models, type TankObj } from './models'

// RPTnkScene::CreateCamerasAndScreens: orthographic view of the 832x456 (16:9) or 608x456 (4:3)
// screen at scale 1.125, in world units. The Wii output is anamorphic, so the 16:9 view is
// stretched to the display aspect exactly as on the TV.
export const ORTHO = { halfW16_9: (832 * 1.125) / 2, halfW4_3: (608 * 1.125) / 2, halfH: (456 * 1.125) / 2 }

/** body/turret angle (atan2(z, x), 0 = +x) -> yaw of a +Z-facing model */
const yaw = (angle: number) => Math.PI / 2 - angle

/**
 * The floor's tread-mark capture (RPTnkField view 0 into "caterpillar"): white where
 * untouched, marks stamped as 30x30 quads. It covers the floor model's UV range
 * (840 x 665 for 16:9, 630 x 665 for 4:3; u along +x, v along +z).
 */
class TreadCanvas {
  canvas = document.createElement('canvas')
  ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  private marks: HTMLImageElement[] = []
  private dirty = false
  private w = 840
  private d = 665
  private static readonly PX = 2 // pixels per world unit

  constructor() {
    this.canvas.width = 840 * TreadCanvas.PX
    this.canvas.height = 665 * TreadCanvas.PX
    this.ctx = this.canvas.getContext('2d')!
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.NoColorSpace
    this.texture.flipY = false
    this.clear()
  }

  async load() {
    const names = ['1p', '2p', ...Array.from({ length: 9 }, (_, i) => `e_${i + 1}`)]
    this.marks = await Promise.all(
      names.map((n) => {
        const im = new Image()
        im.src = `assets/effects/tread_marks/tnk_mark_${n}.png`
        return im.decode().then(() => im)
      }),
    )
  }

  setSize(aspect: '16_9' | '4_3') {
    this.w = aspect === '16_9' ? 840 : 630
    const W = this.w * TreadCanvas.PX
    if (this.canvas.width !== W) {
      this.canvas.width = W
      this.texture.dispose()
      this.texture = new THREE.CanvasTexture(this.canvas)
      this.texture.colorSpace = THREE.NoColorSpace
      this.texture.flipY = false
    }
    this.clear()
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.fillStyle = '#fff'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.dirty = true
  }

  /** RPTnkTank::DrawTreadMark: quad y axis along the body forward */
  stamp(model: number, x: number, z: number, dirX: number, dirZ: number) {
    const im = this.marks[model]
    if (!im) return
    const P = TreadCanvas.PX
    const c = this.ctx
    c.setTransform(P, 0, 0, P, (x + this.w / 2) * P, (z + this.d / 2) * P)
    c.rotate(Math.atan2(dirZ, dirX) + Math.PI / 2)
    c.drawImage(im, -15, -15, 30, 30)
    this.dirty = true
  }

  flush() {
    if (this.dirty) this.texture.needsUpdate = true
    this.dirty = false
  }
}

export class SceneView {
  renderer: THREE.WebGPURenderer
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 100000)
  /** effects and other world-space extras are parented here */
  root = new THREE.Group()
  private stage = new THREE.Group()
  private tankObjs = new Map<Tank, TankObj>()
  private shellObjs = new Map<number, THREE.Object3D>()
  private mineObjs = new Map<number, THREE.Object3D>()
  private markObjs = new Map<number, THREE.Object3D>()
  private blockObjs = new Map<string, THREE.Object3D[]>()
  private blockGroup = new THREE.Group()
  private fieldObj: THREE.Object3D | null = null
  private tread = new TreadCanvas()
  private world: World | null = null
  fx: Effects
  /** 2D effect view (draw group 4): cursors, in screen units 832 x 456 */
  overlay = new THREE.Scene()
  overlayCam = new THREE.OrthographicCamera(-416, 416, 228, -228, -1000, 1000)
  cursorFx: Effects
  private cursors: { main: EffectHandle; tail: EffectHandle; line: EffectHandle }[] = []
  private trails = new Map<number, EffectHandle>()
  private stealthFx = new Map<Tank, EffectHandle>()
  aspect = 16 / 9
  private fieldAspect: '16_9' | '4_3' = '16_9'

  constructor(canvas: HTMLCanvasElement, public models: Models) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    // GX does no colour management: textures and output are raw values
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.scene.background = new THREE.Color(0, 0, 0)
    this.scene.add(this.root)
    this.root.add(this.stage)
    this.stage.add(this.blockGroup)
    this.fx = new Effects(this.root)
    this.cursorFx = new Effects(this.overlay)
    this.overlayCam.position.z = 100
  }

  async init() {
    await Promise.all([this.renderer.init(), this.tread.load(), this.fx.load(), this.cursorFx.load()])
    this.renderer.autoClear = false
    this.models.frameCamera(this.camera)
  }

  resize(w: number, h: number) {
    this.renderer.setSize(w, h, false)
    this.aspect = w / h
    const halfW = this.fieldAspect === '16_9' ? ORTHO.halfW16_9 : ORTHO.halfW4_3
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = ORTHO.halfH
    this.camera.bottom = -ORTHO.halfH
    this.camera.updateProjectionMatrix()
  }

  /** (re)build the static field and blocks for a stage load */
  setWorld(world: World) {
    this.world = world
    const aspect = world.width === 22 ? '16_9' : '4_3'
    if (!this.fieldObj || aspect !== this.fieldAspect) {
      this.fieldAspect = aspect
      this.tread.setSize(aspect)
      if (this.fieldObj) this.stage.remove(this.fieldObj)
      this.fieldObj = this.models.field(aspect, this.tread.texture)
      this.stage.add(this.fieldObj)
    }
    this.tread.clear()
    this.fx.clear()
    this.trails.clear()
    this.stealthFx.clear()
    for (const o of this.markObjs.values()) this.stage.remove(o)
    this.markObjs.clear()
    this.rebuildBlocks()
  }

  /** blocks + their shadows (RPTnkBlock::UpdateShadow runs every frame; rebuilt on change) */
  rebuildBlocks() {
    const w = this.world!
    this.blockGroup.clear()
    this.blockObjs.clear()
    const solid = (c: number, r: number) => {
      const g = w.grid[r]?.[c]
      return !!g && (g.kind === Cell.Block || g.kind === Cell.Cork)
    }
    for (let r = 0; r < w.height; r++)
      for (let c = 0; c < w.width; c++) {
        const g = w.grid[r][c]
        if (g.kind === Cell.Empty) continue
        const p = w.cellCenter(c, r)
        const objs: THREE.Object3D[] = []
        const blk = this.models.block(g.kind === Cell.Cork ? 0 : 1, g.kind === Cell.Hole ? 1 : g.height)
        blk.position.set(p.x, 0, p.z)
        objs.push(blk)
        if (g.kind !== Cell.Hole) {
          const sh = blockShadowFor(solid(c, r - 1), solid(c, r + 1), solid(c - 1, r), solid(c + 1, r))
          const s = this.models.blockShadow(sh.frame, sh.forward)
          s.position.set(p.x, 0, p.z)
          objs.push(s)
        }
        for (const o of objs) this.blockGroup.add(o)
        this.blockObjs.set(`${c},${r}`, objs)
      }
  }

  /** effects the original spawns at these events (RPSysEffect calls in RPTnk*.cpp) */
  onEvents(ev: SimEvent[]) {
    const fx = this.fx
    for (const e of ev) {
      switch (e.t) {
        case 'tread':
          this.tread.stamp(modelIndex(e.tank), e.pos.x, e.pos.z, e.dir.x, e.dir.z)
          break
        case 'blockBreak': {
          // RPTnkBlock::SpawnBreakEffect: one per 2 half-cells of height, 35 apart
          const p = this.world!.cellCenter(e.cx, e.cz)
          for (let i = 0, y = 0; i < e.height; i += 2, y += 35) fx.spawn('Tnk_blockbreak01', { pos: { x: p.x, y, z: p.z }, scale: 1 })
          this.rebuildBlocks()
          break
        }
        case 'shoot':
          // RPTnkTank::PlayShotEffect at the cannon matrix (only when a shell was fired)
          if (e.bullet) fx.spawn('Tnk_shot', { matrix: cannonMatrix(e.tank) })
          break
        case 'ricochet':
          fx.spawn('Tnk_shell_crash', { pos: e.pos, scale: 1.5238097 })
          break
        case 'bulletDie':
          if (e.reason === 'wall' || e.reason === 'early') fx.spawn('Tnk_shell_bomb', { pos: e.pos, scale: 1.5238097 })
          break
        case 'tankDie': {
          const t = e.tank
          const pos = { x: t.pos.x, y: t.pos.y, z: t.pos.z }
          fx.spawn('Tnk_bomb01_piece', { pos, scale: 1.6, color: TANK_PIECE_COLORS[modelIndex(t)] as [number, number, number] })
          fx.spawn('Tnk_bomb01', { pos, scale: 1.6 })
          break
        }
        case 'mineExplode':
          fx.spawn('Tnk_mine_bomb', { pos: { x: e.mine.pos.x, y: e.mine.pos.y, z: e.mine.pos.z }, scale: 1.6 })
          break
        case 'stealth':
          this.stealthFx.set(e.tank, fx.spawn('Tnk_stealth_change', { pos: e.tank.pos, scale: 1.6 }))
          break
      }
    }
  }

  /** one 60 Hz step of the effects: shell smoke follows the shells, then particles update */
  stepFx() {
    const w = this.world
    if (w) {
      const seen = new Set<number>()
      for (const b of w.bullets) {
        seen.add(b.id)
        const m = shellMatrix(b)
        let h = this.trails.get(b.id)
        if (!h) {
          h = this.fx.spawn(['Tnk_shellsmoke01', 'Tnk_shellsmoke02', 'Tnk_shellsmoke03', 'Tnk_shellsmoke03'][b.smokeType] ?? 'Tnk_shellsmoke01', { matrix: m })
          this.trails.set(b.id, h)
        } else h.setMatrix(m)
      }
      for (const [id, h] of this.trails)
        if (!seen.has(id)) {
          h.stop()
          this.trails.delete(id)
        }
      for (const [t, h] of this.stealthFx) h.setPos(t.pos)
    }
    this.fx.update()
  }

  sync() {
    const w = this.world
    if (!w) return
    this.tread.flush()
    const seen = new Set<Tank>()
    for (const t of w.tanks) {
      seen.add(t)
      let o = this.tankObjs.get(t)
      if (!o || o.root.userData.model !== modelIndex(t)) {
        if (o) this.stage.remove(o.root)
        o = this.models.tank(modelIndex(t))
        o.root.userData.model = modelIndex(t)
        this.tankObjs.set(t, o)
        this.stage.add(o.root)
      }
      o.root.visible = t.alive && !t.invisible
      this.models.poseTank(o, t.pos.x, t.pos.z, yaw(t.body), yaw(t.turret))
    }
    for (const [t, o] of this.tankObjs)
      if (!seen.has(t)) {
        this.stage.remove(o.root)
        this.tankObjs.delete(t)
      }
    syncSet(this.shellObjs, w.bullets, this.stage, () => this.models.shell(), (o, b) => {
      o.position.set(b.pos.x, b.pos.y, b.pos.z)
      o.rotation.y = Math.atan2(b.vel.x, b.vel.z)
    })
    syncSet(this.mineObjs, w.mines, this.stage, () => this.models.mine(), (o, m) => {
      o.position.set(m.pos.x, 0, m.pos.z)
      this.models.setMineFrame(o, m.fuseLit ? (o.userData.blink = (o.userData.blink ?? 0) + 1) : 0)
    })
    syncSet(this.markObjs, w.checkMarks, this.stage, (m) => this.models.checkMark(m.color), (o, m) => o.position.set(m.pos.x, 0.2, m.pos.z))
  }

  render() {
    this.renderer.clear()
    this.renderer.render(this.scene, this.camera)
    this.renderer.clearDepth()
    this.renderer.render(this.overlay, this.overlayCam)
  }

  /**
   * RPTnkCursor effects: main + tail at the cursor, line from the tank (mode 2) scaled by
   * distance / 100. Modes: 0 hidden, 1 main + tail, 2 + line, 3 main at alpha 128.
   */
  updateCursor(player: number, c: { x: number; y: number; mode: number; visible: boolean }, tank: { x: number; y: number } | null) {
    let h = this.cursors[player]
    if (!h) {
      const p = player ? '2p' : '1p'
      h = this.cursors[player] = {
        main: this.cursorFx.spawn(`Tnk_cursor_${p}_main`),
        tail: this.cursorFx.spawn(`Tnk_cursor_${p}_tail`),
        line: this.cursorFx.spawn(`Tnk_cursor_${p}_line`),
      }
    }
    const mode = c.visible ? c.mode : 0
    h.main.setVisible(mode !== 0)
    h.tail.setVisible(mode === 1 || mode === 2)
    h.line.setVisible(mode === 2 && !!tank)
    h.main.setColor(255, 255, 255, mode === 3 ? 128 : 255)
    const pos = { x: c.x, y: c.y, z: 0 }
    h.tail.setPos(pos)
    h.main.setPos(pos)
    if (tank) {
      const dx = c.x - tank.x
      const dy = c.y - tank.y
      const d = Math.hypot(dx, dy)
      const m = new THREE.Matrix4().makeRotationZ(d ? Math.atan2(dy, dx) : 0)
      m.scale(new THREE.Vector3(d / 100, d / 100, d / 100))
      m.setPosition(tank.x, tank.y, 0)
      h.line.setMatrix(m)
    }
  }

  stepCursorFx() {
    this.cursorFx.update()
  }

  /** world point -> layout units (832 x 456 centred, y up), like RPTnkCamera::ProjectToScreen */
  projectToLayout(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    return { x: (v.x * 832) / 2, y: (v.y * 456) / 2 }
  }
}

/** RPTnkTank::EditWorldMtx cannon matrix: T(pos + 17.6 up) * turretYaw * S(1.6) */
function cannonMatrix(t: Tank) {
  const m = new THREE.Matrix4().makeRotationY(yaw(t.turret))
  m.scale(new THREE.Vector3(1.6, 1.6, 1.6))
  m.setPosition(t.pos.x, t.pos.y + 17.6, t.pos.z)
  return m
}

/** RPTnkShell matrix: z along the velocity, y up, scale 1.5238 */
function shellMatrix(b: { pos: { x: number; y: number; z: number }; vel: { x: number; z: number } }) {
  const m = new THREE.Matrix4().makeRotationY(Math.atan2(b.vel.x, b.vel.z))
  m.scale(new THREE.Vector3(1.5238097, 1.5238097, 1.5238097))
  m.setPosition(b.pos.x, b.pos.y, b.pos.z)
  return m
}

/** model index: 0 = 1p, 1 = 2p, 2-10 = enemy type 1-9 */
function modelIndex(t: Tank) {
  return t.team === 2 ? 1 + t.type : t.team
}

/**
 * RPTnkBlock::UpdateShadow. Flags 0/2/4/6 are the shadow's corners; a solid block
 * above(-z)/below(+z)/left(-x)/right(+x) clears two of them. The count of cleared
 * corners picks the SRT0 frame, and the free side picks the quad orientation.
 */
function blockShadowFor(up: boolean, down: boolean, left: boolean, right: boolean) {
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
      // 0 cleared corners; a lone neighbour clears 2 (handled above), so only 0 lands here
      return { frame: 0, forward: fwd }
  }
}

function syncSet<T extends { id: number }>(
  map: Map<number, THREE.Object3D>,
  items: T[],
  parent: THREE.Object3D,
  make: (it: T) => THREE.Object3D,
  update: (o: THREE.Object3D, it: T) => void,
) {
  const seen = new Set<number>()
  for (const it of items) {
    seen.add(it.id)
    let o = map.get(it.id)
    if (!o) {
      o = make(it)
      map.set(it.id, o)
      parent.add(o)
    }
    update(o, it)
  }
  for (const [id, o] of map)
    if (!seen.has(id)) {
      parent.remove(o)
      map.delete(id)
    }
}
