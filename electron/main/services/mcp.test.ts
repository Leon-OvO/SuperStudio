import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { McpServerConfig } from '../../../src/shared/ipc-types'
import { MCP_TOOL_CALL_TIMEOUT_MS } from '../agent/timeouts'

/**
 * McpManager 的连接生命周期 / 错误分类 / 出站白名单。
 *
 * 这里全部用假的 SDK Client：真 Client 会去 spawn 子进程，而我们要验的恰恰是
 * 「子进程崩掉之后会发生什么」——那在真实连接上没法稳定复现。
 */

// vi.mock 的工厂会被提升到文件顶部，所以假 Client / 临时目录这些都必须住在
// vi.hoisted 里，否则工厂执行时它们还没初始化。
const H = vi.hoisted(() => {
  const os2 = require('node:os') as typeof os
  const fs2 = require('node:fs') as typeof fs
  const path2 = require('node:path') as typeof path
  const TMP = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'mcp-test-'))

  interface Behavior {
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
    call: (client: FakeClient, params: { name: string; arguments?: unknown }) => Promise<unknown>
    connectDelay?: () => Promise<void>
  }
  const behaviors = new Map<string, Behavior>()
  const behaviorOf = (key: string): Behavior => {
    const b = behaviors.get(key)
    if (!b) throw new Error(`测试里没有为 "${key}" 定义行为`)
    return b
  }

  class FakeStdio {
    constructor(public opts: { command: string; args?: string[]; env?: Record<string, string> }) {}
  }
  class FakeSSE {
    constructor(public url: URL, public opts: unknown) {}
  }
  class FakeClient {
    static instances: FakeClient[] = []
    onclose?: () => void
    onerror?: (e: Error) => void
    transport?: FakeStdio | FakeSSE
    closed = false
    callOptions: Array<Record<string, unknown> | undefined> = []
    constructor(_info: unknown, _caps?: unknown) { FakeClient.instances.push(this) }

    /** 这个 client 连到了哪台服务器 —— 用 stdio 的 command 当 key。 */
    get key(): string {
      return this.transport instanceof FakeStdio ? this.transport.opts.command : 'sse'
    }
    async connect(transport: FakeStdio | FakeSSE, _options?: unknown): Promise<void> {
      this.transport = transport
      await behaviorOf(this.key).connectDelay?.()
    }
    async close(): Promise<void> {
      if (this.closed) return
      this.closed = true
      this.onclose?.()   // 真 SDK 也是 close → transport.onclose → Protocol.onclose
    }
    async listTools(_params?: unknown, _options?: unknown): Promise<{ tools: unknown[] }> {
      return { tools: behaviorOf(this.key).tools }
    }
    async callTool(
      params: { name: string; arguments?: unknown },
      _schema: unknown,
      options?: Record<string, unknown>
    ): Promise<unknown> {
      this.callOptions.push(options)
      return behaviorOf(this.key).call(this, params)
    }
  }

  return {
    TMP,
    behaviors,
    FakeStdio,
    FakeSSE,
    FakeClient,
    servers: [] as unknown[],
    saveGalleryItem: vi.fn(async () => 1),
  }
})

const { behaviors, FakeClient } = H

vi.mock('electron', () => ({ app: { getPath: () => H.TMP, getVersion: () => '0.0.0-test' } }))
vi.mock('./store', () => ({
  getSettings: () => ({ dataDirectory: H.TMP }),
  getMcpServers: () => H.servers,
}))
vi.mock('./gallery', () => ({ saveGalleryItem: H.saveGalleryItem }))
vi.mock('./ua', () => ({ userAgent: () => 'test-agent' }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: H.FakeClient }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: H.FakeStdio }))
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: H.FakeSSE }))

function textResult(text: string): unknown {
  return { content: [{ type: 'text', text }] }
}

import { McpManager, isFetchableUrl, classifyMcpError, isValidQualifiedName } from './mcp'

function cfg(id: string, name: string, command = id): McpServerConfig {
  return { id, name, transport: 'stdio', command, enabled: true } as McpServerConfig
}

/** JSON-RPC 错误（SDK 的 McpError 就是这个形状：错误码在 err.code 上）。 */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code })
}

let mgr: McpManager

beforeEach(() => {
  FakeClient.instances = []
  behaviors.clear()
  H.servers = []
  H.saveGalleryItem.mockClear()
  mgr = new McpManager()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

// ---- 出站白名单（SSRF） ------------------------------------------------------

describe('isFetchableUrl —— MCP 返回的地址不能想打哪就打哪', () => {
  it('放行公网 https', () => {
    expect(isFetchableUrl('https://cdn.example.com/a.png')).toBe(true)
    expect(isFetchableUrl('https://1.2.3.4/a.png')).toBe(true)
  })

  it('放行回环 http —— MCP 服务器常把产物挂在自己起的本地端口上', () => {
    expect(isFetchableUrl('http://127.0.0.1:8188/view?x=1')).toBe(true)
    expect(isFetchableUrl('http://localhost:3000/a.png')).toBe(true)
    expect(isFetchableUrl('http://[::1]:9000/a.png')).toBe(true)
    expect(isFetchableUrl('https://127.0.0.1/a.png')).toBe(true)
  })

  it('拒非回环的明文 http', () => {
    expect(isFetchableUrl('http://cdn.example.com/a.png')).toBe(false)
  })

  it('拒云元数据服务与各类私网段（https 也拒）', () => {
    for (const u of [
      'http://169.254.169.254/latest/meta-data/',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/a.png',
      'https://172.16.3.9/a.png',
      'https://172.31.255.1/a.png',
      'https://192.168.1.1/a.png',
      'https://100.64.0.1/a.png',
      'https://0.0.0.0/a.png',
      'https://[fd00::1]/a.png',
      'https://[fe80::1]/a.png',
    ]) {
      expect(isFetchableUrl(u), u).toBe(false)
    }
  })

  it('拒非 http(s) 协议与畸形地址', () => {
    expect(isFetchableUrl('file:///C:/Windows/win.ini')).toBe(false)
    expect(isFetchableUrl('ftp://example.com/a.png')).toBe(false)
    expect(isFetchableUrl('不是个地址')).toBe(false)
  })

  it('十进制/十六进制写法的回环与私网也认得出来', () => {
    // URL 会把这些规范化成点分十进制，我们不能只认字面量写法
    expect(isFetchableUrl('http://2130706433/a.png')).toBe(true)          // 127.0.0.1
    expect(isFetchableUrl('https://0xA9FEA9FE/a.png')).toBe(false)        // 169.254.169.254
    expect(isFetchableUrl('https://[::ffff:192.168.0.1]/a.png')).toBe(false)
  })

  it('172.32/172.15 不在私网段里，不能误伤', () => {
    expect(isFetchableUrl('https://172.32.0.1/a.png')).toBe(true)
    expect(isFetchableUrl('https://172.15.0.1/a.png')).toBe(true)
  })
})

describe('saveRemote 真的走白名单', () => {
  it('文本里扫出的内网地址不会被下载，公网/回环地址才下载', async () => {
    const fetchSpy = vi.fn(async (_url: string) => ({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }))
    vi.stubGlobal('fetch', fetchSpy)
    behaviors.set('srv', {
      tools: [{ name: 'draw' }],
      call: async () => textResult(
        '好了：http://169.254.169.254/latest.png 以及 http://10.0.0.9/x.png 以及 https://cdn.example.com/ok.png'
      ),
    })
    const c = cfg('s1', 'srv', 'srv')
    await mgr.listToolsFor(c)
    const res = await mgr.callTool('srv__draw', {})
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://cdn.example.com/ok.png')
    expect(res.artifacts).toHaveLength(1)
  })
})

// ---- 错误三分法 --------------------------------------------------------------

describe('classifyMcpError', () => {
  it('JSON-RPC 请求类错误不可恢复', () => {
    for (const code of [-32700, -32600, -32601, -32602]) {
      expect(classifyMcpError(rpcError(code, 'bad'))).toBe('request')
    }
  })
  it('连接关闭类是会话坏了，可恢复', () => {
    expect(classifyMcpError(rpcError(-32000, 'Connection closed'))).toBe('session')
    expect(classifyMcpError(new Error('MCP error: Connection closed'))).toBe('session')
    expect(classifyMcpError(new Error('write EPIPE'))).toBe('session')
    expect(classifyMcpError(new Error('Not connected'))).toBe('session')
  })
  it('凭据坏了要重新授权，不是重连', () => {
    expect(classifyMcpError(new Error('HTTP 401 Unauthorized'))).toBe('auth')
    expect(classifyMcpError(new Error('invalid api key'))).toBe('auth')
  })
  it('超时归为其它 —— 重连会让还在跑的工具白跑一遍', () => {
    expect(classifyMcpError(rpcError(-32001, 'Request timed out'))).toBe('other')
  })
})

// ---- 死连接回收 --------------------------------------------------------------

describe('死连接回收', () => {
  it('子进程崩掉后工具不会永久消失（不必重启 App）', async () => {
    let alive = true
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => {
        if (!alive) throw rpcError(-32000, 'Connection closed')
        return textResult('ok')
      },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    expect(await mgr.listToolsFor(c)).toHaveLength(1)

    // 模拟 stdio 子进程崩了：SDK 会触发 Protocol.onclose
    alive = false
    FakeClient.instances[0].onclose?.()
    alive = true

    const res = await mgr.callTool('alpha__hello', {})
    expect(res.text).toBe('ok')
    // 崩掉的那个必须被换掉，而不是继续拿旧 client 去调
    expect(FakeClient.instances).toHaveLength(2)
  })

  it('回收不会去 reject 在途请求（178s 的出图不能因为回收而丢结果）', async () => {
    let release!: (v: unknown) => void
    behaviors.set('slow', {
      tools: [{ name: 'draw' }],
      call: () => new Promise(r => { release = r }),
    })
    const c = cfg('slow', 'slow', 'slow')
    H.servers = [c]
    await mgr.listToolsFor(c)
    const p = mgr.callTool('slow__draw', {})
    FakeClient.instances[0].onclose?.()          // 回收发生在出图途中
    release(textResult('画完了'))
    await expect(p).resolves.toMatchObject({ text: '画完了' })
  })

  it('主动 disconnect 也会清掉工具索引', async () => {
    behaviors.set('a', { tools: [{ name: 'hello' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    H.servers = []                                // 断开后没有任何可用服务器
    await mgr.listToolsFor(c)
    await mgr.disconnect('a')
    await expect(mgr.callTool('alpha__hello', {})).rejects.toThrow(/not found/)
  })
})

// ---- 会话坏了：回收 + 重连一次 -----------------------------------------------

describe('callTool 的恢复策略', () => {
  it('会话坏了：回收 + 重连一次再重试，且只重试一次', async () => {
    let attempts = 0
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => {
        attempts++
        if (attempts === 1) throw rpcError(-32000, 'Connection closed')
        return textResult('第二次成功')
      },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    await mgr.listToolsFor(c)
    const res = await mgr.callTool('alpha__hello', {})
    expect(res.text).toBe('第二次成功')
    expect(attempts).toBe(2)
    expect(FakeClient.instances).toHaveLength(2)
  })

  it('一直坏也只重连一次，绝不变成 spawn 风暴', async () => {
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => { throw rpcError(-32000, 'Connection closed') },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    await mgr.listToolsFor(c)
    await expect(mgr.callTool('alpha__hello', {})).rejects.toThrow(/Connection closed/)
    expect(FakeClient.instances).toHaveLength(2)
  })

  it('参数写错（-32602）不重连', async () => {
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => { throw rpcError(-32602, 'Invalid params') },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    await mgr.listToolsFor(c)
    await expect(mgr.callTool('alpha__hello', {})).rejects.toThrow(/Invalid params/)
    expect(FakeClient.instances).toHaveLength(1)
  })

  it('凭据坏了（401）不重连 —— 重连不会让过期凭据变有效', async () => {
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => { throw new Error('HTTP 401 Unauthorized') },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    await mgr.listToolsFor(c)
    await expect(mgr.callTool('alpha__hello', {})).rejects.toThrow(/401/)
    expect(FakeClient.instances).toHaveLength(1)
  })

  it('用户已按停止时不偷偷重试', async () => {
    const ac = new AbortController()
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => { ac.abort(); throw rpcError(-32000, 'Connection closed') },
    })
    const c = cfg('a', 'alpha', 'a')
    H.servers = [c]
    await mgr.listToolsFor(c)
    await expect(mgr.callTool('alpha__hello', {}, { signal: ac.signal })).rejects.toThrow(/Connection closed/)
    expect(FakeClient.instances).toHaveLength(1)
  })
})

// ---- 并发去重 ----------------------------------------------------------------

describe('连接并发去重', () => {
  it('并发调用同一个未连服务器只 spawn 一个子进程', async () => {
    let unblock!: () => void
    const gate = new Promise<void>(r => { unblock = r })
    behaviors.set('a', {
      tools: [{ name: 'hello' }],
      call: async () => textResult('ok'),
      connectDelay: () => gate,
    })
    const c = cfg('a', 'alpha', 'a')
    const p = Promise.all([mgr.listToolsFor(c), mgr.listToolsFor(c), mgr.listToolsFor(c)])
    unblock()
    await p
    expect(FakeClient.instances).toHaveLength(1)
  })
})

// ---- 超时 / 取消穿透 ---------------------------------------------------------

describe('超时与取消穿透到 SDK', () => {
  it('callTool 显式带上 timeout —— 否则 SDK 自己的 60s 默认值会把长时工具掐断', async () => {
    behaviors.set('a', { tools: [{ name: 'draw' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    await mgr.listToolsFor(c)
    await mgr.callTool('alpha__draw', {})
    const opts = FakeClient.instances[0].callOptions[0]!
    expect(opts.timeout).toBe(MCP_TOOL_CALL_TIMEOUT_MS)
    expect(opts.maxTotalTimeout).toBe(MCP_TOOL_CALL_TIMEOUT_MS)
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000)
  })

  it('abort signal 原样传给 SDK（SDK 收到后会给服务器发取消通知）', async () => {
    behaviors.set('a', { tools: [{ name: 'draw' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    await mgr.listToolsFor(c)
    const ac = new AbortController()
    await mgr.callTool('alpha__draw', {}, { signal: ac.signal })
    expect(FakeClient.instances[0].callOptions[0]!.signal).toBe(ac.signal)
  })

  it('已经取消的调用根本不发出去', async () => {
    behaviors.set('a', { tools: [{ name: 'draw' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    await mgr.listToolsFor(c)
    const ac = new AbortController()
    ac.abort()
    await expect(mgr.callTool('alpha__draw', {}, { signal: ac.signal })).rejects.toThrow(/已取消/)
    expect(FakeClient.instances[0].callOptions).toHaveLength(0)
  })
})

// ---- 工具名撞名 --------------------------------------------------------------

describe('工具限定名', () => {
  it('两个纯中文命名的服务器不会互相覆盖工具索引', async () => {
    const hits: string[] = []
    behaviors.set('cn1', { tools: [{ name: 'run' }], call: async () => { hits.push('cn1'); return textResult('一号') } })
    behaviors.set('cn2', { tools: [{ name: 'run' }], call: async () => { hits.push('cn2'); return textResult('二号') } })
    const a = cfg('id-1', '出图服务', 'cn1')
    const b = cfg('id-2', '绘画助手', 'cn2')
    const ta = await mgr.listToolsFor(a)
    const tb = await mgr.listToolsFor(b)
    expect(ta[0].qualifiedName).not.toBe(tb[0].qualifiedName)
    expect(isValidQualifiedName(ta[0].qualifiedName)).toBe(true)
    expect(isValidQualifiedName(tb[0].qualifiedName)).toBe(true)
    expect((await mgr.callTool(ta[0].qualifiedName, {})).text).toBe('一号')
    expect((await mgr.callTool(tb[0].qualifiedName, {})).text).toBe('二号')
    expect(hits).toEqual(['cn1', 'cn2'])
  })

  it('同一个服务器的 slug 稳定（不随连接次数变化）', async () => {
    behaviors.set('cn1', { tools: [{ name: 'run' }], call: async () => textResult('x') })
    const a = cfg('id-1', '出图服务', 'cn1')
    const first = (await mgr.listToolsFor(a))[0].qualifiedName
    await mgr.disconnect('id-1')
    const again = (await mgr.listToolsFor(a))[0].qualifiedName
    expect(again).toBe(first)
  })

  it('名字不合规的工具被跳过而不是截断改写', async () => {
    behaviors.set('a', {
      tools: [{ name: 'good' }, { name: 'bad name!' }, { name: '中文工具' }, { name: 'x'.repeat(90) }],
      call: async () => textResult('ok'),
    })
    const c = cfg('a', 'alpha', 'a')
    const tools = await mgr.listToolsFor(c)
    expect(tools.map(t => t.qualifiedName)).toEqual(['alpha__good'])
    await expect(mgr.callTool('alpha__中文工具', {})).rejects.toThrow(/not found/)
  })

  it('限定名以数字开头的服务器名也能通过校验', async () => {
    behaviors.set('a', { tools: [{ name: 'run' }], call: async () => textResult('ok') })
    const c = cfg('a', '3D 建模', 'a')
    const tools = await mgr.listToolsFor(c)
    expect(tools).toHaveLength(1)
    expect(isValidQualifiedName(tools[0].qualifiedName)).toBe(true)
  })

  it('test() 把被跳过的工具报给用户，而不是假装它们能用', async () => {
    behaviors.set('a', { tools: [{ name: 'good' }, { name: 'bad name!' }], call: async () => textResult('ok') })
    const r = await mgr.test(cfg('a', 'alpha', 'a'))
    expect(r.tools.map(t => t.name)).toEqual(['good'])
    expect(r.skipped.map(s => s.name)).toEqual(['bad name!'])
  })
})

// ---- 工具缓存 ----------------------------------------------------------------

describe('工具列表缓存', () => {
  it('TTL 内复用缓存，不重复 listTools', async () => {
    behaviors.set('a', { tools: [{ name: 'hello' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    const spy = vi.spyOn(FakeClient.prototype, 'listTools')
    await mgr.listToolsFor(c)
    await mgr.listToolsFor(c)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('连接被回收后缓存一并失效（缓存和时间戳同生共死）', async () => {
    behaviors.set('a', { tools: [{ name: 'hello' }], call: async () => textResult('ok') })
    const c = cfg('a', 'alpha', 'a')
    const spy = vi.spyOn(FakeClient.prototype, 'listTools')
    await mgr.listToolsFor(c)
    FakeClient.instances[0].onclose?.()
    await mgr.listToolsFor(c)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
