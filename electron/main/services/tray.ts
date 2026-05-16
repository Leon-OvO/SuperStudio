import { app, Tray, Menu, Notification, BrowserWindow, nativeImage } from 'electron'
import zlib from 'zlib'

let trayInstance: Tray | null = null

/**
 * Build a 16×16 RGBA PNG buffer programmatically — we don't ship dedicated tray
 * icon assets, so generate one in-memory at startup. Format reference:
 * https://www.w3.org/TR/PNG/
 */
function buildTrayPng(): Buffer {
  const W = 16, H = 16
  // Filled rounded-ish square with a brand-ish purple-blue gradient.
  const raw = Buffer.alloc(H * (1 + W * 4))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0 // filter byte (None)
    for (let x = 0; x < W; x++) {
      const i = y * (1 + W * 4) + 1 + x * 4
      // Trim corners by 1px to suggest a rounded shape
      const corner = (x === 0 || x === W - 1) && (y === 0 || y === H - 1)
      if (corner) {
        raw[i + 0] = 0; raw[i + 1] = 0; raw[i + 2] = 0; raw[i + 3] = 0
      } else {
        const t = y / (H - 1)
        raw[i + 0] = Math.round(99 + (139 - 99) * t)    // R
        raw[i + 1] = Math.round(102 + (92 - 102) * t)   // G
        raw[i + 2] = Math.round(241 + (246 - 241) * t)  // B
        raw[i + 3] = 255
      }
    }
  }
  const idat = zlib.deflateSync(raw)

  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

export function initTray(getWindow: () => BrowserWindow | null): void {
  if (trayInstance) return
  try {
    const img = nativeImage.createFromBuffer(buildTrayPng())
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
