// The floor's tread-mark capture (RPTnkField view 0 into "caterpillar"): white where
// untouched, marks stamped as 30x30 quads. It covers the floor model's UV range (840 x 665 for
// 16:9, 630 x 665 for 4:3; u along +x, v along +z), `px` texels per world unit.
//
// A 2D canvas uploaded as a texture. (A GPU render-target version was tried: on the WebGL2
// backend, targets that are both sampled by the floor and drawn into lost their contents
// inside the full game frame, so the canvas stays.) Uploads are batched: at most one every
// FLUSH_EVERY frames, which the eye can't tell from the original per-frame stamping.

import * as THREE from 'three/webgpu'
import type { HiresTextures } from './hires'
import type { TreadMark } from './registry'

const DISC_MARKS = ['1p', '2p', 'e_1', 'e_2', 'e_3', 'e_4', 'e_5', 'e_6', 'e_7', 'e_8', 'e_9'] as const
const FLUSH_EVERY = 2

type Mark = CanvasImageSource

/** P3 / P4 marks (no disc texture): studs and chevrons on the 1p dash layout (64-grid, x 1-18, y 26-37) */
function drawPlayerMark(kind: 'p3' | 'p4') {
  const S = 4
  const c = document.createElement('canvas')
  c.width = c.height = 64 * S
  const g = c.getContext('2d')!
  g.scale(S, S)
  g.fillStyle = 'rgba(34,34,34,0.87)'
  for (const x0 of [1, 45]) {
    if (kind === 'p3') {
      // two studs per track
      for (const dx of [0, 10]) {
        g.beginPath()
        g.roundRect(x0 + dx, 27, 8, 10, 1.5)
        g.fill()
      }
    } else {
      // chevron pointing forward (image up = forward)
      g.beginPath()
      g.moveTo(x0, 33)
      g.lineTo(x0 + 9, 25)
      g.lineTo(x0 + 18, 33)
      g.lineTo(x0 + 18, 38)
      g.lineTo(x0 + 9, 30)
      g.lineTo(x0, 38)
      g.closePath()
      g.fill()
    }
  }
  return c
}

export class TreadCapture {
  canvas = document.createElement('canvas')
  private ctx: CanvasRenderingContext2D
  texture: THREE.CanvasTexture
  private marks = new Map<string, Mark>()
  private dirty = false
  private sinceFlush = 0
  private w = 840
  private readonly d = 665

  constructor(public px = 2) {
    this.ctx = this.canvas.getContext('2d')!
    this.texture = this.makeTexture()
    this.resizeCanvas()
  }

  private makeTexture() {
    const t = new THREE.CanvasTexture(this.canvas)
    t.colorSpace = THREE.NoColorSpace
    t.flipY = false
    t.generateMipmaps = false
    t.minFilter = THREE.LinearFilter
    return t
  }

  /** size the canvas for w x d at px; true when the texture object was replaced */
  private resizeCanvas() {
    const W = Math.round(this.w * this.px), H = Math.round(this.d * this.px)
    if (this.canvas.width === W && this.canvas.height === H) return false
    // keep what is drawn (resolution change mid-stage)
    const old = this.canvas.width > 1 ? this.copy() : null
    this.canvas.width = W
    this.canvas.height = H
    this.texture.dispose()
    this.texture = this.makeTexture()
    this.clear()
    if (old) this.ctx.drawImage(old, 0, 0, W, H)
    return true
  }

  private copy() {
    const c = document.createElement('canvas')
    c.width = this.canvas.width
    c.height = this.canvas.height
    c.getContext('2d')!.drawImage(this.canvas, 0, 0)
    return c
  }

  /** disc marks (hi-res when available) + the P3/P4 marks */
  async load(hires: HiresTextures | null) {
    await Promise.all(
      DISC_MARKS.map(async (k) => {
        const t = hires ? await hires.get(`tread/${k}`) : null
        let im: Mark | null = (t?.image as Mark) ?? null
        if (!im) {
          const el = new Image()
          el.src = `assets/effects/tread_marks/tnk_mark_${k}.png`
          im = await el.decode().then(() => el)
        }
        this.marks.set(k, im!)
      }),
    )
    this.marks.set('p3', drawPlayerMark('p3'))
    this.marks.set('p4', drawPlayerMark('p4'))
  }

  /** a loaded mark image ([arena] the big field stamps its own chunks) */
  markImage(k: string) {
    return this.marks.get(k) ?? this.marks.get('1p')
  }

  /** add or replace a mark image (registered tank types) */
  setMark(k: TreadMark | string, im: Mark) {
    this.marks.set(k, im)
  }

  setSize(aspect: '16_9' | '4_3') {
    this.w = aspect === '16_9' ? 840 : 630
    this.resizeCanvas()
    this.clear()
  }

  /** texels per world unit; existing marks are resampled */
  setResolution(px: number) {
    if (px === this.px) return
    this.px = px
    this.resizeCanvas()
  }

  clear() {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.fillStyle = '#fff'
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    this.dirty = true
    this.sinceFlush = FLUSH_EVERY
  }

  /** RPTnkTank::DrawTreadMark: quad y axis along the body forward */
  stamp(mark: string, x: number, z: number, dirX: number, dirZ: number) {
    const im = this.marks.get(mark) ?? this.marks.get('1p')
    if (!im) return
    const P = this.px
    const c = this.ctx
    c.setTransform(P, 0, 0, P, (x + this.w / 2) * P, (z + this.d / 2) * P)
    c.rotate(Math.atan2(dirZ, dirX) + Math.PI / 2)
    c.drawImage(im, -15, -15, 30, 30)
    this.dirty = true
  }

  /** upload pending stamps (at most once per FLUSH_EVERY calls) */
  flush() {
    this.sinceFlush++
    if (this.dirty && this.sinceFlush >= FLUSH_EVERY) {
      this.texture.needsUpdate = true
      this.dirty = false
      this.sinceFlush = 0
    }
  }
}
