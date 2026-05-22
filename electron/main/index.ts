import { app, BrowserWindow, shell, protocol, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db/sqlite'
import { registerIpcHandlers } from './ipc'
import { installFetchLogger } from './debug-fetch'
import { IPC } from '../../src/shared/ipc-types'
import type { ShellOpenTarget } from './services/system-integration'

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
/** Path captured from argv during cold start (Explorer "Open with"). Sent to
 *  the renderer once it signals ready — we can't send before the first window
 *  exists. */
let pendingShellPath: ShellOpenTarget | null = null
/** Flips to true only after the first window is created AND all IPC handlers
 *  are registered. `second-instance` checks this before recreating a window —
 *  painting a window onto a process that failed/hung during startup yields a
 *  UI where every ipcRenderer.invoke fails with "No handler registered". */
let startupComplete = false

// Single-instance lock — Explorer's right-click "用 SuperStudio 打开" should
// FOCUS the existing window and forward the path, NOT spawn a second app
// instance with its own SQLite/store/etc.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', async (_event, argv) => {
    // Restore + focus existing window — or recreate it if the previous window
    // was destroyed (defense-in-depth: a relaunch must always bring the UI back,
    // even if an old process is somehow still holding the single-instance lock).
    const hadWindow = !!mainWindow && !mainWindow.isDestroyed()
    if (hadWindow) {
      if (mainWindow!.isMinimized()) mainWindow!.restore()
      mainWindow!.show()
      mainWindow!.focus()
    } else if (startupComplete) {
      createWindow()
    } else {
      // Startup never finished — this process has no IPC handlers wired up, so
      // a window here would be dead (every invoke → "No handler registered").
      // Quit and release the single-instance lock; the user's next launch then
      // becomes a fresh, fully-initialized primary.
      console.error('[main] second-instance before startup completed — quitting so a clean instance can take over')
      app.quit()
      return
    }
    // Forward the path the user right-clicked on to the renderer
    try {
      const { findPathArg } = await import('./services/system-integration')
      const target = findPathArg(argv)
      if (target) {
        if (hadWindow) {
          mainWindow!.webContents.send(IPC.APP_OPEN_PATH_FROM_SHELL, target)
        } else {
          // Renderer just spun up — stash the path; ready-to-show forwards it.
          pendingShellPath = target
        }
      }
    } catch (e) {
      console.warn('[main] second-instance arg parse failed:', (e as Error).message)
    }
  })
}

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
    // Now that the renderer is alive, forward any path captured from argv
    // during cold start. We delay a frame so the renderer's IPC listener has
    // mounted (App.tsx subscribes inside useEffect → runs after first paint).
    if (pendingShellPath) {
      const p = pendingShellPath
      pendingShellPath = null
      setTimeout(() => mainWindow?.webContents.send(IPC.APP_OPEN_PATH_FROM_SHELL, p), 300)
    }
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
  // Second-instance branch: we already called app.quit() above. Skip all
  // startup — protocol.handle / initDb in a quitting process throws spurious
  // errors ("Failed to register protocol: local-file") that mask real failures
  // in the primary's log.
  if (!gotSingleInstanceLock) return

  electronApp.setAppUserModelId('com.superstudio.app')

  // Startup watchdog — if init hangs (e.g. initDb on an unreachable data
  // directory, or a SQLite file locked by a lingering process) the primary
  // would sit here forever holding the single-instance lock, blocking every
  // relaunch. Force-exit after 20s so the next launch starts clean. unref()
  // keeps a normal fast startup unaffected.
  const startupWatchdog = setTimeout(() => {
    if (!startupComplete) {
      console.error('[startup] watchdog: startup did not complete within 20s — force-exiting')
      app.exit(1)
    }
  }, 20000)
  startupWatchdog.unref()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Serve local files with a custom protocol that works cross-origin (dev + prod)
  // Covers gallery (images/videos), Vibe project previews (web assets), and KB.
  const MIME: Record<string, string> = {
    // Images
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
    bmp: 'image/bmp', avif: 'image/avif',
    // Video / audio
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
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

  // Reconcile OS-level toggles with the stored intent on every boot. This
  // matters after the user moves the .exe (path inside the registry / login
  // item is now stale) or after an upgrade (defaults may have changed).
  try {
    const { setAutoLaunch, setShellIntegration, findPathArg } = await import('./services/system-integration')
    setAutoLaunch(!!startupSettings.autoLaunch)
    // Best-effort — never block startup on registry writes.
    setShellIntegration(!!startupSettings.shellIntegrationEnabled).catch(e =>
      console.warn('[startup] setShellIntegration failed:', (e as Error).message)
    )
    // Cold-start argv may carry a path the user right-clicked on. Stash it
    // and forward once the window is ready-to-show.
    const target = findPathArg(process.argv)
    if (target) pendingShellPath = target
  } catch (e) {
    console.warn('[startup] system-integration init failed:', (e as Error).message)
  }

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
  // Startup reached the end successfully — IPC handlers are registered and the
  // first window exists. Safe now for second-instance to recreate a window.
  startupComplete = true
  clearTimeout(startupWatchdog)

  // System tray — quick window-restore + quit. Notifications also live in this module.
  const { initTray } = await import('./services/tray')
  initTray(() => mainWindow)

  // Background update check (Gitee). Silent unless a new version is found —
  // then the renderer's UpdateNotifier listener shows a toast.
  try {
    const { scheduleStartupCheck } = await import('./services/updater')
    scheduleStartupCheck(() => mainWindow)
  } catch (e) {
    console.warn('[startup] updater schedule failed:', (e as Error).message)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((e) => {
  // Startup threw before completing. A half-initialized primary that lingers
  // would hold the single-instance lock (so relaunch can't get a fresh
  // process) and could get a dead window painted onto it by second-instance.
  // Quit to release the lock — the next launch then starts from a clean slate.
  console.error('[startup] fatal error — quitting so the next launch starts clean:', e)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  // Force-exit watchdog: a hung tool promise or an unresponsive MCP stdio child
  // can keep the event loop alive so graceful quit never completes — the process
  // then lingers as a zombie and blocks the next launch. unref() keeps the
  // normal fast path instant; the timer only bites when something else is still
  // holding the loop open.
  setTimeout(() => app.exit(0), 3000).unref()
  // Remove the tray icon first so it disappears even if MCP cleanup stalls.
  const { destroyTray } = await import('./services/tray')
  destroyTray()
  // Shut down any spawned MCP subprocesses cleanly
  const { mcpManager } = await import('./services/mcp')
  await mcpManager.disconnectAll().catch(() => {})
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
