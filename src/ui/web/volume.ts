// Volume sliders: the Settings screen's Sound section, and the same two on the in-game menus
// (pause, the arena's Esc menu, the online Esc menu). Changes apply at once (updateSettings).

import { h } from './dom'
import { settings, updateSettings } from './settings'

/** a labelled 0-100 slider for a 0-1 value */
export function slider(label: string, value: number, set: (v: number) => void) {
  const out = h('output', null, `${Math.round(value * 100)}`)
  const input = h('input', {
    type: 'range',
    min: '0',
    max: '100',
    step: '5',
    value: String(Math.round(value * 100)),
    'aria-label': label,
    style: `--p:${Math.round(value * 100)}%`,
    oninput: (e: Event) => {
      const el = e.target as HTMLInputElement
      const v = +el.value / 100
      out.textContent = `${Math.round(v * 100)}`
      el.style.setProperty('--p', `${Math.round(v * 100)}%`)
      set(v)
    },
  })
  return h('label.row', null, h('span.row-label', null, label), h('span.slider', null, input, out))
}

/** Music and Sound effects; `blip` plays a sample sound as the effects volume moves */
export function volumeControls(blip?: () => void) {
  return h(
    'div.volume',
    null,
    slider('Music', settings.music, (v) => updateSettings({ music: v })),
    slider('Sound effects', settings.sfx, (v) => {
      updateSettings({ sfx: v })
      blip?.()
    }),
  )
}
