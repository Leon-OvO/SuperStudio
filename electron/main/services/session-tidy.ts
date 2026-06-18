import { dbRun, dbGet } from '../db/sqlite'
import { getSettings } from './store'
import { IPC } from '../../../src/shared/ipc-types'

/**
 * Background session list tidy-up (会话列表自动收敛):
 *  - prune empty「新对话」 that were created, never used, and are older than a day
 *  - auto-archive plain conversations inactive longer than `autoArchiveDays`
 *
 * Both are rule-based + reversible-ish (archive is soft, shown under 「显示归档」;
 * prune only removes verifiably-empty default-titled chats). Pinned / employee /
 * group / scheduled sessions are never auto-archived. Runs on startup + every ~3h.
 */

const DAY = 86_400_000

// Conversations exempt from auto-archive: pinned, scheduled, employee-bound, group.
const ARCHIVE_GUARD =
  `archived IS NOT 1 AND is_scheduled IS NOT 1 AND pinned IS NOT 1 ` +
  `AND (employee_id IS NULL OR employee_id = '') ` +
  `AND (group_employee_ids IS NULL OR group_employee_ids = '')`

const EMPTY_CHAT_WHERE =
  `is_scheduled IS NOT 1 AND title LIKE '新对话%' AND created_at < ? ` +
  `AND id NOT IN (SELECT DISTINCT session_id FROM messages)`

export function tidySessions(): { archived: number; pruned: number } {
  const settings = getSettings()
  const now = Date.now()
  let archived = 0
  let pruned = 0

  // 1. prune abandoned empty 新对话 (no messages, >1 day old).
  if (settings.autoPruneEmptyChats !== false) {
    try {
      pruned = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE ${EMPTY_CHAT_WHERE}`, [now - DAY])?.n ?? 0
      if (pruned > 0) dbRun(`DELETE FROM sessions WHERE ${EMPTY_CHAT_WHERE}`, [now - DAY])
    } catch (e) { console.warn('[tidy] prune empty chats failed:', (e as Error).message); pruned = 0 }
  }

  // 2. auto-archive inactive plain conversations.
  const days = settings.autoArchiveDays ?? 30
  if (days > 0) {
    try {
      const cutoff = now - days * DAY
      archived = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM sessions WHERE ${ARCHIVE_GUARD} AND updated_at < ?`, [cutoff])?.n ?? 0
      // NOTE: bulk auto-archive intentionally does NOT trigger memory capture
      // (would fire dozens of LLM calls); manual archive still does.
      if (archived > 0) dbRun(`UPDATE sessions SET archived = 1 WHERE ${ARCHIVE_GUARD} AND updated_at < ?`, [cutoff])
    } catch (e) { console.warn('[tidy] auto-archive failed:', (e as Error).message); archived = 0 }
  }

  return { archived, pruned }
}

let timer: ReturnType<typeof setInterval> | null = null

/** Run tidy now, then every ~3h. Notifies the renderer (SESSIONS_CHANGED) to
 *  reload the list whenever something actually changed. Call once on startup. */
export function startSessionTidy(): void {
  const run = (): void => {
    let res: { archived: number; pruned: number }
    try { res = tidySessions() } catch { return }
    if (res.archived || res.pruned) {
      console.log(`[tidy] auto-archived ${res.archived}, pruned ${res.pruned} empty chats`)
      void import('../index')
        .then(({ getMainWindow }) => {
          const w = getMainWindow()
          if (w && !w.isDestroyed()) w.webContents.send(IPC.SESSIONS_CHANGED)
        })
        .catch(() => { /* window not ready */ })
    }
  }
  run()
  if (timer) clearInterval(timer)
  timer = setInterval(run, 3 * 60 * 60_000)
  timer.unref?.()
}
