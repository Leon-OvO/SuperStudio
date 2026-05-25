import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import './assets/globals.css'

// Catch uncaught async errors too — they don't propagate to React boundaries.
// Mirror to the local error log so users can find them in Settings → 关于.
window.addEventListener('unhandledrejection', (event) => {
  const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason))
  console.error('[unhandledrejection]', err)
  window.api?.reportError?.({ level: 'error', message: 'Unhandled rejection: ' + err.message, stack: err.stack })?.catch(() => {})
})
window.addEventListener('error', (event) => {
  const err = event.error instanceof Error ? event.error : new Error(event.message || 'Unknown error')
  console.error('[window error]', err)
  window.api?.reportError?.({ level: 'error', message: err.message, stack: err.stack })?.catch(() => {})
})

// Mount with a DOM fallback. If React itself throws during initial render
// (broken module, missing dep, etc), the user would otherwise see a blank
// white window with no recourse — we paint a styled error card directly into
// document.body and report it to the main process for logging.
try {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('#root element not found in index.html')
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  )
} catch (err) {
  const e = err instanceof Error ? err : new Error(String(err))
  console.error('[main] React failed to mount:', e)
  window.api?.reportError?.({
    level: 'error',
    message: 'Renderer mount failed: ' + e.message,
    stack: e.stack
  })?.catch(() => {})
  const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!))
  document.body.innerHTML = `
    <div style="font:13px/1.5 -apple-system,Segoe UI,sans-serif;background:#1b1b1f;color:#e7e7ea;padding:32px;min-height:100vh;box-sizing:border-box;">
      <h1 style="color:#ffb4b4;margin:0 0 8px;font-size:18px;">界面启动失败</h1>
      <p style="color:#c8c8cd;margin:0 0 16px;">React 渲染层无法挂载。这通常意味着前端包损坏或缺失依赖。</p>
      <pre style="background:#0f0f12;border:1px solid #2a2a30;border-radius:6px;padding:12px;font:12px ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;margin:0 0 16px;">${esc(e.message)}${e.stack ? '\n\n' + esc(e.stack) : ''}</pre>
      <button onclick="location.reload()" style="font:inherit;color:#fff;background:#2b6cb0;border:1px solid #3779c0;padding:7px 14px;border-radius:6px;cursor:pointer;">重新加载</button>
    </div>`
}
