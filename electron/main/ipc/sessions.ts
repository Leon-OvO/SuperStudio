import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC, RUNTIME_ADAPTERS_READY, type SessionRuntime } from '../../../src/shared/ipc-types'
import { BRAND } from '../../../src/shared/brand'
import { dbRun, dbAll, dbGet } from '../db/sqlite'
import { randomUUID } from 'crypto'

/** Best-effort: distill long-term memories from a session's transcript in the
 *  background. Honors the auto-capture setting; never throws into callers. */
async function captureSessionMemoryInBackground(sessionId: string): Promise<void> {
  try {
    const { getSettings } = await import('../services/store')
    if (getSettings().memoryAutoCapture === false) return
    const { captureFromTranscript } = await import('../services/memory')
    const rows = dbAll<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
      [sessionId]
    )
    const transcript = rows
      .filter(r => r.content && r.content.trim())
      .map(r => `${r.role === 'user' ? '用户' : 'AI'}: ${r.content}`)
      .join('\n\n')
    const inserted = await captureFromTranscript({
      transcript,
      source: `session:${sessionId}`,
      allowedKinds: ['profile', 'episode', 'skill'],
      scopeKey: sessionId,
    })
    if (inserted.length) {
      const { getMainWindow } = await import('../index')
      getMainWindow()?.webContents.send(IPC.MEMORY_CAPTURED, { count: inserted.length, memories: inserted })
    }
  } catch (e) {
    console.warn('[memory] session archive capture failed:', (e as Error).message)
  }
}

export function sessionHandlers(): void {
  ipcMain.handle(IPC.SESSIONS_LIST, () => {
    const rows = dbAll<Record<string, unknown> & { groupEmployeeIdsJson: string | null }>(`
      SELECT s.id, s.title,
             s.created_at AS createdAt,
             s.updated_at AS updatedAt,
             COALESCE(s.archived, 0) AS archived,
             COALESCE(s.is_scheduled, 0) AS isScheduled,
             COALESCE(s.pinned, 0) AS pinned,
             COALESCE(s.host_mode, 0) AS hostMode,
             s.working_dir AS workingDir,
             s.employee_id AS employeeId,
             s.runtime AS runtime,
             s.group_employee_ids AS groupEmployeeIdsJson,
             COALESCE((SELECT SUM(cost_usd)      FROM messages WHERE session_id = s.id), 0) AS totalCostUsd,
             COALESCE((SELECT SUM(input_tokens)  FROM messages WHERE session_id = s.id), 0) AS totalInputTokens,
             COALESCE((SELECT SUM(output_tokens) FROM messages WHERE session_id = s.id), 0) AS totalOutputTokens
      FROM sessions s
      ORDER BY s.updated_at DESC
    `)
    return rows.map(({ groupEmployeeIdsJson, ...r }) => {
      let groupEmployeeIds: string[] | null = null
      if (groupEmployeeIdsJson) { try { groupEmployeeIds = JSON.parse(groupEmployeeIdsJson) } catch { /* malformed → null */ } }
      return { ...r, groupEmployeeIds }
    })
  })

  ipcMain.handle(IPC.SESSIONS_CREATE, (_e, title?: string, opts?: { isScheduled?: boolean; employeeId?: string | null; groupEmployeeIds?: string[] | null }) => {
    const id = randomUUID()
    const now = Date.now()
    const name = title || `新对话 ${new Date(now).toLocaleString('zh-CN')}`
    const employeeId = opts?.employeeId ?? null
    const groupIds = opts?.groupEmployeeIds?.length ? opts.groupEmployeeIds : null
    dbRun(
      `INSERT INTO sessions (id, title, created_at, updated_at, is_scheduled, employee_id, group_employee_ids) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, now, now, opts?.isScheduled ? 1 : 0, employeeId, groupIds ? JSON.stringify(groupIds) : null]
    )
    return { id, title: name, createdAt: now, updatedAt: now, isScheduled: opts?.isScheduled ? 1 : 0, employeeId, groupEmployeeIds: groupIds }
  })

  // Bind / unbind a hired employee to a conversation. Null clears the binding
  // (session reverts to a plain chat). The bound employee's soul persona + model
  // take effect on the next run (read live from the session row in the engine).
  ipcMain.handle(IPC.SESSIONS_SET_ASSIGNEE, (_e, id: string, employeeId: string | null) => {
    dbRun(`UPDATE sessions SET employee_id = ? WHERE id = ?`, [employeeId || null, id])
    return { ok: true }
  })

  // 选择本会话的 Agent 引擎（覆盖全局默认）。null = 清除覆盖、跟随全局。
  // 'builtin' 是显式档位（钉住内置自研引擎），与「未设」不同。下一轮生效（运行时实时读会话行）。
  ipcMain.handle(IPC.SESSIONS_SET_RUNTIME, (_e, id: string, runtime: SessionRuntime | null) => {
    const allowed: SessionRuntime[] = ['builtin', ...RUNTIME_ADAPTERS_READY]
    const next = runtime && allowed.includes(runtime) ? runtime : null
    dbRun(`UPDATE sessions SET runtime = ? WHERE id = ?`, [next, id])
    return { ok: true, runtime: next }
  })

  // Group chat membership — pull an employee in (拉人进群) or remove one. Mutates
  // the session's group_employee_ids JSON; the new member joins from the next round.
  function readGroupIds(id: string): string[] {
    const row = dbGet<{ group_employee_ids: string | null }>(`SELECT group_employee_ids FROM sessions WHERE id = ?`, [id])
    if (!row?.group_employee_ids) return []
    try { return JSON.parse(row.group_employee_ids) as string[] } catch { return [] }
  }
  ipcMain.handle(IPC.SESSIONS_ADD_MEMBER, (_e, id: string, employeeId: string) => {
    const ids = readGroupIds(id)
    if (!ids.includes(employeeId)) ids.push(employeeId)
    dbRun(`UPDATE sessions SET group_employee_ids = ? WHERE id = ?`, [JSON.stringify(ids), id])
    return { ok: true, groupEmployeeIds: ids }
  })
  ipcMain.handle(IPC.SESSIONS_REMOVE_MEMBER, (_e, id: string, employeeId: string) => {
    const ids = readGroupIds(id).filter(x => x !== employeeId)
    dbRun(`UPDATE sessions SET group_employee_ids = ? WHERE id = ?`, [ids.length ? JSON.stringify(ids) : null, id])
    return { ok: true, groupEmployeeIds: ids }
  })

  ipcMain.handle(IPC.SESSIONS_DELETE, (_e, id: string) => {
    // Side-effect: if this session was a scheduled task's dedicated channel,
    // auto-pause the owning task. Task + run history stay, so the user can
    // re-enable later (which will rebuild a fresh dedicated session).
    try {
      dbRun(`UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE session_id = ?`, [Date.now(), id])
    } catch { /* table may not exist on very old DBs — ignore */ }
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
    // Archiving a chat = a natural "done" signal → distill long-term memories
    // from it in the background (best-effort, never blocks the reply).
    if (archived) void captureSessionMemoryInBackground(id)
    return { ok: true }
  })

  // Pin / unpin a conversation. Pinned sessions sort into a top「置顶」section and
  // are excluded from auto-archive (see session-tidy.ts).
  ipcMain.handle(IPC.SESSIONS_SET_PINNED, (_e, id: string, pinned: boolean) => {
    dbRun(`UPDATE sessions SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, id])
    return { ok: true }
  })

  // Group chat: toggle 主持人持续推进. Turning it off mid-run does NOT abort the
  // current round — it just stops the host from queuing the next one (the loop
  // re-reads host_mode each round). group_goal is set by the group runner.
  ipcMain.handle(IPC.SESSIONS_SET_HOST_MODE, (_e, id: string, on: boolean) => {
    dbRun(`UPDATE sessions SET host_mode = ? WHERE id = ?`, [on ? 1 : 0, id])
    return { ok: true }
  })

  // Pin (or clear) a conversation's working directory. Validated against the
  // real filesystem here so a stale/typo'd path never reaches the agent: a
  // non-existent or non-directory path is rejected; an empty string clears it
  // (stored as NULL → the agent falls back to the desktop default).
  ipcMain.handle(IPC.SESSIONS_SET_WORKING_DIR, (_e, id: string, dir: string) => {
    const trimmed = (dir ?? '').trim()
    if (trimmed) {
      // Invariant: working dir is an ABSOLUTE path. A relative value would be
      // resolved against the main-process CWD here AND again in the engine
      // (path.resolve), making the approved root silently depend on CWD.
      if (!path.isAbsolute(trimmed)) return { ok: false, error: '工作目录必须是绝对路径' }
      try {
        if (!fs.statSync(trimmed).isDirectory()) return { ok: false, error: '所选路径不是文件夹' }
      } catch {
        return { ok: false, error: '文件夹不存在或无法访问' }
      }
    }
    dbRun(`UPDATE sessions SET working_dir = ? WHERE id = ?`, [trimmed || null, id])
    return { ok: true, workingDir: trimmed }
  })

  ipcMain.handle(IPC.MESSAGES_LIST, (_e, sessionId: string) => {
    const rows = dbAll<{
      id: string; session_id: string; role: string; content: string;
      tool_calls: string | null; attachments: string | null; meta: string | null; created_at: number;
      input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; model: string | null;
      speaker_employee_id: string | null
    }>(`SELECT id, session_id, role, content, tool_calls, attachments, meta, created_at,
               input_tokens, output_tokens, cost_usd, model, speaker_employee_id
        FROM messages WHERE session_id = ? ORDER BY created_at ASC`, [sessionId])
    return rows.map(r => {
      const baseMeta = r.meta ? JSON.parse(r.meta) : undefined
      // Prefer columns when present; fall back to whatever was inlined in meta
      // for rows written before the migration.
      const meta = (baseMeta || r.input_tokens != null || r.output_tokens != null || r.cost_usd != null || r.model)
        ? {
            ...(baseMeta || {}),
            ...(r.model ? { model: r.model } : {}),
            ...(r.input_tokens != null ? { inputTokens: r.input_tokens } : {}),
            ...(r.output_tokens != null ? { outputTokens: r.output_tokens } : {}),
            ...(r.cost_usd != null ? { costUsd: r.cost_usd } : {})
          }
        : undefined
      return {
        id: r.id,
        sessionId: r.session_id,
        role: r.role,
        content: r.content,
        toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
        attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
        meta,
        createdAt: r.created_at,
        speakerEmployeeId: r.speaker_employee_id || undefined
      }
    })
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

  ipcMain.handle(IPC.MESSAGES_CLEAR_SESSION, (_e, sessionId: string) => {
    const before = dbGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?`,
      [sessionId]
    )?.cnt ?? 0
    dbRun(`DELETE FROM messages WHERE session_id = ?`, [sessionId])
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

    const sessions = dbAll(`SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, COALESCE(archived, 0) AS archived, COALESCE(is_scheduled, 0) AS isScheduled, working_dir AS workingDir, employee_id AS employeeId, group_employee_ids AS groupEmployeeIdsJson FROM sessions ORDER BY created_at ASC`)
    const messages = dbAll(
      `SELECT id, session_id AS sessionId, role, content, tool_calls AS toolCallsJson,
              attachments AS attachmentsJson, meta AS metaJson, created_at AS createdAt,
              speaker_employee_id AS speakerEmployeeId
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
      sessions?: Array<{ id: string; title: string; createdAt: number; updatedAt: number; archived?: number; isScheduled?: number; workingDir?: string | null; employeeId?: string | null; groupEmployeeIdsJson?: string | null }>
      messages?: Array<{
        id: string; sessionId: string; role: string; content: string;
        toolCallsJson?: string | null; attachmentsJson?: string | null; metaJson?: string | null;
        createdAt: number; speakerEmployeeId?: string | null
      }>
    }
    if (!data || typeof data !== 'object' || data.version !== 1) {
      return { canceled: false, error: `不是 ${BRAND.displayName} 对话导出文件（缺少 version=1）` }
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
        `INSERT OR REPLACE INTO sessions (id, title, created_at, updated_at, archived, is_scheduled, working_dir, employee_id, group_employee_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, s.title, s.createdAt, s.updatedAt, s.archived ?? 0, s.isScheduled ?? 0, s.workingDir ?? null, s.employeeId ?? null, s.groupEmployeeIdsJson ?? null]
      )
      sessionsAdded++
    }
    for (const m of data.messages ?? []) {
      const existing = dbGet(`SELECT id FROM messages WHERE id = ?`, [m.id])
      if (existing && strategy === 'merge') continue
      dbRun(
        `INSERT OR REPLACE INTO messages (id, session_id, role, content, tool_calls, attachments, meta, created_at, speaker_employee_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          m.id, m.sessionId, m.role, m.content,
          m.toolCallsJson ?? null, m.attachmentsJson ?? null, m.metaJson ?? null,
          m.createdAt, m.speakerEmployeeId ?? null
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
