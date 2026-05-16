import { ipcMain, dialog, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { listGallery, deleteGalleryItem, batchDeleteGallery } from '../services/gallery'
import { dbAll } from '../db/sqlite'
import fs from 'fs'
import path from 'path'

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
}
