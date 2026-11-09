// Converted ROM models (public/assets/models, docs/models.md) with the GX shading rebuilt as
// TSL node materials:
//   lit:   out = tex * K * vertexColour * clamp(ambient 100/255 + max(0, N.y)) + envTex(matcapUV) * Kenv
//   blend: out = tex * factor (shadows, X marks, hole)
//   floor: lerp(floor_lower, floor_face, treadCapture)
// All colour maths happens on raw texture values, like the hardware (no sRGB conversion).
//
// Quality variants (quality.ts): every converted material is a *base*; the material actually
// on a mesh is a variant of it for the current RenderOptions (disc or hi-res textures, GX or
// enhanced lighting), built on demand and cached. Geometry likewise has a PN-smoothed variant
// for the curved models. `applyTo(root)` puts the right variants on a subtree; the base
// (classic) variant is exactly the original port.

import * as THREE from 'three/webgpu'
import { clamp, float, mix, normalView, normalWorld, texture, uniform, uv, vec2, vec3, vec4, vertexColor } from 'three/tsl'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { HiresTextures, differenceMask, recolour, textureFromPixels, texturePixels } from './hires'
import { QUALITY_PRESETS, type RenderOptions } from './quality'
import type { BaseModel, TankVisual } from './registry'
import { pnTriangles } from './smooth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const BASE = 'assets/models/'
const AMBIENT = 100 / 255

export type TankObj = { root: THREE.Object3D; cannon: THREE.Object3D }

/** RPTnkBlock::CalcModelMtx: model (0 hole, 1 block_7, 2 block_8) and sink offset per height 1-8 */
const BLOCK_MODEL = [0, 2, 2, 1, 2, 2, 1, 2]
const BLOCK_SINK = [-0.2, 105, 87.5, 52.5, 52.5, 35, 0, 0]
const BLOCK_NAMES = ['tnk_block__tnk_block_1', 'tnk_block__tnk_block_7', 'tnk_block__tnk_block_8']

/** tnk_shadow_animation SRT0: texture translation per frame (0, 2, 3, 4 neighbours) */
const SHADOW_SRT: [number, number][] = [
  [0, 0],
  [-0.5, 0],
  [0, 0.5],
  [0.5, -0.5],
]

/** models whose curved parts get PN smoothing at 'high' and above, with the max angle between
 *  a vertex normal and its face normal that still counts as a curved surface (smooth.ts) */
const SMOOTH_MODELS: [RegExp, number][] = [
  [/tnk_tank_|tnk_mine|shell__shell/, 32],
  // the border: only the finely tessellated round logs, not the bevelled slabs
  [/_out$/, 13],
]

/** decal shadow materials (hidden when real-time shadows replace them) */
const DECAL_SHADOWS = new Set(['tank_shadow_mat', 'mine_shadow_mat', 'block_shadow_mat'])

type MatOpts = { lit: boolean; vertexColors: boolean; envTex: THREE.Texture | null; envK?: number[] }

/** what a base material is made of (userData of every base material) */
type BaseData = {
  opts: MatOpts
  map: THREE.Texture | null
  /** explicit hi-res counterpart of `map` (recoloured liveries) */
  hiresMap?: THREE.Texture | null
  factor: THREE.Color
  opacity: number
  tint: N
  emissive?: THREE.Color
  /** floor: tread capture node + the two floor textures */
  floor?: { face: THREE.Texture; lower: THREE.Texture; tread: N }
  variants: Map<string, THREE.Material>
}

/** one tank look: model + livery overrides (registry entries, players 3/4) */
export interface TankLook {
  key: string
  base: BaseModel
  livery?: TankVisual['livery']
  accent?: TankVisual['accent']
  scale?: number
  emissive?: TankVisual['emissive']
  emissiveIntensity?: number
}

const color = (c: number | string) => new THREE.Color(c as THREE.ColorRepresentation)

export class Models {
  hires = new HiresTextures()
  opts: RenderOptions = QUALITY_PRESETS.classic
  private glb = new Map<string, THREE.Group>()
  private texCache = new Map<string, Promise<THREE.Texture>>()
  private corkTex!: THREE.Texture
  private floorTextures!: [THREE.Texture, THREE.Texture]
  private baseOf = new WeakMap<THREE.Material, THREE.Material>()
  private geoBase = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
  private geoSmooth = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
  private hiresClones = new Map<THREE.Texture, THREE.Texture>()
  mineClr: number[][] = []

  async load() {
    const loader = new GLTFLoader()
    const names = [
      'tnk_tank__tnk_tank_1p',
      'tnk_tank__tnk_tank_2p',
      ...Array.from({ length: 9 }, (_, i) => `tnk_tank__tnk_tank_e_${i + 1}`),
      ...BLOCK_NAMES,
      'tnk_block_shadow__tnk_block_shadow',
      'tnk_field_16_9__tnk_field_16_9',
      'tnk_field_16_9__tnk_field_16_9_out',
      'tnk_field_4_3__tnk_field_4_3',
      'tnk_field_4_3__tnk_field_4_3_out',
      'tnk_mine__tnk_mine',
      'shell__shell',
      'tnk_check__tnk_check_blue',
      'tnk_check__tnk_check_red',
      'tnk_check__tnk_check_white',
    ]
    await Promise.all([
      this.hires.load(),
      ...names.map(async (n) => {
        const g = await loader.loadAsync(BASE + n + '.glb')
        await this.convertMaterials(g.scene, g.parser, n.split('__')[0])
        if (n.endsWith('_out')) mergeByMaterial(g.scene)
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          m.userData.smooth = SMOOTH_MODELS.find(([re]) => re.test(n))?.[1] ?? 0
          const transparent = (m.material as THREE.Material).transparent
          m.castShadow = !transparent
          m.receiveShadow = !transparent
          if (DECAL_SHADOWS.has((m.material as THREE.Material).name) || /^block_shadow/.test((m.material as THREE.Material).name)) m.userData.decal = true
        })
        this.glb.set(n, g.scene)
      }),
    ])
    const [cork, face, lower] = await Promise.all([this.tex('tnk_block/block.2.png'), this.tex('tnk_block/floor_face.png'), this.tex('tnk_block/floor_lower.png')])
    this.corkTex = cork
    this.floorTextures = [face, lower]
    const clr = await fetch(BASE + 'animations/tnk_mine__tnk_mine.clr0.json').then((r) => r.json())
    this.mineClr = mineColours(clr)
  }

  private tex(file: string): Promise<THREE.Texture> {
    let p = this.texCache.get(file)
    if (!p) {
      p = new THREE.TextureLoader().loadAsync(BASE + 'textures/' + file).then((t) => {
        t.colorSpace = THREE.NoColorSpace
        t.flipY = false
        t.wrapS = t.wrapT = THREE.RepeatWrapping
        t.userData.texKey = file.replace(/\.png$/, '')
        return t
      })
      this.texCache.set(file, p)
    }
    return p
  }

  private clone(name: string) {
    const g = this.glb.get(name)
    if (!g) throw new Error('model ' + name)
    const c = g.clone(true)
    this.applyTo(c)
    return c
  }

  // ---- quality variants ------------------------------------------------------------------

  /** switch options; resolves once the hi-res textures it needs are loaded */
  async setOptions(o: RenderOptions) {
    this.hires.setAnisotropy(o.anisotropy)
    if (o.hires && this.hires.available) {
      const keys = new Set<string>()
      for (const g of this.glb.values())
        g.traverse((x) => {
          const m = (x as THREE.Mesh).material as THREE.Material | undefined
          const d = m?.userData as BaseData | undefined
          if (d?.map?.userData.texKey) keys.add(d.map.userData.texKey)
          if (d?.opts?.envTex?.userData.texKey) keys.add(d.opts.envTex.userData.texKey)
        })
      for (const t of [this.corkTex, ...this.floorTextures]) keys.add(t.userData.texKey)
      await this.hires.preload(keys)
    }
    // recoloured liveries / marks pair a disc and a hi-res texture made when first used:
    // rebuild them now that the hi-res set may be loaded (the scene re-creates its tanks)
    this.looks.clear()
    this.markMats.clear()
    this.bands = null
    this.opts = o
  }

  /** put the variants for the current options on every mesh under `root` */
  applyTo(root: THREE.Object3D) {
    root.traverse((x) => {
      const m = x as THREE.Mesh
      if (!m.isMesh) return
      if (m.material && !Array.isArray(m.material)) m.material = this.variant(m.material)
      if (m.userData.decal) m.visible = !this.opts.shadows
      const base = this.geoBase.get(m.geometry) ?? m.geometry
      if (m.userData.smooth && this.opts.smooth) {
        let s = this.geoSmooth.get(base)
        if (!s) {
          s = pnTriangles(base, 3, 0.02, m.userData.smooth as number)
          this.geoSmooth.set(base, s)
          this.geoBase.set(s, base)
        }
        m.geometry = s
      } else m.geometry = base
    })
  }

  private variant(mat: THREE.Material) {
    const base = this.baseOf.get(mat) ?? mat
    const d = base.userData as BaseData
    if (!d.variants) return mat
    const hires = this.opts.hires && this.hires.available
    const key = `${hires ? 'h' : 'o'}:${this.opts.lighting}`
    let v = d.variants.get(key)
    if (!v) {
      v = key === 'o:gx' ? base : this.buildVariant(base, hires, this.opts.lighting)
      d.variants.set(key, v)
      this.baseOf.set(v, base)
    }
    return v
  }

  /** hi-res counterpart of a texture with the same sampling setup (offset, wrap), or itself */
  private hiresFor(t: THREE.Texture | null, explicit?: THREE.Texture | null) {
    if (!t) return t
    if (explicit) return explicit
    const hi = t.userData.texKey ? this.hires.peek(t.userData.texKey) : null
    if (!hi) return t
    let c = this.hiresClones.get(t)
    if (!c) {
      c = hi.clone()
      c.wrapS = t.wrapS
      c.wrapT = t.wrapT
      c.offset.copy(t.offset)
      c.repeat.copy(t.repeat)
      c.needsUpdate = true
      this.hiresClones.set(t, c)
    }
    return c
  }

  private buildVariant(base: THREE.Material, hires: boolean, lighting: 'gx' | 'enhanced') {
    const d = base.userData as BaseData
    const enhanced = lighting === 'enhanced' && !base.transparent
    const m = enhanced ? new THREE.MeshPhongNodeMaterial() : new THREE.MeshBasicNodeMaterial()
    m.name = base.name
    m.side = base.side
    m.transparent = base.transparent
    m.depthWrite = base.depthWrite
    m.alphaTest = base.alphaTest
    // the hole decal is alpha tested: with MSAA, alpha to coverage smooths its edge
    if (hires && base.alphaTest > 0) m.alphaToCoverage = true
    m.userData = d
    const map = hires ? this.hiresFor(d.map, d.hiresMap) : d.map
    const env = hires ? this.hiresFor(d.opts.envTex) : d.opts.envTex
    if (d.floor) {
      const face = hires ? this.hiresFor(d.floor.face)! : d.floor.face
      const lower = hires ? this.hiresFor(d.floor.lower)! : d.floor.lower
      m.colorNode = vec4(mix(texture(lower, uv()).rgb, texture(face, uv()).rgb, d.floor.tread.r), 1)
    } else buildColorNode(m, d, map, env, enhanced)
    if (enhanced) {
      const p = m as THREE.MeshPhongNodeMaterial
      p.specular = new THREE.Color().setScalar(d.opts.envK && d.opts.envK[0] > 0.3 ? 0.18 : 0.015)
      p.shininess = d.opts.envK && d.opts.envK[0] > 0.3 ? 48 : 8
    }
    return m
  }

  // ---- field ----------------------------------------------------------------

  /** floor + surroundings; `tread` is the tread-mark capture (white = untouched) */
  field(aspect: '16_9' | '4_3', tread: THREE.Texture) {
    const g = new THREE.Group()
    const floor = this.clone(`tnk_field_${aspect}__tnk_field_${aspect}`)
    floor.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && (m.material as THREE.Material).name === 'tnk_field_mat') {
        m.material = this.variant(this.floorMaterial(tread))
        m.castShadow = false
      }
    })
    g.add(floor)
    g.add(this.clone(`tnk_field_${aspect}__tnk_field_${aspect}_out`))
    return g
  }

  private floorMat: THREE.Material | null = null

  /** tnk_field_mat TEV: lerp(floor_lower, floor_face, caterpillar capture); the capture
   *  texture can be swapped later with setTreadTexture */
  private floorMaterial(tread: THREE.Texture) {
    if (this.floorMat) {
      this.setTreadTexture(tread)
      return this.floorMat
    }
    const [face, lower] = this.floorTextures
    const m = new THREE.MeshBasicNodeMaterial()
    m.name = 'tnk_field_mat'
    const k: N = texture(tread, uv())
    const d: BaseData = {
      opts: { lit: false, vertexColors: false, envTex: null },
      map: null,
      factor: new THREE.Color(1, 1, 1),
      opacity: 1,
      tint: uniform(new THREE.Color(1, 1, 1)),
      floor: { face, lower, tread: k },
      variants: new Map(),
    }
    m.userData = d
    m.colorNode = vec4(mix(texture(lower, uv()).rgb, texture(face, uv()).rgb, k.r), 1)
    this.floorMat = m
    return m
  }

  setTreadTexture(t: THREE.Texture) {
    const d = this.floorMat?.userData as BaseData | undefined
    if (d?.floor && d.floor.tread.value !== t) d.floor.tread.value = t
  }

  // ---- blocks ---------------------------------------------------------------

  /** kind 0 cork / 1 wood, height 1-8 (1 = hole); origin at the cell centre on the floor */
  block(kind: number, height: number) {
    const idx = BLOCK_MODEL[height - 1]
    const obj = this.clone(BLOCK_NAMES[idx])
    obj.position.y = -BLOCK_SINK[height - 1]
    if (idx !== 0 && kind === 0) {
      // PAT0 frame 1 -> block.2 (cork)
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.material = this.variant(this.corkMat(this.baseOf.get(m.material as THREE.Material) ?? (m.material as THREE.Material)))
      })
    }
    const g = new THREE.Group()
    g.add(obj)
    return g
  }

  private corkCache = new Map<THREE.Material, THREE.Material>()
  private corkMat(src: THREE.Material) {
    let m = this.corkCache.get(src)
    if (!m) this.corkCache.set(src, (m = rebuild(src, this.corkTex)))
    return m
  }

  /** RPTnkBlock::UpdateShadow: frame = atlas quadrant, forward = quad orientation */
  blockShadow(frame: number, forward: { x: number; z: number }) {
    const obj = this.clone('tnk_block_shadow__tnk_block_shadow')
    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.material = this.variant(this.shadowMaterial(this.baseOf.get(m.material as THREE.Material) ?? (m.material as THREE.Material), frame))
        m.userData.decal = true
        m.visible = !this.opts.shadows
      }
    })
    obj.rotation.y = Math.atan2(forward.x, forward.z)
    return obj
  }

  private shadowMats = new Map<number, THREE.Material>()
  private shadowMaterial(src: THREE.Material, frame: number) {
    let m = this.shadowMats.get(frame)
    if (!m) {
      const srcMap = (src.userData as BaseData).map!
      const map = srcMap.clone()
      map.offset.set(SHADOW_SRT[frame][0], SHADOW_SRT[frame][1])
      map.wrapS = map.wrapT = THREE.RepeatWrapping
      map.userData = { ...srcMap.userData }
      map.needsUpdate = true
      this.shadowMats.set(frame, (m = rebuild(src, map)))
    }
    return m
  }

  /**
   * Static blocks as instanced meshes: one draw per (model part, material) instead of one per
   * block. `blocks` are kind/height/cell centre; `shadows` the decal frame/orientation per cell.
   */
  blockInstances(blocks: { kind: number; height: number; x: number; z: number }[], shadows: { frame: number; forward: { x: number; z: number }; x: number; z: number }[]) {
    const g = new THREE.Group()
    const groups = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; mesh: THREE.Mesh; mats: THREE.Matrix4[] }>()
    const add = (proto: THREE.Object3D, at: THREE.Matrix4, tag: string) => {
      proto.updateMatrixWorld(true)
      proto.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const mat = m.material as THREE.Material
        const k = `${tag}|${m.geometry.uuid}|${mat.uuid}`
        let e = groups.get(k)
        if (!e) groups.set(k, (e = { geo: m.geometry, mat, mesh: m, mats: [] }))
        e.mats.push(new THREE.Matrix4().multiplyMatrices(at, m.matrixWorld))
      })
    }
    const at = new THREE.Matrix4()
    for (const b of blocks) {
      const proto = this.block(b.kind, b.height)
      add(proto, at.makeTranslation(b.x, 0, b.z), 'b')
    }
    for (const s of shadows) {
      const proto = this.blockShadow(s.frame, s.forward)
      add(proto, at.makeTranslation(s.x, 0, s.z), 's')
    }
    for (const e of groups.values()) {
      const im = new THREE.InstancedMesh(e.geo, e.mat, e.mats.length)
      e.mats.forEach((m, i) => im.setMatrixAt(i, m))
      im.renderOrder = e.mesh.renderOrder
      im.castShadow = e.mesh.castShadow
      im.receiveShadow = e.mesh.receiveShadow
      im.userData = { ...e.mesh.userData }
      im.visible = e.mesh.visible
      im.computeBoundingSphere()
      g.add(im)
    }
    return g
  }

  // ---- tanks, shells, mines, marks ---------------------------------------------

  private looks = new Map<string, Map<THREE.Material, THREE.Material>>()

  /** a tank in the given look (disc model + optional livery override) */
  tank(look: TankLook): TankObj {
    const name = look.base === '1p' ? 'tnk_tank__tnk_tank_1p' : look.base === '2p' ? 'tnk_tank__tnk_tank_2p' : `tnk_tank__tnk_tank_${look.base}`
    const model = this.clone(name)
    model.scale.setScalar(1.6 * (look.scale ?? 1))
    if (look.livery !== undefined || look.emissive !== undefined) {
      let swap = this.looks.get(look.key)
      if (!swap) this.looks.set(look.key, (swap = new Map()))
      model.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const base = this.baseOf.get(m.material as THREE.Material) ?? (m.material as THREE.Material)
        if (base.name !== 'tank_mat') return
        let lm = swap.get(base)
        if (!lm) swap.set(base, (lm = this.liveryMaterial(base, look)))
        m.material = this.variant(lm)
      })
    }
    const root = new THREE.Group()
    root.add(model)
    return { root, cannon: model.getObjectByName('cannon')! }
  }

  /** tank_mat with a recoloured (or replaced) livery, for the disc and the hi-res texture */
  private liveryMaterial(base: THREE.Material, look: TankLook) {
    const d = base.userData as BaseData
    const src = d.map!
    let map = src
    let hiresMap: THREE.Texture | null = null
    if (typeof look.livery === 'string' && !/^#|^0x/i.test(look.livery)) {
      map = new THREE.TextureLoader().load(look.livery)
      map.colorSpace = THREE.NoColorSpace
      map.flipY = false
      map.wrapS = src.wrapS
      map.wrapT = src.wrapT
      hiresMap = map
    } else if (look.livery !== undefined) {
      const target = color(look.livery)
      const accent = look.accent !== undefined ? color(look.accent) : null
      const enemy = look.base.startsWith('e_')
      const make = (t: THREE.Texture, band: Float32Array | null) => {
        const px = texturePixels(t)
        return px ? textureFromPixels(recolour(px, target, enemy ? band : null, accent), t, `${t.name}_${look.key}`) : t
      }
      map = make(src, enemy ? this.bandMask(false) : null)
      const hi = this.hires.available && src.userData.texKey ? this.hires.peek(src.userData.texKey) : null
      if (hi) {
        hi.wrapS = src.wrapS
        hi.wrapT = src.wrapT
        hiresMap = make(hi, enemy ? this.bandMask(true) : null)
      }
    }
    const m = rebuild(base, map, { hiresMap, emissive: look.emissive !== undefined ? color(look.emissive).multiplyScalar(look.emissiveIntensity ?? 0.35) : undefined })
    return m
  }

  private bands: [Float32Array | null, Float32Array | null] | null = null
  /** where the enemy liveries differ from each other = the coloured band */
  private bandMask(hires: boolean) {
    if (!this.bands) {
      const tex = (n: string) => {
        let t: THREE.Texture | null = null
        this.glb.get(n)?.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined
          if (m?.name === 'tank_mat') t = (m.userData as BaseData).map
        })
        return t as THREE.Texture | null
      }
      const a = tex('tnk_tank__tnk_tank_e_2'), b = tex('tnk_tank__tnk_tank_e_4')
      const pa = a && texturePixels(a), pb = b && texturePixels(b)
      const ha = a?.userData.texKey ? this.hires.peek(a.userData.texKey) : null
      const hb = b?.userData.texKey ? this.hires.peek(b.userData.texKey) : null
      const hpa = ha && texturePixels(ha), hpb = hb && texturePixels(hb)
      this.bands = [pa && pb ? differenceMask(pa, pb) : null, hpa && hpb ? differenceMask(hpa, hpb) : null]
    }
    return this.bands[hires ? 1 : 0]
  }

  /** yaw: radians about +Y, 0 = model facing +Z */
  poseTank(t: TankObj, x: number, z: number, bodyYaw: number, turretYaw: number) {
    t.root.position.set(x, 0, z)
    t.root.rotation.y = bodyYaw
    // cannon's local X is world up (parent bind rotation Rz 90)
    t.cannon.rotation.x = turretYaw - bodyYaw
  }

  shell() {
    const s = this.clone('shell__shell')
    s.scale.setScalar(1.5238097)
    const g = new THREE.Group()
    g.add(s)
    return g
  }

  mine() {
    const m = this.clone('tnk_mine__tnk_mine')
    m.traverse((o) => {
      const mesh = o as THREE.Mesh
      const base = mesh.isMesh ? (this.baseOf.get(mesh.material as THREE.Material) ?? (mesh.material as THREE.Material)) : null
      if (base?.name === 'mine_mat') {
        // per-mine tint uniform, shared by all its quality variants
        const mat = rebuild(base, null)
        mesh.material = this.variant(mat)
        m.userData.tint = (mat.userData as BaseData).tint
      }
    })
    return m
  }

  /** tnk_mine CLR0 colour frame (the game runs it only while the fuse is lit) */
  setMineFrame(o: THREE.Object3D, frame: number) {
    const u = o.userData.tint as { value: THREE.Color } | undefined
    if (!u || !this.mineClr.length) return
    const c = this.mineClr[frame % this.mineClr.length]
    u.value.setRGB(c[0] / 255, c[1] / 255, c[2] / 255)
  }

  private markMats = new Map<number, THREE.Material>()

  /**
   * RPTnkCheckMark colour param: player index 0-3, anything else (TEAM_ENEMY = 9) enemy white.
   * P1 blue and P2 red are the disc marks; P3/P4 recolour the blue one.
   */
  checkMark(colorParam: number, p34?: [number, number]) {
    const name = colorParam === 0 || colorParam >= 2 && colorParam <= 3 ? 'tnk_check__tnk_check_blue' : colorParam === 1 ? 'tnk_check__tnk_check_red' : 'tnk_check__tnk_check_white'
    const o = this.clone(name)
    if ((colorParam === 2 || colorParam === 3) && p34) {
      o.traverse((x) => {
        const m = x as THREE.Mesh
        if (!m.isMesh) return
        let mat = this.markMats.get(colorParam)
        if (!mat) {
          const base = this.baseOf.get(m.material as THREE.Material) ?? (m.material as THREE.Material)
          const src = (base.userData as BaseData).map!
          const target = color(p34[colorParam - 2])
          const re = (t: THREE.Texture) => {
            const px = texturePixels(t)
            return px ? textureFromPixels(recolourKeepAlpha(px, target), t, `${t.name}_p${colorParam + 1}`) : t
          }
          const hi = src.userData.texKey ? this.hires.peek(src.userData.texKey) : null
          mat = rebuild(base, re(src), { hiresMap: hi ? re(hi) : null })
          this.markMats.set(colorParam, mat)
        }
        m.material = this.variant(mat)
      })
    }
    const g = new THREE.Group()
    g.add(o)
    return g
  }

  /** Fixed gameplay camera (RPTnkCamera::SetMode(1)) */
  frameCamera(cam: THREE.OrthographicCamera) {
    const a = (42 * Math.PI) / 180
    cam.position.set(0, 2000 * Math.sin(a), 2000 * Math.cos(a) - 14)
    cam.up.set(0, Math.cos(a), -Math.sin(a))
    cam.lookAt(0, 0, -14)
  }

  // ---- materials ------------------------------------------------------------------

  /** Replace the glTF materials with GX-equivalent node materials (the base variants). */
  private async convertMaterials(root: THREE.Object3D, parser: GLTF['parser'], brres: string) {
    const jobs: Promise<void>[] = []
    const done = new Map<THREE.Material, Promise<THREE.Material>>()
    root.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      mesh.renderOrder = (mesh.userData.renderOrder as number) ?? 0
      const src = mesh.material as THREE.MeshStandardMaterial
      let p = done.get(src)
      if (!p) {
        p = (async () => {
          const ex = (src.userData ?? {}) as { env_add?: { gltf_texture: number; scale_rgb: number[] }[]; light_set?: number }
          if (src.map) {
            src.map.colorSpace = THREE.NoColorSpace
            src.map.userData.texKey = `${brres}/${src.map.name}`
          }
          const env = ex.env_add?.[0]
          const envTex = env ? ((await parser.getDependency('texture', env.gltf_texture)) as THREE.Texture) : null
          if (envTex) {
            envTex.colorSpace = THREE.NoColorSpace
            envTex.userData.texKey = `${brres}/${envTex.name}`
          }
          const opts: MatOpts = { lit: (ex.light_set ?? -1) >= 0 && !src.transparent, vertexColors: src.vertexColors, envTex, envK: env?.scale_rgb }
          const m = new THREE.MeshBasicNodeMaterial()
          m.name = src.name
          m.side = src.side
          m.transparent = src.transparent
          m.depthWrite = src.depthWrite
          m.alphaTest = src.alphaTest
          const d: BaseData = {
            opts,
            map: src.map,
            factor: src.color.clone(),
            opacity: src.opacity,
            tint: uniform(new THREE.Color(src.color.r, src.color.g, src.color.b)),
            variants: new Map(),
          }
          m.userData = d
          buildColorNode(m, d, src.map, envTex, false)
          return m
        })()
        done.set(src, p)
      }
      jobs.push(p.then((m) => void (mesh.material = m)))
    })
    await Promise.all(jobs)
  }
}

/** a base material with another base texture (and its own tint uniform) */
function rebuild(src: THREE.Material, map: THREE.Texture | null, extra: { hiresMap?: THREE.Texture | null; emissive?: THREE.Color } = {}) {
  const s = src.userData as BaseData
  const m = new THREE.MeshBasicNodeMaterial()
  m.name = src.name
  m.side = src.side
  m.transparent = src.transparent
  m.depthWrite = src.depthWrite
  m.alphaTest = src.alphaTest
  const d: BaseData = {
    ...s,
    map: map ?? s.map,
    hiresMap: map ? (extra.hiresMap ?? null) : s.hiresMap,
    tint: uniform(new THREE.Color(s.factor.r, s.factor.g, s.factor.b)),
    emissive: extra.emissive ?? s.emissive,
    variants: new Map(),
  }
  m.userData = d
  buildColorNode(m, d, d.map, d.opts.envTex, false)
  return m
}

/**
 * GX colour: tex * tint (* GX light * vertex colour) + env shine. With `enhanced` the light
 * term is left to three.js (Phong): colorNode is the albedo and the shine goes to emissive.
 */
function buildColorNode(m: THREE.MeshBasicNodeMaterial | THREE.MeshPhongNodeMaterial, d: BaseData, map: THREE.Texture | null, envTex: THREE.Texture | null, enhanced: boolean) {
  const o = d.opts
  const base: N = map ? texture(map, uv()) : vec4(1, 1, 1, 1)
  let rgb: N = base.rgb.mul(d.tint)
  const alpha: N = base.a.mul(float(d.opacity))
  if (o.vertexColors && (o.lit || enhanced)) rgb = rgb.mul(vertexColor().rgb)
  let shine: N = null
  if (envTex && o.envK) {
    // texgen env_camera: s = 0.5 n.x + 0.5, t = 0.5 - 0.5 n.y (view-space normal), added
    const n = normalView.normalize()
    const envUv = vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5))
    shine = texture(envTex, envUv).rgb.mul(vec3(o.envK[0], o.envK[1], o.envK[2]))
  }
  if (d.emissive) {
    const e: N = vec3(d.emissive.r, d.emissive.g, d.emissive.b)
    shine = shine ? shine.add(e) : e
  }
  if (enhanced) {
    m.colorNode = vec4(clamp(rgb, 0, 1), alpha)
    if (shine) (m as THREE.MeshPhongNodeMaterial).emissiveNode = shine
    return
  }
  if (o.lit) {
    // GX channel: material colour (vertex colour) * clamp(ambient + N.L), one white light straight down
    const light: N = clamp(normalWorld.y.max(0).add(AMBIENT), 0, 1)
    rgb = rgb.mul(light)
  }
  if (shine) rgb = rgb.add(shine)
  m.colorNode = vec4(clamp(rgb, 0, 1), alpha)
}

/** X mark recolour: target colour at the mark's brightness, alpha untouched */
function recolourKeepAlpha(px: ImageData, target: THREE.Color) {
  return recolour(px, target)
}

/** merge the static meshes of a model by material (one draw per material, same pixels) */
function mergeByMaterial(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  const groups = new Map<string, THREE.Mesh[]>()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const mat = m.material as THREE.Material
    const sig = Object.keys(m.geometry.attributes).sort().join(',') + (m.geometry.index ? 'i' : '')
    const k = `${mat.uuid}|${sig}|${mat.transparent ? m.renderOrder : 0}`
    let l = groups.get(k)
    if (!l) groups.set(k, (l = []))
    l.push(m)
  })
  const out: THREE.Mesh[] = []
  for (const list of groups.values()) {
    const geos = list.map((m) => m.geometry.clone().applyMatrix4(m.matrixWorld))
    const merged = list.length > 1 ? mergeGeometries(geos) : geos[0]
    if (!merged) {
      out.push(...list)
      continue
    }
    const mesh = new THREE.Mesh(merged, list[0].material)
    mesh.renderOrder = Math.min(...list.map((m) => m.renderOrder))
    mesh.name = list[0].name
    mesh.userData = { ...list[0].userData }
    out.push(mesh)
  }
  // flatten: the merged meshes are in root space
  for (const c of [...root.children]) root.remove(c)
  root.position.set(0, 0, 0)
  root.rotation.set(0, 0, 0)
  root.scale.set(1, 1, 1)
  for (const m of out) {
    if (m.parent) m.matrixWorld.decompose(m.position, m.quaternion, m.scale)
    root.add(m)
  }
}

/** frames of RGB from the tnk_mine CLR0 json (first animated colour) */
function mineColours(clr: unknown): number[][] {
  let out: number[][] = []
  const walk = (v: unknown) => {
    if (out.length || !v || typeof v !== 'object') return
    if (Array.isArray(v)) {
      if (v.length > 1 && v.every((f) => Array.isArray(f) && f.length >= 3 && f.every((x: unknown) => typeof x === 'number'))) {
        out = v as number[][]
        return
      }
      v.forEach(walk)
      return
    }
    for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k])
  }
  walk(clr)
  return out
}
