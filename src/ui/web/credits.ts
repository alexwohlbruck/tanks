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
            h('p.lead', null, 'Toy tank battles in the browser.'),
            h('h3', null, 'About'),
            h('p', null, 'A non-commercial fan project.'),
            h('h3', null, 'How it works'),
            h(
              'p',
              null,
              'The game logic is a faithful port of the original; models, layouts, effects and sound are converted at build time from your own copy of the disc. Nothing from the disc ships with the code.',
            ),
            h('h3', null, 'Built with'),
            h('ul', null, h('li', null, 'three.js (MIT)'), h('li', null, 'M+ 1 typeface by the M+ FONTS Project (SIL Open Font License 1.1)'), h('li', null, 'Bun, Vite, TypeScript')),
            h('p.made', null, 'Made with ❤️ by ', h('a', { href: 'https://alex.wohlbruck.com', target: '_blank', rel: 'noopener' }, 'Alex Wohlbruck')),
            h('p.coffee', null, h('a', { href: 'https://buymeacoffee.com/alexwohlbruck', target: '_blank', rel: 'noopener' }, '☕ Buy me a coffee')),
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
