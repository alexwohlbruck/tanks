// Vector replacement for the BRFNT bitmap fonts (Rodin DB / EB) in the layout renderer:
// M+ 1 (SIL OFL, public/fonts) at the matching weight, each character centred on the bitmap
// glyph's cell so the layouts keep the original spacing. IA4 fonts carry a two-tone glyph
// (fill where the intensity is 1, outline where it is 0): drawn as a stroke in TEV colour 0
// under a fill in TEV colour 1, both times the vertex colour gradient and material colour.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any

export const FONT_FAMILY = 'Tanks Sans'
const FONT_URL = 'fonts/MPLUS1-latin.woff2'

let loading: Promise<void> | null = null

/** registers the web font for canvas text (the DOM screens get it through CSS) */
export function loadVectorFont() {
  loading ??= (async () => {
    try {
      const f = new FontFace(FONT_FAMILY, `url(${FONT_URL})`, { weight: '100 900' })
      document.fonts.add(f)
      await f.load()
    } catch (e) {
      console.warn('web font', e)
    }
  })()
  return loading
}

export type VectorFont = {
  weight: number
  /** em size in font texels */
  em: number
  /** outline width in font texels (IA4 fonts), 0 for single-tone fonts */
  outline: number
}

const fonts = new Map<string, VectorFont>()

const SAMPLE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
let measure: CanvasRenderingContext2D | null = null

/** the em size (font texels) at which the web font's advances match the bitmap font's */
function calibrate(fi: Json, weight: number, outline: number) {
  measure ??= document.createElement('canvas').getContext('2d')!
  measure.font = `${weight} 100px "${FONT_FAMILY}"`
  let v = 0
  let b = 0
  for (const ch of SAMPLE) {
    const g = fi.glyphs[ch.codePointAt(0)!]
    if (!g) continue
    v += measure.measureText(ch).width
    // the outline widens every bitmap glyph on both sides
    b += g.charWidth - 2 * outline
  }
  return v ? (100 * b) / v : fi.height
}

/** pac_nRodDb_62_IA4 -> Rodin DB: weight, size matched to the glyph advances, outline for IA4 */
export function vectorFontOf(fi: Json): VectorFont {
  let f = fonts.get(fi.name)
  if (!f) {
    const m = /Rod(Db|Eb)_(\d+)_(I4|IA4)/.exec(fi.name)
    const eb = m?.[1] === 'Eb'
    const weight = eb ? 800 : 540
    const outline = m?.[3] === 'IA4' ? (eb ? 2.6 : 2.1) : 0
    f = { weight, em: calibrate(fi, weight, outline), outline }
    // measured with a fallback font until the web font is ready: measure again later
    if (document.fonts.check(`${weight} 10px "${FONT_FAMILY}"`)) fonts.set(fi.name, f)
  }
  return f
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

function rgba(c: number[], vc: number[], mc: number[]) {
  const k = (i: number) => (clamp8(c[i]) * vc[i] * mc[i]) / 65025
  return `rgba(${k(0) | 0},${k(1) | 0},${k(2) | 0},${(k(3) / 255).toFixed(3)})`
}

const same = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

/** wide (full-width) forms -> ASCII, so the digits come from the vector font */
function narrow(cp: number) {
  return cp >= 0xff01 && cp <= 0xff5e ? cp - 0xfee0 : cp === 0x3000 ? 0x20 : cp
}

/** characters the web font draws (Latin, punctuation, full-width forms); the rest are the Wii's
 * button and controller icons (private use area, CJK compatibility squares, …) */
const isIcon = (cp: number) => !(cp < 0x2100 || (cp >= 0xff01 && cp <= 0xff5e) || cp === 0x3000)

/**
 * One line of a text pane. (x, y): left edge and cell top of the line in layout units (y up);
 * sx/sy: layout units per font texel. Icons go to `icon(ch, glyph, x)` (bitmap path).
 */
export function drawVectorText(
  ctx: CanvasRenderingContext2D,
  vf: VectorFont,
  line: string,
  x: number,
  y: number,
  sx: number,
  sy: number,
  charSpace: number,
  fi: Json,
  m: Json,
  top: number[],
  bot: number[],
  icon: (ch: string, g: Json, x: number) => void,
) {
  const [c0, c1] = m.tevColors
  const mc = m.materialColor
  const base = y - fi.baseline * sy
  // in the flipped glyph space (origin on the baseline, y down) the cell spans these
  const cellTop = -fi.baseline
  const cellBot = fi.cellHeight - fi.baseline
  let fill: string | CanvasGradient
  let stroke: string | CanvasGradient
  // IA4: the outline texels have intensity 0 (TEV colour 0) at full coverage, so they take
  // colour 0's RGB with colour 1's alpha
  const c0o = [c0[0], c0[1], c0[2], c1[3]]
  if (same(top, bot)) {
    fill = rgba(c1, top, mc)
    stroke = rgba(c0o, top, mc)
  } else {
    const gf = ctx.createLinearGradient(0, cellTop, 0, cellBot)
    gf.addColorStop(0, rgba(c1, top, mc))
    gf.addColorStop(1, rgba(c1, bot, mc))
    const gs = ctx.createLinearGradient(0, cellTop, 0, cellBot)
    gs.addColorStop(0, rgba(c0o, top, mc))
    gs.addColorStop(1, rgba(c0o, bot, mc))
    fill = gf
    stroke = gs
  }
  const font = `${vf.weight} ${vf.em}px "${FONT_FAMILY}", sans-serif`
  const outline = vf.outline > 0 && clamp8(c1[3]) > 0
  for (const ch of line) {
    const cp = ch.codePointAt(0)!
    const g = fi.glyphs[cp]
    if (!g) {
      x += fi.defaultWidth.charWidth * sx + charSpace
      continue
    }
    if (isIcon(cp)) icon(ch, g, x)
    else if (cp !== 0x20 && cp !== 0x3000) {
      const cx = x + (g.left + g.glyphWidth / 2) * sx
      ctx.save()
      // font texels, y down, origin on the baseline at the glyph centre
      ctx.translate(cx, base)
      ctx.scale(sx, -sy)
      ctx.font = font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      const t = String.fromCodePoint(narrow(cp))
      if (outline) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = vf.outline * 2
        ctx.strokeStyle = stroke
        ctx.strokeText(t, 0, 0)
      }
      ctx.fillStyle = fill
      ctx.fillText(t, 0, 0)
      ctx.restore()
    }
    x += g.charWidth * sx + charSpace
  }
}
