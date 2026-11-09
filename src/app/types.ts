// App-level contracts shared by the menus, the level editor, online play and the game view.

import type { Audio } from '../audio/audio'
import type { Game } from '../game'
import type { Input, PadState } from '../input'
import type { LevelPack } from '../levels/format'
import type { SceneView } from '../render/scene'

/**
 * What drives the game each 60 Hz frame. LocalSession runs the simulation with local input;
 * an online session (src/net) feeds server state into the same Game/World instead.
 */
export interface Session {
  readonly kind: string
  /** one 60 Hz frame; `pads` are this frame's input devices */
  step(pads: Pads): void
  /** called when the session is replaced */
  dispose?(): void
}

export type Pads = { kbm: PadState; gamepads: PadState[]; merged: PadState }

/** A DOM screen layered over the game canvas (menus, editor, lobby, store, ...). */
export interface Screen {
  /** build the DOM into `root` (an empty element owned by the router) */
  mount(root: HTMLElement, app: AppContext, params?: Record<string, unknown>): void | Promise<void>
  unmount?(): void
  /** per rendered frame, while visible */
  update?(): void
  /** true when the screen covers the game entirely (the 3D view is not rendered) */
  readonly opaque?: boolean
  /** true when the screen should receive pointer input instead of the game */
  readonly modal?: boolean
}

export type ScreenFactory = () => Screen

export interface AppContext {
  game: Game
  view: SceneView
  audio: Audio
  input: Input
  /** show a registered screen (replacing the current one); null hides all screens */
  show(id: string | null, params?: Record<string, unknown>): void
  /** current screen id */
  readonly screen: string | null
  /** the original Wii Play campaign (1-4 local players) */
  playClassic(players: number, mission?: number): void
  /** a custom level pack (editor test, store levels, Tanks+ campaign) */
  playPack(pack: LevelPack, players: number, level?: number): void
  /** replace what drives the game (local play / online) */
  setSession(s: Session): void
  /** back to the main menu */
  toMenu(): void
  /** server API base (same origin `/api` in production) */
  api(path: string, init?: RequestInit): Promise<Response>
}
