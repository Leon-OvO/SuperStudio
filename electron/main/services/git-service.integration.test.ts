/**
 * Integration tests that exercise the REAL git binary against throwaway repos.
 * Self-skips when git isn't installed so CI on a git-less box stays green.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  gitAvailable, gitInit, gitStatus, gitDiffFile, revertFile,
  createCheckpoint, rollbackToCheckpoint, revertHunk, commit,
} from './git-service'

const HAS_GIT = await gitAvailable()
const tmpDirs: string[] = []

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-git-'))
  tmpDirs.push(dir)
  return dir
}
const w = (dir: string, rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content, 'utf8')
// Normalize CRLF → LF: on Windows git's core.autocrlf rewrites line endings on
// checkout/restore, which is orthogonal to what we're testing here.
const r = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n')

afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

describe.skipIf(!HAS_GIT)('git-service integration', () => {
  it('init creates a repo with HEAD', async () => {
    const dir = mkRepo()
    const res = await gitInit(dir)
    expect(res.ok).toBe(true)
    const st = await gitStatus(dir)
    expect(st.gitAvailable).toBe(true)
    expect(st.isRepo).toBe(true)
  })

  it('status + diff reflect working-tree changes', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    w(dir, 'a.txt', 'v1\n')
    await commit(dir, 'add a')
    w(dir, 'a.txt', 'v2\n')      // modify tracked
    w(dir, 'b.txt', 'new\n')     // add untracked

    const st = await gitStatus(dir)
    const paths = st.files.map(f => f.path)
    expect(paths).toContain('a.txt')
    expect(paths).toContain('b.txt')
    expect(st.files.find(f => f.path === 'a.txt')?.kind).toBe('M')
    expect(st.files.find(f => f.path === 'b.txt')?.kind).toBe('?')

    const diff = await gitDiffFile(dir, 'a.txt')
    expect(diff.original).toBe('v1\n')
    expect(diff.modified).toBe('v2\n')
    expect(diff.hunkCount).toBeGreaterThanOrEqual(1)
  })

  it('revertFile discards modification (tracked) and deletes untracked', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    w(dir, 'a.txt', 'orig\n')
    await commit(dir, 'add a')
    w(dir, 'a.txt', 'edited\n')
    w(dir, 'b.txt', 'junk\n')

    await revertFile(dir, 'a.txt')
    expect(r(dir, 'a.txt')).toBe('orig\n')

    await revertFile(dir, 'b.txt')
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false)
  })

  it('checkpoint + rollback restores worktree and removes files added after', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    w(dir, 'a.txt', 'v1\n')
    await commit(dir, 'add a')

    // AI run #1 lands these, then we checkpoint that state.
    w(dir, 'a.txt', 'v2\n')
    w(dir, 'b.txt', 'b-content\n')
    const cp = await createCheckpoint(dir)
    expect(cp).not.toBeNull()

    // AI run #2 keeps going past the checkpoint.
    w(dir, 'a.txt', 'v3-bad\n')
    w(dir, 'c.txt', 'c-content\n')

    const res = await rollbackToCheckpoint(dir, cp!.id)
    expect(res.ok).toBe(true)
    expect(r(dir, 'a.txt')).toBe('v2\n')                       // restored to checkpoint
    expect(r(dir, 'b.txt')).toBe('b-content\n')                // in checkpoint → kept
    expect(fs.existsSync(path.join(dir, 'c.txt'))).toBe(false) // added after → removed
  })

  it('revertHunk reverts only the targeted hunk', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    // 14 lines; edits on line 2 and line 13 stay >6 apart so git's 3-line
    // context doesn't merge them into one hunk.
    const base = Array.from({ length: 14 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    w(dir, 'a.txt', base)
    await commit(dir, 'add a')
    const edited = base.replace('l2\n', 'l2-CHANGED\n').replace('l13\n', 'l13-CHANGED\n')
    w(dir, 'a.txt', edited)

    const before = await gitDiffFile(dir, 'a.txt')
    expect(before.hunkCount).toBe(2)

    await revertHunk(dir, 'a.txt', 0)  // revert the first edit only
    const txt = r(dir, 'a.txt')
    expect(txt).toContain('l2\n')           // first edit reverted
    expect(txt).not.toContain('l2-CHANGED') // …confirmed gone
    expect(txt).toContain('l13-CHANGED')    // second edit preserved
  })
})
