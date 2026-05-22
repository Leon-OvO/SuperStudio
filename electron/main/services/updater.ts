/**
 * Gitee-backed update checker.
 *
 * We can't use electron-updater here — Gitee isn't a supported provider, and
 * setting up a generic-provider manifest is overkill for an unsigned desktop
 * app. Instead we hit Gitee's public REST API to fetch the latest release,
 * compare its tag against the running version, and surface a "new version
 * available" toast in the renderer that opens the Gitee release page in the
 * user's browser.
 *
 * No background download, no in-place install — but also no signing
 * requirement, no extra infrastructure, and the user always sees a real
 * Gitee URL before downloading anything.
 */

import { app, shell } from 'electron'
import { BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'

const GITEE_OWNER = 'leonops'
const GITEE_REPO = 'SuperStudio'
const RELEASES_URL = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/latest`
/** Browser-facing page — what we open when the user clicks "下载新版本". */
const RELEASES_PAGE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases`

export interface UpdateInfo {
  /** True when remoteVersion > currentVersion. */
  hasUpdate: boolean
  currentVersion: string
  /** Remote tag stripped of leading 'v'. Null if no release exists yet. */
  remoteVersion: string | null
  /** Human-readable release name. */
  remoteName: string | null
  /** Release notes body (markdown from Gitee). */
  body: string | null
  /** Direct link to open in the browser. */
  releaseUrl: string
  /** Set when the API call failed — UI can show a non-toast error. */
  error?: string
}

interface GiteeRelease {
  tag_name: string
  name: string
  body?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
}

/** Parse "1.2.3" / "v1.2.3" / "1.2.3-beta.1" → [1,2,3] (suffix ignored). */
function parseVersion(v: string): number[] {
  const cleaned = v.replace(/^v/i, '').split(/[-+]/)[0]
  return cleaned.split('.').map(n => parseInt(n, 10) || 0)
}

/** > 0 → a is newer; < 0 → b is newer; 0 → same. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentVersion = app.getVersion()
  const base: UpdateInfo = {
    hasUpdate: false,
    currentVersion,
    remoteVersion: null,
    remoteName: null,
    body: null,
    releaseUrl: RELEASES_PAGE
  }

  try {
    const res = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/json', 'User-Agent': `SuperStudio/${currentVersion}` }
    })
    if (res.status === 404) {
      // Repository has no releases yet — treat as "up to date" silently.
      console.log('[updater] no releases published yet on Gitee')
      return base
    }
    if (!res.ok) {
      return { ...base, error: `Gitee API HTTP ${res.status}` }
    }
    const data = await res.json() as GiteeRelease
    if (data.draft || data.prerelease) {
      // Skip drafts / prereleases — users only want stable.
      return base
    }
    const remoteVersion = data.tag_name?.replace(/^v/i, '') ?? null
    if (!remoteVersion) return base
    const hasUpdate = compareVersions(remoteVersion, currentVersion) > 0
    return {
      hasUpdate,
      currentVersion,
      remoteVersion,
      remoteName: data.name ?? null,
      body: data.body ?? null,
      releaseUrl: data.html_url ?? RELEASES_PAGE
    }
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    console.warn('[updater] check failed:', msg)
    return { ...base, error: msg }
  }
}

/** Fire-and-forget startup check. Notifies the renderer ONLY if an update is
 *  available — silent failures and "already latest" don't bother the user. */
export function scheduleStartupCheck(getWin: () => BrowserWindow | null): void {
  // Wait ~10s so the window has time to fully paint + the renderer's IPC
  // listener has been mounted. We don't race the toast against the splash.
  setTimeout(async () => {
    const info = await checkForUpdates()
    if (!info.hasUpdate) return
    const win = getWin()
    if (!win || win.isDestroyed()) return
    win.webContents.send(IPC.UPDATER_AVAILABLE, info)
  }, 10000)
}

export function openReleasePage(url?: string): void {
  shell.openExternal(url || RELEASES_PAGE).catch(() => {/* ignore */})
}
