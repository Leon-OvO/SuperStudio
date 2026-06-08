import { app, Tray, Menu, Notification, BrowserWindow, nativeImage } from 'electron'
import { BRAND } from '../../../src/shared/brand'

let trayInstance: Tray | null = null

// 32×32 PNG of the app's Sparkles glyph (indigo rounded-square + white
// 4-point star + two small + marks). Kept inline so the tray works in both
// dev and packaged builds without a filesystem lookup. Regenerate from the
// master design via `python build/gen-icon.py` (writes build/tray.b64.txt).
const TRAY_ICON_SUPERSTUDIO_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA20lEQVR4nM2XSw7CMAxE7RGn' +
  'gAvBrpw07OBCcA1QkYJCaKlju3Fn1UpN5vmTpGGqNBzvT1pZl9uB8zN6m9c+6G1e+3GEeSlE' +
  'mo/arTl5uu6/3s+nx8838DZpFShY8Ih+LgtTKe/aAxIIUFDtzQBeglf02oyAgsUtO6E0Skn3' +
  'iwGSsdmWYHgOwKvLl0BYWoJWIGkZWHMaWna+za0CaAZNRaqJXg3gKWgHaiMWnYapaDIvI3UG' +
  '0p/ll+EskKBgwTqBtUQc/VuOSPM3QHlRDAGg6rbaU6PvpwS9IbLfC6YpVSNGsDqVAAAAAElF' +
  'TkSuQmCC'

// DWork's own 32×32 tray glyph (orange lightning). Regenerate via
// `python build/gen-dwork-icon.py` (writes build/dwork/tray.b64.txt).
const TRAY_ICON_DWORK_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADr0lEQVR4nMWXS4gcVRSGv3NvVXd6MnEiOo6JMmRQEImLEd3pwhdGFwYRYkBDwIBLXUgwmIjiIpFIcKErEVxEBUOMYDY+YsCFLoSgswhIUJjQhJnooGaSGTvd1beunLrdthn7VeWoB4rqR1V9/3nVvUcA/MsYeYXU75+aoMRzGNlK098CCKtjnkjOkPrjNHhd9s3+1GbKn/ADmx6kZN4mlkkSD86zqmYFYoHEV2mkT8ves59n7Ezewcn7qcRfZODEO8Agq+Z9MI96lBKLzYTUkgdkT/Wk+P03jxO7GaxsIPEpgl1V8N+FOGIxOD9PYqcNkdtN2WwsDBeT83psxlJm5HYbPNtIvC8UcoU3lsGneUVIxvRs01xP4bzC87liIqj9BpsfhXXXg0tAhvZBU6AyphSav9wVfnkRbroX7nsRkt/zwP9qXgXku9PYEPbRCXj8Xbg4DxfnwJbB+3+5gsRAswFxBbYfDmfXABsXCqRazhIGXB0efg02TAfowpkgqlgKGF6Aerm8APfshdseg+blkL36pdAFGh0VsfIYkOFoaPil8zD9JNz1LKTNUIhq2gn68tQu0N+7uhn9AwFG2+0CbLobHnq15a3t5PxCNRRk+aogpG3Z3ymYEtR+6RkJ8QenelePhlWLrLwOdn0GYzd2wt02bUH1fiXAN6E0CideglPvQHnsSoEDIyASQqrH9vcCPAu97bSbMuMR0CboZqePwbeHg5AucLXeRagQ9X7rm7Dx9tbVqrdLgWWCWke7Dua+g+PPgC317ZCou/cW6otw5y649RGo/QrS7dI05L6dEk2Pilw8B0d2hM969FkrpHcNeKhcA2kjBEpWvpDqsH4SdhwLaWhDtC0/eALOnYI1Y707o28EMhNY/pm+EZrY3IK7kAb19tMX4OxXnQVqgEV9/zVx9+5RAQobuTZ8d02IyvD1GzDz/tDwwQI0Dd0SpKK0QMd13+oD/PRH8OUBWDs+NFwt/1rQFqZFWRoJauZn4JPnw4qY00wxvgoAbrgDkhoc2RnOUSn37sgUWke16LT99PYPn4Kl81BaC6n7DzYkIqHoRq+Db96CH07AmvUD263X0wyeWayEPftQmn1ndfz+Y6hcXQSeZkzPrG5KjxKLtAaHXNqveAHlMWUpUzhqaNpD1NO5bFjQoSHXg9Lig4kym/aQkX0/LuDdzkyRjk16Qd5oDAf2LbiOZqJMZZtsQNxTPcmS24KnSsVYooIbvH6mz9RnK2PJbVFmZzj9H8fzPwAvwoQwi0Rq7AAAAABJRU5ErkJggg=='

// Pick the tray glyph by flavor so DWork shows its own icon, not SuperStudio's.
const TRAY_ICON_PNG_BASE64 = BRAND.id === 'dwork' ? TRAY_ICON_DWORK_B64 : TRAY_ICON_SUPERSTUDIO_B64

export function initTray(getWindow: () => BrowserWindow | null): void {
  if (trayInstance) return
  try {
    const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG_BASE64, 'base64'))
    trayInstance = new Tray(img)
    trayInstance.setToolTip(BRAND.displayName)

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
