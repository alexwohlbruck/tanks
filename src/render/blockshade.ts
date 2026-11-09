// Block shadows on the floor, computed from the whole block grid at once (not in the original:
// the disc puts one blurred decal under every block, picked by its neighbours, which breaks up
// into a zigzag along long runs of blocks and a grey halo round single ones).
//
// One low-resolution mask over the field, two channels:
//   red    the shadow each block casts away from the key light (scene.ts KEY_DIR: down and to
//          the right on screen), as long as the block is tall, softened at the edges
//   green  contact shade: a narrow dark band hugging every block's base
// drawn on a transparent plane just above the floor. With real-time shadow maps (ultra) the
// cast shadow comes from the light itself, so only the contact shade is drawn.

import * as THREE from 'three/webgpu'
import { float, max, texture, uv, vec4 } from 'three/tsl'
import { Cell, type World } from '../sim/world'

/** mask texels: about this many in all (the campaign's small field gets finer texels than a big
 * arena), between MIN_PX and MAX_PX per world unit */
const BUDGET = 600_000
const MIN_PX = 0.25
const MAX_PX = 0.6
/** horizontal shadow offset per unit of block height: KEY_DIR (-0.3, 1, -0.35) projected */
const CAST = { x: 0.36, z: 0.42 }
/** how dark a full cast shadow / contact shade makes the floor */
const CAST_DARK = 0.36
const CONTACT_DARK = 0.26
/** contact band width and the blur radius (world units) */
const CONTACT = 7
const BLUR = 7

export class BlockShade {
  mesh: THREE.Mesh
  private canvas = document.createElement('canvas')
  private tex: THREE.CanvasTexture
  private castOn = true

  constructor() {
    this.tex = new THREE.CanvasTexture(this.canvas)
    this.tex.colorSpace = THREE.NoColorSpace
    this.tex.generateMipmaps = false
    this.tex.minFilter = THREE.LinearFilter
    this.tex.magFilter = THREE.LinearFilter
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material())
    this.mesh.rotation.x = -Math.PI / 2
    // just above the floor, pulled toward the camera (the big arena floor won the depth test
    // at a hair's height)
    this.mesh.position.y = 1
    this.mesh.renderOrder = -1
    this.mesh.frustumCulled = false
  }

  /** `cast`: draw the cast shadow (off when shadow maps do it) */
  setCast(on: boolean) {
    if (on === this.castOn) return
    this.castOn = on
    this.mesh.material = this.material()
  }

  private material() {
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
    const k = texture(this.tex, uv())
    const cast = this.castOn ? k.r.mul(CAST_DARK) : float(0)
    m.colorNode = vec4(0, 0, 0, max(cast, k.g.mul(CONTACT_DARK)))
    return m
  }

  /** redraw the mask for the world's blocks (`skip`: cells drawn by something else) */
  build(w: World, skip: (code: number) => boolean = () => false) {
    const cell = 35
    const W = w.width * cell
    const D = w.height * cell
    const margin = cell * 2
    const PX = Math.max(MIN_PX, Math.min(MAX_PX, Math.sqrt(BUDGET / ((W + 2 * margin) * (D + 2 * margin)))))
    const cw = Math.ceil((W + 2 * margin) * PX)
    const ch = Math.ceil((D + 2 * margin) * PX)
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw
      this.canvas.height = ch
      // a new size needs a new GPU texture
      this.tex.dispose()
      this.tex = new THREE.CanvasTexture(this.canvas)
      this.tex.colorSpace = THREE.NoColorSpace
      this.tex.generateMipmaps = false
      this.tex.minFilter = THREE.LinearFilter
      this.mesh.material = this.material()
    }
    const g = this.canvas.getContext('2d', { willReadFrequently: true })!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = '#000'
    g.fillRect(0, 0, cw, ch)
    // world -> mask: x0 = -W/2 - margin
    g.setTransform(PX, 0, 0, PX, (W / 2 + margin) * PX, (D / 2 + margin) * PX)
    g.globalCompositeOperation = 'lighter'
    const h = cell / 2
    for (let r = 0; r < w.height; r++)
      for (let c = 0; c < w.width; c++) {
        const gc = w.grid[r][c]
        if (gc.kind !== Cell.Block && gc.kind !== Cell.Cork) continue
        if (skip(gc.code)) continue
        const p = w.cellCenter(c, r)
        const x0 = p.x - h, x1 = p.x + h, z0 = p.z - h, z1 = p.z + h
        // cast: the footprint swept along the light (a hexagon), red
        const len = gc.height * 17.5
        const dx = CAST.x * len, dz = CAST.z * len
        g.fillStyle = 'rgb(255,0,0)'
        g.beginPath()
        g.moveTo(x0, z0)
        g.lineTo(x1, z0)
        g.lineTo(x1 + dx, z0 + dz)
        g.lineTo(x1 + dx, z1 + dz)
        g.lineTo(x0 + dx, z1 + dz)
        g.lineTo(x0, z1)
        g.closePath()
        g.fill()
        // contact: the footprint grown a little, green
        g.fillStyle = 'rgb(0,255,0)'
        g.fillRect(x0 - CONTACT, z0 - CONTACT, cell + 2 * CONTACT, cell + 2 * CONTACT)
      }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'source-over'
    blur(g, cw, ch, Math.max(1, Math.round(BLUR * PX)))
    this.mesh.scale.set(W + 2 * margin, D + 2 * margin, 1)
    this.mesh.position.x = 0
    this.mesh.position.z = 0
    this.tex.needsUpdate = true
  }

  dispose() {
    this.tex.dispose()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}

/** three box-blur passes each way (about a gaussian), on the red and green channels */
function blur(g: CanvasRenderingContext2D, w: number, h: number, r: number) {
  const img = g.getImageData(0, 0, w, h)
  const d = img.data
  const tmp = new Float32Array(Math.max(w, h))
  for (const ch of [0, 1]) {
    for (let pass = 0; pass < 3; pass++) {
      // rows
      for (let y = 0; y < h; y++) line(d, y * w * 4 + ch, 4, w, r, tmp)
      // columns
      for (let x = 0; x < w; x++) line(d, x * 4 + ch, w * 4, h, r, tmp)
    }
  }
  g.putImageData(img, 0, 0)
}

function line(d: Uint8ClampedArray, start: number, stride: number, n: number, r: number, tmp: Float32Array) {
  let sum = 0
  const at = (i: number) => d[start + Math.max(0, Math.min(n - 1, i)) * stride]
  for (let i = -r; i <= r; i++) sum += at(i)
  const k = 1 / (2 * r + 1)
  for (let i = 0; i < n; i++) {
    tmp[i] = sum * k
    sum += at(i + r + 1) - at(i - r)
  }
  for (let i = 0; i < n; i++) d[start + i * stride] = tmp[i]
}
