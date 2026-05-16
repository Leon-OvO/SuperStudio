import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { readFile, writeFile } from '../services/fileops'
import fs from 'fs'
import path from 'path'

export function fileHandlers(): void {
  ipcMain.handle(IPC.FILE_READ, async (_e, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle(IPC.FILE_WRITE, async (_e, params) => {
    return writeFile(params)
  })

  ipcMain.handle(IPC.FILE_REVERT_BACKUP, (_e, backupPath: string, targetPath: string) => {
    if (!fs.existsSync(backupPath)) throw new Error('Backup file not found')
    fs.copyFileSync(backupPath, targetPath)
    return { ok: true, restoredTo: targetPath }
  })

  ipcMain.handle(IPC.FILE_WRITE_TEMP, (_e, { name, data }: { name: string; data: string }) => {
    const tempDir = path.join(app.getPath('userData'), 'temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const filePath = path.join(tempDir, name)
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
    return { path: filePath, name }
  })

  ipcMain.handle(IPC.FILE_SAVE_AS, async (e, sourcePath: string, suggestedName?: string) => {
    if (!fs.existsSync(sourcePath)) throw new Error('Source file not found: ' + sourcePath)
    const ext = path.extname(sourcePath).replace(/^\./, '') || 'bin'
    const defaultName = suggestedName || path.basename(sourcePath)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      defaultPath: defaultName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.copyFileSync(sourcePath, result.filePath)
    return { canceled: false, filePath: result.filePath }
  })

  ipcMain.handle(IPC.SHELL_SHOW_ITEM, (_e, filePath: string) => {
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath)
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
}
