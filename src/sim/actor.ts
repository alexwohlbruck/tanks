// RPTnkActor (RPTnkActor.cpp) and RPTnkActorPool (RPTnkActorPool.cpp).
//
// Physics per frame, driven by RPTnkScene::UpdateGameplay: ApplyVelocity (pos += vel) ->
// ClearForcesStep (zero the push accumulators) -> CollideWithField (collisions write
// per-component min/max pushes into posAccum/velAccum) -> IntegrateStep (pos += lo + hi,
// vel += lo + hi) -> Calculate (state machine) -> TickAge.

import { type Axes, type V3, identityAxes, setAxes, v3, vset, ZERO } from './vec'

let serial = 1
/** fresh id for every spawn, so renderers can key objects by id */
export const nextId = () => serial++

export class Actor {
  pos: V3 = v3()
  /** model scale */
  scale: V3 = v3(1, 1, 1)
  /** mRot: x side, y up, z forward */
  rot: Axes = identityAxes()
  vel: V3 = v3()
  posAccum: [V3, V3] = [v3(), v3()]
  velAccum: [V3, V3] = [v3(), v3()]
  hitOffset: V3 = v3()
  hitRadius = 0
  hitOffsetAlt: V3 = v3()
  /** frames since spawn; < 0 when the slot is free (-1 after ResetState, -999 after Kill) */
  age = 0
  index = 0
  pool: ActorPool<Actor> | null = null
  /** unique per spawn (not in the original) */
  id = 0

  get active() {
    return this.age >= 0
  }

  /** RPTnkActor::ResetState */
  resetState() {
    vset(this.pos, ZERO)
    vset(this.scale, { x: 1, y: 1, z: 1 })
    setAxes(this.rot, identityAxes())
    vset(this.vel, ZERO)
    this.clearForces()
    vset(this.hitOffset, ZERO)
    this.hitRadius = 1
    vset(this.hitOffsetAlt, ZERO)
    this.age = -1
  }

  /** RPTnkActor::Reset */
  reset() {
    this.resetState()
  }

  /** RPTnkActor::ClearForces */
  clearForces() {
    for (const a of this.posAccum) vset(a, ZERO)
    for (const a of this.velAccum) vset(a, ZERO)
  }

  /** RPTnkActor::Integrate */
  integrate() {
    const [p0, p1] = this.posAccum
    const [v0, v1] = this.velAccum
    this.pos.x += p0.x + p1.x
    this.pos.y += p0.y + p1.y
    this.pos.z += p0.z + p1.z
    this.vel.x += v0.x + v1.x
    this.vel.y += v0.y + v1.y
    this.vel.z += v0.z + v1.z
  }

  onSpawn() {}
  applySpawnParam(_param: number) {}

  /** RPTnkActor::ApplyVelocity */
  applyVelocity() {
    this.pos.x += this.vel.x
    this.pos.y += this.vel.y
    this.pos.z += this.vel.z
  }
  clearForcesStep() {
    this.clearForces()
  }
  collideWithField() {}
  integrateStep() {
    this.integrate()
  }
  calculate() {}

  /** RPTnkActor::Spawn */
  spawn(pos: V3, param: number) {
    this.resetState()
    vset(this.pos, pos)
    this.onSpawn()
    this.applySpawnParam(param)
    this.age = 0
    this.id = nextId()
  }

  /** RPTnkActor::Kill */
  kill() {
    this.age = -999
    if (this.pool) this.pool.activeNum--
  }

  hitCenter(): V3 {
    return v3(this.pos.x + this.hitOffset.x, this.pos.y + this.hitOffset.y, this.pos.z + this.hitOffset.z)
  }
  hitCenterAlt(): V3 {
    return v3(this.pos.x + this.hitOffsetAlt.x, this.pos.y + this.hitOffsetAlt.y, this.pos.z + this.hitOffsetAlt.z)
  }

  /** RPTnkActor::TestHit: XZ circle test of other's hit circle against ours. */
  testHit(other: Actor): number | null {
    return circleTest(other.hitCenter(), this.pos.x + this.hitOffset.x, this.pos.z + this.hitOffset.z, this.hitRadius + other.hitRadius)
  }
  /** RPTnkActor::TestHitAlt */
  testHitAlt(other: Actor): number | null {
    return circleTest(other.hitCenter(), this.pos.x + this.hitOffsetAlt.x, this.pos.z + this.hitOffsetAlt.z, this.hitRadius + other.hitRadius)
  }

  /** called by Field.collideActor for every wall the hit circle crosses */
  onHitWall(_depth: number, _normal: V3, _wall: number, _vel: V3) {}
  collideObject(_other: Actor, _mode: number): boolean {
    return false
  }
  ownerSlot(): number {
    return 0
  }
  kind(): number {
    return 0
  }
  height(): number {
    return 0
  }
  isInBlastRadius(_other: Actor): boolean {
    return false
  }
  isInTriggerRange(_other: Actor): boolean {
    return false
  }
  isExploding(): boolean {
    return false
  }
  ownerTank(): Actor | null {
    return null
  }
}

/**
 * The shared circle test of TestHit & co: rejects on |dx|^2, then |dz|^2, then the sum, against
 * radius^2 (inclusive); returns the distance on a hit, null otherwise.
 */
export function circleTest(o: V3, cx: number, cz: number, radius: number): number | null {
  const r2 = radius * radius
  let dx = o.x - cx
  dx *= dx
  if (dx > r2) return null
  let dz = o.z - cz
  dz *= dz
  if (dz > r2) return null
  if (dx + dz > r2) return null
  return Math.sqrt(dx + dz)
}

/** RPTnkActorPool: fixed array, round-robin spawn from `next`. */
export class ActorPool<T extends Actor> {
  items: T[] = []
  activeNum = 0
  next = 0

  constructor(n: number, make: (i: number) => T) {
    for (let i = 0; i < n; i++) {
      const a = make(i)
      a.index = i
      a.pool = this as unknown as ActorPool<Actor>
      this.items.push(a)
    }
  }

  get capacity() {
    return this.items.length
  }

  /** RPTnkActorPool::Reset */
  reset() {
    this.activeNum = 0
    this.next = 0
    for (const a of this.items) a.reset()
  }

  /** RPTnkActorPool::Spawn: the next free actor from `next`, or null when full. */
  spawn(pos: V3, param: number): T | null {
    if (this.activeNum >= this.capacity) return null
    let i = this.next
    do {
      const a = this.items[i]
      if (!a.active) {
        a.spawn(pos, param)
        this.activeNum++
        this.next = i === this.capacity - 1 ? 0 : i + 1
        return a
      }
      i = i === this.capacity - 1 ? 0 : i + 1
    } while (i !== this.next)
    return null
  }

  /** RPTnkActorPool::KillAll (note: does not rewind `next`) */
  killAll() {
    for (const a of this.items) a.kill()
    this.activeNum = 0
  }

  forActive(f: (a: T) => void) {
    if (this.activeNum === 0) return
    for (const a of this.items) if (a.active) f(a)
  }

  applyVelocityAll() {
    this.forActive((a) => a.applyVelocity())
  }
  clearForcesAll() {
    this.forActive((a) => a.clearForcesStep())
  }
  collideAllWithField() {
    this.forActive((a) => a.collideWithField())
  }
  integrateAll() {
    this.forActive((a) => a.integrateStep())
  }
  calcAll() {
    this.forActive((a) => a.calculate())
  }
  /** RPTnkActorPool::TickAge */
  tickAge() {
    if (this.activeNum === 0) return
    for (const a of this.items) if (a.age >= 0) a.age++
  }
}
