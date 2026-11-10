// 'title': the logo over the attract-mode match; any key, click, tap or gamepad button opens
// the main menu.

import { registerScreen } from '../../app/router'
import { logo } from './art'
import { WebScreen } from './base'
import { h, touch } from './dom'
import { isRelease, VERSION } from '../../version'

class TitleScreen extends WebScreen {
  private armed = false
  private count = h('div.title-online', { hidden: true })
  private poll = 0
  /** a newer release is live than this page: offer a reload */
  private newer = h('button.title-update', { type: 'button', hidden: true, onclick: (e: Event) => (e.stopPropagation(), location.reload()) }, 'A new version is out · Reload')
  private arm = 0
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
        this.count,
        this.newer,
        h('div.title-foot', null, 'Fan-made port. Wii Play and Tanks! are trademarks of Nintendo.', h('span.title-version', null, VERSION)),
      ),
    )
    this.refresh()
    this.poll = window.setInterval(() => document.hidden || this.refresh(), 10_000)
    // the key or click that came from the previous screen does not count
    // (a screen that replaces this one at once, like an invite link's lobby, must not leave the
    // listener behind)
    this.arm = window.setTimeout(() => {
      this.armed = true
      addEventListener('keydown', this.onKey)
    }, 250)
  }

  /** the live player count (arena + online rooms); hidden when the server can't be reached */
  private async refresh() {
    try {
      const r = await this.app.api('/online')
      if (!r.ok) throw 0
      const { online, version } = (await r.json()) as { online: number; version?: string }
      this.newer.hidden = !(version && isRelease(version) && isRelease(VERSION) && version !== VERSION)
      this.count.replaceChildren(h('i'), h('b', null, String(online)), online === 1 ? ' player online' : ' players online')
      this.count.hidden = false
    } catch {
      this.count.hidden = true
    }
  }

  unmount() {
    clearInterval(this.poll)
    clearTimeout(this.arm)
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
