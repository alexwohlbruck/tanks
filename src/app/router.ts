// Screen router: one DOM screen at a time, layered over the game canvases.

import type { AppContext, Screen, ScreenFactory } from './types'

const registry = new Map<string, ScreenFactory>()

/** screens register themselves at module load: registerScreen('menu', () => new MainMenu()) */
export function registerScreen(id: string, factory: ScreenFactory) {
  registry.set(id, factory)
}

export function hasScreen(id: string) {
  return registry.has(id)
}

export class Router {
  current: { id: string; screen: Screen; root: HTMLElement } | null = null

  constructor(private host: HTMLElement, private app: () => AppContext) {}

  show(id: string | null, params?: Record<string, unknown>) {
    if (this.current) {
      this.current.screen.unmount?.()
      this.current.root.remove()
      this.current = null
    }
    if (!id) return
    const f = registry.get(id)
    if (!f) throw new Error(`unknown screen ${id}`)
    const screen = f()
    const root = document.createElement('div')
    root.className = `screen screen-${id}`
    this.host.appendChild(root)
    this.current = { id, screen, root }
    void screen.mount(root, this.app(), params)
  }

  get id() {
    return this.current?.id ?? null
  }
  get opaque() {
    return !!this.current?.screen.opaque
  }
  get modal() {
    return !!this.current?.screen.modal
  }

  update() {
    this.current?.screen.update?.()
  }
}
