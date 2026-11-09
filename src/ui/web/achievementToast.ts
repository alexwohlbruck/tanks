// The "Achievement unlocked" popup: a wooden tag that drops in at the top of the window for a
// few seconds whenever src/ui/shared/achievements.ts unlocks one (any mode, menus or play).

import type { Audio } from '../../audio/audio'
import { onAchievement, type Achievement } from '../shared/achievements'
import { icon, tankIcon, tankStyle } from './art'
import { h } from './dom'
import './achievements.css'

let host: HTMLElement | null = null
let audio: Audio | null = null
const queue: Achievement[] = []
let showing = false

/** starts showing the popups; `a` plays their sound */
export function achievementToasts(a: Audio | null) {
  audio = a
}

function container() {
  if (!host || !host.isConnected) {
    host = h('div.web.ach-toasts', { 'aria-live': 'polite' })
    document.body.append(host)
  }
  return host
}

function next() {
  const a = queue.shift()
  if (!a) {
    showing = false
    return
  }
  showing = true
  const st = tankStyle(a.tank ?? 0)
  const el = h(
    'div.ach-toast',
    { role: 'status' },
    h('div.ach-badge.on', null, icon('trophy')),
    h('div.ach-toast-text', null, h('small', null, 'Achievement unlocked'), h('b', null, a.name), h('span', null, a.desc)),
    tankIcon(st.body, st.dark),
  )
  container().append(el)
  audio?.play('RP_COM_GAME_PARTY_SE_LANK_01')
  setTimeout(() => el.classList.add('out'), 3600)
  setTimeout(() => {
    el.remove()
    next()
  }, 4000)
}

onAchievement((a) => {
  queue.push(a)
  if (!showing) next()
})
