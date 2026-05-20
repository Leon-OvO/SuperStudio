import { app, Tray, Menu, Notification, BrowserWindow, nativeImage } from 'electron'

let trayInstance: Tray | null = null

// 32×32 PNG of the app's Sparkles glyph (indigo rounded-square + white
// 4-point star + two small + marks). Kept inline so the tray works in both
// dev and packaged builds without a filesystem lookup. Regenerate from the
// master design via `python build/gen-icon.py` (writes build/tray.b64.txt).
const TRAY_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA20lEQVR4nM2XSw7CMAxE7RGn' +
  'gAvBrpw07OBCcA1QkYJCaKlju3Fn1UpN5vmTpGGqNBzvT1pZl9uB8zN6m9c+6G1e+3GEeSlE' +
  'mo/arTl5uu6/3s+nx8838DZpFShY8Ih+LgtTKe/aAxIIUFDtzQBeglf02oyAgsUtO6E0Skn3' +
  'iwGSsdmWYHgOwKvLl0BYWoJWIGkZWHMaWna+za0CaAZNRaqJXg3gKWgHaiMWnYapaDIvI3UG' +
  '0p/ll+EskKBgwTqBtUQc/VuOSPM3QHlRDAGg6rbaU6PvpwS9IbLfC6YpVSNGsDqVAAAAAElF' +
  'TkSuQmCC'

export function initTray(getWindow: () => BrowserWindow | null): void {
  if (trayInstance) return
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'))
    trayInstance = new Tray(img)
    trayInstance.setToolTip('SuperStudio')

    const show = (): void => {
      const w = getWindow()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }

    trayInstance.setContextMenu(Menu.buildFromTemplate([
      { label: '显示窗口', click: show },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit() } }
    ]))
    trayInstance.on('click', show)
    trayInstance.on('double-click', show)
  } catch (e) {
    console.error('[tray] failed to init', e)
  }
}

export function destroyTray(): void {
  trayInstance?.destroy()
  trayInstance = null
}

/**
 * Fire a desktop notification — only when the window is not focused. We
 * suppress duplicates while the user is actively watching the task progress,
 * since the in-app UI already shows completion.
 */
export function notifyTaskComplete(
  getWindow: () => BrowserWindow | null,
  opts: { title: string; body: string }
): void {
  const w = getWindow()
  if (w?.isFocused()) return
  if (!Notification.isSupported()) return
  try {
    const n = new Notification({ title: opts.title, body: opts.body, silent: false })
    n.on('click', () => {
      const win = getWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
  } catch (e) {
    console.error('[notify] failed', e)
  }
}
