/**
 * Vibe / Build page — recent-project metadata helpers.
 *
 * Recent project paths are persisted inside `AppSettings.buildRecentProjectDirs`
 * (no separate store file). We also expose `getVibeProjectsRoot()` for the
 * app-managed project folder.
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { RecentProject } from '../../../src/shared/ipc-types'
import { getSettings, saveSettings } from './store'

const RECENT_CAP = 10

let _rootCache: string | null = null

export function getVibeProjectsRoot(): string {
  if (_rootCache) return _rootCache
  const dir = path.join(app.getPath('userData'), 'vibe-projects')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  _rootCache = dir
  return dir
}

function readRecent(): string[] {
  const s = getSettings() as { buildRecentProjectDirs?: string[] }
  return Array.isArray(s.buildRecentProjectDirs) ? s.buildRecentProjectDirs : []
}

function writeRecent(list: string[]): void {
  saveSettings({ buildRecentProjectDirs: list.slice(0, RECENT_CAP) })
}

export function addRecentProject(p: string): void {
  const abs = path.resolve(p)
  const list = readRecent().filter(x => path.resolve(x) !== abs)
  list.unshift(abs)
  writeRecent(list)
}

export function removeRecentProject(p: string): void {
  const abs = path.resolve(p)
  writeRecent(readRecent().filter(x => path.resolve(x) !== abs))
}

export function getRecentProjects(): RecentProject[] {
  const out: RecentProject[] = []
  let mutated = false
  const filtered: string[] = []
  for (const p of readRecent()) {
    // Drop entries whose folder no longer exists on disk
    try {
      const st = fs.statSync(p)
      if (!st.isDirectory()) { mutated = true; continue }
      filtered.push(p)
      out.push({
        path: p,
        name: path.basename(p),
        lastOpenedAt: 0  // we don't track per-entry time yet; ordering = recency
      })
    } catch {
      mutated = true  // path is gone; drop it
    }
  }
  if (mutated) writeRecent(filtered)
  return out
}

/**
 * Is the given absolute path allowed as a project root?
 * Allowed if:
 *   - it lives under getVibeProjectsRoot(), OR
 *   - it's currently in the recent-projects list
 */
export function isAllowedProjectPath(p: string): boolean {
  const abs = path.resolve(p)
  const root = getVibeProjectsRoot()
  if (abs === root) return false  // root itself isn't a project
  if (abs.startsWith(root + path.sep)) return true
  return readRecent().some(x => path.resolve(x) === abs)
}
