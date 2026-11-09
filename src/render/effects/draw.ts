// nw4r::ef draw strategies (drawstrategy/*.cpp) on the CPU: each particle becomes
// a quad (or a stripe segment) written into a Sink, which also evaluates what
// DrawStrategyImpl::SetupGP loads per particle (TEV colours, texture matrices,
// alpha-compare refs). Vertices come out in world space.

import * as M from './mtx'
import { V3, type M34, normalizeEps as nrm } from './mtx'
import type { Particle, ParticleManager } from './core'
import { LS_ACTIVE } from './core'
import { DF_DRAW_ORDER } from './res'

/** floats per vertex: pos 3, uv0 2, uv1 2, colours 4x4, extra 4 */
export const VERT_FLOATS = 27

export class Sink {
  data: Float32Array
  n = 0 // vertices
  space: M34 = M.m34()
  texture: (string | null)[] = [null, null]
  // per particle
  private col = new Uint8Array(16)
  private tm = [new Float64Array(6), new Float64Array(6)]
  private ext = [0, 0, 0, 0]
  private w = new V3()
  private vtx: number[] = []

  constructor(cap = 1024) {
    this.data = new Float32Array(cap * VERT_FLOATS)
  }
  reset() {
    this.n = 0
    this.texture = [null, null]
  }
  /** make room for n vertices in total (reallocates: the owner rebuilds its geometry) */
  reserve(n: number) {
    if (n * VERT_FLOATS <= this.data.length) return
    let cap = this.data.length / VERT_FLOATS
    while (cap < n) cap *= 2
    const d = new Float32Array(cap * VERT_FLOATS)
    d.set(this.data)
    this.data = d
  }
  private ensure(n: number) {
    this.reserve(this.n + n)
  }

  /** SetupGP: colours (Draw_GetColor), texture SRT + reverse/mirror matrices, alpha refs */
  particle(p: Particle) {
    p.drawColor(0, this.col, 0)
    p.drawColor(1, this.col, 8)
    for (let L = 0; L < 2; L++) {
      if (this.texture[L] === null) this.texture[L] = p.textures[L]
      const wS = (p.texWrap >> (L * 4)) & 3
      const wT = (p.texWrap >> (L * 4 + 2)) & 3
      const rev = (p.texReverse >> (L * 2)) & 3
      let scS = wS === 2 ? 2 : 1
      let scT = wT === 2 ? 2 : 1
      if (rev === 1 || rev === 3) scS = -scS
      if (rev === 2 || rev === 3) scT = -scT
      let trS = rev === 1 || rev === 3 ? 1 : 0
      let trT = rev === 2 || rev === 3 ? 1 : 0
      if (wS === 2) trS *= 2
      if (wT === 2) trT *= 2
      // mtx = Rev * T(.5) S T(-.5) * T(.5) R T(-.5) * T(trans), as 2x3 [a b c; d e f]
      let a = 1, b = 0, c = p.texTrans[L * 2], d = 0, e = 1, f = p.texTrans[L * 2 + 1]
      const r = p.texRot[L]
      if (r !== 0) {
        const cr = Math.cos(r), sr = Math.sin(r)
        c -= 0.5
        f -= 0.5
        const a2 = cr * a - sr * d, b2 = cr * b - sr * e, c2 = cr * c - sr * f
        const d2 = sr * a + cr * d, e2 = sr * b + cr * e, f2 = sr * c + cr * f
        a = a2; b = b2; c = c2 + 0.5; d = d2; e = e2; f = f2 + 0.5
      }
      const sx = p.texScale[L * 2], sy = p.texScale[L * 2 + 1]
      a *= sx; b *= sx; c = (c - 0.5) * sx + 0.5
      d *= sy; e *= sy; f = (f - 0.5) * sy + 0.5
      const m = this.tm[L]
      m[0] = scS * a; m[1] = scS * b; m[2] = scS * c + trS
      m[3] = scT * d; m[4] = scT * e; m[5] = scT * f + trT
      this.ext[2 + L] = wS + 4 * wT
    }
    this.ext[0] = p.acmp[0] / 255
    this.ext[1] = p.acmp[1] / 255
  }

  private emit(x: number, y: number, z: number, s: number, t: number) {
    const w = M.xform(this.w, this.space, this.w.set(x, y, z))
    const o = this.n * VERT_FLOATS
    const D = this.data
    D[o] = w.x
    D[o + 1] = w.y
    D[o + 2] = w.z
    const m0 = this.tm[0], m1 = this.tm[1]
    D[o + 3] = m0[0] * s + m0[1] * t + m0[2]
    D[o + 4] = m0[3] * s + m0[4] * t + m0[5]
    D[o + 5] = m1[0] * s + m1[1] * t + m1[2]
    D[o + 6] = m1[3] * s + m1[4] * t + m1[5]
    for (let i = 0; i < 16; i++) D[o + 7 + i] = this.col[i] / 255
    D[o + 23] = this.ext[0]
    D[o + 24] = this.ext[1]
    D[o + 25] = this.ext[2]
    D[o + 26] = this.ext[3]
    this.n++
  }

  /** GX quad p0..p3 with the strategies' u8 texcoord table (0,1) (0,0) (1,0) (1,1) */
  quad(p0: V3, p1: V3, p2: V3, p3: V3) {
    this.ensure(6)
    this.emit(p0.x, p0.y, p0.z, 0, 1)
    this.emit(p1.x, p1.y, p1.z, 0, 0)
    this.emit(p2.x, p2.y, p2.z, 1, 0)
    this.emit(p0.x, p0.y, p0.z, 0, 1)
    this.emit(p2.x, p2.y, p2.z, 1, 0)
    this.emit(p3.x, p3.y, p3.z, 1, 1)
  }

  /** triangle strip: begin, push vertices, end */
  stripBegin() {
    this.vtx.length = 0
  }
  stripVert(p: V3, s: number, t: number) {
    this.vtx.push(p.x, p.y, p.z, s, t)
  }
  stripEnd() {
    const v = this.vtx
    const n = v.length / 5
    if (n < 3) return
    this.ensure((n - 2) * 3)
    for (let i = 0; i + 2 < n; i++)
      for (const j of [i, i + 1, i + 2]) this.emit(v[j * 5], v[j * 5 + 1], v[j * 5 + 2], v[j * 5 + 3], v[j * 5 + 4])
  }
}

// ------------------------------------------------------------------ particle order

const active = (pm: ParticleManager) => pm.particles.filter((p) => p.status === LS_ACTIVE)
/** DRAWORDER_YOUNGERS_FIRST (flag clear) draws the youngest first; the flag draws elders first */
const drawList = (pm: ParticleManager) => {
  const l = active(pm)
  return pm.res.drawFlags & DF_DRAW_ORDER ? l : l.reverse()
}

// ------------------------------------------------------------------ ahead (direction) helpers

interface Ahead {
  pm: ParticleManager
  list: Particle[] // oldest -> youngest (active)
  emitterMtx: M34
  pmMtx: M34
  pmInv: M34
  emitterAxisY: V3
  emitterCenter: V3
  worldYAxis: V3
  emitterAxisX: V3
  screenAxisZ: V3
}

function aheadContext(pm: ParticleManager): Ahead {
  const emitterMtx = pm.em.calcGlobalMtx(M.m34())
  const pmMtx = pm.calcGlobalMtx(M.m34())
  const pmInv = M.m34()
  M.inv(pmInv, pmMtx)
  const axisY = M.xformN(new V3(), pmInv, new V3(emitterMtx[1], emitterMtx[5], emitterMtx[9]))
  if (!nrm(axisY)) axisY.set(0, 1, 0)
  const center = M.xform(new V3(), pmInv, new V3(emitterMtx[3], emitterMtx[7], emitterMtx[11]))
  const wy = new V3(pmInv[1], pmInv[5], pmInv[9])
  if (!nrm(wy)) wy.set(0, 1, 0)
  const ax = M.xformN(new V3(), pmInv, new V3(emitterMtx[0], emitterMtx[4], emitterMtx[8]))
  return { pm, list: active(pm), emitterMtx, pmMtx, pmInv, emitterAxisY: axisY, emitterCenter: center, worldYAxis: wy, emitterAxisX: ax, screenAxisZ: new V3(0, 0, 1) }
}

const elder = (c: Ahead, p: Particle) => {
  const i = c.list.indexOf(p)
  return i > 0 ? c.list[i - 1] : null
}
const younger = (c: Ahead, p: Particle) => {
  const i = c.list.indexOf(p)
  return i >= 0 && i + 1 < c.list.length ? c.list[i + 1] : null
}

type AheadFn = (out: V3, c: Ahead, p: Particle) => void

const aheadSpeed: AheadFn = (o, c, p) => {
  p.moveDir(o)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
const aheadCenter: AheadFn = (o, c, p) => {
  o.subVecs(p.pos, c.emitterCenter)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
const aheadDesign: AheadFn = (o, c) => {
  o.copy(c.emitterAxisY)
}
const aheadParticle: AheadFn = (o, c, p) => {
  const e = elder(c, p)
  if (e) o.subVecs(e.pos, p.pos)
  else o.subVecs(p.pos, c.emitterCenter)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
const aheadNoDesign: AheadFn = (o, c) => {
  o.copy(c.worldYAxis)
}
const aheadBoth: AheadFn = (o, c, p) => {
  const e = elder(c, p), y = younger(c, p)
  const ed = new V3(), yd = new V3()
  if (e) {
    ed.subVecs(e.pos, p.pos)
    if (!nrm(ed)) ed.set(0, 0, 0)
  }
  if (y) {
    yd.subVecs(y.pos, p.pos)
    if (!nrm(yd)) yd.set(0, 0, 0)
  }
  o.subVecs(ed, yd)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
// stripe variants
const aheadParticleStripe: AheadFn = (o, c, p) => {
  const y = younger(c, p)
  if (y) o.subVecs(p.pos, y.pos)
  else o.subVecs(p.pos, c.emitterCenter)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
const aheadBothRing: AheadFn = (o, c, p) => {
  const e = elder(c, p) ?? c.list[c.list.length - 1]
  const y = younger(c, p) ?? c.list[0]
  const ed = new V3().subVecs(e.pos, p.pos)
  if (!nrm(ed)) ed.set(0, 0, 0)
  const yd = new V3().subVecs(y.pos, p.pos)
  if (!nrm(yd)) yd.set(0, 0, 0)
  o.subVecs(ed, yd)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}
const aheadBothOrigin: AheadFn = (o, c, p) => {
  const e = elder(c, p), y = younger(c, p)
  const ed = new V3()
  if (e) {
    ed.subVecs(e.pos, p.pos)
    nrm(ed)
  }
  const yd = y ? new V3().subVecs(y.pos, p.pos) : new V3().subVecs(c.emitterCenter, p.pos)
  nrm(yd)
  o.subVecs(ed, yd)
  if (!nrm(o)) o.copy(c.emitterAxisY)
}

/** GetCalcAheadFunc of the billboard, directional and stripe strategies (three tables) */
function aheadFn(dir: number, kind: 'bb' | 'dir' | 'stripe', opt2: number): AheadFn {
  switch (dir) {
    case 0:
      return aheadSpeed
    case 1:
      return aheadCenter
    case 2:
      return aheadDesign
    case 3:
      return kind === 'stripe' ? aheadParticleStripe : aheadParticle
    case 4:
      return kind === 'bb' ? aheadBoth : aheadSpeed
    case 5:
      return kind === 'bb' ? aheadSpeed : aheadNoDesign
    case 6:
      if (kind === 'bb') return aheadSpeed
      if (kind === 'dir') return aheadBoth
      return (opt2 & 7) === 1 ? aheadBothRing : (opt2 & 7) === 2 ? aheadBothOrigin : aheadBoth
    default:
      return aheadSpeed
  }
}

// ------------------------------------------------------------------ strategies

const EPS = 1.1920929e-7
const tv = [new V3(), new V3(), new V3(), new V3()]

/** DrawBillboardStrategy (normal / Y / directional) */
function drawBillboard(pm: ParticleManager, view: M34, invView: M34, sink: Sink) {
  const r = pm.res
  const viewMtx = M.mult(M.m34(), view, pm.calcGlobalMtx(M.m34()))
  const vx = Math.sqrt(viewMtx[0] ** 2 + viewMtx[4] ** 2 + viewMtx[8] ** 2)
  const vy = Math.sqrt(viewMtx[1] ** 2 + viewMtx[5] ** 2 + viewMtx[9] ** 2)
  const px = r.pivotX / 100, py = r.pivotY / 100
  sink.space = invView
  const pos = new V3(), rot = new V3()
  const P = new V3(), D0 = new V3(), D1 = new V3()
  const emitQuad = () => {
    tv[0].copy(P).sub(D0)
    tv[1].copy(P).sub(D1)
    tv[2].copy(P).add(D0)
    tv[3].copy(P).add(D1)
    sink.quad(tv[0], tv[1], tv[2], tv[3])
  }
  const opt = r.typeOption
  let ctx: Ahead | null = null
  let ahead: AheadFn | null = null
  let rc = 1, rs = 0
  if (opt === 0) {
    const mag = Math.sqrt(view[1] * view[1] + view[5] * view[5])
    if (mag !== 0) {
      rs = -view[1] / mag
      rc = view[5] / mag
    }
  } else if (opt === 1) {
    const mag = Math.sqrt(view[5] * view[5] + view[9] * view[9])
    if (mag !== 0) {
      rc = view[9] / mag
      rs = view[5] / mag
    }
  } else if (opt === 2) {
    ctx = aheadContext(pm)
    ahead = aheadFn(r.typeDir, 'bb', r.typeOption2)
  }
  const axisY = new V3(), delta = new V3()
  for (const p of drawList(pm)) {
    const sx = p.drawSizeX()
    if (sx < EPS) continue
    const sy = p.drawSizeY()
    if (sy < EPS) continue
    sink.particle(p)
    M.xform(pos, viewMtx, p.pos)
    if (opt === 1) {
      // DispParticle_YBillboard
      p.drawRotate(rot)
      const vys = vy * rs, vyc = vy * rc
      if (rot.z !== 0) {
        const sr = Math.sin(-rot.z), cr = Math.cos(-rot.z)
        const crsx = cr * sx, srsx = sr * sx, crsy = cr * sy, srsy = sr * sy
        const e1 = -py - srsx * px + crsy * py
        const e0 = px - crsx * px - srsy * py
        P.set(pos.x + vx * e0, pos.y + vys * e1, pos.z + vyc * e1)
        D0.set(vx * (crsx - srsy), vys * (srsx + crsy), vyc * (srsx + crsy))
        D1.set(vx * (crsx + srsy), vys * (srsx - crsy), vyc * (srsx - crsy))
      } else {
        P.set(pos.x + vx * (px - px * sx), pos.y + vys * (py * sy - py), pos.z + vyc * (py * sy - py))
        D0.set(vx * sx, vys * sy, vyc * sy)
        D1.set(vx * sx, -vys * sy, -vyc * sy)
      }
      emitQuad()
      continue
    }
    let ratio = 1
    if (opt === 2) {
      ahead!(axisY, ctx!, p)
      M.xformN(axisY, viewMtx, axisY)
      const mag = Math.sqrt(axisY.x * axisY.x + axisY.y * axisY.y)
      if (mag === 0) {
        rs = 0
        rc = 1
      } else {
        rs = -axisY.x / mag
        rc = axisY.y / mag
      }
      if (r.typeOption0) ratio += (0.5 * p.moveDir(delta).len()) / sy
      // DispParticle_Directional
      const vxc = vx * rc, vxs = vx * rs, vyc = vy * rc, vys = vy * rs
      const e0 = px - sx * px
      const e1 = sy * (ratio + py - 1) - py
      P.set(pos.x + (vxc * e0 + vys * e1), pos.y + (vxs * e0 - vyc * e1), pos.z)
      const a = vxc * sx, b = ratio * (vys * sy), c = vxs * sx, d = ratio * (vyc * sy)
      D0.set(a - b, c + d, 0)
      D1.set(a + b, c - d, 0)
      emitQuad()
      continue
    }
    // DispParticle_Normal
    p.drawRotate(rot)
    const vxc = vx * rc, vxs = vx * rs, vyc = vy * rc, vys = vy * rs
    if (rot.z !== 0) {
      const sr = Math.sin(-rot.z), cr = Math.cos(-rot.z)
      const crsx = cr * sx, srsx = sr * sx, crsy = cr * sy, srsy = sr * sy
      const e0 = px - crsx * px - srsy * py
      const e1 = py + srsx * px - crsy * py
      P.set(vxc * e0 + vys * e1 + pos.x, vxs * e0 - vyc * e1 + pos.y, pos.z)
      D0.set(vxc * crsx - vxc * srsy - vys * srsx - vys * crsy, vxs * crsx - vxs * srsy + vyc * srsx + vyc * crsy, 0)
      D1.set(vxc * crsx + vxc * srsy - vys * srsx + vys * crsy, vxs * crsx + vxs * srsy + vyc * srsx - vyc * crsy, 0)
    } else {
      const e0 = px - sx * px
      const e1 = py - sy * py
      P.set(vxc * e0 + vys * e1 + pos.x, vxs * e0 - vyc * e1 + pos.y, pos.z)
      D0.set(vxc * sx - vys * sy, vxs * sx + vyc * sy, 0)
      D1.set(vxc * sx + vys * sy, vxs * sx - vyc * sy, 0)
    }
    emitQuad()
  }
}

/** DrawDirectionalStrategy CalcRotate */
function calcRotate(p: Particle, axis: number) {
  const rot = p.drawRotate(new V3())
  const m = M.m34()
  switch (axis) {
    case 0: {
      const s = Math.sin(-rot.x), c = Math.cos(-rot.x)
      m.set([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0])
      return m
    }
    case 1: {
      const s = Math.sin(-rot.y), c = Math.cos(-rot.y)
      m.set([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0])
      return m
    }
    case 2: {
      const s = Math.sin(-rot.z), c = Math.cos(-rot.z)
      m.set([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0])
      return m
    }
    default: {
      const sX = Math.sin(-rot.x), cX = Math.cos(-rot.x)
      const sY = Math.sin(-rot.y), cY = Math.cos(-rot.y)
      const sZ = Math.sin(-rot.z), cZ = Math.cos(-rot.z)
      const sxsy = sX * sY, cxsy = cX * sY
      m.set([cY * cZ, sxsy * cZ - cX * sZ, cxsy * cZ + sX * sZ, 0, cY * sZ, sxsy * sZ + cX * cZ, cxsy * sZ - sX * cZ, 0, -sY, cY * sX, cX * cY, 0])
      return m
    }
  }
}

/** DrawDirectionalStrategy CalcLocalTransform */
function calcLocal(axis: number, pivX: number, pivY: number, sx: number, sy: number, ratio: number, R: M34) {
  const m = M.m34()
  if (axis === 0) {
    const x = sx * pivX, syr = sy * ratio, y = sy * (pivY + ratio - 1)
    m.set([R[0] * sx, R[1] * syr, R[2] * sx, pivX + (-R[0] * x - R[1] * y), R[4] * sx, R[5] * syr, R[6] * sx, pivY + (-R[4] * x - R[5] * y), R[8] * sx, R[9] * syr, R[10] * sx, -R[8] * x - R[9] * y])
  } else {
    const x = sx * pivX, y = sy * pivY
    m.set([R[0] * sx, R[2] * sy, R[1] * sx, pivX + (-R[0] * x - R[2] * y), R[4] * sx, R[6] * sy, R[5] * sx, -R[4] * x - R[6] * y, R[8] * sx, R[10] * sy, R[9] * sx, -R[8] * x - R[10] * y - pivY])
  }
  return m
}

const QP = [new V3(-1, -1, 0), new V3(-1, 1, 0), new V3(1, 1, 0), new V3(1, -1, 0)]
const QX = [new V3(0, -1, 1), new V3(0, 1, 1), new V3(0, 1, -1), new V3(0, -1, -1)]
function quadMtx(sink: Sink, m: M34, q: V3[]) {
  sink.quad(M.xform(tv[0], m, q[0]), M.xform(tv[1], m, q[1]), M.xform(tv[2], m, q[2]), M.xform(tv[3], m, q[3]))
}

/** DrawDirectionalStrategy */
function drawDirectional(pm: ParticleManager, view: M34, invView: M34, sink: Sink) {
  const r = pm.res
  const ctx = aheadContext(pm)
  const ahead = aheadFn(r.typeDir, 'dir', r.typeOption2)
  const glb = ctx.pmMtx
  const pivX = r.pivotX / 100, pivY = r.pivotY / 100
  const delta = new V3()
  if ((r.typeOption2 & 3) !== 1) {
    // DrawDirectional (particle-manager space)
    const em = M.mult(M.m34(), ctx.pmInv, ctx.emitterMtx)
    const emAxisY = new V3(em[1], em[5], em[9])
    const emAxisZ = new V3(em[2], em[6], em[10])
    nrm(emAxisZ)
    for (let i = ctx.list.length - 1; i >= 0 && ctx.list[i].prevAxis.x > 1; i--) ctx.list[i].prevAxis.copy(emAxisY)
    sink.space = glb
    const axX = new V3(), axY = new V3(), axZ = new V3()
    for (const p of drawList(pm)) {
      const sx = p.drawSizeX()
      if (sx < EPS) continue
      const sy = p.drawSizeY()
      if (sy < EPS) continue
      let ratio = 1
      if (r.typeOption0) ratio += (0.5 * p.moveDir(delta).len()) / sy
      sink.particle(p)
      const local = calcLocal(r.typeOption1, pivX, pivY, sx, sy, ratio, calcRotate(p, r.typeAxis))
      ahead(axY, ctx, p)
      M.cross(axZ, p.prevAxis, axY)
      if (!nrm(axZ)) axZ.copy(emAxisZ)
      M.cross(axX, axY, axZ)
      p.prevAxis.copy(axX)
      const base = M.m34()
      base.set([axX.x, axY.x, axZ.x, p.pos.x, axX.y, axY.y, axZ.y, p.pos.y, axX.z, axY.z, axZ.z, p.pos.z])
      const world = M.mult(M.m34(), base, local)
      quadMtx(sink, world, QP)
      if (r.typeOption === 1) quadMtx(sink, world, QX)
    }
    return
  }
  // DrawDirectionalBillboard (view space)
  const viewMtx = M.mult(M.m34(), view, glb)
  const lx = Math.sqrt(viewMtx[0] ** 2 + viewMtx[4] ** 2 + viewMtx[8] ** 2)
  const ly = Math.sqrt(viewMtx[1] ** 2 + viewMtx[5] ** 2 + viewMtx[9] ** 2)
  const lz = Math.sqrt(viewMtx[2] ** 2 + viewMtx[6] ** 2 + viewMtx[10] ** 2)
  for (let i = ctx.list.length - 1; i >= 0 && ctx.list[i].prevAxis.x > 1; i--) ctx.list[i].prevAxis.set(0, 0, 0)
  sink.space = invView
  const axX = new V3(), axY = new V3(), axZ = new V3(), ah = new V3(), pos = new V3()
  for (const p of drawList(pm)) {
    const sx = p.drawSizeX()
    if (sx < EPS) continue
    const sy = p.drawSizeY()
    if (sy < EPS) continue
    let ratio = 1
    if (r.typeOption0) ratio += (0.5 * p.moveDir(delta).len()) / sy
    sink.particle(p)
    const local = calcLocal(r.typeOption1, pivX, pivY, sx, sy, ratio, calcRotate(p, r.typeAxis))
    ahead(ah, ctx, p)
    M.xformN(ah, viewMtx, ah)
    axY.copy(ah)
    nrm(axY)
    axX.set(ah.y, -ah.x, 0)
    if (nrm(axX)) axZ.set(-ah.x * ah.z, -ah.y * ah.z, ah.x * ah.x + ah.y * ah.y)
    else {
      M.cross(axX, ah, p.prevAxis)
      if (!nrm(axX)) axX.set(1, 0, 0)
      M.cross(axZ, axX, ah)
    }
    nrm(axZ)
    p.prevAxis.copy(axZ)
    M.xform(pos, viewMtx, p.pos)
    const base = M.m34()
    base.set([lx * axX.x, ly * axY.x, lz * axZ.x, pos.x, lx * axX.y, ly * axY.y, lz * axZ.y, pos.y, lx * axX.z, ly * axY.z, lz * axZ.z, pos.z])
    const w = M.mult(M.m34(), base, local)
    const C = new V3(w[3], w[7], w[11])
    const d1 = new V3(w[0] + w[1], w[4] + w[5], w[8] + w[9])
    const d2 = new V3(w[0] - w[1], w[4] - w[5], w[8] - w[9])
    sink.quad(C.clone().sub(d1), C.clone().sub(d2), C.clone().add(d1), C.clone().add(d2))
    if (r.typeOption === 1) {
      const e1 = new V3(w[1] + w[2], w[5] + w[6], w[9] + w[10])
      const e2 = new V3(w[1] - w[2], w[5] - w[6], w[9] - w[10])
      sink.quad(C.clone().sub(e1), C.clone().sub(e2), C.clone().add(e1), C.clone().add(e2))
    }
  }
}

/** DrawFreeStrategy */
function drawFree(pm: ParticleManager, sink: Sink) {
  const r = pm.res
  sink.space = pm.calcGlobalMtx(M.m34())
  const px = r.pivotX / 100, py = r.pivotY / 100
  const rot = new V3()
  for (const p of drawList(pm)) {
    const sx = p.drawSizeX()
    if (sx < EPS) continue
    const sy = p.drawSizeY()
    if (sy < EPS) continue
    sink.particle(p)
    p.drawRotate(rot)
    const R = M.rotXYZ(M.m34(), rot.x, rot.y, rot.z)
    const sxpx = sx * px, sypy = sy * py
    const L = M.m34()
    L.set([
      R[0] * sx, R[1] * sy, R[2] * sx, -R[0] * sxpx - R[1] * sypy + px + p.pos.x,
      R[4] * sx, R[5] * sy, R[6] * sx, -R[4] * sxpx - R[5] * sypy + py + p.pos.y,
      R[8] * sx, R[9] * sy, R[10] * sx, -R[8] * sxpx - R[9] * sypy + p.pos.z,
    ])
    quadMtx(sink, L, QP)
    if (r.typeOption === 1) quadMtx(sink, L, QX)
  }
}

/** DrawStripeStrategy (normal / cross; tubes are not used by basic_tank) */
function drawStripe(pm: ParticleManager, view: M34, sink: Sink) {
  const r = pm.res
  const ctx = aheadContext(pm)
  const num = ctx.list.length
  if (num === 0) return
  // GetInitialPrevAxis
  const init = new V3()
  switch (r.typeOption2 & 0x38) {
    case 0x08:
      M.xformN(init, ctx.pmInv, M.xformN(init, ctx.emitterMtx, new V3(1, 0, 0)))
      break
    case 0x10:
      M.xformN(init, ctx.pmInv, M.xformN(init, ctx.emitterMtx, new V3(0, 0, 1)))
      break
    case 0x18:
      M.xformN(init, ctx.pmInv, M.xformN(init, ctx.emitterMtx, new V3(1, 1, 1)))
      break
    default:
      init.copy(ctx.emitterAxisY)
  }
  if ((r.typeOption2 & 0x38) !== 0 && !nrm(init)) init.copy(ctx.emitterAxisY)
  for (let i = num - 1; i >= 0; i--) {
    if (ctx.list[i].prevAxis.x <= 1) break
    ctx.list[i].prevAxis.copy(init)
  }
  const drawOrder = r.drawFlags & DF_DRAW_ORDER
  const billboard = r.typeOption === 2
  const connect = r.typeOption2 & 7
  const ahead = aheadFn(r.typeDir, 'stripe', r.typeOption2)
  const order = drawList(pm)
  const axisMtx = (p: Particle, axisY: V3, pos: V3) => {
    const axX = M.cross(new V3(), axisY, billboard ? ctx.screenAxisZ : p.prevAxis)
    if (!nrm(axX)) axX.copy(ctx.emitterAxisX)
    const axZ = M.cross(new V3(), axX, axisY)
    nrm(axZ)
    p.prevAxis.copy(axZ)
    const m = M.m34()
    m.set([axX.x, axisY.x, axZ.x, pos.x, axX.y, axisY.y, axZ.y, pos.y, axX.z, axisY.z, axZ.z, pos.z])
    return m
  }
  if ((connect === 1 && num < 3) || (connect === 0 && num < 2)) {
    const a = new V3()
    for (const p of order) {
      ahead(a, ctx, p)
      axisMtx(p, a, p.pos)
    }
    return
  }
  sink.space = ctx.pmMtx
  if (billboard) {
    const pv = M.mult(M.m34(), view, ctx.pmMtx)
    const iv = M.m34()
    if (M.inv(iv, pv)) ctx.screenAxisZ.set(iv[2], iv[6], iv[10])
  }
  // SetupGP once, with the first particle in draw order
  sink.particle(order[0])
  const pivot = 0.01 * r.pivotX
  const drawOne = (P0: V3, P1: V3) => {
    let n = num
    const ring = connect === 1, toEmitter = connect === 2
    if (ring || toEmitter) n++
    const texStep = (r.typeOption2 & 0xc0) === 0x40 ? 1 : 1 / (n - 1)
    let index = drawOrder === 0 ? 0 : n - 1
    const step = drawOrder === 0 ? 1 : -1
    sink.stripBegin()
    const one = (p: Particle | null, pos: V3, tc: number) => {
      const pp = p ?? ctx.list[ctx.list.length - 1]
      const a = new V3()
      ahead(a, ctx, pp)
      const am = axisMtx(pp, a, pos)
      const rot = pp.drawRotate(new V3())
      const sx = pp.drawSizeX()
      const c = sx * Math.cos(rot.y), s = sx * Math.sin(rot.y)
      const rm = M.m34()
      rm.set([c, 0, -s, pivot - c * pivot, 0, 1, 0, 0, s, 0, c, -s * pivot])
      const m = M.mult(M.m34(), am, rm)
      sink.stripVert(M.xform(new V3(), m, P0), 1, tc)
      sink.stripVert(M.xform(new V3(), m, P1), 0, tc)
    }
    if (toEmitter && drawOrder === 0) {
      one(null, ctx.emitterCenter, texStep * index)
      index += step
    }
    for (const p of order) {
      one(p, p.pos, texStep * index)
      index += step
    }
    if (ring) one(order[0], order[0].pos, texStep * index)
    if (toEmitter && drawOrder !== 0) one(null, ctx.emitterCenter, texStep * index)
    sink.stripEnd()
  }
  if (r.typeOption === 3) return // ASSIST_ST_TUBE
  drawOne(new V3(1, 0, 0), new V3(-1, 0, 0))
  if (r.typeOption === 1) drawOne(new V3(0, 0, -1), new V3(0, 0, 1))
}

/** ParticleManager::Draw through its strategy */
export function drawPM(pm: ParticleManager, view: M34, invView: M34, sink: Sink) {
  pm.sweep()
  if (pm.particles.length === 0) return
  switch (pm.res.ptype) {
    case 'directional':
      return drawDirectional(pm, view, invView, sink)
    case 'free':
      return drawFree(pm, sink)
    case 'stripe':
    case 'smooth_stripe':
      return drawStripe(pm, view, sink)
    default:
      // billboard (point / line strategies are not used by basic_tank)
      return drawBillboard(pm, view, invView, sink)
  }
}
