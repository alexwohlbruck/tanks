// Named view of the 42-word tank records in param/TnkGameParam.bin (record t at 4 + t*0xA8).
// Field use per consumer: RPTnkPlayerController::Reset (player record 0), RPTnkAiMove::LoadParams
// (RPTnkAi_2.cpp), RPTnkAiAttack::LoadParams (RPTnkAi_4.cpp), RPTnkTank::SpawnEnemy (stealth).
// The decomp's AI field names for words 8/9/41 are misleading; the names below follow the
// player controller usage (DOL-confirmed): k8 = mine cooldown, k9 = freeze after a mine,
// k41 = freeze after a shot.

export type TankParams = {
  raw: number[]
  /** k0 0x00: turns invisible on activation (White) */
  stealth: boolean
  /** k1 0x04: AI FindClearDirection distance before laying a mine */
  mineClearDist: number
  /** k2 0x08: own mines on the field at most */
  maxMines: number
  /** k3/k4 0x0C/0x10: AI mine-decision interval range */
  mineIntervalMax: number
  mineIntervalMin: number
  /** k5 0x14: AI lays no mine while another enemy is within this distance */
  mineEnemyDist: number
  /** k6 0x18: % chance next to a cork block; k7 0x1C: % otherwise */
  mineChanceNearBlock: number
  mineChance: number
  /** k8 0x20: frames between mines */
  mineCooldown: number
  /** k9 0x24: frames frozen after laying a mine */
  mineFreeze: number
  /** k10 0x28: speed gained per frame while facing the goal; k11 0x2C: speed factor otherwise */
  accel: number
  decel: number
  /** k12 0x30: AI StateApproach random deviation (degrees, +-) */
  wanderAngle: number
  /** k13/k14 0x34/0x38: AI movement re-decision interval range */
  moveTimerMax: number
  moveTimerMin: number
  /** k15 0x3C / k17 0x44: AI avoids mines laid by non-P1 / P1 within this radius (0 = ignore) */
  mineAvoidEnemy: number
  mineAvoidPlayer: number
  /** k16 0x40 / k18 0x48: AI notices shells fired by non-P1 / P1 within this range */
  shellRangeEnemy: number
  shellRangePlayer: number
  /** k19 0x4C: cannot fire / lay mines while evading */
  noFireWhileEvading: boolean
  /** k20 0x50: pull toward the nearest player in StateApproach */
  aggression: number
  /** k21 0x54: direction history entries averaged */
  historyNum: number
  /** k22 0x58: top speed */
  speed: number
  /** k23/k24 0x5C/0x60: player stick dead zone / full-speed magnitude */
  stickMin: number
  stickMax: number
  /** k25 0x64: body turn step (side component per frame) */
  turnStep: number
  /** k26 0x68: accelerate only within this angle of the goal (Nunchuk; D-pad uses 46) */
  moveAngle: number
  /** k27 0x6C: AI StateApproach probe length */
  probeSteps: number
  /** k28 0x70: AI aim deviation (degrees, +-) */
  aimAngle: number
  /** k29 0x74: own shells on the field at most */
  maxShells: number
  /** k30 0x78 / k31 0x7C / k32 0x80: AI shot cone angles (self / ally / player) */
  selfAngle: number
  allyAngle: number
  playerAngle: number
  /** k33 0x84: wall bounces */
  ricochets: number
  /** k34/k35 0x88/0x8C: AI fire-decision interval range */
  fireIntervalMax: number
  fireIntervalMin: number
  /** k36 0x90: frames between shots */
  fireCooldown: number
  /** k37 0x94: shell speed (units / frame) */
  shellSpeed: number
  /** k38 0x98: AI turret turn step */
  aimStep: number
  /** k39 0x9C: AI frames between aim re-targeting */
  aimTime: number
  /** k40 0xA0: AI ally distance */
  allyDist: number
  /** k41 0xA4: frames frozen after a shot */
  fireFreeze: number

  // legacy names used by older renderer / HUD code
  invisible: boolean
  maxBullets: number
  bulletSpeed: number
  turnSpeed: number
  turnStopAngle: number
  turretSpeed: number
}

export type TankStats = TankParams

let records: number[][] = []

export function setTankRecords(r: number[][]) {
  records = r
}

/** word index of the legacy names (docs/rom-notes.md) */
export const F = {
  invisible: 0,
  maxMines: 2,
  speed: 22,
  turnSpeed: 25,
  turnStopAngle: 26,
  maxBullets: 29,
  ricochets: 33,
  fireCooldown: 36,
  bulletSpeed: 37,
  turretSpeed: 38,
} as const

const cache = new Map<number, TankParams>()

export function paramsFromRecord(k: number[]): TankParams {
  return {
    raw: k,
    stealth: k[0] !== 0,
    mineClearDist: k[1],
    maxMines: k[2],
    mineIntervalMax: k[3],
    mineIntervalMin: k[4],
    mineEnemyDist: k[5],
    mineChanceNearBlock: k[6],
    mineChance: k[7],
    mineCooldown: k[8],
    mineFreeze: k[9],
    accel: k[10],
    decel: k[11],
    wanderAngle: k[12],
    moveTimerMax: k[13],
    moveTimerMin: k[14],
    mineAvoidEnemy: k[15],
    shellRangeEnemy: k[16],
    mineAvoidPlayer: k[17],
    shellRangePlayer: k[18],
    noFireWhileEvading: k[19] !== 0,
    aggression: k[20],
    historyNum: k[21],
    speed: k[22],
    stickMin: k[23],
    stickMax: k[24],
    turnStep: k[25],
    moveAngle: k[26],
    probeSteps: k[27],
    aimAngle: k[28],
    maxShells: k[29],
    selfAngle: k[30],
    allyAngle: k[31],
    playerAngle: k[32],
    ricochets: k[33],
    fireIntervalMax: k[34],
    fireIntervalMin: k[35],
    fireCooldown: k[36],
    shellSpeed: k[37],
    aimStep: k[38],
    aimTime: k[39],
    allyDist: k[40],
    fireFreeze: k[41],
    invisible: k[0] !== 0,
    maxBullets: k[29],
    bulletSpeed: k[37],
    turnSpeed: k[25],
    turnStopAngle: k[26],
    turretSpeed: k[38],
  }
}

/** Parameters of tank type 0 (player) .. 9 (Black), and of registered added types (10+). */
export function paramsFor(type: number): TankParams {
  let p = cache.get(type)
  // [tanks+] added types (10+) come from registerTankType; the disc records are never replaced
  const rec = records[type] ?? (type >= FIRST_ADDED_TYPE ? added.get(type)?.record : undefined)
  if (!p || p.raw !== rec) {
    if (!rec) throw new Error(`no tank record ${type} (setTankRecords not called?)`)
    p = paramsFromRecord(rec)
    cache.set(type, p)
  }
  return p
}

// ===== [tanks+] tank type registry =========================================================
// Added enemy types (ids 10..31) are a 42-word record like the disc's (same meaning per word,
// read by the unchanged AI) plus `meta`: display data and opt-in behaviour flags that the
// records cannot express (src/sim/types/*). Types 1-9 are listed by tankTypes() too, with the
// original names / swatches, but their records always come from the disc data.

/** first id available to added types; stats arrays hold ids up to 31 (game.ts TYPE_SLOTS) */
export const FIRST_ADDED_TYPE = 10
export const MAX_TANK_TYPE = 31

/** opt-in behaviours of added types (all off by default; see src/sim/types/behaviours.ts) */
export type TankBehaviours = {
  /** hit points (default 1); +hpPerPlayer for every player beyond the first */
  hp?: number
  hpPerPlayer?: number
  /** extra radius against shells (big boss hulls) */
  hitBonus?: number
  /** every shot is a fan of `count` shells `angle` degrees apart */
  spread?: { count: number; angle: number }
  /** shells steer toward the nearest player (degrees per frame, after `delay` frames) */
  homing?: { turn: number; delay: number }
  /** shells from within +-`angle` degrees of the hull's front ricochet off */
  frontShield?: { angle: number }
  /** teleports to a free cell away from the players every `interval` frames (`warn` frames telegraphed) */
  teleport?: { interval: number; warn: number; minDist: number }
  /** lays mines on a timer while driving, `pattern` 'trail' (one behind) or 'cross' (a burst of 3) */
  minePattern?: { interval: number; pattern: 'trail' | 'cross'; max: number }
  /** no gun; arms a short fuse near a player and explodes like a mine */
  kamikaze?: { trigger: number; fuse: number }
  /** a shot is charged with a visible laser sight for `charge` frames, then fired at `speed` */
  sniper?: { charge: number; speed: number }
  /** gives allies within `radius` a one-hit shield every `interval` frames */
  medic?: { interval: number; radius: number }
  /** releases tanks of `type` every `interval` frames, at most `max` alive */
  spawner?: { type: number; interval: number; max: number }
  /** invisible while (nearly) standing still */
  ghost?: boolean
}

export type TankMeta = {
  name: string
  /** CSS colour (HUD / results / editor swatch) */
  colour: string
  description: string
  /** BGM track-mask row (original type 1-9 whose music intensity this type gets) */
  bgmRank: number
  /** original type (1-9) whose shell look / sounds this type's shells use (3/7/9 = rockets) */
  shellLook?: number
  /** boss tank (shown with a hit-point bar) */
  boss?: boolean
  behaviours?: TankBehaviours
}

export type TankTypeInfo = { id: number; name: string; colour: string; description: string; original: boolean; boss: boolean; bgmRank: number }

const added = new Map<number, { record: number[]; meta: TankMeta }>()

const ORIGINAL: [string, string, string][] = [
  ['Brown', '#a17a3a', 'Stationary; its turret wanders and it rarely fires.'],
  ['Ash', '#767064', 'Slow and defensive; dodges shells.'],
  ['Marine', '#407c71', 'Fires fast rockets with perfect aim; keeps its distance.'],
  ['Pink', '#ca5f69', 'Aggressive; fires three shells in quick succession.'],
  ['Yellow', '#d8c130', 'Fast mine layer.'],
  ['Violet', '#815c80', 'Fast and aggressive; five shells and mines.'],
  ['Green', '#52874a', 'Stationary bank-shot specialist with double-ricochet rockets.'],
  ['White', '#e7dbae', 'Turns invisible when the mission starts; only its tracks show.'],
  ['Black', '#383630', 'Very fast with accurate rockets; ignores your mines.'],
]

/** registers an added enemy type (id 10..31) */
export function registerTankType(id: number, record42: number[], meta: TankMeta) {
  if (id < FIRST_ADDED_TYPE || id > MAX_TANK_TYPE) throw new Error(`tank type id ${id} outside ${FIRST_ADDED_TYPE}..${MAX_TANK_TYPE}`)
  if (record42.length !== 42) throw new Error(`tank type ${id}: record has ${record42.length} words, not 42`)
  added.set(id, { record: record42, meta })
  cache.delete(id)
}

/** meta of an added type (undefined for 0-9 and unknown ids) */
export function tankMeta(id: number): TankMeta | undefined {
  return added.get(id)?.meta
}

/** every enemy type: the original 1-9 and the registered added ones, by id */
export function tankTypes(): TankTypeInfo[] {
  const out: TankTypeInfo[] = ORIGINAL.map(([name, colour, description], i) => ({ id: i + 1, name, colour, description, original: true, boss: false, bgmRank: i + 1 }))
  for (const [id, { meta }] of [...added].sort((a, b) => a[0] - b[0]))
    out.push({ id, name: meta.name, colour: meta.colour, description: meta.description, original: false, boss: !!meta.boss, bgmRank: meta.bgmRank })
  return out
}

export const statsFor = paramsFor
