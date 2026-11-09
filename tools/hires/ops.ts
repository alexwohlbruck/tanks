// Image operations for the hi-res texture pipeline (float RGBA, see png.ts).
//
// - resize: separable Lanczos-3 / Mitchell resampling in premultiplied alpha, with the
//   texture's wrap mode at the borders (repeat for tiling textures, mirror for the effect
//   sprites that are drawn as mirrored quarter images, clamp otherwise)
// - crisp: edge-aware sharpening for flat art (liveries, X marks, cursors, tread dashes):
//   every transition is pulled toward its local min / max, so a 16x upscale keeps the
//   original's hard edges without the staircase of nearest-neighbour or the smear of bicubic
// - grain: line-integral convolution of noise along the source's own grain direction
//   (structure tensor), added multiplicatively, so magnified wood gets fibres that follow
//   the original figure instead of the bilinear blur
// - cork: cellular granules with per-cell brightness, same idea for the cork blocks

import { img, type Img } from './png'

export type Wrap = 'repeat' | 'clamp' | 'mirror'

const wrapIdx = (i: number, n: number, w: Wrap) => {
  if (w === 'repeat') return ((i % n) + n) % n
  if (w === 'clamp') return i < 0 ? 0 : i >= n ? n - 1 : i
  const p = 2 * n
  let k = ((i % p) + p) % p
  if (k >= n) k = p - 1 - k
  return k
}

export function clone(a: Img): Img {
  return { w: a.w, h: a.h, d: new Float32Array(a.d) }
}

/** deterministic PRNG (mulberry32) */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x))
const lanczos3 = (x: number) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0)
function mitchell(x: number) {
  const B = 1 / 3, C = 1 / 3
  x = Math.abs(x)
  if (x < 1) return ((12 - 9 * B - 6 * C) * x ** 3 + (-18 + 12 * B + 6 * C) * x ** 2 + (6 - 2 * B)) / 6
  if (x < 2) return ((-B - 6 * C) * x ** 3 + (6 * B + 30 * C) * x ** 2 + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6
  return 0
}

/** 1D resample of `n` samples (stride `st`, 4 channels) to `m` */
function resample1d(src: Float32Array, n: number, m: number, kernel: (x: number) => number, support: number, wrap: Wrap) {
  const scale = m / n
  const fs = scale < 1 ? 1 / scale : 1 // widen the kernel when shrinking
  const taps: { i: number[]; w: number[] }[] = []
  for (let j = 0; j < m; j++) {
    const c = (j + 0.5) / scale - 0.5
    const lo = Math.floor(c - support * fs), hi = Math.ceil(c + support * fs)
    const ii: number[] = [], ww: number[] = []
    let sum = 0
    for (let i = lo; i <= hi; i++) {
      const wgt = kernel((i - c) / fs)
      if (!wgt) continue
      ii.push(wrapIdx(i, n, wrap))
      ww.push(wgt)
      sum += wgt
    }
    taps.push({ i: ii, w: ww.map((x) => x / sum) })
  }
  return taps
}

/** premultiplied resize to W x H */
export function resize(a: Img, W: number, H: number, opts: { wrap?: Wrap; kernel?: 'lanczos' | 'mitchell' } = {}): Img {
  const wrap = opts.wrap ?? 'clamp'
  const [k, sup] = opts.kernel === 'mitchell' ? [mitchell, 2] : [lanczos3, 3]
  const pm = new Float32Array(a.d)
  for (let i = 0; i < pm.length; i += 4) for (let c = 0; c < 3; c++) pm[i + c] *= pm[i + 3]
  // horizontal
  const tx = resample1d(pm, a.w, W, k, sup, wrap)
  const mid = new Float32Array(W * a.h * 4)
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < W; x++) {
      const t = tx[x]
      for (let c = 0; c < 4; c++) {
        let s = 0
        for (let q = 0; q < t.i.length; q++) s += pm[(y * a.w + t.i[q]) * 4 + c] * t.w[q]
        mid[(y * W + x) * 4 + c] = s
      }
    }
  const ty = resample1d(mid, a.h, H, k, sup, wrap)
  const out = img(W, H)
  for (let y = 0; y < H; y++) {
    const t = ty[y]
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0
        for (let q = 0; q < t.i.length; q++) s += mid[(t.i[q] * W + x) * 4 + c] * t.w[q]
        out.d[(y * W + x) * 4 + c] = s
      }
  }
  unpremultiply(out)
  return out
}

export function unpremultiply(a: Img) {
  const d = a.d
  for (let i = 0; i < d.length; i += 4) {
    const al = Math.min(1, Math.max(0, d[i + 3]))
    d[i + 3] = al
    for (let c = 0; c < 3; c++) d[i + c] = al > 1e-4 ? Math.min(1, Math.max(0, d[i + c] / al)) : 0
  }
}

/** colour of fully transparent texels: spread from the nearest opaque ones, so bilinear
 *  filtering and resampling never pull black into the edges */
export function bleed(a: Img, passes = 8) {
  const { w, h, d } = a
  for (let p = 0; p < passes; p++) {
    const src = new Float32Array(d)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (src[i + 3] > 0.02) continue
        let r = 0, g = 0, b = 0, n = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          const j = (yy * w + xx) * 4
          if (src[j + 3] <= 0.02 && !(src[j] + src[j + 1] + src[j + 2])) continue
          r += src[j], g += src[j + 1], b += src[j + 2], n++
        }
        if (n) (d[i] = r / n), (d[i + 1] = g / n), (d[i + 2] = b / n)
      }
  }
}

/** separable gaussian blur of selected channels */
export function blur(a: Img, sigma: number, wrap: Wrap = 'clamp', channels = [0, 1, 2, 3]): Img {
  const r = Math.max(1, Math.ceil(sigma * 3))
  const k: number[] = []
  let s = 0
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma))), (s += k[k.length - 1])
  for (let i = 0; i < k.length; i++) k[i] /= s
  const { w, h } = a
  const tmp = clone(a)
  const out = clone(a)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (const c of channels) {
        let v = 0
        for (let i = -r; i <= r; i++) v += a.d[(y * w + wrapIdx(x + i, w, wrap)) * 4 + c] * k[i + r]
        tmp.d[(y * w + x) * 4 + c] = v
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (const c of channels) {
        let v = 0
        for (let i = -r; i <= r; i++) v += tmp.d[(wrapIdx(y + i, h, wrap) * w + x) * 4 + c] * k[i + r]
        out.d[(y * w + x) * 4 + c] = v
      }
  return out
}

/** unsharp mask on rgb */
export function sharpen(a: Img, sigma: number, amount: number, wrap: Wrap = 'clamp'): Img {
  const b = blur(a, sigma, wrap, [0, 1, 2])
  const out = clone(a)
  for (let i = 0; i < a.d.length; i += 4) for (let c = 0; c < 3; c++) out.d[i + c] = clamp01(a.d[i + c] + (a.d[i + c] - b.d[i + c]) * amount)
  return out
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/** separable square-window min and max of one channel (premultiplied plane) */
function minMax(p: Float32Array, w: number, h: number, r: number, wrap: Wrap) {
  const mn1 = new Float32Array(w * h), mx1 = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let lo = Infinity, hi = -Infinity
      for (let i = -r; i <= r; i++) {
        const v = p[y * w + wrapIdx(x + i, w, wrap)]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      mn1[y * w + x] = lo
      mx1[y * w + x] = hi
    }
  const mn = new Float32Array(w * h), mx = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let lo = Infinity, hi = -Infinity
      for (let i = -r; i <= r; i++) {
        const j = wrapIdx(y + i, h, wrap) * w + x
        if (mn1[j] < lo) lo = mn1[j]
        if (mx1[j] > hi) hi = mx1[j]
      }
      mn[y * w + x] = lo
      mx[y * w + x] = hi
    }
  return { mn, mx }
}

/**
 * Edge-aware upscale for flat art: Mitchell upscale, then every channel (premultiplied) is
 * pushed toward its local min / max where the window spans an edge. Flat areas and the
 * original's intentional soft gradients wider than the window keep their values.
 */
export function crispUpscale(a: Img, scale: number, opts: { wrap?: Wrap; strength?: number } = {}): Img {
  const wrap = opts.wrap ?? 'clamp'
  const W = Math.round(a.w * scale), H = Math.round(a.h * scale)
  const src = clone(a)
  bleed(src)
  const u = resize(src, W, H, { wrap, kernel: 'mitchell' })
  const n = W * H
  const pm = [0, 1, 2, 3].map((c) => {
    const p = new Float32Array(n)
    for (let i = 0; i < n; i++) p[i] = c === 3 ? u.d[i * 4 + 3] : u.d[i * 4 + c] * u.d[i * 4 + 3]
    return p
  })
  const r = Math.max(1, Math.round(scale * 0.9))
  const lo = 0.5 - 0.5 / (opts.strength ?? 2.4), hi = 1 - lo
  const out = img(W, H)
  for (let c = 0; c < 4; c++) {
    const { mn, mx } = minMax(pm[c], W, H, r, wrap)
    for (let i = 0; i < n; i++) {
      const range = mx[i] - mn[i]
      let v = pm[c][i]
      if (range > 0.04) {
        const t = (v - mn[i]) / range
        // blend in the sharpening with the contrast of the edge (no effect on noise)
        const k = smoothstep(0.04, 0.16, range)
        v = v + (mn[i] + range * smoothstep(lo, hi, t) - v) * k
      }
      out.d[i * 4 + c] = v
    }
  }
  unpremultiply(out)
  // colour under fully transparent texels from the smooth upscale (keeps filtering clean)
  for (let i = 0; i < n; i++)
    if (out.d[i * 4 + 3] < 0.01) for (let c = 0; c < 3; c++) out.d[i * 4 + c] = u.d[i * 4 + c]
  return out
}

/** smooth (soft-art) upscale: Mitchell, no ringing */
export function smoothUpscale(a: Img, scale: number, wrap: Wrap = 'clamp'): Img {
  const src = clone(a)
  bleed(src)
  return resize(src, Math.round(a.w * scale), Math.round(a.h * scale), { wrap, kernel: 'mitchell' })
}

export const luma = (d: Float32Array, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]

/**
 * Grain direction field of `a` at W x H: angle (radians, image space) along which the
 * texture varies least, from the gaussian-smoothed structure tensor.
 */
export function grainField(a: Img, W: number, H: number, wrap: Wrap, sigma = 2): Float32Array {
  const { w, h, d } = a
  const t = img(w, h)
  const L = (x: number, y: number) => luma(d, (wrapIdx(y, h, wrap) * w + wrapIdx(x, w, wrap)) * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = (L(x + 1, y - 1) + 2 * L(x + 1, y) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x - 1, y) - L(x - 1, y + 1)) / 8
      const gy = (L(x - 1, y + 1) + 2 * L(x, y + 1) + L(x + 1, y + 1) - L(x - 1, y - 1) - 2 * L(x, y - 1) - L(x + 1, y - 1)) / 8
      const i = (y * w + x) * 4
      // normalised contributions: a strong edge (a livery band border) counts like any other
      // texel, so the many faint fibres decide the grain direction
      const m = 1 / (Math.hypot(gx, gy) + 0.01)
      t.d[i] = gx * gx * m
      t.d[i + 1] = gy * gy * m
      t.d[i + 2] = gx * gy * m
      t.d[i + 3] = 1
    }
  const s = blur(t, sigma, wrap, [0, 1, 2])
  // tensor is smooth: bilinear-ish upscale is enough
  const u = resize(s, W, H, { wrap, kernel: 'mitchell' })
  const ang = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const jxx = u.d[i * 4], jyy = u.d[i * 4 + 1], jxy = u.d[i * 4 + 2]
    // dominant gradient angle; the grain runs perpendicular to it
    ang[i] = 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2
  }
  return ang
}

/** zero-mean, unit-variance line integral convolution of white noise along `ang` */
export function lic(W: number, H: number, ang: Float32Array, len: number, seed: number, wrap: Wrap, noiseBlur = 0): Float32Array {
  const R = rng(seed)
  let noise: Float32Array = new Float32Array(W * H)
  for (let i = 0; i < noise.length; i++) noise[i] = R()
  if (noiseBlur > 0) {
    const n = img(W, H)
    for (let i = 0; i < W * H; i++) n.d[i * 4] = noise[i]
    noise = blur(n, noiseBlur, wrap, [0]).d.filter((_, i) => i % 4 === 0)
  }
  const out = new Float32Array(W * H)
  const ca = new Float32Array(W * H), sa = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) (ca[i] = Math.cos(ang[i])), (sa[i] = Math.sin(ang[i]))
  const rep = wrap === 'repeat'
  const at = (x: number, y: number) => {
    let ix = Math.floor(x + 0.5), iy = Math.floor(y + 0.5)
    if (ix < 0 || ix >= W) ix = rep ? ((ix % W) + W) % W : wrapIdx(ix, W, wrap)
    if (iy < 0 || iy >= H) iy = rep ? ((iy % H) + H) % H : wrapIdx(iy, H, wrap)
    return iy * W + ix
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sum = noise[y * W + x], n = 1
      for (let dir = 1; dir >= -1; dir -= 2) {
        let px = x, py = y
        let dx = ca[y * W + x] * dir, dy = sa[y * W + x] * dir
        for (let s = 0; s < len; s++) {
          px += dx
          py += dy
          const j = at(px, py)
          let nx = ca[j], ny = sa[j]
          if (nx * dx + ny * dy < 0) (nx = -nx), (ny = -ny)
          dx = nx
          dy = ny
          const wgt = 1 - s / len
          sum += noise[j] * wgt
          n += wgt
        }
      }
      out[y * W + x] = sum / n
    }
  normalize(out)
  return out
}

export function normalize(v: Float32Array) {
  let m = 0
  for (const x of v) m += x
  m /= v.length
  let s = 0
  for (const x of v) s += (x - m) ** 2
  s = Math.sqrt(s / v.length) || 1
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - m) / s
}

/** multiply rgb by (1 + amp * detail * mask) */
export function applyDetail(a: Img, detail: Float32Array, amp: number, mask?: Float32Array) {
  for (let i = 0; i < a.w * a.h; i++) {
    const k = 1 + amp * detail[i] * (mask ? mask[i] : 1)
    for (let c = 0; c < 3; c++) a.d[i * 4 + c] = clamp01(a.d[i * 4 + c] * k)
  }
}

/**
 * Wood: Lanczos upscale, unsharp at the source texel scale, then two octaves of fibres
 * (LIC along the grain). Tiling textures stay tiling (every step wraps).
 */
export function wood(a: Img, scale: number, opts: { wrap?: Wrap; amp?: number; seed?: number; sharpen?: number; sigma?: number; mask?: (x: number, y: number) => number } = {}): Img {
  const wrap = opts.wrap ?? 'repeat'
  const W = Math.round(a.w * scale), H = Math.round(a.h * scale)
  let up = resize(a, W, H, { wrap, kernel: 'lanczos' })
  if (opts.sharpen ?? 0.5) up = sharpen(up, Math.max(0.8, scale * 0.45), opts.sharpen ?? 0.5, wrap)
  const ang = grainField(a, W, H, wrap, opts.sigma ?? 2)
  const fine = lic(W, H, ang, Math.min(24, Math.max(6, Math.round(scale * 3))), opts.seed ?? 1, wrap)
  const coarse = lic(W, H, ang, Math.min(40, Math.max(10, Math.round(scale * 6))), (opts.seed ?? 1) + 7, wrap, Math.max(1, scale * 0.25))
  const det = new Float32Array(W * H)
  for (let i = 0; i < det.length; i++) det[i] = 0.55 * fine[i] + 0.45 * coarse[i]
  let mask: Float32Array | undefined
  if (opts.mask) {
    mask = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = opts.mask(x / W, y / H)
  }
  applyDetail(up, det, opts.amp ?? 0.05, mask)
  return up
}

/** tileable cellular noise: per-pixel {cell random value, F2 - F1 edge distance} */
export function cells(W: number, H: number, size: number, seed: number) {
  const gx = Math.max(1, Math.round(W / size)), gy = Math.max(1, Math.round(H / size))
  const R = rng(seed)
  const pts = new Float32Array(gx * gy * 3)
  for (let i = 0; i < gx * gy; i++) (pts[i * 3] = R()), (pts[i * 3 + 1] = R()), (pts[i * 3 + 2] = R())
  const val = new Float32Array(W * H), edge = new Float32Array(W * H)
  const cw = W / gx, ch = H / gy
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const cx = Math.floor(x / cw), cy = Math.floor(y / ch)
      let f1 = Infinity, f2 = Infinity, v = 0
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const ix = cx + i, iy = cy + j
          const k = (((iy % gy) + gy) % gy) * gx + (((ix % gx) + gx) % gx)
          const px = (ix + pts[k * 3]) * cw, py = (iy + pts[k * 3 + 1]) * ch
          const dd = Math.hypot(px - x, py - y)
          if (dd < f1) (f2 = f1), (f1 = dd), (v = pts[k * 3 + 2])
          else if (dd < f2) f2 = dd
        }
      val[y * W + x] = v
      edge[y * W + x] = (f2 - f1) / Math.min(cw, ch)
    }
  return { val, edge }
}

/** cork: Lanczos upscale + granules (cell brightness jitter, darker seams, fine speckle) */
export function cork(a: Img, scale: number, opts: { wrap?: Wrap; seed?: number } = {}): Img {
  const wrap = opts.wrap ?? 'repeat'
  const W = Math.round(a.w * scale), H = Math.round(a.h * scale)
  const up = sharpen(resize(a, W, H, { wrap, kernel: 'lanczos' }), scale * 0.45, 0.45, wrap)
  const big = cells(W, H, scale * 1.6, (opts.seed ?? 3) + 1)
  const small = cells(W, H, scale * 0.7, (opts.seed ?? 3) + 2)
  const R = rng((opts.seed ?? 3) + 3)
  for (let i = 0; i < W * H; i++) {
    let k = 1 + (big.val[i] - 0.5) * 0.12 + (small.val[i] - 0.5) * 0.08
    k *= 1 - 0.1 * (1 - smoothstep(0, 0.12, big.edge[i])) - 0.05 * (1 - smoothstep(0, 0.15, small.edge[i]))
    k *= 1 + (R() - 0.5) * 0.03
    for (let c = 0; c < 3; c++) up.d[i * 4 + c] = clamp01(up.d[i * 4 + c] * k)
  }
  return up
}
