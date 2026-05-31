import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ───────────────────────────────────────────────────────────────────
// Mock every module runAgent touches so the test exercises ONLY the orchestration
// logic (stream collection, empty-response guard, ask_user fallback, AGENT_DONE).

const sends: Array<{ channel: string; payload: unknown }> = []
const dbRuns: Array<{ sql: string; params: unknown[] }> = []

// Controls what the fake streamText yields per test.
let streamScript: {
  chunks: string[]
  finishReason?: string
  usage?: { promptTokens?: number; completionTokens?: number }
} = { chunks: ['Hello'], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } }

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return {
    ...actual,
    streamText: vi.fn(() => {
      async function* gen() { for (const c of streamScript.chunks) yield c }
      return {
        textStream: gen(),
        usage: Promise.resolve(streamScript.usage ?? {}),
        finishReason: Promise.resolve(streamScript.finishReason ?? 'stop')
      }
    })
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/superstudio-test' },
  BrowserWindow: class {}
}))

vi.mock('../db/sqlite', () => ({
  dbRun: vi.fn((sql: string, params: unknown[]) => { dbRuns.push({ sql, params }) }),
  dbAll: vi.fn(() => []),
  dbGet: vi.fn(() => null)
}))

vi.mock('../services/store', () => ({
  getSettings: () => ({
    defaultChatProviderId: 'p1',
    defaultChatModel: 'gpt-4o',
    defaultImageModel: 'dall-e-3',
    defaultVideoModel: 'sora',
    autoModelEnabled: false
  }),
  getProviders: () => [{ id: 'p1', name: 'OpenAI', type: 'openai', apiKey: 'k', models: ['gpt-4o'] }]
}))

vi.mock('../services/llm', () => ({ createLLMClient: () => ({}) }))
vi.mock('../services/mcp', () => ({ mcpManager: { listAllTools: async () => [], callTool: async () => ({ text: '' }) } }))
vi.mock('../services/knowledge', () => ({ searchKnowledge: async () => [] }))
vi.mock('../services/skills-db', () => ({ getActiveSkillsForScenario: () => [] }))
vi.mock('../services/tray', () => ({ notifyTaskComplete: vi.fn() }))
vi.mock('../services/model-pricing', () => ({ computeCost: () => null }))
vi.mock('../services/gallery', () => ({ saveGalleryItem: vi.fn() }))
vi.mock('./skill-tools', () => ({ buildSkillTools: () => ({}) }))

import { runAgent } from './engine'
import { IPC } from '../../../src/shared/ipc-types'

function fakeWin() {
  return {
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => { sends.push({ channel, payload }) } }
  } as never
}

function lastSend(channel: string) {
  return [...sends].reverse().find(s => s.channel === channel)?.payload as Record<string, unknown> | undefined
}

beforeEach(() => {
  sends.length = 0
  dbRuns.length = 0
  streamScript = { chunks: ['Hello'], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } }
})

describe('runAgent orchestration', () => {
  it('streams text and emits AGENT_DONE with the assembled content', async () => {
    streamScript = { chunks: ['Hel', 'lo ', 'world'], finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 5 } }
    await runAgent({ sessionId: 's1', message: 'hi' }, fakeWin())
    const done = lastSend(IPC.AGENT_DONE)
    expect(done).toBeTruthy()
    expect(done!.content).toBe('Hello world')
    expect(done!.sessionId).toBe('s1')
    // user message + assistant message persisted
    expect(dbRuns.some(r => /INSERT INTO messages/.test(r.sql) && r.params.includes('hi'))).toBe(true)
  })

  it('throws AGENT_ERROR (not DONE) on a truly empty response', async () => {
    streamScript = { chunks: [], finishReason: 'stop', usage: {} }
    await runAgent({ sessionId: 's2', message: 'hi' }, fakeWin())
    expect(lastSend(IPC.AGENT_DONE)).toBeUndefined()
    const err = lastSend(IPC.AGENT_ERROR)
    expect(err).toBeTruthy()
    expect(String(err!.error)).toContain('空响应')
  })

  it('errors clearly when no model is configured', async () => {
    // Override store to return empty defaults for this one call.
    const store = await import('../services/store')
    vi.spyOn(store, 'getSettings').mockReturnValueOnce({
      defaultChatProviderId: '', defaultChatModel: '', defaultImageModel: '', defaultVideoModel: ''
    } as never)
    await runAgent({ sessionId: 's3', message: 'hi' }, fakeWin())
    const err = lastSend(IPC.AGENT_ERROR)
    expect(err).toBeTruthy()
    expect(String(err!.error)).toContain('默认模型')
  })
})
