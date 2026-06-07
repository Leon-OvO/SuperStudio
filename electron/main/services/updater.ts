/**
 * Update checker (policy layer).
 *
 * The actual "where do releases come from" lives behind the RemoteControlSource
 * seam (remote-control-source.ts); this module owns the policy: schedule a
 * silent startup check, surface a "new version available" toast in the renderer,
 * and open a release URL in the user's browser. The deliverable default source
 * returns null (update checks disabled); a proprietary overlay injects a
 * GitHub-backed source.
 *
 * No background download, no in-place install — the user always sees a real
 * release URL before downloading anything.
 */

import { app, shell } from 'electron'
import { BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { getRemoteControlSource, type UpdateInfo } from './remote-control-source'

export type { UpdateInfo }

export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  const base: UpdateInfo = {
    hasUpdate: false,
    currentVersion,
    remoteVersion: null,
    remoteName: null,
    body: null,
    releaseUrl: '',
  }
  try {
    const info = await getRemoteControlSource().checkUpdate(currentVersion)
    return info ?? base
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    console.warn('[updater] check failed:', msg)
    return { ...base, error: msg }
  }
}

/** Fire-and-forget startup check. Notifies the renderer ONLY if an update is
 *  available — silent failures and "already latest" don't bother the user. */
export function scheduleStartupCheck(getWin: () => BrowserWindow | null): void {
  // Wait ~10s so the window has time to fully paint + the renderer's IPC
  // listener has been mounted. We don't race the toast against the splash.
  setTimeout(async () => {
    const info = await checkForUpdates()
    if (!info.hasUpdate) return
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.UPDATER_AVAILABLE, info)
  }, 10000)
}

export function openReleasePage(url?: string): void {
  if (!url) return
  shell.openExternal(url).catch(() => {/* ignore */})
}
