// three.js (WebGPU renderer, WebGL2 fallback) view of a World, built from the
// converted ROM models. Observes the simulation; never mutates it.
//
// Quality: `setQuality('classic' | 'high' | 'ultra', overrides?)` (quality.ts). Classic is the
// GX-faithful port; nothing is persisted here. Extension points for new tank types and
// special floor tiles live in registry.ts.

import * as THREE from 'three/webgpu'
import { Cell, type SimEvent, type Tank, type World } from '../sim/world'
import { Effects, TANK_PIECE_COLORS, type EffectHandle } from './effects'
import { Models, type TankLook, type TankObj } from './models'
import { QUALITY_PRESETS, type Quality, type RenderOptions } from './quality'
import { defaultTankVisual, registryVersion, tankVisual, tileFactory, type BaseModel, type TileResult } from './registry'
import { TilesView } from './tiles'
import { TreadCapture } from './tread'

// RPTnkScene::CreateCamerasAndScreens: orthographic view of the 832x456 (16:9) or 608x456 (4:3)
// screen at scale 1.125, in world units. The Wii output is anamorphic, so the 16:9 view is
// stretched to the display aspect exactly as on the TV.
export const ORTHO = { halfW16_9: (832 * 1.125) / 2, halfW4_3: (608 * 1.125) / 2, halfH: (456 * 1.125) / 2 }
/**
 * Filling a window of any shape (`resize(w, h, true)`): world units that always stay in view —
 * the field plus a bit of its border model (the full original height, so the HUD band fits) —
 * with square pixels; the long axis shows more of the surroundings instead of letterboxing.
 */
export const ORTHO_FIT = { w16_9: 900, w4_3: 660, h: 456 * 1.125 }

/** body/turret angle (atan2(z, x), 0 = +x) -> yaw of a +Z-facing model */
const yaw = (angle: number) => Math.PI / 2 - angle

/** players 3 and 4: the 1p model recoloured (livery, X mark, cursor, debris) */
export const PLAYER_COLORS = { p3: 0x34a34a, p4: 0xe8901c }
const P34_PIECES: [number, number, number][] = [
  [0x6b, 0xd0, 0x5a],
  [0xf3, 0xa6, 0x3a],
]

/** resolved look of one tank: model/livery, tread mark, debris tint */
type Look = { look: TankLook; tread: string; piece: [number, number, number] }

const rgb = (c: number | string): [number, number, number] => {
  const k = new THREE.Color(c as THREE.ColorRepresentation)
  return [Math.round(k.r * 255), Math.round(k.g * 255), Math.round(k.b * 255)]
}

/**
 * Enhanced lighting (ultra): hemisphere fill + one key light from the upper left, behind the
 * field, so shadows fall down-screen like the disc's decal shadows read. Calibrated so an
 * unshadowed up-facing surface gets exactly 1.0 (the GX top-face value): the floor looks the
 * same as classic outside the shadows, and vertical faces stay near GX's 0.39.
 */
const KEY_DIR = new THREE.Vector3(-0.3, 1, -0.35).normalize()
const SKY = 0.55
const GROUND = 0.2
const KEY = (1 - SKY) / KEY_DIR.y

export class SceneView {
  renderer: THREE.WebGPURenderer
  scene = new THREE.Scene()
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 10, 100000)
  /** first-person view (not in the original): a perspective camera on a player's turret */
  fpvCam = new THREE.PerspectiveCamera(75, 16 / 9, 1, 5000)
  /** player index carrying the camera and the view heading (atan2(z, x)); null = the fixed camera */
  fpv: { player: number; yaw: number; pitch: number } | null = null
  private fpvPos = new THREE.Vector3()
  private fpvReady = false
  /** effects and other world-space extras are parented here */
  root = new THREE.Group()
  private stage = new THREE.Group()
  private tankObjs = new Map<Tank, TankObj>()
  private shellObjs = new Map<number, THREE.Object3D>()
  private mineObjs = new Map<number, THREE.Object3D>()
  private markObjs = new Map<number, THREE.Object3D>()
  private blockGroup = new THREE.Group()
  private tileUpdates: ((frame: number) => void)[] = []
  private tileDisposers: (() => void)[] = []
  private fieldObj: THREE.Object3D | null = null
  private tread = new TreadCapture(2)
  private world: World | null = null
  fx: Effects
  /** [tanks+] special tiles, power-ups and tank extras */
  private tiles: TilesView
  /** 2D effect view (draw group 4): cursors, in screen units 832 x 456 */
  overlay = new THREE.Scene()
  overlayCam = new THREE.OrthographicCamera(-416, 416, 228, -228, -1000, 1000)
  cursorFx: Effects
  private cursors: { main: EffectHandle; tail: EffectHandle; line: EffectHandle }[] = []
  private trails = new Map<number, EffectHandle>()
  private stealthFx = new Map<Tank, EffectHandle>()
  aspect = 16 / 9
  private fieldAspect: '16_9' | '4_3' = '16_9'
  private quality: Quality = 'classic'
  private options: RenderOptions = QUALITY_PRESETS.classic
  private qualityJob: Promise<void> = Promise.resolve()
  private hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0)
  private key = new THREE.DirectionalLight(0xffffff, 0)
  private lookCache = new Map<string, Look>()
  private lookVersion = -1
  private frame = 0

  constructor(canvas: HTMLCanvasElement, public models: Models) {
    // MSAA 4x in every quality (the sample count is fixed at creation)
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: new URLSearchParams(location.search).has('webgl') })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    // GX does no colour management: textures and output are raw values
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.scene.background = new THREE.Color(0, 0, 0)
    this.scene.add(this.root)
    this.root.add(this.stage)
    this.stage.add(this.blockGroup)
    this.setupLights()
    this.fx = new Effects(this.root)
    this.tiles = new TilesView(this.stage, this.fx)
    this.cursorFx = new Effects(this.overlay)
    this.overlayCam.position.z = 100
    this.watchPixelRatio()
  }

  async init() {
    await Promise.all([this.renderer.init(), this.tread.load(null), this.fx.load(), this.cursorFx.load()])
    this.renderer.autoClear = false
    this.models.frameCamera(this.camera)
    this.deriveCursors()
    // dev/testing: ?quality=classic|high|ultra (the settings menu calls setQuality itself)
    const q = new URLSearchParams(location.search).get('quality')
    if (q === 'classic' || q === 'high' || q === 'ultra') void this.setQuality(q)
  }

  /**
   * Layout space (origin centre, y up): half extents of the view. 416 x 228 for the original
   * 16:9 picture; when filling the window, the 608 x 456 safe area fits and the rest extends.
   */
  layoutHalf = { x: 416, y: 228 }

  /** `fill`: square pixels at any aspect (ORTHO_FIT stays visible), else the anamorphic 16:9 TV view */
  resize(w: number, h: number, fill = false) {
    this.renderer.setSize(w, h, false)
    this.aspect = w / h
    this.fpvCam.aspect = w / h
    this.fpvCam.updateProjectionMatrix()
    let halfW = this.fieldAspect === '16_9' ? ORTHO.halfW16_9 : ORTHO.halfW4_3
    let halfH = ORTHO.halfH
    if (fill && w > 0 && h > 0) {
      const k = Math.max((this.fieldAspect === '16_9' ? ORTHO_FIT.w16_9 : ORTHO_FIT.w4_3) / w, ORTHO_FIT.h / h)
      halfW = (w * k) / 2
      halfH = (h * k) / 2
    }
    this.camera.left = -halfW
    this.camera.right = halfW
    this.camera.top = halfH
    this.camera.bottom = -halfH
    this.camera.updateProjectionMatrix()
    // the 2D layouts scale with the short side: their 4:3 safe area (608 x 456) always fits
    const k = Math.min(w / 608, h / 456)
    this.layoutHalf = fill && k > 0 ? { x: w / k / 2, y: h / k / 2 } : { x: 416, y: 228 }
    const o = this.overlayCam
    o.left = -this.layoutHalf.x
    o.right = this.layoutHalf.x
    o.top = this.layoutHalf.y
    o.bottom = -this.layoutHalf.y
    o.updateProjectionMatrix()
  }

  // ---- quality ------------------------------------------------------------------------------

  /**
   * Switch render quality. `overrides` tweaks single options of the preset (e.g.
   * `{ shadows: false }` on ultra). Resolves when the hi-res textures are loaded and the scene
   * is rebuilt; calls are serialised, the last one wins. Never persists anything.
   */
  setQuality(q: Quality, overrides: Partial<RenderOptions> = {}): Promise<void> {
    const opts: RenderOptions = { ...QUALITY_PRESETS[q], ...overrides }
    if (opts.lighting === 'gx') opts.shadows = false
    this.qualityJob = this.qualityJob.then(() => this.applyQuality(q, opts)).catch((e) => console.error('setQuality', e))
    return this.qualityJob
  }

  getQuality(): Quality {
    return this.quality
  }

  /** the effective options of the current quality (preset + overrides) */
  get renderOptions(): Readonly<RenderOptions> {
    return this.options
  }

  private async applyQuality(q: Quality, opts: RenderOptions) {
    const m = this.models
    await m.setOptions(opts)
    // effect sprites and tread marks
    const fxOverrides = new Map<string, THREE.Texture>()
    if (opts.hires && m.hires.available) {
      const names = ['pc_box_glow1', 'pc_box_hit06', 'pc_clr_kira01', 'pc_clr_stardust01', 'pc_gen_ball1', 'pc_gen_glow1', 'pc_gen_glow2', 'pc_gen_glow3', 'pc_gen_grad_v1', 'pc_gen_orilight2_i', 'pc_gen_particle1', 'pc_gen_smokesmpl1', 'pc_sht_cursor1', 'pc_sht_cursor2', 'pc_sht_hahen1', 'pc_tnk_rock03', 'pc_tnk_smoke3', 'pc_tnk_smokeami01', 'pc_tnk_smoketail03']
      await Promise.all(
        names.map(async (n) => {
          const t = await m.hires.get(`fx/${n}`)
          if (!t) return
          // wrap is emulated in the effect shader: clamp, and no mips across the mirror seams
          const c = t.clone()
          c.generateMipmaps = false
          c.minFilter = THREE.LinearFilter
          c.wrapS = c.wrapT = THREE.ClampToEdgeWrapping
          c.anisotropy = 1
          c.needsUpdate = true
          fxOverrides.set(n, c)
        }),
      )
    }
    this.fx.setTextureOverrides(fxOverrides)
    this.cursorFx.setTextureOverrides(fxOverrides)
    await this.tread.load(opts.hires ? m.hires : null)
    this.tread.setResolution(opts.treadPx)
    m.setTreadTexture(this.tread.texture)
    // [tanks+] tile pieces for the new textures / lighting
    await this.tiles.setOptions(opts, m.hires)
    this.quality = q
    this.options = opts
    this.applyLights()
    this.applyPixelRatio()
    // rebuild everything that holds materials
    m.applyTo(this.stage)
    for (const o of this.tankObjs.values()) this.stage.remove(o.root)
    this.tankObjs.clear()
    for (const o of this.markObjs.values()) this.stage.remove(o)
    this.markObjs.clear()
    if (this.world) this.rebuildBlocks()
  }

  private setupLights() {
    this.hemi.position.set(0, 1, 0)
    this.key.position.copy(KEY_DIR).multiplyScalar(2000)
    this.key.target.position.set(0, 0, 0)
    // covers the field and its border from the key light's direction
    const c = this.key.shadow.camera
    c.left = -1000
    c.right = 1000
    c.top = 800
    c.bottom = -800
    c.near = 100
    c.far = 4000
    this.key.shadow.bias = -0.0008
    this.key.shadow.normalBias = 0.6
    this.key.shadow.radius = 4
    this.scene.add(this.hemi, this.key, this.key.target)
    this.applyLights()
  }

  private applyLights() {
    const on = this.options.lighting === 'enhanced'
    // three's Lambert/Phong divide irradiance by PI
    this.hemi.color.setScalar(SKY)
    this.hemi.groundColor.setScalar(GROUND)
    this.hemi.intensity = on ? Math.PI : 0
    this.key.intensity = on ? KEY * Math.PI : 0
    this.hemi.visible = this.key.visible = on
    const shadows = on && this.options.shadows
    this.renderer.shadowMap.enabled = shadows
    this.key.castShadow = shadows
    if (shadows && this.key.shadow.mapSize.x !== this.options.shadowMapSize) {
      this.key.shadow.mapSize.set(this.options.shadowMapSize, this.options.shadowMapSize)
      this.key.shadow.map?.dispose()
      this.key.shadow.map = null
    }
  }

  private applyPixelRatio() {
    const o = this.options
    this.renderer.setPixelRatio(Math.min(devicePixelRatio * o.pixelRatioScale, o.maxPixelRatio))
  }

  /** browser zoom / moving the window to another monitor changes devicePixelRatio */
  private watchPixelRatio() {
    if (typeof matchMedia !== 'function') return
    const watch = () => {
      const mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
      mq.addEventListener(
        'change',
        () => {
          this.applyPixelRatio()
          watch()
        },
        { once: true },
      )
    }
    watch()
  }

  // ---- players 3/4 and registered types -----------------------------------------------------

  /** Tnk_cursor_3p/4p_*: the 1p/2p cursor emitters recoloured */
  private deriveCursors() {
    const tint = (hex: number) => {
      const c = new THREE.Color(hex)
      const hsl = { h: 0, s: 0, l: 0 }
      c.getHSL(hsl)
      return ([r, g, b, a]: [number, number, number, number]): [number, number, number, number] => {
        // keep each colour's lightness and saturation, take the player's hue
        const k = new THREE.Color(r / 255, g / 255, b / 255)
        const h2 = { h: 0, s: 0, l: 0 }
        k.getHSL(h2)
        if (h2.s < 0.05) return [r, g, b, a]
        k.setHSL(hsl.h, h2.s, h2.l)
        return [Math.round(k.r * 255), Math.round(k.g * 255), Math.round(k.b * 255), a]
      }
    }
    for (const fx of [this.cursorFx])
      for (const part of ['main', 'tail', 'line']) {
        fx.derive(`Tnk_cursor_1p_${part}`, `Tnk_cursor_3p_${part}`, tint(PLAYER_COLORS.p3))
        fx.derive(`Tnk_cursor_2p_${part}`, `Tnk_cursor_4p_${part}`, tint(PLAYER_COLORS.p4))
      }
  }

  /** model, livery, tread mark and debris colour of a tank (registry.ts for new types) */
  private lookOf(t: Tank): Look {
    if (this.lookVersion !== registryVersion()) {
      this.lookCache.clear()
      this.lookVersion = registryVersion()
    }
    const id = t.isEnemy ? `e${t.type}` : `p${t.team}`
    let l = this.lookCache.get(id)
    if (l) return l
    if (!t.isEnemy) {
      const p = Math.max(0, Math.min(3, t.team))
      l =
        p < 2
          ? { look: { key: `p${p}`, base: p ? '2p' : '1p' }, tread: p ? '2p' : '1p', piece: TANK_PIECE_COLORS[p] }
          : { look: { key: `p${p}`, base: '1p', livery: p === 2 ? PLAYER_COLORS.p3 : PLAYER_COLORS.p4 }, tread: p === 2 ? 'p3' : 'p4', piece: P34_PIECES[p - 2] }
    } else {
      const reg = tankVisual(t.type)
      if (!reg && t.type >= 1 && t.type <= 9) {
        const base = `e_${t.type}` as BaseModel
        l = { look: { key: base, base }, tread: base, piece: TANK_PIECE_COLORS[1 + t.type] }
      } else {
        const v = reg ?? defaultTankVisual(t.type)
        const baseIdx = v.baseModel === '1p' ? 0 : v.baseModel === '2p' ? 1 : 1 + Number(v.baseModel.slice(2))
        const liveryColor = typeof v.livery === 'number' || /^#|^0x/i.test(v.livery) ? v.livery : null
        l = {
          look: { key: `t${t.type}:${registryVersion()}`, base: v.baseModel, livery: v.livery, accent: v.accent, scale: v.scale, emissive: v.emissive, emissiveIntensity: v.emissiveIntensity },
          tread: v.tread ?? v.baseModel,
          piece: v.pieceColor !== undefined ? rgb(v.pieceColor) : liveryColor !== null ? rgb(liveryColor) : TANK_PIECE_COLORS[baseIdx],
        }
      }
    }
    this.lookCache.set(id, l)
    return l
  }

  // ---- stage --------------------------------------------------------------------------------

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
    this.models.setTreadTexture(this.tread.texture)
    this.tread.clear()
    this.fx.clear()
    this.trails.clear()
    this.stealthFx.clear()
    for (const o of this.markObjs.values()) this.stage.remove(o)
    this.markObjs.clear()
    this.tiles.setWorld(world)
    this.rebuildBlocks()
  }

  /**
   * Blocks + their shadows (RPTnkBlock::UpdateShadow runs every frame; rebuilt on change) as
   * instanced meshes, and the registered special tiles (codes 500-599).
   */
  rebuildBlocks() {
    const w = this.world!
    for (const d of this.tileDisposers) d()
    this.tileDisposers = []
    this.tileUpdates = []
    for (const c of this.blockGroup.children) if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose()
    this.blockGroup.clear()
    const solid = (c: number, r: number) => {
      const g = w.grid[r]?.[c]
      return !!g && (g.kind === Cell.Block || g.kind === Cell.Cork)
    }
    const blocks: { kind: number; height: number; x: number; z: number }[] = []
    const shadows: { frame: number; forward: { x: number; z: number }; x: number; z: number }[] = []
    for (let r = 0; r < w.height; r++)
      for (let c = 0; c < w.width; c++) {
        const g = w.grid[r][c]
        const p = w.cellCenter(c, r)
        if (g.code >= 500 && g.code <= 599) this.addTile(g.code, c, r, p.x, p.z)
        // [tanks+] special tiles (glass, crates, gates, water ...) are drawn by TilesView
        if (g.kind === Cell.Empty || this.tiles.ownsCell(g.code)) continue
        blocks.push({ kind: g.kind === Cell.Cork ? 0 : 1, height: g.kind === Cell.Hole ? 1 : g.height, x: p.x, z: p.z })
        if (g.kind !== Cell.Hole) shadows.push({ ...blockShadowFor(solid(c, r - 1), solid(c, r + 1), solid(c - 1, r), solid(c + 1, r)), x: p.x, z: p.z })
      }
    this.blockGroup.add(this.models.blockInstances(blocks, shadows))
  }

  private addTile(code: number, col: number, row: number, x: number, z: number) {
    const f = tileFactory(code)
    if (!f) return
    let res: TileResult = null
    try {
      res = f({ code, col, row, x, z, quality: this.quality, grid: this.world!.grid })
    } catch (e) {
      console.error('tile renderer', code, e)
    }
    if (!res) return
    const obj = (res as THREE.Object3D).isObject3D ? (res as THREE.Object3D) : (res as { object: THREE.Object3D }).object
    const r = res as { update?: (f: number) => void; dispose?: () => void }
    obj.position.x += x
    obj.position.z += z
    this.blockGroup.add(obj)
    if (r.update) this.tileUpdates.push(r.update)
    if (r.dispose) this.tileDisposers.push(r.dispose)
  }

  /** effects the original spawns at these events (RPSysEffect calls in RPTnk*.cpp) */
  onEvents(ev: SimEvent[]) {
    const fx = this.fx
    for (const e of ev) {
      switch (e.t) {
        case 'tread':
          this.tread.stamp(this.lookOf(e.tank).tread, e.pos.x, e.pos.z, e.dir.x, e.dir.z)
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
          fx.spawn('Tnk_bomb01_piece', { pos, scale: 1.6, color: this.lookOf(t).piece })
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
    this.tiles.onEvents(ev)
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
    this.frame++
    for (const u of this.tileUpdates) u(w.frame)
    const seen = new Set<Tank>()
    for (const t of w.tanks) {
      seen.add(t)
      let o = this.tankObjs.get(t)
      const look = this.lookOf(t).look
      if (!o || o.root.userData.look !== look.key) {
        if (o) this.stage.remove(o.root)
        o = this.models.tank(look)
        o.root.userData.look = look.key
        this.tankObjs.set(t, o)
        this.stage.add(o.root)
      }
      // the first-person tank is the camera: its own model would fill the view
      o.root.visible = t.alive && !t.invisible && !(this.fpv && !t.isEnemy && t.index === this.fpv.player)
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
    this.tiles.sync(this.tankObjs)
    syncSet(this.markObjs, w.checkMarks, this.stage, (m) => this.models.checkMark(m.color, [PLAYER_COLORS.p3, PLAYER_COLORS.p4]), (o, m) => o.position.set(m.pos.x, 0.2, m.pos.z))
  }

  /** the camera this frame: first person while the player's tank is alive, else the fixed view */
  activeCamera(): THREE.Camera {
    const t = this.fpv && this.world?.playerTanks[this.fpv.player]
    if (!this.fpv || !t || !t.alive) {
      this.fpvReady = false
      return this.camera
    }
    // eye on the turret, a little behind the pivot; ease the position so the 60 Hz steps don't judder
    const { yaw, pitch } = this.fpv
    const target = new THREE.Vector3(t.pos.x - Math.cos(yaw) * 6, 30, t.pos.z - Math.sin(yaw) * 6)
    if (this.fpvReady) this.fpvPos.lerp(target, 0.5)
    else this.fpvPos.copy(target)
    this.fpvReady = true
    const cam = this.fpvCam
    cam.position.copy(this.fpvPos)
    cam.up.set(0, 1, 0)
    cam.lookAt(this.fpvPos.x + Math.cos(yaw) * 100, this.fpvPos.y + Math.tan(pitch) * 100, this.fpvPos.z + Math.sin(yaw) * 100)
    return cam
  }

  render() {
    this.tread.flush()
    this.models.setTreadTexture(this.tread.texture)
    this.renderer.clear()
    const cam = this.activeCamera()
    this.renderer.render(this.scene, cam)
    // the 2D cursor effects belong to the fixed view
    if (cam === this.camera) {
      this.renderer.clearDepth()
      this.renderer.render(this.overlay, this.overlayCam)
    }
  }

  /**
   * RPTnkCursor effects: main + tail at the cursor, line from the tank (mode 2) scaled by
   * distance / 100. Modes: 0 hidden, 1 main + tail, 2 + line, 3 main at alpha 128.
   * Players 3/4 use recoloured copies of the 1p/2p cursors.
   */
  updateCursor(player: number, c: { x: number; y: number; mode: number; visible: boolean }, tank: { x: number; y: number } | null) {
    let h = this.cursors[player]
    if (!h) {
      const p = ['1p', '2p', '3p', '4p'][player] ?? '1p'
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

  /** world point -> layout units (832 x 456 centred, y up, in 16:9), like RPTnkCamera::ProjectToScreen */
  projectToLayout(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    return { x: v.x * this.layoutHalf.x, y: v.y * this.layoutHalf.y }
  }

  /** draw calls / triangles of the last frame (dev, perf checks) */
  get stats() {
    const i = this.renderer.info
    return { calls: i.render.drawCalls, triangles: i.render.triangles, frame: this.frame }
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
