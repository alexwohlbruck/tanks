// Online play entry point. Importing this registers the screens:
//   'lobby'    rooms, quick play, join by code, room settings (src/net/lobby.ts)
//   'net-hud'  the overlay during an online game (ping, players, versus score, end menu)
// and wires the server's room / game messages to the app (NetSession while a game runs).
//
// App hooks (src/app/app.ts, marked [net]): call handleJoinParam(app) once the app has loaded;
// a main menu opens the lobby with app.show('lobby').

import { LocalSession } from '../app/session'
import type { AppContext } from '../app/types'
import { netClient } from './client'
import './hud'
import './lobby'
import { NetSession } from './session'

let app: AppContext | null = null
let session: NetSession | null = null
let wired = false

/** the running online session, if any */
export function currentSession() {
  return session
}

/** wires the shared connection to the app (idempotent; the lobby calls it on mount) */
export function bindNet(a: AppContext) {
  app = a
  if (wired) return
  wired = true
  const net = netClient()
  net.on((m) => {
    if (m.t === 'game') startSession()
    else if (m.t === 'room') {
      remember(!!m.room)
      if (!m.room || m.room.state === 'lobby') {
        if (session) endSession()
        // back in a room after a reload / reconnect ('invite': the web screen that set it up)
        else if (m.room && app && app.screen !== 'lobby' && app.screen !== 'invite') app.show('lobby')
      }
    }
  })
}

const IN_ROOM = 'tanks-net-in-room'
function remember(inRoom: boolean) {
  try {
    if (inRoom) sessionStorage.setItem(IN_ROOM, '1')
    else sessionStorage.removeItem(IN_ROOM)
  } catch {}
}
function wasInRoom() {
  try {
    return sessionStorage.getItem(IN_ROOM) === '1'
  } catch {
    return false
  }
}

function startSession() {
  if (!app) return
  if (!session) {
    session = new NetSession(app.game, netClient())
    app.setSession(session)
  }
  if (app.screen !== 'net-hud') app.show('net-hud')
}

/** back from a game to the lobby screen (the room, or the room list after leaving) */
export function endSession() {
  if (!app || !session) return
  const a = app
  session = null
  a.setSession(new LocalSession(a.game))
  const g = a.game
  g.quitToTitle()
  g.world = null
  ;(g.presenter as { reset?: () => void }).reset?.()
  // the attract-mode match behind the lobby again
  ;(a as { startDemo?: () => void }).startDemo?.()
  a.show('lobby')
}

/**
 * Handles the shared room link (?join=CODE) and ?online on page load: opens the lobby and
 * joins. Call once after the app has loaded (App.start).
 */
export function handleJoinParam(a: AppContext) {
  bindNet(a)
  const p = new URLSearchParams(location.search)
  const code = p.get('join')
  if (code) {
    // the code stays out of the address bar after use (a reload rejoins by token instead)
    p.delete('join')
    const q = p.toString()
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash)
    a.show('lobby', { join: code })
  } else if (p.has('online')) a.show('lobby')
  // a reload while in a room: reconnect into the same seat (the server keeps it for 60 s)
  else if (wasInRoom()) netClient().connect().catch(() => remember(false))
}

/** the link that joins a room */
export function joinLink(code: string) {
  return `${location.origin}${location.pathname}?join=${encodeURIComponent(code)}`
}
