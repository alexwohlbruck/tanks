// Achievements: the list, their saved state (localStorage, like save.ts) and the calls that
// unlock them. The web UI shows a toast when one unlocks (src/ui/web/achievementToast.ts,
// listening through onAchievement) and lists them on the 'achievements' screen.
//
// ===== API ==================================================================================
//   unlock(id)            unlocks a one-off achievement; true when it was newly unlocked
//   progress(id, n = 1)   adds n to a counter achievement (unlocks when it reaches `goal`)
//   reach(id, value)      raises a counter to `value` (never lowers it), e.g. a best streak
//   collect(id, key)      marks `key` of a set achievement (unlocks once every `keys` is in)
//   isUnlocked(id), progressOf(id), onAchievement(fn)
// Unknown ids are ignored (with a console warning), so callers never need to guard.
//
// ===== Arena hooks (to be called from src/arena; nothing in this module triggers them) =========
// Call these on the client for the local player only (not for other players' events):
//   'arena-first-kill'    unlock('arena-first-kill')                 the local player destroys a tank
//   'arena-kills-100'     progress('arena-kills-100')                 on every kill by the local player
//   'arena-streak-5'      reach('arena-streak-5', streak)             current kill streak (kills since
//                                                                     the last death) after each kill
//   'arena-win'           unlock('arena-win')                         the local player (or their team)
//                                                                     wins an arena match
//   'arena-all-specials'  collect('arena-all-specials', name)         when the local player becomes a
//                                                                     special tank; name is one of
//                                                                     ARENA_SPECIALS ('Teal', 'Green', ...)
//   'arena-mine-steal'    unlock('arena-mine-steal')                  a kill credited to the local
//                                                                     player by a mine another player laid
// e.g.  import { unlock, progress, reach, collect } from '../ui/shared/achievements'
//       if (e.t === 'kill' && e.killer === me.pid) { unlock('arena-first-kill'); progress('arena-kills-100'); reach('arena-streak-5', me.streak) }
// =========================================================================================

export type AchievementGroup = 'classic' | 'tanksplus' | 'community' | 'online' | 'arena'

export type Achievement = {
  id: string
  name: string
  desc: string
  group: AchievementGroup
  /** counter achievements: unlocked at this count */
  goal?: number
  /** set achievements: unlocked when every key has been collected */
  keys?: string[]
  /** a tank colour (art.ts TANK_TYPES index) for the list's badge */
  tank?: number
}

/** the special tanks of the arena (src/arena pickups) */
export const ARENA_SPECIALS = ['Teal', 'Green', 'Black', 'Pink', 'Yellow', 'Violet', 'White', 'Hornet', 'Sniper']

export const GROUPS: { id: AchievementGroup; name: string }[] = [
  { id: 'classic', name: 'Classic' },
  { id: 'tanksplus', name: 'Tanks+' },
  { id: 'community', name: 'Editor & community' },
  { id: 'online', name: 'Online' },
  { id: 'arena', name: 'Arena' },
]

export const ACHIEVEMENTS: Achievement[] = [
  // classic campaign (local play)
  { id: 'classic-first', group: 'classic', name: 'Rolling out', desc: 'Clear mission 1.', tank: 1 },
  { id: 'classic-20', group: 'classic', name: 'Wii Play champion', desc: 'Clear mission 20.', tank: 6 },
  { id: 'classic-100', group: 'classic', name: 'Centurion', desc: 'Clear mission 100.', tank: 9 },
  { id: 'classic-flawless', group: 'classic', name: 'Not a scratch', desc: 'Clear the 20 missions in one run without losing a life.', tank: 8 },
  { id: 'classic-gold', group: 'classic', name: 'Gold standard', desc: 'Win the gold medal (missions 21-100 open up).', tank: 5 },
  { id: 'classic-platinum', group: 'classic', name: 'Platinum treads', desc: 'Win the platinum medal.', tank: 8 },
  { id: 'classic-duo', group: 'classic', name: 'Brothers in arms', desc: 'Clear mission 10 in a 2-player game.', tank: 0 },
  { id: 'ricochet', group: 'classic', name: 'Bank shot', desc: 'Destroy a tank with a shell that bounced off a wall.', tank: 3 },
  { id: 'mine-kill', group: 'classic', name: 'Sapper', desc: 'Destroy a tank with one of your mines.', tank: 5 },
  { id: 'mine-double', group: 'classic', name: 'Two birds', desc: 'Destroy two tanks with a single mine.', tank: 5 },
  { id: 'black-100', group: 'classic', name: 'Lights out', desc: 'Destroy 100 Black tanks.', goal: 100, tank: 9 },
  { id: 'tanks-1000', group: 'classic', name: 'Tank buster', desc: 'Destroy 1,000 tanks.', goal: 1000, tank: 2 },
  // Tanks+ campaign
  { id: 'tp-boss-1', group: 'tanksplus', name: 'Shop closed', desc: 'Beat the Workshop boss (Tanks+ level 10).', tank: 1 },
  { id: 'tp-boss-2', group: 'tanksplus', name: 'Thaw', desc: 'Beat the Frozen Works boss (level 20).', tank: 8 },
  { id: 'tp-boss-3', group: 'tanksplus', name: 'Lights on', desc: 'Beat the Night Ops boss (level 30).', tank: 9 },
  { id: 'tp-boss-4', group: 'tanksplus', name: 'Overdriven', desc: 'Beat the Overdrive boss (level 40).', tank: 4 },
  { id: 'tp-complete', group: 'tanksplus', name: 'Tanks++', desc: 'Clear every Tanks+ level.', tank: 6 },
  { id: 'tp-platinum', group: 'tanksplus', name: 'Plus platinum', desc: 'Win the Tanks+ platinum medal: every level in one run without losing a life.', tank: 8 },
  // level editor and community levels
  { id: 'editor-publish', group: 'community', name: 'Architect', desc: 'Publish a level pack to Community Levels.', tank: 7 },
  { id: 'store-play', group: 'community', name: 'Tourist', desc: 'Play a community level.', tank: 3 },
  // online rooms
  { id: 'online-coop', group: 'online', name: 'Better together', desc: 'Play a campaign online with a friend.', tank: 0 },
  { id: 'vs-win', group: 'online', name: 'Top tank', desc: 'Win an online versus match.', tank: 4 },
  // arena (triggered from src/arena, see the header)
  { id: 'arena-first-kill', group: 'arena', name: 'First blood', desc: 'Destroy a tank in the arena.', tank: 4 },
  { id: 'arena-streak-5', group: 'arena', name: 'Rampage', desc: 'Destroy 5 tanks in the arena without being destroyed.', goal: 5, tank: 7 },
  { id: 'arena-win', group: 'arena', name: 'King of the arena', desc: 'Win an arena match.', tank: 5 },
  { id: 'arena-all-specials', group: 'arena', name: 'Collector', desc: 'Play as every special tank in the arena.', keys: ARENA_SPECIALS, tank: 6 },
  { id: 'arena-mine-steal', group: 'arena', name: 'Return to sender', desc: 'Destroy a tank with a mine someone else laid.', tank: 9 },
  { id: 'arena-kills-100', group: 'arena', name: 'Veteran', desc: 'Destroy 100 tanks in the arena.', goal: 100, tank: 2 },
]

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]))
const KEY = 'tanks.achievements'

type State = {
  /** unlocked: id -> time (ms) */
  u: Record<string, number>
  /** counters */
  p: Record<string, number>
  /** collected keys of set achievements */
  s: Record<string, string[]>
}

let state: State | null = null

function load(): State {
  if (state) return state
  state = { u: {}, p: {}, s: {} }
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (d && typeof d === 'object') {
      for (const [k, v] of Object.entries(d.u ?? {})) if (BY_ID.has(k)) state.u[k] = Number(v) || 1
      for (const [k, v] of Object.entries(d.p ?? {})) if (BY_ID.has(k)) state.p[k] = Math.max(0, Math.floor(Number(v) || 0))
      for (const [k, v] of Object.entries(d.s ?? {})) if (BY_ID.has(k) && Array.isArray(v)) state.s[k] = v.filter((x) => typeof x === 'string')
    }
  } catch {
    /* corrupt or unavailable storage: start fresh */
  }
  return state
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()))
  } catch {
    /* storage unavailable */
  }
}

const listeners = new Set<(a: Achievement) => void>()

/** called once per newly unlocked achievement (the toast); returns the unsubscribe */
export function onAchievement(f: (a: Achievement) => void) {
  listeners.add(f)
  return () => listeners.delete(f)
}

function def(id: string) {
  const a = BY_ID.get(id)
  if (!a) console.warn(`unknown achievement "${id}"`)
  return a
}

/** unlocks `id`; true when it was not unlocked before */
export function unlock(id: string): boolean {
  const a = def(id)
  const s = load()
  if (!a || s.u[id]) return false
  s.u[id] = Date.now()
  if (a.goal) s.p[id] = Math.max(s.p[id] ?? 0, a.goal)
  save()
  for (const f of [...listeners]) f(a)
  return true
}

/** adds `n` to a counter achievement */
export function progress(id: string, n = 1) {
  const a = def(id)
  if (!a || !(n > 0)) return
  reach(id, (load().p[id] ?? 0) + n)
}

/** raises a counter achievement to `value` */
export function reach(id: string, value: number) {
  const a = def(id)
  if (!a) return
  const s = load()
  const v = Math.floor(value)
  if (!(v > (s.p[id] ?? 0))) return
  s.p[id] = a.goal ? Math.min(v, a.goal) : v
  if (a.goal && v >= a.goal && !s.u[id]) unlock(id)
  else save()
}

/** marks `key` of a set achievement */
export function collect(id: string, key: string) {
  const a = def(id)
  if (!a || !a.keys) return
  const s = load()
  const have = (s.s[id] ??= [])
  if (!have.includes(key)) {
    have.push(key)
    s.p[id] = a.keys.filter((k) => have.includes(k)).length
  }
  if (a.keys.every((k) => have.includes(k)) && !s.u[id]) unlock(id)
  else save()
}

export function isUnlocked(id: string) {
  return !!load().u[id]
}

/** unlock time (ms), 0 while locked */
export function unlockedAt(id: string) {
  return load().u[id] ?? 0
}

/** counter / set progress so far (0 for one-off achievements) */
export function progressOf(id: string) {
  return load().p[id] ?? 0
}

/** the goal shown under a progress bar (counters and sets), 0 for one-off achievements */
export function goalOf(a: Achievement) {
  return a.goal ?? a.keys?.length ?? 0
}

export function unlockedCount() {
  return ACHIEVEMENTS.filter((a) => isUnlocked(a.id)).length
}

/** the collected keys of a set achievement */
export function collected(id: string): string[] {
  return (load().s[id] ?? []).slice()
}
