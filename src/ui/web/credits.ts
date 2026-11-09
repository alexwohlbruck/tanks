// 'credits': about the port.

import { registerScreen } from '../../app/router'
import { backButton, band, WebScreen } from './base'
import { h } from './dom'

class CreditsScreen extends WebScreen {
  protected build(root: HTMLElement) {
    root.append(
      h(
        'div.credits-screen',
        null,
        h(
          'div.panel.credits',
          null,
          h('div.panel-head', null, backButton(() => this.back(), 'Back'), band('Credits')),
          h(
            'div.panel-scroll',
            null,
            h('p.lead', null, 'Tanks! — the Wii Play minigame, ported to the web.'),
            h('h3', null, 'Original game'),
            h('p', null, 'Tanks! from Wii Play (2006) by Nintendo. Wii Play and Tanks! are trademarks of Nintendo. This is a non-commercial fan project, not affiliated with or endorsed by Nintendo.'),
            h('h3', null, 'This port'),
            h(
              'p',
              null,
              'Game logic ported from the Wii Play decompilation; models, layouts, effects and sound converted at build time from your own copy of the disc — nothing from the disc ships with the code.',
            ),
            h('h3', null, 'Built with'),
            h('ul', null, h('li', null, 'three.js (MIT)'), h('li', null, 'M+ 1 typeface — The M+ FONTS Project, SIL Open Font License 1.1'), h('li', null, 'Bun, Vite, TypeScript')),
            h('p.made', null, 'Made with ❤️ by ', h('a', { href: 'https://alex.wohlbruck.dev', target: '_blank', rel: 'noopener' }, 'Alex Wohlbruck')),
          ),
        ),
      ),
    )
  }

  protected back() {
    this.app.show('menu')
  }
}

registerScreen('credits', () => new CreditsScreen())
