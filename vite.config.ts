import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? '/aq-remote-dashboard/' : '/',
  test: { environment: 'node', globals: true },
})
