import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'

/**
 * GitHub-Releases-backed auto-updater.
 *
 * Release flow:
 *   1. Bump package.json version
 *   2. `git tag v0.x.y && git push --tags`
 *   3. The `release.yml` workflow builds Win/macOS, uploads installers +
 *      `latest.yml` to the matching GitHub Release
 *   4. Installed clients call autoUpdater.checkForUpdates() on launch +
 *      every hour while running; if a newer version exists they download
 *      it in the background and the user gets a "restart to apply" toast.
 *
 * Skipped entirely during `npm run dev` because there's no packaged
 * version to compare against.
 */

let mainWindowRef: BrowserWindow | null = null

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; reason: string }

let lastStatus: UpdateStatus = { kind: 'idle' }

function emit(status: UpdateStatus): void {
  lastStatus = status
  mainWindowRef?.webContents.send(IPC.UPDATE_STATUS, status)
}

export function getUpdateStatus(): UpdateStatus { return lastStatus }

export function initAutoUpdater(window: BrowserWindow): void {
  mainWindowRef = window

  // In dev (run via electron-vite dev) there's no installed app to update.
  // Also when running unpacked via electron-builder --dir.
  if (!app.isPackaged) {
    emit({ kind: 'disabled', reason: '开发模式下不检查更新' })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => emit({ kind: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    emit({ kind: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => emit({ kind: 'not-available' }))
  autoUpdater.on('download-progress', (p) =>
    emit({ kind: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    emit({ kind: 'ready', version: info.version })
  )
  autoUpdater.on('error', (err) =>
    emit({ kind: 'error', message: err?.message ?? String(err) })
  )

  // Fire-and-forget — never throw, never block startup
  autoUpdater.checkForUpdates().catch(err => {
    console.warn('[updater] initial check failed:', err?.message ?? err)
  })

  // Re-check every hour while the app is running
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {/* logged via 'error' event */})
  }, 60 * 60 * 1000)
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    emit({ kind: 'disabled', reason: '开发模式下不检查更新' })
    return lastStatus
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    emit({ kind: 'error', message: (e as Error).message })
  }
  return lastStatus
}

export function quitAndInstall(): void {
  if (lastStatus.kind !== 'ready') {
    console.warn('[updater] quitAndInstall called but no update ready')
    return
  }
  autoUpdater.quitAndInstall()
}
