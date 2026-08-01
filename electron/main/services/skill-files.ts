import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'

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

// ----------------------------------------------------------------------------
// Transactional install helpers.
//
// A download/import writes into a throwaway ".staging-<id>-<nonce>" directory
// first. Only once every file is on disk (and sha256-verified, and a
// SKILL.md/README.md was found) does it get promoted into place. Promotion is
// a two-step rename dance — Windows refuses `rename()` onto an existing
// target, so we can't do it in one atomic swap: first move the current
// install (if any) to a backup, then move staging into its place. Any
// failure along the way restores the backup, so a network drop or a locked
// file mid-download leaves the previously-installed skill untouched instead
// of a half-written directory.
// ----------------------------------------------------------------------------

/** Short random suffix for staging/backup dir names — kept small (not a UUID)
 *  so deeply-nested skill bundles don't trip Windows' ~260 char path limit. */
function randomSuffix(): string {
  return crypto.randomBytes(4).toString('hex')
}

function stagingDirFor(id: string): string {
  return path.join(skillsRootDir(), `.staging-${sanitizeId(id)}-${randomSuffix()}`)
}

/** Windows Defender / Explorer can transiently hold a handle open right after
 *  a file is written, making the immediately-following rename/rm fail with
 *  EBUSY/EPERM/ENOTEMPTY. Retry a few times with a short backoff before
 *  giving up. Sleeps synchronously (Atomics.wait) since this whole module's
 *  filesystem API is sync-first and importLocalSkillBundle must stay sync for
 *  its existing (unawaited) callers. */
function withRetry<T>(fn: () => T, attempts = 5, baseDelayMs = 60): T {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try { return fn() }
    catch (e) {
      lastErr = e
      if (i < attempts - 1) syncSleepMs(baseDelayMs * (i + 1))
    }
  }
  throw lastErr
}

function syncSleepMs(ms: number): void {
  try {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  } catch { /* SharedArrayBuffer unavailable — best effort, skip the wait */ }
}

/** Best-effort recursive delete with retry. Never throws — a leftover staging
 *  or backup directory is disk-space noise, not a correctness problem, and
 *  must never mask the real error that triggered cleanup. */
function cleanupDirBestEffort(dir: string): void {
  try { withRetry(() => fs.rmSync(dir, { recursive: true, force: true })) }
  catch (e) { console.warn(`[skill-files] cleanup failed for ${dir}:`, (e as Error).message) }
}

/**
 * Promote a fully-populated staging directory into the real install location
 * for `id`. Two-step rename (see module header) with rollback on failure.
 * On success the staging dir no longer exists at its original path (it *is*
 * the new install dir); on failure it is left untouched so the caller can
 * inspect/clean it up, and the previous install (if any) is restored.
 */
function commitStagingToFinal(id: string, staging: string): string {
  const final = skillDir(id)
  fs.mkdirSync(path.dirname(final), { recursive: true })
  let backup: string | null = null
  if (fs.existsSync(final)) {
    backup = `${final}.bak-${randomSuffix()}`
    withRetry(() => fs.renameSync(final, backup as string))
  }
  try {
    withRetry(() => fs.renameSync(staging, final))
  } catch (e) {
    if (backup) {
      try { withRetry(() => fs.renameSync(backup as string, final)) }
      catch (rollbackErr) {
        console.warn(`[skill-files] 回滚失败，技能 ${id} 可能已丢失，备份在: ${backup}`, (rollbackErr as Error).message)
      }
    }
    throw e
  }
  if (backup) cleanupDirBestEffort(backup)
  return final
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
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

/** Fetch a skill file's raw bytes. Must NOT be decoded as text — the bundle can
 *  contain images/fonts/binaries, and round-tripping those through a UTF-8
 *  string corrupts them (and makes any sha256 check fail). Only SKILL.md is
 *  ever interpreted as text, and only after it's safely on disk as bytes. */
export async function fetchSkillFileBytes(slug: string, filePath: string, version?: string): Promise<Buffer> {
  const v = version ? `&version=${encodeURIComponent(version)}` : ''
  const url = `${SKILLHUB_API}/api/v1/skills/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(filePath)}${v}`
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`下载技能文件失败 (${filePath}): HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export interface DownloadedBundle { installPath: string; files: string[]; skillMd: string }

/**
 * Download every file of a skill into <userData>/skills/<id>/ and return the
 * install path, the bundle-relative file list, and the SKILL.md content.
 *
 * Transactional: files are downloaded + sha256-verified into a staging
 * directory first, and only promoted over the previous install once the
 * whole bundle (including a discoverable SKILL.md) is confirmed intact. A
 * network drop mid-download aborts the staging attempt and leaves whatever
 * was previously installed exactly as it was.
 */
export async function downloadSkillBundle(slug: string, id: string, version?: string): Promise<DownloadedBundle> {
  const list = await fetchSkillFileList(slug, version)
  if (!list.length) throw new Error('技能没有任何文件')
  if (list.length > MAX_FILES) throw new Error(`技能文件数超限 (${list.length} > ${MAX_FILES})`)
  const total = list.reduce((s, f) => s + (f.size || 0), 0)
  if (total > MAX_TOTAL_SIZE) throw new Error(`技能包过大 (${(total / 1024 / 1024).toFixed(1)} MB)`)

  const staging = stagingDirFor(id)
  fs.mkdirSync(staging, { recursive: true })
  try {
    const written: string[] = []
    for (const f of list) {
      if (f.size && f.size > MAX_FILE_SIZE) {
        console.warn(`[skill-files] skipping oversized file ${f.path} (${f.size} bytes)`)
        continue
      }
      const dest = safeJoin(staging, f.path)
      const bytes = await fetchSkillFileBytes(slug, f.path, version)
      if (f.sha256) {
        const actual = sha256Hex(bytes)
        if (actual.toLowerCase() !== f.sha256.toLowerCase()) {
          throw new Error(`技能文件校验失败（sha256 不匹配）: ${f.path}`)
        }
      } else {
        // SkillHub is a third-party source — don't assume every entry always
        // carries a hash, but flag it so a silently-tampered file is at least
        // visible in logs.
        console.warn(`[skill-files] ${f.path} 缺少 sha256，跳过完整性校验`)
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, bytes)
      written.push(f.path.replace(/\\/g, '/'))
    }

    const skillMdRel = findSkillMd(written)
    if (!skillMdRel) throw new Error('技能包缺少 SKILL.md（也没有 README.md 兜底）')
    const skillMd = fs.readFileSync(safeJoin(staging, skillMdRel), 'utf8')

    const installPath = commitStagingToFinal(id, staging)
    return { installPath, files: written, skillMd }
  } catch (e) {
    cleanupDirBestEffort(staging)
    throw e
  }
}

export interface ImportedBundle extends DownloadedBundle { id: string; name: string }

/** Directories never worth copying into a skill bundle (noise / huge / unsafe). */
const IMPORT_SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.DS_Store'])

/** Recursively list bundle-relative (posix) file paths under `dir`, enforcing
 *  the same count / size caps as a remote download. Skips noise dirs + symlinks. */
function listLocalBundleFiles(dir: string): { files: string[]; total: number } {
  const out: string[] = []
  let total = 0
  const walk = (abs: string, rel: string): void => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(abs, { withFileTypes: true }) }
    catch { return } // dir vanished / unreadable mid-walk — skip it
    for (const e of entries) {
      if (e.isSymbolicLink()) continue // never follow symlinks out of the tree
      if (e.isDirectory()) {
        if (IMPORT_SKIP_DIRS.has(e.name)) continue
        walk(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name)
        continue
      }
      if (!e.isFile()) continue
      const relPath = rel ? `${rel}/${e.name}` : e.name
      // A file can disappear between readdir and stat — skip it rather than crash.
      let size: number
      try { size = fs.statSync(path.join(abs, e.name)).size }
      catch { continue }
      if (size > MAX_FILE_SIZE) {
        console.warn(`[skill-files] import skipping oversized file ${relPath} (${size} bytes)`)
        continue
      }
      total += size
      if (total > MAX_TOTAL_SIZE) throw new Error(`技能包过大（超过 ${(MAX_TOTAL_SIZE / 1024 / 1024).toFixed(0)} MB）`)
      out.push(relPath)
      if (out.length > MAX_FILES) throw new Error(`技能文件数超限（> ${MAX_FILES}）`)
    }
  }
  walk(dir, '')
  return { files: out, total }
}

/** Find a SKILL.md / skill.md / README.md anywhere in the tree (prefer SKILL.md,
 *  then the shallowest). Used to re-root when the user picked a parent folder. */
function findSkillMdDeep(files: string[]): string | null {
  const cand = files.filter(f => /(^|\/)(skill|readme)\.md$/i.test(f))
  if (!cand.length) return null
  cand.sort((a, b) => {
    const rank = (f: string): number => (/(^|\/)skill\.md$/i.test(f) ? 0 : 1)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.split('/').length - b.split('/').length
  })
  return cand[0]
}

/**
 * Import a skill bundle from a local folder (or a path to its SKILL.md) into
 * <userData>/skills/<id>/. Mirrors downloadSkillBundle but copies from disk.
 * The id is derived from the SKILL.md `name` (or folder name), prefixed `local-`
 * so it never collides with a SkillHub slug.
 */
export function importLocalSkillBundle(sourcePath: string): ImportedBundle {
  let st: fs.Stats
  try { st = fs.statSync(sourcePath) }
  catch { throw new Error('所选路径不存在或无法访问') }

  // A picked/dropped .zip → extract to a temp folder and import that folder.
  // Lets an exported bundle (see buildSkillExportZip) round-trip straight back in.
  if (st.isFile() && sourcePath.toLowerCase().endsWith('.zip')) return importZipSkillBundle(sourcePath)

  // A single picked/dropped FILE → import just that file as a one-file skill.
  // We must NOT walk its parent directory: a loose SKILL.md often sits in
  // Downloads / Desktop / a project folder with GBs of unrelated files, which is
  // exactly what used to trip the 20 MB bundle cap ("技能包过大"). To bring along
  // bundled scripts/resources, the user selects (or drops) the FOLDER instead.
  if (st.isFile()) return importSingleFileSkill(sourcePath)

  let srcDir = sourcePath

  let rel = listLocalBundleFiles(srcDir).files
  if (!rel.length) throw new Error('所选文件夹为空')
  let skillMdRel = findSkillMd(rel)
  // The user may have picked the bundle's PARENT folder — if SKILL.md isn't at
  // the top level, re-root to wherever the nearest SKILL.md actually lives.
  if (!skillMdRel) {
    // Multi-skill collection (the combined .zip from buildSkillsExportZip): ≥2
    // immediate subfolders each holding their own SKILL.md. Importing one would
    // silently drop the rest, so refuse with a clear instruction instead.
    const subBundles = new Set<string>()
    for (const f of rel) {
      const parts = f.split('/')
      if (parts.length === 2 && /^skill\.md$/i.test(parts[1])) subBundles.add(parts[0])
    }
    if (subBundles.size >= 2) {
      throw new Error('这是多技能合集包（含多个技能子目录）。请先解压，再到「导入本地技能」里多选其中的技能文件夹分别导入。')
    }
    const deep = findSkillMdDeep(rel)
    if (deep) {
      srcDir = path.dirname(safeJoin(srcDir, deep))
      rel = listLocalBundleFiles(srcDir).files
      skillMdRel = findSkillMd(rel)
    }
  }
  if (!skillMdRel) throw new Error('未找到 SKILL.md —— 请选择包含 SKILL.md 的技能文件夹')

  const skillMd = fs.readFileSync(safeJoin(srcDir, skillMdRel), 'utf8')
  const { name } = parseSkillMd(skillMd)
  const baseName = name.trim() || path.basename(srcDir)
  const id = 'local-' + sanitizeId(baseName).toLowerCase()

  const staging = stagingDirFor(id)
  fs.mkdirSync(staging, { recursive: true })
  try {
    const written: string[] = []
    for (const r of rel) {
      const dest = safeJoin(staging, r)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(safeJoin(srcDir, r), dest) // byte-for-byte copy — never goes through a text encoding
      written.push(r)
    }
    const installPath = commitStagingToFinal(id, staging)
    return { id, name: baseName, installPath, files: written, skillMd }
  } catch (e) {
    cleanupDirBestEffort(staging)
    throw e
  }
}

/**
 * Import a single picked/dropped markdown file as a one-file skill. The file is
 * copied into the bundle as SKILL.md (so findSkillMd + load_skill pick it up).
 * No parent-directory walk — see importLocalSkillBundle for why.
 */
function importSingleFileSkill(filePath: string): ImportedBundle {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_FILE_SIZE) throw new Error(`文件过大 (${(stat.size / 1024 / 1024).toFixed(1)} MB)`)
  const content = fs.readFileSync(filePath, 'utf8')
  const { name } = parseSkillMd(content)
  const baseName = (name.trim() || path.basename(filePath).replace(/\.[^.]+$/, '')).trim() || 'skill'
  const id = 'local-' + sanitizeId(baseName).toLowerCase()

  const staging = stagingDirFor(id)
  fs.mkdirSync(staging, { recursive: true })
  try {
    fs.writeFileSync(path.join(staging, 'SKILL.md'), content, 'utf8')
    const installPath = commitStagingToFinal(id, staging)
    return { id, name: baseName, installPath, files: ['SKILL.md'], skillMd: content }
  } catch (e) {
    cleanupDirBestEffort(staging)
    throw e
  }
}

/** Extract a .zip skill bundle into a temp folder (guarding zip-slip via
 *  safeJoin) and import that folder, then clean up the temp copy. */
function importZipSkillBundle(zipPath: string): ImportedBundle {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(zipPath)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-import-'))
  try {
    for (const entry of zip.getEntries() as Array<{ isDirectory: boolean; entryName: string; getData: () => Buffer }>) {
      if (entry.isDirectory) continue
      const dest = safeJoin(tmp, entry.entryName) // throws on path-traversal escape
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, entry.getData())
    }
    return importLocalSkillBundle(tmp) // tmp is a dir now → folder branch (size caps re-applied)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * Build a re-importable .zip of an installed skill. Runtime skills (with an
 * on-disk bundle) are zipped wholesale (SKILL.md + resources); a prompt-only
 * skill gets a synthesized SKILL.md from its manifest. The returned buffer is
 * written to a user-chosen path by the SKILLS_EXPORT IPC handler.
 */
export interface ExportableSkill {
  id: string; name: string; description: string; version: string; author: string
  runtime: boolean; installPath: string | null; skillBody?: string; systemPrompt?: string
}

/** Synthesize a SKILL.md (frontmatter + body) for a prompt-only skill that has
 *  no on-disk bundle to zip wholesale. */
function synthSkillMd(skill: ExportableSkill): string {
  return [
    '---',
    `name: ${skill.name || skill.id}`,
    `description: ${(skill.description || '').replace(/\n/g, ' ')}`,
    `version: ${skill.version || '0.0.0'}`,
    `author: ${skill.author || ''}`,
    '---',
    '',
    skill.skillBody || skill.systemPrompt || ''
  ].join('\n')
}

/** Add one skill's content into a zip, optionally nested under `subdir`.
 *  Runtime skills (with an on-disk bundle) are copied wholesale; prompt-only
 *  skills get a synthesized SKILL.md. */
function addSkillToZip(zip: { addLocalFolder: (p: string, target?: string) => void; addFile: (n: string, b: Buffer) => void }, skill: ExportableSkill, subdir = ''): void {
  if (skill.runtime && skill.installPath && fs.existsSync(skill.installPath)) {
    zip.addLocalFolder(skill.installPath, subdir)
  } else {
    const name = subdir ? `${subdir}/SKILL.md` : 'SKILL.md'
    zip.addFile(name, Buffer.from(synthSkillMd(skill), 'utf8'))
  }
}

export function buildSkillExportZip(skill: ExportableSkill): Buffer {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip()
  addSkillToZip(zip, skill)
  return zip.toBuffer()
}

/**
 * Build ONE combined .zip holding many skills, each in its own subfolder
 * (named after the skill, de-duplicated). For backup / migrating / sharing a
 * whole set at once. Each subfolder contains a complete, individually
 * re-importable bundle (SKILL.md + resources).
 */
export function buildSkillsExportZip(skills: ExportableSkill[]): Buffer {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip()
  const used = new Set<string>()
  for (const skill of skills) {
    const base = (skill.name || skill.id).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 50) || 'skill'
    let sub = base, i = 2
    while (used.has(sub.toLowerCase())) sub = `${base}-${i++}`
    used.add(sub.toLowerCase())
    addSkillToZip(zip, skill, sub)
  }
  return zip.toBuffer()
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
  try { withRetry(() => fs.rmSync(skillDir(id), { recursive: true, force: true })) }
  catch (e) { console.warn('[skill-files] removeSkillDir failed:', (e as Error).message) }
}

export function readSkillResource(id: string, relPath: string): string {
  return readSkillResourceAt(skillDir(id), relPath)
}

/** Read a bundle-relative file under an arbitrary base dir (same traversal guard
 *  + size cap as readSkillResource). Used by ephemeral 工作目录 skills, whose
 *  bundle lives at its original on-disk path rather than under userData/skills. */
export function readSkillResourceAt(baseDir: string, relPath: string): string {
  const abs = safeJoin(baseDir, relPath)
  const stat = fs.statSync(abs)
  if (!stat.isFile()) throw new Error('不是文件')
  if (stat.size > MAX_READ_SIZE) throw new Error(`文件过大 (${(stat.size / 1024).toFixed(0)} KB)`)
  return fs.readFileSync(abs, 'utf8')
}

/** List bundle-relative (posix) file paths under `dir`, enforcing the same
 *  count/size caps as an import. Used to populate an ephemeral skill's
 *  resourceFiles without copying anything. Returns [] on any failure. */
export function listBundleFiles(dir: string): string[] {
  try { return listLocalBundleFiles(dir).files }
  catch { return [] }
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
