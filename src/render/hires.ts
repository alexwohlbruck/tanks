// Hi-res texture set (tools/hires/build.ts -> public/assets/hires/manifest.json) and
// runtime recolouring for the liveries that have no disc texture (players 3/4, registered
// tank types). Everything degrades to the disc textures: a missing manifest or file
// just means `get` resolves to null.

import * as THREE from 'three/webgpu'

const BASE = 'assets/hires/'

type Entry = { file: string; w: number; h: number }

export class HiresTextures {
  private entries: Record<string, Entry> | null = null
  private cache = new Map<string, Promise<THREE.Texture | null>>()
  private ready = new Map<string, THREE.Texture>()
  private loading: Promise<void> | null = null
  anisotropy = 1

  /** fetch the manifest once; resolves false when there is no hi-res set */
  async load(): Promise<boolean> {
    this.loading ??= fetch(BASE + 'manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => void (this.entries = m?.textures ?? null))
      .catch(() => void (this.entries = null))
    await this.loading
    return !!this.entries
  }

  get available() {
    return !!this.entries
  }

  has(key: string) {
    return !!this.entries?.[key]
  }

  /** loaded texture (flipY false, raw colour, mipmapped) or null */
  get(key: string): Promise<THREE.Texture | null> {
    let p = this.cache.get(key)
    if (!p) {
      const e = this.entries?.[key]
      p = e
        ? new THREE.TextureLoader()
            .loadAsync(BASE + e.file.split('/').map(encodeURIComponent).join('/'))
            .then((t) => {
              t.name = key
              t.colorSpace = THREE.NoColorSpace
              t.flipY = false
              t.generateMipmaps = true
              t.minFilter = THREE.LinearMipmapLinearFilter
              t.magFilter = THREE.LinearFilter
              t.anisotropy = this.anisotropy
              this.ready.set(key, t)
              return t
            })
            .catch(() => null)
        : Promise.resolve(null)
      this.cache.set(key, p)
    }
    return p
  }

  /** already loaded (see preload) */
  peek(key: string) {
    return this.ready.get(key) ?? null
  }

  async preload(keys: Iterable<string>) {
    await Promise.all([...keys].map((k) => this.get(k)))
  }

  setAnisotropy(a: number) {
    this.anisotropy = a
    for (const t of this.ready.values())
      if (t.anisotropy !== a) {
        t.anisotropy = a
        t.needsUpdate = true
      }
  }
}

// ---- recolouring ---------------------------------------------------------------------------

/** pixels of a loaded texture (ImageBitmap / HTMLImageElement / canvas) */
export function texturePixels(t: THREE.Texture): ImageData | null {
  const im = t.image as CanvasImageSource & { width: number; height: number }
  if (!im || !im.width) return null
  const c = document.createElement('canvas')
  c.width = im.width
  c.height = im.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(im, 0, 0)
  return ctx.getImageData(0, 0, c.width, c.height)
}

/** a CanvasTexture with the same sampling setup as `like` */
export function textureFromPixels(px: ImageData, like: THREE.Texture, name: string) {
  const c = document.createElement('canvas')
  c.width = px.width
  c.height = px.height
  c.getContext('2d')!.putImageData(px, 0, 0)
  const t = new THREE.CanvasTexture(c)
  t.name = name
  t.colorSpace = THREE.NoColorSpace
  t.flipY = like.flipY
  t.wrapS = like.wrapS
  t.wrapT = like.wrapT
  t.offset.copy(like.offset)
  t.repeat.copy(like.repeat)
  t.minFilter = like.minFilter
  t.magFilter = like.magFilter
  t.generateMipmaps = like.generateMipmaps
  t.anisotropy = like.anisotropy
  // no texKey: a recoloured texture has no hi-res file of its own
  t.userData = { ...like.userData, texKey: undefined }
  return t
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * Recolour `src` so its average colour (over `mask`, default every pixel) becomes `target`
 * while each pixel keeps its brightness relative to that average: the shading bands of the
 * 1p livery, or the grain of an enemy livery band, survive the colour change.
 * `accent` (optional) recolours the unmasked part the same way.
 */
export function recolour(src: ImageData, target: THREE.Color, mask?: Float32Array | null, accent?: THREE.Color | null): ImageData {
  const d = src.data
  const n = d.length / 4
  const out = new ImageData(new Uint8ClampedArray(d), src.width, src.height)
  const o = out.data
  const avg = (sel: (i: number) => number) => {
    let s = 0, w = 0
    for (let i = 0; i < n; i++) {
      const k = sel(i)
      if (k <= 0) continue
      s += luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) * k
      w += k
    }
    return w ? s / w : 128
  }
  const m = (i: number) => (mask ? mask[i] : 1)
  const ref = avg(m)
  const refA = accent ? avg((i) => 1 - m(i)) : 1
  for (let i = 0; i < n; i++) {
    const k = m(i)
    const l = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
    for (let c = 0; c < 3; c++) {
      const tc = [target.r, target.g, target.b][c] * 255
      let v = d[i * 4 + c]
      if (k > 0) v = v * (1 - k) + Math.min(255, (tc * l) / ref) * k
      if (accent && k < 1) {
        const ac = [accent.r, accent.g, accent.b][c] * 255
        v = v * k + Math.min(255, (ac * l) / refA) * (1 - k)
      }
      o[i * 4 + c] = v
    }
  }
  return out
}

/** 1 where two same-size liveries differ (the coloured band of the enemy textures), else 0 */
export function differenceMask(a: ImageData, b: ImageData): Float32Array | null {
  if (a.width !== b.width || a.height !== b.height) return null
  const n = a.width * a.height
  const m = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const dd = Math.abs(a.data[i * 4] - b.data[i * 4]) + Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]) + Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2])
    m[i] = Math.min(1, Math.max(0, (dd - 30) / 40))
  }
  return m
}
