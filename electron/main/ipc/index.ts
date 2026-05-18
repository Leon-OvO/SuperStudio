import { ipcMain, dialog, app } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { settingsHandlers } from './settings'
import { sessionHandlers } from './sessions'
import { agentHandlers } from './agent'
import { fileHandlers } from './files'
import { galleryHandlers } from './gallery'
import { kbHandlers } from './knowledge'
import { workflowHandlers } from './workflows'
import { imageEditHandlers } from './image-edit'
import { mcpHandlers } from './mcp'
import { logEntry, getEntriesFromDisk, clearEntries } from '../services/error-log'

export function registerIpcHandlers(): void {
  settingsHandlers()
  sessionHandlers()
  agentHandlers()
  fileHandlers()
  galleryHandlers()
  kbHandlers()
  workflowHandlers()
  imageEditHandlers()
  mcpHandlers()

  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion())

  ipcMain.handle(IPC.LOG_LIST, () => getEntriesFromDisk(500))
  ipcMain.handle(IPC.LOG_CLEAR, () => { clearEntries(); return { ok: true } })
  ipcMain.handle(IPC.LOG_APPEND, (_e, entry: { level: 'error' | 'warn' | 'info'; message: string; stack?: string; context?: Record<string, unknown> }) => {
    logEntry({ source: 'renderer', ...entry })
    return { ok: true }
  })

  ipcMain.handle(IPC.FILE_OPEN_DIALOG, async (_e, options) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported Files', extensions: ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'txt', 'md'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'Word', extensions: ['docx', 'doc'] },
        { name: 'PowerPoint', extensions: ['pptx', 'ppt'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Text', extensions: ['txt', 'md'] },
      ],
      ...options
    })
    // User explicitly handed us these paths → trust them for this session.
    const { registerApproved } = await import('../services/path-allow')
    for (const p of result.filePaths) registerApproved(p)
    return result.filePaths
  })
}
