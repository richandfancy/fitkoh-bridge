import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const gitSha = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()
  } catch {
    return String(Date.now())
  }
})()

function swVersionPlugin(): Plugin {
  return {
    name: 'sw-cache-version',
    apply: 'build',
    writeBundle({ dir }) {
      const outDir = dir ?? path.resolve(__dirname, 'dist')
      const swPath = path.join(outDir, 'sw.js')
      if (!fs.existsSync(swPath)) return
      const short = gitSha.slice(0, 8)
      const content = fs.readFileSync(swPath, 'utf-8')
      fs.writeFileSync(
        swPath,
        content.replace(
          /const CACHE_VERSION = '[^']+'/,
          `const CACHE_VERSION = 'bridge-${short}'`,
        ),
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), swVersionPlugin()],
  root: 'client',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'client/src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
