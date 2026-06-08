import { app, BrowserWindow, shell, protocol, ipcMain } from 'electron'
import path from 'path'
import fs from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDb } from './db/sqlite'
import { registerIpcHandlers } from './ipc'
import { installFetchLogger } from './debug-fetch'
import { IPC } from '../../src/shared/ipc-types'
import { FLAVOR } from '../../src/shared/flavor'
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

// Force HTTP/1.1+TCP/TLS instead of QUIC/HTTP3. Chromium's QUIC negotiation
// emits "handshake failed ... net_error -100" (ERR_CONNECTION_CLOSED) stderr
// noise even when it silently falls back to TCP, and behaves more reliably
// behind corporate proxies. Cross-platform on purpose.
app.commandLine.appendSwitch('disable-quic')

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
/** Guards the one-time whenReady startup body. whenReady can fire more than once
 *  in a single process (observed after app.relaunch / hot upgrade — the same
 *  reason the local-file protocol below detaches a stale handler). Re-running
 *  init throws "Attempted to register a second handler for ..." on the first
 *  ipcMain.handle, and would double-create windows/listeners. */
let startupBegun = false

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

  // First-paint watchdog: if the window doesn't reach ready-to-show within
  // 15s, the renderer is probably stuck on a bundle/CSS load. Surface that
  // explicitly instead of leaving the user staring at a black BrowserWindow.
  let readyToShowFired = false
  mainWindow.once('ready-to-show', () => { readyToShowFired = true })
  setTimeout(async () => {
    if (readyToShowFired) return
    if (!mainWindow || mainWindow.isDestroyed()) return
    try {
      const { logEntry } = await import('./services/error-log')
      logEntry({ level: 'error', source: 'main', message: '[STARTUP-NO-PAINT] renderer did not signal ready-to-show within 15s' })
    } catch {/* ignore */}
    try {
      const { showFatalErrorWindow } = await import('./services/fatal-window')
      showFatalErrorWindow({
        title: '渲染层未启动',
        reason: '主窗口已经创建，但渲染层在 15 秒内没有完成首屏渲染 —— 通常是前端 bundle 加载失败、CSS 解析报错，或 preload 脚本崩溃。详情请查看日志文件。',
        error: new Error('Renderer ready-to-show timeout (15s)'),
        context: {
          'App version': app.getVersion(),
          'Window URL': mainWindow.webContents.getURL() || '(none)',
          'userData': app.getPath('userData')
        }
      })
    } catch {/* ignore */}
  }, 15000)

  // Catch renderer load / crash signals. Without these, a broken bundle or
  // a renderer crash leaves the window blank with no surfaced error.
  mainWindow.webContents.on('did-fail-load', async (_, errorCode, errorDescription, validatedURL) => {
    // -3 = ABORTED (user navigated away). Anything else is a real failure.
    if (errorCode === -3) return
    try {
      const { logEntry } = await import('./services/error-log')
      logEntry({
        level: 'error',
        source: 'main',
        message: `[RENDERER-LOAD-FAIL] ${errorDescription} (${errorCode})`,
        context: { url: validatedURL }
      })
    } catch {/* ignore */}
    try {
      const { showFatalErrorWindow } = await import('./services/fatal-window')
      showFatalErrorWindow({
        title: '页面加载失败',
        reason: '主窗口尝试加载渲染层 HTML 时失败。常见原因：安装包损坏、磁盘只读、文件被杀毒软件隔离。',
        error: new Error(`did-fail-load ${errorCode}: ${errorDescription}`),
        context: { 'URL': validatedURL, 'errorCode': errorCode }
      })
    } catch {/* ignore */}
  })

  mainWindow.webContents.on('render-process-gone', async (_, details) => {
    try {
      const { logEntry } = await import('./services/error-log')
      logEntry({
        level: 'error',
        source: 'main',
        message: `[RENDERER-CRASHED] reason=${details.reason} exitCode=${details.exitCode}`
      })
    } catch {/* ignore */}
    try {
      const { showFatalErrorWindow } = await import('./services/fatal-window')
      showFatalErrorWindow({
        title: '渲染进程崩溃',
        reason: `渲染进程已退出（${details.reason}）。通常意味着 JavaScript 触发了内存/原生层错误。重启可恢复。`,
        error: new Error(`render-process-gone: ${details.reason} (exit ${details.exitCode})`),
        context: { 'reason': details.reason, 'exitCode': details.exitCode }
      })
    } catch {/* ignore */}
  })

  const wcRef = mainWindow.webContents
  mainWindow.on('closed', async () => {
    // Kill any PTY sessions spawned by this window — prevents zombie shells.
    try {
      const { disposeAllForWebContents } = await import('./services/terminals')
      disposeAllForWebContents(wcRef)
    } catch { /* terminals module may not be loaded */ }
    // Tear down any pooled SSH connections so they don't outlive the window.
    try {
      const { closeAllSsh } = await import('./services/ssh-service')
      closeAllSsh()
    } catch { /* ssh module may not be loaded */ }
    // Tear down the hidden search-scraper window too — otherwise it can outlive
    // the main window, keeping the app alive headless or (when it later closes)
    // tripping window-all-closed → app.quit() at a surprising time.
    try {
      const { closeScraper } = await import('./services/search')
      closeScraper()
    } catch { /* search module may not be loaded */ }
    // Same for the persistent web-browse window used by the web_open tool.
    try {
      const { closeBrowse } = await import('./services/web-browse')
      closeBrowse()
    } catch { /* web-browse module may not be loaded */ }
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

  // whenReady can fire again within the same process (app.relaunch / hot
  // upgrade). Everything below is one-time init; re-running it throws on the
  // duplicate ipcMain.handle('app:version') registration (and would re-create
  // the window + re-add app.on listeners). Skip cleanly on any later fire — the
  // first run already built the window, and app.on('activate') re-shows it.
  if (startupBegun) {
    console.warn('[startup] whenReady fired again — skipping duplicate init')
    return
  }
  startupBegun = true

  electronApp.setAppUserModelId('com.superstudio.app')

  // Startup watchdog — if init hangs (e.g. initDb on an unreachable data
  // directory, or a SQLite file locked by a lingering process) the primary
  // would sit here forever holding the single-instance lock, blocking every
  // relaunch. Force-exit after 20s so the next launch starts clean. unref()
  // keeps a normal fast startup unaffected.
  const startupWatchdog = setTimeout(async () => {
    if (!startupComplete) {
      const msg = 'startup did not complete within 20s'
      console.error('[startup] watchdog:', msg)
      try {
        const { logEntry } = await import('./services/error-log')
        logEntry({ level: 'error', source: 'main', message: '[STARTUP-WATCHDOG] ' + msg })
      } catch {/* ignore */}
      try {
        const { showFatalErrorWindow } = await import('./services/fatal-window')
        showFatalErrorWindow({
          title: '启动超时',
          reason: '应用启动耗时超过 20 秒仍未完成 —— 通常是数据库文件被其他进程占用、数据目录所在磁盘异常，或某个依赖加载卡死。',
          error: new Error('Startup watchdog tripped after 20s'),
          context: {
            'App version': app.getVersion(),
            'Electron': process.versions.electron,
            'Node': process.versions.node,
            'Platform': `${process.platform} ${process.arch}`,
            'userData': app.getPath('userData')
          }
        })
      } catch {/* if even this fails, fall through to exit */}
      // Don't force-exit anymore — leave the panic window up so the user can
      // copy the log and choose restart vs quit themselves.
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
  // Defensive: if any prior handler for this scheme somehow exists (Electron
  // 33.x has occasionally been seen leaving stale registration after a hot
  // upgrade where the previous process tray-quit asynchronously, or after an
  // app.relaunch where whenReady fires twice), detach it first so the fresh
  // handler installs cleanly instead of throwing "Failed to register protocol".
  try {
    if (protocol.isProtocolHandled('local-file')) {
      protocol.unhandle('local-file')
      console.warn('[startup] local-file protocol was already handled; detached prior handler')
    }
  } catch (e) {
    // isProtocolHandled / unhandle are best-effort defenses — don't let them
    // mask the real failure on the next line.
    console.warn('[startup] pre-handle local-file probe threw:', (e as Error).message)
  }
  try {
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
  } catch (e) {
    // CRITICAL: do not let protocol registration failure crash startup. The
    // app needs to launch so the user can reach settings / about / log
    // viewer. Without this catch, "Failed to register protocol: local-file"
    // surfaces as a fatal panic window with no recovery path. Gallery
    // thumbnails, Vibe preview, and KB attachments will be broken until
    // the user restarts (which fixes it 99% of the time), but the app is
    // at least usable.
    const msg = (e as Error).message || String(e)
    console.error('[startup] protocol.handle(local-file) failed — continuing without it:', msg)
    try {
      const { logEntry } = await import('./services/error-log')
      logEntry({
        level: 'error',
        source: 'main',
        message: '[STARTUP] protocol.handle("local-file") failed: ' + msg,
        stack: (e as Error).stack,
        context: { electron: process.versions.electron, platform: process.platform }
      })
    } catch {/* logging best-effort */}
  }

  // Read data directory from store (electron-store is independent of SQLite, safe to read early)
  const { getSettings: readSettings, saveSettings: writeSettings } = await import('./services/store')
  const startupSettings = readSettings()
  let dataDir = startupSettings.dataDirectory
  // DWork: auto-provision the data directory on first run (freest drive root →
  // <root>/DWorkData) so onboarding never asks the user to choose one. Done
  // BEFORE initDb so the DB lands in the right place with no restart needed.
  if (!dataDir && FLAVOR === 'dwork') {
    try {
      const { autoPickDataDir } = await import('./services/data-dir')
      dataDir = autoPickDataDir()
      writeSettings({ dataDirectory: dataDir })
      console.log('[startup] DWork auto data directory:', dataDir)
    } catch (e) {
      console.warn('[startup] auto data dir failed, falling back to userData:', (e as Error).message)
    }
  }
  await initDb(dataDir || undefined)

  // Inject proprietary seam implementations (remote control, talent pool,
  // supercode account) BEFORE registering IPC — the auth provider's handlers are
  // registered inside registerIpcHandlers(). Guarded by flavor: the DWork
  // deliverable runs on the seam BYOK/noop defaults. This block +
  // services/providers/ move to the private overlay at the repo split.
  if (FLAVOR === 'superstudio') {
    try {
      const { registerProprietaryProviders } = await import('./services/providers/register-proprietary')
      registerProprietaryProviders()
    } catch (e) {
      console.warn('[startup] proprietary providers registration failed:', (e as Error).message)
    }
  }

  registerIpcHandlers()

  // Apply outbound proxy. Both session-level proxy (BrowserWindow + net.fetch)
  // and undici global dispatcher (Node's global fetch — image, video, updater,
  // LLM streaming, …) are set here. Fire-and-forget: we MUST NOT block window
  // creation on session.setProxy round-trips. For mode='off' (the default),
  // applyProxyFromSettings short-circuits to a true no-op so default users see
  // zero behavior change from before this feature existed.
  import('./services/proxy')
    .then(({ applyProxyFromSettings }) => applyProxyFromSettings(startupSettings))
    .catch(e => console.warn('[startup] applyProxy failed:', (e as Error).message))

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

  // Attempt to restore existing auth session silently (via the AuthProvider
  // seam — supercode restores its token; BYOK resolves as logged-in instantly).
  try {
    const { getAuthProvider } = await import('./services/auth-provider')
    await getAuthProvider().restore()
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

  // Background update check. Silent unless a new version is found — then the
  // renderer's UpdateNotifier listener shows a toast. No-op when no remote
  // control source is injected (deliverable default).
  try {
    const { scheduleStartupCheck } = await import('./services/updater')
    scheduleStartupCheck(() => mainWindow)
  } catch (e) {
    console.warn('[startup] updater schedule failed:', (e as Error).message)
  }

  // Remote model.conf — pull recommended default models from GitHub and apply
  // them under the managed-default policy (never clobbers a user's manual pick).
  try {
    const { scheduleModelConfSync } = await import('./services/model-conf')
    scheduleModelConfSync(() => mainWindow)
  } catch (e) {
    console.warn('[startup] model.conf sync schedule failed:', (e as Error).message)
  }

  // Scheduled prompts — start the per-task tick loop. Catches up on any
  // < 24h missed fires from the previous session at start-up time.
  try {
    const { startScheduler } = await import('./services/scheduler')
    startScheduler()
  } catch (e) {
    console.warn('[startup] scheduler start failed:', (e as Error).message)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch(async (e) => {
  // Startup threw before completing. Surface a visible panic window so the
  // user sees the error (previously this only logged to stderr, which is
  // invisible in a packaged build → silent black screen). The panic window
  // gives the user a Restart button + a "Open log folder" shortcut.
  console.error('[startup] fatal error:', e)
  try {
    const { logEntry } = await import('./services/error-log')
    const err = e instanceof Error ? e : new Error(String(e))
    logEntry({ level: 'error', source: 'main', message: '[STARTUP-FATAL] ' + err.message, stack: err.stack })
  } catch {/* logging is best-effort */}
  try {
    const { showFatalErrorWindow } = await import('./services/fatal-window')
    showFatalErrorWindow({
      title: '启动失败',
      reason: '主进程在初始化阶段抛出了未捕获的异常。下面是错误详情；点击「重启」可以再试一次。',
      error: e,
      context: {
        'App version': app.getVersion(),
        'Electron': process.versions.electron,
        'Node': process.versions.node,
        'Platform': `${process.platform} ${process.arch}`,
        'userData': app.getPath('userData')
      }
    })
  } catch (e2) {
    // If even the panic window fails, fall back to quitting — nothing else
    // we can do without dumping a console message no user will ever see.
    console.error('[startup] failed to open fatal-error window:', (e2 as Error).message)
    app.quit()
  }
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
  // Stop the scheduled-prompts tick loop so a slow setInterval doesn't keep
  // the event loop alive after MCP teardown.
  try {
    const { stopScheduler } = await import('./services/scheduler')
    stopScheduler()
  } catch { /* best-effort */ }
  // Tear down the hidden search-scraper Chromium window if it's still around.
  try {
    const { closeScraper } = await import('./services/search')
    closeScraper()
  } catch { /* best-effort */ }
  // Tear down the persistent web-browse Chromium window if it's still around.
  try {
    const { closeBrowse } = await import('./services/web-browse')
    closeBrowse()
  } catch { /* best-effort */ }
  // Close any Playwright publish browsers (真实系统 Chrome/Edge) so they don't linger.
  try {
    const { closePublishBrowsers } = await import('./services/web-publish-playwright')
    await closePublishBrowsers()
  } catch { /* best-effort */ }
  // Shut down any spawned MCP subprocesses cleanly
  const { mcpManager } = await import('./services/mcp')
  await mcpManager.disconnectAll().catch(() => {})
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}
