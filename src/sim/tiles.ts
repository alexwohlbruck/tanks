// Tanks+ special tiles (level cell codes 500-599): registry for the level editor and the
// per-stage mechanics. Only built for levels that use them (World.plus), so the original
// missions never reach this code.
//
// Solid tiles are ordinary RPTnkBlock actors (so tanks, shells, mines and the AI probes collide
// with them exactly like with wood / cork); their four edges carry a tag id (EDGE_TAG + tile)
// that Shell.onHitWall hands back here. The grid cell keeps the tile's code with the matching
// Cell kind, so the AI and the renderer see an ordinary block / hole.

import type { Block } from './field'
import type { Mine } from './mine'
import type { Plus } from './plus'
import type { Shell } from './shell'
import { mag, v3 } from './vec'
import { Cell, type World } from './world'

export type TileGroup = 'teleporter' | 'conveyor' | 'floor' | 'wall' | 'switch' | 'hazard' | 'powerup'

export type TileType = {
  code: number
  /** short machine name (JSON / editor ids) */
  id: string
  name: string
  group: TileGroup
  /** CSS colour for the editor palette / minimap */
  colour: string
  /** one-character glyph for the editor palette (and the default ASCII-map character) */
  icon: string
  description: string
  /** tanks cannot drive through it */
  solid: boolean
  /** shells fly over it (water) */
  shellsPass?: boolean
}

const TILES: TileType[] = [
  ...['A', 'B', 'C', 'D'].map(
    (n, i): TileType => ({
      code: 500 + i,
      id: `teleporter_${n.toLowerCase()}`,
      name: `Teleporter ${n}`,
      group: 'teleporter',
      colour: ['#38c8ff', '#ff8a2a', '#9cff3a', '#ff4ad0'][i],
      icon: 'TUVW'[i],
      description: 'Tanks and shells that cross it come out of the other pad with the same letter.',
      solid: false,
    }),
  ),
  ...['north', 'east', 'south', 'west'].map(
    (d, i): TileType => ({
      code: 510 + i,
      id: `conveyor_${d}`,
      name: `Conveyor (${d})`,
      group: 'conveyor',
      colour: '#c9a53a',
      icon: '^>v<'[i],
      description: `Pushes tanks ${d}.`,
      solid: false,
    }),
  ),
  { code: 520, id: 'ice', name: 'Ice', group: 'floor', colour: '#bfe8ff', icon: '*', description: 'Slippery: tanks keep sliding and turn wide.', solid: false },
  { code: 521, id: 'mud', name: 'Mud', group: 'floor', colour: '#6b4a2a', icon: '%', description: 'Tanks drive at half speed.', solid: false },
  { code: 530, id: 'bouncy', name: 'Bumper wall', group: 'wall', colour: '#ff5fa0', icon: 'B', description: 'Shells bounce off it without using up a ricochet.', solid: true },
  { code: 531, id: 'glass', name: 'Glass', group: 'wall', colour: '#a8e4f0', icon: 'G', description: 'Breaks when a shell or a mine blast hits it (the shell is spent).', solid: true },
  { code: 532, id: 'crate', name: 'Crate', group: 'wall', colour: '#c08040', icon: 'C', description: 'Breaks on a shell or blast hit and may drop a power-up.', solid: true },
  { code: 540, id: 'switch', name: 'Switch', group: 'switch', colour: '#ffd23a', icon: 'S', description: 'Drive onto it or shoot over it to open closed gates and close open ones.', solid: false },
  { code: 541, id: 'gate', name: 'Gate (closed)', group: 'switch', colour: '#d0a020', icon: 'D', description: 'A wall that a switch opens.', solid: true },
  { code: 542, id: 'gate_open', name: 'Gate (open)', group: 'switch', colour: '#806010', icon: 'O', description: 'An open gate that a switch closes (once nothing is in the way).', solid: false },
  { code: 550, id: 'water', name: 'Water', group: 'floor', colour: '#2a78c8', icon: '~', description: 'Tanks cannot cross it; shells fly over it.', solid: true, shellsPass: true },
  ...['north', 'east', 'south', 'west', 'north', 'east', 'south', 'west'].map(
    (d, i): TileType => ({
      code: 560 + i,
      id: `laser_${d}${i < 4 ? '' : '_b'}`,
      name: `Laser (${d}${i < 4 ? '' : ', alternate'})`,
      group: 'hazard',
      colour: i < 4 ? '#ff3030' : '#ff30a0',
      icon: i < 4 ? 'NLZJ'[i] : 'nlzj'[i - 4],
      description: `An emitter whose beam (${d}) destroys any tank crossing it while lit. Lit 2.5 s, dark 2.5 s; alternate emitters are lit while the others are dark. It flickers before lighting.`,
      solid: true,
    }),
  ),
  { code: 570, id: 'gravity_well', name: 'Gravity well', group: 'hazard', colour: '#7a40ff', icon: '@', description: 'Bends the path of nearby shells toward its centre.', solid: false },
  ...['rapid', 'bounce', 'shield', 'speed', 'mine', 'rocket'].map(
    (p, i): TileType => ({
      code: 580 + i,
      id: `pad_${p}`,
      name: `Power-up pad (${p})`,
      group: 'powerup',
      colour: ['#ff5040', '#40c0ff', '#80ffd0', '#ffe040', '#ff9020', '#c070ff'][i],
      icon: 'P',
      description: `Holds a ${p} power-up; it comes back 15 s after it is taken.`,
      solid: false,
    }),
  ),
]
const BY_CODE = new Map(TILES.map((t) => [t.code, t]))

/** every special tile (for the level editor) */
export function tileTypes(): TileType[] {
  return TILES.map((t) => ({ ...t }))
}
export function tileType(code: number): TileType | undefined {
  return BY_CODE.get(code)
}

/** edge ids of tile blocks: EDGE_TAG + tile index (original blocks and border walls use 0) */
export const EDGE_TAG = 0x10000

/** conveyor push (units / frame); player top speed is 1.8 */
const CONVEYOR = 0.9
/** ice: fraction of the commanded velocity taken over per frame */
const ICE_GRIP = 0.06
const MUD = 0.5
/** laser cycle (frames): lit [0, LIT), dark, flicker from WARN */
const LASER_PERIOD = 300
const LASER_LIT = 150
const LASER_WARN = 255
/** gravity well reach and pull */
const WELL_RADIUS = 150
const WELL_PULL = 0.12
const BLOCK_H2 = 1 << 4

export type Tile = {
  index: number
  code: number
  type: TileType
  c: number
  r: number
  x: number
  z: number
  block: Block | null
  /** gates: open; switches: pressed this frame */
  open: boolean
  /** gates waiting to close */
  closing: boolean
  /** lasers: 0 dark, 1 flicker (warning), 2 lit; beam end points */
  laser: 0 | 1 | 2
  beam: { x0: number; z0: number; x1: number; z1: number } | null
  /** teleporter partner index */
  partner: number
}

export class Tiles {
  list: Tile[] = []
  private at = new Map<number, Tile>()
  /** shells inside a teleporter / over a switch (no re-trigger until they leave) */
  private shellTp = new WeakSet<Shell>()
  private shellSw = new WeakSet<Shell>()
  private bounced = new WeakMap<Shell, number>()
  private switchCooldown = 0
  /** bumped by every change the renderer must rebuild for */
  version = 0

  constructor(
    private w: World,
    private plus: Plus,
  ) {
    const f = w.field
    for (let r = 0; r < f.rows; r++)
      for (let c = 0; c < f.cols; c++) {
        const code = w.grid[r][c].code
        const type = BY_CODE.get(code)
        if (!type) continue
        const p = f.cellPos(c, r)
        const t: Tile = { index: this.list.length, code, type, c, r, x: p.x, z: p.z, block: null, open: code === 542, closing: false, laser: 0, beam: null, partner: -1 }
        this.list.push(t)
        this.at.set(r * 1000 + c, t)
      }
    // teleporters: each pad sends to the next pad with the same letter (a cycle)
    for (let code = 500; code <= 503; code++) {
      const pads = this.list.filter((t) => t.code === code)
      pads.forEach((t, i) => (t.partner = pads.length > 1 ? pads[(i + 1) % pads.length].index : -1))
    }
  }

  tileAt(c: number, r: number) {
    return this.at.get(r * 1000 + c)
  }
  tileUnder(p: { x: number; z: number }) {
    const [c, r] = this.w.cellAt(p)
    return this.tileAt(c, r)
  }
  pads(group: TileGroup) {
    return this.list.filter((t) => t.type.group === group)
  }

  /** RPTnkStageMap::SpawnBlocks for the solid tiles (after the original blocks) */
  spawnBlocks() {
    for (const t of this.list) {
      const g = this.w.grid[t.r][t.c]
      const code = t.code
      if (code === 530 || code === 541 || (code >= 560 && code <= 567)) this.solidify(t, BLOCK_H2 | 1, Cell.Block, 2)
      else if (code === 531 || code === 532) this.solidify(t, BLOCK_H2, Cell.Cork, 2)
      else if (code === 550) this.solidify(t, 1, Cell.Hole, 1)
      else {
        g.kind = Cell.Empty
        g.height = 0
      }
    }
    this.updateLasers()
  }

  private solidify(t: Tile, param: number, kind: Cell, height: number) {
    const b = this.w.blocks.spawnAt(t.c, t.r, param)
    if (!b) return
    for (const e of b.edges) e.id = EDGE_TAG + t.index
    t.block = b
    const g = this.w.grid[t.r][t.c]
    g.kind = kind
    g.height = height
    this.version++
  }

  private unsolidify(t: Tile) {
    if (t.block?.active) t.block.kill()
    t.block = null
    const g = this.w.grid[t.r][t.c]
    g.kind = Cell.Empty
    g.height = 0
    this.version++
  }

  // ---- hooks ---------------------------------------------------------------------------

  /** Shell.onHitWall with a tagged edge (several edges can report in one frame) */
  shellHitTile(s: Shell, id: number) {
    const t = this.list[id - EDGE_TAG]
    if (!t || !t.block) return
    if (t.code === 530) {
      // bumper: the bounce is free (Shell.calculate takes one off for the wall contact)
      if (this.bounced.get(s) !== this.w.frame) {
        this.bounced.set(s, this.w.frame)
        s.bouncesLeft++
        this.plus.event('bumper', { x: t.x, y: 0, z: t.z })
      }
    } else if (t.code === 531 || t.code === 532) {
      // glass / crate: breaks (RPTnkBlock::Calculate handles the break), the shell is spent
      t.block.breakRequested = true
      s.bouncesLeft = 0
    }
  }

  /** World.onBlockBreak (mine blasts on glass / crates, and the shell hits above) */
  onBlockBreak(b: Block) {
    const t = this.tileAt(b.col, b.row)
    if (!t || t.block !== b) return
    t.block = null
    const g = this.w.grid[t.r][t.c]
    g.kind = Cell.Empty
    g.height = 0
    this.version++
    if (t.code === 532) this.plus.powerups.crateBroken(t)
    this.plus.event(t.code === 531 ? 'glass' : 'crate', { x: t.x, y: 0, z: t.z })
  }

  /** collision phase (after every actor collided, before Calculate): lasers */
  collide() {
    for (const t of this.list) {
      if (t.laser !== 2 || !t.beam) continue
      const b = t.beam
      this.w.tanks.forEach((k) => {
        if (!k.active || k.lives <= 0 || (k.state !== 1 && k.state !== 2)) return
        if (segDist(k.pos.x, k.pos.z, b.x0, b.z0, b.x1, b.z1) < 14 + 3) k.keepNearestShellHit(HIT_HAZARD, 0)
      })
    }
  }

  /** after Calculate: floor effects on the commanded velocities, pads, switches, wells */
  afterCalc() {
    const w = this.w
    // lasers: phase per emitter set, beams follow the blocks
    if (this.list.some((t) => t.code >= 560 && t.code <= 567)) this.updateLasers()
    for (const k of w.tanks) {
      if (!k.active || k.lives <= 0 || !k.ext) continue
      const x = k.ext
      if (k.state !== 1 && k.state !== 2) {
        x.slide = null
        continue
      }
      const tile = this.tileUnder(k.pos)
      const code = tile?.code ?? 0
      if (code === 521) {
        k.vel.x *= MUD
        k.vel.z *= MUD
      }
      if (code === 520) {
        const s = x.slide ?? v3(k.vel.x, 0, k.vel.z)
        s.x += (k.vel.x - s.x) * ICE_GRIP
        s.z += (k.vel.z - s.z) * ICE_GRIP
        x.slide = s
        k.vel.x = s.x
        k.vel.z = s.z
      } else x.slide = null
      if (code >= 510 && code <= 513) {
        const d = DIRS[code - 510]
        k.vel.x += d[0] * CONVEYOR
        k.vel.z += d[1] * CONVEYOR
      }
      // teleporters
      if (tile && code >= 500 && code <= 503 && !x.tpLock && tile.partner >= 0 && Math.hypot(k.pos.x - tile.x, k.pos.z - tile.z) < 12) {
        const to = this.list[tile.partner]
        this.plus.moveTank(k, k.pos.x - tile.x + to.x, k.pos.z - tile.z + to.z)
        x.tpLock = true
        this.plus.event('teleport', { x: tile.x, y: 0, z: tile.z }, k, to.index)
        w.sound('RP_TNK_SE_TNK_DISAPPEAR', k.pos)
      } else if (x.tpLock && !this.list.some((t) => t.code >= 500 && t.code <= 503 && Math.hypot(k.pos.x - t.x, k.pos.z - t.z) < 26)) x.tpLock = false
      // switches: players driving on
      if (!k.isEnemy) {
        const on = code === 540
        if (on && !x.onSwitch) this.toggleGates(tile!)
        x.onSwitch = on
      }
    }
    // shells: teleporters, switches, wells, wind
    const wind = this.plus.wind
    const wells = this.list.filter((t) => t.code === 570)
    for (const s of w.bullets) {
      if (!s.active) continue
      const tile = this.tileUnder(s.pos)
      if (tile && tile.code >= 500 && tile.code <= 503 && tile.partner >= 0) {
        if (!this.shellTp.has(s) && Math.hypot(s.pos.x - tile.x, s.pos.z - tile.z) < 10) {
          const to = this.list[tile.partner]
          s.pos.x += to.x - tile.x
          s.pos.z += to.z - tile.z
          this.shellTp.add(s)
          this.plus.event('teleport', { x: tile.x, y: 0, z: tile.z }, undefined, to.index)
        }
      } else this.shellTp.delete(s)
      if (tile?.code === 540) {
        if (!this.shellSw.has(s)) {
          this.shellSw.add(s)
          this.toggleGates(tile)
        }
      } else this.shellSw.delete(s)
      if (wells.length || wind) {
        const sp = mag(s.vel)
        if (sp === 0) continue
        for (const g of wells) {
          const dx = g.x - s.pos.x
          const dz = g.z - s.pos.z
          const d = Math.hypot(dx, dz)
          if (d > 4 && d < WELL_RADIUS) {
            const k = (WELL_PULL * (1 - d / WELL_RADIUS)) / d
            s.vel.x += dx * k
            s.vel.z += dz * k
          }
        }
        if (wind) {
          s.vel.x += wind.x
          s.vel.z += wind.z
        }
        const n = mag(s.vel)
        if (n !== 0) {
          s.vel.x *= sp / n
          s.vel.z *= sp / n
        }
      }
    }
    // gates waiting for their cell to clear
    for (const t of this.list) if (t.closing && this.cellClear(t)) this.closeGate(t)
    if (this.switchCooldown > 0) this.switchCooldown--
  }

  private toggleGates(sw: Tile) {
    if (this.switchCooldown > 0) return
    this.switchCooldown = 20
    sw.open = !sw.open
    for (const t of this.list) {
      if (t.code !== 541 && t.code !== 542) continue
      if (t.closing) {
        // still waiting to close: stays open
        t.closing = false
        t.open = true
      } else if (t.open) {
        // open -> close (waits for the cell to clear)
        t.open = false
        t.closing = true
        if (this.cellClear(t)) this.closeGate(t)
      } else {
        t.open = true
        this.unsolidify(t)
      }
    }
    this.plus.event('switch', { x: sw.x, y: 0, z: sw.z })
    this.w.sound('RP_TNK_SE_JIRAI_SET', { x: sw.x, y: 0, z: sw.z })
  }

  private closeGate(t: Tile) {
    t.closing = false
    this.solidify(t, BLOCK_H2 | 1, Cell.Block, 2)
  }

  /** nothing overlapping the cell (tanks: radius 16, mines: 17.1) */
  private cellClear(t: Tile) {
    const h = 17.5
    for (const k of this.w.tanks) if (k.active && Math.abs(k.pos.x - t.x) < h + 17 && Math.abs(k.pos.z - t.z) < h + 17) return false
    for (const m of this.w.mines as Mine[]) if (Math.abs(m.pos.x - t.x) < h + 18 && Math.abs(m.pos.z - t.z) < h + 18) return false
    return true
  }

  private updateLasers() {
    const w = this.w
    const f = this.plus.frame
    for (const t of this.list) {
      if (t.code < 560 || t.code > 567) continue
      if (!t.block) {
        t.laser = 0
        t.beam = null
        continue
      }
      const phase = (f + (t.code >= 564 ? LASER_PERIOD / 2 : 0)) % LASER_PERIOD
      t.laser = phase < LASER_LIT ? 2 : phase >= LASER_WARN ? 1 : 0
      const [dc, dr] = DIRS[(t.code - 560) % 4]
      let c = t.c
      let r = t.r
      for (;;) {
        const nc = c + dc
        const nr = r + dr
        if (nc < 0 || nr < 0 || nc >= w.width || nr >= w.height) break
        const k = w.grid[nr][nc].kind
        if (k === Cell.Block || k === Cell.Cork) break
        c = nc
        r = nr
      }
      const half = 17.5
      const end = w.field.cellPos(c, r)
      t.beam = { x0: t.x + dc * half, z0: t.z + dr * half, x1: end.x + dc * half, z1: end.z + dr * half }
    }
  }
}

/** hit id of hazards (lasers, kamikaze blasts): nobody is credited (World.onTankExplode) */
export const HIT_HAZARD = 15

/** north (-z), east (+x), south (+z), west (-x) as [dc, dr] / [dx, dz] */
const DIRS: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
]

export function segDist(px: number, pz: number, x0: number, z0: number, x1: number, z1: number) {
  const dx = x1 - x0
  const dz = z1 - z0
  const l2 = dx * dx + dz * dz
  let t = l2 ? ((px - x0) * dx + (pz - z0) * dz) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (x0 + t * dx), pz - (z0 + t * dz))
}

/** true when a cell code needs the Tanks+ extension */
export function isSpecialCode(code: number) {
  return code >= 500 && code <= 599
}
