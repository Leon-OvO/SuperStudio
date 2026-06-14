import { ipcMain, app, dialog, shell, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { readFile, writeFile } from '../services/fileops'
import { registerApproved } from '../services/path-allow'
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

  // Approve a path the user dropped onto the composer. Drag-drop resolves the real
  // path via webUtils.getPathForFile (a pure preload call that never reaches main),
  // so unlike the file picker / paste it isn't allowlisted — and the local-file
  // protocol would 403 its preview. The renderer awaits this before rendering.
  ipcMain.handle(IPC.FILE_APPROVE_PATH, (_e, filePath: string) => {
    if (typeof filePath === 'string' && filePath) registerApproved(filePath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FILE_WRITE_TEMP, (_e, { name, data }: { name: string; data: string }) => {
    const tempDir = path.join(app.getPath('userData'), 'temp')
    fs.mkdirSync(tempDir, { recursive: true })
    const filePath = path.join(tempDir, name)
    fs.writeFileSync(filePath, Buffer.from(data, 'base64'))
    registerApproved(filePath)  // user-pasted → trusted for this session
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

  // 把一组绝对路径批量拷到用户选的文件夹。画布节点只有文件路径、没有素材库 id，
  // 所以不能复用 gallery:batch-save（它按 id 查），单独走这条按路径导出。重名追加 " (n)"。
  ipcMain.handle(IPC.FILE_EXPORT_TO_DIR, async (e, paths: string[]) => {
    if (!Array.isArray(paths) || paths.length === 0) return { canceled: true, saved: 0 }
    const win = BrowserWindow.fromWebContents(e.sender)
    const dlg = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (dlg.canceled || !dlg.filePaths[0]) return { canceled: true, saved: 0 }
    const targetDir = dlg.filePaths[0]
    let saved = 0
    const failures: string[] = []
    for (const src of paths) {
      if (!src || !fs.existsSync(src)) { failures.push(src); continue }
      const base = path.basename(src)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let dest = path.join(targetDir, base)
      let n = 1
      while (fs.existsSync(dest)) { dest = path.join(targetDir, `${stem} (${n})${ext}`); n++ }
      try { fs.copyFileSync(src, dest); saved++ } catch { failures.push(src) }
    }
    return { canceled: false, saved, failures, targetDir }
  })

  ipcMain.handle(IPC.SHELL_SHOW_ITEM, (_e, filePath: string) => {
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath)
    shell.showItemInFolder(filePath)
    return { ok: true }
  })

  ipcMain.handle(IPC.FILE_SAVE_TEXT, async (e, params: { defaultName: string; content: string; filters?: Array<{ name: string; extensions: string[] }> }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      defaultPath: params.defaultName,
      filters: params.filters ?? [{ name: 'Text', extensions: ['txt'] }, { name: 'All Files', extensions: ['*'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (result.canceled || !result.filePath) return { canceled: true }
    fs.writeFileSync(result.filePath, params.content, 'utf8')
    return { canceled: false, filePath: result.filePath }
  })
}
