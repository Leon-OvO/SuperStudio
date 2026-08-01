/**
 * Integration tests that exercise the REAL git binary against throwaway repos.
 * Self-skips when git isn't installed so CI on a git-less box stays green.
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  gitAvailable, gitInit, gitStatus, gitDiffFile, revertFile,
  createCheckpoint, rollbackToCheckpoint, revertHunk, commit,
  buildHunkPatch, _resetServedHunks,
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
/** 逐字节读取，不做任何行尾归一 —— 快照往返测试就是要盯字节。 */
const rawBytes = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel))
/** 在测试仓里跑一条 git 命令（不带任何配置覆盖，用来做「不修就会红」的对照）。 */
const plainGit = (dir: string, args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

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

  it('autocrlf=true 的仓库里，LF 文件走快照往返后字节完全不变', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    // 复现 Windows 版 git 安装器的装机默认（本机 gitconfig 实测就是 true）。
    // 显式写进仓库配置，这条测试在任何机器上都成立。
    plainGit(dir, ['config', 'core.autocrlf', 'true'])

    const LF = 'a\nb\nc\n'
    // 对照：不带配置覆盖时 git 往工作区写文件就会把 LF 换成 CRLF ——
    // 这正是「不修就会红」的根因，顺带保证这条测试没有在空转。
    w(dir, 'probe.txt', LF)
    plainGit(dir, ['add', '--', 'probe.txt'])
    plainGit(dir, ['commit', '-qm', 'probe'])
    fs.rmSync(path.join(dir, 'probe.txt'))
    plainGit(dir, ['checkout', '--', 'probe.txt'])
    expect(rawBytes(dir, 'probe.txt').includes(Buffer.from('\r\n'))).toBe(true)

    w(dir, 'run.sh', LF)
    await commit(dir, 'add run.sh')
    w(dir, 'run.sh', LF + 'd\n')
    const cp = await createCheckpoint(dir)
    expect(cp).not.toBeNull()

    // 真正的往返：快照 → 乱改 → 回滚，字节必须与快照时一模一样。
    w(dir, 'run.sh', 'wrecked\n')
    const res = await rollbackToCheckpoint(dir, cp!.id)
    expect(res.ok).toBe(true)
    expect(rawBytes(dir, 'run.sh')).toEqual(Buffer.from(LF + 'd\n', 'utf8'))
  })

  it('回滚会删掉快照之后新增的中文名未跟踪文件', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    w(dir, 'a.txt', 'v1\n')
    await commit(dir, 'add a')
    const cp = await createCheckpoint(dir)
    expect(cp).not.toBeNull()

    // AI 生成的中文名新文件（快照之后才出现）。
    const cn = '产品说明 文档.txt'
    w(dir, cn, '内容\n')
    // 对照：默认 core.quotepath=true 时文件清单是八进制转义串，拿它去删必然删不掉。
    expect(plainGit(dir, ['ls-files', '--others', '--exclude-standard'])).toContain('\\344')

    const res = await rollbackToCheckpoint(dir, cp!.id)
    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(dir, cn))).toBe(false)
  })

  it('createCheckpoint 失败时不留下临时 index（清理在 finally 里）', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    w(dir, 'a.txt', 'v1\n')
    await commit(dir, 'add a')
    // 把当前分支指向一个不存在的对象：rev-parse 仍给出 sha、read-tree 失败(被吞)、
    // add -A 会把临时 index 写到盘上，最后 commit-tree 抛异常 —— 正是泄漏那条路径。
    const ref = plainGit(dir, ['symbolic-ref', 'HEAD']).trim()
    fs.writeFileSync(path.join(dir, '.git', ...ref.split('/')), `${'a'.repeat(40)}\n`, 'utf8')

    const leftovers = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vibe-index-'))
    const before = new Set(leftovers())
    const cp = await createCheckpoint(dir)
    expect(cp).toBeNull()
    expect(leftovers().filter(n => !before.has(n))).toEqual([])
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

  it('文件在刷新与点击之间被改过时，按指纹定位到正确的改动块', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    const base = Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    w(dir, 'a.txt', base)
    await commit(dir, 'add a')

    // 界面上展示的是这份 diff：块0=l2、块1=l18。
    const shown = base.replace('l2\n', 'l2-CHANGED\n').replace('l18\n', 'l18-CHANGED\n')
    w(dir, 'a.txt', shown)
    const served = await gitDiffFile(dir, 'a.txt')
    expect(served.hunkCount).toBe(2)

    // 刷新是防抖的：用户点「块1」之前，agent 又在中间插了一处改动，
    // 最新 diff 变成 块0=l2、块1=l10、块2=l18 —— 裸下标 1 会指到 l10 上。
    const drifted = shown.replace('l10\n', 'l10-CHANGED\n')
    w(dir, 'a.txt', drifted)
    const fresh = await gitDiffFile(dir, 'a.txt')
    expect(fresh.hunkCount).toBe(3)
    // 对照：按下标取到的是错的那一块。
    expect(buildHunkPatch(fresh.patch, 1)).toContain('l10-CHANGED')

    const res = await revertHunk(dir, 'a.txt', 1, served.hunkFingerprints[1])
    expect(res.ok).toBe(true)
    const txt = r(dir, 'a.txt')
    expect(txt).not.toContain('l18-CHANGED') // 用户真正想撤销的块
    expect(txt).toContain('l10-CHANGED')     // 别人的改动一个字都不能动
    expect(txt).toContain('l2-CHANGED')
  })

  it('目标改动块的内容已变化时拒绝执行，不动工作区', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    const base = Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    w(dir, 'a.txt', base)
    await commit(dir, 'add a')

    const shown = base.replace('l2\n', 'l2-CHANGED\n').replace('l18\n', 'l18-CHANGED\n')
    w(dir, 'a.txt', shown)
    const served = await gitDiffFile(dir, 'a.txt')

    // 用户点下去之前，块1 的正文又被改了一版。
    const drifted = shown.replace('l18-CHANGED\n', 'l18-CHANGED-AGAIN\n')
    w(dir, 'a.txt', drifted)

    const res = await revertHunk(dir, 'a.txt', 1, served.hunkFingerprints[1])
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请刷新后重试')
    expect(r(dir, 'a.txt')).toContain('l18-CHANGED-AGAIN') // 工作区原封不动
  })

  it('没有任何已展示记录时不按裸下标动手', async () => {
    const dir = mkRepo()
    await gitInit(dir)
    const base = Array.from({ length: 24 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
    w(dir, 'a.txt', base)
    await commit(dir, 'add a')
    w(dir, 'a.txt', base.replace('l2\n', 'l2-CHANGED\n'))

    _resetServedHunks() // 模拟主进程重启：这份 diff 我们从没给出去过
    const res = await revertHunk(dir, 'a.txt', 0)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('请刷新后重试')
    expect(r(dir, 'a.txt')).toContain('l2-CHANGED')
  })
})
