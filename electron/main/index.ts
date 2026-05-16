import { app, BrowserWindow, shell, protocol, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db/sqlite'
import { registerIpcHandlers } from './ipc'
import { installFetchLogger } from './debug-fetch'
import { IPC } from '../../src/shared/ipc-types'

installFetchLogger()

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
    ...(process.platform === 'linux' ? { icon: path.join(__dirname, '../../build/icon.png') } : {}),
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

  // Serve local gallery files with a custom protocol that works cross-origin (dev + prod)
  const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm'
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
    console.log('[startup] providers:', providers.map(p => ({ id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, models: p.models.length, key: maskApiKey(p.apiKey) })))
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

  // Hook autoUpdater after window exists (it needs a webContents to emit
  // status events to). Skips silently in dev.
  if (mainWindow) {
    const { initAutoUpdater } = await import('./services/updater')
    initAutoUpdater(mainWindow)
  }

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
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
