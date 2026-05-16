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
    return result.filePaths
  })
}
