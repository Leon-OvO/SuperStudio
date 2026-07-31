import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '../../../../src/shared/ipc-types'
import type { AgentSink } from '../../agent/sink'
import type { AgentRuntime, RuntimeTask, RuntimeResult } from './agent-runtime'
import { killProcessTree } from './proc'

/**
 * Claude Code 运行时（pc-agent-runtime / PRD 第四部分 §9）。
 *
 * spawn 平台原生 `claude` CLI，走双向 stream-json 协议驱动，映射到既有 `AGENT_DELTA/PHASE/DONE/ERROR`。
 *   claude -p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions
 *
 * **模型出口 = 直连 supercode**（镜像 master `createAnthropic`）：不 patch CLI，只注入 env——
 *   ANTHROPIC_BASE_URL=<baseUrl 剥 /vN>、ANTHROPIC_API_KEY=<真实 key>（发 `x-api-key`）、ANTHROPIC_AUTH_TOKEN=''。
 *   claude CLI 会对 ANTHROPIC_BASE_URL 再补 `/v1/messages`，故必须剥掉 invoker 传入的 `/vN` 尾段
 *   （否则打成 `.../v1/v1/messages`）。真实模型经 `--model` 直传。
 *
 * 关键坑（multica 实证，见 reference-multica-runtime）：
 * - 写 stdin 必须独立于 stdout 读（Node 天然异步，直接 write 即可）；首条消息后**不关 stdin**，
 *   以便回应运行时中途发来的 control_request。
 * - env 剥离内部会话标记 CLAUDECODE/CLAUDE_CODE_ENTRYPOINT/EXECPATH/SESSION_ID/SSE_PORT，
 *   但**保留 CLAUDE_CODE_GIT_BASH_PATH**（Windows 删了 CLI 找不到 bash 直接崩）。
 */

/** 剥离的 env：内部会话标记（防子进程误判自己在嵌套/续接会话）+ 会绕过直连注入的模型出口开关。
 *  CLAUDE_CODE_GIT_BASH_PATH 不在此列，保留（Windows 删了 claude 找不到 bash 会崩）。 */
const STRIP_ENV = new Set([
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  // 直连不变量：若继承用户本地这些开关，claude 会走 Bedrock/Vertex 绕过我们注入的 supercode 端点。
  // 强制剥离，只认注入的 ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY。
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
])

/**
 * 构造子进程环境：继承 + 剥内部标记 + 注入直连 supercode 的 env（镜像 master `createAnthropic`）。
 * - `baseUrl`：invoker 传 `withApiVersion(provider.baseUrl)`（带 `/v1`）。claude CLI 自己会补 `/v1/messages`，
 *   故这里剥掉尾部 `/vN`（否则 `.../v1/v1/messages`）；`baseUrl` 为空则不设，打官方 api.anthropic.com。
 * - `apiKey` → `ANTHROPIC_API_KEY`，且强制 `ANTHROPIC_AUTH_TOKEN=''`：claude 在 API_KEY 存在时发 `x-api-key`
 *   （与 master 一致）；清空 AUTH_TOKEN 挡住继承来的 bearer 覆盖。
 */
export function buildClaudeEnv(baseUrl: string | undefined, apiKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_ENV.has(k)) continue
    env[k] = v
  }
  // 端点完全由 provider 记录决定，别让继承自用户 shell 的 ANTHROPIC_BASE_URL 劫持直连（同 Bedrock/Vertex 剥离哲学）。
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '') // 剥 /vN，见文件头注释
  else delete env.ANTHROPIC_BASE_URL // 无 baseUrl → 打官方 api.anthropic.com
  env.ANTHROPIC_API_KEY = apiKey // 发 x-api-key（镜像 master buildAnthropicModel）
  env.ANTHROPIC_AUTH_TOKEN = '' // 挡住继承来的 bearer，避免覆盖 x-api-key
  return env
}

/** 一条 stream-json 行解析出的归一事件（多个 content block → 多个事件）。纯函数，便于单测。 */
export interface ClaudeMappedEvent {
  kind: 'delta' | 'thinking' | 'tool' | 'session' | 'retry' | 'mcp' | 'result' | 'control' | 'ignore'
  text?: string
  toolName?: string
  sessionId?: string
  isError?: boolean
  controlRequestId?: string
  /** retry：第几次重试 / 上限 / 上游状态码——必须让用户看见，否则退避期像死机。 */
  attempt?: number
  maxRetries?: number
  errorStatus?: number
  /** mcp：init 行里连接失败的 MCP server 名（桥挂了却静默＝「有桥没工具」那类坑）。 */
  failedMcpServers?: string[]
}

interface ClaudeContentBlock {
  type?: string
  text?: string
  name?: string
}
interface ClaudeSDKMessage {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  result?: string
  request_id?: string
  attempt?: number
  max_retries?: number
  error_status?: number
  error?: string
  mcp_servers?: Array<{ name?: string; status?: string }>
  message?: { content?: ClaudeContentBlock[] }
}

/**
 * 解析单行 stream-json → 归一事件数组。无法 JSON.parse 的行返回 []（跳过，不崩）。
 * 事件类型分派：assistant(遍历 content)、system(session_id)、result(终局)、control_request(需回应)。
 */
export function mapClaudeLine(line: string): ClaudeMappedEvent[] {
  const t = line.trim()
  if (!t) return []
  let obj: ClaudeSDKMessage
  try {
    obj = JSON.parse(t) as ClaudeSDKMessage
  } catch {
    return []
  }
  switch (obj.type) {
    case 'assistant': {
      const blocks = obj.message?.content ?? []
      const out: ClaudeMappedEvent[] = []
      for (const b of blocks) {
        if (b.type === 'text' && b.text) out.push({ kind: 'delta', text: b.text })
        else if (b.type === 'thinking') out.push({ kind: 'thinking' })
        else if (b.type === 'tool_use') out.push({ kind: 'tool', toolName: b.name })
      }
      return out
    }
    case 'system': {
      // 别再把所有 system 行压成一个被忽略的 session 事件 —— 上游 401/5xx 时 claude 不退出，
      // 而是走 10 次指数退避重试，期间**只**发 system/api_retry(实测间隔可达 37s)。全吞掉的话
      // 界面就永远停在「启动运行时…」，看着像死机，实际是在静默重试(用户实测 40s+ 正是此)。
      if (obj.subtype === 'api_retry') {
        return [{
          kind: 'retry',
          attempt: obj.attempt,
          maxRetries: obj.max_retries,
          errorStatus: obj.error_status,
          text: obj.error,
        }]
      }
      const out: ClaudeMappedEvent[] = []
      // init 行带 MCP 连接结果：桥挂了要说出来，否则就是「有桥却没有生图/技能」的静默失能。
      const failed = (obj.mcp_servers ?? []).filter(s => s.status && s.status !== 'connected')
        .map(s => s.name || '?')
      if (failed.length) out.push({ kind: 'mcp', failedMcpServers: failed })
      if (obj.session_id) out.push({ kind: 'session', sessionId: obj.session_id })
      return out
    }
    case 'result':
      return [{ kind: 'result', isError: !!obj.is_error, text: obj.result, sessionId: obj.session_id }]
    case 'control_request':
      return obj.request_id ? [{ kind: 'control', controlRequestId: obj.request_id }] : []
    default:
      return [{ kind: 'ignore' }]
  }
}

export class ClaudeRuntime implements AgentRuntime {
  readonly name = 'claude'

  async run(task: RuntimeTask, sink: AgentSink): Promise<RuntimeResult> {
    const { sessionId, cwd, model, providerId, providerName, upstream, message, signal, messageId, mcp } = task
    const runStart = Date.now()
    const phase = (p: 'connecting' | 'thinking' | 'responding' | 'tool', label: string, toolName?: string): void =>
      sink.send(IPC.AGENT_PHASE, { sessionId, phase: p, label, startedAt: Date.now(), ...(toolName ? { toolName } : {}) })

    // 协议门控（belt-and-suspenders，主门控在 invoker）：claude CLI 只说 Anthropic 协议。
    if (upstream.protocol !== 'anthropic') {
      sink.send(IPC.AGENT_ERROR, { sessionId, error: 'Claude Code 运行时只支持 Anthropic 协议模型，请切换 OpenCode 或改用 Claude 系模型' })
      return { text: '' }
    }

    const isWin = process.platform === 'win32'
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--model', model, // 真实模型 id（直连 supercode）
    ]

    // 进程内 MCP 桥（生图/技能）。schema 按 Claude Code 2.x 实测：
    // `{"mcpServers":{name:{type:"http",url,headers}}}`——注意与 opencode 的 `type:"remote"` 不同名。
    //
    // `--mcp-config` 也收 JSON 字符串，但这里**必须走临时文件**：Windows 上本适配器 shell:true
    // （claude 是 .cmd shim），一坨带引号的 JSON 过 cmd.exe 会被引号规则啃坏；文件路径没这问题。
    // 刻意不加 `--strict-mcp-config`：那会把用户自己配的 MCP server 一并屏蔽掉。
    let mcpConfigPath: string | null = null
    if (mcp) {
      try {
        mcpConfigPath = path.join(os.tmpdir(), `ss-mcp-${randomUUID()}.json`)
        fs.writeFileSync(
          mcpConfigPath,
          JSON.stringify({
            mcpServers: {
              superstudio: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
            },
          }),
          'utf8'
        )
        // Windows 上本适配器 shell:true，而 Node 对 shell 模式的参数**只拼接不转义**（见 DEP0190）：
        // 临时目录一旦含空格（"C:\Users\Foo Bar\..."）路径就会被拆成两个参数 → claude 起不来。
        // 自己加引号，cmd.exe 解析时会剥掉。
        args.push('--mcp-config', isWin ? `"${mcpConfigPath}"` : mcpConfigPath)
      } catch (e) {
        // 写不出配置不该让整轮对话失败——降级成没有独有工具的纯 CLI 会话。
        console.warn('[claude-runtime] MCP 配置写入失败，本轮无生图/技能：', (e as Error).message)
        mcpConfigPath = null
      }
    }

    // 用 settings 层钉死模型出口 —— **只靠 env 注入是不够的**（实测）。
    // claude 会把 `~/.claude/settings.json` 的 `env` 块**盖在**继承的进程 env 之上：用户那份
    // settings 里若写了自己的 ANTHROPIC_BASE_URL/AUTH_TOKEN，我们注入的 baseUrl 会被整个丢弃，
    // 而 apiKey 仍以 x-api-key 发出 → 端点与凭据错配 → 401 → claude 进 10 次退避重试而不退出。
    // A/B 实证：仅改 CLAUDE_CONFIG_DIR，真实配置目录下我们注入的端点收到 0 个请求；干净目录下正常命中。
    // `--settings` 是附加且最高优先级，用户自己的 hooks/权限/MCP 等其余设置照常生效（比
    // `--setting-sources` 或换 CLAUDE_CONFIG_DIR 更克制，那两者会把用户整层设置一并丢掉）。
    let settingsPath: string | null = null
    try {
      settingsPath = path.join(os.tmpdir(), `ss-claude-settings-${randomUUID()}.json`)
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          env: {
            ...(upstream.baseUrl
              ? { ANTHROPIC_BASE_URL: upstream.baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '') }
              : {}),
            ANTHROPIC_API_KEY: upstream.apiKey,
            ANTHROPIC_AUTH_TOKEN: '', // 压掉用户 settings 里的 bearer，避免与 x-api-key 打架
          },
        }),
        'utf8'
      )
      args.push('--settings', isWin ? `"${settingsPath}"` : settingsPath) // 引号理由同 --mcp-config
    } catch (e) {
      console.warn('[claude-runtime] settings 写入失败，回退纯 env 注入：', (e as Error).message)
      settingsPath = null
    }

    phase('connecting', '启动运行时…')
    const child = spawn('claude', args, {
      cwd,
      env: buildClaudeEnv(upstream.baseUrl, upstream.apiKey),
      shell: isWin, // Windows 上 claude 是 .cmd/npm shim，需 shell 解析
      windowsHide: true,
    })

    // 管道错误吞噬（关键：防主进程崩溃）：进程已退出/被 killProcessTree 强杀时，向 stdin 写(初始 prompt 或
    // control_response)会异步发 EPIPE、stdout/stderr 会 ECONNRESET；无监听器则冒泡成 Electron 主进程未捕获异常。
    // 这些失败一律由下面的 close/error 兜底，管道错误静默即可。try/catch 只兜同步抛出，兜不住这些异步事件。
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})

    let full = ''
    let started = false
    let resultErr: string | null = null

    // 喂 prompt：单行 JSON user 消息 + 换行；发完**不关 stdin**（留着回 control_request）。
    const userMsg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: message }] },
    })
    try {
      child.stdin.write(userMsg + '\n')
    } catch {
      /* 写失败由 close/error 兜底 */
    }

    // Windows 上 shell:true 的直接子进程是 cmd.exe，claude(node) 是其孙进程；只 kill 父会留孤儿继续烧
    // token/操控电脑，且孙进程持 stdout 管道会让 close 不触发、槽不释放 → 用进程树 kill。
    const onAbort = (): void => killProcessTree(child)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    // 本轮收工：投 EOF 让 claude 自己退出。
    //
    // 关键(实测)：`--input-format stream-json` 下 claude 把 stdin 当消息流，**即使本轮 result 已发出
    // 也会继续等下一条消息**——不投 EOF 就永不退出 → close 不触发 → run() 永久挂起 → 界面一直转圈。
    // (对照实验：stdin 保持打开时它在 result 后又活了 25s，直到 EOF 才立刻退出。)
    // 不能一开始就 end()：turn 进行中要靠 stdin 回写 control_response 放行工具。
    // 看门狗兜底：EOF 后仍不退(卡在清理/子进程持管道)就杀进程树，绝不留僵尸吊死执行槽。
    let lastRetry: string | null = null // 最后一次重试的上游错误，重试耗尽时用它报真因
    let retryCount = 0
    let mcpFailed: string[] = []
    let finished = false
    let exitWatchdog: ReturnType<typeof setTimeout> | null = null
    const finishTurn = (): void => {
      if (finished) return
      finished = true
      try { child.stdin.end() } catch { /* 进程已退，close 会兜底 */ }
      exitWatchdog = setTimeout(() => killProcessTree(child), 5000)
      exitWatchdog.unref?.()
    }

    const applyLine = (line: string): void => {
      for (const ev of mapClaudeLine(line)) {
        switch (ev.kind) {
          case 'delta':
            if (!started) {
              started = true
              phase('responding', '输出中…')
            }
            if (ev.text) {
              full += ev.text
              sink.send(IPC.AGENT_DELTA, { sessionId, messageId, delta: ev.text })
            }
            break
          case 'thinking':
            if (!started) phase('thinking', '思考中…')
            break
          case 'tool':
            phase('tool', `执行 ${ev.toolName ?? '工具'}…`, ev.toolName)
            break
          case 'retry': {
            // 让退避期可见：否则用户面对的是几十秒无任何反馈的「假死」。
            const n = ev.attempt ?? 0
            const max = ev.maxRetries ?? 0
            const code = ev.errorStatus ? `${ev.errorStatus} ` : ''
            lastRetry = `${code}${ev.text || '上游错误'}`.trim()
            retryCount = n || retryCount + 1
            phase('connecting', `上游${code}错误，正在重试（第 ${n}/${max} 次）…`)
            break
          }
          case 'mcp':
            // 桥没连上就明说，别让「没有生图工具」以「模型不肯画」的样子呈现。
            console.warn(`[claude-runtime] MCP 未连接: ${ev.failedMcpServers?.join(', ')}`)
            mcpFailed = ev.failedMcpServers ?? []
            break
          case 'result':
            if (ev.isError) resultErr = ev.text || '运行时返回错误'
            finishTurn() // result = 本轮终帧，投 EOF 收工（否则 claude 会一直等下一条输入）
            break
          case 'control':
            // 无人值守自动放行：回写 control_response（best-effort，具体协议以真机验证为准）。
            if (ev.controlRequestId) {
              try {
                child.stdin.write(
                  JSON.stringify({
                    type: 'control_response',
                    response: { subtype: 'success', request_id: ev.controlRequestId, response: { behavior: 'allow' } },
                  }) + '\n'
                )
              } catch {
                /* ignore */
              }
            }
            break
          default:
            break
        }
      }
    }

    // 逐行读 stdout（stream-json 单行可能很大，靠换行切）。
    await new Promise<void>((resolve) => {
      let buf = ''
      let stderrTail = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          applyLine(line)
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000) // 保留尾部供报错拼接
      })
      child.on('error', (err) => {
        resultErr = resultErr || err.message
        resolve()
      })
      child.on('close', (code: number | null) => {
        if (exitWatchdog) { clearTimeout(exitWatchdog); exitWatchdog = null } // 已干净退出，别再杀
        if (buf.trim()) applyLine(buf) // 冲刷残留
        if (!resultErr && stderrTail.trim() && !full) resultErr = stderrTail.trim().slice(-500)
        // 重试打光后如实报真因，别把上游 401/5xx 说成「异常退出（code N）」。
        if (!resultErr && !full && lastRetry) {
          resultErr = `上游请求失败（已重试 ${retryCount} 次仍未成功）：${lastRetry}`
        }
        // 非 0 退出且无正文无错：视为异常退出，不误报空的成功。
        if (!resultErr && !full && code != null && code !== 0) resultErr = `运行时异常退出（code ${code}）`
        // 桥没连上时补一句：否则「不会生图/技能」会被误当成模型不听话。
        if (resultErr && mcpFailed.length) {
          resultErr += `（另：本机工具服务未连接：${mcpFailed.join(', ')}，本轮无生图/技能）`
        }
        resolve()
      })
    })

    if (signal) signal.removeEventListener('abort', onAbort)

    // 两个临时文件都含凭据（MCP 的 run token / 上游 apiKey），用完立刻删。
    for (const p of [mcpConfigPath, settingsPath]) {
      if (p) { try { fs.unlinkSync(p) } catch { /* 已不在/占用中，无妨 */ } }
    }

    // 用户取消:onAbort→killProcessTree 强杀→Windows taskkill /F 令非0退出(code=1、signal=null),POSIX SIGTERM→code=null。
    // 前者会命中上面「非0退出→运行时异常退出」误报成崩溃、后者会发出空 AGENT_DONE——两者都是取消后不该发的终帧,
    // 取消的终态归上层 invoker(AGENT_STOP),运行时 abort 后静默退出、不 emit。
    if (signal?.aborted) return { text: full }

    // MCP 桥采集到的工具流水（Claude Code 的 stream-json 里 tool_result 走 `user` 行、当前被忽略，
    // 产物同样只能由进程内的桥提供）。有产物就不算失败，否则报错会把已生成的图一起丢掉。
    const toolCallLog = task.collectToolCalls?.() ?? []

    if (resultErr && !full && !toolCallLog.length) {
      sink.send(IPC.AGENT_ERROR, { sessionId, error: resultErr })
      return { text: '' }
    }

    sink.send(IPC.AGENT_DONE, {
      sessionId,
      messageId,
      content: full,
      ...(toolCallLog.length ? { toolCallLog } : {}),
      meta: { model, providerId, providerName, durationMs: Date.now() - runStart, runtime: this.name },
    })
    return { text: full, ...(toolCallLog.length ? { toolCallLog } : {}) }
  }

  async dispose(): Promise<void> {
    // 每 run 独立起停子进程，无常驻资源。
  }
}
