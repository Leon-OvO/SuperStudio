import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * 本地 Agent 运行时 invoker（runtime-run.ts）单测。
 *
 * mock 掉 store/llm/engine/db + 两个运行时类（不真 spawn CLI），断言 invoker 的接线：
 *   (a) supercode 记录 → task.upstream 直连（baseUrl 带 /v1、真实 key、protocol=anthropic）+ 真实模型/provider。
 *   (b) claude 运行时 + 非 anthropic 协议 → AGENT_ERROR 硬门控，不 spawn 运行时。
 *   (c) 落库：run 前 user 行、run 后 assistant 行（与流式共用同一 messageId）。
 *   (d) stopRuntimeRun 能 abort 进行中 run 已注册的 controller。
 */

const H = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  providers: [] as Array<Record<string, unknown>>,
  protocol: 'anthropic' as 'anthropic' | 'openai' | 'gemini',
  sessionWorkingDir: '/tmp/ws' as string | null,
  dbCalls: [] as Array<{ sql: string; params: unknown[] }>,
  claudeTasks: [] as Array<Record<string, unknown>>,
  opencodeTasks: [] as Array<Record<string, unknown>>,
  claudeResult: { text: 'hello from claude' } as { text: string },
  claudeRunImpl: null as ((task: Record<string, unknown>) => Promise<{ text: string }>) | null,
  claudeDisposed: 0,
  sessionRuntime: null as string | null,
  bridgeToolCalls: [] as Array<Record<string, unknown>>,
  unregistered: [] as Array<string | undefined>,
}))

vi.mock('electron', () => ({ app: { getPath: () => '/userdata' } }))
vi.mock('../services/store', () => ({
  getSettings: () => H.settings,
  getProviders: () => H.providers,
}))
vi.mock('../services/llm', () => ({
  effectiveProtocol: () => H.protocol,
  // 镜像真实 withApiVersion：无 baseUrl → undefined；已带 /vN 原样；否则补 /v1。
  withApiVersion: (b?: string): string | undefined =>
    b ? (/\/v\d+\/?$/.test(b) ? b.replace(/\/+$/, '') : b.replace(/\/+$/, '') + '/v1') : undefined,
}))
vi.mock('./engine', () => ({ readSessionWorkingDir: () => H.sessionWorkingDir }))
vi.mock('../db/sqlite', () => ({
  dbRun: (sql: string, params: unknown[]) => {
    H.dbCalls.push({ sql, params })
  },
  // 会话级引擎覆盖（sessions.runtime）；null = 该会话未设，跟随全局默认。
  dbGet: () => ({ runtime: H.sessionRuntime }),
}))
vi.mock('../services/mcp-bridge', () => ({
  ensureBridgeStarted: async () => 'http://127.0.0.1:1/mcp',
  registerRun: () => 'tok-test',
  unregisterRun: (t: string | undefined) => { H.unregistered.push(t) },
  getRunToolCalls: () => H.bridgeToolCalls,
}))
vi.mock('../worker/runtime/claude-runtime', () => ({
  ClaudeRuntime: class {
    async run(task: Record<string, unknown>): Promise<{ text: string }> {
      H.claudeTasks.push(task)
      if (H.claudeRunImpl) return H.claudeRunImpl(task)
      return H.claudeResult
    }
    async dispose(): Promise<void> {
      H.claudeDisposed++
    }
  },
}))
vi.mock('../worker/runtime/opencode-runtime', () => ({
  OpenCodeRuntime: class {
    async run(task: Record<string, unknown>): Promise<{ text: string }> {
      H.opencodeTasks.push(task)
      return { text: 'hello from opencode' }
    }
    async dispose(): Promise<void> {}
  },
}))

import { IPC } from '../../../src/shared/ipc-types'
import { runViaRuntime, runtimeEnabled, runtimeForSession, stopRuntimeRun } from './runtime-run'

const sent: Array<[string, Record<string, unknown>]> = []
const win = {
  isDestroyed: () => false,
  webContents: { send: (c: string, p: unknown) => sent.push([c, p as Record<string, unknown>]) },
} as never

beforeEach(() => {
  H.settings = { defaultRuntime: 'claude', defaultChatProviderId: 'supercode', defaultChatModel: 'claude-sonnet-4-5' }
  H.providers = [{ id: 'supercode', name: 'SuperCode', baseUrl: 'https://api.supercode.help', apiKey: 'sk-real' }]
  H.protocol = 'anthropic'
  H.sessionWorkingDir = '/tmp/ws'
  H.claudeResult = { text: 'hello from claude' }
  H.claudeRunImpl = null
  H.claudeDisposed = 0
  H.dbCalls.length = 0
  H.claudeTasks.length = 0
  H.opencodeTasks.length = 0
  H.sessionRuntime = null
  H.bridgeToolCalls = []
  H.unregistered.length = 0
  sent.length = 0
})

describe('runtimeEnabled', () => {
  it('已选可用运行时 → 返回 kind；未选 → null', () => {
    H.settings.defaultRuntime = 'claude'
    expect(runtimeEnabled()).toBe('claude')
    H.settings.defaultRuntime = null
    expect(runtimeEnabled()).toBeNull()
    // codex 未有可用适配器（不在 RUNTIME_ADAPTERS_READY）→ 视为未启用
    H.settings.defaultRuntime = 'codex'
    expect(runtimeEnabled()).toBeNull()
  })
})

describe('runViaRuntime', () => {
  it('(a) supercode 记录 → task.upstream 直连（baseUrl 带 /v1、真实 key、protocol=anthropic）', async () => {
    await runViaRuntime({ sessionId: 's1', message: 'hi' }, win)
    expect(H.claudeTasks).toHaveLength(1)
    const t = H.claudeTasks[0]
    expect(t.upstream).toMatchObject({
      baseUrl: 'https://api.supercode.help/v1', // withApiVersion 补 /v1（claude 适配器再剥）
      apiKey: 'sk-real',
      protocol: 'anthropic',
    })
    expect(t.model).toBe('claude-sonnet-4-5')
    expect(t.providerId).toBe('supercode')
    expect(t.providerName).toBe('SuperCode')
    expect(t.cwd).toBe('/tmp/ws')
    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(false)
  })

  it('(b) claude 运行时 + 非 anthropic 协议 → AGENT_ERROR 门控，不 spawn 运行时', async () => {
    H.protocol = 'openai'
    await runViaRuntime({ sessionId: 's2', message: 'hi' }, win)
    expect(H.claudeTasks).toHaveLength(0)
    expect(H.opencodeTasks).toHaveLength(0)
    const err = sent.find((s) => s[0] === IPC.AGENT_ERROR)
    expect(err?.[1]).toMatchObject({ sessionId: 's2' })
    // 门控发生在落库前 → 不该有 user 行
    expect(H.dbCalls).toHaveLength(0)
  })

  it('(b2) gemini 协议 → AGENT_ERROR（无对应 CLI），不 spawn', async () => {
    H.protocol = 'gemini'
    await runViaRuntime({ sessionId: 's2b', message: 'hi' }, win)
    expect(H.claudeTasks).toHaveLength(0)
    expect(sent.some((s) => s[0] === IPC.AGENT_ERROR)).toBe(true)
  })

  it('(c) 落库：run 前 user 行、run 后 assistant 行（同 messageId）', async () => {
    H.claudeResult = { text: 'hello world' }
    await runViaRuntime({ sessionId: 's3', message: '写个 hello' }, win)

    const userIns = H.dbCalls.find((c) => c.sql.includes("'user'"))
    const asstIns = H.dbCalls.find((c) => c.sql.includes("'assistant'"))
    expect(userIns).toBeTruthy()
    expect(asstIns).toBeTruthy()
    // user 行在 assistant 行之前落
    expect(H.dbCalls.indexOf(userIns!)).toBeLessThan(H.dbCalls.indexOf(asstIns!))
    // assistant 与流式共用 task.messageId（否则消息分叉）
    const t = H.claudeTasks[H.claudeTasks.length - 1]
    expect(asstIns!.params[0]).toBe(t.messageId)
    expect(asstIns!.params[2]).toBe('hello world') // content = 运行时返回正文
    // sessions.updated_at 也被刷新
    expect(H.dbCalls.some((c) => c.sql.includes('UPDATE sessions'))).toBe(true)
  })

  it('(c2) 运行时返回空正文且无工具产物 → 不落 assistant 行（避免空气泡）', async () => {
    H.claudeResult = { text: '   ' }
    await runViaRuntime({ sessionId: 's3b', message: 'hi' }, win)
    expect(H.dbCalls.some((c) => c.sql.includes("'user'"))).toBe(true)
    expect(H.dbCalls.some((c) => c.sql.includes("'assistant'"))).toBe(false)
  })

  it('(c3) 纯出图轮：正文为空但有工具产物 → 仍落库，且 tool_calls 落下（否则重开对话图没了）', async () => {
    const toolCalls = [
      { toolName: 'image_generate', args: { prompt: '一只猫' }, result: { text: 'ok', artifacts: [{ type: 'image', path: 'cat.png' }] } },
    ]
    H.claudeResult = { text: '' }
    H.claudeRunImpl = async () => ({ text: '', toolCallLog: toolCalls }) as never

    await runViaRuntime({ sessionId: 's3c', message: '画只猫' }, win)

    const asstIns = H.dbCalls.find((c) => c.sql.includes("'assistant'"))
    expect(asstIns).toBeTruthy()
    expect(JSON.parse(asstIns!.params[3] as string)).toEqual(toolCalls)
  })

  it('(c4) meta 落库带引擎名 → 重开对话仍能看出这条是哪个引擎答的', async () => {
    await runViaRuntime({ sessionId: 's3d', message: 'hi' }, win)
    const asstIns = H.dbCalls.find((c) => c.sql.includes("'assistant'"))
    expect(asstIns!.sql).toContain('meta')
    expect(JSON.parse(asstIns!.params[4] as string)).toMatchObject({
      runtime: 'claude',
      providerName: 'SuperCode',
    })
  })

  it('(e) MCP 桥：task 带 url+token，run 结束 token 立刻失效', async () => {
    await runViaRuntime({ sessionId: 's6', message: 'hi' }, win)
    expect(H.claudeTasks[0].mcp).toEqual({ url: 'http://127.0.0.1:1/mcp', token: 'tok-test' })
    expect(H.unregistered).toContain('tok-test')
  })
})

describe('runtimeForSession（会话覆盖优先于全局默认）', () => {
  it('会话未设 → 跟随全局默认', () => {
    H.settings.defaultRuntime = 'opencode'
    H.sessionRuntime = null
    expect(runtimeForSession('s')).toBe('opencode')
  })

  it("会话选 'builtin' → 钉住内置引擎（即便全局选了 CLI）", () => {
    H.settings.defaultRuntime = 'opencode'
    H.sessionRuntime = 'builtin'
    expect(runtimeForSession('s')).toBeNull()
  })

  it('会话选某 CLI → 覆盖全局（全局未选也生效）', () => {
    H.settings.defaultRuntime = null
    H.sessionRuntime = 'claude'
    expect(runtimeForSession('s')).toBe('claude')
  })

  it('会话存了无可用适配器的 kind（codex）→ 回退全局默认，不当它生效', () => {
    H.settings.defaultRuntime = 'opencode'
    H.sessionRuntime = 'codex'
    expect(runtimeForSession('s')).toBe('opencode')
  })

  it('opencode 运行时 → 交给 OpenCodeRuntime，upstream.protocol=openai 不门控', async () => {
    H.settings.defaultRuntime = 'opencode'
    H.protocol = 'openai'
    await runViaRuntime({ sessionId: 's5', message: 'hi' }, win)
    expect(H.opencodeTasks).toHaveLength(1)
    expect(H.claudeTasks).toHaveLength(0)
    expect(H.opencodeTasks[0].upstream).toMatchObject({ protocol: 'openai', apiKey: 'sk-real' })
  })

  it('(d) stopRuntimeRun：进行中调用会 abort 已注册的 controller', async () => {
    let sig: AbortSignal | undefined
    H.claudeRunImpl = (task) =>
      new Promise((resolve) => {
        sig = task.signal as AbortSignal
        sig.addEventListener('abort', () => resolve({ text: '' }))
      })
    const done = runViaRuntime({ sessionId: 's4', message: 'hi' }, win)
    await vi.waitFor(() => expect(sig).toBeDefined())
    expect(sig!.aborted).toBe(false)
    stopRuntimeRun('s4')
    expect(sig!.aborted).toBe(true)
    await done
    // 取消后不落 assistant 行、dispose 仍被调用清理
    expect(H.dbCalls.some((c) => c.sql.includes("'assistant'"))).toBe(false)
    expect(H.claudeDisposed).toBe(1)
  })
})
