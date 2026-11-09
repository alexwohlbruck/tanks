// Input devices mapped onto the Wii controls:
//   Nunchuk stick  -> WASD / arrows / left stick (D-pad = digital, 46 degree drive cone)
//   Wii pointer    -> mouse, or a virtual pointer moved by the right stick
//   B (fire)       -> left click / J / gamepad RT, RB or A
//   A (mine)       -> right click / Space / E / Shift / K / gamepad LT, LB or X
//   + (pause)      -> Escape / P / Start
// Keyboard+mouse and each gamepad are separate devices, so two players can play.

export type PadState = {
  moveX: number
  moveY: number
  /** true for analog sticks (Nunchuk rules), false for digital keys (D-pad rules) */
  analog: boolean
  /** pointer position over the stage, [0,1]^2, or null when not pointing */
  pointer: { x: number; y: number } | null
  aimStick: { x: number; y: number } | null
  fire: boolean
  mine: boolean
  pause: boolean
  confirm: boolean
  back: boolean
  up: boolean
  down: boolean
  left: boolean
  right: boolean
}

const empty = (): PadState => ({
  moveX: 0,
  moveY: 0,
  analog: false,
  pointer: null,
  aimStick: null,
  fire: false,
  mine: false,
  pause: false,
  confirm: false,
  back: false,
  up: false,
  down: false,
  left: false,
  right: false,
})

type GamepadSlot = { index: number; prev: boolean[]; pointer: { x: number; y: number } }

export class Input {
  private keys = new Set<string>()
  private pressed = new Set<string>()
  private mousePressed = new Set<number>()
  private mouse: { x: number; y: number } | null = null
  private pads = new Map<number, GamepadSlot>()
  /** devices in the order they were first used: 'kbm' or a gamepad index */
  order: (string | number)[] = []

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.keys.add(e.code)
      this.pressed.add(e.code)
      this.use('kbm')
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault()
    })
    addEventListener('keyup', (e) => this.keys.delete(e.code))
    addEventListener('blur', () => this.keys.clear())
    el.addEventListener('contextmenu', (e) => e.preventDefault())
    el.addEventListener('pointerdown', (e) => {
      this.mousePressed.add(e.button)
      this.setPointer(e)
      this.use('kbm')
    })
    el.addEventListener('pointermove', (e) => {
      this.setPointer(e)
      this.use('kbm')
    })
  }

  private use(d: string | number) {
    if (!this.order.includes(d)) this.order.push(d)
  }

  private setPointer(e: PointerEvent) {
    const r = this.el.getBoundingClientRect()
    this.mouse = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }

  private pollKbm(): PadState {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c))
    const p = (...codes: string[]) => codes.some((c) => this.pressed.has(c))
    let mx = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0)
    let my = (k('KeyS', 'ArrowDown') ? 1 : 0) - (k('KeyW', 'ArrowUp') ? 1 : 0)
    if (mx && my) {
      mx *= Math.SQRT1_2
      my *= Math.SQRT1_2
    }
    const s: PadState = {
      ...empty(),
      moveX: mx,
      moveY: my,
      pointer: this.mouse,
      fire: this.mousePressed.has(0) || p('KeyJ'),
      mine: this.mousePressed.has(2) || p('Space', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyK'),
      pause: p('Escape', 'KeyP'),
      confirm: p('Enter', 'Space', 'KeyZ') || this.mousePressed.has(0),
      back: p('Backspace', 'KeyX'),
      up: p('ArrowUp', 'KeyW'),
      down: p('ArrowDown', 'KeyS'),
      left: p('ArrowLeft', 'KeyA'),
      right: p('ArrowRight', 'KeyD'),
    }
    this.pressed.clear()
    this.mousePressed.clear()
    return s
  }

  private pollGamepad(g: Gamepad): PadState {
    let slot = this.pads.get(g.index)
    if (!slot) this.pads.set(g.index, (slot = { index: g.index, prev: [], pointer: { x: 0.5, y: 0.55 } }))
    const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v)
    const btn = (i: number) => !!g.buttons[i]?.pressed
    const edge = (i: number) => btn(i) && !slot!.prev[i]
    const lx = dz(g.axes[0] ?? 0)
    const ly = dz(g.axes[1] ?? 0)
    const rx = dz(g.axes[2] ?? 0)
    const ry = dz(g.axes[3] ?? 0)
    const dpx = (btn(15) ? 1 : 0) - (btn(14) ? 1 : 0)
    const dpy = (btn(13) ? 1 : 0) - (btn(12) ? 1 : 0)
    if (lx || ly || rx || ry || g.buttons.some((b) => b.pressed)) this.use(g.index)
    // right stick drives a pointer, like pointing the Wii Remote
    slot.pointer.x = Math.min(1, Math.max(0, slot.pointer.x + rx * 0.018))
    slot.pointer.y = Math.min(1, Math.max(0, slot.pointer.y + ry * 0.018 * (16 / 9)))
    const analog = !!(lx || ly)
    const s: PadState = {
      ...empty(),
      moveX: analog ? lx : dpx * (dpy ? Math.SQRT1_2 : 1),
      moveY: analog ? ly : dpy * (dpx ? Math.SQRT1_2 : 1),
      analog,
      pointer: { ...slot.pointer },
      aimStick: rx || ry ? { x: rx, y: ry } : null,
      fire: edge(7) || edge(5) || edge(0),
      mine: edge(6) || edge(4) || edge(2),
      pause: edge(9),
      confirm: edge(0),
      back: edge(1),
      up: edge(12) || (ly < -0.6 && !slot.prev[100]),
      down: edge(13) || (ly > 0.6 && !slot.prev[101]),
      left: edge(14),
      right: edge(15),
    }
    slot.prev = g.buttons.map((b) => b.pressed)
    slot.prev[100] = ly < -0.6
    slot.prev[101] = ly > 0.6
    return s
  }

  /** all devices this frame: keyboard+mouse first, then gamepads by index */
  pollAll(): { kbm: PadState; gamepads: Map<number, PadState> } {
    const kbm = this.pollKbm()
    const gamepads = new Map<number, PadState>()
    for (const g of navigator.getGamepads?.() ?? []) if (g && g.connected) gamepads.set(g.index, this.pollGamepad(g))
    return { kbm, gamepads }
  }

  /** merge devices into one pad (single player / menus) */
  static merge(a: PadState, b?: PadState): PadState {
    if (!b) return a
    const useB = !!(b.moveX || b.moveY)
    return {
      moveX: useB ? b.moveX : a.moveX,
      moveY: useB ? b.moveY : a.moveY,
      analog: useB ? b.analog : a.analog,
      pointer: b.aimStick ? b.pointer : (a.pointer ?? b.pointer),
      aimStick: b.aimStick ?? a.aimStick,
      fire: a.fire || b.fire,
      mine: a.mine || b.mine,
      pause: a.pause || b.pause,
      confirm: a.confirm || b.confirm,
      back: a.back || b.back,
      up: a.up || b.up,
      down: a.down || b.down,
      left: a.left || b.left,
      right: a.right || b.right,
    }
  }
}
