// Dev page for src/render/effects.ts, seen from the game camera over the wood floor.
//   /effects.html                         grid of the gameplay effects
//   /effects.html?name=Tnk_mine_bomb      one effect at the centre
//   &frame=N   step N 60 Hz updates, render once, title = 'done' (default 20)
//   &anim      play in real time, respawning
//   &frames=1,4,8,16  contact strip: one copy per frame count, side by side
//   &zoom=2    narrower view;  &x=..&z=.. look-at offset
//   &scale=1.6 &color=r,g,b &light (undarkened floor) &webgl (WebGL2 backend)
import * as THREE from 'three/webgpu'
import { Effects, TANK_PIECE_COLORS, type EffectHandle } from '../render/effects'

const q = new URLSearchParams(location.search)
const canvas = document.getElementById('c') as HTMLCanvasElement
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: q.has('webgl') })
renderer.outputColorSpace = THREE.LinearSRGBColorSpace
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight, false)
await renderer.init()

const scene = new THREE.Scene()
scene.background = new THREE.Color(0, 0, 0)
// RPTnkCamera fixed view: eye (0, 1338.26, 1472.29) -> (0, 0, -14), 42 degrees
const a = (42 * Math.PI) / 180
const zoom = Number(q.get('zoom') ?? 1)
const cx = Number(q.get('x') ?? 0), cz = Number(q.get('z') ?? 0)
const cam = new THREE.OrthographicCamera(-468 / zoom, 468 / zoom, 256.5 / zoom, -256.5 / zoom, 10, 100000)
cam.position.set(cx, 2000 * Math.sin(a), 2000 * Math.cos(a) - 14 + cz)
cam.up.set(0, Math.cos(a), -Math.sin(a))
cam.lookAt(cx, 0, -14 + cz)

// floor
const floorTex = await new THREE.TextureLoader().loadAsync('assets/models/textures/tnk_field_16_9/floor_face.png')
floorTex.colorSpace = THREE.NoColorSpace
floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping
floorTex.repeat.set(1, 1)
const floorMat = new THREE.MeshBasicNodeMaterial({ map: floorTex })
floorMat.color.setScalar(q.has('light') ? 1 : 0.42)
const floor = new THREE.Mesh(new THREE.PlaneGeometry(22 * 35 * 1.3, 17 * 35 * 1.3), floorMat)
floor.rotation.x = -Math.PI / 2
scene.add(floor)

const fx = new Effects(scene)
await fx.load()

const name = q.get('name')
const strip = q.get('frames')?.split(',').map(Number)
const frames = strip ? Math.max(...strip) : Number(q.get('frame') ?? 20)
const scaleQ = q.has('scale') ? Number(q.get('scale')) : undefined
const colorQ = q.get('color')?.split(',').map(Number) as [number, number, number] | undefined

interface Item {
  name: string
  delay?: number
  label?: string
  x: number
  z: number
  scale?: number
  color?: [number, number, number]
  extra?: string[]
}
const items: Item[] = name && strip
  ? strip.map((f, i) => ({
      name,
      x: cx + ((i + 0.5) / strip.length - 0.5) * (900 / zoom),
      z: cz,
      scale: scaleQ,
      color: colorQ,
      delay: Math.max(...strip) - f,
      label: `${f}`,
    }))
  : name
  ? [{ name, x: cx, z: cz, scale: scaleQ, color: colorQ }]
  : [
      { name: 'Tnk_shot', x: -300, z: -150 },
      { name: 'Tnk_shell_crash', x: -100, z: -150 },
      { name: 'Tnk_shell_bomb', x: 100, z: -150 },
      { name: 'Tnk_blockbreak01', x: 300, z: -150 },
      { name: 'Tnk_bomb01', x: -300, z: 50, scale: 1.6, extra: ['Tnk_bomb01_piece'] },
      { name: 'Tnk_mine_bomb', x: 0, z: 50, scale: 1.6 },
      { name: 'Tnk_stealth_change', x: 300, z: 50, scale: 1.6 },
      { name: 'Tnk_shellsmoke01', x: -380, z: 200 },
      { name: 'Tnk_shellsmoke02', x: -100, z: 200 },
      { name: 'Tnk_shellsmoke03', x: 180, z: 200 },
    ]

// moving shells: RPTnkShell matrix (z = travel direction, scale 32/21)
const SHELL_SCALE = 32 / 21
const shellMatrix = (x: number, z: number) => {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))
  m.scale(new THREE.Vector3(SHELL_SCALE, SHELL_SCALE, SHELL_SCALE))
  m.setPosition(x, 17.6, z)
  return m
}
const shellSpeed = (n: string) => (n === 'Tnk_shellsmoke01' ? 3 : 6)
// cannon matrix of a tank facing +x (RPTnkTank mCannonMtx; the emitter adds +20.3 Z)
const cannonMatrix = (x: number, z: number) => {
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0))
  m.scale(new THREE.Vector3(1.6, 1.6, 1.6))
  m.setPosition(x, 17.6, z)
  return m
}

interface Live {
  it: Item
  h: EffectHandle
  t: number
}
let live: Live[] = []
let clock = 0
const spawnAll = () => {
  live = []
  clock = 0
  spawnDue()
}
// game heights: shells fly at 17.6 (RPTnkTank body height), tanks / mines / blocks sit on y = 0
const heightOf = (n: string) => (/shell|shot/.test(n) ? 17.6 : 0)
const spawnDue = () => {
  for (const it of items) {
    if ((it.delay ?? 0) !== clock) continue
    if (it.name.startsWith('Tnk_shellsmoke')) {
      live.push({ it, h: fx.spawn(it.name, { matrix: shellMatrix(it.x - (name ? (frames / 2) * shellSpeed(it.name) : 0), it.z) }), t: 0 })
    } else if (it.name === 'Tnk_shot') {
      live.push({ it, h: fx.spawn(it.name, { matrix: cannonMatrix(it.x, it.z) }), t: 0 })
    } else {
      for (const e of it.extra ?? [])
        fx.spawn(e, { pos: { x: it.x, y: 0, z: it.z }, scale: it.scale, color: e === 'Tnk_bomb01_piece' ? TANK_PIECE_COLORS[1] : undefined })
      live.push({ it, h: fx.spawn(it.name, { pos: { x: it.x, y: heightOf(it.name), z: it.z }, scale: it.scale, color: it.color }), t: 0 })
    }
  }
}
const step = () => {
  for (const l of live) {
    l.t++
    if (l.it.name.startsWith('Tnk_shellsmoke')) {
      const speed = shellSpeed(l.it.name)
      l.h.setMatrix(shellMatrix(l.it.x + (l.t - (name ? frames / 2 : 0)) * speed, l.it.z))
    }
  }
  fx.update()
  clock++
  spawnDue()
}

// labels
cam.updateMatrixWorld()
for (const it of items) {
  const d = document.createElement('div')
  d.className = 'lbl'
  d.textContent = it.label ?? it.name
  const p = new THREE.Vector3(it.x, 0, it.z + 45 / zoom).project(cam)
  d.style.left = `${((p.x + 1) / 2) * 100}%`
  d.style.top = `${((1 - p.y) / 2) * 100}%`
  document.body.appendChild(d)
}
const info = document.getElementById('info')!

spawnAll()
if (q.has('anim')) {
  let acc = 0
  let last = performance.now()
  let n = 0
  renderer.setAnimationLoop((now) => {
    acc += Math.min(100, now - last)
    last = now
    while (acc >= 1000 / 60) {
      acc -= 1000 / 60
      step()
      if (++n % 150 === 0) {
        fx.clear()
        spawnAll()
      }
    }
    renderer.render(scene, cam)
    info.textContent = `frame ${n % 150}  particles ${fx.particleCount}`
  })
} else {
  for (let i = 0; i < frames; i++) step()
  await renderer.renderAsync(scene, cam)
  info.textContent = `frame ${frames}  particles ${fx.particleCount}`
  document.title = 'done'
}
