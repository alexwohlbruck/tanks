// The arena's airstrike nuke: a Fat Man style bomb (a fat egg-shaped casing with a bolted
// band round its middle, a nose plate with impact fuzes, and a box tail of fins and braces),
// built from three.js primitives. The scene is unlit (GX colours: see models.ts), so it shades
// itself: its material lights the paint (vertex colours) from a fixed light at the upper left,
// in world space, so the light stays put as it turns. It falls tilted, nose first, so the
// camera above sees it side on, spinning about its own axis and tumbling a little.
//
// Units: the mine model's (a mine is about 17 across); the nose tip sits on the group's origin,
// so the group's y is the height of the tip above the floor.

import * as THREE from 'three/webgpu'
import { attribute, dot, float, max, min, normalWorld, pow, uniform, vec3, vec4 } from 'three/tsl'

/** the casing's colours: olive drab with black seams and a red stripe toward the tail (raw:
 * the renderer does no colour management) */
const PAINT = { body: [0.36, 0.4, 0.24], band: [0.1, 0.1, 0.09], tail: [0.27, 0.3, 0.19], nose: [0.2, 0.2, 0.19], bolt: [0.62, 0.6, 0.55], fuze: [0.82, 0.18, 0.12], stripe: [0.8, 0.16, 0.12] } as const
/** where the light comes from (world space: up, a little left and toward the camera) */
const LIGHT = new THREE.Vector3(-0.45, 0.8, 0.4).normalize()

let geometry: THREE.BufferGeometry | null = null
let material: THREE.MeshBasicNodeMaterial | null = null

/**
 * How it falls: tilted (`tilt`, radians: the tail leans away from the camera, which looks down
 * from the south, and a little to the left, so the view sees it side on, nose toward the bottom
 * of the screen), spinning about its own axis (`spin`, radians a second) and tumbling a little
 * either way (`tumble` radians, at `rate` and a bit more, radians a second).
 */
const FALL = { tilt: new THREE.Euler(-0.8, 0, 0.35, 'ZXY'), spin: 2.6, tumble: 0.14, rate: 3.1 }
/** the half-way vector for the sheen (the camera above and to the south) */
const HALF = new THREE.Vector3(0, 0.55, 1).normalize().add(LIGHT).normalize()

/** one part: placed (`at`), painted, and how much it shines */
function part(geo: THREE.BufferGeometry, rgb: readonly number[], at: THREE.Matrix4, shine = 0.25) {
  const g = (geo.index ? geo.toNonIndexed() : geo).applyMatrix4(at)
  g.deleteAttribute('uv')
  const n = g.getAttribute('position').count
  const cols = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) cols.set(rgb, i * 3)
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3))
  g.setAttribute('shine', new THREE.BufferAttribute(new Float32Array(n).fill(shine), 1))
  return g
}

/** the paint lit in world space: Lambert from LIGHT, a little ambient, a sheen */
function shaded() {
  // (the paint is read here: vertexColors would multiply it in a second time)
  const m = new THREE.MeshBasicNodeMaterial()
  const n = normalWorld.normalize()
  const lam = max(dot(n, uniform(LIGHT)), float(0))
  const spec = pow(max(dot(n, uniform(HALF)), float(0)), float(24)).mul(attribute('shine', 'float'))
  m.colorNode = vec4(min(attribute('color', 'vec3').mul(lam.mul(0.7).add(0.42)).add(spec), vec3(1)), 1)
  return m
}

function build() {
  const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz))
  // built along +y with the nose at the origin
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
  // the bolted seam round its middle, a thinner one toward the nose and a red stripe toward
  // the tail
  parts.push(part(new THREE.TorusGeometry(R * 1.02, 0.7, 6, 36), PAINT.band, M(0, mid, 0, Math.PI / 2)))
  for (const dy of [-5.5, 5.5]) {
    const r = R * Math.sqrt(1 - (dy / mid) ** 2) * 1.03
    parts.push(part(new THREE.TorusGeometry(r, dy > 0 ? 0.75 : 0.35, 6, 32), dy > 0 ? PAINT.stripe : PAINT.band, M(0, mid + dy, 0, Math.PI / 2), dy > 0 ? 0.4 : 0.25))
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
  const out = new THREE.BufferGeometry()
  for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3], ['shine', 1]] as const) {
    const a = new Float32Array(n * size)
    let o = 0
    for (const g of parts) {
      a.set(g.getAttribute(name).array as Float32Array, o * size)
      o += g.getAttribute('position').count
    }
    out.setAttribute(name, new THREE.BufferAttribute(a, size))
  }
  for (const g of parts) g.dispose()
  out.computeBoundingSphere()
  return out
}

/** a falling nuke (the geometry and material are shared by every one): the group, a tilt
 * about its nose, and the bomb spinning in it */
export function nukeModel(): THREE.Object3D {
  geometry ??= build()
  material ??= shaded()
  const g = new THREE.Group()
  const tilt = new THREE.Group()
  const mesh = new THREE.Mesh(geometry, material)
  tilt.add(mesh)
  g.add(tilt)
  g.userData.nuke = { tilt, mesh }
  return g
}

/** spin and tumble it as it falls (`t` seconds) */
export function swayNuke(o: THREE.Object3D, t: number) {
  const n = o.userData.nuke as { tilt: THREE.Object3D; mesh: THREE.Mesh } | undefined
  if (!n) return
  const { tilt, spin, tumble, rate } = FALL
  n.tilt.rotation.set(tilt.x + Math.sin(t * rate) * tumble, 0, tilt.z + Math.sin(t * rate * 1.37 + 1) * tumble, 'ZXY')
  n.mesh.rotation.y = t * spin
}
