// [arena] The floor of a big field (any number of 35-unit cells): the disc's floor textures
// tiled at their original scale (one texture repeat per 840 x 665 units, like tnk_field_16_9),
// with the tread-mark capture split into chunks so a stamp only re-uploads the chunk it lands
// in. Around it, the lower floor texture darkened, so the edge of the world isn't a void.
// Scorch marks (nukes) share the capture: red holds the tread marks as before, green / red is
// how unburned the floor is (a scorch multiplies green only, so later tread marks keep it).

import * as THREE from 'three/webgpu'
import { clamp, float, max, mix, texture, uv, vec3, vec4 } from 'three/tsl'
import type { Models } from './models'
import type { RenderOptions } from './quality'
import type { TreadCapture } from './tread'

/** world units per chunk side, and capture texels per unit */
const CHUNK = 640
const PX = 1
const FLUSH_EVERY = 4
const REPEAT = { x: 840, z: 665 }

type Chunk = { x0: number; z0: number; w: number; d: number; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture; mesh: THREE.Mesh; dirty: boolean }

export class BigField {
  group = new THREE.Group()
  private chunks: Chunk[] = []
  private outer: THREE.Mesh | null = null
  private since = 0

  constructor(
    private models: Models,
    private tread: TreadCapture,
    /** floor area (the field plus a one-cell margin like the disc's floor model) */
    public width: number,
    public depth: number,
  ) {
    const W = width, D = depth
    for (let z0 = -D / 2; z0 < D / 2 - 0.01; z0 += CHUNK)
      for (let x0 = -W / 2; x0 < W / 2 - 0.01; x0 += CHUNK) {
        const w = Math.min(CHUNK, W / 2 - x0)
        const d = Math.min(CHUNK, D / 2 - z0)
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(w * PX)
        canvas.height = Math.ceil(d * PX)
        const ctx = canvas.getContext('2d')!
        const tex = new THREE.CanvasTexture(canvas)
        tex.colorSpace = THREE.NoColorSpace
        tex.flipY = false
        tex.generateMipmaps = false
        tex.minFilter = THREE.LinearFilter
        const geo = quad(x0, z0, w, d)
        const mesh = new THREE.Mesh(geo)
        mesh.receiveShadow = true
        this.chunks.push({ x0, z0, w, d, canvas, ctx, tex, mesh, dirty: true })
        this.group.add(mesh)
      }
    this.clear()
  }

  /** (re)builds the materials for the current options */
  setOptions(o: RenderOptions) {
    const [face, lower] = this.models.floorTex()
    const lit = o.lighting === 'enhanced'
    for (const c of this.chunks) {
      ;(c.mesh.material as THREE.Material | undefined)?.dispose?.()
      const m = lit ? new THREE.MeshLambertNodeMaterial() : new THREE.MeshBasicNodeMaterial()
      const k = texture(c.tex, uv())
      const floor = mix(texture(lower, uv(1)).rgb, texture(face, uv(1)).rgb, k.r)
      // burned: towards charcoal, a little warm at the rim
      const burn = clamp(float(1).sub(k.g.div(max(k.r, 0.08))), 0, 1)
      const char = mix(vec3(0.33, 0.2, 0.11), vec3(0.06, 0.05, 0.045), burn)
      m.colorNode = vec4(mix(floor, floor.mul(char), burn), 1)
      c.mesh.material = m
    }
    // the world beyond the border
    if (this.outer) {
      this.group.remove(this.outer)
      ;(this.outer.material as THREE.Material).dispose()
    }
    const M = 2400
    const m = lit ? new THREE.MeshLambertNodeMaterial() : new THREE.MeshBasicNodeMaterial()
    m.colorNode = vec4(texture(lower, uv(1)).rgb.mul(vec3(0.42, 0.38, 0.36)), 1)
    this.outer = new THREE.Mesh(quad(-this.width / 2 - M, -this.depth / 2 - M, this.width + 2 * M, this.depth + 2 * M, -0.6), m)
    this.outer.receiveShadow = true
    this.group.add(this.outer)
  }

  clear() {
    for (const c of this.chunks) {
      c.ctx.setTransform(1, 0, 0, 1, 0, 0)
      c.ctx.fillStyle = '#fff'
      c.ctx.fillRect(0, 0, c.canvas.width, c.canvas.height)
      c.dirty = true
    }
  }

  /** one 30 x 30 mark, in every chunk it touches */
  stamp(mark: string, x: number, z: number, dirX: number, dirZ: number) {
    const im = this.tread.markImage(mark)
    if (!im) return
    for (const c of this.chunks) {
      if (x + 22 < c.x0 || x - 22 > c.x0 + c.w || z + 22 < c.z0 || z - 22 > c.z0 + c.d) continue
      const g = c.ctx
      g.setTransform(PX, 0, 0, PX, (x - c.x0) * PX, (z - c.z0) * PX)
      g.rotate(Math.atan2(dirZ, dirX) + Math.PI / 2)
      g.drawImage(im, -15, -15, 30, 30)
      c.dirty = true
    }
  }

  /** a burned circle of radius `r`: dark in the middle, ragged at the edge */
  scorch(x: number, z: number, r: number) {
    const blobs: [number, number, number, number][] = [[0, 0, r * 0.95, 0.95]]
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const d = r * (0.45 + Math.random() * 0.45)
      blobs.push([Math.cos(a) * d, Math.sin(a) * d, r * (0.2 + Math.random() * 0.25), 0.55 + Math.random() * 0.3])
    }
    for (const c of this.chunks) {
      if (x + r * 1.3 < c.x0 || x - r * 1.3 > c.x0 + c.w || z + r * 1.3 < c.z0 || z - r * 1.3 > c.z0 + c.d) continue
      const g = c.ctx
      g.save()
      g.setTransform(PX, 0, 0, PX, (x - c.x0) * PX, (z - c.z0) * PX)
      g.globalCompositeOperation = 'multiply'
      for (const [bx, bz, br, k] of blobs) {
        const grad = g.createRadialGradient(bx, bz, 0, bx, bz, br)
        const lo = Math.round(255 * (1 - k))
        grad.addColorStop(0, `rgb(255,${lo},${lo})`)
        grad.addColorStop(0.55, `rgb(255,${Math.round(lo + (255 - lo) * 0.35)},${Math.round(lo + (255 - lo) * 0.35)})`)
        grad.addColorStop(1, 'rgb(255,255,255)')
        g.fillStyle = grad
        g.beginPath()
        g.arc(bx, bz, br, 0, Math.PI * 2)
        g.fill()
      }
      g.restore()
      c.dirty = true
    }
  }

  flush() {
    if (++this.since < FLUSH_EVERY) return
    this.since = 0
    for (const c of this.chunks)
      if (c.dirty) {
        c.tex.needsUpdate = true
        c.dirty = false
      }
  }

  dispose() {
    for (const c of this.chunks) {
      c.tex.dispose()
      c.mesh.geometry.dispose()
      ;(c.mesh.material as THREE.Material).dispose()
    }
    this.outer?.geometry.dispose()
  }
}

/** a floor quad on y = `y`: uv 0..1 over the quad (tread), uv1 in floor-texture repeats */
function quad(x0: number, z0: number, w: number, d: number, y = 0) {
  const g = new THREE.BufferGeometry()
  const xs = [x0, x0 + w, x0, x0 + w]
  const zs = [z0, z0, z0 + d, z0 + d]
  g.setAttribute('position', new THREE.Float32BufferAttribute(xs.flatMap((x, i) => [x, y, zs[i]]), 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2))
  g.setAttribute('uv1', new THREE.Float32BufferAttribute(xs.flatMap((x, i) => [x / REPEAT.x + 0.5, zs[i] / REPEAT.z + 0.5]), 2))
  g.setIndex([0, 2, 1, 1, 2, 3])
  return g
}
