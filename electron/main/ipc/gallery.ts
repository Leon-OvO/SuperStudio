import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { randomUUID } from 'crypto'
import { IPC } from '../../../src/shared/ipc-types'
import { listGallery, deleteGalleryItem, batchDeleteGallery, saveGalleryItem } from '../services/gallery'
import { getSettings } from '../services/store'
import { dbAll } from '../db/sqlite'
import fs from 'fs'
import path from 'path'

/** Library asset kinds keyed by lowercase file extension (no dot). */
const KIND_BY_EXT: Record<string, 'image' | 'video' | 'audio'> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  svg: 'image', bmp: 'image', avif: 'image',
  mp4: 'video', webm: 'video', mov: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio',
}

export function galleryHandlers(): void {
  ipcMain.handle(IPC.GALLERY_LIST, (_e, filters) => listGallery(filters))
  ipcMain.handle(IPC.GALLERY_DELETE, (_e, id: number) => {
    deleteGalleryItem(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.GALLERY_BATCH_DELETE, (_e, ids: number[]) => {
    batchDeleteGallery(ids)
    return { ok: true, deleted: ids.length }
  })

  /**
   * Copy every selected gallery item into a user-chosen folder. On name
   * collisions we append " (1)", " (2)", … so existing files are never
   * overwritten.
   */
  ipcMain.handle(IPC.GALLERY_BATCH_SAVE, async (e, ids: number[]) => {
    if (!Array.isArray(ids) || ids.length === 0) return { canceled: true, saved: 0 }
    const win = BrowserWindow.fromWebContents(e.sender)
    const dlg = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (dlg.canceled || !dlg.filePaths[0]) return { canceled: true, saved: 0 }
    const targetDir = dlg.filePaths[0]

    const placeholders = ids.map(() => '?').join(',')
    const rows = dbAll<{ file_path: string }>(
      `SELECT file_path FROM gallery WHERE id IN (${placeholders})`,
      ids
    )

    let saved = 0
    const failures: string[] = []
    for (const r of rows) {
      const src = r.file_path
      if (!src || !fs.existsSync(src)) { failures.push(src); continue }
      const base = path.basename(src)
      const ext = path.extname(base)
      const stem = base.slice(0, base.length - ext.length)
      let dest = path.join(targetDir, base)
      let n = 1
      while (fs.existsSync(dest)) {
        dest = path.join(targetDir, `${stem} (${n})${ext}`)
        n++
      }
      try { fs.copyFileSync(src, dest); saved++ } catch { failures.push(src) }
    }
    return { canceled: false, saved, failures, targetDir }
  })

  /**
   * Import local files into the library. Each picked file is copied into
   * gallery/{images,videos,audio} under a fresh UUID name so the library owns
   * its copy — deleting a library entry never touches the user's original.
   */
  ipcMain.handle(IPC.GALLERY_IMPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有素材', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] },
        { name: '视频', extensions: ['mp4', 'webm', 'mov'] },
        { name: '音频', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
      ],
    }
    const dlg = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true, imported: 0, failures: [] }

    const baseDir = getSettings().dataDirectory || app.getPath('userData')
    let imported = 0
    const failures: string[] = []
    for (const src of dlg.filePaths) {
      const ext = path.extname(src).slice(1).toLowerCase()
      const kind = KIND_BY_EXT[ext]
      if (!kind) { failures.push(src); continue }
      const subdir = kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio'
      const dir = path.join(baseDir, 'gallery', subdir)
      try {
        fs.mkdirSync(dir, { recursive: true })
        const dest = path.join(dir, `${randomUUID()}.${ext}`)
        fs.copyFileSync(src, dest)
        await saveGalleryItem({
          type: kind,
          filePath: dest,
          prompt: path.basename(src),
          source: 'import',
        })
        imported++
      } catch {
        failures.push(src)
      }
    }
    return { canceled: false, imported, failures }
  })
}
