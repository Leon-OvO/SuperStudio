import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { syncModelConf } from '../services/model-conf'

export function modelConfHandlers(): void {
  // Manual refresh — pull model.conf now and apply under the managed-default
  // policy. Returns which default fields (if any) were updated.
  ipcMain.handle(IPC.MODEL_CONF_SYNC, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return syncModelConf(() => win)
  })
}
