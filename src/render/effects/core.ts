// nw4r::ef runtime: Effect -> Emitter -> ParticleManager -> Particle, ported from
// ef_effect.cpp, ef_emitter.cpp, ef_particlemanager.cpp, ef_particle.cpp,
// ef_emitterform.cpp, emform/*.cpp and the texture / child curves of ef_animcurve.cpp.
// Update order, matrix spaces, random streams and lifetimes follow the original.

import { calcFrameStep, calcRandomSeed, executeF32, executeRotate, executeU8, searchKeyStep, stepResult } from './anim'
import * as M from './mtx'
import { V3, type M34 } from './mtx'
import {
  CMN_DISABLE_CALC,
  CMN_EMIT_INHERIT_ROT,
  CMN_EMIT_INHERIT_SCALE,
  CMN_INHERIT_PTCL_ROT,
  CMN_INHERIT_PTCL_SCALE,
  CMN_MAX_LIFE,
  CMN_SYNC_LIFE,
  EMIT_BIASED,
  EMIT_BILLBOARD,
  EMIT_BILLBOARD_X,
  EMIT_CENTERED_LINE,
  EMIT_EQUAL_DIV,
  EMIT_FIXED_ANGLE,
  EMIT_XYZ_SAME_SIZE,
  FORM_CUBE,
  FORM_DISC,
  FORM_LINE,
  FORM_POINT,
  FORM_SPHERE,
  INHERIT_FOLLOW_EMIT,
  INHERIT_ROT,
  PROC_STOP,
  PROC_TIMING,
  zeroSetting,
  type EmitterRes,
  type InheritSetting,
  type Track,
} from './res'

export const LS_CLOSED = 0
export const LS_ACTIVE = 1
export const LS_WAIT = 2
export const ES_WAIT = 0
export const ES_DONE = 1
export const ES_SKIP = 3

const PI = Math.PI
const FLT_EPSILON = 1.1920929e-7
const FLT_MIN = 1.175494e-38
const ANGLE_MIN = 1.917476e-4
const ANGLE_MAX = 2 * 3.1414969

/** u8 offsets of the colour curve targets (mColor[layer][pri/sec].r / .a) */
const U8_TARGET = [0, 3, 4, 7, 8, 11, 12, 15]

// ------------------------------------------------------------------ Particle

export class Particle {
  pm!: ParticleManager
  status = LS_ACTIVE
  eval = ES_WAIT
  calcRemain = 0
  tick = 0
  randSeed = 0
  life = 1
  color = new Uint8Array(16)
  acmp = new Uint8Array(2)
  size = new Float64Array(2)
  scale = new Float64Array(2)
  rotate = new Float64Array(3)
  texScale = new Float64Array(6)
  texRot = new Float64Array(3)
  texTrans = new Float64Array(6)
  textures: (string | null)[] = [null, null, null]
  texWrap = 0
  texReverse = 0
  alphaFlickRnd = 0
  vel = new V3()
  pos = new V3()
  prevPos = new V3()
  momentum = 1
  prevAxis = new V3(2, 0, 0)

  initialize(life: number, pos: V3, vel: V3, pm: ParticleManager, space: M34 | null, momentum: number, setting: InheritSetting | null, ref: Particle | null) {
    if (life === 0) life = 1
    this.pm = pm
    this.eval = ES_WAIT
    this.calcRemain = 0
    const r = pm.res
    // ParticleParameter::Initialize (v5 has no rotate offsets)
    this.color.set(r.colors)
    this.size[0] = r.size[0]
    this.size[1] = r.size[1]
    this.scale[0] = r.pscale[0]
    this.scale[1] = r.pscale[1]
    this.rotate.set(r.prot)
    this.texScale.set(r.texScale)
    this.texRot.set(r.texRot)
    this.texTrans.set(r.texTrans)
    this.textures = [...r.textures]
    this.texWrap = r.texWrap
    this.texReverse = r.texReverse
    this.acmp[0] = r.acmpRef0
    this.acmp[1] = r.acmpRef1
    this.momentum = momentum
    this.tick = 0
    const rnd = pm.em.random
    this.randSeed = rnd.rand() & 0xffff
    this.life = life
    this.alphaFlickRnd = (rnd.rand() % 254) - 127
    this.pos.copy(pos)
    this.prevPos.copy(pos)
    this.vel.copy(vel)
    const ev = pm.em.effect.velocity
    if (!ev.isZero()) {
      const g = pm.em.calcGlobalMtx(M.m34())
      M.inv(g, g)
      M.noTrans(g, g)
      this.vel.add(M.xform(new V3(), g, ev))
    }
    if (space) {
      M.xform(this.pos, space, this.pos)
      const sp = M.noTrans(M.m34(), space)
      M.xform(this.vel, sp, this.vel)
    }
    this.prevAxis.set(2, 0, 0)
    if (ref && setting) {
      if (setting.speed !== 0) {
        const g = M.noTrans(M.m34(), ref.pm.calcGlobalMtx(M.m34()))
        const gs = M.xform(new V3(), g, ref.vel)
        const l = M.noTrans(M.m34(), pm.calcGlobalMtx(M.m34()))
        M.inv(l, l)
        M.xform(gs, l, gs)
        this.vel.x += gs.x * setting.speed * 0.01
        this.vel.y += gs.y * setting.speed * 0.01
        this.vel.z += gs.z * setting.speed * 0.01
      }
      if (setting.scale !== 0) {
        this.size[0] = setting.scale * ref.drawSizeX() * 0.01
        this.size[1] = setting.scale * ref.drawSizeY() * 0.01
      }
      if (setting.alpha !== 0) for (let i = 0; i < 4; i++) this.color[i * 4 + 3] = Math.floor((setting.alpha * ref.color[i * 4 + 3]) / 100)
      if (setting.color !== 0)
        for (let i = 0; i < 4; i++)
          for (let c = 0; c < 3; c++) this.color[i * 4 + c] = Math.floor((setting.color * ref.color[i * 4 + c]) / 100)
      // FLAG_INHERIT_ROT feeds the rotate offsets, which v5 particles do not have
    }
  }

  drawSizeX() {
    return this.size[0] * this.scale[0] * this.pm.modScale[0]
  }
  drawSizeY() {
    // no emitter in basic_tank sets FLAG_XY_SAME_SIZE / SAME_SCALE, but follow Draw_GetSizeY
    const f = this.pm.res.drawFlags & 0x6000
    let sy: number
    if (f === 0x4000) sy = this.size[1] * this.scale[0]
    else if (f === 0x2000) sy = this.size[0] * this.scale[1]
    else if (f === 0x6000) sy = this.size[0] * this.scale[0]
    else sy = this.size[1] * this.scale[1]
    return sy * this.pm.modScale[1]
  }
  drawRotate(out: V3) {
    const m = this.pm.modRot
    return out.set(this.rotate[0] + m[0], this.rotate[1] + m[1], this.rotate[2] + m[2])
  }
  moveDir(out: V3) {
    return out.subVecs(this.pos, this.prevPos)
  }
  addPosition(d: V3) {
    this.pos.x += d.x * this.momentum
    this.pos.y += d.y * this.momentum
    this.pos.z += d.z * this.momentum
  }

  /** Particle::Draw_GetColor: layer colours after alpha flicker and the PM colour modifier */
  drawColor(layer: number, out: Uint8Array, off: number) {
    out.set(this.color.subarray(layer * 8, layer * 8 + 8), off)
    const f = this.pm.res.flick
    if (f.type !== 0) {
      let cycle = f.cycle + Math.trunc((f.cycle * this.alphaFlickRnd * f.random) / 12700)
      cycle = Math.min(0xffff, cycle >>> 0) || 1
      const pos = (((this.tick - 1) % cycle) + cycle) % cycle
      const amp = f.amplitude
      let alpha = 0
      switch (f.type) {
        case 1:
          alpha = pos * 2 <= cycle ? 128 - amp + Math.trunc((amp * (pos * 4)) / cycle) : 128 + amp * 3 - Math.trunc((amp * pos * 4) / cycle)
          break
        case 2:
          alpha = 128 + amp - Math.trunc((amp * pos * 2) / cycle)
          break
        case 3:
          alpha = 128 - amp + Math.trunc((amp * (pos * 2)) / cycle)
          break
        case 4:
          alpha = pos * 2 <= cycle ? 128 + amp : 128 - amp
          break
        case 5:
          alpha = Math.trunc(128 + amp * Math.sin((2 * PI * pos) / cycle))
          break
      }
      alpha = Math.max(0, Math.min(255, alpha))
      out[off + 3] = (out[off + 3] * alpha + 128) >> 8
      out[off + 7] = (out[off + 7] * alpha + 128) >> 8
    }
    const pm = this.pm
    if (pm.lightType === 1) {
      const a = pm.ambient
      for (let i = 0; i < 8; i++) out[off + i] = (out[off + i] * a[i & 3] + 128) >> 8
    }
  }
}

// ------------------------------------------------------------------ ParticleManager

export class ParticleManager {
  status = LS_ACTIVE
  particles: Particle[] = []
  flag = 0 // 1 inherit scale, 2 inherit rotation
  inheritT = 100
  weight = 128
  modScale = [1, 1]
  modRot = [0, 0, 0]
  lightType = 0
  ambient = [255, 255, 255, 255]
  private compact = false

  constructor(
    public em: Emitter,
    public res: EmitterRes,
  ) {}

  calcGlobalMtx(out: M34) {
    const orig = this.em.calcGlobalMtx(M.m34())
    return M.restruct(out, orig, !!(this.flag & 1), !!(this.flag & 2), this.inheritT)
  }

  createParticle(life: number, pos: V3, vel: V3, space: M34 | null, momentum: number, setting: InheritSetting | null, ref: Particle | null, calcRemain: number) {
    const p = new Particle()
    p.initialize(life, pos, vel, this, space, momentum, setting, ref)
    p.calcRemain += calcRemain
    p.status = LS_ACTIVE
    this.particles.push(p)
    return p
  }

  retireParticle(p: Particle) {
    if (p.status !== LS_ACTIVE) return 0
    p.status = LS_WAIT
    this.compact = true
    return 1
  }
  retireParticleAll() {
    let n = 0
    for (const p of this.particles) n += this.retireParticle(p)
    return n
  }
  sweep() {
    if (!this.compact) return
    this.compact = false
    this.particles = this.particles.filter((p) => p.status === LS_ACTIVE)
  }

  beginCalc(onlyIfRemain: boolean) {
    for (const p of this.particles) {
      if (!onlyIfRemain || p.calcRemain !== 0) {
        if (p.calcRemain !== 0) p.calcRemain--
        if (p.status === LS_ACTIVE && p.eval === ES_DONE) p.eval = ES_WAIT
      }
    }
  }
  endCalc() {
    for (const p of this.particles) if (p.status === LS_ACTIVE && p.eval === ES_SKIP) p.eval = ES_DONE
  }

  /** ParticleManager::Calc */
  calc() {
    const list = this.particles
    if (list.length === 0) return
    const sys = this.em.effect.sys
    const locToGlb = this.calcGlobalMtx(M.m34())
    const glbToLoc = M.m34()
    M.inv(glbToLoc, locToGlb)
    const emToGlb = this.em.calcGlobalMtx(M.m34())
    const emToLoc = M.mult(M.m34(), glbToLoc, emToGlb)
    const locToEm = M.m34()
    M.inv(locToEm, emToLoc)
    const glbToLocNT = M.noTrans(M.m34(), glbToLoc)
    const locToEmNT = M.noTrans(M.m34(), locToEm)
    const emToLocNT = M.noTrans(M.m34(), emToLoc)
    const prevPos = new V3(), prevVel = new V3(), prevDir = new V3()
    const addVel = new V3(), addPos = new V3(), v = new V3(), pos = new V3()
    const tracks = this.res.ptclTracks
    const nInit = this.res.numPtclInit
    const n = list.length
    for (let li = 0; li < n; li++) {
      const p = list[li]
      if (p.status !== LS_ACTIVE || p.eval !== ES_WAIT) continue
      p.eval = ES_DONE
      if (p.calcRemain !== 0) this.em.effect.existCalcRemain = true
      prevPos.copy(p.pos)
      prevVel.copy(p.vel)
      p.moveDir(prevDir)
      p.prevPos.copy(p.pos)
      if (p.life <= p.tick) {
        this.retireParticle(p)
        continue
      }
      addVel.set(0, 0, 0)
      addPos.set(0, 0, 0)
      for (let i = p.tick === 0 ? 0 : nInit; i < tracks.length; i++) {
        const t = tracks[i]
        if (t.proc & PROC_STOP) continue
        if (p.tick !== 0 && t.frameLength <= 1 && t.kind < 26) continue
        let tick: number, life: number, seed: number
        if (t.proc & PROC_TIMING) {
          const em = this.em
          tick = em.tick
          life = em.comFlags & CMN_MAX_LIFE ? 0xffffffff : em.emitSpan
          seed = em.randSeed & 0xffff
        } else {
          tick = p.tick
          life = p.life
          seed = p.randSeed
        }
        switch (t.ctype) {
          case 'u8':
            if (t.kind < 8) executeU8(t, p.color, U8_TARGET[t.kind], tick, seed, life)
            else if (t.kind < 10) executeU8(t, p.acmp, t.kind - 8, tick, seed, life)
            break
          case 'f32':
            this.execF32(t, p, tick, seed, life, prevVel, prevDir, prevPos, addVel, addPos, v, pos, {
              locToGlb,
              emToGlb,
              locToEm,
              glbToLocNT,
              locToEmNT,
              emToLocNT,
            })
            break
          case 'rotate':
            if (t.kind === 12) executeRotate(t, p.rotate, tick, seed, life)
            break
          case 'texture':
            executeTexture(t, p, tick, seed, life)
            break
          case 'child':
            executeChild(t, p, tick, seed, life, sys)
            break
        }
      }
      p.tick++
      p.vel.add(addVel)
      p.addPosition(addPos)
      p.addPosition(p.vel)
    }
    this.sweep()
  }

  private execF32(
    t: Track,
    p: Particle,
    tick: number,
    seed: number,
    life: number,
    prevVel: V3,
    prevDir: V3,
    prevPos: V3,
    addVel: V3,
    addPos: V3,
    v: V3,
    pos: V3,
    m: { locToGlb: M34; emToGlb: M34; locToEm: M34; glbToLocNT: M34; locToEmNT: M34; emToLocNT: M34 },
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = (t.field ?? {}) as Record<string, any>
    const spaceEm = f.space === 'emitter'
    const type = f.type ?? (f.apply === 'position' ? 1 : 0)
    const apply = () => {
      if (type === 0) addVel.add(v)
      else if (type === 1) addPos.add(v)
    }
    // position of the particle relative to the field origin (emitter or world space)
    const fieldPos = () => {
      if (spaceEm) M.xform(pos, m.locToEm, prevPos)
      else {
        M.xform(pos, m.locToGlb, prevPos)
        pos.sub(M.xform(new V3(), m.emToGlb, new V3()))
      }
      return pos
    }
    const toLocal = () => M.xformN(v, spaceEm ? m.emToLocNT : m.glbToLocNT, v)
    switch (t.kind) {
      case 10:
        executeF32(t, p.size, 0, tick, seed, life)
        break
      case 11:
        executeF32(t, p.scale, 0, tick, seed, life)
        break
      case 17:
      case 20:
      case 23:
        executeF32(t, p.texScale, ((t.kind - 17) / 3) * 2, tick, seed, life)
        break
      case 18:
      case 21:
      case 24:
        executeF32(t, p.texRot, (t.kind - 18) / 3, tick, seed, life)
        break
      case 19:
      case 22:
      case 25:
        executeF32(t, p.texTrans, ((t.kind - 19) / 3) * 2, tick, seed, life)
        break
      case 33: {
        // field speed
        const s = [f.base_speed ?? 1]
        executeF32(t, s, 0, tick, seed, life)
        addVel.add(v.copy(prevVel).scale(s[0] - 1))
        break
      }
      case 32: {
        // field gravity
        const pw = [f.power ?? 0]
        executeF32(t, pw, 0, tick, seed, life)
        const d = f.dir ?? [0, 0, 0]
        v.set(d[0] * pw[0], d[1] * pw[0], d[2] * pw[0])
        M.xformN(v, spaceEm ? m.emToLocNT : m.glbToLocNT, v)
        apply()
        break
      }
      case 38: {
        // field spin: (speed, axis rotation)
        const ar = f.axis_rot ?? [0, 0, 0]
        const prm = [f.speed ?? 0, ar[0], ar[1], ar[2]]
        executeF32(t, prm, 0, tick, seed, life)
        const axis = M.rotation2VecY(new V3(prm[1], prm[2], prm[3]), new V3())
        const rot = M.rotAxis(M.m34(), axis, prm[0])
        fieldPos()
        M.xform(v, rot, pos).sub(pos)
        toLocal()
        apply()
        break
      }
      case 34: {
        // field magnet
        const prm = [f.power ?? 0]
        executeF32(t, prm, 0, tick, seed, life)
        fieldPos()
        const fp = f.pos ?? [0, 0, 0]
        v.set(fp[0] - pos.x, fp[1] - pos.y, fp[2] - pos.z)
        if (!v.isZero()) v.normalize()
        v.scale(prm[0])
        toLocal()
        apply()
        break
      }
      case 35: {
        // field newton
        const prm = [f.power ?? 0]
        executeF32(t, prm, 0, tick, seed, life)
        fieldPos()
        const fp = f.pos ?? [0, 0, 0]
        v.set(fp[0] - pos.x, fp[1] - pos.y, fp[2] - pos.z)
        const lenSq = v.lenSq()
        if (!v.isZero()) v.normalize()
        v.scale(prm[0])
        const rangeSq = (f.range ?? 0) * (f.range ?? 0)
        if (lenSq > rangeSq) v.scale(rangeSq / lenSq)
        toLocal()
        apply()
        break
      }
      case 36: {
        // field vortex
        const prm = [f.inner_speed ?? 0]
        executeF32(t, prm, 0, tick, seed, life)
        const ar = f.axis_rot ?? [0, 0, 0]
        const axis = M.rotation2VecY(new V3(ar[0], ar[1], ar[2]), new V3())
        fieldPos()
        const radius = (f.radius ?? 0) * (f.radius ?? 0)
        const dist = pos.clone().sub(axis.clone().scale(M.dot(axis, pos)))
        const distSq = dist.lenSq()
        if (distSq === 0) break
        let speed: number
        if (distSq >= radius) speed = f.outer_speed ?? 0
        else {
          const r = distSq / radius
          speed = (1 - r) * prm[0] + r * (f.outer_speed ?? 0)
        }
        dist.normalize()
        M.cross(v, dist, axis).scale(speed)
        toLocal()
        apply()
        break
      }
      case 39: {
        // field random
        // like CalcRandomSeed with the tick in place of the range index and no loop term
        const rs = fieldRandomSeed(seed, t.randomSeed, tick)
        const interval = (f.interval ?? 0) + 1
        if (!(t.proc & PROC_TIMING)) {
          if (tick === 0 || tick % interval !== 0) break
        } else if (p.tick !== 0 && tick % interval !== 0) break
        const pw = [f.power ?? 0]
        executeF32(t, pw, 0, tick, seed, life)
        const power = pw[0]
        if ((f.flags ?? 0) & 2) {
          const r0 = rs
          const r1 = M.mixRandom(r0)
          const r2 = M.mixRandom(r1)
          v.set((((r0 >>> 16) << 16) >> 16) / 32768 * power, (((r1 >>> 16) << 16) >> 16) / 32768 * power, (((r2 >>> 16) << 16) >> 16) / 32768 * power)
        } else {
          const dir = p.tick === 0 ? prevVel.clone() : prevDir.clone()
          M.xformN(dir, m.locToEmNT, dir)
          if (dir.lenSq() < FLT_MIN) dir.y = 1
          else dir.normalize()
          const md = M.getDirMtxY(M.m34(), dir)
          const diffuse = f.diffuse ?? 0
          if (diffuse !== 0) {
            const r0 = rs
            const theta = ((r0 >>> 16) / 65535) * diffuse
            const r1 = M.mixRandom(r0)
            const phi = 2 * (PI * ((r1 >>> 16) / 65535))
            v.set(Math.sin(theta) * Math.sin(phi), Math.cos(theta), Math.sin(theta) * Math.cos(phi))
            const r2 = M.mixRandom(r1)
            v.scale(((r2 >>> 16) / 65535) * power)
            M.xform(v, md, v)
          } else {
            v.set(0, ((((rs >>> 16) << 16) >> 16) / 32768) * power, 0)
            M.xform(v, md, v)
          }
        }
        M.xformN(v, m.emToLocNT, v)
        if (type === 0) addVel.add(v)
        else addPos.add(v)
        break
      }
    }
  }
}

function fieldRandomSeed(seed: number, trackSeed: number, tick: number) {
  let v = (Math.imul(seed & 0xffff, 0x3f81f635) + Math.imul(trackSeed & 0xffff, 0x30a74193) + Math.imul(tick & 0xffff, 0x371097e7) + 0x4bf53) >>> 0
  let b3 = v >>> 24, b2 = (v >>> 16) & 0xff, b1 = (v >>> 8) & 0xff, b0 = v & 0xff
  b2 ^= b3
  b1 ^= b2
  b0 ^= b1
  v = ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0
  return v
}

// ------------------------------------------------------------------ curves needing the particle

/** AnimCurveExecuteTexture */
function executeTexture(t: Track, p: Particle, tick: number, seed: number, life: number) {
  calcFrameStep(t, tick, life)
  const { frame, loop } = stepResult()
  const layer = t.kind - 14
  if (layer < 0 || layer > 2 || t.keys.length === 0) return
  const k = t.keys[searchKeyStep(t.keys, frame, false)]
  let name: number, wrap: number, reverse: number
  if (k.random === 0) {
    name = k.name
    wrap = k.wrap
    reverse = k.reverse
  } else {
    const rnd = calcRandomSeed(seed, t, loop, k.rangeIdx)
    const r = t.texRanges[k.rangeIdx]
    if (!r) return
    name = r.name
    wrap = r.wrap
    reverse = r.reverse
    switch (r.randomReverse) {
      case 1:
        reverse = (reverse & 2) | ((rnd >>> 16) & 1)
        break
      case 2:
        reverse = (reverse & 1) | ((rnd >>> 16) & 2)
        break
      case 3:
        reverse = (rnd >>> 16) & 3
        break
    }
  }
  p.textures[layer] = t.names[name] ?? p.textures[layer]
  p.texWrap = (p.texWrap & ~(0xf << (layer * 4)) & 0xffff) | ((wrap & 0xf) << (layer * 4))
  p.texReverse = (p.texReverse & ~(3 << (layer * 2)) & 0xff) | ((reverse & 3) << (layer * 2))
}

/** AnimCurveExecuteChild: queues child emitters / particles at key frames crossed this tick */
function executeChild(t: Track, p: Particle, tick: number, _seed: number, life: number, sys: EffectSystem) {
  const keys = t.keys
  if (keys.length === 0) return
  calcFrameStep(t, tick, life)
  const s0 = stepResult()
  calcFrameStep(t, tick + 1, life)
  let { frame: frame1 } = stepResult()
  const { loop: loop1 } = stepResult()
  const { frame: frame0, loop: loop0, end } = s0
  const create = (i: number) => {
    const k = keys[i]
    if (!k.child || !k.setting) return
    const res = sys.res.get(k.child)
    if (!res) return
    sys.queue.push({ type: k.setting.type === 0 ? 0 : 1, setting: k.setting, ptcl: p, res, calcRemain: p.calcRemain })
  }
  const n = keys.length
  if (loop0 === loop1) {
    if (frame0 === frame1) {
      if (!end) return
      frame1 = 1
    }
    if (frame0 < frame1) {
      for (let i = searchKeyStep(keys, frame0, true); i < n; i++) {
        if (keys[i].frame >= frame0) {
          if (frame1 <= keys[i].frame) return
          create(i)
        }
      }
    } else {
      for (let i = searchKeyStep(keys, frame0, false); i >= 0; i--) {
        if (frame0 >= keys[i].frame) {
          if (keys[i].frame <= frame1) return
          create(i)
        }
      }
    }
    return
  }
  const fl = t.frameLength
  if (t.proc & 0x40) {
    if (!(loop0 & 1)) {
      for (let i = searchKeyStep(keys, frame0, true); i < n; i++) {
        if (keys[i].frame >= frame0) {
          if (keys[i].frame === fl - 1) break
          create(i)
        }
      }
    } else {
      for (let i = searchKeyStep(keys, frame0, false); i >= 0; i--) {
        if (frame0 >= keys[i].frame) {
          if (keys[i].frame === 0) break
          create(i)
        }
      }
    }
    for (let l = loop0 + 1; l < loop1; l++) {
      if (!(loop0 & 1)) {
        for (let i = 0; i < n; i++) {
          if (keys[i].frame === fl - 1) break
          create(i)
        }
      } else {
        for (let i = n - 1; i >= 0; i--) {
          if (keys[i].frame === 0) break
          create(i)
        }
      }
    }
    if (!(loop1 & 1)) {
      for (let i = 0; i < n; i++) {
        if (frame1 <= keys[i].frame) return
        create(i)
      }
    } else {
      for (let i = n - 1; i >= 0; i--) {
        if (frame1 >= keys[i].frame) return
        create(i)
      }
    }
  } else {
    for (let i = searchKeyStep(keys, frame0, true); i < n; i++) if (keys[i].frame >= frame0) create(i)
    for (let l = loop0 + 1; l < loop1; l++) for (let i = 0; i < n; i++) create(i)
    for (let i = 0; i < n; i++) {
      if (frame1 <= keys[i].frame) return
      create(i)
    }
  }
}

// ------------------------------------------------------------------ Emitter

export class Emitter {
  tick = 0
  status = LS_ACTIVE
  eval = ES_WAIT
  calcRemain = 0
  comFlags = 0
  emitFlags = 0
  emitSpan = 0
  waitTime = 0
  emitIntervalWait = 0
  emitRatio = 0
  emitRandom = 0
  emitInterval = 0
  emitDiv = 0
  emitIntervalRandom = 0
  emitCount = 0
  isFirstEmission = true
  translate = new V3()
  scale = new V3(1, 1, 1)
  rotate = new V3()
  inherit = 3
  inheritT = 100
  velInitRandom = 0
  velMomentumRandom = 0
  velRadiation = 0
  velYAxis = 0
  velRandom = 0
  velNormal = 0
  velNormalDiffusion = 0
  velSpecDir = 0
  velSpecDiffusion = 0
  specDir = new V3()
  randSeed = 0
  random = new M.Random()
  params: number[] = [0, 0, 0, 0, 0, 0]
  parent: Emitter | null = null
  refPtcl: Particle | null = null
  setting: InheritSetting = zeroSetting()
  pms: ParticleManager[] = []

  constructor(
    public effect: Effect,
    public res: EmitterRes,
  ) {
    this.initializeDatas()
  }

  /** Emitter::InitializeDatas */
  initializeDatas() {
    const d = this.res
    this.tick = 0
    this.status = LS_ACTIVE
    this.eval = ES_WAIT
    this.calcRemain = d.emitPast
    this.comFlags = d.comFlags
    this.emitFlags = d.emitFlags
    this.emitSpan = d.emitLife
    this.waitTime = d.emitStart
    this.emitIntervalWait = 0
    this.emitRatio = d.emitCount
    this.emitRandom = d.emitRandom / 100
    this.emitInterval = d.emitInterval
    this.emitDiv = d.emitDiv
    this.emitIntervalRandom = d.emitIntervalRandom / 100
    this.emitCount = 0
    this.isFirstEmission = true
    this.translate.copy(d.translate)
    this.scale.copy(d.scale)
    this.rotate.copy(d.rotate)
    this.inherit = 3
    this.inheritT = 100
    this.velInitRandom = d.velInitRandom
    this.velMomentumRandom = d.velMomentumRandom
    this.velRadiation = d.velRadiation
    this.velYAxis = d.velYAxis
    this.velRandom = d.velRandom
    this.velNormal = d.velNormal
    this.velNormalDiffusion = d.velNormalDiffusion
    this.velSpecDir = d.velSpecDir
    this.velSpecDiffusion = d.velSpecDiffusion
    this.specDir.copy(d.specDir)
    this.randSeed = d.randomSeed
    if (this.randSeed === 0) this.randSeed = this.effect.sys.random.rand()
    this.random.srand(this.randSeed)
    this.params = [...d.params]
    this.refPtcl = null
    this.parent = null
  }

  /** Emitter::Initialize: the emitter's own particle manager */
  initialize(weight: number) {
    const pm = new ParticleManager(this, this.res)
    this.pms.push(pm)
    pm.flag = 0
    if (this.res.comFlags & CMN_INHERIT_PTCL_SCALE) pm.flag |= 1
    if (this.res.comFlags & CMN_INHERIT_PTCL_ROT) pm.flag |= 2
    pm.inheritT = this.res.inheritPtclTranslate
    pm.weight = weight
    this.effect.addPM(pm)
  }

  calcGlobalMtx(out: M34): M34 {
    if (!this.parent) M.copy(out, this.effect.root)
    else {
      const orig = this.parent.calcGlobalMtx(M.m34())
      M.restruct(out, orig, !!(this.inherit & 1), !!(this.inherit & 2), this.inheritT)
    }
    M.trans(out, out, this.translate.x, this.translate.y, this.translate.z)
    const r = M.rotXYZ(M.m34(), this.rotate.x, this.rotate.y, this.rotate.z)
    M.mult(out, out, r)
    M.scale(out, out, this.scale.x, this.scale.y, this.scale.z)
    return out
  }

  /** translate so that this emitter (parented) sits on the particle (CreateEmitter / CreateEmitterTmp) */
  private placeAtParticle(p: Particle) {
    const save = this.translate.clone()
    this.translate.set(0, 0, 0)
    const mtx = M.rotXYZ(M.m34(), this.rotate.x, this.rotate.y, this.rotate.z)
    M.scale(mtx, mtx, this.scale.x, this.scale.y, this.scale.z)
    const tmp = this.calcGlobalMtx(M.m34())
    M.inv(tmp, tmp)
    M.mult(mtx, mtx, tmp)
    p.pm.calcGlobalMtx(tmp)
    M.mult(mtx, mtx, tmp)
    M.trans(mtx, mtx, p.pos.x, p.pos.y, p.pos.z)
    M.rotXYZ(tmp, this.rotate.x, this.rotate.y, this.rotate.z)
    M.scale(tmp, tmp, this.scale.x, this.scale.y, this.scale.z)
    M.inv(tmp, tmp)
    M.mult(mtx, mtx, tmp)
    this.translate.set(save.x + mtx[3], save.y + mtx[7], save.z + mtx[11])
  }

  /** Emitter::CreateEmitter (child type 1: a full emitter parented to this one) */
  createEmitter(res: EmitterRes, s: InheritSetting, p: Particle | null, calcRemain: number) {
    const em = this.effect.createEmitter(res, s.weight, 0)
    em.calcRemain += calcRemain
    em.parent = this
    em.inherit = 0
    if (this.res.comFlags & CMN_EMIT_INHERIT_SCALE) em.inherit |= 1
    if (this.res.comFlags & CMN_EMIT_INHERIT_ROT) em.inherit |= 2
    em.inheritT = this.res.inheritChildEmitTranslate
    if (p) {
      em.placeAtParticle(p)
      if (s.speed !== 0 || s.scale !== 0 || s.alpha !== 0 || s.color !== 0 || s.flag & INHERIT_ROT) {
        em.refPtcl = p
        em.setting = { ...s }
      }
    }
    return em
  }

  /** Emitter::CreateEmitterTmp (child type 0: one emission into a manager of this emitter) */
  createEmitterTmp(res: EmitterRes, s: InheritSetting, p: Particle, calcRemain: number) {
    const tmp = new Emitter(this.effect, res)
    tmp.calcRemain += calcRemain
    tmp.parent = this
    if (s.flag & INHERIT_FOLLOW_EMIT && s.speed !== 0) {
      const g = M.noTrans(M.m34(), p.pm.calcGlobalMtx(M.m34()))
      const dir = M.xform(new V3(), g, p.moveDir(new V3()))
      if (!dir.isZero()) {
        dir.normalize()
        if (s.speed < 0) dir.scale(-1)
        const dm = M.getDirMtxY(M.m34(), dir)
        M.mult(dm, dm, M.rotXYZ(M.m34(), tmp.rotate.x, tmp.rotate.y, tmp.rotate.z))
        M.getRotation(dm, tmp.rotate)
      }
    }
    tmp.placeAtParticle(p)
    tmp.calcEmitter()
    tmp.calcBillboard()
    const inheritS = !!(this.comFlags & CMN_EMIT_INHERIT_SCALE) && !!(res.comFlags & CMN_INHERIT_PTCL_SCALE)
    const inheritR = !!(this.comFlags & CMN_EMIT_INHERIT_ROT) && !!(res.comFlags & CMN_INHERIT_PTCL_ROT)
    const parentChildT = this.res.inheritChildEmitTranslate
    const myPtclT = res.inheritPtclTranslate
    let inheritT: number
    if (parentChildT === 0 || myPtclT === 0) inheritT = 0
    else if (parentChildT === 100) inheritT = myPtclT
    else if (myPtclT === 100) inheritT = parentChildT
    else inheritT = Math.trunc((parentChildT * myPtclT) / 100)
    let pm = this.pms.find((m) => m.res === res && !!(m.flag & 1) === inheritS && !!(m.flag & 2) === inheritR && m.inheritT === inheritT && m.weight === s.weight)
    if (!pm) {
      pm = new ParticleManager(this, res)
      this.pms.push(pm)
      pm.flag = (inheritS ? 1 : 0) | (inheritR ? 2 : 0)
      pm.inheritT = inheritT
      pm.weight = s.weight
      // a modifier set on the effect before (RPSysEffect::setColor) only reached the managers alive then
      this.effect.addPM(pm)
    }
    if (s.speed !== 0 || s.scale !== 0 || s.alpha !== 0 || s.color !== 0 || s.flag & INHERIT_ROT) {
      tmp.refPtcl = p
      tmp.setting = { ...s }
    } else tmp.refPtcl = null
    const pmMtx = pm.calcGlobalMtx(M.m34())
    M.inv(pmMtx, pmMtx)
    const space = M.mult(M.m34(), pmMtx, tmp.calcGlobalMtx(M.m34()))
    tmp.emission(pm, space)
    if (this.status !== LS_ACTIVE && pm.status === LS_ACTIVE) pm.status = LS_WAIT
  }

  /** Emitter::Emission */
  emission(pm: ParticleManager, space: M34) {
    if (this.emitIntervalWait > 0) {
      this.emitIntervalWait--
      return
    }
    this.emitIntervalWait = this.emitInterval
    if (this.emitIntervalRandom !== 0) this.emitIntervalWait += Math.ceil((this.emitInterval * this.emitIntervalRandom - 1) * this.random.randFloat()) & 0xffff
    if (this.emitFlags & EMIT_EQUAL_DIV) this.emitCount = this.emitDiv
    else {
      const count = this.emitRandom === 0 ? this.emitRatio : this.emitRatio + this.emitRatio * this.emitRandom * (2 * this.random.randFloat() - 1)
      // EMIT_FLAG_8 (camera distance LOD) is not set by any basic_tank emitter
      this.emitCount += count
      if (this.isFirstEmission && this.emitRatio !== 0 && this.emitCount < 1) this.emitCount = 1
    }
    if (this.emitCount >= 1) {
      const d = this.res
      emitForm(this, pm, Math.trunc(this.emitCount), this.emitFlags, this.params, d.ptclLife, d.ptclLifeRandom / 100, space)
      this.emitCount -= Math.trunc(this.emitCount)
    }
    this.isFirstEmission = false
  }

  /** Emitter::CalcEmitter: lifetime and emitter tracks */
  calcEmitter() {
    if (this.comFlags & CMN_DISABLE_CALC) return
    if (this.status !== LS_ACTIVE || this.eval !== ES_WAIT || this.waitTime > 0) return
    if (!(this.comFlags & CMN_MAX_LIFE)) {
      if (this.tick >= this.emitSpan) {
        this.effect.retireEmitter(this)
        return
      }
    } else if (this.tick === 0xffffffff) {
      this.effect.retireEmitter(this)
      return
    }
    const animTime = this.tick
    const animSpan = this.comFlags & CMN_MAX_LIFE ? 0xffffffff : this.emitSpan
    const tracks = this.res.emitTracks
    const nInit = this.res.numEmitInit
    const seed = this.randSeed & 0xffff
    for (let i = this.tick === 0 ? 0 : nInit; i < tracks.length; i++) {
      const t = tracks[i]
      if (t.proc & PROC_STOP) continue
      if (t.ctype !== 'f32') continue
      const e = t.enable
      const k = t.kind
      if (e === 0b001) {
        if (k === 68) this.velRadiation = execScalar(t, this.velRadiation, animTime, seed, animSpan)
        else if (k === 69) this.velYAxis = execScalar(t, this.velYAxis, animTime, seed, animSpan)
        else if (k === 70) this.velRandom = execScalar(t, this.velRandom, animTime, seed, animSpan)
        else if (k === 73) this.emitRatio = execScalar(t, this.emitRatio, animTime, seed, animSpan)
        continue
      }
      if (e === 0b011) {
        if (k === 71) this.velNormal = execScalar(t, this.velNormal, animTime, seed, animSpan)
        continue
      }
      if (e === 0b111) {
        const v = k === 65 ? this.scale : k === 66 ? this.rotate : k === 67 ? this.translate : null
        if (!v) continue
        const a = [v.x, v.y, v.z]
        executeF32(t, a, 0, animTime, seed, animSpan)
        v.set(a[0], a[1], a[2])
        continue
      }
      if (k === 72) this.velSpecDir = execScalar(t, this.velSpecDir, animTime, seed, animSpan)
      else if (k === 64) executeF32(t, this.params, 0, animTime, seed, animSpan)
    }
  }

  calcParticle() {
    if (this.comFlags & CMN_DISABLE_CALC) return
    for (const pm of [...this.pms]) pm.calc()
  }

  /** Emitter::CalcEmission */
  calcEmission() {
    if (this.comFlags & CMN_DISABLE_CALC) return
    if (this.eval !== ES_WAIT) return
    this.eval = ES_DONE
    if (this.calcRemain > 0) this.effect.existCalcRemain = true
    if (this.status === LS_ACTIVE) {
      const pm = this.pms[0]
      if (this.waitTime > 0) this.waitTime--
      else {
        if (pm) {
          const pmMtx = pm.calcGlobalMtx(M.m34())
          M.inv(pmMtx, pmMtx)
          const space = M.mult(M.m34(), pmMtx, this.calcGlobalMtx(M.m34()))
          this.emission(pm, space)
        }
        this.tick++
      }
    } else {
      if (this.waitTime > 0) this.waitTime--
      else this.tick++
    }
  }

  /** Emitter::CalcBillboard (EMIT_FLAG_15/16; unused by basic_tank, kept for completeness) */
  calcBillboard() {
    if (this.status !== LS_ACTIVE && this.status !== LS_WAIT) return
    if (!(this.emitFlags & (EMIT_BILLBOARD | EMIT_BILLBOARD_X))) return
    const view = this.effect.sys.viewMtx
    this.rotate.set(0, 0, 0)
    const glb = this.calcGlobalMtx(M.m34())
    const mtx = M.mult(M.m34(), view, glb)
    const tmp = M.copy(M.m34(), mtx)
    tmp[0] = Math.sqrt(tmp[0] * tmp[0] + tmp[4] * tmp[4] + tmp[8] * tmp[8])
    tmp[4] = tmp[8] = 0
    tmp[5] = Math.sqrt(tmp[1] * tmp[1] + tmp[5] * tmp[5] + tmp[9] * tmp[9])
    tmp[1] = tmp[9] = 0
    tmp[10] = Math.sqrt(tmp[2] * tmp[2] + tmp[6] * tmp[6] + tmp[10] * tmp[10])
    tmp[2] = tmp[6] = 0
    if (this.emitFlags & EMIT_BILLBOARD_X) M.mult(tmp, tmp, M.rotXYZ(M.m34(), PI / 2, 0, 0))
    M.inv(mtx, mtx)
    M.mult(mtx, mtx, tmp)
    M.scale(mtx, mtx, 1 / this.scale.x, 1 / this.scale.y, 1 / this.scale.z)
    // MTX34Scale(&mtx, &scale, &mtx): S * mtx
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) mtx[r * 4 + c] *= [this.scale.x, this.scale.y, this.scale.z][r]
    M.getRotation(mtx, this.rotate)
  }

  /** Emitter::DestroyFunc (on retirement) */
  destroyFunc() {
    if (this.comFlags & CMN_SYNC_LIFE) this.retireParticleAll()
    for (const pm of this.pms) pm.status = LS_WAIT
    if (this.comFlags & CMN_SYNC_LIFE) {
      for (const e of [...this.effect.emitters]) {
        for (let it = e.parent; it; it = it.parent) {
          if (it !== this) continue
          e.retireParticleAll()
          if (e.status === LS_ACTIVE) this.effect.retireEmitter(e)
          break
        }
      }
    }
  }

  retireParticleAll() {
    let n = 0
    for (const pm of this.pms) n += pm.retireParticleAll()
    return n
  }
}

const execScalar = (t: Track, cur: number, tick: number, seed: number, life: number) => {
  const a = [cur]
  executeF32(t, a, 0, tick, seed, life)
  return a[0]
}

// ------------------------------------------------------------------ emitter forms

/** EmitterForm::CalcVelocity */
function calcVelocity(em: Emitter, normal: V3, fromOrigin: V3, fromYAxis: V3) {
  const vel = new V3()
  if (em.velRadiation !== 0) vel.copy(fromOrigin).scale(em.velRadiation)
  if (em.velYAxis !== 0) vel.add(fromYAxis.clone().scale(em.velYAxis))
  const R = em.random
  if (em.velRandom !== 0) {
    const rx = R.randFloat() * PI * 2
    const ry = R.randFloat() * PI * 2
    const rz = R.randFloat() * PI * 2
    const sr = Math.sin(rx), cr = Math.cos(rx), sp = Math.sin(ry), cp = Math.cos(ry), sh = Math.sin(rz), ch = Math.cos(rz)
    vel.x += (cr * sp * ch + sr * sh) * em.velRandom
    vel.y += (cr * sp * sh - sr * ch) * em.velRandom
    vel.z += em.velRandom * cr * cp
  }
  if (em.velNormal !== 0) vel.add(normal.clone().scale(em.velNormal))
  if (em.velSpecDir !== 0) {
    if (em.velSpecDiffusion === 0) {
      const m = M.rotXYZ(M.m34(), em.specDir.x, em.specDir.y, em.specDir.z)
      const d = M.xform(new V3(), m, new V3(0, 1, 0))
      vel.add(d.scale(em.velSpecDir))
    } else {
      const a = R.randFloat() * em.velSpecDiffusion
      const b = R.randFloat() * PI * 2
      const m = M.rotXYZ(M.m34(), a, b, 0)
      const rz = M.rotXYZ(M.m34(), em.specDir.x, em.specDir.y, em.specDir.z)
      M.mult(m, rz, m)
      vel.x += m[1] * em.velSpecDir
      vel.y += m[5] * em.velSpecDir
      vel.z += m[9] * em.velSpecDir
    }
  }
  if (em.velInitRandom !== 0) vel.scale(1 - em.velInitRandom * 0.01 * (R.randFloat() * 2 - 1))
  return vel
}

/** EmitterForm::CalcLife */
function calcLife(life: number, lifeRnd: number, em: Emitter) {
  let n = life
  if (lifeRnd !== 0) {
    const rnd = life * em.random.randFloat() * lifeRnd
    if (n - rnd < 1) n = 1
    else if (n - rnd > 65535) n = 65535
    else n = (n - (Math.trunc(rnd) & 0xffff)) & 0xffff
  }
  return n
}

function create(em: Emitter, pm: ParticleManager, life: number, lifeRnd: number, pos: V3, vel: V3, space: M34) {
  const l = calcLife(life, lifeRnd, em)
  const momentum = 1 + em.velMomentumRandom * 0.01 * em.random.randFloat()
  pm.createParticle(l, pos, vel, space, momentum, em.setting, em.refPtcl, em.calcRemain)
}

function emitForm(em: Emitter, pm: ParticleManager, count: number, flags: number, P: number[], life: number, lifeRnd: number, space: M34) {
  if (count < 1) return
  const R = em.random
  switch (em.res.form) {
    case FORM_POINT:
    default: {
      for (let i = 0; i < count; i++) {
        const pos = new V3()
        const normal = new V3()
        let rx = R.randFloat() * 2 - 1
        normal.x = rx >= 0 ? (0.66 + 0.34 * rx) * rx : (0.66 - 0.34 * rx) * rx
        const radius = Math.sqrt(1 - normal.x * normal.x)
        rx = R.randFloat() * PI * 2
        normal.y = Math.cos(rx) * radius
        normal.z = Math.sin(rx) * radius
        const fy = new V3(normal.x, 0, normal.z)
        if (normal.x !== 0 || normal.z !== 0) fy.normalize()
        const vel = calcVelocity(em, normal, normal, fy)
        create(em, pm, life, lifeRnd, pos, vel, space)
      }
      return
    }
    case FORM_DISC: {
      const sizeX = Math.abs(P[0]) > FLT_EPSILON ? P[0] : FLT_EPSILON
      const sizeZ = flags & EMIT_XYZ_SAME_SIZE ? sizeX : Math.abs(P[4]) > FLT_EPSILON ? P[4] : FLT_EPSILON
      let angle = 0
      let dangle = 0
      const angleOffset = flags & EMIT_FIXED_ANGLE ? P[2] : R.randFloat() * PI * 2
      if (flags & EMIT_EQUAL_DIV) {
        const f = (P[3] - P[2]) % (PI * 2)
        if (f < ANGLE_MIN || f > ANGLE_MAX) dangle = (P[3] - P[2]) / em.emitDiv
        else dangle = (P[3] - P[2]) / (em.emitDiv - 1)
      }
      for (let i = 0; i < count; i++) {
        R.rand()
        const seed = R.seed
        let dist = (seed >>> 16) / 65536
        const inner = P[1] / 100
        if (flags & EMIT_BIASED) dist = Math.sqrt(dist + inner * inner * (1 - dist))
        else dist = dist + inner * (1 - dist)
        if (!(flags & EMIT_EQUAL_DIV)) {
          const as = M.mixRandom(seed)
          R.seed = as
          angle = (P[3] - P[2]) * ((as >>> 16) / 65536)
        }
        const sa = Math.sin(angleOffset + angle)
        const ca = Math.cos(angleOffset + angle)
        const fy = new V3(sa, 0, -ca)
        const pos = new V3(fy.x * dist * sizeX, 0, fy.z * dist * sizeZ)
        const normal = new V3()
        if (em.velNormalDiffusion === 0) normal.set(0, 1, 0)
        else {
          const cone = dist * em.velNormalDiffusion
          normal.set(Math.sin(cone) * sa, Math.cos(cone), Math.sin(cone) * -ca)
        }
        const vel = calcVelocity(em, normal, fy.clone(), fy)
        create(em, pm, life, lifeRnd, pos, vel, space)
        if (flags & EMIT_EQUAL_DIV) angle += dangle
      }
      return
    }
    case FORM_SPHERE: {
      const inner = P[1] / 100
      const sizeX = Math.abs(P[0]) > FLT_EPSILON ? P[0] : FLT_EPSILON
      let sizeY: number, sizeZ: number
      if (flags & EMIT_XYZ_SAME_SIZE) sizeY = sizeZ = sizeX
      else {
        sizeY = Math.abs(P[4]) > FLT_EPSILON ? P[4] : FLT_EPSILON
        sizeZ = Math.abs(P[5]) > FLT_EPSILON ? P[5] : FLT_EPSILON
      }
      let startAngle = P[2]
      if (!(flags & EMIT_FIXED_ANGLE)) startAngle += R.randFloat() * PI * 2
      if (flags & EMIT_EQUAL_DIV) {
        const maxX = count * 2 + 1
        let countX = 0
        let maxAngle = 1
        let countAngle = 0
        const sweep = P[3] - P[2]
        const f = (P[3] - P[2]) % (PI * 2)
        const isCircle = f < ANGLE_MIN || f > ANGLE_MAX
        const total = count * (count * 4) + 2
        for (let i = 0; i < total; i++) {
          const x = (countX / (maxX - 1)) * PI + PI / 2
          let angle: number
          if (maxAngle === 1) angle = startAngle
          else if (isCircle) angle = startAngle + (countAngle / maxAngle) * sweep
          else angle = startAngle + (countAngle / (maxAngle - 1)) * sweep
          countAngle++
          if (countAngle === maxAngle) {
            countAngle = 0
            countX++
            if (countX * 2 < maxX) maxAngle = maxAngle !== 1 ? maxAngle + 4 : maxAngle + 3
            else maxAngle = maxAngle !== 4 ? maxAngle - 4 : 1
          }
          let radius = R.randFloat()
          if (flags & EMIT_BIASED) radius = 1 - radius * radius * radius
          radius = radius * (1 - inner) + inner
          const fy = new V3(-Math.sin(angle), 0, Math.cos(angle))
          const pos = new V3(sizeX * radius * Math.cos(x) * fy.x, sizeY * radius * -Math.sin(x), sizeZ * radius * Math.cos(x) * fy.z)
          const normal = pos.isZero() ? new V3() : pos.clone().normalize()
          if (Math.cos(x) < 0) {
            fy.x = -fy.x
            fy.z = -fy.z
          }
          const vel = calcVelocity(em, normal, normal, fy)
          create(em, pm, life, lifeRnd, pos, vel, space)
        }
      } else {
        for (let i = 0; i < count; i++) {
          let dist = R.randFloat()
          if (flags & EMIT_BIASED) {
            dist = 1 - dist * dist * dist
            dist = dist + inner * (1 - dist)
          } else dist += inner * (1 - dist)
          const angle = (P[3] - P[2]) * R.randFloat() + startAngle
          const x = R.randFloat() * PI + PI / 2
          const pos = new V3(sizeX * dist * -Math.cos(x) * Math.sin(angle), sizeY * dist * -Math.sin(x), sizeZ * dist * Math.cos(x) * Math.cos(angle))
          const normal = pos.isZero() ? new V3() : pos.clone().normalize()
          const fy = new V3(pos.x, 0, pos.z)
          if (fy.x !== 0 || fy.z !== 0) fy.normalize()
          const vel = calcVelocity(em, normal, normal, fy)
          create(em, pm, life, lifeRnd, pos, vel, space)
        }
      }
      return
    }
    case FORM_LINE: {
      for (let i = 0; i < count; i++) {
        let fpos: number
        if (!(flags & EMIT_EQUAL_DIV)) fpos = R.randFloat()
        else if (count > 1) fpos = i / (count - 1)
        else fpos = 0
        if (flags & EMIT_CENTERED_LINE) fpos -= 0.5
        fpos *= P[0]
        const sx = Math.sin(P[1]), cx = Math.cos(P[1]), sy = Math.sin(P[2]), cy = Math.cos(P[2]), sz = Math.sin(P[3]), cz = Math.cos(P[3])
        const pos = new V3((cx * cz * sy + sx * sz) * fpos, (-cz * sx + cx * sy * sz) * fpos, cx * cy * fpos)
        const normal = new V3(0, 1, 0)
        const fy = new V3(pos.x, 0, pos.z)
        const vel = calcVelocity(em, normal, pos, fy)
        create(em, pm, life, lifeRnd, pos, vel, space)
      }
      return
    }
    case FORM_CUBE: {
      // the EMIT_FLAG_17 (equal division) grid layout is not used by basic_tank
      let ox = P[0], oy = P[1], oz = P[2]
      if (ox < 1e-5) ox = 1e-5
      if (oy < 1e-5) oy = 1e-5
      if (oz < 1e-5) oz = 1e-5
      const inner = P[3] === 0 ? 1e-5 : P[3] * 0.01
      const innerRev = 1 - inner
      let diffuse = em.velNormalDiffusion
      if (Math.abs(diffuse - PI) < PI * FLT_EPSILON) diffuse -= PI * FLT_EPSILON
      const rf = () => R.randFloat() * 2 - 1
      for (let i = 0; i < count; i++) {
        let x = 0, y = 0, z = 0
        if (inner === 0) {
          x = rf()
          y = rf()
          z = rf()
        } else if (inner === 1) {
          switch (R.rand() % 6) {
            case 0: x = rf(); y = rf(); z = 1; break
            case 1: x = rf(); y = rf(); z = -1; break
            case 2: x = rf(); y = 1; z = rf(); break
            case 3: x = rf(); y = -1; z = rf(); break
            case 4: x = 1; y = rf(); z = rf(); break
            case 5: x = -1; y = rf(); z = rf(); break
          }
        } else {
          const tb = ox * oy * innerRev * oz
          const fb = ox * oy * inner * oz * innerRev
          const lr = ox * innerRev * oy * inner * oz * inner
          const f = R.randFloat() * (tb + fb + lr)
          if (f < tb) {
            x = rf()
            y = rf() * innerRev
            y = y >= 0 ? 1 - y : -1 - y
            z = rf()
          } else if (f < tb + fb) {
            x = rf()
            y = rf() * inner
            z = rf() * innerRev
            z = z >= 0 ? 1 - z : -1 - z
          } else {
            x = rf() * innerRev
            x = x >= 0 ? 1 - x : -1 - x
            y = rf() * inner
            z = rf() * inner
          }
        }
        const normal = new V3()
        if (y >= 0 && y >= Math.abs(x) && y >= Math.abs(z)) normal.y = 1
        else if (y < 0 && -y >= Math.abs(x) && -y >= Math.abs(z)) normal.y = -1
        else if (x >= 0 && x >= Math.abs(y) && x >= Math.abs(z)) normal.x = 1
        else if (x < 0 && -x >= Math.abs(y) && -x >= Math.abs(z)) normal.x = -1
        else if (z >= 0) normal.z = 1
        else normal.z = -1
        const pos = new V3(x * ox, y * oy, z * oz)
        if (diffuse !== 0) {
          if (normal.x !== 0) {
            const ylen = 1 / Math.tan(Math.max(Math.abs(pos.y), Math.abs(pos.z)) * diffuse)
            normal.set(normal.x * ylen * Math.sqrt(pos.y * pos.y + pos.z * pos.z), pos.y, pos.z)
          } else if (normal.y !== 0) {
            const ylen = 1 / Math.tan(Math.max(Math.abs(pos.x), Math.abs(pos.z)) * diffuse)
            normal.set(pos.x, normal.y * ylen * Math.sqrt(pos.x * pos.x + pos.z * pos.z), pos.z)
          } else {
            const ylen = 1 / Math.tan(Math.max(Math.abs(pos.x), Math.abs(pos.y)) * diffuse)
            normal.set(pos.x, pos.y, normal.z * ylen * Math.sqrt(pos.x * pos.x + pos.y * pos.y))
          }
        }
        // EmitterFormCube::EmissionSub
        if (!normal.isZero()) normal.normalize()
        const fo = pos.clone()
        if (fo.lenSq() <= FLT_MIN) fo.set(2 * R.randFloat() - 1, 2 * R.randFloat() - 1, 2 * R.randFloat() - 1)
        if (!fo.isZero()) fo.normalize()
        const fy = new V3(pos.x, 0, pos.z)
        if (fy.lenSq() <= FLT_MIN) {
          fy.x = 2 * R.randFloat() - 1
          fy.z = 2 * R.randFloat() - 1
        }
        if (!fy.isZero()) fy.normalize()
        const vel = calcVelocity(em, normal, fo, fy)
        create(em, pm, life, lifeRnd, pos, vel, space)
      }
      return
    }
  }
}

// ------------------------------------------------------------------ Effect / system

export interface QueueItem {
  type: 0 | 1
  setting: InheritSetting
  ptcl: Particle
  res: EmitterRes
  calcRemain: number
}

export class EffectSystem {
  random = new M.Random(0)
  queue: QueueItem[] = []
  effects: Effect[] = []
  /** view matrix of the last draw (Emitter::CalcBillboard) */
  viewMtx = M.m34()
  constructor(public res: Map<string, EmitterRes>) {}

  createEffect(name: string) {
    const r = this.res.get(name)
    if (!r) return null
    const e = new Effect(this, r)
    this.effects.push(e)
    return e
  }

  executeQueue() {
    const q = this.queue
    this.queue = []
    for (const it of q) {
      const em = it.ptcl.pm.em
      if (it.type === 0) em.createEmitterTmp(it.res, it.setting, it.ptcl, it.calcRemain)
      else em.createEmitter(it.res, it.setting, it.ptcl, it.calcRemain)
    }
  }

  calc() {
    for (const e of [...this.effects]) e.calc()
    this.effects = this.effects.filter((e) => e.prune())
  }
}

export class Effect {
  root = M.m34()
  emitters: Emitter[] = []
  /** particle managers in draw order (DrawOrder::Add, by weight) */
  pmList: ParticleManager[] = []
  velocity = new V3()
  disableCalc = false
  disableDraw = false
  existCalcRemain = false
  seq: number
  private static nextSeq = 0

  constructor(
    public sys: EffectSystem,
    res: EmitterRes,
  ) {
    this.seq = Effect.nextSeq++
    const em = new Emitter(this, res)
    em.initialize(128)
    this.emitters.push(em)
  }

  createEmitter(res: EmitterRes, weight: number, calcRemain: number) {
    const em = new Emitter(this, res)
    em.initialize(weight)
    this.emitters.push(em)
    em.calcRemain += calcRemain
    return em
  }

  addPM(pm: ParticleManager) {
    let i = this.pmList.length
    while (i > 0 && this.pmList[i - 1].weight > pm.weight) i--
    this.pmList.splice(i, 0, pm)
  }

  retireEmitter(em: Emitter) {
    if (em.status !== LS_ACTIVE) return 0
    em.status = LS_WAIT
    em.destroyFunc()
    return 1
  }
  retireEmitterAll() {
    let n = 0
    for (const em of [...this.emitters]) if (em.status === LS_ACTIVE) n += this.retireEmitter(em)
    return n
  }
  retireParticleAll() {
    let n = 0
    for (const em of this.emitters) n += em.retireParticleAll()
    return n
  }

  /** drop finished managers / emitters; false when the whole effect is gone */
  prune() {
    for (const em of this.emitters) {
      em.pms = em.pms.filter((pm) => pm.status === LS_ACTIVE || pm.particles.length > 0)
    }
    this.pmList = this.pmList.filter((pm) => pm.status === LS_ACTIVE || pm.particles.length > 0)
    this.emitters = this.emitters.filter((em) => em.status === LS_ACTIVE || em.pms.length > 0)
    return this.emitters.length > 0
  }

  /** Effect::Calc */
  calc() {
    if (this.disableCalc) return
    for (const em of this.emitters) {
      if ((em.status === LS_ACTIVE || em.status === LS_WAIT) && em.eval === ES_DONE) em.eval = ES_WAIT
      for (const pm of em.pms) pm.beginCalc(false)
    }
    this.existCalcRemain = true
    let guard = 0
    while (this.existCalcRemain && guard++ < 1000) {
      this.existCalcRemain = false
      for (let loop = 0; loop < 64; loop++) {
        for (const em of [...this.emitters]) em.calcEmitter()
        for (const em of [...this.emitters]) if ((em.status === LS_ACTIVE || em.status === LS_WAIT) && em.emitFlags & (EMIT_BILLBOARD | EMIT_BILLBOARD_X)) em.calcBillboard()
        for (const em of [...this.emitters]) {
          if (em.eval === ES_WAIT) em.tick++
          em.calcParticle()
          if (em.eval === ES_WAIT) em.tick--
        }
        for (const em of [...this.emitters]) em.calcEmission()
        for (const em of [...this.emitters]) em.calcParticle()
        if (this.sys.queue.length === 0) break
        this.sys.executeQueue()
      }
      if (this.existCalcRemain) {
        for (const em of this.emitters) {
          if (em.status === LS_ACTIVE && em.calcRemain !== 0) {
            em.calcRemain--
            if (em.eval === ES_DONE) em.eval = ES_WAIT
          }
          for (const pm of em.pms) pm.beginCalc(true)
        }
      }
    }
    for (const em of this.emitters) {
      if ((em.status === LS_ACTIVE || em.status === LS_WAIT) && em.eval === ES_SKIP) em.eval = ES_DONE
      for (const pm of em.pms) pm.endCalc()
    }
  }

  setColor(r: number, g: number, b: number, a: number) {
    for (const pm of this.pmList) {
      if (pm.status !== LS_ACTIVE) continue
      pm.lightType = 1
      pm.ambient = [r, g, b, a]
    }
  }
}
