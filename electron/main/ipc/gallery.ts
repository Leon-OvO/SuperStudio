import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { listGallery, deleteGalleryItem, batchDeleteGallery } from '../services/gallery'

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
}
