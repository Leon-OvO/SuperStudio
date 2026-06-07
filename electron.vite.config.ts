import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Product flavor is chosen at build time via the FLAVOR env var and baked into
// all three bundles as the global `__APP_FLAVOR__`. src/shared/flavor.ts reads
// it through a typeof guard, so contexts without this define (vitest, tsc) fall
// back to 'superstudio'.
const FLAVOR = process.env.FLAVOR === 'dwork' ? 'dwork' : 'superstudio'
const flavorDefine = { __APP_FLAVOR__: JSON.stringify(FLAVOR) }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: flavorDefine,
    resolve: {
      alias: {
        '@main': resolve('electron/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      lib: {
        entry: resolve('electron/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define: flavorDefine,
    build: {
      lib: {
        entry: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    define: flavorDefine,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
