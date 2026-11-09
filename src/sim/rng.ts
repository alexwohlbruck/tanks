// The party-pack random generator (RP_randSeedX / RP_randSeedY, inlined in every Tanks
// unit, e.g. RPTnkAi_2.cpp AdvanceRandom, RPTnkAi_4.cpp AttackRandom, RPTnkStageMap.cpp
// RandomU32, RPTnkGameManager.cpp TnkGameRandom, RPTnkTankManager.cpp LimitAiFlag110):
//
//   X = X * 0x41C64E6D + 12345          (32-bit LCG)
//   if (Y & 1) Y ^= 0x11020; Y >>= 1    (LFSR)
//   r = X ^ Y
//
// Seeded from OSGetTick at RPTnkScene::Reset (RP_seedRandomTicks, RPUtlDohMath.cpp); here
// from an explicit seed so runs are reproducible.

export class RPRandom {
  x = 1
  y = 1

  constructor(seed = 1) {
    this.seed(seed)
  }

  /** RP_seedRandomTicks: both words non-zero. We derive Y from the seed with a hash. */
  seed(seed: number) {
    this.x = seed >>> 0 || 1
    let h = Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
    this.y = (h ^ (h >>> 16)) >>> 0 || 1
  }

  /** Advances and returns the raw u32 X ^ Y. */
  next(): number {
    this.x = (Math.imul(this.x, 0x41c64e6d) + 12345) >>> 0
    if (this.y & 1) this.y = (this.y ^ 0x11020) >>> 0
    this.y >>>= 1
    return (this.x ^ this.y) >>> 0
  }

  /** ((r >> 4) & 0xFFFF): the 16-bit integer draw used for timers. */
  int16(): number {
    return (this.next() >>> 4) & 0xffff
  }

  /** (r & 0x7FFFFF) * 2^-23 in [0, 1) */
  float01(): number {
    return (this.next() & 0x7fffff) * 1.1920929e-7
  }

  /** AiMoveAccess::RandomRange / AttackRandomRange: returns lo WITHOUT advancing when lo == hi. */
  range(lo: number, hi: number): number {
    if (lo === hi) return lo
    return (hi - lo) * this.float01() + lo
  }

  /** lo + ((r >> 4) & 0xFFFF) % (hi - lo) with Gekko divide-by-zero semantics (see ppcMod). */
  timer(lo: number, hi: number): number {
    return lo + ppcMod(this.int16(), hi - lo)
  }

  get state() {
    return { x: this.x, y: this.y }
  }
}

/**
 * Signed `a % b` as compiled for Broadway (divw + mullw + subf). divw by zero does not trap;
 * the quotient is 0 for a non-negative dividend (and -1 for a negative one), so the
 * remainder is `a` (resp. a + b = a). Brown/Green have equal timer bounds and hit this.
 */
export function ppcMod(a: number, b: number): number {
  if (b === 0) return a
  return a % b
}
