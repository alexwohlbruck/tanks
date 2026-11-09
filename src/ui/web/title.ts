// 'title': the logo over the attract-mode match; any key, click, tap or gamepad button opens
// the main menu.

import { registerScreen } from '../../app/router'
import { logo } from './art'
import { WebScreen } from './base'
import { h, touch } from './dom'

class TitleScreen extends WebScreen {
  private armed = false
  private onKey = (e: KeyboardEvent) => {
    if (e.repeat || ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'Backquote'].includes(e.code)) return
    this.go()
  }

  protected build(root: HTMLElement) {
    root.append(
      h(
        'div.title-screen',
        { onclick: () => this.go() },
        h('div.title-logo', null, logo()),
        h('div.title-sub', null, 'Wii Play · web edition'),
        h('button.press', { type: 'button', autofocus: true }, touch() ? 'Tap to start' : 'Press start'),
        h('div.title-foot', null, 'Fan-made port. Wii Play and Tanks! are trademarks of Nintendo.'),
      ),
    )
    // the key or click that came from the previous screen does not count
    setTimeout(() => {
      this.armed = true
      addEventListener('keydown', this.onKey)
    }, 250)
  }

  unmount() {
    removeEventListener('keydown', this.onKey)
    super.unmount()
  }

  protected start() {
    this.go()
  }
  /** gamepad A / B also start */
  protected back() {
    this.go()
  }

  private go() {
    if (!this.armed) return
    this.armed = false
    this.sound('ok')
    // first user gesture: the audio context may start now
    this.app.music('RP_COMMON_BGM_PARTY_MENU')
    this.app.show('menu')
  }
}

registerScreen('title', () => new TitleScreen())
