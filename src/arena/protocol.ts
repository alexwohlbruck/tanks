// Arena wire protocol (WebSocket /ws/arena, JSON text frames). The server simulates at 60 Hz
// and sends every client a snapshot of what is near its tank 20 times a second, a scoreboard +
// minimap every half second, and global events (kills, broken blocks, match state) to all.

import type { AnyPickup, ArenaMode, ArenaSize, MapTheme, PickupKind } from './rules'

export const ARENA_PROTO = 10

export type C2S =
  /** `id`: the browser's stats id; `arena` / `with`: an invite link (that arena, that player's team);
   * `not`: a new game, anywhere but this arena (one where you get a tank right away) */
  | { t: 'join'; v: number; name: string; mode: ArenaMode; size?: ArenaSize; id?: string; arena?: string; with?: number; not?: string }
  /** quick chat (rules EMOTES index) */
  | { t: 'emote'; i: number }
  /** the next map's theme, during the intermission */
  | { t: 'vote'; theme: string }
  /** input for one tick: seq, move x/z, analog, aim x/z, fire / mine / flare / nuke pressed this tick (0/1) */
  | { t: 'i'; s: number; mx: number; mz: number; an: number; ax: number; az: number; f: number; m: number; fl?: number; nk?: number }
  | { t: 'ping'; c: number }
  | { t: 'leave' }
  /** development servers only (ARENA_DEV=1): become a special tank */
  | { t: 'dev'; power: string }

/** [id, x, z, body, turret, flags, pid] */
export type TankRec = [number, number, number, number, number, number, number]
/** [id, x, z, vx, vz, smoke] */
export type ShellRec = [number, number, number, number, number, number]
/** [id, x, z, fuseLit 0/1, nuke blast radius (0: a mine), nuke fuse ticks left] */
export type MineRec = [number, number, number, number, number, number]
/** a flare missile: [id, x, z, vx, vz] */
export type FlareRec = [number, number, number, number, number]
/** [id, x, z, kind] */
export type PickupRec = [number, number, number, AnyPickup]

export const TF_ALIVE = 1
export const TF_PROTECT = 2
/** a White tank this client cannot see (only its tracks show) */
export const TF_STEALTH = 4
/** power index + 1 in bits 3-6 (rules PICKUP_KINDS order) */
export const TF_POWER_SHIFT = 3
/** a shield is up */
export const TF_SHIELD = 128
/** streak level (0-2) in bits 8-9 */
export const TF_LEVEL_SHIFT = 8

/** the receiving client's own tank, full precision for prediction */
export type YouRec = {
  /** input seq applied last */
  a: number
  x: number
  z: number
  vx: number
  vz: number
  /** body forward x / z */
  fx: number
  fz: number
  /** controller: speed, sign, freeze, shell / mine timers */
  sp: number
  sg: number
  fr: number
  st: number
  mt: number
  alive: number
  /** ticks until respawn / protection / power end */
  respawn: number
  protect: number
  power: PickupKind | null
  powerLeft: number
  /** nukes left this match, flares (and the most you can carry), ticks until a flare comes back (0:
   * none coming), shield ticks left; the kill-streak level and streak */
  nukes: number
  flares: number
  flareMax: number
  flareBack: number
  shield: number
  level: number
  streak: number
  /** shells / mines ready, and the most the tank may have out */
  shells: number
  mines: number
  maxShells: number
  maxMines: number
  /** while waiting to respawn: the tank of whoever destroyed you (0: none in sight) */
  spec: number
  /** one-life modes: out until the next round (Elimination) or match (Battle royale) */
  out: number
  /** Battle royale: ticks spent outside the zone (0: inside) */
  zo: number
}

/** compact events: kind first (see sim ArenaEvent) */
export type NetEv =
  | ['shot', number, number, number, number, number] // tank, x, z, smoke, type
  | ['ric', number, number]
  | ['die', number, number, number] // x, z, wall
  | ['clash', number, number]
  | ['kill', number, number, number, number, number, string, number, number, number] // tank, x, z, victim, killer, cause, streak, mine layer, teamkill
  | ['shpop', number, number, number] // tank, x, z
  | ['flare', number, number, number, number] // tank, x, z, missiles
  | ['fhit', number, number]
  | ['mset', number, number]
  | ['fuse', number, number, number]
  | ['boom', number, number, number] // x, z, nuke blast radius (0: a mine)
  | ['brk', number, number, number]
  | ['pick', number, string, number, number]
  | ['spawn', number, number, number]
  | ['emo', number, number] // pid, emote
  | ['match', string]
  | ['round', number, number, number] // round, winning team (-1: none), started (1) or decided (0)

export type BoardPlayer = [number, string, number, string, number, number, number, number] // pid, name, team, color, kills, deaths, score, bot
export type Board = {
  t: 'board'
  players: BoardPlayer[]
  teams: number[]
  state: 'play' | 'over'
  secs: number
  winner: { name: string; color: string } | null
  /** minimap dots: [pid, x, z] (teammates always, enemies while they are firing) */
  mm: [number, number, number][]
  /** the current map's theme, and the ballot for the next one (intermission) */
  theme: MapTheme
  vote: { options: MapTheme[]; counts: number[]; mine: MapTheme | null } | null
  /** this arena's id (invite links) */
  arena: string
  /** one-life modes: tanks left (Battle royale: [all]; Elimination: [Blue, Red]) */
  alive?: number[]
  /** Elimination: the round, and whether it's decided (the pause before the next one) */
  round?: number
  roundOver?: boolean
  /** Battle royale: the zone [x, z, radius, the radius it's closing to, units per second] */
  zone?: [number, number, number, number, number]
}

export type S2C =
  | { t: 'welcome'; v: number; arena: string; pid: number; tank: number; mode: ArenaMode; size: ArenaSize; seed: number; theme: MapTheme; broken: [number, number][]; tick: number; online: number }
  | { t: 'map'; seed: number; theme: MapTheme; tick: number }
  | { t: 's'; k: number; T: TankRec[]; S: ShellRec[]; F: FlareRec[]; M: MineRec[]; K: PickupRec[]; E: NetEv[]; you: YouRec }
  | Board
  | { t: 'pong'; c: number }
  | { t: 'error'; message: string }

export const r1 = (v: number) => Math.round(v * 10) / 10
