// Tanks+ power-ups: temporary player upgrades picked up from pads (tiles 580-585) and crates
// (tile 532). They edit the player controller's copy of the player record (TnkGameParam
// record 0) while they last; PlayerController.reset() restores it on every spawn anyway.

import type { Plus } from './plus'
import { paramsFor } from './stats'
import type { Tank } from './tank'
import type { Tile } from './tiles'
import { type V3, v3 } from './vec'
import type { World } from './world'

export type PowerUpId = 'rapid' | 'bounce' | 'shield' | 'speed' | 'mine' | 'rocket'

export type PowerUpType = {
  /** index = kind number (pads: tile 580 + index) */
  index: number
  id: PowerUpId
  name: string
  colour: string
  description: string
  /** frames the effect lasts (shield: until it absorbs a hit) */
  frames: number
}

const POWERUPS: PowerUpType[] = [
  { index: 0, id: 'rapid', name: 'Rapid fire', colour: '#ff5040', description: '8 shells on the field and no pause after firing.', frames: 720 },
  { index: 1, id: 'bounce', name: 'Ricochet+', colour: '#40c0ff', description: 'Shells ricochet one extra time.', frames: 900 },
  { index: 2, id: 'shield', name: 'Shield', colour: '#80ffd0', description: 'A bubble that absorbs one hit.', frames: 0 },
  { index: 3, id: 'speed', name: 'Speed', colour: '#ffe040', description: 'Drive 40% faster.', frames: 720 },
  { index: 4, id: 'mine', name: 'Mines+', colour: '#ff9020', description: 'Four mines on the field instead of two.', frames: 900 },
  { index: 5, id: 'rocket', name: 'Rockets', colour: '#c070ff', description: 'Fast rocket shells (no extra ricochet).', frames: 720 },
]

export function powerUpTypes(): PowerUpType[] {
  return POWERUPS.map((p) => ({ ...p }))
}

export type Pickup = {
  id: number
  kind: number
  pos: V3
  age: number
  /** frames left before a dropped pickup vanishes (-1 = stays) */
  life: number
  pad: Tile | null
}

/** pads refill this long after their pickup is taken */
const PAD_RESPAWN = 900
/** crate drops vanish after this long */
const DROP_LIFE = 900
const PICK_RADIUS = 22

let serial = 1

export class PowerUps {
  items: Pickup[] = []
  private padTimers = new Map<Tile, number>()
  /** chance that a crate holds a power-up (rule `crateDrop`, default 0.7) */
  crateDrop = 0.7

  constructor(
    private w: World,
    private plus: Plus,
  ) {
    const r = w.rules.crateDrop
    if (typeof r === 'number') this.crateDrop = r
  }

  init() {
    for (const t of this.plus.tiles.pads('powerup')) this.spawn(t.code - 580, v3(t.x, 0, t.z), -1, t)
  }

  private spawn(kind: number, pos: V3, life: number, pad: Tile | null) {
    const p: Pickup = { id: serial++, kind, pos, age: 0, life, pad }
    this.items.push(p)
    return p
  }

  crateBroken(t: Tile) {
    if (this.plus.rng.float01() >= this.crateDrop) return
    const kind = this.plus.rng.next() % POWERUPS.length
    this.spawn(kind, v3(t.x, 0, t.z), DROP_LIFE, null)
    this.plus.event('drop', v3(t.x, 0, t.z), undefined, kind)
  }

  afterCalc() {
    const w = this.w
    // pickups
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i]
      p.age++
      let taken: Tank | null = null
      for (let k = 0; k < w.players; k++) {
        const t = w.playerTanks[k]
        if (!t.active || t.lives <= 0 || t.state !== 1 || !t.ext) continue
        if (Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z) < PICK_RADIUS) {
          taken = t
          break
        }
      }
      if (taken) {
        this.give(taken, p.kind)
        this.items.splice(i, 1)
        if (p.pad) this.padTimers.set(p.pad, PAD_RESPAWN)
        this.plus.event('pickup', p.pos, taken, p.kind)
        w.sound('RP_TNK_SE_GET_TNKNUM', p.pos)
      } else if (p.life > 0 && --p.life === 0) this.items.splice(i, 1)
    }
    for (const [pad, n] of this.padTimers) {
      if (n > 1) this.padTimers.set(pad, n - 1)
      else {
        this.padTimers.delete(pad)
        this.spawn(pad.code - 580, v3(pad.x, 0, pad.z), -1, pad)
      }
    }
    // buffs
    for (let k = 0; k < w.players; k++) {
      const t = w.playerTanks[k]
      if (!t.active || !t.ext) continue
      const b = t.ext.buffs
      for (let i = 0; i < b.length; i++) if (b[i] > 0) b[i]--
      applyBuffs(t)
    }
  }

  give(t: Tank, kind: number) {
    const x = t.ext!
    if (POWERUPS[kind].id === 'shield') x.shield = 1
    else x.buffs[kind] = POWERUPS[kind].frames
    applyBuffs(t)
  }
}

/** the player controller's parameters with the active buffs applied (record 0 otherwise) */
export function applyBuffs(t: Tank) {
  const b = t.ext!.buffs
  const base = paramsFor(0)
  const pc = t.player
  pc.maxShells = base.maxShells + (b[0] > 0 ? 3 : 0)
  pc.fireFreeze = b[0] > 0 ? 0 : base.fireFreeze
  pc.shellBounces = base.ricochets + (b[1] > 0 ? 1 : 0)
  pc.maxSpeed = b[3] > 0 ? base.speed * 1.4 : base.speed
  pc.accel = b[3] > 0 ? base.accel * 1.4 : base.accel
  pc.maxMines = base.maxMines + (b[4] > 0 ? 2 : 0)
  pc.shellSpeed = b[5] > 0 ? 5.5 : base.shellSpeed
}

/** frames left of each buff, for HUDs */
export function buffsOf(t: Tank): { type: PowerUpType; frames: number }[] {
  if (!t.ext) return []
  const out = t.ext.buffs.map((f, i) => ({ type: POWERUPS[i], frames: f })).filter((b) => b.frames > 0)
  if (t.ext.shield > 0) out.push({ type: POWERUPS[2], frames: -1 })
  return out
}
