/**
 * Git integration for the Vibe / Build page — the "trust" layer that lets users
 * review, accept, revert, and roll back the AI's file changes.
 *
 * Design (see plan):
 *  - The agent writes to disk as normal (so the parallel apply loop + code_bash
 *    keep working). git is the *review/staging* layer, applied AFTER the run.
 *  - Before each writing run we take a CHECKPOINT (full worktree incl. untracked,
 *    captured without disturbing the tree) so "roll back to before this run" can
 *    undo everything — even files the AI newly created and the user's own
 *    pre-run uncommitted edits.
 *  - Hunk-level revert/stage operate on the per-file `git diff HEAD` so the UI's
 *    hunk list and the server's slicing stay aligned.
 *
 * Everything feature-detects `git`: on a machine without git installed, all
 * calls degrade gracefully (the code tools are unaffected).
 */

import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash, randomUUID } from 'crypto'

// Neutral, flavor-agnostic identity used ONLY as a fallback when the user has no
// git identity configured — so checkpoint/commit don't fail on a fresh machine.
// Deliberately does NOT leak the SuperStudio / DWork brand into the user's log.
const FALLBACK_ENV = {
  GIT_AUTHOR_NAME: 'AI Build Agent',
  GIT_AUTHOR_EMAIL: 'agent@localhost',
  GIT_COMMITTER_NAME: 'AI Build Agent',
  GIT_COMMITTER_EMAIL: 'agent@localhost',
}

const CHECKPOINT_REF = 'refs/vibe/checkpoint-latest'

// ---------------------------------------------------------------------------
// Types (shared shape mirrored in src/shared/ipc-types.ts)
// ---------------------------------------------------------------------------

export interface GitFileChange {
  /** POSIX-relative path inside the project. */
  path: string
  /** Porcelain index (staged) status char: ' ' M A D R C U ?. */
  index: string
  /** Porcelain working-tree status char. */
  working: string
  /** Single convenience kind for the UI: M(odified) A(dded) D(eleted) R(enamed) ?(untracked). */
  kind: 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | '?'
  /** True when staged in the index (index char is meaningful and not ' '/'?'). */
  staged: boolean
}

export interface GitStatus {
  gitAvailable: boolean
  isRepo: boolean
  root: string
  files: GitFileChange[]
  /** A checkpoint exists for this project → "roll back to before AI changes" is offered. */
  hasCheckpoint: boolean
}

export interface GitDiff {
  path: string
  /** File content at HEAD ('' for a newly-added/untracked file). */
  original: string
  /** Working-tree content ('' for a deleted file). */
  modified: string
  /** Unified `git diff HEAD -- <file>` patch. */
  patch: string
  /** Number of hunks in `patch` (for hunk-level controls). */
  hunkCount: number
  /** True when git couldn't text-diff it (binary). */
  binary: boolean
  /** 每个改动块的内容指纹，顺序与 patch 里的块一致；点块时用它重新定位。 */
  hunkFingerprints: string[]
}

export interface GitCommitInfo { hash: string; message: string; date: string; author: string }

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

let _gitAvailable: boolean | null = null

/** Whether the `git` binary is usable. Cached after first probe. */
export async function gitAvailable(): Promise<boolean> {
  if (_gitAvailable != null) return _gitAvailable
  try {
    await simpleGit(os.tmpdir()).raw(['--version'])
    _gitAvailable = true
  } catch {
    _gitAvailable = false
  }
  return _gitAvailable
}

/** Whether `root` is inside a git work tree. */
export async function isRepo(root: string): Promise<boolean> {
  if (!(await gitAvailable())) return false
  try {
    return await simpleGit(root).checkIsRepo()
  } catch {
    return false
  }
}

// simple-git's "unsafe" plugin refuses to let editor/pager/ssh/GIT_* env vars
// through `.env()` (EDITOR, VISUAL, PAGER, SSH_ASKPASS, GIT_EDITOR, GIT_SSH,
// GIT_EXTERNAL_DIFF, GIT_CONFIG*, …). Since `.env()` REPLACES the whole child
// env, we keep the ambient env minus that family and re-add only what we need
// (PATH etc. survive; the GIT_* identity / index vars come back via `extra`).
function safeGitEnv(extra: Record<string, string>): Record<string, string> {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    const up = k.toUpperCase()
    if (up.startsWith('GIT_')) continue
    if (up === 'EDITOR' || up === 'VISUAL' || up === 'PAGER') continue
    if (up.endsWith('EDITOR') || up.endsWith('PAGER') || up.includes('SSH')) continue
    e[k] = v
  }
  return { ...e, ...extra }
}

// Plain client — inherits the ambient process.env. The unsafe plugin only guards
// env we pass explicitly via `.env()`, so an ambient GIT_EDITOR etc. is harmless.
function git(root: string): SimpleGit {
  return simpleGit(root)
}

// ---------------------------------------------------------------------------
// 快照/回滚专用的 git 配置覆盖
// ---------------------------------------------------------------------------

/**
 * 快照(capture)与还原(restore)全程强制的 git 配置。
 *
 * 用户机器上的 git 配置会直接改变快照往返的字节内容 —— Windows 版 git 安装器
 * 默认写死 `core.autocrlf=true`，于是「拍快照 → 回滚」会把 LF 文件整篇改写成
 * CRLF：满屏假 diff，`.sh` / `.py` 之类还可能直接跑不起来。`core.quotepath`
 * 默认 true 会让文件清单里的中文名变成八进制转义串，回滚删不掉 AI 新建的
 * 中文名文件。
 *
 * 硬约束：capture 与 restore 必须用同一套 —— 只改一半会让往返在两端用不同的
 * 规则转换，比完全不改更糟。所有参与快照的 raw 调用一律走 snapshotRaw()。
 */
const SNAPSHOT_GIT_CONFIG: readonly string[] = [
  '-c', 'core.autocrlf=false',  // 行尾原样进出，快照往返字节不变
  '-c', 'core.longpaths=true',  // Windows 上超过 260 字符的路径也能纳入快照
  '-c', 'core.symlinks=true',   // 符号链接按符号链接存取，不退化成写着目标路径的普通文件
  '-c', 'core.quotepath=false', // 中文/非 ASCII 文件名原样输出，不返回 \344\270\255 这种转义串
  '-c', 'core.fsmonitor=false', // 不依赖外部文件监视器，避免其缓存让快照漏文件
]

/**
 * 快照专用客户端。
 *
 * simple-git 默认拦截一切对 `core.fsmonitor` 的赋值（防止被诱导去执行外部
 * 程序）。我们传的值写死是 `false`，是**关掉**而不是启用监视器进程，还能顺带
 * 压过仓库里可能存在的 fsmonitor 配置，比不传更安全，因此显式放行这一项。
 */
function snapshotGit(root: string, extraEnv?: Record<string, string>): SimpleGit {
  const g = simpleGit(root, { unsafe: { allowUnsafeFsMonitor: true } })
  return extraEnv ? g.env(safeGitEnv(extraEnv)) : g
}

/** 带上 SNAPSHOT_GIT_CONFIG 执行一条 raw 命令。数组参数不过 shell，`-c k=v` 安全。 */
function snapshotRaw(g: SimpleGit, args: string[]): Promise<string> {
  return g.raw([...SNAPSHOT_GIT_CONFIG, ...args])
}

/** `-z` 输出（NUL 分隔）拆成路径列表。不做 trim —— 文件名首尾的空格是合法的。 */
function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/** Initialise a repo with an initial commit so HEAD exists (diffs need it). */
export async function gitInit(root: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await gitAvailable())) return { ok: false, error: 'git 未安装' }
  try {
    const g = git(root)
    await g.init()
    await ensureIdentity(g)
    await g.add('-A')
    await g.raw(['commit', '--allow-empty', '-m', 'Initial commit'])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function ensureIdentity(g: SimpleGit): Promise<void> {
  try {
    const name = (await g.raw(['config', 'user.name']).catch(() => '')).trim()
    if (!name) await g.addConfig('user.name', FALLBACK_ENV.GIT_AUTHOR_NAME)
  } catch { /* best-effort */ }
  try {
    const email = (await g.raw(['config', 'user.email']).catch(() => '')).trim()
    if (!email) await g.addConfig('user.email', FALLBACK_ENV.GIT_AUTHOR_EMAIL)
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Status / diff
// ---------------------------------------------------------------------------

function deriveKind(index: string, working: string): GitFileChange['kind'] {
  if (index === '?' || working === '?') return '?'
  const c = working !== ' ' && working !== '' ? working : index
  if (c === 'A') return 'A'
  if (c === 'D') return 'D'
  if (c === 'R') return 'R'
  if (c === 'C') return 'C'
  if (c === 'U') return 'U'
  return 'M'
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const base: GitStatus = { gitAvailable: false, isRepo: false, root, files: [], hasCheckpoint: hasCheckpoint(root) }
  if (!(await gitAvailable())) return base
  base.gitAvailable = true
  if (!(await isRepo(root))) return base
  base.isRepo = true
  try {
    const s: StatusResult = await git(root).status()
    base.files = s.files.map(f => {
      const index = f.index || ' '
      const working = f.working_dir || ' '
      return {
        path: f.path.replace(/\\/g, '/'),
        index,
        working,
        kind: deriveKind(index, working),
        staged: index !== ' ' && index !== '?',
      }
    })
  } catch (e) {
    console.warn('[git] status failed:', (e as Error).message)
  }
  return base
}

export async function gitDiffFile(root: string, rel: string): Promise<GitDiff> {
  const relPosix = rel.replace(/\\/g, '/')
  const abs = path.join(root, rel)
  let modified = ''
  try { modified = fs.readFileSync(abs, 'utf8') } catch { modified = '' }
  let original = ''
  let patch = ''
  let binary = false
  if (await isRepo(root)) {
    const g = git(root)
    try { original = await g.show([`HEAD:${relPosix}`]) } catch { original = '' }
    try { patch = await g.diff(['HEAD', '--', relPosix]) } catch { patch = '' }
    if (/^Binary files /m.test(patch) || patch.includes('GIT binary patch')) binary = true
  }
  // 记下这次给出去的每块指纹：用户之后点「还原块 N」时按指纹重新定位，
  // 而不是按下标（下标会因为文件被改而指到别的块上）。
  const fps = hunkFingerprints(patch)
  rememberServedHunks(root, relPosix, fps)
  return {
    path: relPosix, original, modified, patch,
    hunkCount: fps.length, binary, hunkFingerprints: fps,
  }
}

export async function gitLog(root: string, n = 20): Promise<GitCommitInfo[]> {
  if (!(await isRepo(root))) return []
  try {
    const log = await git(root).log({ maxCount: n })
    return log.all.map(c => ({ hash: c.hash.slice(0, 8), message: c.message, date: c.date, author: c.author_name }))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Stage / unstage / revert / commit (file level)
// ---------------------------------------------------------------------------

export async function stageFile(root: string, rel: string): Promise<{ ok: boolean; error?: string }> {
  try { await git(root).add([rel]); return { ok: true } }
  catch (e) { return { ok: false, error: (e as Error).message } }
}

export async function unstageFile(root: string, rel: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // `restore --staged` un-stages; for files with no HEAD entry fall back to `reset`.
    await git(root).raw(['restore', '--staged', '--', rel])
    return { ok: true }
  } catch {
    try { await git(root).raw(['reset', '--', rel]); return { ok: true } }
    catch (e) { return { ok: false, error: (e as Error).message } }
  }
}

/** Discard a file's working-tree changes. Untracked files are deleted. */
export async function revertFile(root: string, rel: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const g = git(root)
    // Is it tracked at HEAD? If `ls-files --error-unmatch` succeeds → tracked.
    const tracked = await g.raw(['ls-files', '--error-unmatch', '--', rel]).then(() => true).catch(() => false)
    if (tracked) {
      await g.raw(['restore', '--staged', '--worktree', '--source=HEAD', '--', rel])
    } else {
      // Untracked (AI-created new file) → remove from disk.
      try { fs.unlinkSync(path.join(root, rel)) } catch { /* may already be gone */ }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export async function commit(root: string, message: string, paths?: string[]): Promise<{ ok: boolean; error?: string; hash?: string }> {
  try {
    const g = git(root)
    await ensureIdentity(g)
    if (paths && paths.length) {
      await g.add(paths)
    } else {
      // Respect a user's selective staging: only auto-stage everything when the
      // index is empty, otherwise commit exactly what they staged.
      const staged = (await g.diff(['--cached', '--name-only'])).trim()
      if (!staged) await g.add('-A')
    }
    await g.raw(['commit', '-m', message])
    const hash = (await g.revparse(['HEAD'])).trim()
    return { ok: true, hash }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Hunk-level revert / stage
// ---------------------------------------------------------------------------

/** Split a single-file `git diff` into its header and per-hunk blocks.
 *  Pure + exported for unit tests. */
export function splitFileDiff(fileDiff: string): { header: string; hunks: string[] } {
  if (!fileDiff.trim()) return { header: '', hunks: [] }
  const lines = fileDiff.split('\n')
  const firstHunk = lines.findIndex(l => l.startsWith('@@'))
  if (firstHunk < 0) return { header: fileDiff, hunks: [] }
  const header = lines.slice(0, firstHunk).join('\n')
  const hunks: string[] = []
  let cur: string[] = []
  for (let i = firstHunk; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('@@')) {
      if (cur.length) hunks.push(cur.join('\n'))
      cur = [l]
    } else {
      cur.push(l)
    }
  }
  if (cur.length) hunks.push(cur.join('\n'))
  return { header, hunks }
}

export function countHunks(fileDiff: string): number {
  return splitFileDiff(fileDiff).hunks.length
}

/**
 * 改动块指纹：`@@` 头（**丢掉起始行号、只留行数**）+ 整块正文的 sha1 前 12 位。
 *
 * 丢掉起始行号，是为了让「前面的块变长/变短导致本块整体位移」仍然认得出是同一
 * 块；正文全量入哈希，是为了让内容只要动一个字符就判定成另一块。
 */
export function hunkFingerprint(hunkText: string): string {
  const lines = hunkText.split('\n')
  const head = lines[0] ?? ''
  const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/.exec(head)
  const normalizedHead = m ? `@@ -,${m[1] ?? '1'} +,${m[2] ?? '1'} @@${m[3] ?? ''}` : head
  const body = [normalizedHead, ...lines.slice(1)].join('\n')
  return createHash('sha1').update(body, 'utf8').digest('hex').slice(0, 12)
}

/** 一份 diff 里每个改动块的指纹，顺序与 splitFileDiff().hunks 一致。 */
export function hunkFingerprints(fileDiff: string): string[] {
  return splitFileDiff(fileDiff).hunks.map(hunkFingerprint)
}

// ---------------------------------------------------------------------------
// 「已展示给用户的改动块」台账
// ---------------------------------------------------------------------------

/**
 * 渲染层的 diff 刷新是防抖的，用户点「还原块 2」时点的是我们**上一次返回给它的
 * 那份 diff** 里的第 2 块。如果这中间用户或 agent 又改了同一个文件，最新 diff 的
 * 第 2 块很可能已经换成了别的内容，按下标直接 `git apply -R` 会静默撤销错误的
 * 改动块（上下文碰巧对得上时连报错都没有）。
 *
 * 因此 gitDiffFile 每次都记下「这次给出去的每块指纹」，点击时先按指纹到最新
 * diff 里重新定位。找不到就报「已变化，请刷新后重试」——**绝不回退到裸下标**。
 */
const servedHunks = new Map<string, string[]>()
/** 台账上限，超出按最久未用淘汰（Map 的插入顺序即 LRU 顺序）。 */
const SERVED_HUNKS_MAX = 200
/** 改动块已漂移时统一的中文提示。 */
const HUNK_STALE_ERROR = '该改动块已变化，请刷新后重试'

function servedKey(root: string, relPosix: string): string {
  return `${norm(root)} ${relPosix}`
}

function rememberServedHunks(root: string, relPosix: string, fps: string[]): void {
  const key = servedKey(root, relPosix)
  servedHunks.delete(key)
  servedHunks.set(key, fps)
  while (servedHunks.size > SERVED_HUNKS_MAX) {
    const oldest = servedHunks.keys().next().value
    if (oldest === undefined) break
    servedHunks.delete(oldest)
  }
}

/** 仅供测试：清空台账，模拟「主进程重启后没有任何已展示记录」。 */
export function _resetServedHunks(): void {
  servedHunks.clear()
}

/**
 * 把「用户点的第 N 块」翻译成最新 diff 里的真实块，并生成可应用的补丁。
 * expected 为调用方直接给出的指纹（IPC 以后透传时用），否则查台账。
 */
function resolveHunkPatch(
  root: string, relPosix: string, fileDiff: string, hunkIndex: number, expected?: string
): { patch: string } | { error: string } {
  const want = expected || servedHunks.get(servedKey(root, relPosix))?.[hunkIndex]
  // 没有指纹可比 = 我们从没把这份 diff 给出去过（或已被淘汰）。此时唯一安全的
  // 做法是让用户刷新，绝不按下标猜。
  if (!want) return { error: HUNK_STALE_ERROR }
  const idx = splitFileDiff(fileDiff).hunks.findIndex(h => hunkFingerprint(h) === want)
  if (idx < 0) return { error: HUNK_STALE_ERROR }
  const patch = buildHunkPatch(fileDiff, idx)
  if (!patch) return { error: HUNK_STALE_ERROR }
  return { patch }
}

/** Build a minimal, applyable patch for a single hunk (header + one @@ block). */
export function buildHunkPatch(fileDiff: string, hunkIndex: number): string | null {
  const { header, hunks } = splitFileDiff(fileDiff)
  if (hunkIndex < 0 || hunkIndex >= hunks.length) return null
  let body = hunks[hunkIndex]
  if (!body.endsWith('\n')) body += '\n'
  return `${header}\n${body}`
}

async function applyPatchString(root: string, patch: string, extraArgs: string[]): Promise<void> {
  const tmp = path.join(os.tmpdir(), `vibe-patch-${randomUUID()}.diff`)
  fs.writeFileSync(tmp, patch, 'utf8')
  try {
    await git(root).raw(['apply', '--whitespace=nowarn', ...extraArgs, tmp])
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/** Revert one hunk in the working tree (reverse-apply against HEAD diff).
 *  hunkIndex 是「上一次展示给用户的那份 diff」里的下标，服务端按指纹重新定位。 */
export async function revertHunk(
  root: string, rel: string, hunkIndex: number, expectedFingerprint?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const relPosix = rel.replace(/\\/g, '/')
    const fileDiff = await git(root).diff(['HEAD', '--', relPosix])
    const located = resolveHunkPatch(root, relPosix, fileDiff, hunkIndex, expectedFingerprint)
    if ('error' in located) return { ok: false, error: located.error }
    await applyPatchString(root, located.patch, ['-R'])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Stage one hunk into the index (apply --cached against HEAD diff). */
export async function stageHunk(
  root: string, rel: string, hunkIndex: number, expectedFingerprint?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const relPosix = rel.replace(/\\/g, '/')
    const fileDiff = await git(root).diff(['HEAD', '--', relPosix])
    const located = resolveHunkPatch(root, relPosix, fileDiff, hunkIndex, expectedFingerprint)
    if ('error' in located) return { ok: false, error: located.error }
    await applyPatchString(root, located.patch, ['--cached'])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---------------------------------------------------------------------------
// Checkpoint / rollback
// ---------------------------------------------------------------------------

// Latest checkpoint per project root (in-memory; also persisted to a git ref so
// it survives a restart and isn't garbage-collected).
const checkpoints = new Map<string, { id: string; ts: number }>()

function norm(root: string): string { return path.resolve(root) }

export function hasCheckpoint(root: string): boolean {
  return checkpoints.has(norm(root))
}

export function getLatestCheckpoint(root: string): { id: string; ts: number } | null {
  return checkpoints.get(norm(root)) ?? null
}

/**
 * Snapshot the FULL worktree (including untracked files) without touching it,
 * via a throwaway index + commit-tree. Returns the snapshot commit SHA, or null
 * when not a repo / git missing (caller treats as "no checkpoint"). Best-effort:
 * never throws.
 */
export async function createCheckpoint(root: string): Promise<{ id: string; ts: number } | null> {
  const tmpIndex = path.join(os.tmpdir(), `vibe-index-${randomUUID()}`)
  try {
    if (!(await isRepo(root))) return null
    const g = snapshotGit(root, { ...FALLBACK_ENV, GIT_INDEX_FILE: tmpIndex })
    // Seed the temp index from HEAD when it exists (so unchanged tracked files
    // carry over), then stage everything (incl. untracked) on top.
    const head = await snapshotRaw(g, ['rev-parse', 'HEAD']).then(s => s.trim()).catch(() => '')
    if (head) await snapshotRaw(g, ['read-tree', 'HEAD']).catch(() => {})
    await snapshotRaw(g, ['add', '-A'])
    const tree = (await snapshotRaw(g, ['write-tree'])).trim()
    const args = head
      ? ['commit-tree', tree, '-p', head, '-m', 'vibe-checkpoint']
      : ['commit-tree', tree, '-m', 'vibe-checkpoint']
    const id = (await snapshotRaw(g, args)).trim()
    // Protect the snapshot from GC + allow post-restart rollback.
    await snapshotRaw(snapshotGit(root), ['update-ref', CHECKPOINT_REF, id]).catch(() => {})
    const ts = await currentTs(root)
    const rec = { id, ts }
    checkpoints.set(norm(root), rec)
    return rec
  } catch (e) {
    console.warn('[git] createCheckpoint failed:', (e as Error).message)
    return null
  } finally {
    // 临时 index 与它的锁文件必须无条件清理：write-tree 抛异常时旧代码会把这两个
    // 文件永久留在临时目录里（每次失败泄漏一份）。
    cleanupTmpIndex(tmpIndex)
  }
}

/** 删除一次性 index 及其 `.lock`（git 中途失败时锁文件会留下）。 */
function cleanupTmpIndex(tmpIndex: string): void {
  for (const p of [tmpIndex, `${tmpIndex}.lock`]) {
    try { fs.unlinkSync(p) } catch { /* 不存在或被占用，尽力而为 */ }
  }
}

// We can't use Date.now() freely in some sandboxes; derive a monotonic-ish ts
// from git itself (commit count) as a stable, restart-safe ordinal fallback.
async function currentTs(root: string): Promise<number> {
  try {
    const n = (await git(root).raw(['rev-list', '--count', 'HEAD'])).trim()
    return parseInt(n, 10) || 0
  } catch {
    return 0
  }
}

/**
 * Roll the worktree back to a checkpoint: restore tracked files to the snapshot
 * AND delete files the run newly added (which aren't in the snapshot tree).
 */
export async function rollbackToCheckpoint(root: string, id?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!(await isRepo(root))) return { ok: false, error: '不是 git 仓库' }
    const target = id || checkpoints.get(norm(root))?.id || await readCheckpointRef(root)
    if (!target) return { ok: false, error: '没有可回滚的快照' }
    // 与 createCheckpoint 用同一套配置覆盖：行尾不改写、中文名不转义。
    const g = snapshotGit(root)
    // 1. Restore tracked + staged state to the snapshot. Files that existed in
    //    the snapshot (incl. ones that were untracked when snapshotted) get
    //    written back AND staged, so they become tracked.
    await snapshotRaw(g, ['restore', '--staged', '--worktree', '--source', target, '--', '.'])
    // 2. Delete files created AFTER the snapshot:
    //    2a. staged/tracked adds — `git diff` reports these as Added vs snapshot;
    //    2b. untracked files — anything still untracked can't have been in the
    //        snapshot (those got staged in step 1), so it was created after.
    //    `-z` 让文件名以 NUL 分隔原样输出，配合 quotepath=false 拿到的就是真实
    //    路径，中文名文件才删得掉。
    const trackedAdded = splitZ(await snapshotRaw(g, ['diff', '--diff-filter=A', '--name-only', '-z', target, '--']))
    const untracked = splitZ(await snapshotRaw(g, ['ls-files', '--others', '--exclude-standard', '-z']))
    const stuck: string[] = []
    for (const f of new Set([...trackedAdded, ...untracked])) {
      const abs = path.join(root, f)
      // 必须用 unlinkSync：Windows 上 fs.rmSync(path, { force: true }) 对含非 ASCII
      // 字符的文件名会「不报错也不删」，正是中文名文件删不掉的第二个坑。
      try { fs.unlinkSync(abs) } catch { /* 下面统一核对是否真的没了 */ }
      if (fs.existsSync(abs)) stuck.push(f)
    }
    if (stuck.length) console.warn('[git] rollback 未能删除的新增文件:', stuck.join(', '))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function readCheckpointRef(root: string): Promise<string> {
  try { return (await git(root).raw(['rev-parse', CHECKPOINT_REF])).trim() }
  catch { return '' }
}

/**
 * Per-task revert: restore ONLY the given files to a checkpoint, leaving every
 * other file (other tasks' work) untouched. A file that existed in the snapshot
 * is restored to it; a file the task newly created (absent from the snapshot) is
 * deleted. `files` are repo-relative paths.
 */
export async function restoreFilesToCheckpoint(
  root: string, files: string[], checkpointId?: string
): Promise<{ ok: boolean; error?: string; reverted?: number }> {
  try {
    if (!(await isRepo(root))) return { ok: false, error: '不是 git 仓库' }
    const target = checkpointId || checkpoints.get(norm(root))?.id || await readCheckpointRef(root)
    if (!target) return { ok: false, error: '没有可用的快照' }
    // 同样走快照配置：与 createCheckpoint / rollbackToCheckpoint 保持一致。
    const g = snapshotGit(root)
    const rels = [...new Set(files.map(f => f.replace(/\\/g, '/').trim()).filter(Boolean))]
    let reverted = 0
    for (const rel of rels) {
      const existed = await snapshotRaw(g, ['cat-file', '-e', `${target}:${rel}`]).then(() => true).catch(() => false)
      if (existed) {
        await snapshotRaw(g, ['restore', '--staged', '--worktree', '--source', target, '--', rel]).catch(() => {})
      } else {
        // 同上：中文名文件只有 unlinkSync 删得掉。
        try { fs.unlinkSync(path.join(root, rel)) } catch { /* already gone */ }
      }
      reverted++
    }
    return { ok: true, reverted }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
