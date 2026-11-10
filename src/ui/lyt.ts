// Runtime for the converted NW4R layouts (BRLYT/BRLAN, see docs/ui.md):
// pane tree, animation evaluation (Hermite/step keys) and a 2D-canvas renderer
// with a software version of the default nw4r TEV setup
// (out = lerp(C0, C1, tex) * vertexColor * materialColor).

import { upscaled } from './web/upscale'
import { drawVectorText, vectorFontOf } from './web/vectorText'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Img = ImageData
type Json = any

const BASE = 'assets/ui/'
const jsonCache = new Map<string, Promise<Json>>()
const imgCache = new Map<string, Promise<Img>>()

function getJSON(p: string): Promise<Json> {
  let r = jsonCache.get(p)
  if (!r) {
    r = fetch(BASE + p).then((x) => {
      if (!x.ok) throw new Error(p)
      return x.json()
    })
    jsonCache.set(p, r)
  }
  return r
}

function getImage(p: string): Promise<Img> {
  let r = imgCache.get(p)
  if (!r)
    imgCache.set(
      p,
      (r = new Promise((res, rej) => {
        const im = new Image()
        im.onload = () => {
          const c = document.createElement('canvas')
          c.width = im.width
          c.height = im.height
          const x = c.getContext('2d')!
          x.drawImage(im, 0, 0)
          res(x.getImageData(0, 0, im.width, im.height))
        }
        im.onerror = () => rej(new Error(p))
        im.src = BASE + p
      })),
    )
  return r
}

// ---- messages --------------------------------------------------------------

export const MSG: Record<string, string> = {}

export async function loadMessages() {
  for (const f of ['messages/party_message.json', 'messages/common_message.json']) {
    const b = await getJSON(f)
    for (const m of b.messages) if (!(m.idHex in MSG)) MSG[m.idHex] = m.text
  }
}

/** message id helper: (id << 8) | sub, as in RPSysLayout setMessage */
export function msg(id: number, sub = 0, ...args: (string | number)[]) {
  const key = '0x' + ((id << 8) | sub).toString(16).padStart(8, '0')
  let s = MSG[key] ?? ''
  s = s.replace(/\{num\}/g, () => String(args.length ? args.shift() : 0)).replace(/\{player\}/g, () => String(args.length ? args.shift() : ''))
  return s.replace(/\{(win|tag):[^}]*\}/g, '')
}

/** RPSysStringUtility::GetStringFullSizeNumber */
export function fullWidth(n: number) {
  return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + +d))
}

// ---- resources ---------------------------------------------------------------

export type LytRes = {
  name: string
  L: Json
  tex: Record<string, Img>
  fonts: { info: Json; img: Img }[]
  anims: Record<string, Json>
}

let manifest: Json = null

export async function loadLayout(name: string): Promise<LytRes> {
  manifest ??= await getJSON('index.json')
  const entry = manifest.layouts[name]
  const L = await getJSON(entry.file)
  const res: LytRes = { name, L, tex: {}, fonts: [], anims: {} }
  await Promise.all(L.textureFiles.filter(Boolean).map(async (f: string) => (res.tex[f] = await getImage(f))))
  res.fonts = await Promise.all(
    L.fontFiles.map(async (f: string) => {
      const info = await getJSON(f)
      return { info, img: await getImage(info.image) }
    }),
  )
  await Promise.all(
    entry.anims.map(async (a: string) => {
      const A = await getJSON('anims/' + a + '.json')
      res.anims[a] = A
      await Promise.all((A.textureFiles || []).filter(Boolean).map(async (f: string) => (res.tex[f] ??= await getImage(f))))
    }),
  )
  return res
}

// ---- animation ---------------------------------------------------------------

function hermite(k0: number[], k1: number[], f: number) {
  const d = k1[0] - k0[0]
  const t = (f - k0[0]) / d
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * k0[1] + (t3 - 2 * t2 + t) * d * k0[2] + (-2 * t3 + 3 * t2) * k1[1] + (t3 - t2) * d * k1[2]
}

function evalTarget(tg: Json, f: number): number | null {
  const k = tg.keys
  if (!k.length) return null
  if (tg.curve === 'step') {
    let v = k[0][1]
    for (const e of k) if (f >= e[0]) v = e[1]
    return v
  }
  if (f <= k[0][0]) return k[0][1]
  if (f >= k[k.length - 1][0]) return k[k.length - 1][1]
  for (let i = 0; i < k.length - 1; i++) if (f >= k[i][0] && f < k[i + 1][0]) return hermite(k[i], k[i + 1], f)
  return k[k.length - 1][1]
}

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)))

function findPane(root: Json, name: string): Json | null {
  if (root.name === name) return root
  for (const c of root.children) {
    const r = findPane(c, name)
    if (r) return r
  }
  return null
}

/** bindPane: like RPSysLayout::bindAnmObjToPane(anm, pane, recursive) — only that subtree animates. */
function applyAnim(L: Json, A: Json, frame: number, bindPane?: string, force = false) {
  const panes: Record<string, Json> = {}
  const mats: Record<string, Json> = {}
  const root = bindPane ? findPane(L.root, bindPane) : L.root
  if (!root) return
  ;(function w(p: Json) {
    panes[p.name] = p
    for (const mi of [p.material, p.content?.material, ...(p.frames || []).map((f: Json) => f.material)])
      if (mi !== undefined && mi !== null && L.materials[mi]) mats[L.materials[mi].name] = L.materials[mi]
    p.children.forEach(w)
  })(root)
  // RPSysLayout::forceBindAnmObjToPane: every entry name (panes and materials) gets its last two
  // characters (the ID) replaced by the bound pane's, so N_r00_05 plays the N_r00_00 track and
  // P_button_04's material plays P_button_00's colour track
  const id = force && bindPane ? bindPane.slice(-2) : null
  for (const e of A.entries) {
    const name: string = id ? e.name.slice(0, Math.max(0, e.name.length - 2)) + id : e.name
    for (const tag of e.tags)
      for (const tg of tag.targets) {
        const v = evalTarget(tg, frame)
        if (v === null) continue
        const t = tg.target
        if (tag.type === 'RLPA') {
          const p = panes[name]
          if (!p) continue
          if (t <= 2) p.translate[t] = v
          else if (t <= 5) p.rotate[t - 3] = v
          else if (t <= 7) p.scale[t - 6] = v
          else p.size[t - 8] = v
        } else if (tag.type === 'RLVC') {
          const p = panes[name]
          if (!p) continue
          if (t === 16) {
            p.alpha = clamp8(v)
            continue
          }
          const corner = t >> 2
          const ch = t & 3
          if (p.type === 'pic') p.vertexColors[corner][ch] = clamp8(v)
          else if (p.type === 'wnd') p.content.vertexColors[corner][ch] = clamp8(v)
          else if (p.type === 'txt') (corner < 2 ? p.topColor : p.bottomColor)[ch] = clamp8(v)
        } else if (tag.type === 'RLVI') {
          const p = panes[name]
          if (p) p.visible = !!v
        } else if (tag.type === 'RLMC') {
          const m = mats[name]
          if (!m) continue
          const grp = t >> 2
          const ch = t & 3
          if (grp === 0) m.materialColor[ch] = clamp8(v)
          else if (grp <= 3) m.tevColors[grp - 1][ch] = v
          else m.konstColors[grp - 4][ch] = clamp8(v)
        } else if (tag.type === 'RLTS') {
          const m = mats[name]
          if (!m || !m.texSRT[tg.index]) continue
          const s = m.texSRT[tg.index]
          if (t <= 1) s.translate[t] = v
          else if (t === 2) s.rotate = v
          else s.scale[t - 3] = v
        } else if (tag.type === 'RLTP') {
          const m = mats[name]
          if (!m || !m.texMaps[tg.index]) continue
          m.texMaps[tg.index].file = A.textureFiles[v]
        }
      }
  }
}

// ---- shading -----------------------------------------------------------------

/**
 * Rendering options. Classic: the console's own pixels (bitmap fonts, textures at their size,
 * shaded quads at 2 px per layout unit). Modern: vector text in the bundled web font,
 * textures upscaled with edge-preserving filtering, quads shaded at the display resolution.
 */
export const lytOptions = {
  vectorText: false,
  hiresTextures: false,
  /** panes spanning the whole 16:9 screen (backdrops, bands) extend to cover any window shape */
  coverScreen: false,
}

/** shaded quads are rendered at this many pixels per layout unit */
let QUALITY = 2

/** pixels per layout unit of the display (modern rendering shades at the device resolution) */
export function setLytResolution(pxPerUnit: number) {
  const q = lytOptions.hiresTextures ? Math.max(1, Math.min(4, Math.ceil(pxPerUnit * 4) / 4)) : 2
  if (q !== QUALITY) {
    QUALITY = q
    shadeCache.clear()
  }
}

/** the texture as sampled: upscaled in modern rendering (sizes in layout units stay T.width / scale) */
function texOf(T: Img): Img & { scale?: number } {
  return lytOptions.hiresTextures ? upscaled(T) : T
}
const shadeCache = new Map<string, HTMLCanvasElement>()

function texFileOf(R: LytRes, m: Json, i: number): string | null {
  const tm = m.texMaps[i]
  return tm ? tm.file || R.L.textureFiles[tm.texture] : null
}

function wrapc(x: number, n: number, mode: string) {
  if (mode === 'repeat') {
    x %= n
    return x < 0 ? x + n : x
  }
  if (mode === 'mirror') {
    const p = 2 * n
    x %= p
    if (x < 0) x += p
    return x < n ? x : p - 1 - x
  }
  return x < 0 ? 0 : x >= n ? n - 1 : x
}

function texMtx(srt: Json) {
  if (!srt) return [1, 0, 0, 0, 1, 0]
  const r = (srt.rotate * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  const a = srt.scale[0] * c
  const b = -srt.scale[1] * s
  const d = srt.scale[0] * s
  const e = srt.scale[1] * c
  return [a, b, srt.translate[0] + 0.5 - 0.5 * a - 0.5 * b, d, e, srt.translate[1] + 0.5 - 0.5 * d - 0.5 * e]
}

function shadeQuad(R: LytRes, m: Json, tc: number[][] | null, vc: number[][], rw: number, rh: number) {
  const file = texFileOf(R, m, 0)
  const key = JSON.stringify([file, m.tevColors, m.materialColor, m.texSRT[0], m.texMaps[0] && [m.texMaps[0].wrapS, m.texMaps[0].wrapT], tc, vc, rw, rh, lytOptions.hiresTextures])
  let c = shadeCache.get(key)
  if (c) return c
  c = document.createElement('canvas')
  c.width = rw
  c.height = rh
  const x = c.getContext('2d')!
  const out = x.createImageData(rw, rh)
  const o = out.data
  const T = file && R.tex[file] ? texOf(R.tex[file]) : null
  const [c0, c1] = m.tevColors
  const mc = m.materialColor
  const M = texMtx(m.texSRT[0])
  const ws = m.texMaps[0] ? m.texMaps[0].wrapS : 'clamp'
  const wt = m.texMaps[0] ? m.texMaps[0].wrapT : 'clamp'
  const t = tc || [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  for (let py = 0; py < rh; py++) {
    const fy = (py + 0.5) / rh
    for (let px = 0; px < rw; px++) {
      const fx = (px + 0.5) / rw
      let tr = 255
      let tg = 255
      let tb = 255
      let ta = 255
      if (T) {
        const u0 = t[0][0] + (t[1][0] - t[0][0]) * fx
        const u1 = t[2][0] + (t[3][0] - t[2][0]) * fx
        const v0 = t[0][1] + (t[1][1] - t[0][1]) * fx
        const v1 = t[2][1] + (t[3][1] - t[2][1]) * fx
        const u = u0 + (u1 - u0) * fy
        const v = v0 + (v1 - v0) * fy
        const uu = M[0] * u + M[1] * v + M[2]
        const vv = M[3] * u + M[4] * v + M[5]
        const sx = uu * T.width - 0.5
        const sy = vv * T.height - 0.5
        const ix = Math.floor(sx)
        const iy = Math.floor(sy)
        const ax = sx - ix
        const ay = sy - iy
        const x0 = wrapc(ix, T.width, ws)
        const x1 = wrapc(ix + 1, T.width, ws)
        const y0 = wrapc(iy, T.height, wt)
        const y1 = wrapc(iy + 1, T.height, wt)
        const d = T.data
        const W = T.width
        const i00 = (y0 * W + x0) * 4
        const i10 = (y0 * W + x1) * 4
        const i01 = (y1 * W + x0) * 4
        const i11 = (y1 * W + x1) * 4
        const w00 = (1 - ax) * (1 - ay)
        const w10 = ax * (1 - ay)
        const w01 = (1 - ax) * ay
        const w11 = ax * ay
        tr = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11
        tg = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11
        tb = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11
        ta = d[i00 + 3] * w00 + d[i10 + 3] * w10 + d[i01 + 3] * w01 + d[i11 + 3] * w11
      }
      let r: number, g: number, b: number, a: number
      if (T) {
        r = c0[0] + ((c1[0] - c0[0]) * tr) / 255
        g = c0[1] + ((c1[1] - c0[1]) * tg) / 255
        b = c0[2] + ((c1[2] - c0[2]) * tb) / 255
        a = c0[3] + ((c1[3] - c0[3]) * ta) / 255
      } else {
        r = c1[0]
        g = c1[1]
        b = c1[2]
        a = c1[3]
      }
      const k = (i: number) => (vc[0][i] + (vc[1][i] - vc[0][i]) * fx) * (1 - fy) + (vc[2][i] + (vc[3][i] - vc[2][i]) * fx) * fy
      const q = (py * rw + px) * 4
      o[q] = (r * k(0) * mc[0]) / 65025
      o[q + 1] = (g * k(1) * mc[1]) / 65025
      o[q + 2] = (b * k(2) * mc[2]) / 65025
      o[q + 3] = (a * k(3) * mc[3]) / 65025
    }
  }
  x.putImageData(out, 0, 0)
  if (shadeCache.size > 3000) shadeCache.clear()
  shadeCache.set(key, c)
  return c
}

const glyphCache = new Map<string, HTMLCanvasElement>()

/** one glyph cell of a font sheet, upscaled (hi-res rendering of the button icons) */
const glyphCells = new Map<string, Img>()
function glyphCell(F: { info: Json; img: Img }, g: Json): Img {
  const key = F.info.name + ':' + g.index
  let c = glyphCells.get(key)
  if (!c) {
    const w = Math.max(1, g.glyphWidth)
    const h = F.info.cellHeight
    const cell = new ImageData(w, h)
    const W = F.img.width
    for (let y = 0; y < h; y++) {
      const s = ((g.y + y) * W + g.x) * 4
      cell.data.set(F.img.data.subarray(s, s + w * 4), y * w * 4)
    }
    glyphCells.set(key, (c = upscaled(cell)))
  }
  return c
}

function shadeGlyph(F: { info: Json; img: Img }, g: Json, m: Json, top: number[], bot: number[]) {
  const hi = lytOptions.hiresTextures
  const key = F.info.name + ':' + g.index + ':' + m.tevColors[0] + m.tevColors[1] + ':' + top + ':' + bot + ':' + m.materialColor + ':' + hi
  let c = glyphCache.get(key)
  if (c) return c
  const src = hi ? glyphCell(F, g) : null
  const w = src ? src.width : Math.max(1, g.glyphWidth)
  const h = src ? src.height : F.info.cellHeight
  c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d')!
  const out = x.createImageData(w, h)
  const o = out.data
  const d = src ? src.data : F.img.data
  const W = src ? src.width : F.img.width
  const gx = src ? 0 : g.x
  const gy = src ? 0 : g.y
  const [c0, c1] = m.tevColors
  const mc = m.materialColor
  for (let py = 0; py < h; py++) {
    const fy = (py + 0.5) / h
    const vc = [0, 1, 2, 3].map((i) => top[i] + (bot[i] - top[i]) * fy)
    for (let px = 0; px < w; px++) {
      const s = ((gy + py) * W + gx + px) * 4
      const q = (py * w + px) * 4
      for (let i = 0; i < 4; i++) {
        const tv = d[s + (i === 3 ? 3 : i)] / 255
        o[q + i] = ((c0[i] + (c1[i] - c0[i]) * tv) * vc[i] * mc[i]) / 65025
      }
    }
  }
  x.putImageData(out, 0, 0)
  if (glyphCache.size > 5000) glyphCache.clear()
  glyphCache.set(key, c)
  return c
}

// ---- drawing -----------------------------------------------------------------

function paneRect(p: Json) {
  const [w, h] = p.size
  const hx = p.origin % 3
  const vy = Math.floor(p.origin / 3)
  return { x: (-w * hx) / 2, top: (h * vy) / 2, w, h } // y-up: rect spans top .. top-h
}

function blit(ctx: CanvasRenderingContext2D, img: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, x: number, top: number, w: number, h: number) {
  if (!sw || !sh || !w || !h) return
  ctx.save()
  ctx.translate(x, top)
  ctx.scale(w / sw, -h / sh)
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)
  ctx.restore()
}

type DrawCtx = { R: LytRes; L: Json; text: Record<string, string>; wideX: number; /** pixels per layout unit, when extending full-screen panes */ unitPx: number }

type Rect = ReturnType<typeof paneRect>

/** full-screen panes (>= the 16:9 width / height): the local rect that also covers the canvas */
function coverRect(ctx: CanvasRenderingContext2D, D: DrawCtx, rect: Rect): Rect | null {
  if (!D.unitPx) return null
  const M = ctx.getTransform()
  const gw = (Math.abs(rect.w) * Math.hypot(M.a, M.b)) / D.unitPx
  const gh = (Math.abs(rect.h) * Math.hypot(M.c, M.d)) / D.unitPx
  const ex = gw >= 828
  const ey = gh >= 450 && ex
  if (!ex) return null
  const inv = M.inverse()
  const W = ctx.canvas.width
  const H = ctx.canvas.height
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const [px, py] of [
    [0, 0],
    [W, 0],
    [0, H],
    [W, H],
  ]) {
    const q = inv.transformPoint(new DOMPoint(px, py))
    x0 = Math.min(x0, q.x)
    x1 = Math.max(x1, q.x)
    y0 = Math.min(y0, q.y)
    y1 = Math.max(y1, q.y)
  }
  const r = { ...rect }
  const left = Math.min(rect.x, x0 - 1)
  r.w = Math.max(rect.x + rect.w, x1 + 1) - left
  r.x = left
  if (ey) {
    const top = Math.max(rect.top, y1 + 1)
    r.h = top - Math.min(rect.top - rect.h, y0 - 1)
    r.top = top
  }
  return r
}

function resolveText(D: DrawCtx, p: Json): string {
  if (p.name in D.text) return D.text[p.name]
  const b = D.L.textBindings?.[p.name]
  if (!b) return p.text
  let s: string = b.text !== undefined ? b.text : (MSG[b.msg] ?? p.text)
  const args = (b.args || []).slice()
  s = s.replace(/\{num\}/g, () => (args.length ? String(args.shift()) : '0')).replace(/\{player\}/g, '')
  return s.replace(/\{(win|tag):[^}]*\}/g, '')
}

function drawText(ctx: CanvasRenderingContext2D, D: DrawCtx, p: Json, rect: ReturnType<typeof paneRect>) {
  const F = D.R.fonts[p.font]
  if (!F) return
  const fi = F.info
  const m = D.L.materials[p.material]
  const vf = lytOptions.vectorText ? vectorFontOf(fi) : null
  const sx = p.fontSize[0] / fi.width
  const sy = p.fontSize[1] / fi.height
  const lines = resolveText(D, p).split('\n')
  const glyph = (ch: string) => fi.glyphs[ch.codePointAt(0)!] || null
  const lw = lines.map((l) => {
    let w = 0
    let n = 0
    for (const ch of l) {
      const g = glyph(ch)
      w += (g ? g.charWidth : fi.defaultWidth.charWidth) * sx + p.charSpace
      n++
    }
    return n ? w - p.charSpace : 0
  })
  const bw = Math.max(0, ...lw)
  const lh = fi.lineFeed * sy + p.lineSpace
  const bh = lines.length * fi.lineFeed * sy + (lines.length - 1) * p.lineSpace
  const hx = p.textPosition % 3
  const vy = Math.floor(p.textPosition / 3)
  const bx = rect.x + ((rect.w - bw) * hx) / 2
  let y = rect.top - ((rect.h - bh) * vy) / 2
  lines.forEach((l, i) => {
    let x = bx + ((bw - lw[i]) * hx) / 2
    if (vf) {
      // each character centred where the bitmap glyph's cell would be; controller button icons
      // (private use area) keep their bitmap glyph, smoothly upscaled
      drawVectorText(ctx, vf, l, x, y, sx, sy, p.charSpace, fi, m, p.topColor, p.bottomColor, (ch, g, gx) => {
        const c = shadeGlyph(F, g, m, p.topColor, p.bottomColor)
        blit(ctx, c, 0, 0, c.width, c.height, gx + g.left * sx, y, g.glyphWidth * sx, fi.cellHeight * sy)
        void ch
      })
      y -= lh
      return
    }
    for (const ch of l) {
      const g = glyph(ch)
      if (g) {
        const c = shadeGlyph(F, g, m, p.topColor, p.bottomColor)
        blit(ctx, c, 0, 0, c.width, c.height, x + g.left * sx, y, g.glyphWidth * sx, fi.cellHeight * sy)
        x += g.charWidth * sx + p.charSpace
      } else x += fi.defaultWidth.charWidth * sx + p.charSpace
    }
    y -= lh
  })
}

const shadeSize = (v: number) => Math.max(1, Math.min(2048, Math.ceil(Math.abs(v) * QUALITY)))

// Fast path: when the vertex colours are uniform the TEV output is a per-texel function,
// so shade the texture once and draw it as a pattern through the texcoord/SRT affine map.
const texShadeCache = new Map<string, HTMLCanvasElement>()
const patternCache = new WeakMap<HTMLCanvasElement, CanvasPattern>()

function uniform(vc: number[][]) {
  return vc.every((c) => c[0] === vc[0][0] && c[1] === vc[0][1] && c[2] === vc[0][2] && c[3] === vc[0][3])
}

function shadeTexture(T: Img, file: string, m: Json, vc: number[], mirrorS: boolean, mirrorT: boolean) {
  const key = JSON.stringify([file, m.tevColors[0], m.tevColors[1], m.materialColor, vc, mirrorS, mirrorT])
  let c = texShadeCache.get(key)
  if (c) return c
  const tw = T.width
  const th = T.height
  c = document.createElement('canvas')
  c.width = tw * (mirrorS ? 2 : 1)
  c.height = th * (mirrorT ? 2 : 1)
  const x = c.getContext('2d')!
  const out = x.createImageData(c.width, c.height)
  const o = out.data
  const d = T.data
  const [c0, c1] = m.tevColors
  const mc = m.materialColor
  const f = [0, 1, 2, 3].map((i) => (vc[i] * mc[i]) / 65025)
  for (let py = 0; py < c.height; py++) {
    const sy = py < th ? py : 2 * th - 1 - py
    for (let px = 0; px < c.width; px++) {
      const sx = px < tw ? px : 2 * tw - 1 - px
      const s = (sy * tw + sx) * 4
      const q = (py * c.width + px) * 4
      for (let i = 0; i < 4; i++) o[q + i] = (c0[i] + ((c1[i] - c0[i]) * d[s + i]) / 255) * f[i]
    }
  }
  x.putImageData(out, 0, 0)
  if (texShadeCache.size > 2000) texShadeCache.clear()
  texShadeCache.set(key, c)
  return c
}

function fastQuad(ctx: CanvasRenderingContext2D, R: LytRes, m: Json, tc: number[][] | null, vc: number[][], rect: ReturnType<typeof paneRect>, fill: Rect = rect) {
  if (!uniform(vc)) return false
  const file = texFileOf(R, m, 0)
  const T = file && R.tex[file] ? texOf(R.tex[file]) : null
  if (!T) {
    const c1 = m.tevColors[1]
    const mc = m.materialColor
    const k = (i: number) => (c1[i] * vc[0][i] * mc[i]) / 65025
    ctx.fillStyle = `rgba(${k(0)},${k(1)},${k(2)},${k(3) / 255})`
    ctx.fillRect(fill.x, fill.top - fill.h, fill.w, fill.h)
    return true
  }
  const tm = m.texMaps[0]
  // clamp-to-edge outside [0,1] has no canvas-pattern equivalent: use the exact path
  if (tc && (tm?.wrapS === 'clamp' || tm?.wrapT === 'clamp')) {
    const M0 = texMtx(m.texSRT[0])
    for (const [u, v] of tc) {
      const uu = M0[0] * u + M0[1] * v + M0[2]
      const vv = M0[3] * u + M0[4] * v + M0[5]
      if ((tm.wrapS === 'clamp' && (uu < -1e-6 || uu > 1 + 1e-6)) || (tm.wrapT === 'clamp' && (vv < -1e-6 || vv > 1 + 1e-6))) return false
    }
  }
  const mirS = tm?.wrapS === 'mirror'
  const mirT = tm?.wrapT === 'mirror'
  // vertex alpha is a plain multiply: draw with globalAlpha instead of a re-shaded texture per
  // animation frame
  const va = vc[0][3]
  const S = shadeTexture(T, file!, m, va > 0 ? [vc[0][0], vc[0][1], vc[0][2], 255] : vc[0], mirS, mirT)
  let pat = patternCache.get(S)
  if (!pat) {
    const rep = tm?.wrapS === 'clamp' && tm?.wrapT === 'clamp' ? 'no-repeat' : 'repeat'
    pat = ctx.createPattern(S, rep)!
    patternCache.set(S, pat)
  }
  const t = tc || [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]
  const M = texMtx(m.texSRT[0])
  // (fx, fy) in the quad -> texture pixel
  const uvA = new DOMMatrix([t[1][0] - t[0][0], t[1][1] - t[0][1], t[2][0] - t[0][0], t[2][1] - t[0][1], t[0][0], t[0][1]])
  const srt = new DOMMatrix([M[0], M[3], M[1], M[4], M[2], M[5]])
  const px = new DOMMatrix([T.width, 0, 0, T.height, 0, 0])
  const A = px.multiply(srt).multiply(uvA)
  // (fx, fy) -> local rect coordinates (y up)
  const Lm = new DOMMatrix([rect.w, 0, 0, -rect.h, rect.x, rect.top])
  pat.setTransform(Lm.multiply(A.inverse()))
  ctx.fillStyle = pat
  const ga = ctx.globalAlpha
  if (va > 0) ctx.globalAlpha = (ga * va) / 255
  ctx.fillRect(fill.x, fill.top - fill.h, fill.w, fill.h)
  ctx.globalAlpha = ga
  return true
}

function drawPic(ctx: CanvasRenderingContext2D, D: DrawCtx, p: Json, rect: ReturnType<typeof paneRect>) {
  const m = D.L.materials[p.material]
  const cover = coverRect(ctx, D, rect)
  // clamped textures would smear across the extension: only tiled textures and flat colours extend
  const tm = m.texMaps[0]
  const fill = cover && (!tm || (tm.wrapS !== 'clamp' && (cover.h === rect.h || tm.wrapT !== 'clamp'))) ? cover : rect
  if (fastQuad(ctx, D.R, m, p.texCoords[0] || null, p.vertexColors, rect, fill)) return
  const rw = shadeSize(rect.w)
  const rh = shadeSize(rect.h)
  const c = shadeQuad(D.R, m, p.texCoords[0] || null, p.vertexColors, rw, rh)
  blit(ctx, c, 0, 0, rw, rh, rect.x, rect.top, rect.w, rect.h)
}

const WHITE4 = [
  [255, 255, 255, 255],
  [255, 255, 255, 255],
  [255, 255, 255, 255],
  [255, 255, 255, 255],
]

function drawWindow(ctx: CanvasRenderingContext2D, D: DrawCtx, p: Json, rect: ReturnType<typeof paneRect>) {
  const R = D.R
  const fm = D.L.materials[p.frames[0].material]
  const file = texFileOf(R, fm, 0)
  const T0 = file && R.tex[file]
  const T = T0 ? texOf(T0) : null
  // frame size in layout units (the texture's own size) and in texels of the sampled texture
  const fw = T0 ? T0.width : 0
  const fh = T0 ? T0.height : 0
  const pw = T ? T.width : 0
  const ph = T ? T.height : 0
  const cm = D.L.materials[p.content.material]
  const inf = p.inflation
  const cx = rect.x + fw - inf.l
  const ctop = rect.top - fh + inf.t
  const cw = rect.w - 2 * fw + inf.l + inf.r
  const ch = rect.h - 2 * fh + inf.t + inf.b
  if (cw > 0 && ch > 0 && !fastQuad(ctx, R, cm, p.content.texCoords[0] || null, p.content.vertexColors, { x: cx, top: ctop, w: cw, h: ch })) {
    const c = shadeQuad(R, cm, p.content.texCoords[0] || null, p.content.vertexColors, shadeSize(cw), shadeSize(ch))
    blit(ctx, c, 0, 0, c.width, c.height, cx, ctop, cw, ch)
  }
  if (!T) return
  const corners = [0, 1, 2, 3].map((i) => {
    const f = p.frames[Math.min(i, p.frames.length - 1)]
    return shadeQuad(R, D.L.materials[f.material], null, WHITE4, pw, ph)
  })
  const F = corners[0]
  const n = p.frames.length
  const flip = [
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ]
  const W = rect.w
  const H = rect.h
  const x0 = rect.x
  const t0 = rect.top
  const pos = [
    [x0, t0],
    [x0 + W, t0],
    [x0, t0 - H],
    [x0 + W, t0 - H],
  ]
  for (let i = 0; i < 4; i++) {
    const img = n === 1 ? F : corners[i]
    const [fx, fy] = n === 1 ? flip[i] : [1, 1]
    const ox = n === 1 ? pos[i][0] : i & 1 ? x0 + W - fw : x0
    const oy = n === 1 ? pos[i][1] : i & 2 ? t0 - H + fh : t0
    blit(ctx, img, 0, 0, pw, ph, ox, oy, fw * fx, fh * fy)
  }
  if (n !== 1) return
  const ew = W - 2 * fw
  const eh = H - 2 * fh
  if (ew > 0) {
    blit(ctx, F, pw - 1, 0, 1, ph, x0 + fw, t0, ew, fh)
    blit(ctx, F, pw - 1, 0, 1, ph, x0 + fw, t0 - H, ew, -fh)
  }
  if (eh > 0) {
    blit(ctx, F, 0, ph - 1, pw, 1, x0, t0 - fh, fw, eh)
    blit(ctx, F, 0, ph - 1, pw, 1, x0 + W, t0 - fh, -fw, eh)
  }
}

function drawPane(ctx: CanvasRenderingContext2D, D: DrawCtx, p: Json, parentAlpha: number, hook?: PaneHook) {
  if (!p.visible) return
  ctx.save()
  // panes flagged locationAdjust keep their distance from the screen edge in 16:9
  ctx.translate(p.translate[0] * (p.locationAdjust ? D.wideX : 1), p.translate[1])
  const rx = (p.rotate[0] * Math.PI) / 180
  const ry = (p.rotate[1] * Math.PI) / 180
  ctx.rotate((p.rotate[2] * Math.PI) / 180)
  ctx.scale(p.scale[0] * Math.cos(ry), p.scale[1] * Math.cos(rx))
  // nw4r Pane::CalculateMtx: only panes with influencedAlpha pass their alpha to children
  const alpha = (p.alpha / 255) * parentAlpha
  const childAlpha = p.influencedAlpha ? alpha : parentAlpha
  const rect = paneRect(p)
  if (alpha > 0.001) {
    ctx.globalAlpha = alpha
    if (p.type === 'pic') drawPic(ctx, D, p, rect)
    else if (p.type === 'txt') drawText(ctx, D, p, rect)
    else if (p.type === 'wnd') drawWindow(ctx, D, p, rect)
    hook?.(p.name, ctx, alpha)
  }
  for (const c of p.children) drawPane(ctx, D, c, childAlpha, hook)
  ctx.restore()
}

/** called for every drawn pane with the pane transform applied (for Mii heads, icons, …) */
export type PaneHook = (name: string, ctx: CanvasRenderingContext2D, alpha: number) => void

type Bound = { name: string; frame: number; bind?: string; rate: number; loop: boolean; running: boolean; force: boolean }

/**
 * A live layout with nw4r semantics: panes hold their current state; every
 * calc() applies each bound animation at its frame on top of it, so unbinding
 * an animation leaves its panes where it last put them.
 */
export class Lyt {
  private bound = new Map<string, Bound>()
  L: Json
  text: Record<string, string> = {}
  hook?: PaneHook
  private panes = new Map<string, Json>()

  constructor(public R: LytRes) {
    this.L = structuredClone(R.L)
    this.index()
  }

  private index() {
    this.panes.clear()
    const w = (p: Json) => {
      this.panes.set(p.name, p)
      p.children.forEach(w)
    }
    w(this.L.root)
  }

  /** RPSysLayout::reset: back to the authored state, everything unbound */
  reset() {
    this.L = structuredClone(this.R.L)
    this.index()
    this.bound.clear()
    this.text = {}
  }

  pane(name: string): Json {
    const p = this.panes.get(name)
    if (!p) throw new Error(`${this.R.name}: no pane ${name}`)
    return p
  }

  /**
   * bindAnmObj(ToPane) + restart. `key` identifies the binding (defaults to the
   * anim name); rebinding the same key replaces it.
   */
  play(name: string, opts: { bind?: string; rate?: number; loop?: boolean; key?: string; frame?: number; force?: boolean } = {}) {
    const A = this.R.anims[name]
    if (!A) throw new Error(`${this.R.name}: no anim ${name}`)
    const key = opts.key ?? name
    this.bound.delete(key)
    this.bound.set(key, { name, frame: opts.frame ?? 0, bind: opts.bind, rate: opts.rate ?? 1, loop: opts.loop ?? !!A.loop, running: true, force: !!opts.force })
  }

  unbind(key: string) {
    this.bound.delete(key)
  }

  unbindAll() {
    this.bound.clear()
  }

  setRate(key: string, rate: number) {
    const b = this.bound.get(key)
    if (b) b.rate = rate
  }

  /** isFinished: a one-time animation at its last frame (unbound counts as finished) */
  done(key: string) {
    const b = this.bound.get(key)
    if (!b) return true
    if (b.loop) return false
    return b.frame >= this.R.anims[b.name].frameSize - 1
  }

  isBound(key: string) {
    return this.bound.has(key)
  }

  frameOf(key: string) {
    return this.bound.get(key)?.frame ?? -1
  }

  setVisible(pane: string, v: boolean) {
    this.pane(pane).visible = v
  }
  setAlpha(pane: string, a: number) {
    this.pane(pane).alpha = a
  }
  setTranslate(pane: string, x: number, y: number) {
    const p = this.pane(pane)
    p.translate[0] = x
    p.translate[1] = y
  }
  setText(pane: string, s: string) {
    this.text[pane] = s
  }

  /** RPSysLayout::calc: apply bound animations, then advance their frames */
  calc() {
    for (const b of this.bound.values()) {
      const A = this.R.anims[b.name]
      applyAnim(this.L, A, Math.min(Math.floor(b.frame), A.frameSize - 1), b.bind, b.force)
    }
    for (const b of this.bound.values()) {
      if (!b.running) continue
      const n = this.R.anims[b.name].frameSize
      b.frame += b.rate
      if (b.loop) b.frame %= n
      else if (b.frame > n - 1) b.frame = n - 1
    }
  }

  /**
   * Draw into ctx, whose transform maps layout units (origin centre, y up) to pixels.
   * wideX: horizontal factor for locationAdjust panes (832/608 in 16:9).
   */
  draw(ctx: CanvasRenderingContext2D, wideX = 1) {
    const M = ctx.getTransform()
    const unitPx = lytOptions.coverScreen ? Math.hypot(M.a, M.b) : 0
    drawPane(ctx, { R: this.R, L: this.L, text: this.text, wideX, unitPx }, this.L.root, 1, this.hook)
  }
}
