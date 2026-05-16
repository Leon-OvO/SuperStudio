import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import { IPC } from '../../../src/shared/ipc-types'
import { dbRun, dbAll, dbGet } from '../db/sqlite'
import { randomUUID } from 'crypto'

export function sessionHandlers(): void {
  ipcMain.handle(IPC.SESSIONS_LIST, () =>
    dbAll(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, COALESCE(archived, 0) AS archived FROM sessions ORDER BY updated_at DESC`)
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

  ipcMain.handle(IPC.SESSIONS_ARCHIVE, (_e, id: string, archived: boolean) => {
    dbRun(`UPDATE sessions SET archived = ? WHERE id = ?`, [archived ? 1 : 0, id])
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

  /**
   * Full-text-ish session search. Matches on session title OR any message
   * content within that session. Returns session ids — caller intersects
   * with its in-memory session list to render.
   *
   * sql.js doesn't have a real FTS index, but case-insensitive LIKE on the
   * messages.content column scales fine to tens of thousands of rows.
   */
  ipcMain.handle(IPC.SESSIONS_SEARCH, (_e, rawQuery: string, includeArchived = false) => {
    const q = (rawQuery ?? '').trim()
    if (!q) return { matchedSessionIds: [] as string[] }
    const like = `%${q.replace(/[%_]/g, ch => '\\' + ch)}%`

    const archivedFilter = includeArchived ? '' : ' AND COALESCE(archived, 0) = 0'
    const byTitle = dbAll<{ id: string }>(
      `SELECT id FROM sessions WHERE title LIKE ? ESCAPE '\\'` + archivedFilter,
      [like]
    ).map(r => r.id)

    const byContent = dbAll<{ session_id: string }>(
      `SELECT DISTINCT m.session_id FROM messages m
       JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ? ESCAPE '\\'` + (includeArchived ? '' : ' AND COALESCE(s.archived, 0) = 0'),
      [like]
    ).map(r => r.session_id)

    const ids = Array.from(new Set([...byTitle, ...byContent]))
    return { matchedSessionIds: ids }
  })

  /**
   * Bulk export: dump every session + its messages to a single JSON file. This
   * is the "back up my whole chat history" complement to config:export (which
   * only ships providers / settings / MCP). Schema v1:
   *   { exportedAt, version: 1, sessions: [...], messages: [...] }
   * Attachments are referenced by absolute path only — the bytes themselves
   * are NOT bundled (would balloon the file). If the user moves to a new
   * machine, image / file paths in restored messages won't resolve, but the
   * text history will.
   */
  ipcMain.handle(IPC.SESSIONS_EXPORT_ALL, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const opts = {
      defaultPath: `superstudio-chats-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (dlg.canceled || !dlg.filePath) return { canceled: true }

    const sessions = dbAll(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, COALESCE(archived, 0) AS archived FROM sessions ORDER BY created_at ASC`)
    const messages = dbAll(
      `SELECT id, session_id AS sessionId, role, content, tool_calls AS toolCallsJson,
              attachments AS attachmentsJson, meta AS metaJson, created_at AS createdAt
       FROM messages ORDER BY created_at ASC`
    )
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      sessions,
      messages
    }
    fs.writeFileSync(dlg.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { canceled: false, filePath: dlg.filePath, sessionCount: sessions.length, messageCount: messages.length }
  })

  ipcMain.handle(IPC.SESSIONS_IMPORT, async (e, opts?: { strategy?: 'merge' | 'replace' }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const strategy = opts?.strategy ?? 'merge'
    const dlgOpts = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] }
    const dlg = win ? await dialog.showOpenDialog(win, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(dlg.filePaths[0], 'utf8'))
    } catch (err) {
      return { canceled: false, error: '文件不是合法 JSON：' + (err as Error).message }
    }
    const data = parsed as {
      version?: number
      sessions?: Array<{ id: string; title: string; createdAt: number; updatedAt: number; archived?: number }>
      messages?: Array<{
        id: string; sessionId: string; role: string; content: string;
        toolCallsJson?: string | null; attachmentsJson?: string | null; metaJson?: string | null;
        createdAt: number
      }>
    }
    if (!data || typeof data !== 'object' || data.version !== 1) {
      return { canceled: false, error: '不是 SuperStudio 对话导出文件（缺少 version=1）' }
    }

    if (strategy === 'replace') {
      dbRun(`DELETE FROM messages`, [])
      dbRun(`DELETE FROM sessions`, [])
    }

    let sessionsAdded = 0, sessionsSkipped = 0, messagesAdded = 0
    for (const s of data.sessions ?? []) {
      const existing = dbGet(`SELECT id FROM sessions WHERE id = ?`, [s.id])
      if (existing) {
        if (strategy === 'merge') { sessionsSkipped++; continue }
      }
      dbRun(
        `INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?)`,
        [s.id, s.title, s.createdAt, s.updatedAt, s.archived ?? 0]
      )
      sessionsAdded++
    }
    for (const m of data.messages ?? []) {
      const existing = dbGet(`SELECT id FROM messages WHERE id = ?`, [m.id])
      if (existing && strategy === 'merge') continue
      dbRun(
        `INSERT OR REPLACE INTO messages (id, session_id, role, content, tool_calls, attachments, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id, m.sessionId, m.role, m.content,
          m.toolCallsJson ?? null, m.attachmentsJson ?? null, m.metaJson ?? null,
          m.createdAt
        ]
      )
      messagesAdded++
    }
    return {
      canceled: false, strategy, filePath: dlg.filePaths[0],
      sessionsAdded, sessionsSkipped, messagesAdded
    }
  })
}
