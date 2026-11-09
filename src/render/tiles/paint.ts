// Canvas painters for the Tanks+ toy pieces: crate and gate boards, the felt / ice / water
// sheets and the power-up tokens. Plain 2D canvas (no three.js), so the level editor's tile
// swatches use the same icons and paints as the 3D pieces.

type Ctx = CanvasRenderingContext2D
export type Img = CanvasImageSource | null

/** toy paints (the original's warm, slightly muted palette) */
export const PAINT = {
  cream: '#f2e3c0',
  creamDark: '#d9c399',
  ink: '#3a2a1c',
  iron: '#4a423a',
  red: '#c9392b',
  rubber: '#d9506a',
  mustard: '#dba62e',
  ochre: '#b07a26',
  felt: '#5a3a22',
  water: '#2f6fb0',
  well: '#5a3a92',
  /** teleporters A-D */
  teleport: ['#3a86d0', '#e07a26', '#58a83a', '#c8489a'],
  /** laser emitters: normal / alternate phase */
  laser: ['#b8302a', '#a83878'],
  /** power-ups 0-5 (rapid, ricochet, shield, speed, mines, rockets) */
  power: ['#d4402e', '#3a86c8', '#2fa58a', '#e2b021', '#e0762a', '#8a52b8'],
}

/** deterministic random (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shade(hex: string, k: number, alpha = 1) {
  const n = parseInt(hex.slice(1), 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))))
  return `rgba(${f((n >> 16) & 255)}, ${f((n >> 8) & 255)}, ${f(n & 255)}, ${alpha})`
}

/** the grain of the block texture (inner part of the upper cube's face) stretched over a rect */
export function woodRect(c: Ctx, wood: Img, x: number, y: number, w: number, h: number, tint: string | null = null, rotate = false, upper = true) {
  c.save()
  c.beginPath()
  c.rect(x, y, w, h)
  c.clip()
  if (wood) {
    const iw = (wood as HTMLImageElement).width
    const ih = (wood as HTMLImageElement).height
    const sx = iw * 0.12
    const sy = (upper ? ih * 0.5 : 0) + ih * 0.06
    const sw = iw * 0.76
    const sh = ih * 0.38
    if (rotate) {
      c.translate(x + w, y)
      c.rotate(Math.PI / 2)
      c.drawImage(wood, sx, sy, sw, sh, 0, 0, h, w)
    } else c.drawImage(wood, sx, sy, sw, sh, x, y, w, h)
  } else {
    c.fillStyle = upper ? '#e6c98a' : '#c99a5a'
    c.fillRect(x, y, w, h)
  }
  if (tint) {
    c.globalCompositeOperation = 'multiply'
    c.fillStyle = tint
    c.fillRect(x, y, w, h)
    c.globalCompositeOperation = 'source-over'
  }
  c.restore()
}

/** a soft bevel: light top-left edge, dark bottom-right edge */
function bevel(c: Ctx, x: number, y: number, w: number, h: number, b: number, k = 0.35) {
  c.fillStyle = `rgba(255, 245, 220, ${k})`
  c.fillRect(x, y, w, b)
  c.fillRect(x, y, b, h)
  c.fillStyle = `rgba(60, 30, 10, ${k})`
  c.fillRect(x, y + h - b, w, b)
  c.fillRect(x + w - b, y, b, h)
}

function rivet(c: Ctx, x: number, y: number, r: number) {
  c.fillStyle = '#2a2420'
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fill()
  c.fillStyle = 'rgba(255, 240, 210, 0.55)'
  c.beginPath()
  c.arc(x - r * 0.3, y - r * 0.3, r * 0.45, 0, Math.PI * 2)
  c.fill()
}

/** crate atlas, 2:1: [side face | top face] */
export function paintCrate(c: Ctx, W: number, H: number, wood: Img) {
  const s = H
  for (let f = 0; f < 2; f++) {
    const x0 = f * s
    // planks
    const n = 4
    for (let i = 0; i < n; i++) {
      const y = (i * s) / n
      woodRect(c, wood, x0, y, s, s / n, ['#f4e2bc', '#ead2a4', '#f0dcb4', '#e4c896'][i])
      c.fillStyle = 'rgba(70, 40, 15, 0.55)'
      c.fillRect(x0, y, s, Math.max(1, s * 0.012))
    }
    // frame boards
    const b = s * 0.15
    const frame = (x: number, y: number, w: number, h: number, rot: boolean) => {
      woodRect(c, wood, x, y, w, h, '#d6a868', rot, false)
      bevel(c, x, y, w, h, Math.max(1, s * 0.012))
    }
    frame(x0, 0, s, b, false)
    frame(x0, s - b, s, b, false)
    frame(x0, b, b, s - 2 * b, true)
    frame(x0 + s - b, b, b, s - 2 * b, true)
    if (f === 0) {
      // diagonal brace
      c.save()
      c.beginPath()
      c.rect(x0 + b, b, s - 2 * b, s - 2 * b)
      c.clip()
      c.translate(x0 + s / 2, s / 2)
      c.rotate(-Math.PI / 4)
      const L = s * 1.2
      woodRect(c, wood, -L / 2, -b * 0.45, L, b * 0.9, '#d6a868', false, false)
      bevel(c, -L / 2, -b * 0.45, L, b * 0.9, Math.max(1, s * 0.012))
      c.restore()
    } else {
      // stencilled mark on the lid
      c.save()
      c.translate(x0 + s / 2, s / 2)
      c.fillStyle = 'rgba(176, 52, 36, 0.78)'
      star(c, 0, 0, s * 0.19, s * 0.085, 5)
      c.fill()
      c.restore()
    }
    // iron corner brackets with rivets
    const k = s * 0.2
    const t = s * 0.07
    for (const [cx, cy, sx, sy] of [
      [x0, 0, 1, 1],
      [x0 + s, 0, -1, 1],
      [x0, s, 1, -1],
      [x0 + s, s, -1, -1],
    ]) {
      c.fillStyle = PAINT.iron
      c.beginPath()
      c.moveTo(cx, cy)
      c.lineTo(cx + sx * k, cy)
      c.lineTo(cx + sx * k, cy + sy * t)
      c.lineTo(cx + sx * t, cy + sy * t)
      c.lineTo(cx + sx * t, cy + sy * k)
      c.lineTo(cx, cy + sy * k)
      c.closePath()
      c.fill()
      c.strokeStyle = 'rgba(255, 235, 200, 0.25)'
      c.lineWidth = Math.max(1, s * 0.008)
      c.stroke()
      rivet(c, cx + sx * t * 0.55, cy + sy * k * 0.72, s * 0.018)
      rivet(c, cx + sx * k * 0.72, cy + sy * t * 0.55, s * 0.018)
    }
  }
}

export function star(c: Ctx, x: number, y: number, r1: number, r0: number, n: number) {
  c.beginPath()
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r0 : r1
    const a = (i * Math.PI) / n - Math.PI / 2
    c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r)
  }
  c.closePath()
}

/** gate atlas, 2:1: [door face | end / top board]; painted barn door */
export function paintGate(c: Ctx, W: number, H: number, wood: Img) {
  const s = H
  const n = 5
  for (let i = 0; i < n; i++) {
    const x = (i * s) / n
    woodRect(c, wood, x, 0, s / n, s, null, true)
    c.fillStyle = shade(PAINT.mustard, (i % 2 ? -0.04 : 0.02), 0.82)
    c.fillRect(x, 0, s / n, s)
    c.fillStyle = 'rgba(70, 40, 10, 0.5)'
    c.fillRect(x, 0, Math.max(1, s * 0.014), s)
  }
  // Z brace in a darker ochre
  const b = s * 0.16
  const board = (x: number, y: number, w: number, h: number, rot = 0) => {
    c.save()
    c.translate(x, y)
    c.rotate(rot)
    woodRect(c, wood, -w / 2, -h / 2, w, h, null)
    c.fillStyle = shade(PAINT.red, 0, 0.78)
    c.fillRect(-w / 2, -h / 2, w, h)
    bevel(c, -w / 2, -h / 2, w, h, Math.max(1, s * 0.014), 0.3)
    c.restore()
  }
  board(s / 2, s * 0.17, s, b)
  board(s / 2, s * 0.83, s, b)
  board(s / 2, s / 2, Math.hypot(s * 0.7, s * 0.66), b * 0.9, -Math.atan2(s * 0.66, s * 0.95))
  for (const y of [0.17, 0.83]) for (const x of [0.12, 0.88]) rivet(c, x * s, y * s, s * 0.02)
  // end / top board: plain painted plank
  woodRect(c, wood, s, 0, s, s, null)
  c.fillStyle = shade(PAINT.mustard, -0.05, 0.8)
  c.fillRect(s, 0, s, s)
  bevel(c, s, 0, s, s, Math.max(1, s * 0.03), 0.3)
}

/** felt sheet with wet mud blobs (tileable) */
export function paintMud(c: Ctx, W: number, H: number) {
  const r = rng(7)
  c.fillStyle = '#5c3c22'
  c.fillRect(0, 0, W, H)
  const wrap = (f: (dx: number, dy: number) => void) => {
    for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) f(dx, dy)
  }
  // felt mottling
  for (let i = 0; i < 60; i++) {
    const x = r() * W, y = r() * H, rad = (0.05 + r() * 0.12) * W
    const l = r() < 0.5
    wrap((dx, dy) => {
      const g = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
      g.addColorStop(0, l ? 'rgba(120, 82, 48, 0.25)' : 'rgba(40, 24, 12, 0.25)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      c.fillStyle = g
      c.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2)
    })
  }
  // wet blobs: darker with a glossy rim on their upper-left
  for (let i = 0; i < 9; i++) {
    const x = r() * W, y = r() * H, rad = (0.06 + r() * 0.09) * W
    const pts = Array.from({ length: 9 }, (_, k) => {
      const a = (k / 9) * Math.PI * 2
      const rr = rad * (0.75 + r() * 0.45)
      return [Math.cos(a) * rr, Math.sin(a) * rr * 0.8]
    })
    const blob = (dx: number, dy: number, k = 1, ox = 0, oy = 0) => {
      c.beginPath()
      pts.forEach(([px, py], j) => {
        const [nx, ny] = pts[(j + 1) % pts.length]
        const mx = x + dx + ox + ((px + nx) / 2) * k
        const my = y + dy + oy + ((py + ny) / 2) * k
        if (j === 0) c.moveTo(mx, my)
        c.quadraticCurveTo(x + dx + ox + px * k, y + dy + oy + py * k, mx, my)
      })
      c.closePath()
    }
    wrap((dx, dy) => {
      blob(dx, dy, 1.05, rad * 0.06, rad * 0.1)
      c.fillStyle = 'rgba(30, 16, 6, 0.45)'
      c.fill()
      blob(dx, dy)
      c.fillStyle = '#3f2614'
      c.fill()
      blob(dx, dy, 0.55, -rad * 0.22, -rad * 0.2)
      c.fillStyle = 'rgba(170, 120, 80, 0.35)'
      c.fill()
      blob(dx, dy, 0.25, -rad * 0.3, -rad * 0.3)
      c.fillStyle = 'rgba(255, 230, 190, 0.45)'
      c.fill()
    })
  }
  // felt fibres
  for (let i = 0; i < W * H * 0.02; i++) {
    const x = r() * W, y = r() * H, a = r() * Math.PI, l = (0.01 + r() * 0.02) * W
    c.strokeStyle = r() < 0.5 ? 'rgba(140, 100, 64, 0.22)' : 'rgba(25, 14, 6, 0.22)'
    c.lineWidth = Math.max(0.6, W / 256)
    c.beginPath()
    c.moveTo(x, y)
    c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l)
    c.stroke()
  }
}

/** frosted lacquer: soft clouds, a few scratches (tileable, grey levels: r = frost, g = scratch) */
export function paintIce(c: Ctx, W: number, H: number) {
  const r = rng(11)
  c.fillStyle = '#000'
  c.fillRect(0, 0, W, H)
  for (let i = 0; i < 40; i++) {
    const x = r() * W, y = r() * H, rad = (0.08 + r() * 0.2) * W
    for (const dx of [-W, 0, W])
      for (const dy of [-H, 0, H]) {
        const g = c.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad)
        g.addColorStop(0, `rgba(255, 0, 0, ${0.12 + r() * 0.12})`)
        g.addColorStop(1, 'rgba(255, 0, 0, 0)')
        c.fillStyle = g
        c.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2)
      }
  }
  c.globalCompositeOperation = 'lighter'
  c.lineCap = 'round'
  for (let i = 0; i < 14; i++) {
    let x = r() * W, y = r() * H
    const a0 = r() * Math.PI
    c.strokeStyle = `rgba(0, 255, 0, ${0.35 + r() * 0.4})`
    c.lineWidth = Math.max(0.7, W / 300)
    c.beginPath()
    c.moveTo(x, y)
    for (let k = 0; k < 4; k++) {
      const a = a0 + (r() - 0.5) * 0.8
      const l = (0.03 + r() * 0.06) * W
      x += Math.cos(a) * l
      y += Math.sin(a) * l
      c.lineTo(x, y)
    }
    c.stroke()
  }
  c.globalCompositeOperation = 'source-over'
}

// ---- power-up tokens ----------------------------------------------------------------------

/** the power-up's icon in `ink` at (x, y), radius r */
export function powerIcon(c: Ctx, kind: number, x: number, y: number, r: number, ink: string) {
  c.save()
  c.translate(x, y)
  c.fillStyle = ink
  c.strokeStyle = ink
  c.lineJoin = 'round'
  c.lineCap = 'round'
  const shell = (sx: number, sy: number, w: number, h: number) => {
    c.beginPath()
    c.moveTo(sx - w / 2, sy + h / 2)
    c.lineTo(sx - w / 2, sy - h * 0.15)
    c.quadraticCurveTo(sx - w / 2, sy - h / 2, sx, sy - h / 2)
    c.quadraticCurveTo(sx + w / 2, sy - h / 2, sx + w / 2, sy - h * 0.15)
    c.lineTo(sx + w / 2, sy + h / 2)
    c.closePath()
    c.fill()
  }
  switch (kind) {
    case 0: // rapid fire: three shells
      for (const i of [-1, 0, 1]) shell(i * r * 0.42, i === 0 ? -r * 0.08 : r * 0.08, r * 0.3, r * 1.05)
      break
    case 1: {
      // ricochet: an arrow bouncing off a wall
      c.lineWidth = r * 0.2
      c.beginPath()
      c.moveTo(-r * 0.75, -r * 0.55)
      c.lineTo(-r * 0.05, r * 0.45)
      c.lineTo(r * 0.5, -r * 0.3)
      c.stroke()
      c.beginPath()
      c.moveTo(r * 0.78, -r * 0.62)
      c.lineTo(r * 0.22, -r * 0.48)
      c.lineTo(r * 0.62, -r * 0.08)
      c.closePath()
      c.fill()
      c.fillRect(-r * 0.8, r * 0.58, r * 1.5, r * 0.18)
      break
    }
    case 2: // shield crest
      c.beginPath()
      c.moveTo(0, -r * 0.85)
      c.quadraticCurveTo(r * 0.45, -r * 0.6, r * 0.75, -r * 0.62)
      c.quadraticCurveTo(r * 0.78, r * 0.35, 0, r * 0.9)
      c.quadraticCurveTo(-r * 0.78, r * 0.35, -r * 0.75, -r * 0.62)
      c.quadraticCurveTo(-r * 0.45, -r * 0.6, 0, -r * 0.85)
      c.closePath()
      c.fill()
      c.globalCompositeOperation = 'destination-out'
      c.fillRect(-r * 0.09, -r * 0.55, r * 0.18, r * 1.2)
      c.fillRect(-r * 0.5, -r * 0.2, r * 1.0, r * 0.18)
      c.globalCompositeOperation = 'source-over'
      break
    case 3: // speed: double chevron
      c.lineWidth = r * 0.24
      for (const o of [-0.32, 0.22]) {
        c.beginPath()
        c.moveTo((o - 0.22) * r, -r * 0.55)
        c.lineTo((o + 0.3) * r, 0)
        c.lineTo((o - 0.22) * r, r * 0.55)
        c.stroke()
      }
      break
    case 4: // mines: the dome with its band
      c.beginPath()
      c.arc(0, r * 0.2, r * 0.62, Math.PI, 0)
      c.lineTo(r * 0.8, r * 0.2)
      c.lineTo(r * 0.8, r * 0.42)
      c.lineTo(-r * 0.8, r * 0.42)
      c.lineTo(-r * 0.8, r * 0.2)
      c.closePath()
      c.fill()
      c.beginPath()
      c.arc(0, -r * 0.5, r * 0.14, 0, Math.PI * 2)
      c.fill()
      c.fillRect(-r * 0.05, -r * 0.5, r * 0.1, r * 0.2)
      break
    case 5: // rocket
      c.rotate(Math.PI / 4)
      c.beginPath()
      c.moveTo(0, -r * 0.9)
      c.quadraticCurveTo(r * 0.3, -r * 0.55, r * 0.26, r * 0.3)
      c.lineTo(-r * 0.26, r * 0.3)
      c.quadraticCurveTo(-r * 0.3, -r * 0.55, 0, -r * 0.9)
      c.closePath()
      c.fill()
      c.beginPath()
      c.moveTo(r * 0.26, r * 0.05)
      c.lineTo(r * 0.5, r * 0.5)
      c.lineTo(r * 0.2, r * 0.38)
      c.moveTo(-r * 0.26, r * 0.05)
      c.lineTo(-r * 0.5, r * 0.5)
      c.lineTo(-r * 0.2, r * 0.38)
      c.fill()
      c.beginPath()
      c.moveTo(-r * 0.15, r * 0.42)
      c.lineTo(0, r * 0.85)
      c.lineTo(r * 0.15, r * 0.42)
      c.fill()
      break
  }
  c.restore()
}

/** a painted token face: cream rim, coloured enamel, cream icon (radius r) */
export function tokenFace(c: Ctx, kind: number, x: number, y: number, r: number, wood: Img = null) {
  const col = PAINT.power[kind] ?? PAINT.red
  c.save()
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.clip()
  if (wood) woodRect(c, wood, x - r, y - r, r * 2, r * 2, null)
  c.fillStyle = shade(PAINT.cream, 0, wood ? 0.82 : 1)
  c.fillRect(x - r, y - r, r * 2, r * 2)
  c.beginPath()
  c.arc(x, y, r * 0.8, 0, Math.PI * 2)
  c.fillStyle = shade(col, -0.35)
  c.fill()
  c.beginPath()
  c.arc(x, y, r * 0.74, 0, Math.PI * 2)
  const g = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r * 0.8)
  g.addColorStop(0, shade(col, 0.18))
  g.addColorStop(1, shade(col, -0.12))
  c.fillStyle = g
  c.fill()
  // icon with a soft drop shadow
  powerIcon(c, kind, x + r * 0.04, y + r * 0.05, r * 0.55, 'rgba(40, 20, 10, 0.35)')
  powerIcon(c, kind, x, y, r * 0.55, PAINT.cream)
  // rim dots
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    c.beginPath()
    c.arc(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9, r * 0.035, 0, Math.PI * 2)
    c.fillStyle = shade(col, -0.2, 0.8)
    c.fill()
  }
  c.restore()
}

/** token atlas: 6 faces in a row (power-up kinds 0-5) */
export function paintTokens(c: Ctx, W: number, H: number, wood: Img) {
  const s = W / 6
  for (let k = 0; k < 6; k++) tokenFace(c, k, s * k + s / 2, H / 2, s * 0.5, wood)
}
