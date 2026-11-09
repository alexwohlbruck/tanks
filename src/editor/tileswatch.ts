// Top-down 2D swatches of the Tanks+ tiles (codes 500-599) for the editor canvas, palette and
// thumbnails: small paintings of the 3D toy pieces (src/render/tiles), same paints and icons.

import { PAINT, shade, star, tokenFace } from '../render/tiles/paint'

type Ctx = CanvasRenderingContext2D

const rr = (c: Ctx, x: number, y: number, w: number, h: number, r: number) => {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
}
const disc = (c: Ctx, x: number, y: number, r: number, fill: string | CanvasGradient) => {
  c.beginPath()
  c.arc(x, y, r, 0, Math.PI * 2)
  c.fillStyle = fill
  c.fill()
}
/** a soft drop shadow under raised pieces */
const drop = (c: Ctx, x: number, y: number, w: number, h: number, s: number) => {
  c.fillStyle = 'rgba(60, 35, 10, 0.22)'
  rr(c, x + s * 0.05, y + s * 0.08, w, h, s * 0.1)
  c.fill()
}
/** a wooden block seen from above (light top, darker front face) */
function block(c: Ctx, x: number, y: number, s: number, top: string, side: string, inset = 0.04) {
  const i = s * inset
  drop(c, x + i, y + i, s - 2 * i, s - 2 * i, s)
  c.fillStyle = side
  rr(c, x + i, y + i, s - 2 * i, s - 2 * i, s * 0.08)
  c.fill()
  c.fillStyle = top
  rr(c, x + i, y + i, s - 2 * i, s * 0.72, s * 0.08)
  c.fill()
}

/** draws tile `code` into the cell (x, y, size s); false when the code is not a known tile */
export function drawTileSwatch(c: Ctx, code: number, x: number, y: number, s: number): boolean {
  const cx = x + s / 2
  const cy = y + s / 2
  c.save()
  c.lineJoin = 'round'
  c.lineCap = 'round'
  if (code >= 500 && code <= 503) {
    // teleporter: painted pad with a swirl and 1-4 pips
    const col = PAINT.teleport[code - 500]
    disc(c, cx + s * 0.03, cy + s * 0.05, s * 0.42, 'rgba(60, 35, 10, 0.2)')
    disc(c, cx, cy, s * 0.42, PAINT.cream)
    disc(c, cx, cy, s * 0.31, col)
    c.strokeStyle = shade(col, 0.45)
    c.lineWidth = Math.max(1, s * 0.07)
    for (let k = 0; k < 3; k++) {
      c.beginPath()
      for (let t = 0; t <= 1; t += 0.1) {
        const a = k * 2.094 + t * 2.4
        c.lineTo(cx + Math.cos(a) * s * 0.28 * t, cy + Math.sin(a) * s * 0.28 * t)
      }
      c.stroke()
    }
    disc(c, cx, cy, s * 0.06, PAINT.cream)
    for (let i = 0; i <= code - 500; i++) {
      const a = -Math.PI / 2 + (i - (code - 500) / 2) * 0.5
      disc(c, cx + Math.cos(a) * s * 0.37, cy + Math.sin(a) * s * 0.37, s * 0.03, shade(col, -0.2))
    }
  } else if (code >= 510 && code <= 513) {
    // conveyor: wooden slats with a red chevron along the push
    c.translate(cx, cy)
    c.rotate([-Math.PI / 2, 0, Math.PI / 2, Math.PI][code - 510])
    c.fillStyle = '#3d2614'
    c.fillRect(-s / 2, -s / 2, s, s)
    for (let i = 0; i < 3; i++) {
      c.fillStyle = i % 2 ? '#e2c48a' : '#ecd29c'
      c.fillRect(-s / 2 + (i * s) / 3 + s * 0.02, -s * 0.42, s / 3 - s * 0.04, s * 0.84)
    }
    c.fillStyle = '#9c7440'
    c.fillRect(-s / 2, -s / 2, s, s * 0.08)
    c.fillRect(-s / 2, s * 0.42, s, s * 0.08)
    c.strokeStyle = PAINT.red
    c.lineWidth = s * 0.13
    c.beginPath()
    c.moveTo(-s * 0.14, -s * 0.24)
    c.lineTo(s * 0.12, 0)
    c.lineTo(-s * 0.14, s * 0.24)
    c.stroke()
  } else if (code === 520) {
    // ice: pale lacquer, frosted rim, a gloss streak
    const g = c.createRadialGradient(cx, cy, s * 0.1, cx, cy, s * 0.7)
    g.addColorStop(0, '#bcdff0')
    g.addColorStop(0.6, '#d4ecf6')
    g.addColorStop(1, '#f6fbfe')
    c.fillStyle = g
    c.fillRect(x + 1, y + 1, s - 2, s - 2)
    c.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    c.lineWidth = s * 0.07
    c.beginPath()
    c.moveTo(x + s * 0.2, y + s * 0.85)
    c.lineTo(x + s * 0.85, y + s * 0.2)
    c.stroke()
    c.strokeStyle = 'rgba(90, 110, 125, 0.6)'
    c.lineWidth = 1
    c.strokeRect(x + 1.5, y + 1.5, s - 3, s - 3)
  } else if (code === 521) {
    // mud: brown felt with dark wet puddles
    c.fillStyle = '#5c3c22'
    rr(c, x + 1, y + 1, s - 2, s - 2, s * 0.12)
    c.fill()
    for (const [px, py, r] of [
      [0.32, 0.35, 0.16],
      [0.66, 0.62, 0.19],
      [0.3, 0.74, 0.1],
    ]) {
      c.beginPath()
      c.ellipse(x + px * s, y + py * s, r * s, r * s * 0.75, 0.3, 0, Math.PI * 2)
      c.fillStyle = '#3e2615'
      c.fill()
      c.beginPath()
      c.ellipse(x + px * s - r * s * 0.3, y + py * s - r * s * 0.25, r * s * 0.35, r * s * 0.15, 0.3, 0, Math.PI * 2)
      c.fillStyle = 'rgba(230, 200, 160, 0.35)'
      c.fill()
    }
  } else if (code === 530) {
    // bumper: wooden post in a pink rubber cushion
    block(c, x, y, s, '#f0d9a6', '#c49a5c', 0.12)
    c.strokeStyle = PAINT.rubber
    c.lineWidth = s * 0.12
    rr(c, x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84, s * 0.18)
    c.stroke()
    disc(c, cx, cy - s * 0.06, s * 0.15, PAINT.rubber)
  } else if (code === 531) {
    // glass: clear acrylic with bright bevels and a streak
    c.fillStyle = 'rgba(200, 236, 244, 0.55)'
    rr(c, x + s * 0.05, y + s * 0.05, s * 0.9, s * 0.9, s * 0.1)
    c.fill()
    c.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    c.lineWidth = Math.max(1, s * 0.05)
    c.stroke()
    c.beginPath()
    c.moveTo(x + s * 0.25, y + s * 0.6)
    c.lineTo(x + s * 0.6, y + s * 0.25)
    c.moveTo(x + s * 0.42, y + s * 0.72)
    c.lineTo(x + s * 0.72, y + s * 0.42)
    c.stroke()
    c.strokeStyle = 'rgba(70, 120, 130, 0.5)'
    c.lineWidth = 1
    rr(c, x + s * 0.05, y + s * 0.05, s * 0.9, s * 0.9, s * 0.1)
    c.stroke()
  } else if (code === 532) {
    // crate: framed planks, iron corners, stencilled star
    block(c, x, y, s, '#e6c48c', '#a87a44', 0.07)
    c.strokeStyle = '#9a6a34'
    c.lineWidth = s * 0.08
    c.strokeRect(x + s * 0.12, y + s * 0.12, s * 0.76, s * 0.6)
    c.fillStyle = 'rgba(176, 52, 36, 0.8)'
    star(c, cx, y + s * 0.42, s * 0.15, s * 0.065, 5)
    c.fill()
    c.fillStyle = PAINT.iron
    for (const [px, py] of [
      [0.07, 0.07],
      [0.79, 0.07],
      [0.07, 0.79],
      [0.79, 0.79],
    ])
      c.fillRect(x + px * s, y + py * s, s * 0.14, s * 0.14)
  } else if (code === 540) {
    // switch: wooden plate, red / green dial, lever with a red knob
    block(c, x, y, s, '#f0d9a6', '#c49a5c', 0.1)
    c.beginPath()
    c.arc(cx, cy - s * 0.04, s * 0.26, Math.PI, 0)
    c.fillStyle = '#4f9a3c'
    c.fill()
    c.beginPath()
    c.arc(cx, cy - s * 0.04, s * 0.26, 0, Math.PI)
    c.fillStyle = PAINT.red
    c.fill()
    c.strokeStyle = '#8a6a40'
    c.lineWidth = s * 0.06
    c.beginPath()
    c.moveTo(cx, cy - s * 0.04)
    c.lineTo(cx, cy - s * 0.32)
    c.stroke()
    disc(c, cx, cy - s * 0.34, s * 0.11, PAINT.red)
    disc(c, cx - s * 0.03, cy - s * 0.37, s * 0.035, 'rgba(255, 240, 220, 0.7)')
  } else if (code === 541) {
    // closed gate: mustard barn door with a red Z brace
    block(c, x, y, s, shade(PAINT.mustard, 0.15), shade(PAINT.mustard, -0.2), 0.04)
    c.strokeStyle = shade(PAINT.red, 0, 0.9)
    c.lineWidth = s * 0.1
    c.beginPath()
    c.moveTo(x + s * 0.16, y + s * 0.18)
    c.lineTo(x + s * 0.84, y + s * 0.18)
    c.lineTo(x + s * 0.16, y + s * 0.6)
    c.lineTo(x + s * 0.84, y + s * 0.6)
    c.stroke()
  } else if (code === 542) {
    // open gate: the panel down in its slot between two posts
    c.fillStyle = '#21140a'
    c.fillRect(x + s * 0.1, cy - s * 0.1, s * 0.8, s * 0.2)
    c.fillStyle = shade(PAINT.mustard, 0.1)
    c.fillRect(x + s * 0.12, cy - s * 0.06, s * 0.76, s * 0.12)
    for (const px of [0.06, 0.94]) {
      c.fillStyle = '#9c7440'
      c.fillRect(x + px * s - s * 0.06, cy - s * 0.4, s * 0.12, s * 0.5)
      disc(c, x + px * s, cy - s * 0.4, s * 0.07, PAINT.red)
    }
  } else if (code === 550) {
    // water: blue channel with wooden edging and a ripple
    c.fillStyle = '#c99a5a'
    c.fillRect(x, y, s, s)
    c.fillStyle = PAINT.water
    c.fillRect(x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84)
    c.fillStyle = 'rgba(0, 0, 0, 0.25)'
    c.fillRect(x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.12)
    c.strokeStyle = 'rgba(200, 230, 250, 0.8)'
    c.lineWidth = Math.max(1, s * 0.05)
    for (const py of [0.42, 0.66]) {
      c.beginPath()
      for (let t = 0; t <= 1; t += 0.1) c.lineTo(x + s * (0.18 + t * 0.64), y + s * py + Math.sin(t * Math.PI * 2) * s * 0.04)
      c.stroke()
    }
  } else if (code >= 560 && code <= 567) {
    // laser emitter: wooden base, painted dome, barrel toward the beam
    const d = [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ][(code - 560) % 4]
    const col = PAINT.laser[code >= 564 ? 1 : 0]
    block(c, x, y, s, '#f0d9a6', '#c49a5c', 0.06)
    c.strokeStyle = PAINT.iron
    c.lineWidth = s * 0.14
    c.beginPath()
    c.moveTo(cx, cy - s * 0.08)
    c.lineTo(cx + d[0] * s * 0.48, cy - s * 0.08 + d[1] * s * 0.48)
    c.stroke()
    disc(c, cx + d[0] * s * 0.5, cy - s * 0.08 + d[1] * s * 0.5, s * 0.09, '#ff5030')
    disc(c, cx, cy - s * 0.08, s * 0.28, PAINT.iron)
    disc(c, cx, cy - s * 0.08, s * 0.23, col)
    disc(c, cx - s * 0.07, cy - s * 0.15, s * 0.06, 'rgba(255, 230, 220, 0.7)')
  } else if (code === 570) {
    // gravity well: wooden rim round a painted spiral
    disc(c, cx, cy, s * 0.47, '#d8b680')
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, s * 0.42)
    g.addColorStop(0, '#120a20')
    g.addColorStop(1, '#8a6cc0')
    disc(c, cx, cy, s * 0.42, g)
    c.strokeStyle = 'rgba(225, 210, 245, 0.85)'
    c.lineWidth = Math.max(1, s * 0.05)
    for (let k = 0; k < 2; k++) {
      c.beginPath()
      for (let t = 0.1; t <= 1; t += 0.05) {
        const a = k * Math.PI + t * 5
        c.lineTo(cx + Math.cos(a) * s * 0.4 * t, cy + Math.sin(a) * s * 0.4 * t)
      }
      c.stroke()
    }
  } else if (code >= 580 && code <= 585) {
    // power-up pad: the painted token
    disc(c, cx + s * 0.03, cy + s * 0.05, s * 0.42, 'rgba(60, 35, 10, 0.2)')
    tokenFace(c, code - 580, cx, cy, s * 0.42)
  } else {
    c.restore()
    return false
  }
  c.restore()
  return true
}
