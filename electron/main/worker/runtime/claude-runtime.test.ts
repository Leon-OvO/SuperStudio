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

  // 上游 401/5xx 时 claude 不退出，而是走 10 次指数退避重试，期间**只**发 system/api_retry。
  // 早先把所有 system 行压成被忽略的 session 事件 → 界面永远停在「启动运行时…」，看着像死机
  // （用户实测 40s+ 无反馈，实为静默重试）。这条锁死「重试必须可见」。
  it('system/api_retry → retry（带次数与上游状态码，绝不可再被吞掉）', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'api_retry',
      attempt: 3, max_retries: 10, error_status: 401, error: 'authentication_failed',
    })
    expect(mapClaudeLine(line)).toEqual([
      { kind: 'retry', attempt: 3, maxRetries: 10, errorStatus: 401, text: 'authentication_failed' },
    ])
  })

  it('init 行里未连接的 MCP server 要暴露（桥挂了却静默＝「有桥没生图」那类坑）', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'init', session_id: 's1',
      mcp_servers: [{ name: 'superstudio', status: 'failed' }, { name: 'other', status: 'connected' }],
    })
    expect(mapClaudeLine(line)).toEqual([
      { kind: 'mcp', failedMcpServers: ['superstudio'] },
      { kind: 'session', sessionId: 's1' },
    ])
  })

  it('init 行 MCP 全部连上 → 只出 session，不噪声', () => {
    const line = JSON.stringify({
      type: 'system', subtype: 'init', session_id: 's1',
      mcp_servers: [{ name: 'superstudio', status: 'connected' }],
    })
    expect(mapClaudeLine(line)).toEqual([{ kind: 'session', sessionId: 's1' }])
  })
})

describe('buildClaudeEnv', () => {
  it('直连注入：剥 /vN、发 x-api-key、清空 AUTH_TOKEN', () => {
    const env = buildClaudeEnv('https://api.example.com/v1', 'sk-real')
    // claude CLI 自补 /v1/messages，故必须剥掉传入的 /vN，否则 .../v1/v1/messages
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-real') // 发 x-api-key（镜像 master）
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('') // 挡住继承来的 bearer
  })

  it('尾斜杠 + /vN 一并规范化', () => {
    expect(buildClaudeEnv('https://api.example.com/v1/', 'k').ANTHROPIC_BASE_URL).toBe('https://api.example.com')
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
      const env = buildClaudeEnv('https://api.example.com/v1', 'sk-real')
      expect(env.CLAUDECODE).toBeUndefined()
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
      expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined()
      // 直连：Bedrock/Vertex 开关剥离，强制走注入的上游端点
      expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
      expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
      expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:/bash.exe')
    } finally {
      process.env = prev
    }
  })
})
