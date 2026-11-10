// User settings (localStorage 'tanks.settings'): volumes, graphics quality, key bindings and
// the "Classic UI" switch. Read once at boot; screens change them through `updateSettings`.

/** render quality presets of SceneView.setQuality (src/render/quality.ts) */
export type Quality = 'classic' | 'high' | 'ultra'

/** keyboard actions that can be rebound (mouse buttons stay fixed) */
export type KeyAction = 'up' | 'down' | 'left' | 'right' | 'fire' | 'mine' | 'flare' | 'nuke' | 'pause'

export type Settings = {
  /** 0..1 */
  music: number
  /** 0..1 */
  sfx: number
  quality: Quality
  /** the original game's screens, bitmap fonts and the fixed 16:9 picture */
  classicUi: boolean
  /** KeyboardEvent.code lists per action */
  keys: Record<KeyAction, string[]>
}

export const DEFAULT_KEYS: Record<KeyAction, string[]> = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  fire: ['KeyJ'],
  mine: ['Space', 'KeyE', 'ShiftLeft', 'ShiftRight', 'KeyK'],
  flare: ['KeyF', 'KeyQ', 'KeyL'],
  nuke: ['KeyN', 'KeyR'],
  pause: ['Escape', 'KeyP'],
}

const KEY = 'tanks.settings'

const defaults = (): Settings => ({ music: 0.8, sfx: 0.9, quality: 'high', classicUi: false, keys: structuredClone(DEFAULT_KEYS) })

function load(): Settings {
  const d = defaults()
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (s && typeof s === 'object') {
      const num = (v: unknown, f: number) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : f)
      d.music = num(s.music, d.music)
      d.sfx = num(s.sfx, d.sfx)
      if (['classic', 'high', 'ultra'].includes(s.quality)) d.quality = s.quality
      else if (s.quality === 'low') d.quality = 'classic'
      d.classicUi = !!s.classicUi
      if (s.keys && typeof s.keys === 'object')
        for (const k of Object.keys(d.keys) as KeyAction[]) if (Array.isArray(s.keys[k]) && s.keys[k].every((c: unknown) => typeof c === 'string')) d.keys[k] = s.keys[k]
    }
  } catch {
    /* corrupt or unavailable storage */
  }
  return d
}

export const settings: Settings = load()

const listeners = new Set<(s: Settings) => void>()

export function onSettings(f: (s: Settings) => void) {
  listeners.add(f)
  return () => listeners.delete(f)
}

export function updateSettings(p: Partial<Settings>) {
  Object.assign(settings, p)
  try {
    localStorage.setItem(KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable */
  }
  for (const f of listeners) f(settings)
}

/** ?classic forces the classic UI, ?modern the web UI (for testing), else the saved setting */
export function classicUi() {
  const p = new URLSearchParams(location.search)
  if (p.has('classic')) return true
  if (p.has('modern')) return false
  return settings.classicUi
}

/** a readable name for a KeyboardEvent.code */
export function keyName(code: string) {
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  const map: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Space: 'Space',
    ShiftLeft: 'L Shift',
    ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl',
    ControlRight: 'R Ctrl',
    AltLeft: 'L Alt',
    AltRight: 'R Alt',
    Escape: 'Esc',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Tab: 'Tab',
  }
  return map[code] ?? code.replace(/^Numpad/, 'Num ')
}
