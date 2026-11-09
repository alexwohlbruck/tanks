// Modern UI wording for the mission 1 control hints (RPTnkExGuide): the Wii Remote and Nunchuk
// icons become the keyboard, mouse and gamepad controls (following the key bindings), or the
// on-screen sticks on touch screens (src/ui/touch.ts).

import { MSG } from '../lyt'
import { keyName, type Settings } from './settings'

const id = (sub: number) => '0x' + ((0xb7c << 8) | sub).toString(16).padStart(8, '0')

export function applyModernMessages(s: Settings, touch = false) {
  if (touch) {
    MSG[id(0)] = 'Drive with your left thumb.'
    MSG[id(1)] = 'Aim at the enemy tank: drag on the right.'
    MSG[id(2)] = 'Let go to fire. Tap on the right to fire again.'
    MSG[id(3)] = 'Lay mines with the Mine button.'
    return
  }
  const first = (a: keyof Settings['keys']) => s.keys[a][0] ?? ''
  const dirs = [first('up'), first('left'), first('down'), first('right')]
  const drive = dirs.every((c) => c.startsWith('Key')) ? dirs.map(keyName).join('') : 'the arrow keys'
  MSG[id(0)] = `Drive with ${drive} or the left stick.`
  MSG[id(1)] = 'Aim at the enemy tank with the mouse.'
  MSG[id(2)] = 'Fire with a left click or RT.'
  MSG[id(3)] = `Lay mines with ${first('mine') ? keyName(first('mine')) : 'a right click'} or LT.`
}
