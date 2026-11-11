// Arena: the massively-multiplayer mode (not in the original). Many players and bots share one
// big procedurally generated map; free-for-all or two teams; timed matches with respawns.
// Tank, shell and mine rules are the player tank's from the disc (TnkGameParam record 0).
//
// Rules
//   - one hit destroys a tank; respawn after RESPAWN_TICKS near the fighting (out of enemy
//     sight, not too close), protected for PROTECT_TICKS (ends early on firing)
//   - Free-for-all: a kill scores 1, destroying yourself costs 1; first to the size's limit wins
//   - Teams (Blue vs Red): no friendly fire (shells pass teammates, their mines ignore you);
//     every kill scores for the team; first team to its limit wins
//   - otherwise the match ends after MATCH_TICKS; the best score wins
//   - INTERMISSION_TICKS of results, then a new map
//   - pickups around the map turn you into one of the disc's special tanks for a while, or
//     give an item: a shield (takes one hit) or flares
//   - the arsenal: shells, mines, flares, and one nuke per player per match (a huge mine on
//     its own button; it isn't given back when you respawn)
//   - flares: the third weapon. Every tank carries one (it comes back after FLARE.recharge);
//     a flare launches a swarm of 10-15 tiny homing missiles that hunt down shells and rockets
//     in flight (never tanks)
//   - bots fill an arena up to its size's bot count and leave as players arrive
//
// Modes
//   - Free-for-all and Teams: the timed matches above, with respawns
//   - Battle royale: free-for-all with one life. A zone closes in on a random point; a tank
//     left outside it for ROYALE.outside ticks is destroyed. The last tank standing wins
//   - Elimination: Blue against Red with one life a round. A round ends when one team is
//     wiped out (or after ELIM.roundTicks: the team with more tanks left wins it); the first
//     team to ELIM.rounds rounds wins the match
//   - in the one-life modes, players who join mid-round watch until the next one starts

export const ARENA_TPS = 60
/** snapshots per second (every SNAPSHOT_EVERY ticks) */
export const SNAPSHOT_EVERY = 3

export type ArenaMode = 'ffa' | 'teams' | 'royale' | 'elim'
export const ARENA_MODES: ArenaMode[] = ['ffa', 'teams', 'royale', 'elim']
export const arenaModeOf = (v: unknown): ArenaMode => ((ARENA_MODES as unknown[]).includes(v) ? (v as ArenaMode) : 'ffa')
export const MODE_NAMES: Record<ArenaMode, string> = { ffa: 'Free-for-all', teams: 'Teams', royale: 'Battle royale', elim: 'Elimination' }
/** Blue against Red (no friendly-fire scoring, team bases, team colours) */
export const isTeamMode = (m: ArenaMode) => m === 'teams' || m === 'elim'
/** no respawns: out until the next round (Elimination) or the next match (Battle royale) */
export const isOneLife = (m: ArenaMode) => m === 'royale' || m === 'elim'

/**
 * Map sizes (each arena has one; players pick when they join). Bigger maps hold more players
 * and bots, more pickups, and a higher score to win.
 */
export type ArenaSize = 'small' | 'medium' | 'large'
export const ARENA_SIZES: ArenaSize[] = ['small', 'medium', 'large']
export const SIZES: Record<ArenaSize, { cols: number; rows: number; maxHumans: number; bots: number; pickups: number; ffaLimit: number; teamLimit: number; name: string }> = {
  small: { cols: 51, rows: 37, maxHumans: 10, bots: 6, pickups: 5, ffaLimit: 15, teamLimit: 30, name: 'Small' },
  medium: { cols: 84, rows: 56, maxHumans: 24, bots: 10, pickups: 10, ffaLimit: 25, teamLimit: 50, name: 'Medium' },
  large: { cols: 114, rows: 79, maxHumans: 40, bots: 16, pickups: 16, ffaLimit: 35, teamLimit: 75, name: 'Large' },
}
export const sizeOf = (v: unknown): ArenaSize => ((ARENA_SIZES as unknown[]).includes(v) ? (v as ArenaSize) : 'medium')

export const MATCH_TICKS = 6 * 60 * 60
export const INTERMISSION_TICKS = 12 * 60

export const RESPAWN_TICKS = 3 * 60

/**
 * Battle royale. The zone starts big enough to hold the whole map and closes in on its centre
 * in stages: [tick since the match started, radius as a fraction of the start]. After the last
 * stage it holds at `min` units. `late`: players who join within this many ticks of the start
 * still get a tank.
 */
export const ROYALE = {
  stages: [
    [0, 1],
    [20 * 60, 1],
    [50 * 60, 0.62],
    [70 * 60, 0.62],
    [95 * 60, 0.36],
    [110 * 60, 0.36],
    [135 * 60, 0.16],
    [150 * 60, 0.16],
    [175 * 60, 0],
  ] as [number, number][],
  min: 110,
  outside: 3 * 60,
  late: 10 * 60,
}

/** the zone's radius `t` ticks into a match that started at `r0` */
export function zoneRadius(t: number, r0: number) {
  const S = ROYALE.stages
  let f = S[S.length - 1][1]
  for (let i = 1; i < S.length; i++)
    if (t < S[i][0]) {
      const [t0, f0] = S[i - 1]
      const [t1, f1] = S[i]
      f = f0 + ((f1 - f0) * (t - t0)) / (t1 - t0)
      break
    }
  return Math.max(ROYALE.min, r0 * f)
}

/** where the zone is headed: the radius it shrinks to next (its own radius once it's done) */
export function zoneNext(t: number, r0: number) {
  const now = zoneRadius(t, r0)
  for (const [at, f] of ROYALE.stages) if (at > t && Math.max(ROYALE.min, r0 * f) < now - 0.5) return Math.max(ROYALE.min, r0 * f)
  return now
}

/** Elimination: rounds to win the match, a round's length, the pause between rounds, late joins */
export const ELIM = { rounds: 4, roundTicks: 2 * 60 * 60, between: 4 * 60, late: 5 * 60 }
export const PROTECT_TICKS = Math.round(2.5 * 60)
/** respawns: the best distance to the nearest enemy (about a screen away), the least, and how
 * far an enemy's line of sight counts against a spawn cell */
export const SPAWN_IDEAL = 480
export const SPAWN_SAFE = 260
export const SPAWN_SIGHT = 620

/**
 * Pickups are the disc's special tanks: drive over one and your tank becomes that type for a
 * while (its model, and its trick on top of the player tank's rules):
 *   Teal    rockets (shell speed 6, no ricochet)        Green  rockets with 2 ricochets
 *   Black   very fast, rockets                          Pink   fires in bursts of three
 *   Yellow  mine layer: 10 mines                        Violet aggressive: 8 shells, 3 mines
 *   White   invisible to enemies, firing included (only its tracks and shells show)
 */
//   and two Tanks+ types (src/sim/types):
//   Hornet  homing rockets (no ricochet)               Sniper very fast shells along a laser
//                                                      sight everyone can see
/** Yellow, the mine layer: mines out at once (a kill streak adds its usual +1 / +2) */
export const YELLOW_MINES = 10

export type PickupKind = 'teal' | 'green' | 'black' | 'pink' | 'yellow' | 'violet' | 'white' | 'hornet' | 'sniper'
export const PICKUP_KINDS: PickupKind[] = ['teal', 'green', 'black', 'pink', 'yellow', 'violet', 'white', 'hornet', 'sniper']
/** the enemy type (1-9, Tanks+ 10+) each pickup turns you into */
export const PICKUP_TYPE: Record<PickupKind, number> = { teal: 3, pink: 4, yellow: 5, violet: 6, green: 7, white: 8, black: 9, hornet: 13, sniper: 16 }
export const PICKUP_TICKS: Record<PickupKind, number> = { teal: 20 * 60, green: 20 * 60, black: 15 * 60, pink: 20 * 60, yellow: 20 * 60, violet: 20 * 60, white: 15 * 60, hornet: 18 * 60, sniper: 18 * 60 }
export const PICKUP_INFO: Record<PickupKind, { name: string; color: string; dark: string; trick: string }> = {
  teal: { name: 'Teal', color: '#2fa5a0', dark: '#196560', trick: 'Rockets' },
  green: { name: 'Green', color: '#5bb046', dark: '#2f6b22', trick: 'Ricochet rockets' },
  black: { name: 'Black', color: '#3a3a3e', dark: '#141416', trick: 'Speed + rockets' },
  pink: { name: 'Pink', color: '#e2676f', dark: '#932a31', trick: 'Triple shot' },
  yellow: { name: 'Yellow', color: '#e8c33a', dark: '#9b7d14', trick: `Mine layer (${YELLOW_MINES} mines)` },
  violet: { name: 'Violet', color: '#9a5ac9', dark: '#5c2f82', trick: '8 shells, 3 mines' },
  white: { name: 'White', color: '#f3f1ea', dark: '#9d9a90', trick: 'Invisible' },
  hornet: { name: 'Hornet', color: '#e0482a', dark: '#7d2212', trick: 'Homing rockets' },
  sniper: { name: 'Sniper', color: '#3f5a2e', dark: '#1f2d16', trick: 'Laser sight, fast shells' },
}
/** items: pickups that give a weapon or a shield instead of a special tank */
export type ItemKind = 'shield' | 'flares'
export const ITEM_KINDS: ItemKind[] = ['shield', 'flares']
export type AnyPickup = PickupKind | ItemKind
export const isItem = (k: string): k is ItemKind => (ITEM_KINDS as string[]).includes(k)
export const ITEM_INFO: Record<ItemKind, { name: string; color: string; dark: string; trick: string }> = {
  shield: { name: 'Shield', color: '#7fe0c2', dark: '#2a8a6e', trick: 'Takes one hit for you' },
  flares: { name: 'Flares', color: '#ff7a2a', dark: '#9b3a0a', trick: '+2 flares: missiles that shoot down shells' },
}
/** name / colours / what it does, for any pickup */
export const pickupInfo = (k: AnyPickup) => (isItem(k) ? ITEM_INFO[k] : PICKUP_INFO[k])
/** how often each pickup appears, against 1 for each special tank */
export const PICKUP_WEIGHT: Partial<Record<AnyPickup, number>> = { shield: 1.6, flares: 0.9 }

/** Nuke: a mine with a long fuse that no tank sets off (a shell or a blast can), and a blast
 * almost four times a mine's that breaks every block in reach (wood too) and scorches the
 * floor. Every player gets `perMatch` a match, kept through respawns. The fuse (7 s) gives a
 * tank time to drive clear of even a streak-boosted blast through a maze. */
export const NUKE = { fuse: 420, blast: 290, growFrames: 14, killFrames: 34, frames: 70, bodyRadius: 20, perMatch: 1 }
/** Shield: lasts this long or until it takes a hit (then a moment of protection) */
export const SHIELD = { ticks: 25 * 60, afterHit: 40 }
/**
 * Flares: one launches `swarm` (10-15) tiny missiles fanned out around the tank. Each locks
 * on to the nearest shell in flight within `range` that isn't its tank's own (one not yet
 * locked on to first), turns up to `turn` degrees a frame at up to `speed`, and destroys it
 * on contact (`hit`); it burns out after `life` frames. Every tank has `base` flares
 * (recharged one at a time every `recharge` ticks); a pickup adds `pickup`, up to `max`.
 */
export const FLARE = { swarm: [10, 15], speed: 6.5, launch: 2.5, turn: 16, range: 320, hit: 10, life: 90, cooldown: 40, recharge: 22 * 60, base: 1, pickup: 2, max: 3 }

/**
 * Kill streaks: level 1 (x2) at 3 kills in a row, level 2 (x3) at 6; lost when destroyed.
 * Each level: +2 shells, +1 mine, +1 ricochet (shells that already ricochet), shells 10% faster,
 * mine blasts 20% wider (STREAK_MINE: the mine is drawn bigger too), and the special tank's
 * trick grows (see powerStats); a nuke's blast and a flare's swarm grow too.
 */
export const STREAK_LEVELS = [3, 6]
export const streakLevel = (streak: number) => STREAK_LEVELS.filter((n) => streak >= n).length

/** Hornet: shells turn toward the nearest enemy by up to `turn` degrees a frame after `delay`
 * frames, if it is within `range` and `cone` degrees of the flight direction (Tanks+ Hornet) */
export const HOMING = { turn: 1.5, delay: 14, range: 520, cone: 75 }
/** Sniper: the Tanks+ Sniper's shell speed */
export const SNIPER_SHELL_SPEED = 7.5
export const PICKUP_RESPAWN = 6 * 60
export const PICKUP_RADIUS = 22
/** Teal / Green / Black shell speed (their records: 6, the player's 3) */
export const ROCKET_SHELL_SPEED = 6
/** Black: speed 2.4 against the player's 1.8 */
export const BLACK_SPEED = 2.4 / 1.8

/** what a power (and the streak level) does to the tank's numbers; the speed never depends
 * on the level (the client predicts it from the power alone) */
export function powerStats(p: PickupKind | null, base: { speed: number; shellSpeed: number; ricochets: number; maxShells: number; maxMines: number; mineCooldown: number }, level = 0) {
  const s = { speedMul: 1, shellSpeed: base.shellSpeed, ricochets: base.ricochets, maxShells: base.maxShells, maxMines: base.maxMines, mineCooldown: base.mineCooldown, smoke: 0, burst: 1, homing: false, homingTurn: HOMING.turn }
  if (p === 'teal') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1 })
  if (p === 'green') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 2, smoke: 2 })
  if (p === 'black') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1, speedMul: BLACK_SPEED })
  if (p === 'pink') Object.assign(s, { burst: 3, maxShells: 7 })
  if (p === 'yellow') Object.assign(s, { maxMines: YELLOW_MINES })
  if (p === 'violet') Object.assign(s, { maxShells: 8, maxMines: 3 })
  if (p === 'hornet') Object.assign(s, { ricochets: 0, smoke: 1, homing: true, maxShells: 3 })
  if (p === 'sniper') Object.assign(s, { shellSpeed: SNIPER_SHELL_SPEED, ricochets: 1, smoke: 1, maxShells: 3 })
  if (level) {
    const L = level
    s.maxShells += 2 * L
    s.maxMines += L
    if (s.ricochets > 0) s.ricochets += L
    // the trick itself grows
    if (p === 'green') s.ricochets += L
    if (p === 'pink') s.burst += L
    if (p === 'violet') s.maxShells += L
    if (p === 'teal' || p === 'black') s.shellSpeed += 0.7 * L
    if (p === 'hornet') s.homingTurn *= 1 + 0.5 * L
    if (p === 'sniper') s.shellSpeed += 1.2 * L
  }
  // faster shells (on top of the special tank's own speed)
  if (level) s.shellSpeed *= 1 + 0.1 * level
  return s
}

/** a nuke's blast, a flare's swarm size and missile range at a streak level */
export const nukeBlast = (level: number) => NUKE.blast * (1 + 0.2 * level)
/** a mine's blast grows with the streak level (×1.2, ×1.4 of the disc's 80 units) */
export const STREAK_MINE = 0.2
export const mineScale = (level: number) => 1 + STREAK_MINE * level
export const flareSwarm = (level: number, rnd: number) => FLARE.swarm[0] + Math.floor(rnd * (FLARE.swarm[1] - FLARE.swarm[0] + 1)) + 3 * level
export const flareRange = (level: number) => FLARE.range * (1 + 0.25 * level)

/** map themes (src/arena/map.ts); between matches everyone votes for the next one */
export type MapTheme = 'mixed' | 'cork' | 'pits' | 'maze' | 'spiral' | 'rings' | 'labyrinth' | 'zigzag'
export const MAP_THEMES: MapTheme[] = ['mixed', 'cork', 'pits', 'maze', 'spiral', 'rings', 'labyrinth', 'zigzag']
export const THEME_INFO: Record<MapTheme, { name: string; text: string }> = {
  mixed: { name: 'Toy box', text: 'A bit of everything' },
  cork: { name: 'Cork forest', text: 'Cork everywhere: mine your way through' },
  pits: { name: 'Sinkholes', text: 'Holes stop tanks, shells fly over' },
  maze: { name: 'Maze', text: 'Long walls and tight corridors' },
  spiral: { name: 'Spiral', text: 'Two arms winding out from the middle' },
  rings: { name: 'Bullseye', text: 'Rings within rings, a gap here and there' },
  labyrinth: { name: 'Labyrinth', text: 'A real maze: find your way' },
  zigzag: { name: 'Zigzag', text: 'Rows of chevrons and diamond rooms' },
}

/** quick chat (keys 1-6) */
export const EMOTES = ['Nice shot!', 'Behind you!', 'Help!', 'Follow me!', 'Oops!', 'GG!']
export const EMOTE_TICKS = 150

/** team colours: Blue / Red are the 1P / 2P tanks */
export const TEAM_NAMES = ['Blue', 'Red']
export const TEAM_COLORS = ['#2f6fdf', '#d8383a']
/** free-for-all liveries (the 1p model recoloured) */
export const FFA_COLORS = [
  '#2f6fdf', '#d8383a', '#34a34a', '#e8901c', '#8d4fd0', '#1fb5b0', '#d64fa0', '#c9b21c',
  '#5f6a78', '#7a4a2a', '#9ad13a', '#e0e0e0', '#33405a', '#ff7a59', '#4f7d2f', '#b03a5b',
]

export const BOT_NAMES = ['Brown', 'Grey', 'Teal', 'Yellow', 'Pink', 'Green', 'Violet', 'White', 'Black', 'Ash', 'Cork', 'Felt', 'Moss', 'Rust', 'Slate', 'Plum']
