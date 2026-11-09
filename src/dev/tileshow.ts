// Dev showcase: one level with every Tanks+ tile kind next to original wood / cork blocks,
// power-ups on their pads and the per-tank extras (shield, boss bar, sniper sight, fuse).
//   eval:import('/src/dev/tileshow.ts').then(m => m.show())
//   eval:import('/src/dev/tileshow.ts').then(m => m.show({ frames: 160 }))   (other laser phase)
// The game is left paused so the screenshot holds the pose.

import type { App } from '../app/app'
import type { LevelDef, LevelPack } from '../levels/format'
import { LEGEND } from '../levels/ascii'

const W = 22
const H = 17

function level(): LevelDef {
  const g: string[][] = Array.from({ length: H }, () => Array(W).fill('.'))
  const put = (c: number, r: number, ch: string) => (g[r][c] = ch)
  // teleporters A-D, two of each
  'TUVW'.split('').forEach((ch, i) => (put(1 + i * 2, 1, ch), put(1 + i * 2, 15, ch)))
  // conveyors
  for (let c = 10; c <= 12; c++) put(c, 1, '>')
  for (let r = 1; r <= 3; r++) put(13, r, 'v')
  for (let c = 10; c <= 12; c++) put(c, 3, '<')
  put(10, 2, '^')
  // ice and mud
  for (let r = 1; r <= 3; r++) for (let c = 15; c <= 17; c++) put(c, r, '*')
  for (let r = 1; r <= 3; r++) for (let c = 19; c <= 20; c++) put(c, r, '%')
  // walls row: originals for comparison, then the tile walls
  ;['#', 'x', '=', '.', 'B', 'B', '.', 'G', 'G', '.', 'C', 'C', '.', 'S', '.', 'D', 'D', '.', 'O', 'O'].forEach((ch, i) => put(1 + i, 6, ch))
  // water channel beside a wood block
  for (let r = 9; r <= 10; r++) for (let c = 1; c <= 3; c++) put(c, r, '~')
  put(4, 9, '#')
  put(7, 10, '@')
  // lasers: north into the crate, east to the wall, alternate north into the gate, south
  put(11, 12, 'N')
  put(13, 10, 'L')
  put(16, 12, '5')
  put(19, 8, 'Z')
  // power-up pads
  'RKQFMX'.split('').forEach((ch, i) => put(1 + i * 2, 13, ch))
  put(14, 14, '1')
  put(17, 15, '2')
  put(20, 14, 'a')
  put(9, 9, 'b')
  put(16, 9, 'c')
  put(20, 11, 'd')
  return { v: 1, name: 'Tile showcase', cells: g.map((row) => row.map((ch) => LEGEND[ch])), enemies: [21, 17, 16, 15] }
}

export function show(o: { frames?: number; players?: number } = {}) {
  const app = (window as unknown as { app: App }).app
  const pack: LevelPack = { v: 1, id: 'tileshow', name: 'Tile showcase', levels: [level()] }
  app.playPack(pack, o.players ?? 2, 0)
  const game = app.game
  // through the intro and the start card, then `frames` frames of play
  for (let i = 0; i < 2000 && game.phase !== 'play'; i++) game.tick(() => {})
  for (let i = 0; i < (o.frames ?? 2); i++) game.tick(() => {})
  game.paused = true
  const w = game.world!
  // extras on display
  const p1 = w.playerTanks[0]
  if (p1.ext) p1.ext.shield = 1
  for (const t of w.tanks) {
    if (!t.ext || !t.isEnemy) continue
    if (t.type === 16) t.ext.laser = { x0: t.pos.x, z0: t.pos.z, x1: t.pos.x - 220, z1: t.pos.z + 60 }
    if (t.type === 15) t.ext.fuse = 30
  }
  return `${game.phase} tiles=${w.plus?.tiles.list.length}`
}

/** the editor's tile swatches on one sheet over the page (screenshots of src/editor/tileswatch.ts) */
export async function swatches(size = 56) {
  const { drawTileSwatch } = await import('../editor/tileswatch')
  const { tileTypes } = await import('../sim/tiles')
  const list = tileTypes()
  const cols = 10
  const cv = document.createElement('canvas')
  cv.width = cols * (size + 8) + 8
  cv.height = Math.ceil(list.length / cols) * (size + 8) + 8
  cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;image-rendering:pixelated'
  const c = cv.getContext('2d')!
  c.fillStyle = '#e9d3a4'
  c.fillRect(0, 0, cv.width, cv.height)
  list.forEach((t, i) => drawTileSwatch(c, t.code, 8 + (i % cols) * (size + 8), 8 + Math.floor(i / cols) * (size + 8), size))
  document.body.appendChild(cv)
  return list.length
}
