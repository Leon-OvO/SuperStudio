import { app } from 'electron'
import { FLAVOR } from '../../../src/shared/flavor'

/**
 * Outbound HTTP User-Agent for THIS product flavor — "SuperStudio/<version>" or
 * "DWork/<version>". Replaces undici's bland default ("node") on every API call.
 *
 * Version source: app.getVersion(). For SuperStudio that's package.json's version
 * (0.3.x); for DWork it's electron-builder.dwork.yml's `extraMetadata.version`
 * (0.1.x), which electron-builder bakes into the packaged app metadata — so one
 * call yields the correct per-flavor number with zero version coupling here. (In
 * an unpackaged DWork dev run app.getVersion() falls back to package.json's
 * number; product name is still correct — cosmetic dev-only mismatch.)
 *
 * Lazily computed + memoized: app.getVersion() is only valid once the app module
 * has loaded, and the first outbound request always happens long after that.
 */
let cached: string | null = null
export function userAgent(): string {
  if (cached) return cached
  const product = FLAVOR === 'dwork' ? 'DWork' : 'SuperStudio'
  let version = '0'
  try { version = app.getVersion() } catch { /* extremely early / non-electron ctx */ }
  cached = `${product}/${version}`
  return cached
}

/**
 * Stamp the product User-Agent onto every undici (Node `fetch`) request in the
 * main process. This single global-fetch wrapper is the one chokepoint for the
 * LLM (llm.ts), image (image.ts), account (supercode-api.ts), provider-test
 * (ipc/settings.ts), video, skills, and update-check paths — they all call the
 * global `fetch`, so it covers them on BOTH the direct-dispatcher and proxied
 * (ProxyAgent) paths (undici serializes request headers regardless of which
 * dispatcher is active).
 *
 * NOT covered here (they bypass global `fetch`, so they set the UA at their call
 * site): Electron `net.fetch` (search.ts / webhook.ts) and the MCP SSE transport.
 * Deliberately NOT touched: the renderer / BrowserWindow / headless-scrape UA —
 * those must keep a real browser UA or sites (e.g. 小红书) break.
 *
 * Guarded: only sets the header when the caller didn't already set one, so
 * intentional UAs (the Mozilla string used for search scraping, the flavor UA in
 * github-remote-control) are never clobbered. Idempotent via __uaWrapped; install
 * AFTER installFetchLogger so the logger still sees the final headers.
 */
export function installUserAgent(): void {
  const prev = globalThis.fetch
  if ((prev as { __uaWrapped?: boolean }).__uaWrapped) return
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    if (!headers.has('user-agent')) headers.set('user-agent', userAgent())
    return prev(input as RequestInfo, { ...init, headers })
  }
  ;(wrapped as { __uaWrapped?: boolean }).__uaWrapped = true
  globalThis.fetch = wrapped as typeof fetch
}
