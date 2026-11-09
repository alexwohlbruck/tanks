// RPTnkField (RPTnkField.cpp), RPTnkTestCircleVsWall (RPTnkField_3.cpp), RPTnkBlock
// (RPTnkBlock.cpp) and RPTnkBlockPool (RPTnkBlock_2.cpp).
//
// Block kinds: 0 = cork (map 1xx, destroyed by mine blasts), 1 = wood (map 2xx), 2 = never used.
// Stack height = map digit + 1. Height-1 blocks (map 200) are the holes: tanks and mines
// collide with them, shells fly over them (collide mode bit 0) and the muzzle test ignores them.

import { Actor, ActorPool } from './actor'
import { FIELD, WALL_MARGIN } from './consts'
import { type V3, v3, ZERO } from './vec'
import type { World } from './world'

/** RPTnkWall: segment from pos along tangent = Ey x normal, `length` long (backwards). */
export type Wall = { pos: V3; normal: V3; length: number; id: number }

export type WallHit = { normal: V3; depth: number; id: number }

/** RPTnkTestCircleVsWall (RPTnkField_3.cpp), XZ only. */
export function testCircleVsWall(radius: number, p: V3, wall: Wall): WallHit | null {
  const dx = p.x - wall.pos.x
  const dz = p.z - wall.pos.z
  // tangent = Ey x normal = (nz, 0, -nx)
  const tx = wall.normal.z
  const tz = -wall.normal.x
  const along = dx * tx + dz * tz
  if (along > radius) return null
  const beyond = -along - wall.length
  if (beyond > radius) return null
  const dist = dx * wall.normal.x + dz * wall.normal.z
  let depth = radius - dist
  if (depth < 0) return null
  if (-dist > 8) return null
  let sq: number
  if (along > 0) {
    if (along > dist) return null
    sq = along * along
  } else if (beyond > 0) {
    if (beyond > dist) return null
    sq = beyond * beyond
  } else {
    return { normal: wall.normal, depth, id: wall.id }
  }
  depth = Math.sqrt(radius * radius - sq) - dist
  if (depth < 0) return null
  return { normal: wall.normal, depth, id: wall.id }
}

export class Block extends Actor {
  blockKind = 0
  state = 0
  edges: Wall[] = []
  /** -z, +x, +z, -x: 0 none, 1 hole (height 1), 2 block */
  neighbors = [0, 0, 0, 0]
  breakRequested = false
  blockHeight = 1
  /** map cell (not in the original; for the renderer) */
  col = 0
  row = 0

  constructor(private w: World) {
    super()
  }

  /** RPTnkBlock::OnSpawn */
  override onSpawn() {
    const f = this.w.field
    this.hitRadius = 1
    this.scale.x = (0.5 * f.cellW) / 17.5
    this.scale.y = (0.5 * f.cellW) / 17.5
    this.scale.z = (0.5 * f.cellD) / 17.5
    this.blockKind = 0
    this.state = 0
  }

  /** RPTnkBlock::ApplySpawnParam: kind bits 0-1, height - 1 in bits 4-6 */
  override applySpawnParam(param: number) {
    this.blockKind = param & 3
    this.setupEdges()
    this.lookUpNeighbors()
    this.blockHeight = ((param >> 4) & 7) + 1
  }

  /** RPTnkBlock::SetupEdges */
  setupEdges() {
    const { cellW: w, cellD: d } = this.w.field
    const { x, z } = this.pos
    this.edges = [
      { pos: v3(-(0.5 * w - x), 0, -(0.5 * d - z)), normal: v3(0, 0, -1), length: w, id: 0 },
      { pos: v3(0.5 * w + x, 0, -(0.5 * d - z)), normal: v3(1, 0, 0), length: d, id: 0 },
      { pos: v3(0.5 * w + x, 0, 0.5 * d + z), normal: v3(0, 0, 1), length: w, id: 0 },
      { pos: v3(-(0.5 * w - x), 0, 0.5 * d + z), normal: v3(-1, 0, 0), length: d, id: 0 },
    ]
  }

  private lookUpNeighbors() {
    const f = this.w.field
    const bp = this.w.blocks
    const { x, z } = this.pos
    this.neighbors[0] = bp.getBlockAt(x, z - f.cellD)
    this.neighbors[1] = bp.getBlockAt(x + f.cellW, z)
    this.neighbors[2] = bp.getBlockAt(x, z + f.cellD)
    this.neighbors[3] = bp.getBlockAt(x - f.cellW, z)
  }

  override kind() {
    return this.blockKind
  }
  override height() {
    return this.blockHeight
  }

  /** RPTnkBlock::ClearForcesStep: re-reads the neighbours every frame */
  override clearForcesStep() {
    this.clearForces()
    this.lookUpNeighbors()
    this.breakRequested = false
  }

  /** RPTnkBlock::CollideWithField: cork blocks flag a break inside a mine explosion */
  override collideWithField() {
    if (this.blockKind === 0) {
      this.hitRadius = 0.5 * this.w.field.cellW
      if (this.w.minePool.isInExplosion(this)) this.breakRequested = true
    }
  }

  /** RPTnkBlock::Calculate -> StateBreakIfFlagged */
  override calculate() {
    if (this.breakRequested) {
      this.w.onBlockBreak(this)
      this.kill()
    }
  }

  /** RPTnkBlock::CollideObject: pushes `other` out of the block's edges */
  override collideObject(other: Actor, mode: number): boolean {
    if (mode & 1 && this.blockHeight === 1) return false
    const radius = other.hitRadius
    const c = other.hitCenter()
    const f = this.w.field
    if (Math.abs(c.x - this.pos.x) > f.cellW + radius) return false
    if (Math.abs(c.z - this.pos.z) > f.cellD + radius) return false
    let hit = false
    for (let i = 0; i < 4; i++) {
      if (mode & 2 && this.neighbors[i] === 2) continue
      const h = testCircleVsWall(radius, c, this.edges[i])
      if (h) {
        other.onHitWall(h.depth, h.normal, h.id, ZERO)
        hit = true
      }
    }
    return hit
  }
}

export class BlockPool extends ActorPool<Block> {
  /** cell lookup replacing the original's linear scan with exact position compare */
  private byCell = new Map<number, Block>()

  constructor(private w: World, n: number) {
    super(n, () => new Block(w))
  }

  override reset() {
    super.reset()
    this.byCell.clear()
  }

  spawnAt(col: number, row: number, param: number) {
    const b = this.spawn(this.w.field.cellPos(col, row), param)
    if (b) {
      b.col = col
      b.row = row
      this.byCell.set(row * 1000 + col, b)
    }
    return b
  }

  /** RPTnkBlockPool::GetBlockAt: 0 none, 1 an active height-1 block, 2 any other block */
  getBlockAt(x: number, z: number): number {
    if (this.activeNum === 0) return 0
    const f = this.w.field
    const col = Math.round((x - f.originX) / f.cellW)
    const row = Math.round((z - f.originZ) / f.cellD)
    const b = this.byCell.get(row * 1000 + col)
    if (!b || !b.active) return 0
    if (Math.abs(b.pos.x - x) > 1e-3 || Math.abs(b.pos.z - z) > 1e-3) return 0
    return b.blockHeight === 1 ? 1 : 2
  }

  /** RPTnkBlockPool::CollideObject: every active block of kind != 2 */
  collideObject(actor: Actor, mode: number): boolean {
    if (this.activeNum === 0) return false
    let hit = false
    for (const b of this.items) if (b.active && b.blockKind !== 2) hit = b.collideObject(actor, mode) || hit
    return hit
  }

  /** RPTnkBlockPool::KillAllBlocks */
  killAllBlocks() {
    if (this.activeNum === 0) return
    for (const b of this.items) if (b.active && b.blockKind !== 2) b.kill()
  }

  /** RPTnkBlockPool::IsPointInsideBlock: ignores holes (height 1); bounds inclusive */
  isPointInsideBlock(p: V3): boolean {
    if (this.activeNum === 0) return false
    const hw = this.w.field.cellW / 2
    const hd = this.w.field.cellD / 2
    for (const b of this.items) {
      if (!b.active || b.blockKind === 2 || b.blockHeight === 1) continue
      if (b.pos.x - hw <= p.x && b.pos.x + hw >= p.x && b.pos.z - hd <= p.z && b.pos.z + hd >= p.z) return true
    }
    return false
  }

  /** RPTnkBlockPool::IsKind0BlockNear */
  isKind0BlockNear(radius: number, p: V3): boolean {
    if (this.activeNum === 0) return false
    const hw = this.w.field.cellW / 2
    for (const b of this.items) {
      if (!b.active || b.blockKind !== 0) continue
      if (Math.hypot(b.pos.x - p.x, b.pos.z - p.z) < hw + radius) return true
    }
    return false
  }
}

/** RPTnkField: size, grid and the four border walls. */
export class Field {
  width: number
  depth: number
  cols: number
  rows: number
  cellW: number
  cellD: number
  walls: Wall[]

  /** `size`: [arena] a bigger field of 35-unit cells (not in the original) */
  constructor(aspect: keyof typeof FIELD = '16_9', size?: { cols: number; rows: number }) {
    // RPTnkField::Reset
    const f = size ? { width: size.cols * 35, depth: size.rows * 35, cols: size.cols, rows: size.rows } : FIELD[aspect]
    this.width = f.width
    this.depth = f.depth
    this.cols = f.cols
    this.rows = f.rows
    this.cellW = this.width / this.cols
    this.cellD = this.depth / this.rows
    this.walls = this.initWalls()
  }

  get originX() {
    return -0.5 * ((this.cols - 1) * this.cellW)
  }
  get originZ() {
    return -0.5 * ((this.rows - 1) * this.cellD)
  }

  /** RPTnkField::GetCellPos: grid centred on the origin; row 0 at -z */
  cellPos(x: number, y: number): V3 {
    return v3(this.cellW * x + this.originX, 0, this.cellD * y + this.originZ)
  }

  /** RPTnkField::InitWalls */
  private initWalls(): Wall[] {
    const h = 0.5
    const m = WALL_MARGIN
    const w = this.width
    const d = this.depth
    return [
      { pos: v3(h * w + m, 0, h * -d), normal: v3(0, 0, 1), length: w + 2 * m, id: 0 },
      { pos: v3(h * w, 0, h * d + m), normal: v3(-1, 0, 0), length: d + 2 * m, id: 0 },
      { pos: v3(-(h * w + m), 0, h * d), normal: v3(0, 0, -1), length: w + 2 * m, id: 0 },
      { pos: v3(-(h * w), 0, -(h * d + m)), normal: v3(1, 0, 0), length: d + 2 * m, id: 0 },
    ]
  }

  /** RPTnkField::IsInside (bounds inclusive) */
  isInside(p: V3) {
    return -this.width * 0.5 <= p.x && this.width * 0.5 >= p.x && -this.depth * 0.5 <= p.z && this.depth * 0.5 >= p.z
  }
}

/**
 * RPTnkField::CollideActor: the four border walls, then every block. mode bit 0 = pass over
 * holes (shells, shot probes), bit 1 = skip edges shared with a non-hole neighbour (shells).
 */
export function collideActor(w: World, actor: Actor, mode: number): boolean {
  const radius = actor.hitRadius
  const c = actor.hitCenter()
  let hit = false
  for (const wall of w.field.walls) {
    const h = testCircleVsWall(radius, c, wall)
    if (h) {
      actor.onHitWall(h.depth, h.normal, h.id, ZERO)
      hit = true
    }
  }
  return w.blocks.collideObject(actor, mode) || hit
}
