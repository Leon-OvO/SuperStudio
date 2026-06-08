import os from 'os'
import path from 'path'
import fs from 'fs'
import { parseSkillMd } from './skill-files'
import { getSettings } from './store'
import { listInstalledSkills } from './skills-db'

// ============================================================================
// Local skill auto-discovery.
//
// Scans well-known locations for Claude-Code-format skill bundles (a folder
// containing SKILL.md) that the user already has on disk but hasn't imported
// into SuperStudio yet, so the Skills center can offer a one-click import.
//   - ~/.claude/skills/<bundle>/SKILL.md   (Claude Code, user-level)
//   - <project>/.claude/skills/<bundle>/SKILL.md (project-level, when a Vibe
//     project is open)
//   - <settings.skillDiscoverDir>/<bundle>/SKILL.md (a custom folder)
//
// Read-only: we never copy anything here — the actual import reuses
// importLocalSkillBundle via the SKILLS_IMPORT_LOCAL handler.
// ============================================================================

export type DiscoverSource = 'claude' | 'project' | 'custom'

export interface DiscoveredSkill {
  name: string
  description: string
  /** Absolute path to the bundle directory (passed back to import). */
  path: string
  source: DiscoverSource
  fileCount: number
  /** True when a skill with the same derived id / name is already installed. */
  alreadyImported: boolean
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__'])
const MAX_SCAN_DIRS = 200

/** Mirror importLocalSkillBundle's id derivation so we can detect duplicates. */
function deriveId(name: string): string {
  return 'local-' + name.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase()
}

function findManifest(dir: string): string | null {
  for (const cand of ['SKILL.md', 'skill.md', 'Skill.md']) {
    const p = path.join(dir, cand)
    try { if (fs.statSync(p).isFile()) return p } catch { /* not here */ }
  }
  return null
}

/** Shallow-ish recursive file count (bounded) — purely informational. */
function countFiles(dir: string, depth = 0): number {
  if (depth > 4) return 0
  let n = 0
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      n += countFiles(path.join(dir, e.name), depth + 1)
    } else if (e.isFile()) {
      n++
    }
    if (n > 500) break
  }
  return n
}

function scanRoot(root: string, source: DiscoverSource): DiscoveredSkill[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) }
  catch { return [] } // root doesn't exist / unreadable → nothing
  const out: DiscoveredSkill[] = []
  for (const e of entries) {
    if (out.length >= MAX_SCAN_DIRS) break
    if (!e.isDirectory() || e.isSymbolicLink()) continue
    if (SKIP_DIRS.has(e.name)) continue
    const dir = path.join(root, e.name)
    const manifest = findManifest(dir)
    if (!manifest) continue
    let content = ''
    try { content = fs.readFileSync(manifest, 'utf8') } catch { continue }
    const { name, description } = parseSkillMd(content)
    out.push({
      name: (name || e.name).trim() || e.name,
      description: (description || '').trim(),
      path: dir,
      source,
      fileCount: countFiles(dir),
      alreadyImported: false, // filled by caller
    })
  }
  return out
}

/**
 * Discover importable local skill bundles. `projectPath` (the open Vibe project)
 * adds its `.claude/skills` to the scan. Never throws.
 */
export function discoverLocalSkills(projectPath?: string): DiscoveredSkill[] {
  const roots: { root: string; source: DiscoverSource }[] = [
    { root: path.join(os.homedir(), '.claude', 'skills'), source: 'claude' },
  ]
  if (projectPath && projectPath.trim()) {
    roots.push({ root: path.join(projectPath, '.claude', 'skills'), source: 'project' })
  }
  let custom = ''
  try { custom = (getSettings().skillDiscoverDir || '').trim() } catch { /* settings unavailable */ }
  if (custom) roots.push({ root: custom, source: 'custom' })

  const found: DiscoveredSkill[] = []
  const seen = new Set<string>()
  for (const { root, source } of roots) {
    for (const s of scanRoot(root, source)) {
      const key = path.resolve(s.path)
      if (seen.has(key)) continue
      seen.add(key)
      found.push(s)
    }
  }

  // Flag already-imported bundles (by derived id OR exact display name).
  let installed: ReturnType<typeof listInstalledSkills> = []
  try { installed = listInstalledSkills() } catch { /* db not ready */ }
  const ids = new Set(installed.map(s => s.id))
  const names = new Set(installed.map(s => s.name.toLowerCase()))
  for (const s of found) {
    s.alreadyImported = ids.has(deriveId(s.name)) || names.has(s.name.toLowerCase())
  }
  return found
}
