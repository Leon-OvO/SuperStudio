import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

/**
 * runShell 加固回归。每条用例都对应一个真实踩过的坑：
 *   - 只留头丢尾 → npm/pytest/traceback 的结论看不到
 *   - 'exit' 就 resolve → stdio 没 flush，尾部稳定丢
 *   - 没有排水超时 → 孙进程持管道时 promise 永久吊死
 *   - 裸 proc.kill → Windows 上 npm/python 孙进程杀不掉
 *   - 硬 utf8 解码 → 中文 Windows 的 GBK 输出全是乱码
 *   - 'error' 分支漏删 abort 监听 → 长生命周期 signal 上监听器堆积
 * 这里跑的是真进程（node 自身），不 mock child_process。
 */

const { TEST_USERDATA } = vi.hoisted(() => {
  const _os = require('os'); const _path = require('path')
  return { TEST_USERDATA: _path.join(_os.tmpdir(), 'ss-shelltest-userdata') }
})
vi.mock('electron', () => ({ app: { getPath: () => TEST_USERDATA } }))
vi.mock('./store', () => ({ getSettings: () => ({}) }))
const H = vi.hoisted(() => ({ approved: [] as string[] }))
vi.mock('./path-allow', () => ({ registerApproved: (p: string) => H.approved.push(p) }))

import { runShell } from './shell'

const isWin = process.platform === 'win32'
const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-shell-js-'))
const tmpDirs: string[] = [TEST_USERDATA, scriptDir]
function mkdir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-shell-'))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})
beforeEach(() => { H.approved = [] })

/**
 * 把一段 JS 落成临时脚本再用 node 跑。刻意不用 `node -e "..."`：
 * cmd.exe 没有反斜杠转义，内联脚本里的引号在 Windows 上必炸。
 */
let scriptSeq = 0
function nodeCmd(js: string): string {
  const f = path.join(scriptDir, `s${scriptSeq++}.js`)
  fs.writeFileSync(f, js, 'utf8')
  return `"${process.execPath}" "${f}"`
}

const never = new AbortController().signal

describe('runShell 输出首尾双缓冲', () => {
  it('超限时保留尾部（结论行）而不是只留头', async () => {
    // 打印 2000 行，首行 START、末行 CONCLUSION；头尾窗口各只有 200 字节。
    const js = "for(let i=0;i<2000;i++)console.log(i===0?'START':i===1999?'CONCLUSION-XYZ':'filler-line-'+i)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, {
      maxFrontBytes: 200, maxTailBytes: 200, logDir: mkdir(),
    })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('START')
    // 旧实现 slice(0, 50_000) 只留头，这一行必然看不到。
    expect(r.stdout).toContain('CONCLUSION-XYZ')
    expect(r.truncated).toBe(true)
    expect(r.stdout).toMatch(/中间已省略 \d+ 字节/)
    // 单调字节计数是截断前的真实产出量。
    expect(r.bytes!.stdout).toBeGreaterThan(10_000)
  }, 30_000)

  it('未超限时输出与原文完全一致（头尾窗口重叠不重复也不丢）', async () => {
    const js = "for(let i=0;i<40;i++)console.log('line-'+i)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, {
      maxFrontBytes: 200, maxTailBytes: 200, logDir: mkdir(),
    })
    const expected = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n')
    expect(r.truncated).toBe(false)
    expect(r.stdout.replace(/\r\n/g, '\n').trimEnd()).toBe(expected)
  }, 30_000)

  it('输出超硬上限时主动终止并标 output_limit', async () => {
    // 每 10ms 写 1MB，自然结束要 5s；硬上限 256KB 应该在头几十毫秒就把它掐掉。
    const js = "const b=Buffer.alloc(65536,97);let n=0;const t=setInterval(()=>{for(let i=0;i<16;i++)process.stdout.write(b);if(++n>500){clearInterval(t)}},10)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, {
      maxFrontBytes: 200, maxTailBytes: 200, hardOutputLimitBytes: 256 * 1024,
      killGraceMs: 200, drainTimeoutMs: 500, logDir: mkdir(),
    })
    expect(r.killedBy).toBe('output_limit')
    expect(r.timedOut).toBe(false)
    expect(r.diagnostics).toContain('输出超过上限')
  }, 30_000)
})

describe('runShell resolve 时机', () => {
  it('等 close 而不是 exit：进程秒退也拿得到完整输出', async () => {
    const js = "process.stdout.write('A'.repeat(120000));process.exit(0)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, { logDir: mkdir() })
    expect(r.drained).toBe(true)
    expect(r.bytes!.stdout).toBe(120_000)
  }, 30_000)

  it("进程 exit 后 stdio 永不关闭时，按排水超时收工而不是吊死", async () => {
    // 用假子进程精确复现「'exit' 来了、'close' 永远不来」：真实世界里就是孙进程继承了
    // 管道（`npm run dev` 之类）。没有排水超时的话这个 promise 永远不 resolve，用例超时变红。
    vi.resetModules()
    const fake = new EventEmitter() as EventEmitter & {
      pid: number; stdout: PassThrough; stderr: PassThrough
      exitCode: number | null; signalCode: string | null; kill: () => boolean
    }
    fake.pid = 4242
    fake.stdout = new PassThrough()
    fake.stderr = new PassThrough()
    fake.exitCode = null
    fake.signalCode = null
    fake.kill = () => true
    vi.doMock('child_process', () => ({ spawn: () => fake }))
    try {
      const mod = await import('./shell')
      const t0 = Date.now()
      const p = mod.runShell('whatever', os.tmpdir(), never, 30_000, {
        drainTimeoutMs: 300, logDir: mkdir(),
      })
      await new Promise((res) => setTimeout(res, 20))
      fake.stdout.write('前半截输出\n')
      fake.exitCode = 0
      fake.emit('exit', 0, null) // 只发 exit，永远不发 close
      const r = await p
      expect(Date.now() - t0).toBeLessThan(3_000)
      expect(r.drained).toBe(false)
      expect(r.timedOut).toBe(false)
      expect(r.stdout).toContain('前半截输出')
      // 排水不全这件事必须让模型看得见。
      expect(r.diagnostics ?? '').toContain('排水超时')
    } finally {
      vi.doUnmock('child_process')
      vi.resetModules()
    }
  }, 30_000)

  it.skipIf(isWin)('posix：孙进程继承管道时同样按排水超时收工', async () => {
    // POSIX 上 fork 出来的孙进程真的会持有 stdout 写端，'close' 要等它退出才来。
    const inner = "setTimeout(()=>{},5000)"
    const js = `const cp=require('child_process');cp.spawn(process.argv[0],['-e','${inner}'],{stdio:['ignore','inherit','inherit'],detached:true}).unref()`
    const t0 = Date.now()
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, {
      drainTimeoutMs: 400, logDir: mkdir(),
    })
    expect(Date.now() - t0).toBeLessThan(3_000)
    expect(r.drained).toBe(false)
  }, 30_000)
})

describe('runShell 超时与进程树终止', () => {
  it('超时后连同孙进程一起杀掉（孙进程的延迟写入不再发生）', async () => {
    const dir = mkdir()
    const marker = path.join(dir, 'grandchild.txt').replace(/\\/g, '\\\\')
    // 孙进程 1.5s 后写标记文件；我们 400ms 就超时终止。裸 proc.kill 只杀 cmd.exe/sh，
    // 孙进程活着 → 标记文件会出现 → 这条用例变红。
    const inner = `setTimeout(()=>require('fs').writeFileSync('${marker}','x'),1500)`
    const js = `const cp=require('child_process');cp.spawn(process.argv[0],['-e',${JSON.stringify(inner)}],{stdio:'ignore'});setTimeout(()=>{},4000)`
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 400, {
      killGraceMs: 300, drainTimeoutMs: 500, logDir: dir,
    })
    expect(r.timedOut).toBe(true)
    expect(r.killedBy).toBe('timeout')
    await new Promise((res) => setTimeout(res, 2_500))
    expect(fs.existsSync(path.join(dir, 'grandchild.txt'))).toBe(false)
  }, 30_000)

  it('传入已 abort 的 signal 时立刻终止（AbortSignal 不会补发事件）', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runShell(nodeCmd('setTimeout(()=>{},5000)'), os.tmpdir(), ac.signal, 30_000, {
      killGraceMs: 200, drainTimeoutMs: 500, logDir: mkdir(),
    })
    expect(r.killedBy).toBe('abort')
    expect(r.durationMs).toBeLessThan(5_000)
  }, 30_000)

  it('用户中止标 abort，且不算超时', async () => {
    const ac = new AbortController()
    const p = runShell(nodeCmd('setTimeout(()=>{},5000)'), os.tmpdir(), ac.signal, 30_000, {
      killGraceMs: 200, drainTimeoutMs: 500, logDir: mkdir(),
    })
    setTimeout(() => ac.abort(), 200)
    const r = await p
    expect(r.killedBy).toBe('abort')
    expect(r.timedOut).toBe(false)
  }, 30_000)
})

describe('runShell 编码', () => {
  it('GBK 输出被正确解码成中文而不是替换符', async () => {
    // d6 d0 ce c4 = GBK 的「中文」；硬 utf8 解码会得到 U+FFFD。
    const js = "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, { logDir: mkdir() })
    expect(r.stdout).toContain('中文')
    expect(r.stdout).not.toContain('�')
  }, 30_000)

  it('注入 PYTHONUTF8 / PYTHONIOENCODING', async () => {
    const js = "process.stdout.write(process.env.PYTHONUTF8+'|'+process.env.PYTHONIOENCODING)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, { logDir: mkdir() })
    expect(r.stdout.trim()).toBe('1|utf-8:surrogateescape')
  }, 30_000)

  it.skipIf(!isWin)('chcp 前缀可关闭（老 .bat 逃生口）', async () => {
    const js = "process.stdout.write('ok')"
    const on = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, { forceUtf8: true, logDir: mkdir() })
    const off = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, { forceUtf8: false, logDir: mkdir() })
    // 两种模式都不能把 chcp 自己的输出混进结果（>nul），且命令本身照常执行。
    expect(on.stdout.trim()).toBe('ok')
    expect(off.stdout.trim()).toBe('ok')
    expect(on.code).toBe(0)
  }, 60_000)
})

describe('runShell 日志与诊断', () => {
  it('全量输出落盘、回绝对路径并过 path-allow', async () => {
    const dir = mkdir()
    const js = "for(let i=0;i<500;i++)console.log('row-'+i)"
    const r = await runShell(nodeCmd(js), os.tmpdir(), never, 30_000, {
      maxFrontBytes: 100, maxTailBytes: 100, logDir: dir,
    })
    expect(r.logPath).toBeTruthy()
    expect(path.isAbsolute(r.logPath!)).toBe(true)
    const full = fs.readFileSync(r.logPath!, 'utf8')
    // 内存里被省略掉的中段，日志里必须有。
    expect(full).toContain('row-250')
    expect(r.stdout).not.toContain('row-250')
    expect(H.approved).toContain(r.logPath)
  }, 30_000)

  it('失败时带诊断包，成功时不带', async () => {
    const dir = mkdir()
    const bad = await runShell(nodeCmd("console.error('boom');process.exit(3)"), dir, never, 30_000, { logDir: mkdir() })
    expect(bad.code).toBe(3)
    expect(bad.diagnostics).toContain('exitCode=3')
    expect(bad.diagnostics).toContain('已收输出')
    expect(bad.diagnostics).toContain(bad.logPath!)
    expect(bad.diagnostics).toContain(dir) // cwd 顶层快照

    const good = await runShell(nodeCmd("console.log('fine')"), os.tmpdir(), never, 30_000, { logDir: mkdir() })
    expect(good.code).toBe(0)
    expect(good.diagnostics).toBeUndefined()
  }, 30_000)

  it('既有字段不变（两个调用方靠它们取值）', async () => {
    const r = await runShell(nodeCmd("console.log('hi')"), os.tmpdir(), never, 30_000, { logDir: mkdir() })
    expect(typeof r.code).toBe('number')
    expect(typeof r.stdout).toBe('string')
    expect(typeof r.stderr).toBe('string')
    expect(typeof r.timedOut).toBe('boolean')
  }, 30_000)
})

describe("runShell 'error' 分支", () => {
  it('cwd 不存在时返回诊断，并摘掉 abort 监听器', async () => {
    const events: string[] = []
    const fake = {
      aborted: false,
      addEventListener: () => events.push('add'),
      removeEventListener: () => events.push('remove'),
    } as unknown as AbortSignal
    const missing = path.join(os.tmpdir(), 'ss-shell-does-not-exist-' + Date.now())
    const r = await runShell(nodeCmd("console.log('x')"), missing, fake, 5_000, { logDir: mkdir() })
    expect(r.code).toBe(-1)
    expect(r.diagnostics).toContain('无法执行')
    // 旧实现的 'error' 分支漏了这一步，监听器会一直挂在上层长生命周期 signal 上。
    expect(events).toEqual(['add', 'remove'])
  }, 30_000)
})
