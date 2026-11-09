import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5300,
    strictPort: false,
    allowedHosts: true,
    // the game server (bun server/index.ts) in development
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: { target: 'es2022' },
})
