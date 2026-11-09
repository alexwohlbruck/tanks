// Stand-ins for the player Miis. The original renders each player's Mii (RFL) as a head icon
// (RPMiiIconSet / RPDrawKokeshiIcon) and as a 3D avatar on the result screens (RPSysKokeshi).
// There is no Mii data on the web, so these are generic flat-shaded Mii-style figures:
// P1 in blue, P2 in red (the players' colours in the Tanks HUD).

export type Expression = 'normal' | 'smile' | 'sad'

type Look = { hair: string; hairDark: string; skin: string; skinShade: string; shirt: string; shirtDark: string; style: 0 | 1 }

const LOOKS: Look[] = [
  { hair: '#5a3620', hairDark: '#3f2414', skin: '#ffd6b0', skinShade: '#efb98e', shirt: '#2f6fe0', shirtDark: '#2153b0', style: 0 },
  { hair: '#2c2422', hairDark: '#1a1413', skin: '#f6c8a0', skinShade: '#e2a87c', shirt: '#e0402f', shirtDark: '#b02a1e', style: 1 },
]

const S = 256
const headCache = new Map<string, HTMLCanvasElement>()

/** head icon (256 x 256, y down), cached per player / expression */
function headCanvas(player: number, expr: Expression) {
  const key = player + expr
  let c = headCache.get(key)
  if (c) return c
  c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  const L = LOOKS[player & 1]
  const cx = 128
  const cy = 136
  // hair behind the head
  g.fillStyle = L.hairDark
  g.beginPath()
  if (L.style === 0) g.ellipse(cx, cy - 6, 92, 100, 0, Math.PI, 0)
  else g.ellipse(cx, cy - 2, 96, 104, 0, Math.PI * 0.95, Math.PI * 0.05)
  g.fill()
  // ears
  g.fillStyle = L.skinShade
  for (const s of [-1, 1]) {
    g.beginPath()
    g.ellipse(cx + s * 84, cy + 14, 16, 22, 0, 0, Math.PI * 2)
    g.fill()
  }
  // face
  const face = g.createRadialGradient(cx - 18, cy - 20, 20, cx, cy + 10, 110)
  face.addColorStop(0, L.skin)
  face.addColorStop(0.75, L.skin)
  face.addColorStop(1, L.skinShade)
  g.fillStyle = face
  g.beginPath()
  g.moveTo(cx - 84, cy - 10)
  g.bezierCurveTo(cx - 86, cy + 60, cx - 52, cy + 104, cx, cy + 106)
  g.bezierCurveTo(cx + 52, cy + 104, cx + 86, cy + 60, cx + 84, cy - 10)
  g.bezierCurveTo(cx + 82, cy - 86, cx - 82, cy - 86, cx - 84, cy - 10)
  g.fill()
  // hair on top
  g.fillStyle = L.hair
  g.beginPath()
  if (L.style === 0) {
    // short side-swept fringe
    g.moveTo(cx - 90, cy + 8)
    g.bezierCurveTo(cx - 100, cy - 70, cx - 50, cy - 108, cx + 6, cy - 106)
    g.bezierCurveTo(cx + 70, cy - 104, cx + 102, cy - 60, cx + 90, cy + 8)
    g.bezierCurveTo(cx + 84, cy - 22, cx + 70, cy - 40, cx + 52, cy - 46)
    g.bezierCurveTo(cx + 20, cy - 30, cx - 30, cy - 34, cx - 62, cy - 48)
    g.bezierCurveTo(cx - 74, cy - 34, cx - 82, cy - 14, cx - 90, cy + 8)
  } else {
    // straight bangs
    g.moveTo(cx - 92, cy + 30)
    g.bezierCurveTo(cx - 104, cy - 80, cx - 40, cy - 112, cx, cy - 110)
    g.bezierCurveTo(cx + 40, cy - 112, cx + 104, cy - 80, cx + 92, cy + 30)
    g.lineTo(cx + 78, cy + 30)
    g.bezierCurveTo(cx + 78, cy - 10, cx + 72, cy - 24, cx + 64, cy - 30)
    g.lineTo(cx - 64, cy - 30)
    g.bezierCurveTo(cx - 72, cy - 24, cx - 78, cy - 10, cx - 78, cy + 30)
  }
  g.closePath()
  g.fill()
  // hair highlight
  g.strokeStyle = 'rgba(255,255,255,0.18)'
  g.lineWidth = 7
  g.lineCap = 'round'
  g.beginPath()
  g.arc(cx - 10, cy - 50, 62, Math.PI * 1.15, Math.PI * 1.45)
  g.stroke()
  // eyebrows
  g.strokeStyle = L.hairDark
  g.lineWidth = 7
  const browY = cy - 6 + (expr === 'sad' ? 2 : 0)
  for (const s of [-1, 1]) {
    g.beginPath()
    if (expr === 'sad') {
      g.moveTo(cx + s * 18, browY - 6)
      g.lineTo(cx + s * 48, browY + 2)
    } else {
      g.moveTo(cx + s * 18, browY)
      g.quadraticCurveTo(cx + s * 34, browY - 7, cx + s * 50, browY - 1)
    }
    g.stroke()
  }
  // eyes
  for (const s of [-1, 1]) {
    const ex = cx + s * 33
    const ey = cy + 22
    if (expr === 'smile') {
      g.strokeStyle = '#2a1a12'
      g.lineWidth = 7
      g.beginPath()
      g.arc(ex, ey + 6, 12, Math.PI * 1.15, Math.PI * 1.85)
      g.stroke()
    } else {
      g.fillStyle = '#2a1a12'
      g.beginPath()
      g.ellipse(ex, ey, 9, 14, 0, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#fff'
      g.beginPath()
      g.arc(ex + 3, ey - 5, 3.5, 0, Math.PI * 2)
      g.fill()
    }
  }
  // nose
  g.strokeStyle = L.skinShade
  g.lineWidth = 5
  g.beginPath()
  g.moveTo(cx - 6, cy + 50)
  g.quadraticCurveTo(cx, cy + 56, cx + 6, cy + 50)
  g.stroke()
  // mouth
  g.lineWidth = 6
  g.strokeStyle = '#a3473a'
  g.beginPath()
  if (expr === 'smile') {
    g.fillStyle = '#8f2f28'
    g.moveTo(cx - 22, cy + 68)
    g.quadraticCurveTo(cx, cy + 96, cx + 22, cy + 68)
    g.closePath()
    g.fill()
    g.stroke()
  } else if (expr === 'sad') {
    g.moveTo(cx - 16, cy + 82)
    g.quadraticCurveTo(cx, cy + 70, cx + 16, cy + 82)
    g.stroke()
  } else {
    g.moveTo(cx - 16, cy + 74)
    g.quadraticCurveTo(cx, cy + 84, cx + 16, cy + 74)
    g.stroke()
  }
  // cheeks
  if (expr === 'smile') {
    g.fillStyle = 'rgba(255,120,110,0.25)'
    for (const s of [-1, 1]) {
      g.beginPath()
      g.ellipse(cx + s * 52, cy + 56, 14, 9, 0, 0, Math.PI * 2)
      g.fill()
    }
  }
  headCache.set(key, c)
  return c
}

/**
 * RPDrawKokeshiIcon: the player's head filling a pane of `size` units. `ctx` has the pane's
 * transform applied (y up); `alpha` is the pane's global alpha.
 */
export function drawMiiHead(ctx: CanvasRenderingContext2D, size: number, player: number, alpha: number, expr: Expression = 'normal') {
  if (alpha <= 0.001) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.scale(1, -1)
  ctx.drawImage(headCanvas(player, expr), -size / 2, -size / 2, size, size)
  ctx.restore()
}

export type Pose = 'wait' | 'win' | 'lose' | 'draw'

/**
 * A standing Mii (RPSysKokeshi avatar on the result screens). (x, feetY) in layout units,
 * `height` is the whole figure; `t` animates the pose (frames).
 */
export function drawMiiFigure(ctx: CanvasRenderingContext2D, x: number, feetY: number, height: number, player: number, pose: Pose, t: number, alpha = 1, expr: Expression = 'normal') {
  if (alpha <= 0.001) return
  const L = LOOKS[player & 1]
  const u = height / 100
  const bounce = pose === 'win' ? Math.abs(Math.sin(t * 0.12)) * 5 : pose === 'wait' ? Math.sin(t * 0.05) * 0.8 : 0
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.translate(x, feetY + bounce * u)
  ctx.scale(u, u)
  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)'
  ctx.beginPath()
  ctx.ellipse(0, -bounce, 20, 4, 0, 0, Math.PI * 2)
  ctx.fill()
  // legs
  ctx.fillStyle = '#5c6470'
  ctx.beginPath()
  ctx.roundRect(-11, 0, 9.5, 26, 4)
  ctx.roundRect(1.5, 0, 9.5, 26, 4)
  ctx.fill()
  // shoes
  ctx.fillStyle = '#3b3f46'
  ctx.beginPath()
  ctx.ellipse(-6.5, 1.5, 6.5, 3, 0, 0, Math.PI * 2)
  ctx.ellipse(6.5, 1.5, 6.5, 3, 0, 0, Math.PI * 2)
  ctx.fill()
  // arms
  const arm = (side: number) => {
    ctx.save()
    ctx.translate(side * 14, 48)
    let a: number
    if (pose === 'win') a = side * (2.5 + Math.sin(t * 0.24) * 0.25)
    else if (pose === 'lose') a = side * 0.12
    else if (pose === 'draw') a = side * (0.9 + Math.sin(t * 0.1) * 0.1)
    else a = side * 0.3
    ctx.rotate(a)
    ctx.fillStyle = L.shirtDark
    ctx.beginPath()
    ctx.roundRect(-4, -26, 8, 26, 4)
    ctx.fill()
    ctx.fillStyle = L.skin
    ctx.beginPath()
    ctx.arc(0, -26, 4.6, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  arm(-1)
  arm(1)
  // torso
  const body = ctx.createLinearGradient(-16, 0, 16, 0)
  body.addColorStop(0, L.shirt)
  body.addColorStop(1, L.shirtDark)
  ctx.fillStyle = body
  ctx.beginPath()
  ctx.moveTo(-15, 22)
  ctx.bezierCurveTo(-17, 40, -15, 50, -9, 54)
  ctx.lineTo(9, 54)
  ctx.bezierCurveTo(15, 50, 17, 40, 15, 22)
  ctx.closePath()
  ctx.fill()
  // head
  const tilt = pose === 'lose' ? 0.1 : pose === 'win' ? Math.sin(t * 0.12) * 0.06 : 0
  ctx.translate(0, 72)
  ctx.rotate(-tilt)
  ctx.globalAlpha = alpha
  ctx.scale(1, -1)
  ctx.drawImage(headCanvas(player, expr), -24, -26, 48, 48)
  ctx.restore()
}
