// Procedural arena maps: the field is cut into sectors, each gets a small structure built from
// (the pattern themes instead draw one big shape over the whole field: see PATTERNS below)
//
// the original pieces (wood blocks, cork blocks, holes). Sectors keep a one-cell margin, so the
// gutters between them always form connected two-cell corridors; anything a structure closes
// off is filled with cork. Teams maps are mirrored left/right with an open base on each side.
// Deterministic for a seed: the server sends the seed and every client rebuilds the same map.

import { isTeamMode, SIZES, type ArenaMode, type ArenaSize, type MapTheme } from './rules'

export type ArenaMap = {
  seed: number
  mode: ArenaMode
  theme: MapTheme
  size: ArenaSize
  cols: number
  rows: number
  /** map codes as in the level format: 0 empty, 101-107 cork, 200 hole, 201-207 wood */
  cells: number[][]
  /** cells a tank can spawn on, per team (FFA: everything in [0]); Teams: the bases */
  spawns: [number, number][][]
  /** Teams: roomy cells in each team's own half (respawns near the fighting); FFA: as spawns */
  halves: [number, number][][]
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
// ---- whole-map patterns ------------------------------------------------------------------------
// The pattern themes skip the sectors and draw one big shape over the whole field (Teams: over
// one half, mirrored). Corridors are three cells wide (room to turn, a roomy middle row to spawn
// on); walls change material every few cells (mostly wood, some cork to blast through, a few
// holes that shells fly over) and have doorways, so nothing takes forever to get around.

/** `put` draws a wall cell at (x, y) in the pattern's w x h area; `mat` picks a wall material */
type Pattern = (put: (x: number, y: number, code: number) => void, w: number, h: number, rnd: () => number, mat: () => number) => void

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]

/** a wall along a path of cells, with a three-cell doorway every `min` to `min + spread` cells */
function walker(put: (x: number, y: number, code: number) => void, rnd: () => number, mat: () => number, min = 10, spread = 12) {
  let run = 0
  let gap = 0
  let next = min + Math.floor(rnd() * spread)
  let code = mat()
  return (x: number, y: number) => {
    if (gap > 0) return void gap--
    if (++run >= next) {
      run = 0
      next = min + Math.floor(rnd() * spread)
      gap = 2
      return
    }
    if (run % 6 === 0) code = mat()
    put(x, y, code)
  }
}

/** a solid line through successive points: each new cell joins the last one side-on (a diagonal
 * step gets a corner cell), so no wall is only held together at its corners */
function stroke(draw: (x: number, y: number) => void) {
  let px = NaN, py = NaN
  return (x: number, y: number) => {
    if (x === px && y === py) return
    if (px === px && x !== px && y !== py) draw(x, py)
    draw(x, y)
    px = x
    py = y
  }
}

const PATTERNS: Partial<Record<MapTheme, Pattern>> = {
  // two arms winding out from the middle (an Archimedean spiral), a corridor between them
  spiral: (put, w, h, rnd, mat) => {
    const cx = (w - 1) / 2, cy = (h - 1) / 2
    const far = Math.hypot(w, h) / 2 + 4
    // a turn adds 10 cells to an arm's radius; the other arm runs halfway between (corridors
    // four cells wide), with fewer doorways than the other patterns so the arms read as arms
    const pitch = 10 / (Math.PI * 2)
    for (const arm of [0, Math.PI]) {
      const line = stroke(walker(put, rnd, mat, 18, 14))
      for (let t = 0; ; t += 0.25 / Math.max(2, 2 + pitch * t)) {
        const r = 2 + pitch * t
        if (r > far) break
        line(Math.round(cx + Math.cos(t + arm) * r), Math.round(cy + Math.sin(t + arm) * r))
      }
    }
  },
  // concentric rings with a few gaps each, joined by short spokes
  rings: (put, w, h, rnd, mat) => {
    const cx = (w - 1) / 2, cy = (h - 1) / 2
    const far = Math.hypot(w, h) / 2
    const rings: { r: number; gaps: number[]; code: number[] }[] = []
    for (let r = 3; r < far; r += 5) {
      const n = 2 + Math.floor(r / 10) + Math.floor(rnd() * 2)
      const gaps = Array.from({ length: n }, (_, i) => ((i + rnd() * 0.6) / n) * Math.PI * 2)
      rings.push({ r, gaps, code: Array.from({ length: 12 }, mat) })
    }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy)
        const a = (Math.atan2(y - cy, x - cx) + Math.PI * 2) % (Math.PI * 2)
        for (const g of rings) {
          if (Math.abs(d - g.r) >= 0.55) continue
          // a gap is about three cells of arc
          const open = g.gaps.some((ga) => Math.abs(((a - ga + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 1.6 / g.r)
          if (!open) put(x, y, g.code[Math.floor((a / (Math.PI * 2)) * 12)])
        }
      }
    // spokes between neighbouring rings
    for (let i = 0; i + 1 < rings.length; i++) {
      const n = 2 + Math.floor(rnd() * 3)
      for (let k = 0; k < n; k++) {
        const a = rnd() * Math.PI * 2
        const code = mat()
        for (let d = rings[i].r; d <= rings[i + 1].r; d += 0.5) put(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d), code)
      }
    }
  },
  // a real maze on a 4-cell grid (walls every fourth line), with extra openings for loops
  labyrinth: (put, w, h, rnd, mat) => {
    const gw = Math.floor((w - 1) / 4), gh = Math.floor((h - 1) / 4)
    const ox = Math.floor((w - 1 - gw * 4) / 2), oy = Math.floor((h - 1 - gh * 4) / 2)
    // walls between maze cells: right of (i, j), and below (i, j); the outside stays open
    const right = Array.from({ length: gh }, () => new Array<boolean>(gw).fill(true))
    const below = Array.from({ length: gh }, () => new Array<boolean>(gw).fill(true))
    const seen = Array.from({ length: gh }, () => new Array<boolean>(gw).fill(false))
    const stack: [number, number][] = [[Math.floor(rnd() * gw), Math.floor(rnd() * gh)]]
    seen[stack[0][1]][stack[0][0]] = true
    while (stack.length) {
      const [i, j] = stack[stack.length - 1]
      const next = DIRS.map(([dx, dy]) => [i + dx, j + dy]).filter(([a, b]) => a >= 0 && b >= 0 && a < gw && b < gh && !seen[b][a])
      if (!next.length) {
        stack.pop()
        continue
      }
      const [a, b] = next[Math.floor(rnd() * next.length)]
      if (a > i) right[j][i] = false
      else if (a < i) right[j][a] = false
      else if (b > j) below[j][i] = false
      else below[b][i] = false
      seen[b][a] = true
      stack.push([a, b])
    }
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++) {
        // knock out about a quarter of the remaining walls: loops, and the odd bigger room
        if (rnd() < 0.22) right[j][i] = false
        if (rnd() < 0.22) below[j][i] = false
        const x0 = ox + i * 4, y0 = oy + j * 4
        const code = mat()
        if (right[j][i] && i < gw - 1) for (let k = 0; k <= 4; k++) put(x0 + 4, y0 + k, code)
        if (below[j][i] && j < gh - 1) for (let k = 0; k <= 4; k++) put(x0 + k, y0 + 4, code)
      }
  },
  // rows of big chevrons, every other row shifted half a period: diamonds between them
  zigzag: (put, w, h, rnd, mat) => {
    for (let band = 0, y0 = 4; y0 < h - 4; band++, y0 += 9) {
      const line = stroke(walker(put, rnd, mat))
      const phase = band % 2 ? 8 : 0
      for (let x = 0; x < w; x++) line(x, y0 + Math.round((Math.abs(((x + phase) % 16) - 8) * 5) / 8) - 2)
    }
  },
}

/** per theme: weight multipliers for PIECES (same order), cork share of walls, gutter extras */
const THEMES: Record<MapTheme, { weights: number[]; corkWalls: number; gutterCork: number; gutterHoles: number; longWalls: number }> = {
  mixed: { weights: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], corkWalls: 0, gutterCork: 0, gutterHoles: 0, longWalls: 1 },
  // most structures in cork, cork scattered over the corridors: mines open the way
  cork: { weights: [0.5, 0.6, 1.4, 1, 1.4, 3, 0.4, 1, 1, 1.5, 2], corkWalls: 0.75, gutterCork: 0.07, gutterHoles: 0, longWalls: 1 },
  // pits and hole fields: tanks go around, shells fly straight over
  pits: { weights: [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 5, 0.6, 0.6, 1, 3], corkWalls: 0.1, gutterCork: 0, gutterHoles: 0.05, longWalls: 1 },
  // walls, Ls and Us, and many long walls across the corridors
  maze: { weights: [0.2, 0.4, 3, 2.5, 1.2, 0.4, 0.3, 1.2, 2.5, 0.4, 0.2], corkWalls: 0.1, gutterCork: 0, gutterHoles: 0, longWalls: 3.5 },
  // whole-map patterns (PATTERNS): the sector settings are unused
  spiral: { weights: [], corkWalls: 0, gutterCork: 0, gutterHoles: 0, longWalls: 0 },
  rings: { weights: [], corkWalls: 0, gutterCork: 0, gutterHoles: 0, longWalls: 0 },
  labyrinth: { weights: [], corkWalls: 0, gutterCork: 0, gutterHoles: 0, longWalls: 0 },
  zigzag: { weights: [], corkWalls: 0, gutterCork: 0, gutterHoles: 0, longWalls: 0 },
}

export function generateMap(seed: number, mode: ArenaMode, theme: MapTheme = 'mixed', size: ArenaSize = 'medium'): ArenaMap {
  // Teams and Elimination: two mirrored halves with a base each
  const teams = isTeamMode(mode)
  const rnd = mulberry(seed)
  const th = THEMES[theme] ?? THEMES.mixed
  const pieces = PIECES.map(([w, p], i) => [w * (th.weights[i] ?? 1), p] as [number, Piece])
  const TOTAL = pieces.reduce((a, [w]) => a + w, 0)
  const { cols, rows } = SIZES[size] ?? SIZES.medium
  const cells = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  // border ring
  for (let x = 0; x < cols; x++) cells[0][x] = cells[rows - 1][x] = 202
  for (let y = 0; y < rows; y++) cells[y][0] = cells[y][cols - 1] = 202
  const cork = () => (rnd() < 0.75 ? 101 : 102)
  const wood = () => (rnd() < th.corkWalls ? cork() : rnd() < 0.7 ? 201 : rnd() < 0.7 ? 202 : 203)
  // sectors over the interior (1..cols-2), centred
  const sx = Math.floor((cols - 2) / SECTOR)
  const sy = Math.floor((rows - 2) / SECTOR)
  const ox = 1 + Math.floor((cols - 2 - sx * SECTOR) / 2)
  const oy = 1 + Math.floor((rows - 2 - sy * SECTOR) / 2)
  const half = teams ? Math.ceil(sx / 2) : sx
  const pattern = PATTERNS[theme]
  if (pattern) {
    // the whole interior (Teams: the left half), less a two-cell road along its edges; Teams
    // also keep a base clear on the outside and a lane down the middle
    const w = (teams ? Math.ceil(cols / 2) : cols - 1) - 1
    const h = rows - 2
    const mat = () => {
      const r = rnd()
      return r < 0.07 ? 200 : r < 0.27 ? cork() : rnd() < 0.7 ? 201 : rnd() < 0.7 ? 202 : 203
    }
    pattern((x, y, code) => {
      if (x < 2 || y < 2 || y >= h - 2 || x >= w - 2) return
      if (teams && x < 6) return
      cells[1 + y][1 + x] = code
    }, w, h, rnd, mat)
  } else {
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < half; i++) {
      // teams: the outermost sector column is the base (light cover only)
      const base = teams && i === 0
      let r = rnd() * TOTAL
      let piece = PIECES[0][1]
      for (const [w, p] of pieces) {
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
  // corridor extras: single cork blocks / holes, never two in a row across a gutter
  if (th.gutterCork || th.gutterHoles)
    for (let y = 1; y < rows - 1; y++)
      for (let x = 1; x < (teams ? cols / 2 : cols - 1); x++) {
        if (cells[y][x] !== 0) continue
        const inGutter = (x - ox) % SECTOR === 0 || (x - ox) % SECTOR === SECTOR - 1 || (y - oy) % SECTOR === 0 || (y - oy) % SECTOR === SECTOR - 1
        if (!inGutter || cells[y - 1][x] || cells[y][x - 1]) continue
        const r = rnd()
        if (r < th.gutterCork) cells[y][x] = cork()
        else if (r < th.gutterCork + th.gutterHoles) cells[y][x] = 200
      }
  const walls = Math.floor(((sx * sy) / 6) * th.longWalls)
  for (let k = 0; k < walls; k++) {
    const h = wood()
    if (rnd() < 0.5) {
      const y = oy + Math.floor(rnd() * (sy + 1)) * SECTOR
      const x = ox + Math.floor(rnd() * (teams ? half : sx)) * SECTOR + 1
      if (y > 0 && y < rows - 1) for (let i = 0; i < 3; i++) if (cells[y][x + 1 + i] === 0) cells[y][x + 1 + i] = h
    } else {
      const x = ox + Math.floor(rnd() * ((teams ? half : sx) + 1)) * SECTOR
      const y = oy + Math.floor(rnd() * sy) * SECTOR + 1
      if (x > 0 && x < cols - 1) for (let i = 0; i < 3; i++) if (cells[y + 1 + i]?.[x] === 0) cells[y + 1 + i][x] = h
    }
  }
  }
  if (teams) for (let y = 0; y < rows; y++) for (let x = 0; x < cols / 2; x++) cells[y][cols - 1 - x] = cells[y][x]
  // fill whatever the structures closed off: keep the largest connected open area
  const region = new Int32Array(cols * rows).fill(-1)
  let best = -1
  let bestSize = 0
  for (let i = 0, id = 0; i < cols * rows; i++) {
    if (region[i] >= 0 || cells[(i / cols) | 0][i % cols] !== 0) continue
    region[i] = id
    const q = [i]
    let size = 0
    while (q.length) {
      const j = q.pop()!
      size++
      const x = j % cols, y = (j / cols) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        const k = ny * cols + nx
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || region[k] >= 0 || cells[ny][nx] !== 0) continue
        region[k] = id
        q.push(k)
      }
    }
    if (size > bestSize) (bestSize = size), (best = id)
    id++
  }
  const open: [number, number][] = []
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      if (cells[y][x] !== 0) continue
      if (region[y * cols + x] !== best) cells[y][x] = 101
      else open.push([x, y])
    }
  // spawn cells: open with all 8 neighbours open (room to turn)
  const roomy = open.filter(([x, y]) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cells[y + dy]?.[x + dx] !== 0) return false
    return true
  })
  const spawns: [number, number][][] =
    teams
      ? [roomy.filter(([x]) => x < cols * 0.22), roomy.filter(([x]) => x > cols * 0.78)]
      : [roomy]
  const halves: [number, number][][] = teams ? [roomy.filter(([x]) => x < cols * 0.46), roomy.filter(([x]) => x > cols * 0.54)] : spawns
  return { seed, mode, theme, size, cols, rows, cells, spawns, halves, open }
}

/** cell centre in world units (grid centred on the origin, like RPTnkField::GetCellPos) */
export function cellPos(m: { cols: number; rows: number }, c: number, r: number) {
  return { x: 35 * c - 17.5 * (m.cols - 1), z: 35 * r - 17.5 * (m.rows - 1) }
}
export function cellOf(m: { cols: number; rows: number }, x: number, z: number): [number, number] {
  return [Math.round((x + 17.5 * (m.cols - 1)) / 35), Math.round((z + 17.5 * (m.rows - 1)) / 35)]
}
