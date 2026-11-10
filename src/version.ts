// The release this build is: a git tag like v1.4.2 on deployed builds (tools/release.sh picks
// it, tools/deploy.sh bakes it in), `git describe` output in development. The game server
// reports its own (GET /api/online), so a page left open across a deploy can offer a reload.

declare const __APP_VERSION__: string

export const VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

/** a deployed release (not a development build) */
export const isRelease = (v: string) => /^v\d+\.\d+\.\d+$/.test(v)
