import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { dbRun, dbAll, dbGet } from '../db/sqlite'
import { randomUUID } from 'crypto'

export function sessionHandlers(): void {
  ipcMain.handle(IPC.SESSIONS_LIST, () =>
    dbAll(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM sessions ORDER BY updated_at DESC`)
  )

  ipcMain.handle(IPC.SESSIONS_CREATE, (_e, title?: string) => {
    const id = randomUUID()
    const now = Date.now()
    const name = title || `新对话 ${new Date(now).toLocaleString('zh-CN')}`
    dbRun(`INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, name, now, now])
    return { id, title: name, createdAt: now, updatedAt: now }
  })

  ipcMain.handle(IPC.SESSIONS_DELETE, (_e, id: string) => {
    dbRun(`DELETE FROM messages WHERE session_id = ?`, [id])
    dbRun(`DELETE FROM sessions WHERE id = ?`, [id])
    return { ok: true }
  })

  ipcMain.handle(IPC.SESSIONS_RENAME, (_e, id: string, title: string) => {
    dbRun(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`, [title, Date.now(), id])
    return { ok: true }
  })

  ipcMain.handle(IPC.MESSAGES_LIST, (_e, sessionId: string) => {
    const rows = dbAll<{
      id: string; session_id: string; role: string; content: string;
      tool_calls: string | null; attachments: string | null; meta: string | null; created_at: number
    }>(`SELECT id, session_id, role, content, tool_calls, attachments, meta, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC`, [sessionId])
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
      meta: r.meta ? JSON.parse(r.meta) : undefined,
      createdAt: r.created_at
    }))
  })

  ipcMain.handle(IPC.MESSAGES_DELETE, (_e, messageId: string) => {
    dbRun(`DELETE FROM messages WHERE id = ?`, [messageId])
    return { ok: true }
  })

  /**
   * Delete the target message AND every message in the same session created
   * at-or-after it. Used by regenerate (delete last assistant msg + retry) and
   * edit (delete user msg + everything after, then re-send the edited text).
   */
  ipcMain.handle(IPC.MESSAGES_DELETE_FROM, (_e, messageId: string) => {
    const row = dbGet<{ session_id: string; created_at: number }>(
      `SELECT session_id, created_at FROM messages WHERE id = ?`,
      [messageId]
    )
    if (!row) return { ok: false, deleted: 0 }
    // Count then delete for a useful return value
    const before = dbAll<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ? AND created_at >= ?`,
      [row.session_id, row.created_at]
    )[0]?.cnt ?? 0
    dbRun(
      `DELETE FROM messages WHERE session_id = ? AND created_at >= ?`,
      [row.session_id, row.created_at]
    )
    return { ok: true, deleted: before }
  })

  ipcMain.handle(IPC.MESSAGES_UPDATE, (_e, messageId: string, content: string) => {
    dbRun(`UPDATE messages SET content = ? WHERE id = ?`, [content, messageId])
    return { ok: true }
  })
}
