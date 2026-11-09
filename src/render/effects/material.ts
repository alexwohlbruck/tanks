// GX pixel pipeline of one emitter as a TSL node material: up to 4 TEV stages
// (colour op applied to alpha too, as nw4r::ef's InitTev does), the colour
// routing of EmitterDrawSetting::ColorInput, texture wrap emulated in the
// shader (wrap can change per particle), alpha compare, blend and z mode.

import * as THREE from 'three/webgpu'
import { Discard, Fn, If, attribute, clamp, float, floor, fract, mod, select, texture, vec2, vec3, vec4 } from 'three/tsl'
import type { EmitterRes } from './res'
import { DF_TEX2, DF_ZTEST, DF_ZUPDATE } from './res'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any

const KFRAC: Record<string, number> = { '1': 1, '7/8': 7 / 8, '3/4': 3 / 4, '5/8': 5 / 8, '1/2': 1 / 2, '3/8': 3 / 8, '1/4': 1 / 4, '1/8': 1 / 8 }
const BIAS: Record<string, number> = { '0': 0, '+0.5': 0.5, '-0.5': -0.5 }
const SCALE: Record<string, number> = { '1': 1, '2': 2, '4': 4, '0.5': 0.5, '1/2': 0.5 }

const BLEND: Record<string, THREE.BlendingSrcFactor> = {
  zero: THREE.ZeroFactor,
  one: THREE.OneFactor,
  src_alpha: THREE.SrcAlphaFactor,
  inv_src_alpha: THREE.OneMinusSrcAlphaFactor,
  dst_alpha: THREE.DstAlphaFactor,
  inv_dst_alpha: THREE.OneMinusDstAlphaFactor,
  dst_color: THREE.DstColorFactor,
  inv_dst_color: THREE.OneMinusDstColorFactor,
  src_color: THREE.SrcColorFactor as unknown as THREE.BlendingSrcFactor,
  inv_src_color: THREE.OneMinusSrcColorFactor as unknown as THREE.BlendingSrcFactor,
}
const DEPTH: Record<string, THREE.DepthModes> = {
  never: THREE.NeverDepth,
  less: THREE.LessDepth,
  equal: THREE.EqualDepth,
  lequal: THREE.LessEqualDepth,
  greater: THREE.GreaterDepth,
  nequal: THREE.NotEqualDepth,
  gequal: THREE.GreaterEqualDepth,
  always: THREE.AlwaysDepth,
}

/** GX wrap per coordinate: 0 clamp, 1 repeat, 2 mirror */
function wrap(u: N, mode: N) {
  const m = mod(u, 2)
  const mir = select(m.greaterThan(1), float(2).sub(m), m)
  return select(mode.lessThan(0.5), clamp(u, 0, 1), select(mode.lessThan(1.5), fract(u), mir))
}

function sample(tex: THREE.Texture | null, uvN: N, code: N) {
  if (!tex) return vec4(1, 1, 1, 1)
  const ms = mod(code, 4)
  const mt = floor(code.div(4))
  return texture(tex, vec2(wrap(uvN.x, ms), wrap(uvN.y, mt)))
}

function compare(fn: string, a: N, ref: N): N {
  switch (fn) {
    case 'never':
      return a.lessThan(-1)
    case 'less':
      return a.lessThan(ref)
    case 'equal':
      return a.equal(ref)
    case 'lequal':
      return a.lessThanEqual(ref)
    case 'greater':
      return a.greaterThan(ref)
    case 'nequal':
      return a.notEqual(ref)
    case 'gequal':
      return a.greaterThanEqual(ref)
    default:
      return null // always
  }
}

export function makeMaterial(r: EmitterRes, tex1: THREE.Texture | null, tex2: THREE.Texture | null) {
  const mat = new THREE.NodeMaterial()
  mat.transparent = true
  mat.side = THREE.DoubleSide
  mat.depthTest = !!(r.drawFlags & DF_ZTEST)
  mat.depthWrite = !!(r.drawFlags & DF_ZUPDATE)
  mat.depthFunc = DEPTH[r.zCompare] ?? THREE.LessEqualDepth
  mat.fog = false
  mat.toneMapped = false
  if (r.blend.type === 'blend') {
    mat.blending = THREE.CustomBlending
    mat.blendSrc = BLEND[r.blend.src] ?? THREE.SrcAlphaFactor
    mat.blendDst = (BLEND[r.blend.dst] ?? THREE.OneMinusSrcAlphaFactor) as unknown as THREE.BlendingDstFactor
    mat.blendEquation = THREE.AddEquation
    // keep the destination alpha (GX blends colour only)
    mat.blendSrcAlpha = THREE.ZeroFactor
    mat.blendDstAlpha = THREE.OneFactor
    mat.blendEquationAlpha = THREE.AddEquation
  } else if (r.blend.type === 'subtract') {
    mat.blending = THREE.CustomBlending
    mat.blendSrc = THREE.OneFactor
    mat.blendDst = THREE.OneFactor
    mat.blendEquation = THREE.ReverseSubtractEquation
  } else mat.blending = THREE.NoBlending

  mat.fragmentNode = Fn(() => {
    const uvs = attribute('fxUv', 'vec4')
    const ext = attribute('fxExt', 'vec4')
    const L: Record<string, N> = {
      color1_primary: attribute('fxC0', 'vec4'),
      color1_secondary: attribute('fxC1', 'vec4'),
      'color2_primary?': attribute('fxC2', 'vec4'),
      color2_primary: attribute('fxC2', 'vec4'),
      color2_secondary: attribute('fxC3', 'vec4'),
    }
    const src = (name: string) => L[name] ?? vec4(0, 0, 0, 0)
    const t1 = sample(tex1, uvs.xy, ext.z)
    const t2 = r.drawFlags & DF_TEX2 ? sample(tex2, uvs.zw, ext.w) : vec4(1, 1, 1, 1)
    const K = r.konst.map(src)
    // TEV registers: PREV, REG0..REG2 (rgb + a)
    const reg: Record<string, { c: N; a: N }> = {
      PREV: { c: vec3(0, 0, 0), a: float(0) },
      REG0: { c: src(r.regs[0]).rgb, a: src(r.regs[0]).a },
      REG1: { c: src(r.regs[1]).rgb, a: src(r.regs[1]).a },
      REG2: { c: src(r.regs[2]).rgb, a: src(r.regs[2]).a },
    }
    r.tev.forEach((s, i) => {
      const tx = i === 0 ? t1 : t2
      const konstC = (): N => {
        const m = /^K(\d)(?:_([RGBA]))?$/.exec(s.kcsel)
        if (!m) return vec3(KFRAC[s.kcsel] ?? 1)
        const k = K[+m[1]]
        return m[2] ? vec3(k[m[2].toLowerCase()]) : k.rgb
      }
      const konstA = (): N => {
        const m = /^K(\d)(?:_([RGBA]))?$/.exec(s.kasel)
        if (!m) return float(KFRAC[s.kasel] ?? 1)
        return K[+m[1]][(m[2] ?? 'A').toLowerCase()]
      }
      const ca = (n: string): N => {
        switch (n) {
          case 'CPREV':
            return reg.PREV.c
          case 'APREV':
            return vec3(reg.PREV.a)
          case 'C0':
            return reg.REG0.c
          case 'A0':
            return vec3(reg.REG0.a)
          case 'C1':
            return reg.REG1.c
          case 'A1':
            return vec3(reg.REG1.a)
          case 'C2':
            return reg.REG2.c
          case 'A2':
            return vec3(reg.REG2.a)
          case 'TEXC':
            return tx.rgb
          case 'TEXA':
            return vec3(tx.a)
          case 'RASC':
          case 'ONE':
            return vec3(1)
          case 'RASA':
            return vec3(1)
          case 'HALF':
            return vec3(0.5)
          case 'KONST':
            return konstC()
          default:
            return vec3(0)
        }
      }
      const aa = (n: string): N => {
        switch (n) {
          case 'APREV':
            return reg.PREV.a
          case 'A0':
            return reg.REG0.a
          case 'A1':
            return reg.REG1.a
          case 'A2':
            return reg.REG2.a
          case 'TEXA':
            return tx.a
          case 'RASA':
            return float(1)
          case 'KONST':
            return konstA()
          default:
            return float(0)
        }
      }
      const bias = BIAS[s.bias] ?? 0
      const scale = SCALE[s.scale] ?? 1
      const sub = s.op === 'sub'
      const comb = (a: N, b: N, c: N, d: N) => {
        const lerp = a.mul(c.oneMinus()).add(b.mul(c))
        let v = sub ? d.sub(lerp) : d.add(lerp)
        if (bias) v = v.add(bias)
        if (scale !== 1) v = v.mul(scale)
        return s.clamp ? clamp(v, 0, 1) : v
      }
      const c = comb(ca(s.colorIn[0]), ca(s.colorIn[1]), ca(s.colorIn[2]), ca(s.colorIn[3]))
      const a = comb(aa(s.alphaIn[0]), aa(s.alphaIn[1]), aa(s.alphaIn[2]), aa(s.alphaIn[3]))
      const dst = reg[s.dest] ?? reg.PREV
      dst.c = c.toVar()
      dst.a = a.toVar()
      reg.__last = dst
    })
    const out = reg.__last ?? reg.PREV
    // alpha compare (ref0 / ref1 per particle)
    const c0 = compare(r.acmp.comp0, out.a, ext.x)
    const c1 = compare(r.acmp.comp1, out.a, ext.y)
    if (c0 || c1 || r.acmp.comp0 === 'never' || r.acmp.comp1 === 'never') {
      let pass: N
      const A = c0 ?? null
      const B = c1 ?? null
      if (r.acmp.op === 'or') pass = A && B ? A.or(B) : null
      else pass = A && B ? A.and(B) : (A ?? B)
      if (pass) If(pass.not(), () => Discard())
    }
    return vec4(out.c, out.a)
  })()
  return mat
}
