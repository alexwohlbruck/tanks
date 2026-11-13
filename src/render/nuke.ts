// The arena's airstrike nuke: a Fat Man style bomb (a fat egg-shaped casing with a bolted
// band round its middle, a nose plate with impact fuzes, and a box tail of fins and braces),
// built from three.js primitives. The scene is unlit (GX colours: see models.ts), so the
// shading is baked into vertex colours with a fixed light from the upper left, the way the
// disc's models carry theirs. It falls tilted, nose first, so the camera above sees it side on.
//
// Units: the mine model's (a mine is about 17 across); the nose tip sits on the group's origin,
// so the group's y is the height of the tip above the floor.

import * as THREE from 'three/webgpu'

/** the casing's colours (raw: the renderer does no colour management) */
const PAINT = { body: [0.78, 0.66, 0.26], band: [0.18, 0.16, 0.12], tail: [0.66, 0.56, 0.22], nose: [0.24, 0.22, 0.18], bolt: [0.55, 0.52, 0.45], fuze: [0.75, 0.22, 0.16] } as const
/** where the light comes from (world space: up, a little left and toward the camera) */
const LIGHT = new THREE.Vector3(-0.45, 0.8, 0.4).normalize()

let geometry: THREE.BufferGeometry | null = null
let material: THREE.MeshBasicNodeMaterial | null = null

/** the tilt it falls at: the tail leans away from the camera (which looks down from the south)
 * and a little to the left, so the view sees it side on, nose toward the bottom of the screen */
const TILTED = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.8, 0, 0.35, 'ZXY'))

/** one part: placed (`at`, then tilted), coloured and lit (Lambert, a little ambient, a sheen) */
function part(geo: THREE.BufferGeometry, rgb: readonly number[], at: THREE.Matrix4, shine = 0.25) {
  const g = (geo.index ? geo.toNonIndexed() : geo).applyMatrix4(TILTED.clone().multiply(at))
  g.deleteAttribute('uv')
  const n = g.getAttribute('normal')
  const cols = new Float32Array(n.count * 3)
  const v = new THREE.Vector3()
  const half = new THREE.Vector3(0, 0.55, 1).normalize().add(LIGHT).normalize()
  for (let i = 0; i < n.count; i++) {
    v.fromBufferAttribute(n, i)
    const lam = Math.max(0, v.dot(LIGHT))
    const spec = Math.max(0, v.dot(half)) ** 24 * shine
    const k = 0.42 + 0.7 * lam
    for (let c = 0; c < 3; c++) cols[i * 3 + c] = Math.min(1, rgb[c] * k + spec)
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  return g
}

function build() {
  const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz))
  // built along +y with the nose at the origin (part() tilts each piece)
  const R = 9
  const bodyH = 23
  const mid = bodyH / 2
  const parts: THREE.BufferGeometry[] = []
  // the casing: an egg, a touch fuller toward the nose
  const egg = new THREE.SphereGeometry(R, 28, 20)
  const pos = egg.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R
    const s = 1 + 0.06 * (1 - y) * (1 + y) - 0.05 * y
    pos.setXYZ(i, pos.getX(i) * s, pos.getY(i), pos.getZ(i) * s)
  }
  egg.computeVertexNormals()
  parts.push(part(egg, PAINT.body, M(0, mid, 0, 0, 0, 0, 1, bodyH / (2 * R), 1)))
  // the bolted seam round its middle, and a thinner one each side
  parts.push(part(new THREE.TorusGeometry(R * 1.02, 0.7, 6, 36), PAINT.band, M(0, mid, 0, Math.PI / 2)))
  for (const dy of [-5.5, 5.5]) {
    const r = R * Math.sqrt(1 - (dy / mid) ** 2) * 1.03
    parts.push(part(new THREE.TorusGeometry(r, 0.35, 4, 32), PAINT.band, M(0, mid + dy, 0, Math.PI / 2)))
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    parts.push(part(new THREE.SphereGeometry(0.55, 6, 4), PAINT.bolt, M(Math.cos(a) * R * 1.07, mid, Math.sin(a) * R * 1.07), 0.6))
  }
  // the nose plate and its impact fuzes
  parts.push(part(new THREE.CylinderGeometry(4.2, 4.6, 1.4, 20), PAINT.nose, M(0, 1.3, 0)))
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    parts.push(part(new THREE.CylinderGeometry(0.6, 0.8, 1.6, 8), PAINT.fuze, M(Math.cos(a) * 2.6, 0.4, Math.sin(a) * 2.6), 0.5))
  }
  // the tail cone, and the box of fins round it with braces across the diagonals
  const top = bodyH
  parts.push(part(new THREE.CylinderGeometry(3.2, 6.2, 6, 20, 1, true), PAINT.tail, M(0, top + 1.6, 0)))
  const box = 8.4
  const finH = 7.5
  const finY = top + 4.6
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2
    parts.push(part(new THREE.BoxGeometry(box * 2, finH, 0.45), PAINT.tail, M(Math.sin(a) * box, finY, Math.cos(a) * box, 0, a), 0.04))
  }
  for (const a of [Math.PI / 4, -Math.PI / 4]) parts.push(part(new THREE.BoxGeometry(box * 2.7, finH * 0.85, 0.35), PAINT.band, M(0, finY, 0, 0, a), 0.1))
  // a dark rim round the top and bottom of the box
  for (const dy of [-finH / 2, finH / 2])
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2
      parts.push(part(new THREE.BoxGeometry(box * 2 + 0.6, 0.6, 0.7), PAINT.band, M(Math.sin(a) * box, finY + dy, Math.cos(a) * box, 0, a)))
    }
  return merge(parts)
}

/** the parts as one geometry */
function merge(parts: THREE.BufferGeometry[]) {
  let n = 0
  for (const g of parts) n += g.getAttribute('position').count
  const pos = new Float32Array(n * 3)
  const col = new Float32Array(n * 3)
  let o = 0
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3)
    col.set(g.getAttribute('color').array as Float32Array, o * 3)
    o += g.getAttribute('position').count
    g.dispose()
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('color', new THREE.BufferAttribute(col, 3))
  out.computeBoundingSphere()
  return out
}

/** a falling nuke (the geometry and material are shared by every one) */
export function nukeModel(): THREE.Object3D {
  geometry ??= build()
  material ??= new THREE.MeshBasicNodeMaterial({ vertexColors: true })
  const g = new THREE.Group()
  const mesh = new THREE.Mesh(geometry, material)
  g.add(mesh)
  g.userData.nuke = mesh
  return g
}

/** sway it a little as it falls (`t` seconds) */
export function swayNuke(o: THREE.Object3D, t: number) {
  const m = o.userData.nuke as THREE.Mesh | undefined
  if (!m) return
  m.rotation.z = Math.sin(t * 5.3) * 0.05
  m.rotation.x = Math.sin(t * 3.7) * 0.04
}
