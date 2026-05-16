// Wrap global fetch in the main process to log every outgoing HTTP request.
// Helps diagnose why an LLM call appears to "do nothing" — you can see the URL,
// status code, and any network errors directly in the dev terminal.

const originalFetch = globalThis.fetch

export function installFetchLogger(): void {
  if ((globalThis.fetch as { __wrapped?: boolean }).__wrapped) return

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as Request).url || String(input)
    const method = (init?.method || (input as Request).method || 'GET').toUpperCase()
    const started = Date.now()
    console.log(`[fetch] → ${method} ${url}`)
    try {
      const res = await originalFetch(input as RequestInfo, init)
      const ms = Date.now() - started
      console.log(`[fetch] ← ${res.status} ${res.statusText} ${url} (${ms}ms)`)
      if (!res.ok) {
        // Clone so we can log without consuming the body
        try {
          const clone = res.clone()
          const txt = await clone.text()
          console.log(`[fetch]    body: ${txt.slice(0, 500)}${txt.length > 500 ? '…' : ''}`)
        } catch { /* ignore */ }
      }
      return res
    } catch (err) {
      const ms = Date.now() - started
      console.error(`[fetch] ✗ ${url} (${ms}ms)`, err)
      throw err
    }
  }
  ;(wrapped as { __wrapped?: boolean }).__wrapped = true
  globalThis.fetch = wrapped as typeof fetch
}
