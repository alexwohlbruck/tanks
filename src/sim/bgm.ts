// RPTnkBgmMix (RPTnkBgmMix.cpp): the stage music is one sequence (RP_TNK_BGM_LOOP2) whose
// tracks are unmuted by a mask chosen from the enemies alive and the strongest enemy type.

/** sTrackMasks[strongest enemy type - 1][min(enemies alive, 4) - 1]; bit i = track i audible */
export const TRACK_MASKS: readonly (readonly number[])[] = [
  [0x411, 0x411, 0x411, 0x411],
  [0x491, 0x491, 0x493, 0x493],
  [0x4c3, 0x4d3, 0x4d3, 0x4d9],
  [0x419, 0x459, 0x4d9, 0x4d9],
  [0x4e3, 0x4f3, 0x4f9, 0x4f9],
  [0x543, 0x573, 0x5f9, 0x5f9],
  [0x547, 0x567, 0x5f7, 0x5fd],
  [0x713, 0x7b9, 0x7f9, 0x7f9],
  [0x7ed, 0x7ed, 0x7ed, 0x7ed],
]

/**
 * Pure form of RPTnkBgmMix::ApplyTrackMask: the unmuted-track mask for `enemyAlive` enemies
 * whose strongest type is `maxType`. When the stage music is not playing (after Stop or the
 * clear fanfare) the mix unmutes everything (0xFFFF) on whatever BGM is current.
 */
export function bgmTrackMask(enemyAlive: number, maxType: number, playing = true): number {
  if (!playing) return 0xffff
  const n = Math.min(4, Math.max(1, Math.min(8, enemyAlive)))
  const t = Math.min(9, Math.max(1, maxType))
  return TRACK_MASKS[t - 1][n - 1]
}

/** Track bit -> instrument (docs/research.md 7.1) */
export const TRACK_INSTRUMENTS = ['piccolo', 'timpaniA', 'bells', 'timpaniB', 'snare', 'bass', 'cymbals', 'metronome', 'tuba', 'synth', 'piccolo2']

/** Sound/BGM output. Names are the brsar labels of rp_Tnk_sound.h (e.g. 'RP_TNK_SE_SHOOT_1P'). */
export interface AudioSink {
  /** one-shot SE; `pos` = world position for 3D panning (absent for system SEs) */
  se(name: string, pos?: { x: number; z: number }): void
  /** looped SE that must keep sounding while this is called every frame for `key` */
  seHold?(name: string, key: number, pos?: { x: number; z: number }): void
  /** start a BGM sequence (RPSndAudioMgr::startBgm) */
  bgm(name: string): void
  /** stop the BGM with a fade of `fadeFrames` (RPSndAudioMgr::stopBgm) */
  bgmStop(fadeFrames: number): void
  /** SetTrackMute(0xFFFF, mute) then SetTrackMute(mask, off) on the current BGM */
  bgmTrackMask(mask: number): void
}

type Out = { bgm(name: string): void; bgmStop(f: number): void; mask(m: number): void }

/** RPTnkBgmMix */
export class BgmMix {
  trackMask = 0x411
  stage = 0
  enemyNum = 0
  maxType = 0
  playing = false

  constructor(private out: Out) {}

  /** RPTnkBgmMix::Reset */
  reset() {
    this.trackMask = 0x411
    this.stage = 0
    this.enemyNum = 0
    this.maxType = 0
    this.playing = false
  }

  /** RPTnkBgmMix::StartStageBgm */
  startStageBgm(stage: number, enemyNum: number, maxType: number) {
    this.trackMask = 0x411
    this.stage = Math.max(1, stage)
    this.enemyNum = clamp(enemyNum, 1, 8)
    this.maxType = clamp(maxType, 1, 9)
    this.playing = true
    this.out.bgmStop(0)
    this.out.bgm('RP_TNK_BGM_LOOP2')
    this.applyTrackMask()
  }

  /** RPTnkBgmMix::SetParams (every frame from RPTnkGameManager::Calculate) */
  setParams(enemyNum: number, maxType: number) {
    enemyNum = clamp(enemyNum, 1, 8)
    maxType = clamp(maxType, 1, 9)
    if (this.enemyNum !== enemyNum) {
      this.enemyNum = enemyNum
      this.applyTrackMask()
    }
    if (this.maxType !== maxType) {
      this.maxType = maxType
      this.applyTrackMask()
    }
  }

  /** RPTnkBgmMix::ApplyTrackMask */
  applyTrackMask() {
    if (this.stage < 1) this.stage = 1
    this.enemyNum = clamp(this.enemyNum, 1, 8)
    this.maxType = clamp(this.maxType, 1, 9)
    this.trackMask = bgmTrackMask(this.enemyNum, this.maxType, this.playing)
    this.out.mask(this.trackMask)
  }

  /** RPTnkBgmMix::PlayStageClearBgm */
  playStageClearBgm() {
    this.out.bgmStop(10)
    this.out.bgm('RP_TNK_BGM_FILL2')
    this.reset()
  }

  /** RPTnkBgmMix::Stop */
  stop() {
    this.out.bgmStop(10)
    this.trackMask = 0xffff
    this.stage = 0
    this.enemyNum = 0
    this.maxType = 0
    this.playing = false
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
