import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [react(), nodePolyfills()],
  // allow importing ../shared/constants.ts from outside web/
  server: { fs: { allow: ['..'] } },
})
