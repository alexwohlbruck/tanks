// Converted ROM models (public/assets/models, docs/models.md) with the GX
// shading rebuilt as TSL node materials:
//   lit:   out = tex * K * vertexColour * clamp(ambient 100/255 + max(0, N.y)) + envTex(matcapUV) * Kenv
//   blend: out = tex * factor (shadows, X marks, hole)
//   floor: lerp(floor_lower, floor_face, treadCapture)
// All colour maths happens on raw texture values, like the hardware (no sRGB conversion).

import * as THREE from 'three/webgpu'
import { clamp, float, mix, normalView, normalWorld, texture, uniform, uv, vec2, vec3, vec4, vertexColor } from 'three/tsl'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const BASE = 'assets/models/'
const AMBIENT = 100 / 255

export type TankObj = { root: THREE.Object3D; cannon: THREE.Object3D }

/** RPTnkBlock::CalcModelMtx: model (0 hole, 1 block_7, 2 block_8) and sink offset per height 1-8 */
const BLOCK_MODEL = [0, 2, 2, 1, 2, 2, 1, 2]
const BLOCK_SINK = [-0.2, 105, 87.5, 52.5, 52.5, 35, 0, 0]

/** tnk_shadow_animation SRT0: texture translation per frame (0, 2, 3, 4 neighbours) */
const SHADOW_SRT: [number, number][] = [
  [0, 0],
  [-0.5, 0],
  [0, 0.5],
  [0.5, -0.5],
]

type MatOpts = { lit: boolean; vertexColors: boolean; envTex: THREE.Texture | null; envK?: number[] }

export class Models {
  private glb = new Map<string, THREE.Group>()
  private texCache = new Map<string, Promise<THREE.Texture>>()
  private corkTex!: THREE.Texture
  private floorTextures!: [THREE.Texture, THREE.Texture]
  mineClr: number[][] = []

  async load() {
    const loader = new GLTFLoader()
    const names = [
      'tnk_tank__tnk_tank_1p',
      'tnk_tank__tnk_tank_2p',
      ...Array.from({ length: 9 }, (_, i) => `tnk_tank__tnk_tank_e_${i + 1}`),
      'tnk_block__tnk_block_1',
      'tnk_block__tnk_block_7',
      'tnk_block__tnk_block_8',
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
    await Promise.all(
      names.map(async (n) => {
        const g = await loader.loadAsync(BASE + n + '.glb')
        await convertMaterials(g.scene, g.parser)
        this.glb.set(n, g.scene)
      }),
    )
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
        return t
      })
      this.texCache.set(file, p)
    }
    return p
  }

  private clone(name: string) {
    const g = this.glb.get(name)
    if (!g) throw new Error('model ' + name)
    return g.clone(true)
  }

  // ---- field ----------------------------------------------------------------

  /** floor + surroundings; `tread` is the tread-mark capture (white = untouched) */
  field(aspect: '16_9' | '4_3', tread: THREE.Texture) {
    const g = new THREE.Group()
    const floor = this.clone(`tnk_field_${aspect}__tnk_field_${aspect}`)
    floor.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && (m.material as THREE.Material).name === 'tnk_field_mat') m.material = this.floorMaterial(tread)
    })
    g.add(floor)
    g.add(this.clone(`tnk_field_${aspect}__tnk_field_${aspect}_out`))
    return g
  }

  private floorMat: { tex: THREE.Texture; mat: THREE.Material } | null = null

  private floorMaterial(tread: THREE.Texture) {
    if (this.floorMat?.tex === tread) return this.floorMat.mat
    const [face, lower] = this.floorTextures
    const m = new THREE.MeshBasicNodeMaterial()
    m.name = 'tnk_field_mat'
    // tnk_field_mat TEV: lerp(floor_lower, floor_face, caterpillar capture)
    const k = texture(tread, uv()).r
    m.colorNode = vec4(mix(texture(lower, uv()).rgb, texture(face, uv()).rgb, k), 1)
    this.floorMat = { tex: tread, mat: m }
    return m
  }

  // ---- blocks ---------------------------------------------------------------

  /** kind 0 cork / 1 wood, height 1-8 (1 = hole); origin at the cell centre on the floor */
  block(kind: number, height: number) {
    const idx = BLOCK_MODEL[height - 1]
    const name = ['tnk_block__tnk_block_1', 'tnk_block__tnk_block_7', 'tnk_block__tnk_block_8'][idx]
    const obj = this.clone(name)
    obj.position.y = -BLOCK_SINK[height - 1]
    if (idx !== 0 && kind === 0) {
      // PAT0 frame 1 -> block.2 (cork)
      obj.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.material = this.corkMat(m.material as THREE.MeshBasicNodeMaterial)
      })
    }
    const g = new THREE.Group()
    g.add(obj)
    return g
  }

  private corkCache = new Map<THREE.Material, THREE.Material>()
  private corkMat(src: THREE.MeshBasicNodeMaterial) {
    let m = this.corkCache.get(src)
    if (!m) this.corkCache.set(src, (m = rebuild(src, this.corkTex)))
    return m
  }

  /** RPTnkBlock::UpdateShadow: frame = atlas quadrant, forward = quad orientation */
  blockShadow(frame: number, forward: { x: number; z: number }) {
    const obj = this.clone('tnk_block_shadow__tnk_block_shadow')
    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) m.material = this.shadowMaterial(m.material as THREE.MeshBasicNodeMaterial, frame)
    })
    obj.rotation.y = Math.atan2(forward.x, forward.z)
    return obj
  }

  private shadowMats = new Map<number, THREE.Material>()
  private shadowMaterial(src: THREE.MeshBasicNodeMaterial, frame: number) {
    let m = this.shadowMats.get(frame)
    if (!m) {
      const map = (src.userData.map as THREE.Texture).clone()
      map.offset.set(SHADOW_SRT[frame][0], SHADOW_SRT[frame][1])
      map.wrapS = map.wrapT = THREE.RepeatWrapping
      map.needsUpdate = true
      this.shadowMats.set(frame, (m = rebuild(src, map)))
    }
    return m
  }

  // ---- tanks, shells, mines, marks ---------------------------------------------

  /** model index 0 = 1p, 1 = 2p, 2-10 = enemy type 1-9 */
  tank(modelIdx: number): TankObj {
    const name = modelIdx === 0 ? 'tnk_tank__tnk_tank_1p' : modelIdx === 1 ? 'tnk_tank__tnk_tank_2p' : `tnk_tank__tnk_tank_e_${modelIdx - 1}`
    const model = this.clone(name)
    model.scale.setScalar(1.6)
    const root = new THREE.Group()
    root.add(model)
    return { root, cannon: model.getObjectByName('cannon')! }
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
      if (mesh.isMesh && (mesh.material as THREE.Material).name === 'mine_mat') {
        const mat = rebuild(mesh.material as THREE.MeshBasicNodeMaterial, null)
        mesh.material = mat
        m.userData.tint = mat.userData.tint
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

  /** RPTnkCheckMark: 0 P1 blue, 1 P2 red, 2 enemy white */
  checkMark(kind: number) {
    const o = this.clone(['tnk_check__tnk_check_blue', 'tnk_check__tnk_check_red', 'tnk_check__tnk_check_white'][kind])
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
}

// ---- materials ------------------------------------------------------------------

/** Replace the glTF materials with GX-equivalent node materials. */
async function convertMaterials(root: THREE.Object3D, parser: GLTF['parser']) {
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
        if (src.map) src.map.colorSpace = THREE.NoColorSpace
        const env = ex.env_add?.[0]
        const envTex = env ? ((await parser.getDependency('texture', env.gltf_texture)) as THREE.Texture) : null
        if (envTex) envTex.colorSpace = THREE.NoColorSpace
        const opts: MatOpts = { lit: (ex.light_set ?? -1) >= 0 && !src.transparent, vertexColors: src.vertexColors, envTex, envK: env?.scale_rgb }
        const m = new THREE.MeshBasicNodeMaterial()
        m.name = src.name
        m.side = src.side
        m.transparent = src.transparent
        m.depthWrite = src.depthWrite
        m.alphaTest = src.alphaTest
        m.userData = { ...src.userData, map: src.map, opts, factor: src.color.clone(), opacity: src.opacity }
        buildColorNode(m, src.map)
        return m
      })()
      done.set(src, p)
    }
    jobs.push(p.then((m) => void (mesh.material = m)))
  })
  await Promise.all(jobs)
}

/** a converted material with another base texture (and its own tint uniform) */
function rebuild(src: THREE.MeshBasicNodeMaterial, map: THREE.Texture | null) {
  const m = new THREE.MeshBasicNodeMaterial()
  m.name = src.name
  m.side = src.side
  m.transparent = src.transparent
  m.depthWrite = src.depthWrite
  m.alphaTest = src.alphaTest
  m.userData = { ...src.userData, map: map ?? src.userData.map }
  buildColorNode(m, map ?? (src.userData.map as THREE.Texture | null))
  return m
}

function buildColorNode(m: THREE.MeshBasicNodeMaterial, map: THREE.Texture | null) {
  const o = m.userData.opts as MatOpts
  const factor = m.userData.factor as THREE.Color
  const tint = uniform(new THREE.Color(factor.r, factor.g, factor.b))
  m.userData.tint = tint
  const base = map ? texture(map, uv()) : vec4(1, 1, 1, 1)
  let rgb = base.rgb.mul(tint)
  const alpha = base.a.mul(float(m.userData.opacity as number))
  if (o.lit) {
    // GX channel: material colour (vertex colour) * clamp(ambient + N.L), one white light straight down
    const light = clamp(normalWorld.y.max(0).add(AMBIENT), 0, 1)
    rgb = rgb.mul(light)
    if (o.vertexColors) rgb = rgb.mul(vertexColor().rgb)
  }
  if (o.envTex && o.envK) {
    // texgen env_camera: s = 0.5 n.x + 0.5, t = 0.5 - 0.5 n.y (view-space normal), added
    const n = normalView.normalize()
    const envUv = vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5))
    rgb = rgb.add(texture(o.envTex, envUv).rgb.mul(vec3(o.envK[0], o.envK[1], o.envK[2])))
  }
  m.colorNode = vec4(clamp(rgb, 0, 1), alpha)
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
