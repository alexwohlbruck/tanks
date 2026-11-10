import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

/** the release this build is (the deploy sets TANKS_VERSION; otherwise git describe, e.g.
 * v1.2.0-3-gabc1234 three commits past v1.2.0) */
function version() {
  if (process.env.TANKS_VERSION) return process.env.TANKS_VERSION
  try {
    return execSync('git describe --tags --always --dirty', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return 'dev'
  }
}

// the game server (bun server/index.ts) in development; override with TANKS_SERVER
const server = process.env.TANKS_SERVER ?? 'http://localhost:3001'

export default defineConfig({
  server: {
    port: 5300,
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(version()) },
})
