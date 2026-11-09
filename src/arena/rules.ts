// Arena: the massively-multiplayer mode (not in the original). Many players and bots share one
// big procedurally generated map; free-for-all or two teams; timed matches with respawns.
// Tank, shell and mine rules are the player tank's from the disc (TnkGameParam record 0).
//
// Rules
//   - one hit destroys a tank; respawn after RESPAWN_TICKS at a
//     spawn point away from enemies, protected for PROTECT_TICKS (ends early on firing)
//   - Free-for-all: a kill scores 1, destroying yourself costs 1; first to FFA_LIMIT wins
//   - Teams (Blue vs Red): no friendly fire (shells pass teammates, their mines ignore you);
//     every kill scores for the team; first team to TEAM_LIMIT wins
//   - otherwise the match ends after MATCH_TICKS; the best score wins
//   - INTERMISSION_TICKS of results, then a new map
//   - pickups around the map turn you into one of the disc's special tanks for a while
//   - bots fill an arena up to BOT_FILL tanks and leave as players arrive

export const ARENA_TPS = 60
/** snapshots per second (every SNAPSHOT_EVERY ticks) */
export const SNAPSHOT_EVERY = 3

export type ArenaMode = 'ffa' | 'teams'

export const MAP = { cols: 84, rows: 56 } as const
export const MAX_HUMANS = 24
export const BOT_FILL = 10

export const MATCH_TICKS = 6 * 60 * 60
export const INTERMISSION_TICKS = 12 * 60
export const FFA_LIMIT = 25
export const TEAM_LIMIT = 50

export const RESPAWN_TICKS = 3 * 60
export const PROTECT_TICKS = Math.round(2.5 * 60)

/**
 * Pickups are the disc's special tanks: drive over one and your tank becomes that type for a
 * while (its model, and its trick on top of the player tank's rules):
 *   Teal    rockets (shell speed 6, no ricochet)        Green  rockets with 2 ricochets
 *   Black   very fast, rockets                          Pink   fires in bursts of three
 *   Yellow  fast mine layer: 4 mines, short cooldown    Violet aggressive: 8 shells, 3 mines
 *   White   invisible to enemies (only its tracks show; firing gives it away for a moment)
 */
export type PickupKind = 'teal' | 'green' | 'black' | 'pink' | 'yellow' | 'violet' | 'white'
export const PICKUP_KINDS: PickupKind[] = ['teal', 'green', 'black', 'pink', 'yellow', 'violet', 'white']
/** the enemy type (1-9) each pickup turns you into */
export const PICKUP_TYPE: Record<PickupKind, number> = { teal: 3, pink: 4, yellow: 5, violet: 6, green: 7, white: 8, black: 9 }
export const PICKUP_TICKS: Record<PickupKind, number> = { teal: 20 * 60, green: 20 * 60, black: 15 * 60, pink: 20 * 60, yellow: 20 * 60, violet: 20 * 60, white: 15 * 60 }
export const PICKUP_INFO: Record<PickupKind, { name: string; color: string; dark: string; trick: string }> = {
  teal: { name: 'Teal', color: '#2fa5a0', dark: '#196560', trick: 'Rockets' },
  green: { name: 'Green', color: '#5bb046', dark: '#2f6b22', trick: 'Ricochet rockets' },
  black: { name: 'Black', color: '#3a3a3e', dark: '#141416', trick: 'Speed + rockets' },
  pink: { name: 'Pink', color: '#e2676f', dark: '#932a31', trick: 'Triple shot' },
  yellow: { name: 'Yellow', color: '#e8c33a', dark: '#9b7d14', trick: 'Mine layer' },
  violet: { name: 'Violet', color: '#9a5ac9', dark: '#5c2f82', trick: '8 shells, 3 mines' },
  white: { name: 'White', color: '#f3f1ea', dark: '#9d9a90', trick: 'Invisible' },
}
export const PICKUPS_MAX = 10
export const PICKUP_RESPAWN = 6 * 60
export const PICKUP_RADIUS = 22
/** Teal / Green / Black shell speed (their records: 6, the player's 3) */
export const ROCKET_SHELL_SPEED = 6
/** Black: speed 2.4 against the player's 1.8 */
export const BLACK_SPEED = 2.4 / 1.8
/** White is seen by enemies for this long after firing */
export const WHITE_REVEAL = 40

/** what a power does to the tank's numbers */
export function powerStats(p: PickupKind | null, base: { speed: number; shellSpeed: number; ricochets: number; maxShells: number; maxMines: number; mineCooldown: number }) {
  const s = { speedMul: 1, shellSpeed: base.shellSpeed, ricochets: base.ricochets, maxShells: base.maxShells, maxMines: base.maxMines, mineCooldown: base.mineCooldown, smoke: 0, burst: 1 }
  if (p === 'teal') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1 })
  if (p === 'green') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 2, smoke: 2 })
  if (p === 'black') Object.assign(s, { shellSpeed: ROCKET_SHELL_SPEED, ricochets: 0, smoke: 1, speedMul: BLACK_SPEED })
  if (p === 'pink') Object.assign(s, { burst: 3, maxShells: 7 })
  if (p === 'yellow') Object.assign(s, { maxMines: 4 })
  if (p === 'violet') Object.assign(s, { maxShells: 8, maxMines: 3 })
  return s
}

/** team colours: Blue / Red are the 1P / 2P tanks */
export const TEAM_NAMES = ['Blue', 'Red']
export const TEAM_COLORS = ['#2f6fdf', '#d8383a']
/** free-for-all liveries (the 1p model recoloured) */
export const FFA_COLORS = [
  '#2f6fdf', '#d8383a', '#34a34a', '#e8901c', '#8d4fd0', '#1fb5b0', '#d64fa0', '#c9b21c',
  '#5f6a78', '#7a4a2a', '#9ad13a', '#e0e0e0', '#33405a', '#ff7a59', '#4f7d2f', '#b03a5b',
]

export const BOT_NAMES = ['Brown', 'Grey', 'Teal', 'Yellow', 'Pink', 'Green', 'Violet', 'White', 'Black', 'Ash', 'Cork', 'Felt', 'Moss', 'Rust', 'Slate', 'Plum']
