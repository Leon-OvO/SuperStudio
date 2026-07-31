import { describe, it, expect } from 'vitest'
import { mapClaudeLine, buildClaudeEnv } from './claude-runtime'

describe('mapClaudeLine', () => {
  it('assistant text block → delta', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } })
    expect(mapClaudeLine(line)).toEqual([{ kind: 'delta', text: '你好' }])
  })

  it('assistant 多 block（thinking + text + tool_use）按序归一', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking' }, { type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Bash' }] },
    })
    expect(mapClaudeLine(line)).toEqual([
      { kind: 'thinking' },
      { kind: 'delta', text: 'hi' },
      { kind: 'tool', toolName: 'Bash' },
    ])
  })

  it('system 带 session_id → session', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' })
    expect(mapClaudeLine(line)).toEqual([{ kind: 'session', sessionId: 'sess-123' }])
  })

  it('result 成功', () => {
    const line = JSON.stringify({ type: 'result', is_error: false, result: 'done', session_id: 's1' })
    expect(mapClaudeLine(line)).toEqual([{ kind: 'result', isError: false, text: 'done', sessionId: 's1' }])
  })

  it('result 错误标 isError', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'boom' })
    expect(mapClaudeLine(line)[0]).toMatchObject({ kind: 'result', isError: true })
  })

  it('control_request → control（带 request_id）', () => {
    const line = JSON.stringify({ type: 'control_request', request_id: 'req-9' })
    expect(mapClaudeLine(line)).toEqual([{ kind: 'control', controlRequestId: 'req-9' }])
  })

  it('无法解析的行跳过（不崩）', () => {
    expect(mapClaudeLine('not json {')).toEqual([])
    expect(mapClaudeLine('')).toEqual([])
  })

  it('未知 type → ignore', () => {
    expect(mapClaudeLine(JSON.stringify({ type: 'whatever' }))).toEqual([{ kind: 'ignore' }])
  })
})

describe('buildClaudeEnv', () => {
  it('直连注入：剥 /vN、发 x-api-key、清空 AUTH_TOKEN', () => {
    const env = buildClaudeEnv('https://api.supercode.help/v1', 'sk-real')
    // claude CLI 自补 /v1/messages，故必须剥掉传入的 /vN，否则 .../v1/v1/messages
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.supercode.help')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-real') // 发 x-api-key（镜像 master）
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('') // 挡住继承来的 bearer
  })

  it('尾斜杠 + /vN 一并规范化', () => {
    expect(buildClaudeEnv('https://api.supercode.help/v1/', 'k').ANTHROPIC_BASE_URL).toBe('https://api.supercode.help')
    expect(buildClaudeEnv('https://host/v2', 'k').ANTHROPIC_BASE_URL).toBe('https://host')
  })

  it('baseUrl 为空 → 不设 ANTHROPIC_BASE_URL（打官方端点）', () => {
    const env = buildClaudeEnv(undefined, 'sk-real')
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-real')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
  })

  it('剥离内部会话标记，保留 GIT_BASH_PATH', () => {
    const prev = { ...process.env }
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli'
    process.env.CLAUDE_CODE_SSE_PORT = '5000'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:/bash.exe'
    try {
      const env = buildClaudeEnv('https://api.supercode.help/v1', 'sk-real')
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
      expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined()
      // 直连：Bedrock/Vertex 开关剥离，强制走注入的 supercode 端点
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
      expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:/bash.exe')
    } finally {
      process.env = prev
    }
  })
})
