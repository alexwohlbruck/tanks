// Visuals of the added enemy types (ids 10+): which original tank model to start from and how
// to paint it. Minimal version (may be replaced by the renderer's full registry): registration,
// lookup, and a livery applied as TSL node materials on the converted ROM model.

import * as THREE from 'three/webgpu'
import { dot, float, mix, uniform, vec3, vec4 } from 'three/tsl'

export type TankVisual = {
  /** original enemy type 1-9 whose model / tread marks are reused */
  baseModel: number
  /** body colour (CSS) */
  livery: string
  /** turret colour (CSS) */
  accent: string
  /** model scale relative to the original 1.6 */
  scale: number
  /** added glow colour (CSS) or null */
  emissive: string | null
}

const visuals = new Map<number, TankVisual>()

export function registerTankVisual(type: number, v: Partial<TankVisual> & { livery: string }) {
  visuals.set(type, { baseModel: 8, accent: v.livery, scale: 1, emissive: null, ...v })
}

export function tankVisual(type: number): TankVisual | undefined {
  return visuals.get(type)
}

const mats = new Map<string, THREE.Material>()

/** repaints a freshly cloned tank model: body / cannon meshes get livery / accent */
export function applyTankVisual(root: THREE.Object3D, v: TankVisual) {
  root.scale.setScalar(v.scale)
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const src = mesh.material as THREE.MeshBasicNodeMaterial
    if (src.name !== 'tank_mat' || !src.colorNode) return
    const part = mesh.name.includes('cannon') ? 'cannon' : 'base'
    const key = `${v.livery}/${v.accent}/${v.emissive}/${part}/${src.uuid}`
    let m = mats.get(key)
    if (!m) {
      const nm = new THREE.MeshBasicNodeMaterial()
      nm.name = src.name
      nm.side = src.side
      nm.transparent = src.transparent
      nm.alphaTest = src.alphaTest
      const base = src.colorNode as ReturnType<typeof vec4>
      // keep the model's shading (texture luminance), recolour it
      const lum = dot(base.rgb, vec3(0.3, 0.59, 0.11))
      const tint = uniform(new THREE.Color(part === 'cannon' ? v.accent : v.livery))
      let rgb = mix(base.rgb, tint.mul(lum.mul(1.35)), float(0.88))
      if (v.emissive) rgb = rgb.add(uniform(new THREE.Color(v.emissive)).mul(0.35))
      nm.colorNode = vec4(rgb, base.a)
      mats.set(key, (m = nm))
    }
    mesh.material = m
  })
}
