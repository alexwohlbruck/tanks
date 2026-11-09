// 2D stand-ins for RPMedalResult's 3D medal (medal_model.brres: medal_tex face shaded with the
// env_<metal> sphere map) and RPVsWinner's 3D "P1 WINS" / "P2 WINS" / "TIE" letters
// (win_1P/win_2P/tie_model.brres). The textures are the models' own TEX0s, extracted to
// public/assets/ui/textures/{medal,vsWinner}; without them a flat fallback is drawn.

import { loadImage } from './common'

const BASE = 'assets/ui/textures/'
const METALS = ['bronze', 'silver', 'gold', 'platinum'] as const
const FALLBACK = ['#c07a44', '#c9d0d8', '#f0c030', '#e6eefa']

let faceTex: HTMLImageElement | null = null
const envTex: (HTMLImageElement | null)[] = []
const letterTex = new Map<string, HTMLImageElement | null>()
let loaded: Promise<void> | null = null

export function loadTrophyTextures() {
  loaded ??= (async () => {
    faceTex = await loadImage(BASE + 'medal/medal_tex.png')
    for (const m of METALS) envTex.push(await loadImage(BASE + `medal/env_${m}.png`))
    for (const n of ['1', '2', 'P1', 'W1', 'I0', 'N0', 'S0', 'T1', 'E0']) letterTex.set(n, await loadImage(BASE + `vsWinner/issue_txt_${n}.png`))
  })()
  return loaded
}

const medalCache = new Map<number, HTMLCanvasElement>()

/** the medal face for rank 1..4, 256 x 256 */
function medalCanvas(rank: number) {
  let c = medalCache.get(rank)
  if (c) return c
  c = document.createElement('canvas')
  c.width = c.height = 256
  const g = c.getContext('2d')!
  const env = envTex[rank - 1]
  g.save()
  g.beginPath()
  g.arc(128, 128, 120, 0, Math.PI * 2)
  g.clip()
  // metal: the env sphere map stretched over the disc (what a front-facing medal reflects)
  if (env) {
    g.imageSmoothingEnabled = true
    g.drawImage(env, 0, 0, 256, 256)
  } else {
    const gr = g.createRadialGradient(100, 90, 10, 128, 128, 140)
    gr.addColorStop(0, '#fff')
    gr.addColorStop(0.35, FALLBACK[rank - 1])
    gr.addColorStop(1, '#555')
    g.fillStyle = gr
    g.fillRect(0, 0, 256, 256)
  }
  // relief: TEXC modulates the reflection
  if (faceTex) {
    g.globalCompositeOperation = 'multiply'
    g.drawImage(faceTex, 0, 0, 256, 256)
    g.globalCompositeOperation = 'source-over'
  }
  g.restore()
  g.strokeStyle = 'rgba(0,0,0,0.35)'
  g.lineWidth = 3
  g.beginPath()
  g.arc(128, 128, 119, 0, Math.PI * 2)
  g.stroke()
  medalCache.set(rank, c)
  return c
}

/**
 * The medal at (x, y), `radius` layout units. medal_appear (11 frames) pops it in with a spin,
 * medal_wait (300-frame loop) sways it about the vertical axis.
 */
export function drawMedal(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, rank: number, frame: number, alpha = 1) {
  if (rank < 1 || rank > 4 || alpha <= 0) return
  const appear = Math.min(1, frame / 11)
  const s = appear < 1 ? 1 - Math.pow(1 - appear, 3) : 1
  const spin = appear < 1 ? (1 - appear) * Math.PI * 2 : (Math.sin(((frame - 11) / 300) * Math.PI * 2) * 0.35)
  const sx = Math.max(0.06, Math.abs(Math.cos(spin)))
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, y)
  // glow (Bcm_mdl_*_glow)
  const glow = ctx.createRadialGradient(0, 0, radius * 0.6, 0, 0, radius * 1.7)
  glow.addColorStop(0, 'rgba(255,255,230,0.55)')
  glow.addColorStop(1, 'rgba(255,255,230,0)')
  ctx.fillStyle = glow
  ctx.beginPath()
  ctx.arc(0, 0, radius * 1.7 * s, 0, Math.PI * 2)
  ctx.fill()
  // edge (the coin's thickness)
  ctx.save()
  ctx.scale(s, s)
  ctx.fillStyle = ['#7a4520', '#80868e', '#a87810', '#9aa6b8'][rank - 1]
  ctx.beginPath()
  ctx.ellipse(radius * 0.06 * Math.sign(Math.sin(spin) || 1) * (1 - sx), -radius * 0.03, radius * Math.max(sx, 0.12), radius, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.scale(sx, -1)
  ctx.drawImage(medalCanvas(rank), -radius, -radius, radius * 2, radius * 2)
  ctx.restore()
  // sparkles (Bcm_mdl_*_kira)
  if (appear >= 1) {
    for (let i = 0; i < 4; i++) {
      const ph = (frame * 0.035 + i * 0.25) % 1
      const a = Math.sin(ph * Math.PI)
      const ang = i * 1.9 + Math.floor((frame * 0.035 + i * 0.25) / 1) * 2.3
      const r = radius * (0.55 + 0.35 * ((i * 37) % 10) / 10)
      sparkle(ctx, Math.cos(ang) * r, Math.sin(ang) * r, radius * 0.18 * a, a)
    }
  }
  ctx.restore()
}

function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
  if (r <= 0.5) return
  ctx.save()
  ctx.globalAlpha *= a
  ctx.fillStyle = '#fff'
  ctx.translate(x, y)
  ctx.beginPath()
  ctx.moveTo(0, r)
  ctx.quadraticCurveTo(0, 0, r, 0)
  ctx.quadraticCurveTo(0, 0, 0, -r)
  ctx.quadraticCurveTo(0, 0, -r, 0)
  ctx.quadraticCurveTo(0, 0, 0, r)
  ctx.fill()
  ctx.restore()
}

// ---- RPVsWinner trophy text -----------------------------------------------------------------

/** letters, their texture and the x / y of their bone in model units (from the MDL0s) */
const WORDS: Record<number, { tex: string; w: number; x: number; y: number }[]> = {
  0: [
    { tex: 'P1', w: 1, x: -9.72, y: 0.03 },
    { tex: '1', w: 0.5, x: -5.99, y: 0.03 },
    { tex: 'W1', w: 1, x: 0.86, y: -0.11 },
    { tex: 'I0', w: 0.25, x: 4.31, y: -0.11 },
    { tex: 'N0', w: 1, x: 6.88, y: -0.63 },
    { tex: 'S0', w: 1, x: 10.06, y: -0.66 },
  ],
  1: [
    { tex: 'P1', w: 1, x: -9.72, y: 0.03 },
    { tex: '2', w: 1, x: -5.99, y: 0.03 },
    { tex: 'W1', w: 1, x: 0.86, y: -0.11 },
    { tex: 'I0', w: 0.25, x: 4.31, y: -0.11 },
    { tex: 'N0', w: 1, x: 6.88, y: -0.63 },
    { tex: 'S0', w: 1, x: 10.06, y: -0.66 },
  ],
  [-1]: [
    { tex: 'T1', w: 1, x: -2.62, y: 0.03 },
    { tex: 'I0', w: 0.25, x: 0.16, y: 0.03 },
    { tex: 'E0', w: 1, x: 2.76, y: -0.56 },
  ],
}
const FALLBACK_TEXT: Record<string, string> = { P1: 'P', '1': '1', '2': '2', W1: 'W', I0: 'I', N0: 'N', S0: 'S', T1: 'T', E0: 'E' }

/** mt_txt_*: lerp(C1, C0, tex) * 2 */
const COLORS: Record<number, [number[], number[]]> = {
  0: [
    [0, 80, 200],
    [0, 40, 100],
  ],
  1: [
    [255, 32, 0],
    [136, 16, 0],
  ],
  [-1]: [
    [200, 100, 0],
    [100, 50, 0],
  ],
}

const letterCache = new Map<string, HTMLCanvasElement>()

function letterCanvas(tex: string, winner: number, dark: boolean) {
  const key = tex + winner + dark
  let c = letterCache.get(key)
  if (c) return c
  const img = letterTex.get(tex)
  c = document.createElement('canvas')
  c.width = img ? img.width : 64
  c.height = 64
  const g = c.getContext('2d')!
  const [c0, c1] = COLORS[winner]
  if (img) {
    // The texture shades the letter's front face (TEXC = 0 inside the stroke, 255 on the bevel and
    // beyond); the silhouette comes from the mesh, so it is rebuilt here: the stroke grown by
    // the bevel width.
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height)
    const p = d.data
    const W = c.width
    const H = c.height
    const inside = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) inside[i] = p[i * 4] < 240 ? 1 : 0
    const R = 3
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let a = 0
        for (let dy = -R; dy <= R && !a; dy++)
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx
            const yy = y + dy
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= R * R + 1 && inside[yy * W + xx]) {
              a = 255
              break
            }
          }
        const i = (y * W + x) * 4
        const t = p[i] / 255
        for (let k = 0; k < 3; k++) {
          const v = Math.min(255, (c1[k] + (c0[k] - c1[k]) * t) * 2)
          p[i + k] = dark ? v * 0.45 : v
        }
        p[i + 3] = a
      }
    g.putImageData(d, 0, 0)
  } else {
    g.font = 'bold 60px sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = `rgb(${c0.map((v) => Math.min(255, v * 2) * (dark ? 0.45 : 1)).join(',')})`
    g.fillText(FALLBACK_TEXT[tex] ?? '?', c.width / 2, 34)
  }
  letterCache.set(key, c)
  return c
}

/**
 * The winner text centred at (x, y); `unit` = layout units per model unit. `frame` counts from
 * the start of win_xP_0 (64 frames: letters drop in one after another); `out` counts win_xP_1
 * (21 frames: they fall away), -1 while not leaving.
 */
export function drawWinnerText(ctx: CanvasRenderingContext2D, x: number, y: number, unit: number, winner: -1 | 0 | 1, frame: number, out: number) {
  const word = WORDS[winner]
  const h = 3.4 * unit
  word.forEach((L, i) => {
    const t0 = i * 6
    const f = frame - t0
    if (f < 0) return
    // drop with an overshoot
    const k = Math.min(1, f / 14)
    const drop = (1 - k) * (1 - k) * 220 - Math.sin(Math.min(1, f / 22) * Math.PI) * 10 * (k >= 1 ? 1 : 0)
    let sc = 1
    let dy = drop
    let a = Math.min(1, f / 6)
    if (out >= 0) {
      const o = Math.max(0, Math.min(1, (out - i * 2) / 12))
      dy -= o * o * 300
      sc = 1 - o * 0.3
      a *= 1 - o
    }
    const idle = out < 0 && frame > 64 ? Math.sin((frame - 64) * 0.08 + i * 0.7) * 2 : 0
    const w = h * L.w
    const lx = x + L.x * unit
    const ly = y + L.y * unit + dy + idle
    ctx.save()
    ctx.globalAlpha = a
    ctx.translate(lx, ly)
    ctx.scale(sc, -sc)
    // extrusion
    const back = letterCanvas(L.tex, winner, true)
    for (let d = 5; d > 0; d--) ctx.drawImage(back, -w / 2 + d * 0.6, -h / 2 + d * 0.9, w, h)
    ctx.drawImage(letterCanvas(L.tex, winner, false), -w / 2, -h / 2, w, h)
    ctx.restore()
  })
}
