import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { setAutoLaunch, setShellIntegration, getSystemState } from '../services/system-integration'
import { getSettings, saveSettings } from '../services/store'

export function systemHandlers(): void {
  ipcMain.handle(IPC.APP_SET_AUTO_LAUNCH, async (_e, enabled: boolean) => {
    try {
      setAutoLaunch(enabled)
      saveSettings({ autoLaunch: enabled })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.APP_SET_SHELL_INTEGRATION, async (_e, enabled: boolean) => {
    try {
      await setShellIntegration(enabled)
      saveSettings({ shellIntegrationEnabled: enabled })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  ipcMain.handle(IPC.APP_GET_SYSTEM_STATE, async () => {
    const state = await getSystemState()
    const stored = getSettings()
    return {
      ...state,
      // Echo back the persisted preference too — UI shows the stored intent
      // and falls back to the actual platform state if they disagree.
      storedAutoLaunch: !!stored.autoLaunch,
      storedShellIntegration: !!stored.shellIntegrationEnabled
    }
  })
}
