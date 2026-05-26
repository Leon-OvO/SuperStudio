import { session } from 'electron'
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from 'undici'
import type { AppSettings, ProxyMode } from '../../../src/shared/ipc-types'

// Partitions that need the same proxy as the default session — web_open's
// hidden BrowserWindow uses this partition (web-browse.ts:109).
const PROXY_PARTITIONS = ['persist:web-browse'] as const

// Hold the current undici dispatcher so we can dispose of it when the user
// flips modes — keeps sockets/agents from leaking across mode switches.
let currentDispatcher: Dispatcher | null = null

function resolveSystemEnvProxy(): string | null {
  const env = process.env
  return (
    env.HTTPS_PROXY || env.https_proxy ||
    env.HTTP_PROXY || env.http_proxy ||
    env.ALL_PROXY || env.all_proxy ||
    null
  ) || null
}

function buildCustomUrl(host: string | undefined, port: number | undefined): string | null {
  const h = (host || '').trim()
  if (!h || !port || port < 1 || port > 65535) return null
  return `http://${h}:${port}`
}

/** Compute the URL undici's ProxyAgent should target. session.setProxy is
 *  handled separately because Electron's mode:'system' covers BrowserWindow
 *  and net.fetch on its own — only undici (Node's native fetch) needs an
 *  explicit URL we can pass to ProxyAgent. */
function effectiveUndiciUrl(settings: AppSettings): string | null {
  const mode: ProxyMode = settings.proxyMode ?? 'off'
  if (mode === 'off') return null
  if (mode === 'custom') return buildCustomUrl(settings.proxyHost, settings.proxyPort)
  // system mode — undici doesn't auto-read OS proxy, only env vars.
  return resolveSystemEnvProxy()
}

/** Apply proxy settings to:
 *   1. Electron sessions (default + web-browse partition) → covers all
 *      BrowserWindow loads + electron.net.fetch (search.ts).
 *   2. undici global dispatcher → covers Node's global fetch (image, video,
 *      knowledge embeddings, updater, skills registry, MCP downloads, and
 *      ai-sdk LLM streaming inside engine.ts).
 *
 *  Safe to call any number of times; idempotent. fire-and-forget OK at the
 *  IPC callsite — failures log but don't throw. */
export async function applyProxyFromSettings(settings: AppSettings): Promise<void> {
  const mode: ProxyMode = settings.proxyMode ?? 'off'

  // Fast path: default mode is 'off'. On first apply (no prior dispatcher
  // installed, no session.setProxy yet called by us), do a complete no-op —
  // Electron sessions default to direct and Node's internal undici dispatcher
  // is already correct for direct connections. Touching either at startup
  // risks (a) session.fromPartition('persist:web-browse').setProxy stalling
  // on an unmaterialized partition, and (b) swapping out Node's bundled
  // undici dispatcher for our installed one, which can subtly change
  // keep-alive / timeout behavior of ai-sdk streaming fetch.
  if (mode === 'off' && currentDispatcher === null) {
    console.log('[proxy] applied: off (no-op, first run)')
    return
  }

  // --- 1. Electron sessions ---
  const sessions = [session.defaultSession, ...PROXY_PARTITIONS.map(p => session.fromPartition(p))]
  const proxyConfig =
    mode === 'off' ? { mode: 'direct' as const } :
    mode === 'system' ? { mode: 'system' as const } :
    (() => {
      const url = buildCustomUrl(settings.proxyHost, settings.proxyPort)
      if (!url) return { mode: 'direct' as const }
      // proxyRules string covers http+https in one shot. Bypass loopback so
      // local dev servers (Vibe preview, etc.) aren't accidentally tunneled.
      return { proxyRules: `http=${settings.proxyHost}:${settings.proxyPort};https=${settings.proxyHost}:${settings.proxyPort}`, proxyBypassRules: '<local>' }
    })()

  for (const s of sessions) {
    try {
      // Race against a 3s ceiling so a stuck setProxy can't wedge the caller.
      // Mostly defensive: setProxy on persist:web-browse partition before it's
      // materialized has been observed to stall on some Windows configs.
      await Promise.race([
        s.setProxy(proxyConfig),
        new Promise<void>(resolve => setTimeout(() => resolve(), 3000))
      ])
    } catch (e) {
      console.warn('[proxy] session.setProxy failed:', (e as Error).message)
    }
  }

  // --- 2. undici global dispatcher (Node fetch) ---
  const undiciUrl = effectiveUndiciUrl(settings)
  const prev = currentDispatcher
  try {
    if (undiciUrl) {
      const next = new ProxyAgent(undiciUrl)
      setGlobalDispatcher(next)
      currentDispatcher = next
    } else if (prev) {
      // User turned proxy back off — reset to a fresh default Agent so the
      // previous ProxyAgent stops being consulted. Skip when prev is null:
      // we want to leave Node's internal dispatcher untouched.
      const next = new Agent()
      setGlobalDispatcher(next)
      currentDispatcher = next
    }
  } catch (e) {
    console.warn('[proxy] setGlobalDispatcher failed:', (e as Error).message)
  }
  // Tear down the previous dispatcher AFTER swapping in the new one so any
  // in-flight requests can finish on their existing sockets.
  if (prev) {
    try { await prev.destroy() } catch { /* ignore */ }
  }

  const summary = mode === 'custom'
    ? `${mode} (http://${settings.proxyHost}:${settings.proxyPort})`
    : mode === 'system'
    ? `${mode} (undici: ${undiciUrl || 'no env var → direct'})`
    : mode
  console.log('[proxy] applied:', summary)
}
