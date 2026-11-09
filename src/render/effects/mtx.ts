// nw4r::math subset used by nw4r::ef: 3x4 row-major matrices (column vectors,
// m[r*4+c] = _rc) and a small mutable vector. MTX34Trans/Scale post-multiply
// (out = in * T / in * S), MTX34RotXYZ is Rz * Ry * Rx, like the originals.

export type M34 = Float64Array

export class V3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  set(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  copy(v: V3) {
    this.x = v.x
    this.y = v.y
    this.z = v.z
    return this
  }
  clone() {
    return new V3(this.x, this.y, this.z)
  }
  add(v: V3) {
    this.x += v.x
    this.y += v.y
    this.z += v.z
    return this
  }
  sub(v: V3) {
    this.x -= v.x
    this.y -= v.y
    this.z -= v.z
    return this
  }
  scale(s: number) {
    this.x *= s
    this.y *= s
    this.z *= s
    return this
  }
  subVecs(a: V3, b: V3) {
    return this.set(a.x - b.x, a.y - b.y, a.z - b.z)
  }
  lenSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z
  }
  len() {
    return Math.sqrt(this.lenSq())
  }
  /** VEC3Normalize (no zero check) */
  normalize() {
    const l = Math.sqrt(this.lenSq())
    this.x /= l
    this.y /= l
    this.z /= l
    return this
  }
  isZero() {
    return this.x === 0 && this.y === 0 && this.z === 0
  }
}

export const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z
export function cross(out: V3, a: V3, b: V3) {
  return out.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x)
}

/** DrawStrategyImpl::Normalize: false (unchanged) when |v|^2 < FLT_EPSILON */
export function normalizeEps(v: V3) {
  const sq = v.lenSq()
  if (sq < 1.1920929e-7) return false
  v.scale(1 / Math.sqrt(sq))
  return true
}

export const m34 = (): M34 => {
  const m = new Float64Array(12)
  m[0] = m[5] = m[10] = 1
  return m
}

export function ident(m: M34) {
  m.fill(0)
  m[0] = m[5] = m[10] = 1
  return m
}

export function copy(out: M34, a: M34) {
  out.set(a)
  return out
}

const tmpA = new Float64Array(12)
const tmpB = new Float64Array(12)

/** out = a * b */
export function mult(out: M34, a: M34, b: M34) {
  const A = out === a ? copy(tmpA, a) : a
  const B = out === b ? copy(tmpB, b) : b
  for (let r = 0; r < 3; r++) {
    const a0 = A[r * 4],
      a1 = A[r * 4 + 1],
      a2 = A[r * 4 + 2],
      a3 = A[r * 4 + 3]
    out[r * 4] = a0 * B[0] + a1 * B[4] + a2 * B[8]
    out[r * 4 + 1] = a0 * B[1] + a1 * B[5] + a2 * B[9]
    out[r * 4 + 2] = a0 * B[2] + a1 * B[6] + a2 * B[10]
    out[r * 4 + 3] = a0 * B[3] + a1 * B[7] + a2 * B[11] + a3
  }
  return out
}

/** PSMTXInverse: false (out untouched) when singular */
export function inv(out: M34, a: M34) {
  const m00 = a[0], m01 = a[1], m02 = a[2], m03 = a[3]
  const m10 = a[4], m11 = a[5], m12 = a[6], m13 = a[7]
  const m20 = a[8], m21 = a[9], m22 = a[10], m23 = a[11]
  const det = m00 * m11 * m22 + m01 * m12 * m20 + m02 * m10 * m21 - m20 * m11 * m02 - m10 * m01 * m22 - m00 * m21 * m12
  if (det === 0) return false
  const d = 1 / det
  const i00 = (m11 * m22 - m21 * m12) * d
  const i01 = -(m01 * m22 - m21 * m02) * d
  const i02 = (m01 * m12 - m11 * m02) * d
  const i10 = -(m10 * m22 - m20 * m12) * d
  const i11 = (m00 * m22 - m20 * m02) * d
  const i12 = -(m00 * m12 - m10 * m02) * d
  const i20 = (m10 * m21 - m20 * m11) * d
  const i21 = -(m00 * m21 - m20 * m01) * d
  const i22 = (m00 * m11 - m10 * m01) * d
  out[0] = i00
  out[1] = i01
  out[2] = i02
  out[3] = -(i00 * m03 + i01 * m13 + i02 * m23)
  out[4] = i10
  out[5] = i11
  out[6] = i12
  out[7] = -(i10 * m03 + i11 * m13 + i12 * m23)
  out[8] = i20
  out[9] = i21
  out[10] = i22
  out[11] = -(i20 * m03 + i21 * m13 + i22 * m23)
  return true
}

/** MTX34Trans(out, in, t): out = in * T(t) */
export function trans(out: M34, a: M34, x: number, y: number, z: number) {
  if (out !== a) out.set(a)
  out[3] = a[0] * x + a[1] * y + a[2] * z + a[3]
  out[7] = a[4] * x + a[5] * y + a[6] * z + a[7]
  out[11] = a[8] * x + a[9] * y + a[10] * z + a[11]
  return out
}

/** MTX34Scale(out, in, s): out = in * S(s) */
export function scale(out: M34, a: M34, x: number, y: number, z: number) {
  for (let r = 0; r < 3; r++) {
    out[r * 4] = a[r * 4] * x
    out[r * 4 + 1] = a[r * 4 + 1] * y
    out[r * 4 + 2] = a[r * 4 + 2] * z
    out[r * 4 + 3] = a[r * 4 + 3]
  }
  return out
}

/** MTX34RotXYZRad: Rz * Ry * Rx, no translation */
export function rotXYZ(m: M34, rx: number, ry: number, rz: number) {
  const sx = Math.sin(rx), cx = Math.cos(rx)
  const sy = Math.sin(ry), cy = Math.cos(ry)
  const sz = Math.sin(rz), cz = Math.cos(rz)
  m[8] = -sy
  m[0] = cz * cy
  m[4] = sz * cy
  m[9] = cy * sx
  m[10] = cy * cx
  const cxsz = cx * sz, sxcz = sx * cz
  m[1] = sxcz * sy - cxsz
  m[6] = cxsz * sy - sxcz
  const sxsz = sx * sz, cxcz = cx * cz
  m[2] = cxcz * sy + sxsz
  m[5] = sxsz * sy + cxcz
  m[3] = m[7] = m[11] = 0
  return m
}

/** PSMTXRotAxisRad */
export function rotAxis(m: M34, axis: V3, rad: number) {
  const s = Math.sin(rad), c = Math.cos(rad), t = 1 - c
  const l = axis.len()
  const x = axis.x / l, y = axis.y / l, z = axis.z / l
  m[0] = t * x * x + c
  m[1] = t * x * y - s * z
  m[2] = t * x * z + s * y
  m[3] = 0
  m[4] = t * x * y + s * z
  m[5] = t * y * y + c
  m[6] = t * y * z - s * x
  m[7] = 0
  m[8] = t * x * z - s * y
  m[9] = t * y * z + s * x
  m[10] = t * z * z + c
  m[11] = 0
  return m
}

/** VEC3Transform (with translation) */
export function xform(out: V3, m: M34, v: V3) {
  return out.set(
    m[0] * v.x + m[1] * v.y + m[2] * v.z + m[3],
    m[4] * v.x + m[5] * v.y + m[6] * v.z + m[7],
    m[8] * v.x + m[9] * v.y + m[10] * v.z + m[11],
  )
}

/** VEC3TransformNormal (3x3 only) */
export function xformN(out: V3, m: M34, v: V3) {
  return out.set(m[0] * v.x + m[1] * v.y + m[2] * v.z, m[4] * v.x + m[5] * v.y + m[6] * v.z, m[8] * v.x + m[9] * v.y + m[10] * v.z)
}

export function noTrans(out: M34, a: M34) {
  if (out !== a) out.set(a)
  out[3] = out[7] = out[11] = 0
  return out
}

const colv = (m: M34, c: number, v: V3) => v.set(m[c], m[4 + c], m[8 + c])
const setCol = (m: M34, c: number, v: V3) => {
  m[c] = v.x
  m[4 + c] = v.y
  m[8 + c] = v.z
}

/** ef_util MtxGetRotationMtx */
export function getRotationMtx(m: M34, out: M34) {
  const x = colv(m, 0, new V3())
  if (!x.isZero()) x.normalize()
  else x.x = 1
  const y = colv(m, 1, new V3())
  if (!y.isZero()) y.normalize()
  else y.y = 1
  const z = cross(new V3(), x, y)
  cross(y, z, x)
  setCol(out, 0, x)
  setCol(out, 1, y)
  setCol(out, 2, z)
  out[3] = out[7] = out[11] = 0
  return out
}

/** ef_util MtxGetRotation (XYZ euler) */
export function getRotation(m: M34, out: V3) {
  const sx = Math.sqrt(m[0] * m[0] + m[4] * m[4] + m[8] * m[8])
  const sy = Math.sqrt(m[1] * m[1] + m[5] * m[5] + m[9] * m[9])
  const sz = Math.sqrt(m[2] * m[2] + m[6] * m[6] + m[10] * m[10])
  const FLT_MIN = 1.175494e-38
  if (sx < FLT_MIN || sy < FLT_MIN || sz < FLT_MIN) return out.set(0, 0, 0)
  out.y = Math.asin(Math.max(-1, Math.min(1, -m[8] / sx)))
  if (Math.cos(out.y) >= FLT_MIN) {
    out.x = Math.atan2(m[9] / sy, m[10] / sz)
    out.z = Math.atan2(m[4], m[0])
  } else {
    out.x = Math.atan2(m[1], m[5])
    out.z = 0
  }
  return out
}

/** ef_util MtxGetScale (Gram-Schmidt) */
export function getScale(m: M34, out: V3) {
  const EPS = 1.1920929e-7
  const v0 = colv(m, 0, new V3())
  const v1 = new V3(), v2 = new V3(), v = new V3()
  let mag = v0.lenSq()
  if (mag > EPS) {
    mag = 1 / Math.sqrt(mag)
    out.x = 1 / mag
    v0.scale(mag)
    colv(m, 1, v1)
    const sh0 = dot(v0, v1)
    v1.sub(v.copy(v0).scale(sh0))
    mag = v1.lenSq()
    if (mag > EPS) {
      mag = 1 / Math.sqrt(mag)
      out.y = 1 / mag
      v1.scale(mag)
      colv(m, 2, v2)
      const sh2 = dot(v1, v2)
      v2.sub(v.copy(v1).scale(sh2))
      const sh1 = dot(v0, v2)
      v2.sub(v.copy(v0).scale(sh1))
      mag = v2.lenSq()
      if (mag > EPS) {
        out.z = Math.sqrt(mag)
        cross(v, v1, v2)
        if (dot(v0, v) < 0) {
          out.x = -out.x
          out.y = -out.y
          out.z = -out.z
        }
      } else out.z = 0
    } else {
      out.y = 0
      colv(m, 2, v2)
      const sh1 = dot(v0, v2)
      v2.sub(v.copy(v0).scale(sh1))
      mag = v2.lenSq()
      out.z = mag > EPS ? Math.sqrt(mag) : 0
    }
  } else {
    out.x = 0
    colv(m, 1, v1)
    mag = v1.lenSq()
    if (mag > EPS) {
      mag = 1 / Math.sqrt(mag)
      out.y = 1 / mag
      v1.scale(mag)
      colv(m, 2, v2)
      const sh2 = dot(v1, v2)
      v2.sub(v.copy(v1).scale(sh2))
      out.z = v2.len()
    } else {
      out.y = 0
      out.z = colv(m, 2, v2).len()
    }
  }
  return out
}

/** ef_util Rotation2VecY */
export function rotation2VecY(r: V3, out: V3) {
  const sx = Math.sin(r.x), cx = Math.cos(r.x)
  const sy = Math.sin(r.y), cy = Math.cos(r.y)
  const sz = Math.sin(r.z), cz = Math.cos(r.z)
  return out.set(sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy)
}

/** ef_util GetDirMtxY */
export function getDirMtxY(m: M34, v: V3) {
  const sx = v.z
  const cx = Math.sqrt(Math.max(0, 1 - sx * sx))
  let sz: number, cz: number
  if (cx > 1.1920929e-7) {
    cz = v.y / cx
    sz = v.x / -cx
  } else {
    sz = 0
    cz = 1
  }
  m[0] = cz
  m[1] = v.x
  m[2] = sx * sz
  m[3] = 0
  m[4] = sz
  m[5] = v.y
  m[6] = -cz * sx
  m[7] = 0
  m[8] = 0
  m[9] = v.z
  m[10] = cx
  m[11] = 0
  return m
}

/** Emitter::RestructMatrix */
export function restruct(out: M34, orig: M34, inheritS: boolean, inheritR: boolean, inheritT: number) {
  if (inheritS && inheritR && inheritT === 100) return copy(out, orig)
  ident(out)
  if (!inheritS && !inheritR && inheritT === 0) return out
  if (inheritT !== 0) {
    const f = inheritT / 100
    trans(out, out, orig[3] * f, orig[7] * f, orig[11] * f)
  }
  if (inheritR) {
    const rot = getRotationMtx(orig, m34())
    mult(out, out, rot)
  }
  if (inheritS) {
    const s = getScale(orig, new V3())
    scale(out, out, s.x, s.y, s.z)
  }
  return out
}

/** nw4r::ef::Random (MSVC LCG) */
export class Random {
  constructor(public seed = 0) {}
  srand(s: number) {
    this.seed = s >>> 0
  }
  private mix() {
    this.seed = (Math.imul(this.seed, 0x343fd) + 0x269ec3) >>> 0
  }
  rand() {
    this.mix()
    return this.seed >>> 16
  }
  randFloat() {
    this.mix()
    return (this.seed >>> 16) / 0x10000
  }
}

export const mixRandom = (r: number) => (Math.imul(r, 0x343fd) + 0x269ec3) >>> 0
