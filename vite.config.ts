import { defineConfig } from 'vite'

// TANKS_SERVER: the game server the dev proxy talks to (default http://localhost:3001)
const server = process.env.TANKS_SERVER ?? 'http://localhost:3001'

export default defineConfig({
  server: {
    port: 5300,
    strictPort: false,
    allowedHosts: true,
    // the game server (bun server/index.ts) in development
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022' },
})
