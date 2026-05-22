import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { checkForUpdates, openReleasePage } from '../services/updater'

export function updaterHandlers(): void {
  ipcMain.handle(IPC.UPDATER_CHECK, () => checkForUpdates())
  ipcMain.on(IPC.UPDATER_OPEN_RELEASE, (_e, url?: string) => openReleasePage(url))
}
