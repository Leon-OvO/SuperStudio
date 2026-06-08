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
import { randomUUID } from 'crypto'

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
  return { path: relPosix, original, modified, patch, hunkCount: countHunks(patch), binary }
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

/** Revert one hunk in the working tree (reverse-apply against HEAD diff). */
export async function revertHunk(root: string, rel: string, hunkIndex: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const fileDiff = await git(root).diff(['HEAD', '--', rel.replace(/\\/g, '/')])
    const patch = buildHunkPatch(fileDiff, hunkIndex)
    if (!patch) return { ok: false, error: '未找到该改动块' }
    await applyPatchString(root, patch, ['-R'])
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/** Stage one hunk into the index (apply --cached against HEAD diff). */
export async function stageHunk(root: string, rel: string, hunkIndex: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const fileDiff = await git(root).diff(['HEAD', '--', rel.replace(/\\/g, '/')])
    const patch = buildHunkPatch(fileDiff, hunkIndex)
    if (!patch) return { ok: false, error: '未找到该改动块' }
    await applyPatchString(root, patch, ['--cached'])
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
  try {
    if (!(await isRepo(root))) return null
    const tmpIndex = path.join(os.tmpdir(), `vibe-index-${randomUUID()}`)
    const g = simpleGit(root).env(safeGitEnv({ ...FALLBACK_ENV, GIT_INDEX_FILE: tmpIndex }))
    // Seed the temp index from HEAD when it exists (so unchanged tracked files
    // carry over), then stage everything (incl. untracked) on top.
    const head = await g.revparse(['HEAD']).then(s => s.trim()).catch(() => '')
    if (head) await g.raw(['read-tree', 'HEAD']).catch(() => {})
    await g.raw(['add', '-A'])
    const tree = (await g.raw(['write-tree'])).trim()
    const args = head
      ? ['commit-tree', tree, '-p', head, '-m', 'vibe-checkpoint']
      : ['commit-tree', tree, '-m', 'vibe-checkpoint']
    const id = (await g.raw(args)).trim()
    try { fs.unlinkSync(tmpIndex) } catch { /* ignore */ }
    // Protect the snapshot from GC + allow post-restart rollback.
    await git(root).raw(['update-ref', CHECKPOINT_REF, id]).catch(() => {})
    const ts = await currentTs(root)
    const rec = { id, ts }
    checkpoints.set(norm(root), rec)
    return rec
  } catch (e) {
    console.warn('[git] createCheckpoint failed:', (e as Error).message)
    return null
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
    const g = git(root)
    // 1. Restore tracked + staged state to the snapshot. Files that existed in
    //    the snapshot (incl. ones that were untracked when snapshotted) get
    //    written back AND staged, so they become tracked.
    await g.raw(['restore', '--staged', '--worktree', '--source', target, '--', '.'])
    // 2. Delete files created AFTER the snapshot:
    //    2a. staged/tracked adds — `git diff` reports these as Added vs snapshot;
    //    2b. untracked files — anything still untracked can't have been in the
    //        snapshot (those got staged in step 1), so it was created after.
    const trackedAdded = (await g.raw(['diff', '--diff-filter=A', '--name-only', target, '--']))
      .split('\n').map(s => s.trim()).filter(Boolean)
    const untracked = (await g.raw(['ls-files', '--others', '--exclude-standard']))
      .split('\n').map(s => s.trim()).filter(Boolean)
    for (const f of new Set([...trackedAdded, ...untracked])) {
      try { fs.unlinkSync(path.join(root, f)) } catch { /* ignore */ }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function readCheckpointRef(root: string): Promise<string> {
  try { return (await git(root).raw(['rev-parse', CHECKPOINT_REF])).trim() }
  catch { return '' }
}
