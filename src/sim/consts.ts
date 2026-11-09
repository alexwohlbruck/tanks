// Constants compiled into the Tanks! code (decomp: build/decomp/src/Pack/RPParty/RPTnkScene).
// All lengths are original world units (1 cell = 35), all times are 60 Hz frames.

/** Online play allows up to 4 players; the original has 1-2. Weapon owner slots are
 * players 0..MAX_PLAYERS-1, then enemies from ENEMY_SLOT0 (the original used 2 + index). */
export const MAX_PLAYERS = 4
export const ENEMY_SLOT0 = MAX_PLAYERS
/** team of enemy tanks (players use their index) and the hit id of enemy weapons
 * (players' weapons hit with index + 1; the original used 3 for enemies) */
export const TEAM_ENEMY = 9
export const HIT_ENEMY = 9

/** RPTnkScene::Calculate runs once per 60 Hz frame. */
export const FPS = 60

/** RPTnkField::sCellWidth / sCellDepth (RPTnkField::Reset: width / cols = 770 / 22 = 35). */
export let CELL = 35
/** kept for older callers; the field always resets it to 35 */
export function setCellSize(v: number) {
  CELL = v
}

/** RPTnkField::Reset, per TV mode */
export const FIELD = {
  '16_9': { width: 770, depth: 595, cols: 22, rows: 17 },
  '4_3': { width: 560, depth: 595, cols: 16, rows: 17 },
} as const

/** sWallMargin (RPTnkField_3.cpp): border walls start 8 outside the field and are 16 longer */
export const WALL_MARGIN = 8

/** Pool sizes: RPTnkField::Create (256 blocks), RPTnkWeaponManager::Create (32 shells, 16 mines),
 * RPTnkTankManager::CreateTanks (2 players, 8 enemies, 16 check marks). */
export const POOL = { blocks: 256, shells: 32, mines: 16, players: 2, enemies: 8, checkMarks: 16 }

/** Sizes of the moving objects (RPTnkTank.cpp, RPTnkShell_2.cpp, RPTnkMine_2.cpp). */
export const TANK = {
  /** model scale (OnSpawn) */
  scale: 1.6,
  /** hit radius against the field and for separation (CollideWithField) */
  fieldRadius: 16,
  /** tank-vs-tank push distance (PushApartFrom: 2 * 16) */
  separation: 32,
  /** radius against mines / blasts (TestHit) */
  mineRadius: 14,
  /** radius against shells (TestHitAlt), measured from pos + shellOffset */
  shellRadius: 15,
  /** world-space offset of the shell hit circle (mHitOffsetAlt; not rotated) */
  shellOffsetZ: 9,
  /** turret pivot height = 11 * scale (mBodyHeight) */
  bodyHeight: 11 * 1.6,
  /** muzzle distance ahead of the pivot (StatePlayerControl / StateEnemyControl) */
  muzzle: 25.6,
  /** tread sample offset along the body x axis (IntegrateStep) and mark spacing */
  treadOffset: 10,
  treadMarkSpacing: 10,
  treadMarkSize: 30,
} as const

export const SHELL = {
  /** Tnk_getShellRadius */
  radius: 6,
  /** model scale (OnSpawn) */
  scale: 1.5238097,
  /** a wall contact at age <= this destroys the shell (OnHitWall) */
  earlyWallAge: 6,
  /** a shell can hit its own tank from this age on (CollideWithField) */
  selfHitAge: 4,
  /** a shell ignores its own tank's mines before this age (IsObjectHit / CheckShellHit) */
  ownMineAge: 16,
} as const

export const MINE = {
  /** radius against walls/blocks (CollideWithField) */
  fieldRadius: 17.1,
  /** owner must leave this radius (+14 tank radius) before the mine arms */
  armRadius: 90,
  /** any tank within this radius (+14) lights the short fuse once armed */
  triggerRadius: 70,
  /** body radius vs shells (TestHit / TestHitAlt), measured from pos + (0, 0, 16) */
  bodyRadius: 12,
  shellOffsetZ: 16,
  /** Tnk_getMineProximityRadius: AI probes and the cork-block test for mine laying */
  proximity: 80,
  /** StateArmed: 480 frames, then a 120-frame lit fuse; proximity lights a 20-frame fuse */
  fuse: 480,
  fuseLit: 120,
  fuseNear: 20,
  /** StateExplode: radius 8 -> 80 over 6 frames, kills tanks while timer < 20, lasts 40 */
  blastStart: 8,
  blastMax: 80,
  blastGrowFrames: 6,
  blastKillFrames: 20,
  blastFrames: 40,
  /** radius before exploding (OnSpawn mBlastRadius) */
  blastIdle: 9,
} as const

/** Fixed gameplay camera (RPTnkCamera::SetMode(1), RPTnkScene::CreateCamerasAndScreens). */
export const CAMERA = {
  projection: 'orthographic' as const,
  /** elevation of the view direction above the floor */
  tiltDeg: 42,
  distance: 2000,
  target: { x: 0, y: 0, z: -14 },
  /** eye = (0, 2000 sin 42, 2000 cos 42 - 14) */
  eye: { x: 0, y: 2000 * Math.sin((42 * Math.PI) / 180), z: 2000 * Math.cos((42 * Math.PI) / 180) - 14 },
  /** up = (0, cos 42, -sin 42) */
  up: { x: 0, y: Math.cos((42 * Math.PI) / 180), z: -Math.sin((42 * Math.PI) / 180) },
  /** view 1 screen: EGG ortho frustum, CANVAS_CC, size = RPGrpScreen max (832 / 608 wide,
   * height = the EFB height passed to RPGrpRenderer::Initialize, assumed 456), scale 1.125.
   * Ortho half extents in world units = size / 2 * 1.125. */
  screenScale: 1.125,
  screen: { '16_9': { w: 832, h: 456 }, '4_3': { w: 608, h: 456 } },
  near: 10,
  far: 10000,
  /** view 0 (tread-mark capture) uses RPTnkField world scale 0.742857 */
  captureWorldScale: 0.742857,
  /** 3D viewport (mpScreen3D) */
  viewport: { '16_9': { w: 624, h: 494 }, '4_3': { w: 468, h: 494 } },
} as const

/** Unused intro fly-in (RPTnkCamera::SetMode(0)); the scene always selects mode 1. */
export const CAMERA_INTRO = {
  points: [
    { x: 0, y: 5, z: 120 },
    { x: 0, y: 5, z: 155 },
    { x: 0, y: 8, z: 175 },
    { x: 0, y: 10, z: 190 },
    { x: 0, y: 2000, z: 0 },
  ],
  target: { x: 0, y: 15, z: 0 },
  speed: 1 / 150,
  slowAfter: 0.9,
  slowFactor: 0.94,
  minSpeed: 0.002,
} as const

/** Block model choice and vertical offset per stack height (RPTnkBlock::CalcModelMtx):
 * model 0 = tnk_block_1 (hole), 1 = tnk_block_7, 2 = tnk_block_8; y -= offset. */
export const BLOCK_MODEL = {
  model: [0, 2, 2, 1, 2, 2, 1, 2],
  yOffset: [-0.2, 105, 87.5, 52.5, 52.5, 35, 0, 0],
  /** scale = cell / 2 / 17.5 (OnSpawn) */
  scale: 1,
} as const

/** Legacy names kept for the renderer (cells, not units). */
export const C = {
  tankRadius: TANK.fieldRadius / 35,
  bulletRadius: SHELL.radius / 35,
  mineRadius: MINE.bodyRadius / 35,
  mineBlastRadius: MINE.blastMax / 35,
  muzzle: TANK.muzzle / 35,
  /** TnkGameParam.bin word 0 */
  startLives: 3,
}
