// Procedural arena maps: the field is cut into sectors, each gets a small structure built from
// the original pieces (wood blocks, cork blocks, holes). Sectors keep a one-cell margin, so the
// gutters between them always form connected two-cell corridors; anything a structure closes
// off is filled with cork. Teams maps are mirrored left/right with an open base on each side.
// Deterministic for a seed: the server sends the seed and every client rebuilds the same map.

import { MAP, type ArenaMode } from './rules'

export type ArenaMap = {
  seed: number
  mode: ArenaMode
  cols: number
  rows: number
  /** map codes as in the level format: 0 empty, 101-107 cork, 200 hole, 201-207 wood */
  cells: number[][]
  /** cells a tank can spawn on, per team (FFA: everything in [0]) */
  spawns: [number, number][][]
  /** cells pickups can appear on */
  open: [number, number][]
}

export function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SECTOR = 7
const INNER = SECTOR - 2

type Piece = (put: (x: number, y: number, code: number) => void, rnd: () => number, wood: () => number, cork: () => number) => void


/** structures inside a 5x5 sector interior */
const PIECES: [number, Piece][] = [
  [5, () => {}],
  // a pillar
  [3, (put, rnd, wood) => {
    const s = rnd() < 0.5 ? 1 : 2
    const o = s === 1 ? 2 : 1 + Math.floor(rnd() * 2)
    const h = wood()
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) put(o + x, o + y, h)
  }],
  // a wall
  [4, (put, rnd, wood, cork) => {
    const h = rnd() < 0.25 ? cork() : wood()
    const len = 3 + Math.floor(rnd() * 3)
    const at = Math.floor(rnd() * INNER)
    const from = Math.floor((INNER - len) / 2)
    const vertical = rnd() < 0.5
    for (let i = 0; i < len; i++) vertical ? put(at, from + i, h) : put(from + i, at, h)
  }],
  // an L
  [4, (put, rnd, wood) => {
    const h = wood()
    const fx = rnd() < 0.5, fy = rnd() < 0.5
    const p = (x: number, y: number) => put(fx ? INNER - 1 - x : x, fy ? INNER - 1 - y : y, h)
    for (let i = 0; i < 4; i++) p(i, 0)
    for (let i = 1; i < 4; i++) p(0, i)
  }],
  // a plus
  [2, (put, rnd, wood, cork) => {
    const h = wood()
    const c = cork()
    for (let i = 0; i < INNER; i++) {
      put(2, i, i === 2 ? h : rnd() < 0.3 ? c : h)
      put(i, 2, i === 2 ? h : rnd() < 0.3 ? c : h)
    }
  }],
  // a cork cluster
  [4, (put, rnd, _wood, cork) => {
    for (let y = 0; y < INNER; y++) for (let x = 0; x < INNER; x++) if (rnd() < 0.45 && Math.hypot(x - 2, y - 2) < 2.6) put(x, y, cork())
  }],
  // a pit of holes
  [2, (put, rnd) => {
    const w = 2 + Math.floor(rnd() * 2), d = 2 + Math.floor(rnd() * 2)
    const ox = Math.floor((INNER - w) / 2), oy = Math.floor((INNER - d) / 2)
    for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) put(ox + x, oy + y, 200)
  }],
  // corner brackets (a room with four doors)
  [3, (put, _rnd, wood) => {
    const h = wood()
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [4, 0, -1, 1], [0, 4, 1, -1], [4, 4, -1, -1]]) {
      put(cx, cy, h)
      put(cx + dx, cy, h)
      put(cx, cy + dy, h)
    }
  }],
  // a U
  [2, (put, rnd, wood) => {
    const h = wood()
    const side = Math.floor(rnd() * 4)
    for (let i = 0; i < INNER; i++) {
      const cells: [number, number][] = [[i, 0], [0, i], [4, i]]
      for (const [x, y] of cells) {
        const [rx, ry] = side === 0 ? [x, y] : side === 1 ? [x, 4 - y] : side === 2 ? [y, x] : [4 - y, x]
        put(rx, ry, h)
      }
    }
  }],
  // scattered singles
  [3, (put, rnd, wood, cork) => {
    const n = 2 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) put(Math.floor(rnd() * INNER), Math.floor(rnd() * INNER), rnd() < 0.5 ? wood() : cork())
  }],
  // a checkerboard of holes and cork
  [1, (put, _rnd, _wood, cork) => {
    for (let y = 0; y < INNER; y += 2) for (let x = 0; x < INNER; x += 2) put(x, y, (x + y) % 4 === 0 ? 200 : cork())
  }],
]
const TOTAL = PIECES.reduce((a, [w]) => a + w, 0)

export function generateMap(seed: number, mode: ArenaMode): ArenaMap {
  const rnd = mulberry(seed)
  const cols = MAP.cols
  const rows = MAP.rows
  const cells = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  // border ring
  for (let x = 0; x < cols; x++) cells[0][x] = cells[rows - 1][x] = 202
  for (let y = 0; y < rows; y++) cells[y][0] = cells[y][cols - 1] = 202
  const wood = () => (rnd() < 0.7 ? 201 : rnd() < 0.7 ? 202 : 203)
  const cork = () => (rnd() < 0.75 ? 101 : 102)
  // sectors over the interior (1..cols-2), centred
  const sx = Math.floor((cols - 2) / SECTOR)
  const sy = Math.floor((rows - 2) / SECTOR)
  const ox = 1 + Math.floor((cols - 2 - sx * SECTOR) / 2)
  const oy = 1 + Math.floor((rows - 2 - sy * SECTOR) / 2)
  const half = mode === 'teams' ? Math.ceil(sx / 2) : sx
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < half; i++) {
      // teams: the outermost sector column is the base (light cover only)
      const base = mode === 'teams' && i === 0
      let r = rnd() * TOTAL
      let piece = PIECES[0][1]
      for (const [w, p] of PIECES) {
        if ((r -= w) < 0) {
          piece = p
          break
        }
      }
      if (base) piece = rnd() < 0.5 ? PIECES[0][1] : PIECES[1][1]
      const x0 = ox + i * SECTOR + 1
      const y0 = oy + j * SECTOR + 1
      piece((x, y, code) => {
        if (x < 0 || y < 0 || x >= INNER || y >= INNER) return
        cells[y0 + y][x0 + x] = code
      }, rnd, wood, cork)
    }
  // a few long walls across the gutters for cover (never fully closing a gutter)
  const walls = Math.floor((sx * sy) / 6)
  for (let k = 0; k < walls; k++) {
    const h = wood()
    if (rnd() < 0.5) {
      const y = oy + Math.floor(rnd() * (sy + 1)) * SECTOR
      const x = ox + Math.floor(rnd() * (mode === 'teams' ? half : sx)) * SECTOR + 1
      if (y > 0 && y < rows - 1) for (let i = 0; i < 3; i++) if (cells[y][x + 1 + i] === 0) cells[y][x + 1 + i] = h
    } else {
      const x = ox + Math.floor(rnd() * ((mode === 'teams' ? half : sx) + 1)) * SECTOR
      const y = oy + Math.floor(rnd() * sy) * SECTOR + 1
      if (x > 0 && x < cols - 1) for (let i = 0; i < 3; i++) if (cells[y + 1 + i]?.[x] === 0) cells[y + 1 + i][x] = h
    }
  }
  if (mode === 'teams') for (let y = 0; y < rows; y++) for (let x = 0; x < cols / 2; x++) cells[y][cols - 1 - x] = cells[y][x]
  // fill whatever the structures closed off (flood fill from the centre corridor)
  const seen = new Uint8Array(cols * rows)
  const start = (() => {
    for (let d = 0; d < cols; d++)
      for (const [x, y] of [[(cols >> 1) + d, rows >> 1], [(cols >> 1) - d, rows >> 1], [cols >> 1, (rows >> 1) + d]])
        if (cells[y]?.[x] === 0) return [x, y]
    return [1, 1]
  })()
  const q = [start]
  seen[start[1] * cols + start[0]] = 1
  while (q.length) {
    const [x, y] = q.pop()!
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[ny * cols + nx] || cells[ny][nx] !== 0) continue
      seen[ny * cols + nx] = 1
      q.push([nx, ny])
    }
  }
  const open: [number, number][] = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      if (cells[y][x] !== 0) continue
      if (!seen[y * cols + x]) cells[y][x] = 101
      else open.push([x, y])
    }
  // spawn cells: open with all 8 neighbours open (room to turn)
  const roomy = open.filter(([x, y]) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cells[y + dy]?.[x + dx] !== 0) return false
    return true
  })
  const spawns: [number, number][][] =
    mode === 'teams'
      ? [roomy.filter(([x]) => x < cols * 0.22), roomy.filter(([x]) => x > cols * 0.78)]
      : [roomy]
  return { seed, mode, cols, rows, cells, spawns, open }
}

/** cell centre in world units (grid centred on the origin, like RPTnkField::GetCellPos) */
export function cellPos(m: { cols: number; rows: number }, c: number, r: number) {
  return { x: 35 * c - 17.5 * (m.cols - 1), z: 35 * r - 17.5 * (m.rows - 1) }
}
export function cellOf(m: { cols: number; rows: number }, x: number, z: number): [number, number] {
  return [Math.round((x + 17.5 * (m.cols - 1)) / 35), Math.round((z + 17.5 * (m.rows - 1)) / 35)]
}
