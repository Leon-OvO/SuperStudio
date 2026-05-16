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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
