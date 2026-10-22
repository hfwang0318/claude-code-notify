import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Production-only policy. The dev server keeps the looser CSP declared in
// index.html because Vite HMR needs inline scripts and a WebSocket connection.
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ')

/**
 * Rewrite the renderer CSP meta tag during `electron-vite build` only.
 * `pnpm dev` never runs this plugin, so HMR keeps working.
 */
function productionCspPlugin(): Plugin {
  return {
    name: 'claude-notify:production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i
      if (!meta.test(html)) {
        throw new Error(
          '[production-csp] index.html is missing its Content-Security-Policy meta tag'
        )
      }
      return html.replace(
        meta,
        `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), productionCspPlugin()]
  }
})
