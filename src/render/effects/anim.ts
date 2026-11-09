// nw4r::ef animation curves (ef_animcurve.cpp): curve time (loop / turn / fitting),
// key search, per-key random values and the u8 / f32 / rotate executors.

import { mixRandom } from './mtx'
import { PROC_FITTING, PROC_INFLOOP, PROC_SYNC, PROC_TURN, type Key, type Track } from './res'

const FLT_EPSILON = 1.1920929e-7
const u8 = (v: number) => v & 0xff

// out-parameters of the time helpers
let oFrame = 0
let oLoop = 0
let oEnd = false

/** CalcTime: curve time of a continuous curve; sets oFrame / oLoop */
function calcTime(h: Track, tick: number, life: number) {
  const f = h.frameLength
  oLoop = 0
  let time: number
  if (f <= 1) {
    time = 0
    oLoop = tick
    oFrame = 0
    return time
  }
  const flag = h.proc
  if (!(flag & PROC_INFLOOP) && h.loopCount <= 1) {
    if (!(flag & PROC_FITTING)) {
      oFrame = tick >= f - 1 ? f - 1 : tick
      time = oFrame
    } else {
      // life 1 divides by zero in the original (NaN -> frame 0)
      time = life > 1 ? tick * ((f - 1) / (life - 1)) : 0
      if (time > f - 1) time = f - 1
      oFrame = Math.trunc(time) & 0xffff
    }
  } else if (!(flag & PROC_FITTING)) {
    oLoop = Math.floor(tick / (f - 1))
    if (!(flag & PROC_TURN)) {
      if (!(flag & PROC_INFLOOP) && oLoop >= h.loopCount) {
        oFrame = f - 1
        oLoop = u8(h.loopCount - 1)
      } else oFrame = tick - oLoop * (f - 1)
    } else {
      if (!(flag & PROC_INFLOOP) && oLoop >= h.loopCount) {
        oFrame = h.loopCount % 2 === 0 ? 0 : f - 1
        oLoop = u8(h.loopCount - 1)
      } else if (oLoop % 2 === 0) oFrame = tick - oLoop * (f - 1)
      else oFrame = (f - 1) * (oLoop + 1) - tick
    }
    time = oFrame
  } else {
    const lastTick = life - 1
    if (tick >= lastTick) {
      oFrame = !(flag & PROC_TURN) || h.loopCount % 2 !== 0 ? u8(f - 1) : 0
      time = oFrame
      oLoop = u8(h.loopCount - 1)
    } else {
      // CalcFittingLoopTime
      const scale = h.loopCount * ((f - 1) / lastTick)
      const loop = Math.trunc((tick * scale) / (f - 1)) >>> 0
      oLoop = loop
      time = tick * scale - loop * (f - 1)
      if (flag & PROC_TURN && loop % 2 !== 0) time = f - 1 - time
      oFrame = Math.trunc(time) & 0xffff
    }
  }
  return time
}

/** CalcFrameStep: integer frame of the step curves (texture, child); sets oFrame / oLoop / oEnd */
export function calcFrameStep(h: Track, tick: number, life: number) {
  const flag = h.proc
  const f = h.frameLength
  oLoop = 0
  oEnd = false
  if (!(flag & PROC_INFLOOP) && h.loopCount <= 1) {
    if (!(flag & PROC_FITTING)) {
      oFrame = tick >= f ? f : tick
      return
    }
    oFrame = Math.floor((f * tick) / life) & 0xffff
    return
  }
  if (!(flag & PROC_FITTING)) {
    if (f <= 1 || !(flag & PROC_TURN)) {
      oLoop = Math.floor(tick / f)
      if (!(flag & PROC_INFLOOP) && oLoop >= h.loopCount) {
        oLoop = u8(h.loopCount - 1)
        oFrame = f
        return
      }
      oFrame = tick - oLoop * f
      return
    }
    oLoop = Math.floor(tick / (f - 1))
    if (!(flag & PROC_INFLOOP) && oLoop >= h.loopCount) {
      if (h.loopCount % 2 === 0) {
        if (oLoop === h.loopCount && tick - oLoop * (f - 1) === 0) oEnd = true
        oFrame = 0
      } else oFrame = u8(f - 1)
      oLoop = u8(h.loopCount - 1)
      return
    }
    oFrame = oLoop % 2 === 0 ? tick - oLoop * (f - 1) : f - 1 - (tick - oLoop * (f - 1))
    return
  }
  if (tick >= life) {
    oFrame = !(flag & PROC_TURN) || h.loopCount % 2 !== 0 ? f : 0
    oLoop = u8(h.loopCount - 1)
    return
  }
  if (f <= 1 || !(flag & PROC_TURN)) {
    const scale = h.loopCount * (f / life)
    const loop = Math.trunc((tick * scale) / f)
    oLoop = loop
    oFrame = Math.trunc(tick * scale - loop * f) & 0xffff
    return
  }
  const scale = (1 + (f - 1) * h.loopCount) / life
  const pos = Math.trunc(tick * scale)
  oLoop = Math.floor(pos / (f - 1))
  if (oLoop >= h.loopCount) {
    if (h.loopCount % 2 === 0) {
      if (tick === life - 1) oEnd = true
      oFrame = 0
    } else oFrame = u8(f - 1)
    oLoop = u8(h.loopCount - 1)
    return
  }
  oFrame = oLoop % 2 === 0 ? pos - oLoop * (f - 1) : (f - 1) * (oLoop + 1) - pos
}
export const stepResult = () => ({ frame: oFrame, loop: oLoop, end: oEnd })

/** SearchKeyStep: lowerBound -> first key at/after frame, else last key at/before it */
export function searchKeyStep(keys: Key[], frame: number, lowerBound: boolean) {
  let hi = keys.length - 1
  let lo = 0
  let mid = hi >> 1
  const first = keys[0].frame
  if (frame < first || (frame === first && lowerBound)) return 0
  if (keys[hi].frame < frame || (frame === keys[hi].frame && !lowerBound)) return hi
  let midFrame = keys[mid].frame
  while (lo < mid) {
    if (frame === midFrame) {
      if (lowerBound) hi = mid
      else lo = mid
    } else {
      if (midFrame < frame) lo = mid
      if (midFrame >= frame) hi = mid
    }
    mid = (lo + hi) >> 1
    midFrame = keys[mid].frame
  }
  return lo
}

// SearchKeyStride out-parameters
let sIdx = 0
let sPrev = 0
let sNext = 0
function searchKeyStride(keys: Key[], frame: number, time: number) {
  let lo = 0
  let hi = keys.length - 1
  let mid = hi >> 1
  const exact = Math.abs(frame - time) < FLT_EPSILON
  sPrev = keys[0].frame
  if (frame < keys[0].frame) {
    sIdx = 0
    return true
  }
  if (frame === keys[0].frame) {
    sIdx = 0
    if (hi === 0) return true
    if (!exact) sNext = keys[1].frame
    return exact
  }
  sNext = keys[hi].frame
  if (sNext <= frame) {
    sIdx = hi
    return true
  }
  let midFrame = keys[mid].frame
  while (lo < mid) {
    if (frame === midFrame) {
      sIdx = mid
      if (!exact) {
        sPrev = midFrame
        sNext = keys[mid + 1].frame
      }
      return exact
    }
    if (midFrame < frame) {
      lo = mid
      sPrev = midFrame
    } else {
      hi = mid
      sNext = midFrame
    }
    mid = (lo + hi) >> 1
    midFrame = keys[mid].frame
  }
  sIdx = lo
  return false
}

/** AdjustTurnLoop: returns [loop0, loop1] */
function adjustTurnLoop(h: Track, idx: number, loop: number): [number, number] {
  let l0 = loop
  let l1 = loop
  if (h.proc & PROC_TURN && (h.proc & PROC_INFLOOP || h.loopCount > 1)) {
    if (!(loop & 1) && idx + 1 >= h.keys.length - 1) {
      if (h.proc & PROC_INFLOOP || loop < h.loopCount - 1) l1 = loop + 1
    }
    if (loop & 1 && idx === 0 && loop !== 0) l0 = loop + 1
  }
  return [l0, l1]
}

/** CalcRandomSeed */
export function calcRandomSeed(seed: number, h: Track, loop: number, rangeIdx: number) {
  let v =
    (Math.imul(seed & 0xffff, 0x3f81f635) + Math.imul(h.randomSeed & 0xffff, 0x30a74193) + Math.imul(rangeIdx, 0x371097e7) + Math.imul(loop, 0x7b929) + 0x4bf53) >>> 0
  let b3 = v >>> 24, b2 = (v >>> 16) & 0xff, b1 = (v >>> 8) & 0xff, b0 = v & 0xff
  b2 ^= b3
  b1 ^= b2
  b0 ^= b1
  v = ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0
  return v
}

// GetRandomRange out-parameter
let gRnd = 0
/** GetRandomRange: the (base, width) table of a random key; sets gRnd */
function getRandomRange(h: Track, random: number, rangeIdx: number, loop: number, seed: number): number[][] {
  let rnd = calcRandomSeed(seed, h, loop, rangeIdx)
  let r: number[][]
  if (!(random & 2)) r = h.ranges[rangeIdx] ?? h.ranges[0] ?? []
  else if (h.table.length) {
    r = h.table[(rnd >>> 16) % h.table.length]
    rnd = mixRandom(rnd)
  } else r = h.ranges[rangeIdx] ?? []
  gRnd = rnd
  return r
}
let gSignIdx = 0

const s16 = (v: number) => ((v >>> 16) << 16) >> 16
/** RandomValueU8 (integer maths, truncating division) */
const randU8 = (r: number[] | undefined, rnd: number) => {
  if (!r) return 0
  const v = r[0] + Math.trunc((r[1] * s16(rnd)) / 32768)
  return v < 0 ? 0 : v > 255 ? 255 : v
}
/** CalcRandomValue (f32) */
const randF = (r: number[] | undefined, rnd: number) => (r ? r[0] + r[1] * (rnd >>> 16) : 0)

function interpU8(interp: number, t: number, v0: number, v1: number) {
  switch (interp & 3) {
    case 0:
      return u8(v0 + Math.floor((t * (v1 - v0)) / 65536))
    case 1: {
      const ft = t / 65536
      if (interp === 1) return u8(Math.trunc(v0 + ft * (ft * ((3 - 2 * ft) * (v1 - v0)))))
      const easeIn = (interp >> 2) & 1 ? 1.5 : 0
      const easeOut = (interp >> 3) & 1 ? 1.5 : 0
      const value = v0 + ft * (v1 - v0) * (easeOut + (ft * (ft * (easeOut + easeIn - 2)) + ft * (3 + (-2 * easeOut - easeIn))))
      return value < 0 ? 0 : value > 255 ? 255 : Math.trunc(value)
    }
    case 2:
      return v0
    default:
      return 0
  }
}

function interpF(interp: number, t: number, v0: number, v1: number) {
  switch (interp & 3) {
    case 0:
      return v0 + t * (v1 - v0)
    case 1: {
      if (interp === 1) return v0 + t * (t * ((3 - 2 * t) * (v1 - v0)))
      const easeIn = (interp >> 2) & 1 ? 1.5 : 0
      const easeOut = (interp >> 3) & 1 ? 1.5 : 0
      return v0 + t * (v1 - v0) * (easeOut + (t * (t * (easeOut + easeIn - 2)) + t * (3 + (-2 * easeOut - easeIn))))
    }
    case 2:
      return v0
    default:
      return 0
  }
}

/** number of components (highest enabled bit) */
const numComps = (enable: number) => {
  for (let b = 7; b >= 0; b--) if (enable & (1 << b)) return b + 1
  return 0
}

/** AnimCurveExecuteU8: writes the enabled components into target[off..] */
export function executeU8(h: Track, target: Uint8Array, off: number, tick: number, seed: number, life: number) {
  const num = numComps(h.enable)
  if (num === 0 || h.keys.length === 0) return
  const time = calcTime(h, tick, life)
  const frame = oFrame
  const loop = oLoop
  const keys = h.keys
  const sync = h.proc & PROC_SYNC
  if (searchKeyStride(keys, frame, time)) {
    const k = keys[sIdx]
    if (k.random === 0) {
      for (let c = 0; c < num; c++) if (h.enable & (1 << (num - 1 - c)) && k.value) target[off + c] = k.value[c] ?? target[off + c]
    } else {
      const r = getRandomRange(h, k.random, k.rangeIdx, loop, seed)
      let rnd = gRnd
      let ri = 0
      for (let c = 0; c < num; c++) {
        if (!(h.enable & (1 << (num - 1 - c)))) continue
        target[off + c] = randU8(r[ri++], rnd)
        if (!sync) rnd = mixRandom(rnd)
      }
    }
    return
  }
  const idx = sIdx
  const [loop0, loop1] = adjustTurnLoop(h, idx, loop)
  const t = Math.floor(Math.trunc(65536 * (time - sPrev)) / (sNext - sPrev))
  const k0 = keys[idx]
  const k1 = keys[idx + 1]
  let r0: number[][] = [], r1: number[][] = []
  let rnd0 = 0, rnd1 = 0
  if (k0.random) {
    r0 = getRandomRange(h, k0.random, k0.rangeIdx, loop0, seed)
    rnd0 = gRnd
  }
  if (k1.random) {
    r1 = getRandomRange(h, k1.random, k1.rangeIdx, loop1, seed)
    rnd1 = gRnd
  }
  let ri0 = 0, ri1 = 0
  for (let c = 0; c < num; c++) {
    if (!(h.enable & (1 << (num - 1 - c)))) continue
    let v0: number, v1: number
    if (k0.random) {
      v0 = randU8(r0[ri0++], rnd0)
      if (!sync) rnd0 = mixRandom(rnd0)
    } else v0 = k0.value?.[c] ?? 0
    if (k1.random) {
      v1 = randU8(r1[ri1++], rnd1)
      if (!sync) rnd1 = mixRandom(rnd1)
    } else v1 = k1.value?.[c] ?? 0
    const ip = k0.interp[c] ?? 0
    target[off + c] = !k0.random && !k1.random && v0 === v1 ? v0 : interpU8(ip, t, v0, v1)
  }
}

/** AnimCurveExecuteF32 */
export function executeF32(h: Track, target: Float64Array | number[], off: number, tick: number, seed: number, life: number) {
  const time = calcTime(h, tick, life)
  const frame = oFrame
  const loop = oLoop
  const num = numComps(h.enable)
  if (num === 0 || h.keys.length === 0) return
  const keys = h.keys
  const sync = h.proc & PROC_SYNC
  if (searchKeyStride(keys, frame, time)) {
    const k = keys[sIdx]
    if (k.random === 0) {
      for (let c = 0; c < num; c++) if (h.enable & (1 << (num - 1 - c)) && k.value) target[off + c] = k.value[c] ?? 0
    } else {
      const r = getRandomRange(h, k.random, k.rangeIdx, loop, seed)
      let rnd = gRnd
      let ri = 0
      for (let c = 0; c < num; c++) {
        if (!(h.enable & (1 << (num - 1 - c)))) continue
        target[off + c] = randF(r[ri++], rnd)
        if (!sync) rnd = mixRandom(rnd)
      }
    }
    return
  }
  const idx = sIdx
  const [loop0, loop1] = adjustTurnLoop(h, idx, loop)
  const t = (time - sPrev) / (sNext - sPrev)
  const k0 = keys[idx]
  const k1 = keys[idx + 1]
  let r0: number[][] = [], r1: number[][] = []
  let rnd0 = 0, rnd1 = 0
  if (k0.random) {
    r0 = getRandomRange(h, k0.random, k0.rangeIdx, loop0, seed)
    rnd0 = gRnd
  }
  if (k1.random) {
    r1 = getRandomRange(h, k1.random, k1.rangeIdx, loop1, seed)
    rnd1 = gRnd
  }
  let ri0 = 0, ri1 = 0
  for (let c = 0; c < num; c++) {
    if (!(h.enable & (1 << (num - 1 - c)))) continue
    let v0: number, v1: number
    if (k0.random) {
      v0 = randF(r0[ri0++], rnd0)
      if (!sync) rnd0 = mixRandom(rnd0)
    } else v0 = k0.value?.[c] ?? 0
    if (k1.random) {
      v1 = randF(r1[ri1++], rnd1)
      if (!sync) rnd1 = mixRandom(rnd1)
    } else v1 = k1.value?.[c] ?? 0
    target[off + c] = !k0.random && !k1.random && v0 === v1 ? v0 : interpF(k0.interp[c] ?? 0, t, v0, v1)
  }
}

/** GetRandomSign + range of a rotate key; returns [range, rnd, negate] */
function rotateRange(h: Track, k: Key, loop: number, seed: number): [number[][], number, boolean] {
  const r = getRandomRange(h, k.random, k.rangeIdx, loop, seed)
  gSignIdx = k.random & 2 ? 0 : k.rangeIdx
  let rnd = gRnd
  let neg = false
  if (h.rangeSign[gSignIdx]) {
    if (!(rnd & 0x10000)) neg = true
    rnd = mixRandom(rnd)
  }
  return [r, rnd, neg]
}

/** AnimCurveExecuteRotate (3 components) */
export function executeRotate(h: Track, target: Float64Array, tick: number, seed: number, life: number) {
  const time = calcTime(h, tick, life)
  const frame = oFrame
  const loop = oLoop
  const keys = h.keys
  if (keys.length === 0) return
  const sync = h.proc & PROC_SYNC
  if (searchKeyStride(keys, frame, time)) {
    const k = keys[sIdx]
    if (k.random === 0) {
      for (let i = 0; i < 3; i++) target[i] = k.value?.[i] ?? 0
    } else {
      const [r, rnd0, neg] = rotateRange(h, k, loop, seed)
      let rnd = rnd0
      for (let i = 0; i < 3; i++) {
        const v = randF(r[i], rnd)
        target[i] = neg ? -v : v
        if (!sync && i < 2) rnd = mixRandom(rnd)
      }
    }
    return
  }
  const idx = sIdx
  const [loop0, loop1] = adjustTurnLoop(h, idx, loop)
  const t = (time - sPrev) / (sNext - sPrev)
  const k0 = keys[idx]
  const k1 = keys[idx + 1]
  let r0: number[][] = [], r1: number[][] = []
  let rnd0 = 0, rnd1 = 0
  let n0 = false, n1 = false
  if (k0.random) [r0, rnd0, n0] = rotateRange(h, k0, loop0, seed)
  if (k1.random) [r1, rnd1, n1] = rotateRange(h, k1, loop1, seed)
  for (let i = 0; i < 3; i++) {
    let v0 = k0.value?.[i] ?? 0
    let v1 = k1.value?.[i] ?? 0
    if (k0.random) {
      v0 = randF(r0[i], rnd0)
      if (n0) v0 = -v0
    }
    if (k1.random) {
      v1 = randF(r1[i], rnd1)
      if (n1) v1 = -v1
    }
    target[i] = !k0.random && !k1.random && v0 === v1 ? v0 : interpF(k0.interp[i] ?? 0, t, v0, v1)
    if (!sync) {
      if (k0.random) rnd0 = mixRandom(rnd0)
      if (k1.random) rnd1 = mixRandom(rnd1)
    }
  }
}
