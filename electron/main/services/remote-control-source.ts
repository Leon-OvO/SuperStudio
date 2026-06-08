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
  /** DWork-only: true when the update should be treated as required
   *  (manifest.mandatory === true, or the running version is below minVersion). */
  mandatory?: boolean
  /** DWork-only: minimum supported version from the manifest; clients below it
   *  must update. Null when the manifest doesn't declare one. */
  minVersion?: string | null
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

/** The JSON shape the updater understands. Served either as a standalone JSON
 *  file or embedded in the DWork update page as a
 *  `<script type="application/json" id="dwork-update-manifest">` block. */
interface UpdateManifest {
  version?: string
  /** Alias accepted for `version`. */
  latestVersion?: string
  name?: string
  notes?: string
  body?: string
  mandatory?: boolean
  minVersion?: string
  releaseUrl?: string
}

/** Pull the update manifest out of a fetched body. Prefers an embedded
 *  `<script type="application/json" id="dwork-update-manifest">` block — so the
 *  customer-facing landing page can double as the update endpoint — and falls
 *  back to treating the whole body as JSON (a plain version file). Returns null
 *  when neither parses, so the caller reports "up to date" instead of throwing. */
function extractManifest(text: string): UpdateManifest | null {
  const m = text.match(
    /<script[^>]*id=["']dwork-update-manifest["'][^>]*>([\s\S]*?)<\/script>/i
  )
  const raw = (m ? m[1] : text).trim()
  try {
    return JSON.parse(raw) as UpdateManifest
  } catch {
    return null
  }
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
      mandatory: false,
      minVersion: null,
    }
    try {
      const res = await fetch(verUrl, { headers: { 'Cache-Control': 'no-cache' } })
      if (!res.ok) return base
      const manifest = extractManifest(await res.text())
      if (!manifest) return base
      const remoteVersion = (manifest.version || manifest.latestVersion || '').trim() || null
      if (!remoteVersion) return base
      const minVersion = (manifest.minVersion || '').trim() || null
      // Fields the client judges on: "behind" when remote > current; "mandatory"
      // when the manifest flags it or the running build is below minVersion.
      const hasUpdate = compareVersions(remoteVersion, currentVersion) > 0
      const mandatory =
        manifest.mandatory === true ||
        (minVersion ? compareVersions(minVersion, currentVersion) > 0 : false)
      return {
        ...base,
        remoteVersion,
        remoteName: manifest.name ?? null,
        body: manifest.notes ?? manifest.body ?? null,
        releaseUrl:
          (typeof manifest.releaseUrl === 'string' && manifest.releaseUrl) ||
          BRAND.updateReleasesUrl ||
          '',
        hasUpdate,
        mandatory,
        minVersion,
      }
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
