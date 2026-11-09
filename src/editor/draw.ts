// Top-down 2D drawing of a level grid: the editor canvas and the store / level-strip thumbnails.

import type { EnemySlot } from '../levels/format'
import { LEVEL_H, LEVEL_W } from '../levels/format'
import { blockHeight, isCork, isEnemy, isHole, isPlayer, isTile, isWood, PLAYER_COLORS, PLAYER_NAMES, tankType, tileType } from './catalog'

export const PALETTE = {
  floor: '#e9d3a4',
  floorAlt: '#e3cb98',
  floorLine: 'rgba(120, 80, 30, 0.16)',
  wood: '#f0d9a6',
  woodSide: '#c49a5c',
  woodEdge: '#9c7440',
  cork: '#c0814a',
  corkSide: '#8d5528',
  corkDot: 'rgba(80, 40, 10, 0.35)',
  hole: '#3b2a1c',
  holeRim: '#7a5a3a',
  border: '#7b5330',
  red: '#c8282e',
}

export type DrawOpts = {
  /** height numbers and spawn labels */
  labels?: boolean
  grid?: boolean
  /** enemy slot to highlight */
  hiSlot?: number
}

const slotType = (e: EnemySlot | undefined) => (Array.isArray(e) ? e[0] : e || 0)

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath()
  c.roundRect(x, y, w, h, r)
}

/** a little tank seen from above */
export function drawTank(c: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string, label?: string, dir = 0) {
  c.save()
  c.translate(cx, cy)
  c.fillStyle = 'rgba(0,0,0,0.25)'
  roundRect(c, -s * 0.36, -s * 0.3 + s * 0.06, s * 0.72, s * 0.6, s * 0.1)
  c.fill()
  c.rotate(dir)
  c.fillStyle = '#3a3a3a'
  roundRect(c, -s * 0.38, -s * 0.34, s * 0.76, s * 0.14, s * 0.05)
  c.fill()
  roundRect(c, -s * 0.38, s * 0.2, s * 0.76, s * 0.14, s * 0.05)
  c.fill()
  c.fillStyle = color
  c.strokeStyle = 'rgba(0,0,0,0.55)'
  c.lineWidth = Math.max(1, s * 0.04)
  roundRect(c, -s * 0.33, -s * 0.25, s * 0.66, s * 0.5, s * 0.08)
  c.fill()
  c.stroke()
  c.fillRect(0, -s * 0.05, s * 0.44, s * 0.1)
  c.strokeRect(0, -s * 0.05, s * 0.44, s * 0.1)
  c.beginPath()
  c.arc(0, 0, s * 0.16, 0, Math.PI * 2)
  c.fill()
  c.stroke()
  c.restore()
  if (label) {
    c.font = `700 ${Math.round(s * 0.3)}px system-ui, sans-serif`
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.lineWidth = Math.max(2, s * 0.08)
    c.strokeStyle = 'rgba(255,255,255,0.9)'
    c.strokeText(label, cx, cy + s * 0.36)
    c.fillStyle = '#222'
    c.fillText(label, cx, cy + s * 0.36)
  }
}

/** one cell at (x, y) with size s */
export function drawCell(c: CanvasRenderingContext2D, code: number, x: number, y: number, s: number, enemies: EnemySlot[], o: DrawOpts = {}) {
  if (isWood(code) || isCork(code)) {
    const h = blockHeight(code)
    const wood = isWood(code)
    const side = Math.max(1, (s * 0.06 + (s * 0.22 * h) / 8) | 0)
    c.fillStyle = 'rgba(0,0,0,0.18)'
    c.fillRect(x + side * 0.5, y + side * 0.5, s, s)
    c.fillStyle = wood ? PALETTE.woodSide : PALETTE.corkSide
    c.fillRect(x, y, s, s)
    c.fillStyle = wood ? PALETTE.wood : PALETTE.cork
    c.fillRect(x, y, s, s - side)
    if (wood) {
      c.strokeStyle = 'rgba(150, 105, 50, 0.35)'
      c.lineWidth = 1
      c.beginPath()
      for (let i = 1; i < 3; i++) {
        c.moveTo(x + 2, y + ((s - side) * i) / 3)
        c.lineTo(x + s - 2, y + ((s - side) * i) / 3)
      }
      c.stroke()
    } else if (s >= 10) {
      c.fillStyle = PALETTE.corkDot
      for (let i = 0; i < 6; i++) {
        const px = x + ((i * 37 + code * 13) % 89) / 89 * (s - 4) + 2
        const py = y + ((i * 53 + 7) % 97) / 97 * (s - side - 4) + 2
        c.fillRect(px, py, Math.max(1, s / 16), Math.max(1, s / 16))
      }
    }
    c.strokeStyle = wood ? PALETTE.woodEdge : '#6e3f1a'
    c.lineWidth = Math.max(1, s / 28)
    c.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1)
    if (o.labels && s >= 18) {
      c.font = `700 ${Math.round(s * 0.36)}px system-ui, sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillStyle = wood ? 'rgba(90, 60, 25, 0.8)' : 'rgba(255, 235, 210, 0.9)'
      c.fillText(String(h), x + s / 2, y + (s - side) / 2 + 1)
    }
  } else if (isHole(code)) {
    c.fillStyle = PALETTE.holeRim
    c.beginPath()
    c.arc(x + s / 2, y + s / 2, s * 0.46, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = PALETTE.hole
    c.beginPath()
    c.arc(x + s / 2, y + s / 2 + s * 0.03, s * 0.4, 0, Math.PI * 2)
    c.fill()
  } else if (isPlayer(code)) {
    const p = code - 300
    drawTank(c, x + s / 2, y + s / 2 - (o.labels ? s * 0.08 : 0), s * 0.95, PLAYER_COLORS[p], o.labels ? PLAYER_NAMES[p] : undefined)
  } else if (isEnemy(code)) {
    const i = code - 400
    const e = enemies[i]
    const t = slotType(e)
    const col = t ? tankType(t).color : '#ffffff'
    if (o.hiSlot === i) {
      c.fillStyle = 'rgba(200, 40, 46, 0.35)'
      c.fillRect(x, y, s, s)
    }
    drawTank(c, x + s / 2, y + s / 2 - (o.labels ? s * 0.08 : 0), s * 0.95, col, o.labels ? (Array.isArray(e) ? `${i + 1}?` : String(i + 1)) : undefined, Math.PI)
    if (!t && o.labels) {
      c.strokeStyle = PALETTE.red
      c.lineWidth = 2
      c.setLineDash([3, 3])
      c.strokeRect(x + 1, y + 1, s - 2, s - 2)
      c.setLineDash([])
    }
  } else if (isTile(code)) {
    const t = tileType(code)
    c.fillStyle = t.color
    roundRect(c, x + s * 0.08, y + s * 0.08, s * 0.84, s * 0.84, s * 0.18)
    c.fill()
    c.strokeStyle = 'rgba(0,0,0,0.35)'
    c.lineWidth = 1
    c.stroke()
    if (o.labels && s >= 18) {
      c.font = `700 ${Math.round(s * 0.28)}px system-ui, sans-serif`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillStyle = 'rgba(0,0,0,0.7)'
      c.fillText(t.name.slice(0, 3), x + s / 2, y + s / 2)
    }
  }
}

export function drawFloor(c: CanvasRenderingContext2D, x0: number, y0: number, s: number, grid = true) {
  c.fillStyle = PALETTE.floor
  c.fillRect(x0, y0, LEVEL_W * s, LEVEL_H * s)
  // planks along x
  c.fillStyle = PALETTE.floorAlt
  for (let r = 0; r < LEVEL_H; r += 2) c.fillRect(x0, y0 + r * s, LEVEL_W * s, s)
  if (grid) {
    c.strokeStyle = PALETTE.floorLine
    c.lineWidth = 1
    c.beginPath()
    for (let x = 0; x <= LEVEL_W; x++) {
      c.moveTo(x0 + x * s + 0.5, y0)
      c.lineTo(x0 + x * s + 0.5, y0 + LEVEL_H * s)
    }
    for (let y = 0; y <= LEVEL_H; y++) {
      c.moveTo(x0, y0 + y * s + 0.5)
      c.lineTo(x0 + LEVEL_W * s, y0 + y * s + 0.5)
    }
    c.stroke()
  }
}

/** the whole level; blocks are drawn bottom row last so their sides overlap correctly */
export function drawLevel(c: CanvasRenderingContext2D, cells: number[][], enemies: EnemySlot[], x0: number, y0: number, s: number, o: DrawOpts = {}) {
  drawFloor(c, x0, y0, s, o.grid ?? true)
  for (let y = 0; y < LEVEL_H; y++) for (let x = 0; x < LEVEL_W; x++) if (cells[y]?.[x]) drawCell(c, cells[y][x], x0 + x * s, y0 + y * s, s, enemies, o)
}

const thumbCache = new Map<string, string>()

/** a PNG data URL thumbnail (cached by content) */
export function thumbnail(cells: number[][], enemies: EnemySlot[] = [], cell = 8): string {
  const key = cell + JSON.stringify(cells) + JSON.stringify(enemies)
  const hit = thumbCache.get(key)
  if (hit) return hit
  const cv = document.createElement('canvas')
  const pad = Math.max(2, cell >> 1)
  cv.width = LEVEL_W * cell + pad * 2
  cv.height = LEVEL_H * cell + pad * 2
  const c = cv.getContext('2d')!
  c.fillStyle = PALETTE.border
  c.fillRect(0, 0, cv.width, cv.height)
  drawLevel(c, cells, enemies, pad, pad, cell, { grid: false })
  const url = cv.toDataURL('image/png')
  if (thumbCache.size > 400) thumbCache.clear()
  thumbCache.set(key, url)
  return url
}
