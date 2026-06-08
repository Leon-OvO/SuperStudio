import fs from 'fs'
import path from 'path'
import { parseSoulMd } from './soul-parse'
import { insertUserSouls, type NewUserSoul } from './user-souls-db'

/**
 * Import external soul.md files into the user_souls table. Accepts either a
 * single .md file or a directory (recursively collecting *.md). Mirrors the
 * skill local-import guardrails (skip noise dirs + symlinks, size / count caps).
 */

const MAX_FILES = 500
const MAX_FILE_SIZE = 1024 * 1024        // 1 MB per soul.md
const MAX_TOTAL_SIZE = 20 * 1024 * 1024  // 20 MB per import
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store'])

/** Collect absolute paths of the .md files to import from a file or directory. */
function collectMd(sourcePath: string): string[] {
  let st: fs.Stats
  try { st = fs.statSync(sourcePath) }
  catch { throw new Error('所选路径不存在或无法访问') }

  if (st.isFile()) {
    if (!/\.md$/i.test(sourcePath)) throw new Error('请选择 .md 文件（soul.md）')
    return [sourcePath]
  }

  const out: string[] = []
  let total = 0
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name))
        continue
      }
      if (!e.isFile() || !/\.md$/i.test(e.name)) continue
      const full = path.join(dir, e.name)
      let size: number
      try { size = fs.statSync(full).size }
      catch { continue }
      if (size > MAX_FILE_SIZE) continue
      total += size
      if (total > MAX_TOTAL_SIZE) throw new Error(`导入内容过大（超过 ${(MAX_TOTAL_SIZE / 1024 / 1024).toFixed(0)} MB）`)
      out.push(full)
      if (out.length > MAX_FILES) throw new Error(`文件数超限（> ${MAX_FILES}）`)
    }
  }
  walk(sourcePath)
  return out
}

export interface ImportTalentsResult {
  /** Files that parsed into a valid persona and were stored. */
  inserted: number
  /** Files skipped (unreadable / empty persona / missing name). */
  skipped: number
  /** Total .md files found at the source. */
  total: number
}

export function importLocalTalents(sourcePath: string): ImportTalentsResult {
  const files = collectMd(sourcePath)
  if (!files.length) throw new Error('未找到 .md 文件')

  const entries: NewUserSoul[] = []
  let skipped = 0
  for (const f of files) {
    let md: string
    try { md = fs.readFileSync(f, 'utf8') }
    catch { skipped++; continue }
    const parsed = parseSoulMd(md, path.basename(f))
    if (!parsed.systemPrompt.trim() || !parsed.name.trim()) { skipped++; continue }
    entries.push({ ...parsed, originPath: f })
  }

  const { inserted } = insertUserSouls(entries)
  return { inserted, skipped: skipped + (entries.length - inserted), total: files.length }
}
