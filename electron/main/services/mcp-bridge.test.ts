import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * End-to-end test of the in-process MCP bridge, driven by the SDK's own
 * StreamableHTTP client — the exact transport opencode uses for `type:"remote"`.
 * If this passes, opencode can talk to it.
 */

const H = vi.hoisted(() => ({
  generateImage: vi.fn(async () => ({ images: [{ path: 'F:/g/images/cat.png' }] })),
  saveGalleryItem: vi.fn(async () => 42),
  skills: [] as unknown[],
  recordSkillSignals: vi.fn(),
}))

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }))
vi.mock('./store', () => ({
  getSettings: () => ({ defaultImageProviderId: 'p', defaultImageModel: 'gpt-image-1' }),
}))
vi.mock('./image', () => ({ generateImage: H.generateImage }))
vi.mock('./gallery', () => ({ saveGalleryItem: H.saveGalleryItem }))
vi.mock('./skills-db', () => ({ getActiveSkillsForScenario: () => H.skills }))
vi.mock('./skill-evolution', () => ({ recordSkillSignals: H.recordSkillSignals }))
vi.mock('./skill-files', () => ({
  readSkillResource: () => 'from-id',
  readSkillResourceAt: (base: string, p: string) => `content of ${base}/${p}`,
}))

import { ensureBridgeStarted, registerRun, unregisterRun, getRunToolCalls, stopMcpBridge } from './mcp-bridge'
import { IPC } from '../../../src/shared/ipc-types'

const sent: Array<{ channel: string; payload: Record<string, unknown> }> = []
const sink = { send: (channel: string, payload: unknown) => { sent.push({ channel, payload: payload as Record<string, unknown> }) } }

async function connect(token: string): Promise<Client> {
  const url = await ensureBridgeStarted()
  const client = new Client({ name: 'test-cli', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  )
  return client
}

beforeEach(() => {
  sent.length = 0
  H.generateImage.mockClear()
  H.saveGalleryItem.mockClear()
  H.recordSkillSignals.mockClear()
  H.skills = []
})

afterAll(async () => { await stopMcpBridge() })

describe('mcp-bridge auth', () => {
  it('rejects a request with no/invalid bearer token', async () => {
    const url = await ensureBridgeStarted()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)

    const res2 = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res2.status).toBe(401)
  })

  it('stops accepting a token after unregisterRun', async () => {
    const token = registerRun({ sessionId: 's', messageId: 'm', sink })
    unregisterRun(token)
    const url = await ensureBridgeStarted()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('mcp-bridge tools/list', () => {
  it('exposes image_generate + skill tools, with the live skill names in load_skill description', async () => {
    H.skills = [
      { id: 'a1', name: '小红书排版', slug: '', runtime: true, skillBody: 'body', installPath: 'F:/s/a1', resourceFiles: [], allowScripts: true, sourceUrl: 'auto://induced' },
    ]
    const token = registerRun({ sessionId: 's1', messageId: 'm1', sink })
    const client = await connect(token)
    try {
      const { tools } = await client.listTools()
      const names = tools.map(t => t.name).sort()
      expect(names).toEqual(['image_generate', 'load_skill', 'read_skill_file'])

      const loadSkill = tools.find(t => t.name === 'load_skill')!
      // 关键：外部 CLI 的 system prompt 不归我们管，技能名只能靠工具描述送到模型眼前
      expect(loadSkill.description).toContain('小红书排版')

      const img = tools.find(t => t.name === 'image_generate')!
      expect(img.inputSchema.properties).toHaveProperty('prompt')
      expect(img.inputSchema.properties).toHaveProperty('referenceImagePath')
    } finally {
      await client.close()
      unregisterRun(token)
    }
  })
})

describe('mcp-bridge image_generate', () => {
  it('generates, saves to gallery, records the tool call and emits an artifact progress event', async () => {
    const token = registerRun({ sessionId: 's2', messageId: 'm2', sink })
    const client = await connect(token)
    try {
      const r = await client.callTool({ name: 'image_generate', arguments: { prompt: 'a cat' } })
      expect(r.isError).toBeFalsy()

      expect(H.generateImage).toHaveBeenCalledOnce()
      expect(H.saveGalleryItem).toHaveBeenCalledOnce()

      // 工具流水是产物回到聊天气泡的唯一来源（CLI stdout 丢结果）
      const log = getRunToolCalls(token)
      expect(log).toHaveLength(1)
      expect(log[0].toolName).toBe('image_generate')
      const result = log[0].result as { artifacts: Array<{ type: string; path: string }> }
      expect(result.artifacts).toEqual([
        expect.objectContaining({ type: 'image', path: 'F:/g/images/cat.png' }),
      ])

      // 实时缩略图
      const artifactEvents = sent.filter(
        e => e.channel === IPC.AGENT_PROGRESS && e.payload.artifact
      )
      expect(artifactEvents).toHaveLength(1)
      expect(artifactEvents[0].payload.sessionId).toBe('s2')

      // 返回给模型的文本不含路径（UI 已渲染，回显会重复）
      const text = (r.content as Array<{ type: string; text: string }>)[0].text
      expect(text).not.toContain('F:/g/images/cat.png')
    } finally {
      await client.close()
      unregisterRun(token)
    }
  })

  it('reports a generation failure as a tool error instead of throwing', async () => {
    H.generateImage.mockRejectedValueOnce(new Error('boom upstream'))
    const token = registerRun({ sessionId: 's3', messageId: 'm3', sink })
    const client = await connect(token)
    try {
      const r = await client.callTool({ name: 'image_generate', arguments: { prompt: 'x' } })
      expect(r.isError).toBe(true)
      expect((r.content as Array<{ text: string }>)[0].text).toContain('boom upstream')
      expect(getRunToolCalls(token)[0].result).toEqual({ error: 'boom upstream' })
    } finally {
      await client.close()
      unregisterRun(token)
    }
  })
})

describe('mcp-bridge load_skill', () => {
  it('returns the skill body + basePath and records a usage signal', async () => {
    H.skills = [
      { id: 'a1', name: '写周报', slug: '', runtime: true, skillBody: 'STEP 1...', installPath: 'F:/s/a1', resourceFiles: ['references/x.md'], allowScripts: false, sourceUrl: 'auto://induced' },
    ]
    const token = registerRun({ sessionId: 's4', messageId: 'm4', sink })
    const client = await connect(token)
    try {
      const r = await client.callTool({ name: 'load_skill', arguments: { name: '写周报' } })
      expect(r.isError).toBeFalsy()
      const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)
      expect(payload.instructions).toBe('STEP 1...')
      expect(payload.basePath).toBe('F:/s/a1')
      expect(H.recordSkillSignals).toHaveBeenCalledOnce()

      const miss = await client.callTool({ name: 'load_skill', arguments: { name: '不存在' } })
      expect(miss.isError).toBe(true)
      expect((miss.content as Array<{ text: string }>)[0].text).toContain('写周报')
    } finally {
      await client.close()
      unregisterRun(token)
    }
  })

  it('提示词型技能（应用内置技能就是这类，runtime:false）也必须可见可加载', async () => {
    H.skills = [
      {
        id: 'b1', name: '小红书文案', slug: '', runtime: false, builtin: true,
        systemPrompt: '按小红书风格写…', skillBody: '', installPath: null,
        resourceFiles: [], allowScripts: false, sourceUrl: null,
      },
    ]
    const token = registerRun({ sessionId: 's5', messageId: 'm5', sink })
    const client = await connect(token)
    try {
      // 若按 runtime 过滤，内置技能会在 CLI 引擎下全体失效——正是本次要修的问题。
      const { tools } = await client.listTools()
      expect(tools.find(t => t.name === 'load_skill')!.description).toContain('小红书文案')

      const r = await client.callTool({ name: 'load_skill', arguments: { name: '小红书文案' } })
      expect(r.isError).toBeFalsy()
      const payload = JSON.parse((r.content as Array<{ text: string }>)[0].text)
      expect(payload.instructions).toBe('按小红书风格写…') // 正文取 systemPrompt

      // 它没有磁盘包，读资源文件应给出明确原因而非含糊的文件系统错误
      const rf = await client.callTool({ name: 'read_skill_file', arguments: { skill: '小红书文案', path: 'a.md' } })
      expect(rf.isError).toBe(true)
      expect((rf.content as Array<{ text: string }>)[0].text).toContain('提示词型技能')
    } finally {
      await client.close()
      unregisterRun(token)
    }
  })
})
