import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5300, strictPort: false, allowedHosts: true },
  build: { target: 'es2022' },
})
