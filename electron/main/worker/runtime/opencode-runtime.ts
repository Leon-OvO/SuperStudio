import { spawn } from 'node:child_process'
import { IPC } from '../../../../src/shared/ipc-types'
import type { AgentSink } from '../../agent/sink'
import type { AgentRuntime, RuntimeTask, RuntimeResult } from './agent-runtime'
import { resolveRuntimeExecPath } from './discovery'
import { killProcessTree } from './proc'

/**
 * OpenCode 运行时（run 模式，pc-agent-runtime / PRD 第四部分 §9）。
 *
 * spawn 一次性 `opencode run --format json --dir <cwd> --auto -m ss/<model> <prompt>`，逐行解析
 * NDJSON 事件映射到既有 `AGENT_DELTA/PHASE/DONE/ERROR`。相比 serve 模式（常驻 HTTP server + SDK）
 * 更轻、无生命周期负担、与 ClaudeRuntime 同构（spawn + 行解析）。真实事件格式(v1.17.17)：
 *   step_start / text(part.text 全量) / step_finish(tokens) / error。
 *
 * **模型出口 = 直连上游**：经 `OPENCODE_CONFIG_CONTENT` env 内联注入 provider ss，baseURL 直指
 * `withApiVersion(provider.baseUrl)`（openai 兼容，保留 `/v1`——`@ai-sdk/openai-compatible` 自己补 `/chat/completions`），
 * 鉴权用真实 key。真实模型经 `-m ss/<model>` 直传，不经 BFF。
 *
 * **Windows**：`where opencode` 命中的是 shim(.cmd 的 %* 截断多行 prompt / 无扩展 #!/bin/sh 不可执行)，
 * 故用 discovery 派生的原生 opencode.exe 直接 spawn（deriveOpencodeNativeExe）。
 */

const isWin = process.platform === 'win32'

/** 一条 NDJSON 行解析出的归一事件。纯函数，便于单测。 */
export interface OpencodeMapped {
  kind: 'status' | 'delta' | 'tool' | 'usage' | 'error' | 'ignore'
  /** delta/text：该 part 的**全量**文本（run() 按 partId 做增量 diff）。 */
  fullText?: string
  partId?: string
  toolName?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  error?: string
}

interface OpencodePart {
  id?: string
  type?: string
  text?: string
  tool?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}
interface OpencodeEvent {
  type?: string
  part?: OpencodePart
  error?: unknown
}

/** 解析单行 NDJSON → 归一事件数组。无法 parse 的行返回 []（跳过，不崩）。 */
export function mapOpencodeEvent(line: string): OpencodeMapped[] {
  const t = line.trim()
  if (!t) return []
  let ev: OpencodeEvent
  try {
    ev = JSON.parse(t) as OpencodeEvent
  } catch {
    return []
  }
  switch (ev.type) {
    case 'step_start':
      return [{ kind: 'status' }]
    case 'text': {
      const p = ev.part
      if (p && typeof p.text === 'string') return [{ kind: 'delta', partId: p.id, fullText: p.text }]
      return [{ kind: 'ignore' }]
    }
    case 'tool':
    case 'tool_use': {
      const name = ev.part?.tool
      return [{ kind: 'tool', toolName: name }]
    }
    case 'step_finish': {
      const tk = ev.part?.tokens
      if (tk)
        return [
          {
            kind: 'usage',
            usage: {
              input: tk.input ?? 0,
              output: (tk.output ?? 0) + (tk.reasoning ?? 0),
              cacheRead: tk.cache?.read ?? 0,
              cacheWrite: tk.cache?.write ?? 0,
            },
          },
        ]
      return [{ kind: 'ignore' }]
    }
    case 'error':
      return [{ kind: 'error', error: describeError(ev.error) }]
    default:
      return [{ kind: 'ignore' }]
  }
}

/** OpenCode error 联合体 → 人类可读串。 */
function describeError(err: unknown): string {
  if (!err || typeof err !== 'object') return '运行时出错'
  const e = err as { name?: string; message?: string; data?: { message?: string } }
  return e.data?.message || e.message || e.name || '运行时出错'
}

/** 生图这类工具远超 opencode 的 MCP 默认超时（5s！），必须显式放宽，否则必然超时失败。
 *  取 300s：generateImage 自身上限 180s，留足往返与重试余量。 */
const MCP_TIMEOUT_MS = 300_000

/** provider ss 内联配置（直连上游，openai 兼容端点）+ 进程内 MCP 桥——经 OPENCODE_CONFIG_CONTENT 注入。
 *  baseUrl 保留 `/v1`（invoker 传 withApiVersion 的结果，@ai-sdk/openai-compatible 自补 `/chat/completions`）。
 *
 *  mcp 段把自研独有能力（生图/技能）接进 opencode 自带的工具循环——否则它只有一个聊天出口，
 *  「画只猫」既没有生图工具可调、也不知道用户装了哪些技能。schema 按 opencode 的 McpRemoteConfig：
 *  `{type:'remote', url, enabled, headers, oauth, timeout}`（远程走 StreamableHTTP，headers 经
 *  requestInit 下发）。`oauth:false` 关掉 401 时的 OAuth 自动探测——我们用的是 Bearer。 */
function buildConfigContent(
  baseUrl: string,
  apiKey: string,
  model: string,
  mcp?: { url: string; token: string }
): string {
  return JSON.stringify({
    provider: {
      ss: {
        npm: '@ai-sdk/openai-compatible',
        name: 'SuperStudio',
        options: { baseURL: baseUrl.replace(/\/+$/, ''), apiKey },
        models: { [model]: { name: model } },
      },
    },
    ...(mcp
      ? {
          mcp: {
            superstudio: {
              type: 'remote',
              url: mcp.url,
              enabled: true,
              headers: { Authorization: `Bearer ${mcp.token}` },
              oauth: false,
              timeout: MCP_TIMEOUT_MS,
            },
          },
        }
      : {}),
  })
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = 'opencode'

  async run(task: RuntimeTask, sink: AgentSink): Promise<RuntimeResult> {
    const { sessionId, cwd, model, providerId, providerName, upstream, message, signal, messageId, mcp } = task
    const runStart = Date.now()
    const phase = (p: 'connecting' | 'thinking' | 'responding' | 'tool', label: string, toolName?: string): void =>
      sink.send(IPC.AGENT_PHASE, { sessionId, phase: p, label, startedAt: Date.now(), ...(toolName ? { toolName } : {}) })

    phase('connecting', '启动运行时…')
    // 解析真实可执行路径（Windows 上派生原生 exe）。
    const resolved = await resolveRuntimeExecPath('opencode')
    // 安全不变量：**message(手机可控)绝不经 shell**——始终 shell:false + args 数组传参，杜绝命令注入。
    // Windows 上若拿不到原生 .exe(只有 .cmd/无扩展 shim)：既会截断多行 prompt、又若 shell 传参会注入，
    // 故直接拒绝执行而非降级到 shell。posix 用 resolved 或裸命令(shell:false 下 args 数组安全)。
    if (isWin && (!resolved || !/\.exe$/i.test(resolved))) {
      sink.send(IPC.AGENT_ERROR, {
        sessionId,
        error: '未找到 OpenCode 原生可执行文件，无法安全启动（请重新安装 opencode 后在设置里点刷新）',
      })
      return { text: '' }
    }
    const bin = resolved ?? 'opencode'
    // `--` 选项终止符：message(手机可控)是位置参数，首字符为 `-` 的提示词(「- 帮我…」「-h」)否则会被 opencode
    // 参数解析器当未知 flag → 任务失败/prompt 被吞。`--` 之后一律按位置参数，兼修首字符 `-` + 为参数注入加纵深。
    const args = ['run', '--format', 'json', '--dir', cwd, '--auto', '-m', `ss/${model}`, '--', message]

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PWD: cwd,
      OPENCODE_CONFIG_CONTENT: buildConfigContent(
        upstream.baseUrl ?? 'https://api.openai.com/v1',
        upstream.apiKey,
        model,
        mcp
      ),
    }

    const child = spawn(bin, args, { cwd, env, shell: false, windowsHide: true })

    // 管道错误吞噬（关键：防主进程崩溃）：killProcessTree(taskkill /T /F) 强杀时 stdout/stderr 可能 ECONNRESET，
    // stdin 可能 EPIPE；无监听器则冒泡成 Electron 主进程未捕获异常。失败由下面 close/error 兜底，静默即可。
    child.stdin.on('error', () => {})
    child.stdout.on('error', () => {})
    child.stderr.on('error', () => {})
    // 立即投递 EOF：opencode run 在非 TTY(stdin 是管道)下会 `await Bun.stdin.text()` 读 stdin 到 EOF 才继续，
    // 即使 prompt 已由 argv 位置参数给出。我们从不往 stdin 写(prompt 走 argv)，若不 end() 这个管道，子进程会
    // 永久阻塞等 EOF → 不产出、不退出 → close 不触发 → run() 永久挂起 → worker 执行槽与 aborter 条目泄漏。
    child.stdin.end()

    let full = ''
    let started = false
    let resultErr: string | null = null
    const emitted = new Map<string, number>() // partId → 已发出文本长度（全量→增量 diff）

    const onAbort = (): void => killProcessTree(child) // 杀整棵树，不留孤儿(Windows 用 taskkill /T /F)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const applyLine = (line: string): void => {
      for (const ev of mapOpencodeEvent(line)) {
        switch (ev.kind) {
          case 'status':
            if (!started) {
              started = true
              phase('responding', '输出中…')
            }
            break
          case 'delta': {
            if (!started) {
              started = true
              phase('responding', '输出中…')
            }
            const pid = ev.partId ?? '_'
            const text = ev.fullText ?? ''
            const prev = emitted.get(pid) ?? 0
            if (text.length > prev) {
              const delta = text.slice(prev)
              emitted.set(pid, text.length)
              full += delta
              sink.send(IPC.AGENT_DELTA, { sessionId, messageId, delta })
            }
            break
          }
          case 'tool':
            phase('tool', `执行 ${ev.toolName ?? '工具'}…`, ev.toolName)
            break
          case 'error':
            resultErr = ev.error ?? '运行时出错'
            break
          default:
            break // usage/ignore：不发消息（本地引擎不做计量）
        }
      }
    }

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
        stderrTail = (stderrTail + chunk).slice(-2000)
      })
      child.on('error', (err) => {
        resultErr = resultErr || err.message
        resolve()
      })
      child.on('close', (code: number | null) => {
        if (buf.trim()) applyLine(buf)
        // OpenCode 出错常 RC=0，靠 error 事件判失败；无 error 事件但也无输出时用 stderr 尾兜底。
        if (!resultErr && stderrTail.trim() && !full) resultErr = stderrTail.trim().slice(-500)
        // 非 0 退出且无正文无错：视为异常退出（崩溃/缺依赖/被杀），不误报空的成功。
        if (!resultErr && !full && code != null && code !== 0) resultErr = `运行时异常退出（code ${code}）`
        resolve()
      })
    })

    if (signal) signal.removeEventListener('abort', onAbort)

    // 用户取消:onAbort→killProcessTree 强杀→Windows taskkill /F 非0退出会命中上面「运行时异常退出」误报崩溃、
    // POSIX SIGTERM(code=null)则发空 AGENT_DONE——都是取消后不该发的终帧。取消终态归上层 invoker(AGENT_STOP),
    // 运行时 abort 后静默退出。(与 claude-runtime 同款守卫)
    if (signal?.aborted) return { text: full }

    // MCP 桥采集到的工具流水（生图等产物的唯一来源——opencode 的事件流只有工具名没有结果）。
    const toolCallLog = task.collectToolCalls?.() ?? []

    // 有产物就不算失败：图已经生成并入库，只是模型没再输出文本，报错会把图一起丢掉。
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
