// Fullscreen for the whole page: the Settings switch, the pause and arena menus, the title
// screen's corner button, the touch controls' button and Alt+Enter all go through here.

/** the browser lets the page go fullscreen (iPhone Safari doesn't) */
export const fsSupported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen

export const isFullscreen = () => !!document.fullscreenElement

/** on: fullscreen, then landscape where the browser allows locking it (Android Chrome) */
export async function setFullscreen(on: boolean) {
  try {
    if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {})
    } else if (!on && document.fullscreenElement) await document.exitFullscreen()
  } catch {
    /* not allowed */
  }
}

export const toggleFullscreen = () => setFullscreen(!isFullscreen())

/** Alt+Enter anywhere */
export function installFullscreenKey() {
  if (!fsSupported) return
  addEventListener(
    'keydown',
    (e) => {
      if (e.code !== 'Enter' || !e.altKey || e.repeat) return
      e.preventDefault()
      e.stopImmediatePropagation()
      void toggleFullscreen()
    },
    true,
  )
}
