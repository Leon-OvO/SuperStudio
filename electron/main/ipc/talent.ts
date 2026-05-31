import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { browseCatalog, getSoul } from '../services/talent-pool'

export function talentHandlers(): void {
  ipcMain.handle(IPC.TALENT_BROWSE, (_e, args?: { dept?: string; keyword?: string; page?: number; pageSize?: number }) =>
    browseCatalog(args ?? {}))

  ipcMain.handle(IPC.TALENT_GET, (_e, id: string) => getSoul(id))
}
