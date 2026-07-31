import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC } from '../../../../src/shared/ipc-types'

/** OpenCode run 模式：mapOpencodeEvent 纯解析(真实事件形状) + run() mock-spawn 驱动。 */

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
// mock discovery：run() 用 resolveRuntimeExecPath 解析 bin；返原生 .exe 走安全 happy path(shell:false)。
vi.mock('./discovery', () => ({ resolveRuntimeExecPath: vi.fn(async () => 'C:/x/opencode-windows-x64/bin/opencode.exe') }))
import { spawn } from 'node:child_process'
import { mapOpencodeEvent, OpenCodeRuntime } from './opencode-runtime'

const mSpawn = vi.mocked(spawn)

// —— 真实 opencode v1.17.17 --format json 抓到的事件形状 ——
const EV_STEP_START = JSON.stringify({ type: 'step_start', sessionID: 's', part: { type: 'step-start', id: 'p0' } })
const EV_TEXT = JSON.stringify({ type: 'text', sessionID: 's', part: { type: 'text', id: 'prt_x', text: 'Hi' } })
const EV_STEP_FINISH = JSON.stringify({
  type: 'step_finish',
  part: { type: 'step-finish', reason: 'stop', tokens: { input: 12701, output: 2, reasoning: 18, cache: { write: 0, read: 0 } } },
})

describe('mapOpencodeEvent (真实事件形状)', () => {
  it('step_start → status', () => {
    expect(mapOpencodeEvent(EV_STEP_START)).toEqual([{ kind: 'status' }])
  })
  it('text → delta（全量 fullText + partId）', () => {
    expect(mapOpencodeEvent(EV_TEXT)).toEqual([{ kind: 'delta', partId: 'prt_x', fullText: 'Hi' }])
  })
  it('step_finish → usage（output 含 reasoning，cache 拆读写）', () => {
    expect(mapOpencodeEvent(EV_STEP_FINISH)).toEqual([
      { kind: 'usage', usage: { input: 12701, output: 2 + 18, cacheRead: 0, cacheWrite: 0 } },
    ])
  })
  it('error → error', () => {
    expect(mapOpencodeEvent(JSON.stringify({ type: 'error', error: { data: { message: '模型不可用' } } }))).toEqual([
      { kind: 'error', error: '模型不可用' },
    ])
  })
  it('无法解析/未知 type 安全', () => {
    expect(mapOpencodeEvent('not json')).toEqual([])
    expect(mapOpencodeEvent(JSON.stringify({ type: 'whatever' }))).toEqual([{ kind: 'ignore' }])
  })
})

class FakeStream extends EventEmitter {
  setEncoding(): void {
    /* no-op */
  }
}
function makeChild(): EventEmitter & { stdout: FakeStream; stderr: FakeStream; stdin: unknown; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdout = new FakeStream()
  child.stderr = new FakeStream()
  // 生产代码给 stdin 挂 error 吞噬监听(14d30e8)并立即 end() 投 EOF(防 opencode 阻塞读 stdin);mock 需支持 on/end。
  child.stdin = { write: vi.fn(), on: vi.fn(), end: vi.fn() }
  child.kill = vi.fn()
  return child as never
}

const task = {
  sessionId: 's',
  taskId: 't',
  cwd: '/tmp/ws',
  messageId: 'm1',
  model: 'gpt-4o',
  providerId: 'up1',
  providerName: 'Upstream',
  upstream: { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-real', protocol: 'openai' as const },
  message: '把图片转白底',
}

beforeEach(() => vi.clearAllMocks())

describe('OpenCodeRuntime.run', () => {
  it('真实事件流 → AGENT_DELTA(Hi) + AGENT_DONE；args/env 直连注入', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new OpenCodeRuntime().run(task as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled()) // run 先 await 解析 bin 再 spawn
    child.stdout.emit('data', EV_STEP_START + '\n')
    child.stdout.emit('data', EV_TEXT + '\n')
    child.stdout.emit('data', EV_STEP_FINISH + '\n')
    child.emit('close', 0)
    const res = await p

    expect(res).toEqual({ text: 'Hi' })
    const args = mSpawn.mock.calls[0]![1] as string[]
    expect(args).toEqual(['run', '--format', 'json', '--dir', '/tmp/ws', '--auto', '-m', 'ss/gpt-4o', '--', '把图片转白底'])
    const opts = mSpawn.mock.calls[0]![2] as { env: Record<string, string>; shell: boolean }
    expect(opts.shell).toBe(false) // 安全不变量：message 绝不经 shell
    expect(opts.env.PWD).toBe('/tmp/ws')
    // 直连上游：baseURL 保留 /v1（openai-compat 自补 /chat/completions）、真实 key，无 /m/relay
    expect(opts.env.OPENCODE_CONFIG_CONTENT).toContain('https://api.example.com/v1')
    expect(opts.env.OPENCODE_CONFIG_CONTENT).not.toContain('/m/relay')
    expect(opts.env.OPENCODE_CONFIG_CONTENT).toContain('"apiKey":"sk-real"')
    const delta = sent.find((s) => s[0] === IPC.AGENT_DELTA)
    expect(delta?.[1]).toMatchObject({ delta: 'Hi', messageId: 'm1' })
    expect(sent.find((s) => s[0] === IPC.AGENT_DONE)?.[1]).toMatchObject({
      content: 'Hi',
      meta: expect.objectContaining({ model: 'gpt-4o', providerId: 'up1', providerName: 'Upstream' }),
    })
  })

  it('全量文本增量 diff：同 part 多次 text 只发新增', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: string[] = []
    const sink = { send: (c: string, p: unknown) => c === IPC.AGENT_DELTA && sent.push((p as { delta: string }).delta) }

    const p = new OpenCodeRuntime().run(task as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { id: 'p1', text: 'AB' } }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'text', part: { id: 'p1', text: 'ABCD' } }) + '\n')
    child.emit('close', 0)
    await p
    expect(sent).toEqual(['AB', 'CD']) // 第二次只发新增 CD
  })

  it('error 事件且无输出 → AGENT_ERROR', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new OpenCodeRuntime().run(task as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.stdout.emit('data', JSON.stringify({ type: 'error', error: { message: '无可用模型' } }) + '\n')
    child.emit('close', 0) // 注：OpenCode 出错常 RC=0
    await p
    expect(sent.find((s) => s[0] === IPC.AGENT_ERROR)?.[1]).toMatchObject({ error: '无可用模型' })
    expect(sent.some((s) => s[0] === IPC.AGENT_DONE)).toBe(false)
  })

  it('非 0 退出且无输出无 error → AGENT_ERROR(不误报空的成功)', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new OpenCodeRuntime().run(task as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.emit('close', 5) // 崩溃/缺依赖：非 0 退出，无任何 stdout/stderr
    await p
    expect(sent.find((s) => s[0] === IPC.AGENT_ERROR)?.[1]).toMatchObject({ error: expect.stringContaining('code 5') })
    expect(sent.some((s) => s[0] === IPC.AGENT_DONE)).toBe(false)
  })

  it('spawn 后立即 end() stdin(投 EOF，防 opencode 阻塞读 stdin 永不退出)', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sink = { send: () => {} }
    const p = new OpenCodeRuntime().run(task as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    expect((child.stdin as { end: ReturnType<typeof vi.fn> }).end).toHaveBeenCalled()
    child.emit('close', 0)
    await p
  })

  it('用户取消(signal.aborted)+ 强杀致非0退出 → 不发 AGENT_ERROR/DONE(取消终态归上层)', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }
    const ac = new AbortController()

    const p = new OpenCodeRuntime().run({ ...task, signal: ac.signal } as never, sink as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    ac.abort() // onAbort→killProcessTree(无 pid 的 mock 直接 return)
    child.emit('close', 1) // 模拟 Windows taskkill /F 的非0退出
    await p
    // 若无 signal.aborted 守卫:code!==0 会误报「运行时异常退出」AGENT_ERROR。守卫后应静默。
    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(false)
    expect(sent.some((s) => s[0] === IPC.AGENT_DONE)).toBe(false)
  })

  it('注入进程内 MCP 桥：remote+Bearer+超时远大于 opencode 默认 5s；CLI 参数不变', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sink = { send: () => {} }
    const p = new OpenCodeRuntime().run(
      { ...task, mcp: { url: 'http://127.0.0.1:5321/mcp', token: 'tok-abc' } } as never,
      sink as never
    )
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.emit('close', 0)
    await p

    const opts = mSpawn.mock.calls[0]![2] as { env: Record<string, string> }
    const cfg = JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT) as {
      provider: Record<string, unknown>
      mcp: { superstudio: { type: string; url: string; enabled: boolean; headers: Record<string, string>; oauth: boolean; timeout: number } }
    }
    expect(cfg.provider).toBeTruthy() // provider 段仍在（两段合成一个 JSON 注入）
    const bridge = cfg.mcp.superstudio
    expect(bridge.type).toBe('remote')
    expect(bridge.url).toBe('http://127.0.0.1:5321/mcp')
    expect(bridge.enabled).toBe(true)
    expect(bridge.headers.Authorization).toBe('Bearer tok-abc')
    expect(bridge.oauth).toBe(false) // 用 Bearer，关掉 401 时的 OAuth 自动探测
    // opencode 的 MCP 默认超时只有 5000ms，而生图动辄几十秒——不放宽必然超时。
    expect(bridge.timeout).toBeGreaterThan(60_000)

    // 只加 config 键、不动命令行：args 必须与不带桥时逐字一致。
    const args = mSpawn.mock.calls[0]![1] as string[]
    expect(args).toEqual(['run', '--format', 'json', '--dir', '/tmp/ws', '--auto', '-m', 'ss/gpt-4o', '--', '把图片转白底'])
  })

  it('不给 mcp 时配置里没有 mcp 段（未启用桥不该凭空多出配置）', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const p = new OpenCodeRuntime().run(task as never, { send: () => {} } as never)
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.emit('close', 0)
    await p
    const opts = mSpawn.mock.calls[0]![2] as { env: Record<string, string> }
    expect(JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT).mcp).toBeUndefined()
  })

  it('工具产物存在时，即使无正文也走 DONE 而非 ERROR（纯出图轮不该丢图）', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }
    const toolCalls = [{ toolName: 'image_generate', args: {}, result: { artifacts: [{ type: 'image', path: 'a.png' }] } }]

    const p = new OpenCodeRuntime().run(
      { ...task, collectToolCalls: () => toolCalls } as never,
      sink as never
    )
    await vi.waitFor(() => expect(mSpawn).toHaveBeenCalled())
    child.stderr.emit('data', 'some noise') // 无正文 + 有 stderr → 旧逻辑会判 ERROR
    child.emit('close', 0)
    const res = await p

    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(false)
    const done = sent.find((s) => s[0] === IPC.AGENT_DONE)
    expect(done?.[1].toolCallLog).toEqual(toolCalls)
    expect((done?.[1].meta as Record<string, unknown>).runtime).toBe('opencode')
    expect(res).toMatchObject({ toolCallLog: toolCalls })
  })
})
