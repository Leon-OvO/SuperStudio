import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { IPC } from '../../../../src/shared/ipc-types'

/** ClaudeRuntime.run 驱动逻辑单测：mock spawn，喂 stream-json，断言事件映射 + env 收口注入 + control 回应。 */

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { ClaudeRuntime } from './claude-runtime'

const mSpawn = vi.mocked(spawn)

class FakeStream extends EventEmitter {
  setEncoding(): void {
    /* no-op */
  }
}
function makeChild(): {
  stdout: FakeStream
  stderr: FakeStream
  stdin: { write: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  kill: ReturnType<typeof vi.fn>
  emit: EventEmitter['emit']
} {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.stdout = new FakeStream()
  child.stderr = new FakeStream()
  // 生产代码给 stdin 挂 error 吞噬监听(14d30e8);mock 需支持 .on。
  // claude turn 进行中保持 stdin 开(回写 control_response)，收到 result 才 end() 投 EOF 收工。
  child.stdin = { write: vi.fn(), on: vi.fn(), end: vi.fn() }
  child.kill = vi.fn()
  return child as never
}

const task = {
  sessionId: 's',
  taskId: 't',
  cwd: '/tmp/ws',
  messageId: 'm1',
  model: 'claude-sonnet-4-5',
  providerId: 'supercode',
  providerName: 'SuperCode',
  upstream: { baseUrl: 'https://api.supercode.help/v1', apiKey: 'sk-real', protocol: 'anthropic' as const },
  message: 'hi',
}

beforeEach(() => vi.clearAllMocks())

describe('ClaudeRuntime.run', () => {
  it('stream-json → AGENT_DELTA + AGENT_DONE，直连 supercode env，喂 user 消息', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new ClaudeRuntime().run(task as never, sink as never)
    // 执行器已同步挂好 stdout/close 处理器 → 喂真实形态的 stream-json
    child.stdout.emit('data', JSON.stringify({ type: 'system', session_id: 's1' }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: '你好' }) + '\n')
    child.emit('close', 0)
    const res = await p

    expect(res).toEqual({ text: '你好' })
    // 命令行参数：真实模型 + 全自动放行
    const args = mSpawn.mock.calls[0]![1] as string[]
    expect(args).toEqual(
      expect.arrayContaining([
        '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
        '--permission-mode', 'bypassPermissions', '--model', 'claude-sonnet-4-5',
      ]),
    )
    // env 直连注入：剥 /vN、x-api-key、清空 AUTH_TOKEN
    const opts = mSpawn.mock.calls[0]![2] as { env: Record<string, string> }
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.supercode.help') // /v1 已剥
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-real')
    expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBe('')
    // stdin 喂 user 消息
    expect(child.stdin.write).toHaveBeenCalledWith(expect.stringContaining('"type":"user"'))
    // 事件
    const delta = sent.find((s) => s[0] === IPC.AGENT_DELTA)
    expect(delta?.[1]).toMatchObject({ delta: '你好', messageId: 'm1' })
    const done = sent.find((s) => s[0] === IPC.AGENT_DONE)
    expect(done?.[1]).toMatchObject({
      content: '你好',
      messageId: 'm1',
      meta: expect.objectContaining({ model: 'claude-sonnet-4-5', providerId: 'supercode', providerName: 'SuperCode' }),
    })
    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(false)
  })

  it('非 anthropic 协议 → AGENT_ERROR 门控（belt-and-suspenders），不 spawn', async () => {
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }
    const res = await new ClaudeRuntime().run(
      { ...task, upstream: { ...task.upstream, protocol: 'openai' } } as never,
      sink as never,
    )
    expect(res).toEqual({ text: '' })
    expect(mSpawn).not.toHaveBeenCalled()
    expect(sent.find((s) => s[0] === IPC.AGENT_ERROR)?.[1]).toMatchObject({
      error: expect.stringContaining('Anthropic'),
    })
  })

  it('result is_error 且无 delta → AGENT_ERROR，不发 DONE', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new ClaudeRuntime().run(task as never, sink as never)
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: true, result: 'boom' }) + '\n')
    child.emit('close', 1)
    await p

    const err = sent.find((s) => s[0] === IPC.AGENT_ERROR)
    expect(err?.[1]).toMatchObject({ error: 'boom' })
    expect(sent.some((s) => s[0] === IPC.AGENT_DONE)).toBe(false)
  })

  it('control_request → 回写 control_response allow 到 stdin', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sink = { send: vi.fn() }

    const p = new ClaudeRuntime().run(task as never, sink as never)
    child.stdout.emit('data', JSON.stringify({ type: 'control_request', request_id: 'req-1' }) + '\n')
    child.emit('close', 0)
    await p

    const writes = child.stdin.write.mock.calls.map((c) => String(c[0]))
    expect(writes.some((w) => w.includes('control_response') && w.includes('req-1') && w.includes('allow'))).toBe(true)
  })

  it('跨 chunk 拆行也能拼出完整 delta', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }

    const p = new ClaudeRuntime().run(task as never, sink as never)
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ABC' }] } }) + '\n'
    child.stdout.emit('data', line.slice(0, 10)) // 半行
    child.stdout.emit('data', line.slice(10)) // 补齐
    child.emit('close', 0)
    await p
    expect(sent.find((s) => s[0] === IPC.AGENT_DELTA)?.[1]).toMatchObject({ delta: 'ABC' })
  })

  it('用户取消(signal.aborted)+ 强杀致非0退出 → 不发 AGENT_ERROR/DONE(取消终态归上层)', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const sent: Array<[string, Record<string, unknown>]> = []
    const sink = { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) }
    const ac = new AbortController()

    const p = new ClaudeRuntime().run({ ...task, signal: ac.signal } as never, sink as never)
    ac.abort() // onAbort→killProcessTree(mock 无 pid→直接 return)
    child.emit('close', 1) // 模拟 Windows taskkill /F 的非0退出
    await p
    // 无守卫时:非0退出且无正文会命中「运行时异常退出」误报 AGENT_ERROR;POSIX(code=null)则发空 DONE。守卫后应静默。
    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(false)
    expect(sent.some((s) => s[0] === IPC.AGENT_DONE)).toBe(false)
  })

  it('收到 result 后必须投 stdin EOF —— 否则 claude 会一直等下一条输入，进程不退、界面永远转圈', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const p = new ClaudeRuntime().run(task as never, { send: () => {} } as never)

    // 实测行为：--input-format stream-json 下 claude 把 stdin 当消息流，result 已发出仍继续等，
    // 不投 EOF 就永不退出 → close 不触发 → run() 永久挂起。
    expect(child.stdin.end).not.toHaveBeenCalled() // turn 进行中不能关(要回写 control_response)
    child.stdout.emit('data', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n')
    child.stdout.emit('data', JSON.stringify({ type: 'result', is_error: false, result: 'hi' }) + '\n')
    expect(child.stdin.end).toHaveBeenCalled() // result = 终帧 → 收工

    child.emit('close', 0)
    expect(await p).toMatchObject({ text: 'hi' })
  })

  it('注入 MCP 桥：--mcp-config 走临时文件(Windows shell 会啃坏内联 JSON)，schema 是 type:"http"，用完即删', async () => {
    const child = makeChild()
    mSpawn.mockReturnValue(child as never)
    const p = new ClaudeRuntime().run(
      { ...task, mcp: { url: 'http://127.0.0.1:5321/mcp', token: 'tok-abc' } } as never,
      { send: () => {} } as never
    )

    const args = mSpawn.mock.calls[0]![1] as string[]
    const i = args.indexOf('--mcp-config')
    expect(i).toBeGreaterThan(-1)
    const raw = args[i + 1]
    // 传的是路径而非内联 JSON——否则 Windows 上 shell:true 会把 JSON 的引号啃坏
    expect(raw.startsWith('{')).toBe(false)
    // Windows 走 shell:true，Node 对参数只拼接不转义(DEP0190)：路径必须自带引号，
    // 否则 TEMP 一含空格就被劈成两个参数(实测 claude 会报 config file not found)。
    if (process.platform === 'win32') expect(raw.startsWith('"') && raw.endsWith('"')).toBe(true)
    const cfgPath = raw.replace(/^"|"$/g, '')

    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
      mcpServers: { superstudio: { type: string; url: string; headers: Record<string, string> } }
    }
    // Claude Code 用 type:"http"（opencode 是 "remote"）——两边不同名，实测得来的。
    expect(cfg.mcpServers.superstudio.type).toBe('http')
    expect(cfg.mcpServers.superstudio.url).toBe('http://127.0.0.1:5321/mcp')
    expect(cfg.mcpServers.superstudio.headers.Authorization).toBe('Bearer tok-abc')
    // 不加 --strict-mcp-config：那会连用户自己的 MCP server 一起屏蔽
    expect(args).not.toContain('--strict-mcp-config')

    child.emit('close', 0)
    await p
    expect(fs.existsSync(cfgPath)).toBe(false) // 带 token 的配置用完即删
  })
})
