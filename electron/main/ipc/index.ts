import { ipcMain, dialog, app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import { IPC } from '../../../src/shared/ipc-types'
import { listApiRequestLog, clearApiRequestLog, getApiRequestLogPath } from '../services/request-log'
import { settingsHandlers } from './settings'
import { sessionHandlers } from './sessions'
import { agentHandlers } from './agent'
import { groupChatHandlers } from './group-chat'
import { fileHandlers } from './files'
import { galleryHandlers } from './gallery'
import { memoryHandlers } from './memory'
import { workflowHandlers } from './workflows'
import { imageEditHandlers } from './image-edit'
import { videoHandlers } from './video'
import { mcpHandlers } from './mcp'
import { getAuthProvider } from '../services/auth-provider'
import { vibeHandlers } from './vibe'
import { skillsHandlers } from './skills'
import { terminalHandlers } from './terminal'
import { systemHandlers } from './system'
import { updaterHandlers } from './updater'
import { modelConfHandlers } from './model-conf'
import { talentHandlers } from './talent'
import { employeeHandlers } from './employees'
import { schedulerHandlers } from './scheduler'
import { sshHandlers } from './ssh'
import { usageHandlers } from './usage'
import { logEntry, getEntriesFromDisk, clearEntries } from '../services/error-log'

export function registerIpcHandlers(): void {
  // Register each handler group independently. If one group throws (a bad
  // import, a future duplicate channel, …) the others — crucially the auth
  // handlers — must still register. Without isolation a single failure aborts
  // the whole function, and every later group's invoke then fails at runtime
  // with "No handler registered for …".
  // Auth + account IPC is owned by the injected AuthProvider seam (BYOK shell by
  // default; the supercode overlay registers the full account + dashboard set).
  // Registered first so the renderer's AUTH_GET_STATE always has a handler.
  try {
    getAuthProvider().registerIpcHandlers()
  } catch (e) {
    console.error('[ipc] auth provider registration failed:', (e as Error)?.message ?? e)
  }

  const groups: ReadonlyArray<readonly [string, () => void]> = [
    ['settings', settingsHandlers],
    ['sessions', sessionHandlers],
    ['agent', agentHandlers],
    ['groupChat', groupChatHandlers],
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
    ['ssh', sshHandlers],
    ['usage', usageHandlers],
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

  // API request log (opt-in diagnostics)
  ipcMain.handle(IPC.API_LOG_LIST, () => listApiRequestLog(500))
  ipcMain.handle(IPC.API_LOG_CLEAR, () => { clearApiRequestLog(); return { ok: true } })
  ipcMain.handle(IPC.API_LOG_OPEN, async () => {
    const file = getApiRequestLogPath()
    if (fs.existsSync(file)) { shell.showItemInFolder(file); return { ok: true } }
    await shell.openPath(path.dirname(file)) // 还没写过日志 → 打开 logs 目录
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
