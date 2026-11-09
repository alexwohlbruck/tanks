// basic_tank.json (REFF v5, decoded by tools/g3d/effects.py) -> runtime resources.
// Field names follow nw4r::ef::EmitterDesc / ParticleParameterDesc / AnimCurveHeader.

import { V3 } from './mtx'

// EmitterDesc::CommonFlag
export const CMN_SYNC_LIFE = 1 << 0
export const CMN_DISABLE_DRAW = 1 << 1
export const CMN_MAX_LIFE = 1 << 2
export const CMN_INHERIT_PTCL_SCALE = 1 << 5
export const CMN_INHERIT_PTCL_ROT = 1 << 6
export const CMN_EMIT_INHERIT_SCALE = 1 << 7
export const CMN_EMIT_INHERIT_ROT = 1 << 8
export const CMN_DISABLE_CALC = 1 << 9
// EmitterDesc::EmitFlag
export const EMIT_LOD = 1 << 8
export const EMIT_BILLBOARD_X = 1 << 15
export const EMIT_BILLBOARD = 1 << 16
export const EMIT_EQUAL_DIV = 1 << 17 // FLAG_17
export const EMIT_FIXED_ANGLE = 1 << 18 // FLAG_18
export const EMIT_BIASED = 1 << 24 // FLAG_24
export const EMIT_XYZ_SAME_SIZE = 1 << 25
export const EMIT_CENTERED_LINE = 1 << 26
// EmitFormType
export const FORM_DISC = 0, FORM_LINE = 1, FORM_CUBE = 5, FORM_CYLINDER = 7, FORM_SPHERE = 8, FORM_POINT = 9, FORM_TORUS = 10
// EmitterDrawSetting::Flag
export const DF_ZTEST = 1 << 0
export const DF_ZUPDATE = 1 << 1
export const DF_TEX1 = 1 << 4
export const DF_TEX2 = 1 << 5
export const DF_HIDDEN = 1 << 10
export const DF_DRAW_ORDER = 1 << 11
export const DF_XY_SAME_SIZE = 1 << 13
export const DF_XY_SAME_SCALE = 1 << 14
// AnimCurveHeader::ProcessFlag
export const PROC_SYNC = 1 << 2
export const PROC_STOP = 1 << 3
export const PROC_TIMING = 1 << 4
export const PROC_INFLOOP = 1 << 5
export const PROC_TURN = 1 << 6
export const PROC_FITTING = 1 << 7
const PROC_NAMES: Record<string, number> = {
  sync: PROC_SYNC,
  stop: PROC_STOP,
  timing: PROC_TIMING,
  infinite_loop: PROC_INFLOOP,
  turn: PROC_TURN,
  fitting: PROC_FITTING,
}

export type CurveType = 'u8' | 'f32' | 'rotate' | 'texture' | 'child'

export interface InheritSetting {
  speed: number
  scale: number
  alpha: number
  color: number
  weight: number
  type: number
  flag: number
}
export const INHERIT_FOLLOW_EMIT = 1
export const INHERIT_ROT = 2
export const zeroSetting = (): InheritSetting => ({ speed: 0, scale: 0, alpha: 0, color: 0, weight: 0, type: 0, flag: 0 })

export interface Key {
  frame: number
  random: number
  interp: number[] // per component: 0 linear, 1 smooth, 2 step
  value: (number | null)[] | null
  rangeIdx: number
  // texture keys
  wrap: number
  reverse: number
  name: number
  // child keys
  setting: InheritSetting | null
  child: string | null
}

export interface TexRange {
  wrap: number
  reverse: number
  name: number
  randomReverse: number
}

export interface Track {
  kind: number
  ctype: CurveType
  enable: number
  proc: number
  loopCount: number
  randomSeed: number
  frameLength: number
  initOnly: boolean
  keys: Key[]
  /** f32/u8: [rangeIdx][component] = [base, width]; rotate: + sign */
  ranges: number[][][]
  rangeSign: number[]
  /** u8 random table: [entry][component] = [base, width] */
  table: number[][][]
  texRanges: TexRange[]
  names: string[]
  field: Record<string, unknown> | null
}

export interface TevStage {
  colorIn: string[]
  alphaIn: string[]
  op: string
  bias: string
  scale: string
  clamp: boolean
  dest: string
  kcsel: string
  kasel: string
}

export interface EmitterRes {
  name: string
  comFlags: number
  emitFlags: number
  form: number
  params: number[]
  emitLife: number
  ptclLife: number
  ptclLifeRandom: number
  emitIntervalRandom: number
  emitRandom: number
  emitCount: number
  emitStart: number
  emitPast: number
  emitInterval: number
  inheritPtclTranslate: number
  inheritChildEmitTranslate: number
  emitDiv: number
  velInitRandom: number
  velMomentumRandom: number
  velRadiation: number
  velYAxis: number
  velRandom: number
  velNormal: number
  velNormalDiffusion: number
  velSpecDir: number
  velSpecDiffusion: number
  specDir: V3
  scale: V3
  rotate: V3
  translate: V3
  randomSeed: number
  ptype: string
  typeOption: number
  typeDir: number
  typeAxis: number
  typeOption0: number
  typeOption1: number
  typeOption2: number
  pivotX: number
  pivotY: number
  // draw setting
  drawFlags: number
  acmp: { comp0: string; comp1: string; op: string }
  tev: TevStage[]
  blend: { type: string; src: string; dst: string }
  regs: string[] // C0..C2 sources
  konst: string[] // K0..K3 sources
  zCompare: string
  flick: { type: number; cycle: number; random: number; amplitude: number }
  // particle desc
  colors: Uint8Array // [layer][pri/sec][rgba]
  size: [number, number]
  pscale: [number, number]
  prot: [number, number, number]
  texScale: number[] // 3 x 2
  texRot: number[] // 3
  texTrans: number[] // 3 x 2
  texWrap: number
  texReverse: number
  acmpRef0: number
  acmpRef1: number
  textures: (string | null)[]
  ptclTracks: Track[]
  emitTracks: Track[]
  /** NumPtclInitTrack / NumEmitInitTrack */
  numPtclInit: number
  numEmitInit: number
}

const FLICK: Record<string, number> = { none: 0, triangle: 1, sawtooth_inv: 2, sawtooth: 3, square: 4, sine: 5 }
const INTERP: Record<string, number> = { linear: 0, smooth: 1, step: 2 }

/**
 * Texture-key range tables are not in the JSON (effects.py only dumps u8/f32/rotate
 * ranges). Read from basic_tank.breff by hand: u8 wrap, u8 reverse, u16 name, u8 randomReverse.
 */
const TEX_RANGES: Record<string, TexRange[]> = {
  Tnk_mine_bomb_fire: [{ wrap: 5, reverse: 0, name: 0, randomReverse: 3 }],
  Tnk_clr_stardust01: [{ wrap: 0, reverse: 0, name: 0, randomReverse: 3 }],
}

const hexBytes = (h: string) => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

function parseTrack(t: J, emitterName: string): Track {
  const enable = parseInt(t.component_mask, 2)
  let num = 0
  for (let b = 7; b >= 0; b--)
    if (enable & (1 << b)) {
      num = b + 1
      break
    }
  let proc = 0
  for (const f of t.process_flags as string[]) proc |= PROC_NAMES[f] ?? 0
  const keys: Key[] = (t.keys ?? []).map((k: J) => {
    const isRnd = typeof k.value === 'object' && k.value !== null && !Array.isArray(k.value)
    const key: Key = {
      frame: k.frame,
      random: k.random ?? 0,
      interp: (k.interp ?? []).map((s: string) => INTERP[s] ?? 0),
      value: Array.isArray(k.value) ? k.value : null,
      rangeIdx: isRnd ? k.value.random_range_index : (k.random_range_index ?? 0),
      wrap: k.wrap ?? 0,
      reverse: k.reverse ?? 0,
      name: k.name_index ?? 0,
      setting: k.inherit
        ? { speed: k.inherit.speed, scale: k.inherit.scale, alpha: k.inherit.alpha, color: k.inherit.color, weight: k.inherit.weight, type: k.inherit.type, flag: k.inherit.flag }
        : null,
      child: k.child ?? null,
    }
    return key
  })
  const ranges: number[][][] = []
  const rangeSign: number[] = []
  for (const r of t.random_ranges ?? []) {
    if (Array.isArray(r)) ranges.push(r)
    else {
      ranges.push(r.base_width)
      rangeSign.push(r.random_sign)
    }
  }
  const table: number[][][] = []
  if (t.random_table_raw && t.curve_type === 'u8') {
    const b = hexBytes(t.random_table_raw)
    const count = (b[0] << 8) | b[1]
    for (let i = 0; i < count; i++) {
      const e: number[][] = []
      for (let c = 0; c < num; c++) e.push([b[4 + i * num * 2 + c * 2], b[4 + i * num * 2 + c * 2 + 1]])
      table.push(e)
    }
  }
  return {
    kind: t.target_id,
    ctype: t.curve_type,
    enable,
    proc,
    loopCount: t.loop_count,
    randomSeed: t.random_seed,
    frameLength: t.frame_length,
    initOnly: !!t.init_only,
    keys,
    ranges,
    rangeSign,
    table,
    texRanges: t.curve_type === 'texture' ? (TEX_RANGES[emitterName] ?? []) : [],
    names: t.names ?? [],
    field: t.field ?? null,
  }
}

const v3 = (a: number[]) => new V3(a[0], a[1], a[2])

export function parseEmitter(e: J): EmitterRes {
  const d = e.draw
  const p = e.particle
  const v = e.velocity
  const col = new Uint8Array(16)
  const cl = [p.colors.layer1_primary, p.colors.layer1_secondary, p.colors.layer2_primary, p.colors.layer2_secondary]
  cl.forEach((c: number[], i: number) => col.set(c, i * 4))
  const wrapCode = (w: string) => ({ clamp: 0, repeat: 1, mirror: 2 })[w] ?? 0
  let texWrap = 0
  p.texture_wrap.forEach((w: J, L: number) => (texWrap |= (wrapCode(w.s) | (wrapCode(w.t) << 2)) << (4 * L)))
  const tracks = (list: J[]) => {
    const t = list.map((x) => parseTrack(x, e.name))
    // NumPtclInitTrack: the init-only tracks lead the table
    return [...t.filter((x) => x.initOnly), ...t.filter((x) => !x.initOnly)]
  }
  return {
    name: e.name,
    comFlags: parseInt(e.common_flags_raw, 16) >>> 0,
    emitFlags: parseInt(e.emit_flags_raw, 16) >>> 0,
    form: parseInt(e.emit_flags_raw, 16) & 0xff,
    params: Object.values(e.form_params as Record<string, number>),
    emitLife: e.emitter_life,
    ptclLife: e.particle_life,
    ptclLifeRandom: e.particle_life_random_pct,
    emitIntervalRandom: e.emit_interval_random_pct,
    emitRandom: e.emit_count_random_pct,
    emitCount: e.emit_count,
    emitStart: e.emit_start_frame,
    emitPast: e.emit_past,
    emitInterval: e.emit_interval,
    inheritPtclTranslate: e.inherit_ptcl_translate,
    inheritChildEmitTranslate: e.inherit_child_emit_translate,
    emitDiv: e.emit_div,
    velInitRandom: v.init_random_pct,
    velMomentumRandom: v.momentum_random_pct,
    velRadiation: v.radiation_power,
    velYAxis: v.y_axis_power,
    velRandom: v.random_dir_power,
    velNormal: v.normal_dir_power,
    velNormalDiffusion: v.normal_diffusion,
    velSpecDir: v.spec_dir_power,
    velSpecDiffusion: v.spec_dir_diffusion,
    specDir: v3(v.spec_dir),
    scale: v3(e.emitter_scale),
    rotate: v3(e.emitter_rotate_rad),
    translate: v3(e.emitter_translate),
    randomSeed: e.random_seed >>> 0,
    ptype: e.particle_type,
    typeOption: e.type_option,
    typeDir: e.type_dir,
    typeAxis: e.type_axis,
    typeOption0: e.type_option012[0],
    typeOption1: e.type_option012[1],
    typeOption2: e.type_option012[2],
    pivotX: e.pivot_pct[0],
    pivotY: e.pivot_pct[1],
    drawFlags: parseInt(d.flags_raw, 16),
    acmp: d.alpha_compare,
    tev: (d.tev_stages as J[]).slice(0, d.num_tev_stages).map((s) => ({
      colorIn: s.color_in,
      alphaIn: s.alpha_in,
      // the runtime loads the colour op into the alpha stage too (nw4r bug)
      op: s.color_op.op,
      bias: s.color_op.bias,
      scale: s.color_op.scale,
      clamp: s.color_op.clamp,
      dest: s.color_op.dest,
      kcsel: s.konst_color_sel,
      kasel: s.konst_alpha_sel,
    })),
    blend: d.blend,
    regs: d.color_input.tev_registers_C0_C2,
    konst: d.color_input.tev_konst_K0_K3,
    zCompare: d.z_compare,
    flick: { type: FLICK[d.alpha_flick.type] ?? 0, cycle: d.alpha_flick.cycle, random: d.alpha_flick.random, amplitude: d.alpha_flick.amplitude },
    colors: col,
    size: [p.size[0], p.size[1]],
    pscale: [p.scale[0], p.scale[1]],
    prot: [p.rotate_rad[0], p.rotate_rad[1], p.rotate_rad[2]],
    texScale: (p.texture_scale as number[][]).flat(),
    texRot: [...p.texture_rotate],
    texTrans: (p.texture_translate as number[][]).flat(),
    texWrap,
    texReverse: p.texture_reverse_raw,
    acmpRef0: p.acmp_ref0,
    acmpRef1: p.acmp_ref1,
    textures: [p.textures.layer1, p.textures.layer2, p.textures.indirect],
    ptclTracks: tracks(e.particle_tracks),
    emitTracks: tracks(e.emitter_tracks),
    numPtclInit: (e.particle_tracks as J[]).filter((t) => t.init_only).length,
    numEmitInit: (e.emitter_tracks as J[]).filter((t) => t.init_only).length,
  }
}
