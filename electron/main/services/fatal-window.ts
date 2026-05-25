import { BrowserWindow, shell, app } from 'electron'
import path from 'path'

/**
 * Panic window. Shown when main-process startup throws, the renderer fails
 * to load/render, or the startup watchdog fires. Built as a self-contained
 * data URL so it doesn't depend on the renderer bundle, preload, settings,
 * or anything else that might be the thing that broke.
 *
 * The HTML uses hash-navigation as its IPC: clicking a button sets
 * `location.hash`, the main process observes `did-navigate-in-page`, and
 * dispatches the requested action. This keeps `nodeIntegration` off.
 */

let activeWindow: BrowserWindow | null = null

export interface FatalErrorOptions {
  /** Short title shown at the top, e.g. "启动失败". */
  title: string
  /** One-line summary describing where it failed, e.g. "数据库初始化时出错". */
  reason: string
  /** The actual Error / stack. */
  error: unknown
  /** Extra context (key/value rows) — version, dataDirectory, etc. */
  context?: Record<string, string | number | undefined>
}

function resolveLogDir(): string {
  try {
    return path.join(app.getPath('userData'), 'logs')
  } catch {
    return ''
  }
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]!)
}

function buildHtml(opts: FatalErrorOptions): string {
  const err = opts.error
  const message = err instanceof Error ? err.message : String(err ?? '(no error object)')
  const stack = err instanceof Error && err.stack ? err.stack : ''
  const logDir = resolveLogDir()
  const ctxRows = Object.entries(opts.context ?? {})
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `<tr><td>${escape(k)}</td><td>${escape(String(v))}</td></tr>`)
    .join('')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escape(opts.title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
          "Microsoft YaHei", system-ui, sans-serif;
    background: #1b1b1f; color: #e7e7ea; padding: 24px; overflow: auto;
  }
  h1 { margin: 0 0 6px; font-size: 18px; color: #ffb4b4; }
  .reason { color: #c8c8cd; margin-bottom: 18px; font-size: 13px; }
  .meta { margin-bottom: 14px; }
  .meta table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .meta td { padding: 4px 8px; border-bottom: 1px solid #2a2a30; }
  .meta td:first-child { color: #8a8a92; width: 160px; }
  pre {
    background: #0f0f12; border: 1px solid #2a2a30; border-radius: 6px;
    padding: 12px; font-family: ui-monospace, "JetBrains Mono", Consolas, monospace;
    font-size: 12px; white-space: pre-wrap; word-break: break-word;
    max-height: 280px; overflow: auto; margin: 0 0 16px;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button {
    font: inherit; color: #fff; background: #3b3b42; border: 1px solid #4d4d55;
    padding: 7px 14px; border-radius: 6px; cursor: pointer;
  }
  button:hover { background: #4a4a52; }
  button.primary { background: #2b6cb0; border-color: #3779c0; }
  button.primary:hover { background: #3779c0; }
  .hint { color: #8a8a92; font-size: 11px; margin-top: 16px; }
  .path { font-family: ui-monospace, Consolas, monospace; color: #b4c6ff; }
</style>
</head>
<body>
  <h1>${escape(opts.title)}</h1>
  <div class="reason">${escape(opts.reason)}</div>
  ${ctxRows ? `<div class="meta"><table>${ctxRows}</table></div>` : ''}
  <pre>${escape(message)}${stack ? '\n\n' + escape(stack) : ''}</pre>
  <div class="actions">
    <button class="primary" onclick="location.hash='#restart'">重启 SuperStudio</button>
    <button onclick="location.hash='#open-logs'">打开日志文件夹</button>
    <button onclick="location.hash='#copy'" id="copyBtn">复制错误详情</button>
    <button onclick="location.hash='#quit'">退出</button>
  </div>
  <p class="hint">
    完整日志：<span class="path">${escape(logDir || '(无法访问)')}</span><br/>
    重启不会丢失任何对话或本地数据。如果反复出现同一个错误，请把日志一起反馈。
  </p>
  <textarea id="copySrc" style="position:absolute;left:-9999px;top:-9999px;">${escape(message + (stack ? '\n\n' + stack : ''))}</textarea>
  <script>
    document.getElementById('copyBtn').addEventListener('click', () => {
      const ta = document.getElementById('copySrc');
      ta.select();
      try { document.execCommand('copy'); document.getElementById('copyBtn').textContent = '已复制 ✓'; } catch (e) {}
    });
  </script>
</body>
</html>`
}

export function showFatalErrorWindow(opts: FatalErrorOptions): BrowserWindow {
  // Reuse the existing panic window if one's already up — don't pop a chain
  // of error windows when multiple things fail in quick succession.
  if (activeWindow && !activeWindow.isDestroyed()) {
    activeWindow.focus()
    return activeWindow
  }

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    title: opts.title,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1f',
    webPreferences: {
      // Deliberately minimal — this window must work even if preload is the
      // thing that's broken. No nodeIntegration, no contextBridge.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  activeWindow = win
  win.on('closed', () => { if (activeWindow === win) activeWindow = null })

  // Hash-navigation IPC — buttons set location.hash, we observe it here.
  win.webContents.on('did-navigate-in-page', (_, url) => {
    const hash = url.split('#')[1]
    if (!hash) return
    if (hash === 'restart') {
      app.relaunch()
      app.exit(0)
    } else if (hash === 'quit') {
      app.exit(0)
    } else if (hash === 'open-logs') {
      const dir = resolveLogDir()
      if (dir) shell.openPath(dir).catch(() => {/* ignore */})
    }
    // #copy is handled entirely in-page via execCommand
  })

  const html = buildHtml(opts)
  win.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'))
  return win
}
