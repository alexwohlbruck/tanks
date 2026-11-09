// Game data converted from the ROM by tools/build_data.py (see docs/rom-notes.md).
//
// params.json: TnkGameParam.bin — `header` (word 0 = starting lives), `tanks` (10 records of
// 42 words, see src/sim/stats.ts) and `missions` (100 stage records, RPTnkGameManager.cpp
// TnkStageParam). maps.json: MapData/TnkMapData_P{n}_{stage}_{variant}.bin, keyed
// `P{n}_{stage:02}_{16_9|4_3}`; each file is [W, H, P1 facing, P2 facing, cells...].

export type RawParams = {
  header: number
  tanks: number[][]
  missions: RawMission[]
}

/** TnkStageParam: bonus[1P/2P], enemyTypes[1P/2P][8], variants[1P/2P][first, last] */
export type RawMission = {
  /** 1P: extra life when the mission is cleared (the next fade plays the bonus card) */
  bonus: number
  /** 2P bonus flag */
  bonus2P: number
  slots1P: number[]
  slots2P: number[]
  map1P: [number, number]
  map2P: [number, number]
}

export type RawMap = {
  width: number
  height: number
  /** P1/P2 start balloon orientation: 0/1/2/3 = 0/180/90/270 degrees (RPTnkStageMap::ReadPlayerAngles) */
  facing: [number, number]
  cells: number[][]
}

export const TANK = {
  player: 0,
  brown: 1,
  ash: 2,
  marine: 3,
  pink: 4,
  yellow: 5,
  violet: 6,
  green: 7,
  white: 8,
  black: 9,
} as const

export const TANK_NAMES = ['Player', 'Brown', 'Ash', 'Marine', 'Pink', 'Yellow', 'Violet', 'Green', 'White', 'Black']

export type Aspect = '4_3' | '16_9'

export type GameData = {
  params: RawParams
  maps: Record<string, RawMap>
}

export async function loadGameData(base = 'assets/data/'): Promise<GameData> {
  const [params, maps] = await Promise.all([
    fetch(base + 'params.json').then((r) => r.json()),
    fetch(base + 'maps.json').then((r) => r.json()),
  ])
  return normalizeData({ params, maps })
}

/** Accepts both the current maps.json (with `facing`) and the older 2-word-shifted dump. */
export function normalizeData(d: { params: any; maps: Record<string, any> }): GameData {
  const maps: Record<string, RawMap> = {}
  for (const [k, m] of Object.entries(d.maps)) {
    if (m.facing) maps[k] = m as RawMap
    else {
      // old build_data.py read the cells from word 2: words 2-3 were the facing values
      const flat: number[] = [...m.cells.flat(), ...(m.trailer ?? [])]
      const facing: [number, number] = [flat[0], flat[1]]
      const cells = flat.slice(2)
      const rows = []
      for (let r = 0; r < m.height; r++) rows.push(cells.slice(r * m.width, (r + 1) * m.width))
      maps[k] = { width: m.width, height: m.height, facing, cells: rows }
    }
  }
  const params = d.params as RawParams
  for (const mi of params.missions as any[]) if (mi.bonus2P === undefined) mi.bonus2P = mi.unknown1 ?? 0
  return { params, maps }
}

export function mapKey(players: 1 | 2, stage: number, aspect: Aspect) {
  return `P${players}_${String(stage).padStart(2, '0')}_${aspect}`
}

/** A mission slot value: 0 = empty, 1-9 = tank id, two digits `ab` = random id in [a, b]. */
export function resolveSlot(v: number, rand: () => number): number {
  if (v < 10) return v
  const lo = Math.floor(v / 10)
  const hi = v % 10
  return lo + Math.floor(rand() * (hi - lo + 1))
}

export type MissionSetup = {
  /** 0-based stage (mission number - 1) */
  index: number
  /** bonus flag of this mission for the current mode (life awarded after clearing it) */
  bonus: boolean
  /** map stage file 0-29 (RPTnkGameManager unk10) */
  variant: number
  mapKey: string
  map: RawMap
  /** tank type per enemy spawn slot 0-7 (cells 400-407); 0 = none. Raw values before the
   * stage is loaded, resolved types after (random ranges are rolled by RPTnkStageMap). */
  slots: number[]
  /** RPTnkStageMap::mEnemyActive */
  active: boolean[]
}
