// Shared look of the Tanks+ toy pieces: the block textures (painted wood / cork), the GX-style
// shading of models.ts (tex * clamp(ambient 100/255 + max(0, N.y)) + additive env shine), or
// three.js Phong lighting at 'ultra', the decal shadows and the effect sprites.
//
// One Kit per render quality: classic samples the disc textures and paints its canvases at disc
// resolution; high / ultra use the hi-res set (public/assets/hires) where it exists and paint
// at 4x. Everything falls back to the disc files, and those to flat colours.

import * as THREE from 'three/webgpu'
import { clamp, float, normalView, normalWorld, texture, uv, vec2, vec3, vec4 } from 'three/tsl'
import type { HiresTextures } from '../hires'
import type { RenderOptions } from '../quality'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any

export const CELL = 35
const AMBIENT = 100 / 255
const DISC = 'assets/models/textures/'
const FX = 'assets/effects/textures/'

type Src = { disc: string; hires?: string; wrap?: THREE.Wrapping }

const SOURCES = {
  wood: { disc: DISC + 'tnk_block/block.1.png', hires: 'tnk_block/block.1' },
  cork: { disc: DISC + 'tnk_block/block.2.png', hires: 'tnk_block/block.2' },
  env: { disc: DISC + 'tnk_block/tnk_tank_env.png', hires: 'tnk_block/tnk_tank_env' },
  blockShadow: { disc: DISC + 'tnk_block_shadow/block_shadow.png', hires: 'tnk_block_shadow/block_shadow' },
  roundShadow: { disc: DISC + 'tnk_block/tank_shadow.png', hires: 'tnk_tank/tank_shadow' },
  // effect sprites are quarter images drawn mirrored (sample with sprite())
  glow: { disc: FX + 'pc_gen_glow1.png', hires: 'fx/pc_gen_glow1', wrap: THREE.MirroredRepeatWrapping },
  glowSoft: { disc: FX + 'pc_gen_glow2.png', hires: 'fx/pc_gen_glow2', wrap: THREE.MirroredRepeatWrapping },
  kira: { disc: FX + 'pc_clr_kira01.png', hires: 'fx/pc_clr_kira01', wrap: THREE.MirroredRepeatWrapping },
  grad: { disc: FX + 'pc_gen_grad_v1.png', hires: 'fx/pc_gen_grad_v1' },
} satisfies Record<string, Src>

export type TexName = keyof typeof SOURCES

export type MatOpts = {
  /** additive env shine (models.ts block_mat: 0.157) */
  env?: number
  alpha?: N
  transparent?: boolean
  depthWrite?: boolean
  side?: THREE.Side
  /** added after lighting (glows, lit lenses) */
  emissive?: N
  /** no light term (decals that are already shaded) */
  unlit?: boolean
  /** Phong specular strength at 'ultra' */
  spec?: number
  blending?: THREE.Blending
}

export class Kit {
  tex = {} as Record<TexName, THREE.Texture>
  /** source images for the canvas painters (the textures' images) */
  img = {} as Record<'wood' | 'cork', CanvasImageSource | null>
  /** canvas texture scale: 1 = disc resolution */
  res: number
  enhanced: boolean
  decals: boolean
  private canvases = new Map<string, THREE.CanvasTexture>()

  constructor(
    public opts: RenderOptions,
    private hires: HiresTextures | null,
  ) {
    const hi = !!(opts.hires && hires?.available)
    this.res = hi ? 4 : 1
    this.enhanced = opts.lighting === 'enhanced'
    this.decals = !opts.shadows
  }

  async load() {
    const hi = this.res > 1
    await Promise.all(
      (Object.keys(SOURCES) as TexName[]).map(async (k) => {
        const s: Src = SOURCES[k]
        let t: THREE.Texture | null = null
        if (hi && s.hires) {
          const h = await this.hires!.get(s.hires)
          if (h) {
            t = h.clone()
            t.needsUpdate = true
          }
        }
        if (!t) t = await new THREE.TextureLoader().loadAsync(s.disc).catch(() => null)
        if (!t) t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
        t.colorSpace = THREE.NoColorSpace
        t.flipY = false
        t.wrapS = t.wrapT = s.wrap ?? THREE.RepeatWrapping
        if (s.wrap === THREE.MirroredRepeatWrapping) {
          // like the effect renderer: no mips across the mirror seams
          t.generateMipmaps = false
          t.minFilter = THREE.LinearFilter
        }
        t.anisotropy = this.opts.anisotropy
        t.needsUpdate = true
        this.tex[k] = t
      }),
    )
    for (const k of ['wood', 'cork'] as const) {
      const im = this.tex[k].image as CanvasImageSource & { width?: number }
      this.img[k] = im && (im as { width?: number }).width ? im : null
    }
  }

  dispose() {
    for (const t of this.canvases.values()) t.dispose()
    this.canvases.clear()
  }

  /** a painted canvas texture (cached per key); `size` in disc pixels, painted at `res` */
  canvas(key: string, w: number, h: number, paint: (c: CanvasRenderingContext2D, w: number, h: number) => void, repeat = true) {
    let t = this.canvases.get(key)
    if (!t) {
      const cv = document.createElement('canvas')
      cv.width = Math.round(w * this.res)
      cv.height = Math.round(h * this.res)
      const c = cv.getContext('2d')!
      paint(c, cv.width, cv.height)
      t = new THREE.CanvasTexture(cv)
      t.colorSpace = THREE.NoColorSpace
      t.flipY = false
      t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
      t.anisotropy = this.opts.anisotropy
      t.generateMipmaps = true
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.needsUpdate = true
      this.canvases.set(key, t)
    }
    return t
  }

  // ---- shading --------------------------------------------------------------------------

  /** GX lit channel: ambient 100/255 + max(0, N.y), one white light straight down */
  get light(): N {
    return clamp(normalWorld.y.max(0).add(AMBIENT), 0, 1)
  }

  /** env_camera texgen of models.ts: additive sphere map from the view-space normal */
  shine(k: number): N {
    const n = normalView.normalize()
    return texture(this.tex.env, vec2(n.x.mul(0.5).add(0.5), n.y.mul(-0.5).add(0.5))).rgb.mul(k)
  }

  /** a lit toy material: albedo (vec3 node) through the GX equation or Phong at 'ultra' */
  mat(albedo: N, o: MatOpts = {}): THREE.Material {
    const alpha = o.alpha ?? float(1)
    const lit = !o.unlit
    const shine = o.env ? this.shine(o.env) : null
    let m: THREE.MeshBasicNodeMaterial | THREE.MeshPhongNodeMaterial
    if (this.enhanced && lit && !o.transparent) {
      const p = new THREE.MeshPhongNodeMaterial()
      p.colorNode = vec4(clamp(albedo, 0, 1), alpha)
      let e: N = shine
      if (o.emissive) e = e ? e.add(o.emissive) : o.emissive
      if (e) p.emissiveNode = e
      p.specular = new THREE.Color().setScalar(o.spec ?? (o.env && o.env > 0.2 ? 0.18 : 0.03))
      p.shininess = o.env && o.env > 0.2 ? 48 : 12
      m = p
    } else {
      m = new THREE.MeshBasicNodeMaterial()
      let rgb: N = lit ? albedo.mul(this.light) : albedo
      if (shine) rgb = rgb.add(shine)
      if (o.emissive) rgb = rgb.add(o.emissive)
      m.colorNode = vec4(clamp(rgb, 0, 1), alpha)
    }
    m.transparent = !!o.transparent
    m.depthWrite = o.depthWrite ?? !o.transparent
    if (o.side !== undefined) m.side = o.side
    if (o.blending !== undefined) m.blending = o.blending
    return m
  }

  /** additive / alpha sprite colour (already final, no light) */
  glowMat(rgba: N, additive = true) {
    const m = new THREE.MeshBasicNodeMaterial()
    m.colorNode = rgba
    m.transparent = true
    m.depthWrite = false
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    m.side = THREE.DoubleSide
    return m
  }

  /** effect sprite intensity at sprite uv 0..1 (quarter images, mirrored about the centre) */
  sprite(name: 'glow' | 'glowSoft' | 'kira', at: N = uv()): N {
    return texture(this.tex[name], at.mul(2)).a
  }

  // ---- wood -----------------------------------------------------------------------------

  /**
   * block.1 / block.2 on a face with uv 0..1 (one block face): `upper` = the upper cube's half
   * (yellow wood / light cork), else the lower cube's half (orange / dark), like block_7/8.
   */
  woodFace(at: N = uv(), upper = true, cork = false): N {
    const t = this.tex[cork ? 'cork' : 'wood']
    const v = at.y.clamp(0, 1).mul(0.5).add(upper ? 0.5 : 0)
    return texture(t, vec2(at.x.clamp(0, 1), v)).rgb
  }

  /** wood grain without the block frame (inner part of the face), world-mapped: `p` in cells */
  woodGrain(p: N, upper = true): N {
    const q = p.fract().mul(0.7).add(0.15)
    return texture(this.tex.wood, vec2(q.x, q.y.mul(0.5).add(upper ? 0.5 : 0))).rgb
  }
}

/** painted surface: the paint colour with a little of the wood grain showing through */
export function painted(paint: N, grain: N, k = 0.35): N {
  const lum = grain.dot(vec3(0.3, 0.5, 0.2))
  return paint.mul(lum.mul(k * 1.6).add(1 - k * 0.9))
}

/** a CSS hex colour as raw values (GX does no colour management, see models.ts) */
export const rgb = (c: string): N => {
  const k = new THREE.Color().setStyle(c, THREE.LinearSRGBColorSpace)
  return vec3(k.r, k.g, k.b)
}
