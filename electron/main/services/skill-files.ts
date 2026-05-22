import { app } from 'electron'
import path from 'path'
import fs from 'fs'

// ============================================================================
// Skill bundle download + on-disk management.
//
// SkillHub serves Claude-Code-format Agent Skills (SKILL.md + bundled
// scripts/references/assets). Two endpoints (verified, undocumented):
//   GET /api/v1/skills/{slug}/files          → { files: [{ path, sha256, size }] }
//   GET /api/v1/skills/{slug}/file?path=...  → 302 → COS → raw bytes
// Node's fetch follows the 302 transparently.
//
// All path-traversal guards + size limits live in this module.
// ============================================================================

const SKILLHUB_API = 'https://api.skillhub.cn'
const MAX_FILES = 300
const MAX_FILE_SIZE = 2 * 1024 * 1024      // 2 MB per file
const MAX_TOTAL_SIZE = 20 * 1024 * 1024    // 20 MB per bundle
const MAX_READ_SIZE = 512 * 1024           // 512 KB cap for read_skill_file
const FETCH_TIMEOUT = 20_000

export function skillsRootDir(): string {
  return path.join(app.getPath('userData'), 'skills')
}

export function skillDir(id: string): string {
  return path.join(skillsRootDir(), sanitizeId(id))
}

/** Skill ids come from SkillHub slugs — restrict to a safe charset so a
 *  malicious id can't escape skillsRootDir. */
function sanitizeId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (!clean || clean === '.' || clean === '..') throw new Error(`非法技能 id: ${id}`)
  return clean
}

/** Resolve `relPath` inside `base`, rejecting any path-traversal escape. */
function safeJoin(base: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const resolved = path.resolve(base, normalized)
  const baseResolved = path.resolve(base)
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    throw new Error(`非法文件路径（越界）: ${relPath}`)
  }
  return resolved
}

export interface SkillFileEntry { path: string; sha256: string; size: number }

export async function fetchSkillFileList(slug: string, version?: string): Promise<SkillFileEntry[]> {
  const v = version ? `?version=${encodeURIComponent(version)}` : ''
  const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/files${v}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`获取技能文件列表失败: HTTP ${res.status}`)
  const data = await res.json() as { files?: unknown }
  if (!Array.isArray(data.files)) throw new Error('技能文件列表格式异常（缺少 files 数组）')
  const out: SkillFileEntry[] = []
  for (const f of data.files) {
    if (!f || typeof f !== 'object') continue
    const r = f as Record<string, unknown>
    if (typeof r.path !== 'string' || !r.path) continue
    out.push({
      path: r.path,
      sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
      size: typeof r.size === 'number' ? r.size : 0
    })
  }
  return out
}

export async function fetchSkillFileText(slug: string, filePath: string, version?: string): Promise<string> {
  const v = version ? `&version=${encodeURIComponent(version)}` : ''
  const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}${v}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`下载技能文件失败 (${filePath}): HTTP ${res.status}`)
  return res.text()
}

export interface DownloadedBundle { installPath: string; files: string[]; skillMd: string }

/**
 * Download every file of a skill into <userData>/skills/<id>/ and return the
 * install path, the bundle-relative file list, and the SKILL.md content.
 */
export async function downloadSkillBundle(slug: string, id: string, version?: string): Promise<DownloadedBundle> {
  const list = await fetchSkillFileList(slug, version)
  if (!list.length) throw new Error('技能没有任何文件')
  if (list.length > MAX_FILES) throw new Error(`技能文件数超限 (${list.length} > ${MAX_FILES})`)
  const total = list.reduce((s, f) => s + (f.size || 0), 0)
  if (total > MAX_TOTAL_SIZE) throw new Error(`技能包过大 (${(total / 1024 / 1024).toFixed(1)} MB)`)

  const dir = skillDir(id)
  // Fresh install / upgrade — wipe any stale copy so removed files don't linger.
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  const written: string[] = []
  for (const f of list) {
    if (f.size && f.size > MAX_FILE_SIZE) {
      console.warn(`[skill-files] skipping oversized file ${f.path} (${f.size} bytes)`)
      continue
    }
    const dest = safeJoin(dir, f.path)
    const text = await fetchSkillFileText(slug, f.path, version)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, text, 'utf8')
    written.push(f.path.replace(/\\/g, '/'))
  }

  const skillMdRel = findSkillMd(written)
  if (!skillMdRel) throw new Error('技能包缺少 SKILL.md（也没有 README.md 兜底）')
  const skillMd = fs.readFileSync(safeJoin(dir, skillMdRel), 'utf8')
  return { installPath: dir, files: written, skillMd }
}

/** Locate the manifest file: SKILL.md (exact) → case-insensitive skill.md → README.md. */
function findSkillMd(files: string[]): string | null {
  const top = files.filter(f => !f.includes('/'))
  const exact = top.find(f => f === 'SKILL.md')
  if (exact) return exact
  const ci = top.find(f => f.toLowerCase() === 'skill.md')
  if (ci) return ci
  return top.find(f => f.toLowerCase() === 'readme.md') ?? null
}

export function removeSkillDir(id: string): void {
  try { fs.rmSync(skillDir(id), { recursive: true, force: true }) }
  catch (e) { console.warn('[skill-files] removeSkillDir failed:', (e as Error).message) }
}

export function readSkillResource(id: string, relPath: string): string {
  const abs = safeJoin(skillDir(id), relPath)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_READ_SIZE) throw new Error(`文件过大 (${(stat.size / 1024).toFixed(0)} KB)`)
  return fs.readFileSync(abs, 'utf8')
}

/** Strip the leading YAML frontmatter block and pull name + description. */
export function parseSkillMd(content: string): { name: string; description: string; body: string } {
  const fmMatch = content.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
  const body = fmMatch ? content.slice(fmMatch[0].length).replace(/^\s+/, '') : content.trim()
  let name = ''
  let description = ''
  if (fmMatch) {
    name = extractScalar(fmMatch[1], 'name')
    description = extractScalar(fmMatch[1], 'description')
  }
  return { name, description, body }
}

/** Minimal YAML scalar extractor — handles `key: value`, `key: "value"`,
 *  `key: 'value'`. Returns '' for block scalars (`|`, `>`) or missing keys. */
function extractScalar(frontmatter: string, key: string): string {
  const m = frontmatter.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
  if (!m) return ''
  let v = m[1].trim()
  if (!v || v === '|' || v === '>' || v === '|-' || v === '>-') return ''
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}
