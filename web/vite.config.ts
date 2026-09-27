import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Relayer runs locally (relayer/, port 8787). The dev server forwards /relayer/* to it,
// so the browser talks to the same origin and the relayer needs no CORS.
const RELAYER_TARGET = process.env.RELAYER_TARGET ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  server: {
    // allow importing ../shared/constants.ts from outside web/
    fs: { allow: ['..'] },
    proxy: {
      '/relayer': {
        target: RELAYER_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/relayer/, ''),
      },
    },
  },
})
