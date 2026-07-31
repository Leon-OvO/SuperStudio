import { getSettings } from './store'
import { pruneMemories } from './memory'
import { IPC } from '../../../src/shared/ipc-types'

/**
 * Background long-term-memory cleanup (记忆自动清理), mirroring session-tidy:
 * runs the two-stage decay pass (see memory.ts `pruneMemories`) on startup and
 * every ~3h. Fully rule-based + reversible (stage 1 only archives; archived rows
 * leave recall but stay recoverable until a 30-day grace elapses). The four exempt
 * classes (pinned / profile / correction / manual|imported) are never touched.
 *
 * Gated by `memoryAutoCleanup` (default on). Throttled to at most once an hour so
 * repeated triggers can't thrash the DB. The manual「整理」button calls
 * pruneMemories() directly (unthrottled) via IPC.
 */

const THREE_HOURS = 3 * 60 * 60_000
const MIN_GAP_MS = 60 * 60_000 // don't run the full pass more than once per hour
let timer: ReturnType<typeof setInterval> | null = null
let lastRunAt = 0

/** Run a throttled pass now (no-op when disabled or run <1h ago). Returns counts. */
export function runMemoryTidy(): { archived: number; deleted: number } {
  if (getSettings().memoryAutoCleanup === false) return { archived: 0, deleted: 0 }
  const now = Date.now()
  if (now - lastRunAt < MIN_GAP_MS) return { archived: 0, deleted: 0 }
  lastRunAt = now
  return pruneMemories()
}

/** Run cleanup now, then every ~3h. Notifies the renderer (MEMORY_CHANGED) to
 *  reload the memory page whenever something actually changed. Call once on startup. */
export function startMemoryTidy(): void {
  const run = (): void => {
    let res: { archived: number; deleted: number }
    try { res = runMemoryTidy() } catch { return }
    if (res.archived || res.deleted) {
      console.log(`[mem-tidy] archived ${res.archived}, deleted ${res.deleted}`)
      void import('../index')
        .then(({ getMainWindow }) => {
          const w = getMainWindow()
          if (w && !w.isDestroyed()) w.webContents.send(IPC.MEMORY_CHANGED)
        })
        .catch(() => { /* window not ready */ })
    }
  }
  run()
  if (timer) clearInterval(timer)
  timer = setInterval(run, THREE_HOURS)
  timer.unref?.()
}
