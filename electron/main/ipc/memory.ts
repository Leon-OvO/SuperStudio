import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { dbAll } from '../db/sqlite'
import { getMainWindow } from '../index'
import {
  listMemories, saveMemory, deleteMemory, setMemoryPinned, setMemoryStatus,
  captureFromTranscript, importMemories, type MemoryInput, type MemoryKind
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

  // Import external memory assets (.json/.jsonl/.md). Paths come from
  // openFileDialog (already session-approved); we read them in-process.
  ipcMain.handle(IPC.MEMORY_IMPORT, (_e, paths: string[]) => importMemories({ paths: paths || [] }))

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
