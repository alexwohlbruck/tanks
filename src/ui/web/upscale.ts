// Edge-preserving upscaler for the small layout textures (TPL): separable Catmull-Rom in
// premultiplied space, then the alpha of hard cut-out edges (icons, bands, balloons) is
// re-sharpened to about one output pixel, while soft alpha (glows, shadows, gradients) keeps
// its smooth ramp. Cheap enough to run lazily the first time a texture is drawn.

export type HiTex = ImageData & { scale: number }

/** output textures stay within this size */
const MAX_OUT = 512
const MAX_SCALE = 4

const cache = new WeakMap<ImageData, HiTex>()

export function upscaled(src: ImageData): HiTex {
  let r = cache.get(src)
  if (!r) cache.set(src, (r = upscale(src)))
  return r
}

/** taps of the Catmull-Rom kernel at fractional offset t */
function weights(t: number, out: Float32Array) {
  const t2 = t * t
  const t3 = t2 * t
  out[0] = -0.5 * t3 + t2 - 0.5 * t
  out[1] = 1.5 * t3 - 2.5 * t2 + 1
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t
  out[3] = 0.5 * t3 - 0.5 * t2
}

/** tiles whose opposite edges match are sampled with wrap-around, the rest clamp to edge */
function tiles(d: Uint8ClampedArray, w: number, h: number, horizontal: boolean) {
  let diff = 0
  const n = horizontal ? h : w
  for (let i = 0; i < n; i++) {
    const a = horizontal ? i * w * 4 : i * 4
    const b = horizontal ? (i * w + w - 1) * 4 : ((h - 1) * w + i) * 4
    for (let c = 0; c < 4; c++) diff += Math.abs(d[a + c] - d[b + c])
  }
  return diff / (n * 4) < 12
}

function upscale(src: ImageData): HiTex {
  const w = src.width
  const h = src.height
  const f = Math.min(MAX_SCALE, Math.floor(MAX_OUT / Math.max(w, h)))
  if (f < 2) return Object.assign(src, { scale: 1 })
  const d = src.data
  const W = w * f
  const H = h * f
  // premultiplied float source
  const P = new Float32Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255
    P[i * 4] = d[i * 4] * a
    P[i * 4 + 1] = d[i * 4 + 1] * a
    P[i * 4 + 2] = d[i * 4 + 2] * a
    P[i * 4 + 3] = d[i * 4 + 3]
  }
  const wrapX = tiles(d, w, h, true)
  const wrapY = tiles(d, w, h, false)
  const ix = (x: number) => (wrapX ? ((x % w) + w) % w : x < 0 ? 0 : x >= w ? w - 1 : x)
  const iy = (y: number) => (wrapY ? ((y % h) + h) % h : y < 0 ? 0 : y >= h ? h - 1 : y)
  // per output phase: kernel taps (same for every texel)
  const k = new Float32Array(4)
  const taps: { base: number; w: Float32Array }[] = []
  for (let p = 0; p < f; p++) {
    const s = (p + 0.5) / f - 0.5
    const b = Math.floor(s)
    weights(s - b, k)
    taps.push({ base: b, w: k.slice() })
  }
  // horizontal pass: w*h -> W*h
  const Hp = new Float32Array(W * h * 4)
  for (let y = 0; y < h; y++)
    for (let X = 0; X < W; X++) {
      const x = Math.floor(X / f)
      const t = taps[X % f]
      const o = (y * W + X) * 4
      for (let j = 0; j < 4; j++) {
        const q = (y * w + ix(x + t.base + j - 1)) * 4
        const wt = t.w[j]
        Hp[o] += P[q] * wt
        Hp[o + 1] += P[q + 1] * wt
        Hp[o + 2] += P[q + 2] * wt
        Hp[o + 3] += P[q + 3] * wt
      }
    }
  // hard alpha edges: neighbouring source texels differ by most of the range
  const hard = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3]
      let lo = a
      let hi = a
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const v = d[(iy(y + dy) * w + ix(x + dx)) * 4 + 3]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      hard[y * w + x] = hi - lo > 170 ? 1 : 0
    }
  const out = new ImageData(W, H)
  const o8 = out.data
  const slope = f * 0.8
  for (let Y = 0; Y < H; Y++) {
    const y = Math.floor(Y / f)
    const t = taps[Y % f]
    for (let X = 0; X < W; X++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let j = 0; j < 4; j++) {
        const q = (iy(y + t.base + j - 1) * W + X) * 4
        const wt = t.w[j]
        r += Hp[q] * wt
        g += Hp[q + 1] * wt
        b += Hp[q + 2] * wt
        a += Hp[q + 3] * wt
      }
      a = a < 0 ? 0 : a > 255 ? 255 : a
      let A = a
      if (hard[y * w + Math.floor(X / f)]) {
        A = ((a / 255 - 0.5) * slope + 0.5) * 255
        A = A < 0 ? 0 : A > 255 ? 255 : A
      }
      const o = (Y * W + X) * 4
      if (a > 0.5) {
        // un-premultiply with the interpolated alpha, output with the sharpened one
        const m = 255 / a
        o8[o] = r * m
        o8[o + 1] = g * m
        o8[o + 2] = b * m
      }
      o8[o + 3] = A
    }
  }
  return Object.assign(out, { scale: f })
}
