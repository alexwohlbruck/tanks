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

/** Parameters of tank type 0 (player) .. 9 (Black). */
export function paramsFor(type: number): TankParams {
  let p = cache.get(type)
  if (!p || p.raw !== records[type]) {
    if (!records[type]) throw new Error(`no tank record ${type} (setTankRecords not called?)`)
    p = paramsFromRecord(records[type])
    cache.set(type, p)
  }
  return p
}

export const statsFor = paramsFor
