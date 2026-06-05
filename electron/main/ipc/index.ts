import { ipcMain, dialog, app } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { settingsHandlers } from './settings'
import { sessionHandlers } from './sessions'
import { agentHandlers } from './agent'
import { fileHandlers } from './files'
import { galleryHandlers } from './gallery'
import { memoryHandlers } from './memory'
import { workflowHandlers } from './workflows'
import { imageEditHandlers } from './image-edit'
import { videoHandlers } from './video'
import { mcpHandlers } from './mcp'
import { authHandlers } from './auth'
import { dashboardHandlers } from './dashboard'
import { vibeHandlers } from './vibe'
import { skillsHandlers } from './skills'
import { terminalHandlers } from './terminal'
import { systemHandlers } from './system'
import { updaterHandlers } from './updater'
import { modelConfHandlers } from './model-conf'
import { talentHandlers } from './talent'
import { employeeHandlers } from './employees'
import { schedulerHandlers } from './scheduler'
import { logEntry, getEntriesFromDisk, clearEntries } from '../services/error-log'

export function registerIpcHandlers(): void {
  // Register each handler group independently. If one group throws (a bad
  // import, a future duplicate channel, …) the others — crucially the auth
  // handlers — must still register. Without isolation a single failure aborts
  // the whole function, and every later group's invoke then fails at runtime
  // with "No handler registered for …".
  const groups: ReadonlyArray<readonly [string, () => void]> = [
    ['auth', authHandlers],
    ['dashboard', dashboardHandlers],
    ['settings', settingsHandlers],
    ['sessions', sessionHandlers],
    ['agent', agentHandlers],
    ['files', fileHandlers],
    ['gallery', galleryHandlers],
    ['memory', memoryHandlers],
    ['workflows', workflowHandlers],
    ['imageEdit', imageEditHandlers],
    ['video', videoHandlers],
    ['mcp', mcpHandlers],
    ['vibe', vibeHandlers],
    ['skills', skillsHandlers],
    ['terminal', terminalHandlers],
    ['system', systemHandlers],
    ['updater', updaterHandlers],
    ['modelConf', modelConfHandlers],
    ['talent', talentHandlers],
    ['employees', employeeHandlers],
    ['scheduler', schedulerHandlers],
  ]
  for (const [name, register] of groups) {
    try {
      register()
    } catch (e) {
      console.error(`[ipc] handler group "${name}" failed to register:`, (e as Error)?.message ?? e)
    }
  }

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
        { name: 'Supported Files', extensions: ['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'pdf', 'txt', 'md', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'Word', extensions: ['docx', 'doc'] },
        { name: 'PowerPoint', extensions: ['pptx', 'ppt'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Text', extensions: ['txt', 'md'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      ...options
    })
    // User explicitly handed us these paths → trust them for this session.
    const { registerApproved } = await import('../services/path-allow')
    for (const p of result.filePaths) registerApproved(p)
    return result.filePaths
  })
}
