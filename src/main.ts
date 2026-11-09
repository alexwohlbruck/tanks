import { App } from './app/app'
// screens (each registers itself)
import './editor'
import './store'
import './arena/screen'

const app = new App(
  document.getElementById('stage')!,
  document.getElementById('gl') as HTMLCanvasElement,
  document.getElementById('ui') as HTMLCanvasElement,
  document.getElementById('screens')!,
)

app.start().catch((e) => {
  console.error(e)
  document.body.insertAdjacentHTML('beforeend', `<pre style="color:#f88;position:fixed;top:0;white-space:pre-wrap">${e?.stack ?? e}</pre>`)
})
