import { ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
import { IPC } from '../../../src/shared/ipc-types'
import { dbAll } from '../db/sqlite'
import { getMainWindow } from '../index'
import {
  listMemories, saveMemory, deleteMemory, deleteMemories, deleteArchived, pruneMemories,
  setMemoryPinned, setMemoryStatus, captureFromTranscript, importMemories,
  type MemoryInput, type MemoryKind
} from '../services/memory'

/** Build a compact transcript from a chat session's messages for capture. */
function sessionTranscript(sessionId: string): string {
  const rows = dbAll<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    [sessionId]
  )
  return rows
    .filter(r => r.content && r.content.trim())
    .map(r => `${r.role === 'user' ? '用户' : 'AI'}: ${r.content}`)
    .join('\n\n')
}

export function memoryHandlers(): void {
  ipcMain.handle(IPC.MEMORY_LIST, (_e, filter?: { kind?: MemoryKind; scopeKey?: string | null; status?: string; query?: string }) =>
    listMemories(filter)
  )

  ipcMain.handle(IPC.MEMORY_SAVE, (_e, input: MemoryInput) => saveMemory(input))

  ipcMain.handle(IPC.MEMORY_DELETE, (_e, id: string) => { deleteMemory(id); return { ok: true } })

  // Batch hard-delete (multi-select). Explicit user action → no exemption.
  ipcMain.handle(IPC.MEMORY_DELETE_MANY, (_e, ids: string[]) => ({ ok: true, deleted: deleteMemories(ids || []) }))

  // Empty the archive ("回收站"). Optional kind filter; spares the exempt classes.
  ipcMain.handle(IPC.MEMORY_DELETE_ARCHIVED, (_e, kind?: MemoryKind) => ({ ok: true, deleted: deleteArchived(kind) }))

  // Manual「整理」: run one two-stage decay pass now (unthrottled) and report counts.
  ipcMain.handle(IPC.MEMORY_PRUNE, () => {
    const res = pruneMemories()
    if (res.archived || res.deleted) getMainWindow()?.webContents.send(IPC.MEMORY_CHANGED)
    return { ok: true, ...res }
  })

  // Import external memory assets (.json/.jsonl/.md). Paths come from
  // openFileDialog (already session-approved); we read them in-process.
  ipcMain.handle(IPC.MEMORY_IMPORT, (_e, paths: string[]) => importMemories({ paths: paths || [] }))

  // Export all active memories to a JSON file the user picks. Shape mirrors what
  // importMemories accepts ({ memories: [{ kind, scopeKey, title, content, tags,
  // pinned, confidence, source }] }) so an export round-trips cleanly back in.
  ipcMain.handle(IPC.MEMORY_EXPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const opts = {
      defaultPath: `memories-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (dlg.canceled || !dlg.filePath) return { canceled: true }
    const memories = listMemories({ status: 'active' }).map(r => ({
      kind: r.kind,
      scopeKey: r.scope_key,
      title: r.title,
      content: r.content,
      tags: (() => { try { return JSON.parse(r.tags || '[]') as string[] } catch { return [] } })(),
      pinned: !!r.pinned,
      confidence: r.confidence ?? undefined,
      source: r.source ?? undefined,
    }))
    const payload = { exportedAt: new Date().toISOString(), version: 1, count: memories.length, memories }
    fs.writeFileSync(dlg.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { canceled: false, filePath: dlg.filePath, count: memories.length }
  })

  ipcMain.handle(IPC.MEMORY_SET_PINNED, (_e, args: { id: string; pinned: boolean }) => {
    setMemoryPinned(args.id, args.pinned)
    return { ok: true }
  })

  ipcMain.handle(IPC.MEMORY_ARCHIVE, (_e, args: { id: string; archived: boolean }) => {
    setMemoryStatus(args.id, args.archived ? 'archived' : 'active')
    return { ok: true }
  })

  // Manual "记住这次对话" — distill memories from a whole session.
  ipcMain.handle(IPC.MEMORY_CAPTURE_SESSION, async (_e, sessionId: string) => {
    const transcript = sessionTranscript(sessionId)
    const inserted = await captureFromTranscript({
      transcript,
      source: `session:${sessionId}`,
      allowedKinds: ['profile', 'episode', 'skill'],
      scopeKey: sessionId,
    })
    if (inserted.length) {
      getMainWindow()?.webContents.send(IPC.MEMORY_CAPTURED, { count: inserted.length, memories: inserted })
    }
    return { ok: true, count: inserted.length, memories: inserted }
  })
}
