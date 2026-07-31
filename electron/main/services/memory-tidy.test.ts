import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Gate + throttle for the background memory-tidy pass. The heavy SQL logic is
 * covered in memory.test.ts; here we only assert the wrapper's contract:
 *   - memoryAutoCleanup=false → no-op, pruneMemories never called
 *   - enabled → runs pruneMemories and returns its counts
 *   - throttled to at most once per hour
 */

const H = vi.hoisted(() => ({
  settings: { memoryAutoCleanup: true } as { memoryAutoCleanup?: boolean },
  prune: vi.fn(() => ({ archived: 2, deleted: 1 })),
}))

vi.mock('./store', () => ({ getSettings: () => H.settings }))
vi.mock('./memory', () => ({ pruneMemories: H.prune }))

import { runMemoryTidy } from './memory-tidy'

const T = 1_700_000_000_000
const HOUR = 60 * 60_000

beforeEach(() => {
  H.settings = { memoryAutoCleanup: true }
  H.prune.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('runMemoryTidy', () => {
  it('is a no-op (does not prune) when memoryAutoCleanup is false', () => {
    H.settings = { memoryAutoCleanup: false }
    vi.spyOn(Date, 'now').mockReturnValue(T + 10 * HOUR)
    expect(runMemoryTidy()).toEqual({ archived: 0, deleted: 0 })
    expect(H.prune).not.toHaveBeenCalled()
  })

  it('runs prune when enabled, and throttles repeats to once per hour', () => {
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(T + 100 * HOUR) // well past any prior run in this file
    expect(runMemoryTidy()).toEqual({ archived: 2, deleted: 1 })
    expect(H.prune).toHaveBeenCalledTimes(1)

    now.mockReturnValue(T + 100 * HOUR + 30 * 60_000) // +30m → still throttled
    expect(runMemoryTidy()).toEqual({ archived: 0, deleted: 0 })
    expect(H.prune).toHaveBeenCalledTimes(1)

    now.mockReturnValue(T + 101 * HOUR + 60_000) // >1h later → runs again
    expect(runMemoryTidy()).toEqual({ archived: 2, deleted: 1 })
    expect(H.prune).toHaveBeenCalledTimes(2)
  })
})
