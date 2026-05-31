import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Node-environment unit/integration tests for the Electron MAIN process logic.
// Pure helpers (electron/main/agent/pure.ts) and mocked-streamText integration
// tests live alongside the code as *.test.ts. The renderer is not covered here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['electron/**/*.test.ts', 'src/shared/**/*.test.ts'],
    // Pure-fn tests must not boot electron; integration tests mock it explicitly.
    alias: {
      '@main': resolve(__dirname, 'electron/main'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  }
})
