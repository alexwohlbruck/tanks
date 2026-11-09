import { defineConfig } from 'vite'

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
})
