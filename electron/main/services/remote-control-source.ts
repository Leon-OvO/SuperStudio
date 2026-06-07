// Seam: RemoteControlSource
//
// Inverts core's dependency on a remote control plane (remote model.conf hosting
// + app update checks). Core declares this interface and ships a no-op default,
// so the deliverable build has NO hard-coded host / owner / repo / URLs. A
// proprietary overlay injects a concrete implementation (see
// services/providers/github-remote-control.ts) for SuperStudio; a customer could
// inject their own.
//
// Wiring: model-conf.ts / updater.ts call getRemoteControlSource() instead of
// fetching from a hard-coded URL; the overlay calls setRemoteControlSource(...).

import type { RemoteModelConf } from '../../../src/shared/ipc-types'
import { BRAND } from '../../../src/shared/brand'

export type { RemoteModelConf }

/** Result of an update check. Mirrors what the renderer's UpdateNotifier expects. */
export interface UpdateInfo {
  /** True when remoteVersion > currentVersion. */
  hasUpdate: boolean
  currentVersion: string
  /** Remote tag stripped of leading 'v'. Null if no release exists yet. */
  remoteVersion: string | null
  /** Human-readable release name. */
  remoteName: string | null
  /** Release notes body (markdown). */
  body: string | null
  /** Direct link to open in the browser ('' when none). */
  releaseUrl: string
  /** Set when the check failed — UI can show a non-toast error. */
  error?: string
}

export interface RemoteControlSource {
  /** Fetch managed default-model overrides, or null when no remote source. */
  fetchModelConf(): Promise<RemoteModelConf | null>
  /** Check for an app update given the current version, or null when disabled. */
  checkUpdate(currentVersion: string): Promise<UpdateInfo | null>
}

function parseVersion(v: string): number[] {
  const cleaned = v.replace(/^v/i, '').split(/[-+]/)[0]
  return cleaned.split('.').map((n) => parseInt(n, 10) || 0)
}
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Deliverable default: no remote model.conf; detect updates by comparing the
 *  running version against the `version` field of BRAND.updateVersionUrl (a raw
 *  package.json), and open BRAND.updateReleasesUrl for download. When the brand
 *  declares no update URL, update checks are disabled. A proprietary overlay may
 *  still override this entirely (e.g. SuperStudio's GitHub source). */
const brandRemoteControlSource: RemoteControlSource = {
  async fetchModelConf() {
    return null
  },
  async checkUpdate(currentVersion: string): Promise<UpdateInfo | null> {
    const verUrl = BRAND.updateVersionUrl
    if (!verUrl) return null
    const base: UpdateInfo = {
      hasUpdate: false,
      currentVersion,
      remoteVersion: null,
      remoteName: null,
      body: null,
      releaseUrl: BRAND.updateReleasesUrl || '',
    }
    try {
      const res = await fetch(verUrl, { headers: { 'Cache-Control': 'no-cache' } })
      if (!res.ok) return base
      const data = JSON.parse(await res.text()) as { version?: string }
      const remoteVersion = (data.version || '').trim() || null
      if (!remoteVersion) return base
      return { ...base, remoteVersion, hasUpdate: compareVersions(remoteVersion, currentVersion) > 0 }
    } catch (e) {
      return { ...base, error: (e as Error)?.message || String(e) }
    }
  },
}

let current: RemoteControlSource = brandRemoteControlSource

export function setRemoteControlSource(source: RemoteControlSource): void {
  current = source
}

export function getRemoteControlSource(): RemoteControlSource {
  return current
}
