// Curved PN triangles (Vlachos et al. 2001) on the CPU, for the 'high' / 'ultra' models.
//
// Every triangle's corners stay where they are; edges bow out along the cubic defined by
// the vertex normals, so the faceted silhouettes of the dome-like parts (1p/2p turrets,
// mine dome, the rounded border logs, the shell) become round while flat faces stay flat
// (normals perpendicular to an edge give a straight edge). Edges where the two sides
// disagree on the normals (hard creases, split vertices, the seam between two meshes) are
// kept straight, so the result has no cracks. Triangles with only straight edges are not
// subdivided at all.

import * as THREE from 'three/webgpu'

const EPS = 1e-4

type V = [number, number, number]

const key = (x: number, y: number, z: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`

/**
 * @param level  segments per edge for curved triangles (3 -> 9 triangles)
 * @param minBulge  edges whose control points move less than this fraction of their length stay straight
 */
export function pnTriangles(src: THREE.BufferGeometry, level = 3, minBulge = 0.02, maxDeviation = 32): THREE.BufferGeometry {
  const cosMax = Math.cos((maxDeviation * Math.PI) / 180)
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const nor = src.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!pos || !nor) return src
  const index = src.getIndex()
  const triCount = (index ? index.count : pos.count) / 3
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k)
  const P = (i: number): V => [pos.getX(i), pos.getY(i), pos.getZ(i)]
  const N = (i: number): V => {
    const x = nor.getX(i), y = nor.getY(i), z = nor.getZ(i)
    const l = Math.hypot(x, y, z) || 1
    return [x / l, y / l, z / l]
  }
  const pkey = (i: number) => key(pos.getX(i), pos.getY(i), pos.getZ(i))
  const nkey = (n: V) => key(n[0], n[1], n[2])

  // edge (by position) -> normals at its two ends as seen by each triangle
  const edges = new Map<string, { na: string; nb: string; count: number; smooth: boolean }>()
  const ekey = (a: number, b: number) => {
    const ka = pkey(a), kb = pkey(b)
    return ka < kb ? { k: ka + '|' + kb, a, b } : { k: kb + '|' + ka, a: b, b: a }
  }
  // A tessellated curved surface has vertex normals close to each face's normal (about half
  // the angle between facets). A bevelled box with averaged corner normals does not (~55 deg):
  // its edges stay straight, so boxes keep their silhouettes.
  const faceN = (t: number): V => {
    const [a, b, c] = [P(vi(t, 0)), P(vi(t, 1)), P(vi(t, 2))]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const l = Math.hypot(...n) || 1
    return [n[0] / l, n[1] / l, n[2] / l]
  }
  for (let t = 0; t < triCount; t++) {
    const fn = faceN(t)
    for (let e = 0; e < 3; e++) {
      const { k, a, b } = ekey(vi(t, e), vi(t, (e + 1) % 3))
      const Na = N(a), Nb = N(b)
      const close = Na[0] * fn[0] + Na[1] * fn[1] + Na[2] * fn[2] > cosMax && Nb[0] * fn[0] + Nb[1] * fn[1] + Nb[2] * fn[2] > cosMax
      const na = nkey(Na), nb = nkey(Nb)
      const ex = edges.get(k)
      if (!ex) edges.set(k, { na, nb, count: 1, smooth: close })
      else {
        ex.count++
        if (ex.na !== na || ex.nb !== nb || !close) ex.smooth = false
      }
    }
  }
  const curved = (a: number, b: number) => {
    const e = edges.get(ekey(a, b).k)!
    return e.smooth && e.count === 2
  }

  // attributes copied / interpolated per output vertex
  const names = Object.keys(src.attributes).filter((n) => n !== 'position' && n !== 'normal')
  const outPos: number[] = [], outNor: number[] = []
  const outAttr: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]))
  const attrs = names.map((n) => src.getAttribute(n) as THREE.BufferAttribute)

  const emit = (p: V, n: V, w: [number, number, number], ids: [number, number, number]) => {
    outPos.push(p[0], p[1], p[2])
    const l = Math.hypot(n[0], n[1], n[2]) || 1
    outNor.push(n[0] / l, n[1] / l, n[2] / l)
    names.forEach((name, k) => {
      const a = attrs[k]
      for (let c = 0; c < a.itemSize; c++) outAttr[name].push(a.getComponent(ids[0], c) * w[0] + a.getComponent(ids[1], c) * w[1] + a.getComponent(ids[2], c) * w[2])
    })
  }

  const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const lin = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

  for (let t = 0; t < triCount; t++) {
    const ids: [number, number, number] = [vi(t, 0), vi(t, 1), vi(t, 2)]
    const p = ids.map(P) as [V, V, V]
    const n = ids.map(N) as [V, V, V]
    // edge control points b_ij (near i) and b_ji (near j); straight unless curved
    const ctrl = (i: number, j: number): V => {
      const straight = lin(p[i], p[j], 1 / 3)
      if (!curved(ids[i], ids[j])) return straight
      const w = dot(sub(p[j], p[i]), n[i])
      return [(2 * p[i][0] + p[j][0] - w * n[i][0]) / 3, (2 * p[i][1] + p[j][1] - w * n[i][1]) / 3, (2 * p[i][2] + p[j][2] - w * n[i][2]) / 3]
    }
    const b210 = ctrl(0, 1), b120 = ctrl(1, 0)
    const b021 = ctrl(1, 2), b012 = ctrl(2, 1)
    const b102 = ctrl(2, 0), b201 = ctrl(0, 2)
    // bulge test: distance of the control points from the straight-edge thirds
    let bulge = 0
    const lenMax = Math.max(Math.hypot(...sub(p[1], p[0])), Math.hypot(...sub(p[2], p[1])), Math.hypot(...sub(p[0], p[2])), EPS)
    for (const [c, a, b, f] of [
      [b210, 0, 1, 1 / 3], [b120, 0, 1, 2 / 3], [b021, 1, 2, 1 / 3], [b012, 1, 2, 2 / 3], [b102, 2, 0, 1 / 3], [b201, 2, 0, 2 / 3],
    ] as [V, number, number, number][])
      bulge = Math.max(bulge, Math.hypot(...sub(c, lin(p[a], p[b], f))))
    if (bulge < minBulge * lenMax) {
      for (let k = 0; k < 3; k++) emit(p[k], n[k], [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0], ids)
      continue
    }
    const E: V = [0, 1, 2].map((c) => (b210[c] + b120[c] + b021[c] + b012[c] + b102[c] + b201[c]) / 6) as V
    const Vc: V = [0, 1, 2].map((c) => (p[0][c] + p[1][c] + p[2][c]) / 3) as V
    const b111: V = [0, 1, 2].map((c) => E[c] + (E[c] - Vc[c]) / 2) as V
    const at = (u: number, v: number, w: number): V => {
      const r: V = [0, 0, 0]
      for (let c = 0; c < 3; c++)
        r[c] =
          p[0][c] * w * w * w + p[1][c] * u * u * u + p[2][c] * v * v * v +
          3 * (b210[c] * w * w * u + b120[c] * w * u * u + b201[c] * w * w * v + b021[c] * u * u * v + b102[c] * w * v * v + b012[c] * u * v * v) +
          6 * b111[c] * w * u * v
      return r
    }
    const nAt = (u: number, v: number, w: number): V => [0, 1, 2].map((c) => n[0][c] * w + n[1][c] * u + n[2][c] * v) as V
    const L = level
    const vert = (i: number, j: number) => {
      // i steps toward p1, j toward p2
      const u = i / L, v = j / L, w = 1 - u - v
      return { p: at(u, v, w), n: nAt(u, v, w), b: [w, u, v] as [number, number, number] }
    }
    for (let j = 0; j < L; j++)
      for (let i = 0; i < L - j; i++) {
        const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1)
        for (const q of [a, b, c]) emit(q.p, q.n, q.b, ids)
        if (i + j < L - 1) {
          const d = vert(i + 1, j + 1)
          for (const q of [b, d, c]) emit(q.p, q.n, q.b, ids)
        }
      }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3))
  names.forEach((name, k) => g.setAttribute(name, new THREE.Float32BufferAttribute(outAttr[name], attrs[k].itemSize)))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  g.userData = { ...src.userData, pn: true }
  return g
}
