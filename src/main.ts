import { App } from './app/app'
// screens (each registers itself)
import './editor'
import './store'
import './arena/screen'
import { installFullscreenKey } from './ui/fullscreen'

installFullscreenKey()

const app = new App(
  document.getElementById('stage')!,
  document.getElementById('gl') as HTMLCanvasElement,
  document.getElementById('ui') as HTMLCanvasElement,
  document.getElementById('screens')!,
)

app
  .start()
  .then(() => {
    // arena invite links: ?arena=<id>&with=<pid>
    const p = new URLSearchParams(location.search)
    if (p.has('arena')) app.show('arena', { arena: p.get('arena'), with: p.get('with') })
  })
  .catch((e) => {
  console.error(e)
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:0;white-space:pre-wrap">${e?.stack ?? e}</pre>`)
})
