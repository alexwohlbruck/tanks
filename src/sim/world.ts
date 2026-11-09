// Deterministic Tanks! simulation: a port of the gameplay half of RPTnkScene::UpdateGameplay
// with RPTnkTankManager, RPTnkWeaponManager, RPTnkField/RPTnkBlockPool and RPTnkStageMap.
// Rendering and audio observe it through `events` and entity state; they never mutate it.
//
// ===== Interface (for renderer / HUD / audio) ==============================================
// Units: original world units (1 cell = 35). Field 770 x 595 (16:9, 22 x 17 cells) or
// 560 x 595 (4:3, 16 x 17), centred on the origin; row 0 is at -z (far side of the screen),
// +x is screen right, +y up. cellCenter(c, r) = (35c - 17.5(cols-1), 35r - 17.5(rows-1)).
// Angles: `body` / `turret` = atan2(forward.z, forward.x), 0 = +x, increasing toward +z
// (down the screen). Renderer: rotation.y = -angle for a model whose forward is +x. The
// original models face +z (mRot.z is forward): for those use rotation.y = PI/2 - angle, or
// build the matrix from `tank.rot` / `tank.turretRot` (basis vectors x, y, z) directly.
//
// World
//   width, height            grid columns / rows
//   grid[r][c]               { kind: Cell, code, height } (height = stack 1..8, 0 empty)
//   cellCenter(c, r)         {x, y: 0, z}
//   field                    Field (width, depth, cellW, cellD, walls)
//   tanks: Tank[]            tanks spawned by the current stage load, players first
//                            (id, type 0..9, team 0-3 players / TEAM_ENEMY, slot, pos {x,y,z},
//                            body, turret, rot, turretRot, alive, invisible, odometer,
//                            moving, speed, intent, state, stealth)
//   bullets: Shell[]         active shells (id, pos {x,y,z} (y = 17.6), vel, fast, type
//                            (shooter enemy type, 0 player), smokeType 0/1/2, team, slot)
//   mines: Mine[]            laid, not yet exploding (id, pos, timer, fuseLit, armed, team)
//   explosions: Mine[]       exploding mines (pos, timer 0..40, blastRadius 8..80)
//   checkMarks: CheckMark[]  X marks (id, pos, color 0 P1 / 1 P2 / 2 enemy), max 16
//   playerFacing: [deg, deg] start balloon orientation from the map header (0/180/90/270)
//   events: SimEvent[]       drained by Game every frame
//   frame                    physics steps since the world was created
//   step()                   one full gameplay frame (pool counts + physics); Game calls
//                            countPools() / physics() itself so it can freeze
//
// SimEvent kinds (payloads below): shoot, ricochet, bulletDie, tankDie, mineSet, mineFuse,
// mineExplode, mineGone, blockBreak, cantFire, stealth, shellClash, shellsFrozen, rumble,
// tread (one 30x30 tread mark stamp), se (one-shot sound, brsar name), seHold (looped sound
// that must keep playing this frame; stop when a key stops appearing), bgm / bgmStop / bgmMask
// (music; emitted by Game). Game forwards se/seHold/bgm* to `game.audio` when one is attached.
// =========================================================================================

import { Actor, ActorPool, nextId } from './actor'
import { POOL, TANK, MAX_PLAYERS, HIT_ENEMY, TEAM_ENEMY } from './consts'
import { BlockPool, Field } from './field'
import { Mine, MinePool } from './mine'
import { RPRandom } from './rng'
import { Shell, ShellPool, type ShellDeath } from './shell'
import { Tank } from './tank'
import { type V3, normalize, v3, vcopy } from './vec'

export type { Team, Intent } from './tank'
export { Tank } from './tank'
export { Shell } from './shell'
export { Mine } from './mine'

export type Vec = { x: number; z: number }

export const enum Cell {
  Empty = 0,
  /** wood block, stack height 2-8 (map 201-207) */
  Block = 1,
  /** cork block, destroyed by mine blasts (map 101-107) */
  Cork = 2,
  /** hole: height-1 block (map 200); stops tanks and mines, shells fly over */
  Hole = 3,
}

export type GridCell = { kind: Cell; code: number; height: number }

/** stage description handed to World.loadStage (built by Game from TnkGameParam + maps) */
export type StageMapData = { width: number; height: number; cells: number[][]; facing?: number[] }

export type SimEvent =
  | { t: 'shoot'; tank: Tank; bullet: Shell | null }
  | { t: 'ricochet'; bullet: Shell; pos: V3; super: boolean }
  | { t: 'bulletDie'; bullet: Shell; pos: V3; reason: ShellDeath }
  | { t: 'tankDie'; tank: Tank; by: number; cause: 'shell' | 'mine'; killer: number | null }
  | { t: 'mineSet'; mine: Mine }
  | { t: 'mineFuse'; mine: Mine; near: boolean }
  | { t: 'mineExplode'; mine: Mine }
  | { t: 'mineGone'; mine: Mine }
  | { t: 'blockBreak'; cx: number; cz: number; height: number }
  | { t: 'cantFire'; tank: Tank }
  | { t: 'stealth'; tank: Tank }
  | { t: 'shellClash'; pos: V3 }
  | { t: 'shellsFrozen' }
  | { t: 'rumble'; player: number; frames: number }
  | { t: 'tread'; tank: Tank; pos: V3; dir: V3 }
  | { t: 'se'; name: string; pos?: V3; tank?: Tank }
  | { t: 'seHold'; name: string; key: number; pos?: V3 }
  | { t: 'bgm'; name: string }
  | { t: 'bgmStop'; fade: number }
  | { t: 'bgmMask'; mask: number }

/** RPTnkCheckMark: the X left where a tank was destroyed */
export class CheckMark extends Actor {
  color = 0
  override onSpawn() {
    this.pos.y = 0.2
    this.scale.x = this.scale.y = this.scale.z = 1
  }
  override applySpawnParam(p: number) {
    this.color = p & 0xf
  }
  override calculate() {
    this.vel.x = this.vel.y = this.vel.z = 0
  }
}

/** callbacks into the game manager / stats (RPTnkGameStats, RPTnkStageMap::SetEnemyActive) */
export type WorldHooks = {
  /** RPTnkGameStats::AddKill (player 0/1, enemy type 1-9) */
  addKill(player: number, type: number, pos: V3): void
  /** RPTnkGameStats::AddKilledType (type 1-9); RPTnkTank::SetExGuideTarget on mission 1 */
  enemySpawned(type: number, tank: Tank): void
  /** RPTnkStageMap::SetEnemyActive(slot, false) */
  enemyDestroyed(slot: number): void
}

export class World {
  rng: RPRandom
  field: Field
  blocks: BlockPool
  shellPool: ShellPool
  minePool: MinePool
  marks: ActorPool<CheckMark>
  playerTanks: Tank[]
  enemyTanks: Tank[]
  /** RPTnkTankManager::mActivePlayerNum */
  /** 1-4 (the original: 1 or 2) */
  players: number
  enemyAliveNum = 0
  private enemyNext = 0

  // ---- public view ----
  width: number
  height: number
  grid: GridCell[][] = []
  tanks: Tank[] = []
  bullets: Shell[] = []
  mines: Mine[] = []
  explosions: Mine[] = []
  checkMarks: CheckMark[] = []
  playerFacing: [number, number] = [0, 0]
  events: SimEvent[] = []
  frame = 0
  hooks: WorldHooks = { addKill() {}, enemySpawned() {}, enemyDestroyed() {} }
  /** 1P: enemy-on-enemy kills are credited to P1 (RPTnkTank::Explode hitId 3) */
  twoPlayerMode: boolean

  constructor(players: number, opts: { aspect?: '16_9' | '4_3'; rng?: RPRandom } = {}) {
    this.players = players
    this.twoPlayerMode = players >= 2
    this.rng = opts.rng ?? new RPRandom(1)
    this.field = new Field(opts.aspect ?? '16_9')
    this.width = this.field.cols
    this.height = this.field.rows
    this.blocks = new BlockPool(this, POOL.blocks)
    this.shellPool = new ShellPool(this, POOL.shells)
    this.minePool = new MinePool(this, POOL.mines)
    this.marks = new ActorPool(POOL.checkMarks, () => new CheckMark())
    this.playerTanks = Array.from({ length: MAX_PLAYERS }, (_, i) => new Tank(this, false, i))
    this.enemyTanks = Array.from({ length: POOL.enemies }, (_, i) => new Tank(this, true, i))
    this.reset()
  }

  /** RPTnkScene::Reset order: field, tank manager (AI resets draw 2 random numbers per tank),
   * weapon manager */
  reset() {
    this.blocks.reset()
    for (const t of this.playerTanks) t.reset()
    for (const t of this.enemyTanks) t.reset()
    this.enemyNext = 0
    this.enemyAliveNum = 0
    this.marks.reset()
    this.shellPool.reset()
    this.minePool.reset()
    this.grid = []
    this.tanks = []
    this.syncView()
  }

  // ---- geometry ----------------------------------------------------------------------------

  cellCenter(c: number, r: number): V3 {
    return this.field.cellPos(c, r)
  }
  cellAt(p: Vec): [number, number] {
    const f = this.field
    return [Math.round((p.x - f.originX) / f.cellW), Math.round((p.z - f.originZ) / f.cellD)]
  }
  get halfW() {
    return this.field.width / 2
  }
  get halfH() {
    return this.field.depth / 2
  }

  players_() {
    return this.tanks.filter((t) => !t.isEnemy)
  }
  enemies() {
    return this.tanks.filter((t) => t.isEnemy)
  }

  emit(e: SimEvent) {
    this.events.push(e)
  }
  sound(name: string, pos?: V3, tank?: Tank) {
    this.events.push({ t: 'se', name, pos: pos ? vcopy(pos) : undefined, tank })
  }
  soundHold(name: string, key: number, pos?: V3) {
    this.events.push({ t: 'seHold', name, key, pos: pos ? vcopy(pos) : undefined })
  }

  // ---- RPTnkStageMap ---------------------------------------------------------------------

  /**
   * RPTnkStageMap::LoadStage / ReloadStage. `types` are the per-slot enemy types (already
   * resolved), `active` the slots still alive (ReloadStage), `swap` swaps the P1/P2 spawns.
   * Blocks are spawned row by row (SpawnBlocks), then players, then enemies in slot order.
   * `chooseType` is called per occupied slot right before its spawn (LoadStage interleaves
   * ChooseEnemyType's random draw with SpawnEnemy's two AI-reset draws).
   */
  loadStage(map: StageMapData, slots: number[], opts: { swap: boolean; active?: boolean[]; chooseType?: (v: number) => number }) {
    const f = this.field
    const playerPos: (V3 | null)[] = [null, null, null, null]
    const enemyPos: V3[] = Array.from({ length: 8 }, () => v3())
    this.grid = []
    for (let y = 0; y < f.rows; y++) {
      const row: GridCell[] = []
      for (let x = 0; x < f.cols; x++) {
        const code = map.cells[y]?.[x] ?? 0
        row.push({ kind: cellKind(code), code, height: cellHeight(code) })
        if (code >= 300 && code < 300 + MAX_PLAYERS) playerPos[code - 300] = f.cellPos(x, y)
        else if (code >= 400 && code <= 407) enemyPos[code - 400] = f.cellPos(x, y)
      }
      this.grid.push(row)
    }
    // ReadPlayerAngles: 0/1/2/3 -> 0/180/90/270
    const ang = [0, 180, 90, 270]
    const fc = map.facing ?? [0, 0]
    this.playerFacing = [ang[fc[0]] ?? 0, ang[fc[1]] ?? 0]
    // SpawnBlocks
    this.blocks.killAllBlocks()
    for (let y = 0; y < f.rows; y++)
      for (let x = 0; x < f.cols; x++) {
        const code = this.grid[y][x].code
        if (code >= 100 && code <= 107) this.blocks.spawnAt(x, y, (code - 100) << 4)
        else if (code >= 200 && code <= 207) this.blocks.spawnAt(x, y, ((code - 200) << 4) | 1)
      }
    // players
    // spawns the map lacks (3-4 players on original maps) go to the nearest free cell
    const spawns = this.fillPlayerSpawns(playerPos)
    if (opts.swap) {
      ;[spawns[0], spawns[1]] = [spawns[1], spawns[0]]
      this.playerFacing = [this.playerFacing[1], this.playerFacing[0]]
    }
    for (let i = 0; i < this.players; i++) this.playerTanks[i].spawnPlayer(spawns[i], 0, true)
    // enemies
    const types: number[] = []
    for (let i = 0; i < 8; i++) {
      let type = slots[i] ?? 0
      if (type > 0 && (!opts.active || opts.active[i])) {
        if (opts.chooseType) type = opts.chooseType(type)
        types[i] = type
        this.spawnNextEnemy(enemyPos[i], type, i, true)
      } else types[i] = opts.active ? type : 0
    }
    this.tanks = [...this.playerTanks.slice(0, this.players).filter((t) => t.active), ...this.enemyTanks.filter((t) => t.active)]
    this.syncView()
    return types
  }

  /** RPTnkTankManager::SpawnNextEnemy */
  private spawnNextEnemy(pos: V3, type: number, idx: number, show: boolean) {
    if (this.enemyAliveNum >= POOL.enemies) return
    let i = this.enemyNext
    do {
      const t = this.enemyTanks[i]
      if (t.age < 0) {
        t.spawnEnemy(pos, type, idx, show)
        this.enemyAliveNum++
        this.enemyNext = i === POOL.enemies - 1 ? 0 : i + 1
        return
      }
      i = i === POOL.enemies - 1 ? 0 : i + 1
    } while (i !== this.enemyNext)
  }

  /** RPTnkTankManager::DeactivateAll + RPTnkWeaponManager::DeactivateAll + KillAllBlocks */
  deactivateAll() {
    for (let i = 0; i < this.players; i++) this.playerTanks[i].kill()
    for (const t of this.enemyTanks) t.kill()
    this.enemyAliveNum = 0
    this.enemyNext = 0
    this.marks.killAll()
    this.shellPool.killAll()
    this.minePool.killAll()
    this.blocks.killAllBlocks()
    this.syncView()
  }

  activatePlayers() {
    for (let i = 0; i < this.players; i++) if (this.playerTanks[i].active) this.playerTanks[i].activate()
  }
  activateEnemies() {
    for (const t of this.enemyTanks) if (t.active) t.activate()
  }

  // ---- RPTnkTankManager queries ------------------------------------------------------------

  private forTanks(f: (t: Tank) => void) {
    for (let i = 0; i < this.players; i++) if (this.playerTanks[i].active) f(this.playerTanks[i])
    for (const t of this.enemyTanks) if (t.active) f(t)
  }

  /** RPTnkTankManager::SeparateTank: every other tank pushes `tank` out */
  separateTank(tank: Tank) {
    if (!tank.isEnemy) {
      if (this.players >= 2) for (let i = 0; i < this.players; i++) if (this.playerTanks[i] !== tank && this.playerTanks[i].active) this.playerTanks[i].pushApartFrom(tank)
      for (const e of this.enemyTanks) if (e.active) e.pushApartFrom(tank)
    } else {
      for (let i = 0; i < this.players; i++) if (this.playerTanks[i].active) this.playerTanks[i].pushApartFrom(tank)
      for (const e of this.enemyTanks) if (e.active && e !== tank) e.pushApartFrom(tank)
    }
  }

  /** RPTnkTankManager::FindShellHit: nearest tank whose shell circle touches the shell */
  findShellHit(shell: Actor): { tank: Tank; dist: number } | null {
    let nearest = 10000
    let best: Tank | null = null
    this.forTanks((t) => {
      const d = t.testHitAlt(shell)
      if (d !== null && d < nearest) {
        nearest = d
        best = t
      }
    })
    return best ? { tank: best, dist: nearest } : null
  }

  /** RPTnkTankManager::FindMineHit: nearest tank within 14 + the mine's current radius */
  findMineHit(mine: Actor): { tank: Tank; dist: number } | null {
    let nearest = 10000
    let best: Tank | null = null
    this.forTanks((t) => {
      const d = t.testHit(mine)
      if (d !== null && d < nearest) {
        nearest = d
        best = t
      }
    })
    return best ? { tank: best, dist: nearest } : null
  }

  /** RPTnkTankManager::TestMineHitTank(mine, idx, enemy) */
  testMineHitTank(mine: Actor, idx: number, enemy: boolean): boolean {
    const t = enemy ? this.enemyTanks[idx] : this.playerTanks[idx]
    if (!t || t.age < 0) return false
    return t.testHit(mine) !== null
  }

  /** RPTnkTankManager::GetNearestEnemyDistance(actor) */
  nearestEnemyDistance(a: Actor): number {
    let nearest = 10000
    for (const t of this.enemyTanks) {
      if (t === a || !t.active) continue
      const d = Math.hypot(t.pos.x - a.pos.x, t.pos.z - a.pos.z)
      if (nearest > d) nearest = d
    }
    return nearest
  }

  /** RPTnkTankManager::GetMaxActiveEnemyType (at least 1) */
  maxActiveEnemyType(): number {
    let type = 1
    for (const t of this.enemyTanks) if (t.active && t.enemyType > type) type = t.enemyType
    return type
  }

  /** player spawn positions for every player: map codes 300-303, then free cells next to them */
  private fillPlayerSpawns(given: (V3 | null)[]): V3[] {
    const f = this.field
    const taken = new Set<string>()
    const out: V3[] = []
    const cellOf = (p: V3) => [Math.round(p.x / 35 + (f.cols - 1) / 2), Math.round(p.z / 35 + (f.rows - 1) / 2)]
    for (const p of given) if (p) taken.add(cellOf(p).join(','))
    const free = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < f.cols && y < f.rows && this.grid[y][x].kind === Cell.Empty && !this.grid[y][x].code && !taken.has(`${x},${y}`)
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const g = given[i]
      if (g) {
        out.push(g)
        continue
      }
      // breadth-first from the nearest given spawn (P1's for odd players, P2's for even)
      const from = given[i % 2] ?? given[0] ?? f.cellPos(1, f.rows - 2)
      const [sx, sy] = cellOf(from)
      const seen = new Set<string>([`${sx},${sy}`])
      const queue: [number, number][] = [[sx, sy]]
      let found: V3 | null = null
      while (queue.length && !found) {
        const [x, y] = queue.shift()!
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const nx = x + dx
          const ny = y + dy
          const k = `${nx},${ny}`
          if (seen.has(k) || nx < 0 || ny < 0 || nx >= f.cols || ny >= f.rows) continue
          seen.add(k)
          if (free(nx, ny)) {
            found = f.cellPos(nx, ny)
            taken.add(k)
            break
          }
          if (this.grid[ny][nx].kind === Cell.Empty) queue.push([nx, ny])
        }
      }
      out.push(found ?? from)
    }
    return out
  }

  /** RPTnkTankManager::GetPlayersDeadState: bit 0 P2 dead, bit 1 P1 dead; 1P: 3 dead, 1 alive */
  playersDeadState(): number {
    const p0 = this.playerTanks[0]
    const p1 = this.playerTanks[1]
    if (this.players === 1) return p0.lives === 0 ? 3 : 1
    if (this.players > 2) {
      for (let i = 0; i < this.players; i++) if (this.playerTanks[i].lives !== 0) return 0
      return 3
    }
    if (p0.lives === 0) return (p1.lives === 0 ? 1 : 0) + 2
    return p1.lives === 0 ? 1 : 0
  }

  /** RPTnkTankManager::LimitAiFlag110 / LimitAiFlag118: from a random start, only the first
   * `limit` tanks about to decide (interval == 1) may do so this frame; the rest wait one more */
  private limitAi(which: 'fire' | 'mine', limit: number) {
    const start = (this.rng.next() & 0xffff) % POOL.enemies
    let count = 0
    let i = start
    do {
      const t = this.enemyTanks[i]
      if (t.active) {
        const a = t.aiCtrl.attack
        if (which === 'fire') {
          if (a.fireInterval === 1 && ++count > limit) a.fireInterval++
        } else if (a.mineInterval === 1 && ++count > limit) a.mineInterval++
      }
      i = i === POOL.enemies - 1 ? 0 : i + 1
    } while (i !== start)
  }

  // ---- step ------------------------------------------------------------------------------

  /** RPTnkScene::UpdateGameplay, first part: per-owner counts (also while frozen) */
  countPools() {
    this.shellPool.countShellsPerOwner()
    this.minePool.countByOwner()
  }

  /** RPTnkScene::UpdateGameplay physics block (skipped while the game manager freezes) */
  physics() {
    this.frame++
    const tanks = (f: (t: Tank) => void) => {
      for (let i = 0; i < this.players; i++) if (this.playerTanks[i].active) f(this.playerTanks[i])
      for (const t of this.enemyTanks) if (t.active) f(t)
    }
    // ApplyVelocities
    tanks((t) => t.applyVelocity())
    this.marks.applyVelocityAll()
    this.shellPool.applyVelocityAll()
    this.minePool.applyVelocityAll()
    // ClearHitInfo / ClearHitFlags
    tanks((t) => t.clearForcesStep())
    this.shellPool.clearForcesAll()
    this.minePool.clearForcesAll()
    this.blocks.clearForcesAll()
    // ResolveCollisions / CheckCollisions
    tanks((t) => t.collideWithField())
    this.shellPool.collideAllWithField()
    this.minePool.collideAllWithField()
    this.blocks.collideAllWithField()
    // UpdateTreadDistances / IntegrateAll
    tanks((t) => t.integrateStep())
    this.shellPool.integrateAll()
    this.minePool.integrateAll()
    this.blocks.integrateAll()
    this.limitAi('fire', 2)
    this.limitAi('mine', 1)
    // CalcTanks / CalcAll
    tanks((t) => t.calculate())
    this.marks.calcAll()
    this.shellPool.calcAll()
    this.minePool.calcAll()
    this.blocks.calcAll()
    // IncrementTimers / TickAge
    for (let i = 0; i < this.players; i++) if (this.playerTanks[i].age >= 0) this.playerTanks[i].age++
    for (const t of this.enemyTanks) if (t.age >= 0) t.age++
    this.marks.tickAge()
    this.shellPool.tickAge()
    this.minePool.tickAge()
    this.blocks.tickAge()
    this.syncView()
  }

  /** count + physics in one go (headless use) */
  step() {
    this.countPools()
    this.physics()
    this.drawTreadMarks()
  }

  /** RPTnkTankManager::DrawTrackMarks (runs in the draw pass every frame, frozen or not) */
  drawTreadMarks() {
    this.forTanks((t) => {
      const m = t.treadMark()
      if (m) this.emit({ t: 'tread', tank: t, pos: m.pos, dir: m.dir })
    })
  }

  /** refreshes the public arrays from the pools (pool order) */
  syncView() {
    this.bullets = this.shellPool.items.filter((s) => s.active)
    this.mines = this.minePool.items.filter((m) => m.active && m.state !== 2)
    this.explosions = this.minePool.items.filter((m) => m.active && m.state === 2)
    this.checkMarks = this.marks.items.filter((m) => m.active)
  }

  // ---- weapons (RPTnkWeaponManager) -----------------------------------------------------

  /** RPTnkWeaponManager::FireShell: no shell outside the field or inside a (non-hole) block */
  fireShell(speed: number, tank: Tank, pos: V3, dir: V3, slot: number, bounces: number, smoke: number, unk: number): Shell | null {
    if (!this.field.isInside(pos)) return null
    if (this.blocks.isPointInsideBlock(pos)) return null
    const param = slot | (bounces << 4) | (smoke << 8) | (unk << 12)
    const s = this.shellPool.spawn(pos, param)
    if (!s) return null
    const vel = v3(dir.x * speed, dir.y * speed, dir.z * speed)
    normalize(dir)
    s.rot.z = vcopy(dir)
    s.rot.y = v3(0, 1, 0)
    s.rot.x = v3(dir.z, 0, -dir.x) // Ey x z
    s.vel = vel
    s.owner = tank
    this.bullets.push(s)
    return s
  }

  /** RPTnkWeaponManager::LayMine (speed is always 0: the mine stays where it is laid) */
  layMine(speed: number, tank: Tank, pos: V3, target: V3, param: number): Mine | null {
    if (!this.field.isInside(pos)) return null
    const m = this.minePool.spawn(pos, param)
    if (!m) return null
    const d = v3(target.x - pos.x, 0, target.z - pos.z)
    const len = Math.hypot(d.x, d.z)
    if (len !== 0) {
      d.x *= speed / len
      d.z *= speed / len
    }
    m.targetPos = vcopy(target)
    m.vel = d
    m.owner = tank
    this.emit({ t: 'mineSet', mine: m })
    return m
  }

  // ---- callbacks from actors ---------------------------------------------------------------

  /** RPTnkTank::Explode bookkeeping */
  onTankExplode(t: Tank, hitId: number, cause: 'shell' | 'mine') {
    let killer: number | null = null
    if (t.isEnemy) {
      if (hitId >= 1 && hitId <= MAX_PLAYERS) killer = hitId - 1
      else if (hitId === HIT_ENEMY && !this.twoPlayerMode) killer = 0
      if (killer !== null) {
        this.hooks.addKill(killer, t.enemyType, vcopy(t.pos))
        if (!this.twoPlayerMode) {
          this.sound('RP_TNK_SE_GET_HIT')
          this.sound('RP_TNK_SE_GET_HIT_CSPK')
        } else if (killer % 2 === 0) {
          this.sound('RP_TNK_SE_GET_HIT_01')
          this.sound('RP_TNK_SE_GET_HIT_01_CSPK')
        } else {
          this.sound('RP_TNK_SE_GET_HIT_02')
          this.sound('RP_TNK_SE_GET_HIT_02_CSPK')
        }
      }
      this.marks.spawn(t.pos, TEAM_ENEMY)
      this.hooks.enemyDestroyed(t.spawnParam)
    } else {
      this.marks.spawn(t.pos, t.index)
      this.emit({ t: 'rumble', player: t.index, frames: 24 })
    }
    this.emit({ t: 'tankDie', tank: t, by: hitId, cause, killer })
  }

  onEnemySpawned(type: number, tank: Tank) {
    this.hooks.enemySpawned(type, tank)
  }

  onBlockBreak(b: { col: number; row: number; blockHeight: number }) {
    const g = this.grid[b.row]?.[b.col]
    if (g) {
      g.kind = Cell.Empty
      g.height = 0
    }
    this.emit({ t: 'blockBreak', cx: b.col, cz: b.row, height: b.blockHeight })
  }

  // ---- AI-style queries for tools ----------------------------------------------------------

  /** straight-line test for shells (blocks taller than holes stop it) */
  clearShot(a: Vec, b: Vec): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z)
    const n = Math.ceil(d / 5)
    for (let i = 1; i < n; i++) {
      const p = v3(a.x + ((b.x - a.x) * i) / n, 0, a.z + ((b.z - a.z) * i) / n)
      if (this.blocks.isPointInsideBlock(p)) return false
    }
    return true
  }

  newId() {
    return nextId()
  }
}

export function cellKind(code: number): Cell {
  if (code >= 100 && code <= 107) return Cell.Cork
  if (code === 200) return Cell.Hole
  if (code >= 201 && code <= 207) return Cell.Block
  return Cell.Empty
}

export function cellHeight(code: number): number {
  if (code >= 100 && code <= 107) return code - 100 + 1
  if (code >= 200 && code <= 207) return code - 200 + 1
  return 0
}

export function dist(a: Vec, b: Vec) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}
export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
export function wrap(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a < -Math.PI) a += 2 * Math.PI
  return a
}
export function angleDiff(from: number, to: number) {
  return wrap(to - from)
}

/** muzzle point of a tank (pivot height 17.6, 25.6 ahead along the turret) */
export function muzzleOf(t: Tank): V3 {
  return v3(t.pos.x + TANK.muzzle * t.turretRot.z.x, t.pos.y + TANK.bodyHeight, t.pos.z + TANK.muzzle * t.turretRot.z.z)
}
