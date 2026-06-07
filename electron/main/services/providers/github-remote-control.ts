// PROPRIETARY OVERLAY — moves OUT of the deliverable core at the repo split.
//
// GitHub-backed RemoteControlSource: hosts the recommended model.conf on the
// release-host repo and checks GitHub releases for updates. Owns the only
// hard-coded owner / repo / URLs; core (model-conf.ts / updater.ts) is free of
// them and runs on the seam noop default when this impl is not injected.

import type { RemoteControlSource, UpdateInfo, RemoteModelConf } from '../remote-control-source'
import { parseConf } from '../model-conf'

const GH_OWNER = 'Leon-OvO'
const GH_REPO = 'SuperStudio'
// raw.githubusercontent.com needs a concrete ref (no HEAD), so try the common
// default branches in order. The first that returns the file wins.
const RAW_URLS = ['main', 'master'].map(
  (branch) => `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${branch}/model.conf`
)
const RELEASES_URL = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`
/** Browser-facing page — fallback when a release has no html_url. */
const RELEASES_PAGE = `https://github.com/${GH_OWNER}/${GH_REPO}/releases`

interface GitHubRelease {
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
  return cleaned.split('.').map((n) => parseInt(n, 10) || 0)
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

export class GitHubRemoteControlSource implements RemoteControlSource {
  async fetchModelConf(): Promise<RemoteModelConf | null> {
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

  async checkUpdate(currentVersion: string): Promise<UpdateInfo | null> {
    const base: UpdateInfo = {
      hasUpdate: false,
      currentVersion,
      remoteVersion: null,
      remoteName: null,
      body: null,
      releaseUrl: RELEASES_PAGE,
    }
    try {
      const res = await fetch(RELEASES_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `SuperStudio/${currentVersion}`,
        },
      })
      if (res.status === 404) return base // no releases yet — "up to date"
      if (!res.ok) return { ...base, error: `GitHub API HTTP ${res.status}` }
      const data = (await res.json()) as GitHubRelease
      if (data.draft || data.prerelease) return base // stable only
      const remoteVersion = data.tag_name?.replace(/^v/i, '') ?? null
      if (!remoteVersion) return base
      const hasUpdate = compareVersions(remoteVersion, currentVersion) > 0
      return {
        hasUpdate,
        currentVersion,
        remoteVersion,
        remoteName: data.name ?? null,
        body: data.body ?? null,
        releaseUrl: data.html_url ?? RELEASES_PAGE,
      }
    } catch (e) {
      return { ...base, error: (e as Error)?.message || String(e) }
    }
  }
}
