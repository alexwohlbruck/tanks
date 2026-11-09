// Minimal 3-vector maths mirroring nw4r::math / PSVEC as used by the Tanks code.
// All vectors are mutable plain objects; functions write into `out` like the SDK calls.

export type V3 = { x: number; y: number; z: number }
/** RPAxes: the three basis vectors of a rotation (x side, y up, z forward). */
export type Axes = { x: V3; y: V3; z: V3 }

export const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z })
export const vcopy = (a: V3): V3 => ({ x: a.x, y: a.y, z: a.z })
export function vset(out: V3, a: V3): V3 {
  out.x = a.x
  out.y = a.y
  out.z = a.z
  return out
}
export const ZERO: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 0 })
export const EY: Readonly<V3> = Object.freeze({ x: 0, y: 1, z: 0 })
export const EZ: Readonly<V3> = Object.freeze({ x: 0, y: 0, z: 1 })
export const EX: Readonly<V3> = Object.freeze({ x: 1, y: 0, z: 0 })

export const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
export const mag = (a: V3) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)

/** PSVECNormalize: no zero guard in the SDK; we return the input unchanged for |a| = 0. */
export function normalize(out: V3, a: V3 = out): V3 {
  const m = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
  if (m === 0) return vset(out, a)
  const inv = 1 / m
  out.x = a.x * inv
  out.y = a.y * inv
  out.z = a.z * inv
  return out
}

/** PSVECCrossProduct(a, b, out) */
export function cross(a: V3, b: V3, out: V3): V3 {
  const x = a.y * b.z - a.z * b.y
  const y = a.z * b.x - a.x * b.z
  const z = a.x * b.y - a.y * b.x
  out.x = x
  out.y = y
  out.z = z
  return out
}

export const identityAxes = (): Axes => ({ x: v3(1, 0, 0), y: v3(0, 1, 0), z: v3(0, 0, 1) })
export const copyAxes = (a: Axes): Axes => ({ x: vcopy(a.x), y: vcopy(a.y), z: vcopy(a.z) })
export function setAxes(out: Axes, a: Axes) {
  vset(out.x, a.x)
  vset(out.y, a.y)
  vset(out.z, a.z)
}
/** z := dir, y := Ey, x := y × z (the idiom used for every basis in the Tanks code) */
export function axesFromForward(out: Axes, dir: V3) {
  vset(out.z, dir)
  vset(out.y, EY)
  cross(out.y, out.z, out.x)
}

/**
 * RPSelectMoreAlignedVec (RPUtlDohMath.cpp): copies whichever of a, b has the larger dot
 * with ref (ties pick a). Returns false for a, true for b.
 */
export function selectMoreAligned(out: V3, ref: V3, a: V3, b: V3): boolean {
  if (dot(ref, a) >= dot(ref, b)) {
    vset(out, a)
    return false
  }
  vset(out, b)
  return true
}

/** RPCalcPerpendicularDir (RPUtlDohMath.cpp) */
export function perpendicularDir(out: V3, point: V3, origin: V3, dir: V3): V3 {
  const diff = v3(point.x - origin.x, point.y - origin.y, point.z - origin.z)
  let m = mag(diff)
  if (m === 0) return vset(out, ZERO)
  diff.x /= m
  diff.y /= m
  diff.z /= m
  const d = normalize(v3(), dir)
  const side = cross(d, diff, v3())
  m = mag(side)
  if (m === 0) return vset(out, ZERO)
  side.x /= m
  side.y /= m
  side.z /= m
  return cross(d, side, out)
}

/** RP_calcPerpendicularDistance (RPUtlDohMath_2.cpp) */
export function perpendicularDistance(point: V3, origin: V3, dir: V3): number {
  const diff = v3(origin.x - point.x, origin.y - point.y, origin.z - point.z)
  const perp = perpendicularDir(v3(), point, origin, dir)
  return dot(perp, diff)
}

export const DEG = Math.PI / 180
export const cosDeg = (d: number) => Math.cos(d * DEG)
export const sinDeg = (d: number) => Math.sin(d * DEG)
export const tanDeg = (d: number) => Math.tan(d * DEG)

/** Heading of a forward vector as used by the renderer: atan2(z, x), 0 = +x. */
export const heading = (f: V3) => Math.atan2(f.z, f.x)

/**
 * Per-component min/max push accumulator (TnkAccumulateScaled in RPTnkTank.cpp, and its
 * twins in RPTnkShell_2 / RPTnkMine_2 / RPTnkAi_3): lo = min(lo, s*n), hi = max(hi, s*n).
 */
export function accumulate(lo: V3, hi: V3, s: number, n: V3) {
  const x = s * n.x
  const y = s * n.y
  const z = s * n.z
  if (lo.x > x) lo.x = x
  if (lo.y > y) lo.y = y
  if (lo.z > z) lo.z = z
  if (hi.x < x) hi.x = x
  if (hi.y < y) hi.y = y
  if (hi.z < z) hi.z = z
}
