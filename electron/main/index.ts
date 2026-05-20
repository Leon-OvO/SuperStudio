import { app, BrowserWindow, shell, protocol, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db/sqlite'
import { registerIpcHandlers } from './ipc'
import { installFetchLogger } from './debug-fetch'
import { IPC } from '../../src/shared/ipc-types'

installFetchLogger()

// Force Chromium to use the OS's high-quality font subpixel rendering on Windows
// (ClearType). Without these flags Electron defaults to grayscale antialiasing
// which makes Chinese characters look fuzzy at small sizes (12-14px).
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('font-render-hinting', 'normal')
  app.commandLine.appendSwitch('enable-font-antialiasing')
  // Enable LCD subpixel rendering even when window is composited
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
}

// Capture uncaught failures in main before anything else loads
import('./services/error-log').then(m => m.installMainProcessHooks()).catch(() => {/* ignore */})

// Must be called before app.ready
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true }
  }
])

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === 'darwin',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Windows + Linux: explicitly set the window/taskbar icon so dev mode also
    // shows it. macOS reads the icon from the .app bundle's Info.plist instead.
    ...(process.platform !== 'darwin' ? { icon: path.join(__dirname, '../../build/icon.png') } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow!.show()
  })

  const wcRef = mainWindow.webContents
  mainWindow.on('closed', async () => {
    // Kill any PTY sessions spawned by this window — prevents zombie shells.
    try {
      const { disposeAllForWebContents } = await import('./services/terminals')
      disposeAllForWebContents(wcRef)
    } catch { /* terminals module may not be loaded */ }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send(IPC.WIN_MAXIMIZE_CHANGED, true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send(IPC.WIN_MAXIMIZE_CHANGED, false)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.superstudio.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Serve local files with a custom protocol that works cross-origin (dev + prod)
  // Covers gallery (images/videos), Vibe project previews (web assets), and KB.
  const MIME: Record<string, string> = {
    // Images
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    // Video / audio
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    // Web assets (Vibe iframe preview)
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    map: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    md: 'text/plain; charset=utf-8',
    // Fonts
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject',
    // Wasm
    wasm: 'application/wasm'
  }
  protocol.handle('local-file', async (req) => {
    // Chromium with standard:true normalizes local-file:///F:/path → local-file://f/path
    // where drive letter becomes lowercase hostname and the rest is pathname.
    const url = new URL(req.url)
    let filePath: string
    if (url.hostname && url.hostname.length === 1 && /[a-z]/.test(url.hostname)) {
      // Windows: reconstruct drive path — hostname=f + pathname=/Data/... → F:/Data/...
      filePath = `${url.hostname.toUpperCase()}:${decodeURIComponent(url.pathname)}`
    } else {
      filePath = decodeURIComponent(url.pathname)
    }

    // Path allowlist — refuse to serve anything that isn't under userData OR
    // hasn't been explicitly opened/attached by the user. Blocks prompt-injection
    // attempts to exfiltrate arbitrary disk files through <img src="local-file:///...">.
    const { isApproved } = await import('./services/path-allow')
    if (!isApproved(filePath)) {
      console.warn('[local-file] BLOCKED (not in allowlist):', filePath)
      return new Response('forbidden', { status: 403 })
    }

    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    console.log('[local-file]', filePath)
    try {
      const data = fs.readFileSync(filePath)
      return new Response(data, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream' } })
    } catch (e) {
      console.error('[local-file] not found:', filePath, (e as Error).message)
      return new Response('not found', { status: 404 })
    }
  })

  // Read data directory from store (electron-store is independent of SQLite, safe to read early)
  const { getSettings: readSettings } = await import('./services/store')
  const startupSettings = readSettings()
  await initDb(startupSettings.dataDirectory || undefined)
  registerIpcHandlers()

  // Re-register Vibe recent projects as approved roots — they live in settings
  // (persisted) but path-allow's approvedRoots is in-memory only, so we have to
  // restore the trust list on every startup. Without this, the iframe preview
  // and code_read tools throw "Project path not allowed" on first use after
  // restart for any externally-opened folder.
  try {
    const { getRecentProjects } = await import('./services/vibe-projects')
    const { registerApprovedRoot } = await import('./services/path-allow')
    const recents = getRecentProjects()
    for (const r of recents) {
      registerApprovedRoot(r.path)
    }
    console.log(`[startup] vibe approved-roots registered: ${recents.length}`,
      JSON.stringify(recents.map(r => r.path)))
  } catch (e) {
    console.warn('[startup] vibe approved-root bootstrap failed:', (e as Error).message)
  }

  // Attempt to restore existing auth session silently
  try {
    const { tryRestoreSession } = await import('./ipc/auth')
    await tryRestoreSession()
  } catch (e) {
    console.warn('[startup] session restore failed:', (e as Error).message)
  }

  // Window control handlers (renderer → main)
  ipcMain.on(IPC.WIN_MINIMIZE, () => mainWindow?.minimize())
  ipcMain.on(IPC.WIN_MAXIMIZE, () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on(IPC.WIN_CLOSE, () => mainWindow?.close())

  // Diagnostic: print current store contents on startup
  try {
    const { getSettings, getProviders, maskApiKey } = await import('./services/store')
    const providers = getProviders()
    const settings = getSettings()
    console.log('[startup] providers:', providers.map(p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, modelCount: p.models.length, models: p.models, key: maskApiKey(p.apiKey) })))
    console.log('[startup] settings:', {
      chatProvider: settings.defaultChatProviderId,
      chatModel: settings.defaultChatModel,
      imageProvider: settings.defaultImageProviderId,
      imageModel: settings.defaultImageModel
    })
  } catch (e) {
    console.error('[startup] failed to dump store', e)
  }

  createWindow()

  // System tray — quick window-restore + quit. Notifications also live in this module.
  const { initTray } = await import('./services/tray')
  initTray(() => mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  // Shut down any spawned MCP subprocesses cleanly
  const { mcpManager } = await import('./services/mcp')
  await mcpManager.disconnectAll().catch(() => {})
  const { destroyTray } = await import('./services/tray')
  destroyTray()
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
