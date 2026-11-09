// Modern UI wording for the mission 1 control hints (RPTnkExGuide): the Wii Remote and Nunchuk
// icons become the keyboard, mouse and gamepad controls (following the key bindings).

import { MSG } from '../lyt'
import { keyName, type Settings } from './settings'

const id = (sub: number) => '0x' + ((0xb7c << 8) | sub).toString(16).padStart(8, '0')

export function applyModernMessages(s: Settings) {
  const first = (a: keyof Settings['keys']) => s.keys[a][0] ?? ''
  const dirs = [first('up'), first('left'), first('down'), first('right')]
  const drive = dirs.every((c) => c.startsWith('Key')) ? dirs.map(keyName).join('') : 'the arrow keys'
  MSG[id(0)] = `Drive with ${drive} or the left stick.`
  MSG[id(1)] = 'Aim at the enemy tank with the mouse.'
  MSG[id(2)] = 'Fire with a left click or RT.'
  MSG[id(3)] = `Lay mines with ${first('mine') ? keyName(first('mine')) : 'a right click'} or LT.`
}
