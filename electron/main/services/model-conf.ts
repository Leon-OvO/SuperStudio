/**
 * Remote model.conf — GitHub-hosted recommended default models.
 *
 * The maintainer publishes a `model.conf` (JSON) at the project repo to steer
 * what new clients default to (chat / image / video / embedding model NAMES).
 * Providers are NOT part of the file — providerIds are install-local UUIDs, so
 * the client keeps resolving which logged-in provider serves the recommended
 * model exactly as before (that logic is unchanged).
 *
 * "Managed default" policy: a default is overwritten from model.conf ONLY when
 * the user hasn't diverged from the value we last applied (tracked in
 * `settings.appliedModelConf`). The instant the user picks their own model in
 * Settings, that field stops being touched. So model.conf controls defaults for
 * anyone still on a recommended value, and never clobbers a manual choice.
 *
 * Failure is silent and non-fatal — offline, 404 (file not published yet), or a
 * malformed file all just leave the built-in defaults in place.
 */

import { BrowserWindow } from 'electron'
import { IPC, type RemoteModelConf } from '../../../src/shared/ipc-types'
import { getSettings, saveSettings } from './store'

const GH_OWNER = 'Leon-OvO'
const GH_REPO = 'SuperStudio'
// raw.githubusercontent.com needs a concrete ref (no HEAD), so try the common
// default branches in order. The first that returns the file wins.
const RAW_URLS = ['main', 'master'].map(
  (branch) => `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${branch}/model.conf`
)

const MANAGED_KEYS = [
  'defaultChatModel',
  'defaultImageModel',
  'defaultVideoModel',
  'defaultEmbeddingModel',
] as const

/** Tolerant JSON parse for a hand-edited conf: strips whole-line `#` / `//`
 *  comments and a trailing comma before `}`/`]` so annotations don't break it. */
function parseConf(text: string): RemoteModelConf {
  const stripped = text
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return t && !t.startsWith('#') && !t.startsWith('//')
    })
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1')
  const data = JSON.parse(stripped) as Record<string, unknown>
  const out: RemoteModelConf = {}
  for (const key of MANAGED_KEYS) {
    const v = data[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim()
  }
  return out
}

async function fetchRemoteConf(): Promise<RemoteModelConf | null> {
  for (const url of RAW_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': `SuperStudio`, 'Cache-Control': 'no-cache' },
      })
      if (res.status === 404) continue // not on this branch — try the next
      if (!res.ok) continue
      return parseConf(await res.text())
    } catch {
      // Network error / parse error → try next URL, then give up silently.
    }
  }
  return null
}

export interface ModelConfSyncResult {
  ok: boolean
  /** Field names whose default model was actually updated this run. */
  applied: string[]
  error?: string
}

/**
 * Fetch model.conf and apply it under the managed-default policy. Emits
 * IPC.MODEL_CONF_APPLIED to the window when something changed, so the renderer
 * can re-read settings without waiting for a focus event.
 */
export async function syncModelConf(getWin?: () => BrowserWindow | null): Promise<ModelConfSyncResult> {
  const remote = await fetchRemoteConf()
  if (!remote) return { ok: false, applied: [], error: 'model.conf unavailable' }

  const settings = getSettings()
  const prevSnapshot = settings.appliedModelConf ?? {}
  const patch: Partial<RemoteModelConf> = {}
  const nextSnapshot: RemoteModelConf = { ...prevSnapshot }

  for (const key of MANAGED_KEYS) {
    const remoteVal = remote[key]
    if (!remoteVal) continue
    // Record what the cloud currently recommends, regardless of whether we
    // apply it — so a user override is detected against the LATEST snapshot.
    nextSnapshot[key] = remoteVal

    const current = settings[key]
    const lastApplied = prevSnapshot[key]
    // Untouched when empty or still equal to what we last pushed. A manual pick
    // diverges from lastApplied and is therefore preserved.
    const untouched = !current || current === lastApplied
    if (untouched && current !== remoteVal) {
      patch[key] = remoteVal
    }
  }

  const snapshotChanged = JSON.stringify(nextSnapshot) !== JSON.stringify(prevSnapshot)
  const appliedKeys = Object.keys(patch)

  if (appliedKeys.length > 0 || snapshotChanged) {
    saveSettings({ ...patch, appliedModelConf: nextSnapshot })
  }

  if (appliedKeys.length > 0 && getWin) {
    const win = getWin()
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.MODEL_CONF_APPLIED, { applied: appliedKeys })
    }
  }

  return { ok: true, applied: appliedKeys }
}

/** Fire-and-forget startup sync. Delayed so it doesn't compete with first paint
 *  and the renderer's IPC listener is mounted to receive MODEL_CONF_APPLIED. */
export function scheduleModelConfSync(getWin: () => BrowserWindow | null): void {
  setTimeout(() => {
    syncModelConf(getWin).catch((e) => {
      console.warn('[model-conf] startup sync failed:', (e as Error)?.message ?? e)
    })
  }, 8000)
}
