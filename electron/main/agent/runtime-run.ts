import { app, type BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { IPC, RUNTIME_ADAPTERS_READY, type RuntimeKind } from '../../../src/shared/ipc-types'
import { getSettings, getProviders } from '../services/store'
import { effectiveProtocol, withApiVersion } from '../services/llm'
import { readSessionWorkingDir } from './engine'
import { makeWindowSink } from './sink'
import type { AgentRuntime, RuntimeTask } from '../worker/runtime/agent-runtime'
import { ClaudeRuntime } from '../worker/runtime/claude-runtime'
import { OpenCodeRuntime } from '../worker/runtime/opencode-runtime'
import { ensureBridgeStarted, registerRun, unregisterRun, getRunToolCalls } from '../services/mcp-bridge'
import { dbRun, dbGet } from '../db/sqlite'

/**
 * 本地 Agent 运行时入口（PRD 第四部分·Agent 运行时底层升级，去 BFF 版）。
 *
 * 用户在设置里选了一款本机 code CLI（Claude Code / OpenCode）当对话引擎后，普通文本/代码会话经此
 * 派给该 CLI 执行——**直连 supercode**（凭据来源同 master `createLLMClient`：从 provider 记录解析
 * baseUrl/apiKey/protocol/真实模型，经子进程 env 注入），不经 BFF/云 worker/配对。
 *
 * 与自研 `runAgent` 的分工：运行时**只接管硬活文本/代码**；显式媒体轮（forceImage）+ Computer Use 仍走
 * 自研直连（调用方门控，不派给运行时）。附件/思考档/群聊/员工/KB 由运行时自带的工具循环负责，此处不透传。
 *
 * **例外（进程内 MCP 桥）**：生图与技能经 `services/mcp-bridge` 暴露给 CLI 的工具循环——否则 CLI 只有
 * 一个聊天出口，「画只猫」既无生图工具可调、也不知道用户装了哪些技能（正是用户实测踩到的坑）。工具跑在
 * 主进程内，产物因此能直接落画廊并回到聊天气泡，无需解析 CLI 的输出（它本就丢弃工具结果）。
 */

/** 每会话一个 AbortController，供 `stopRuntimeRun` 取消。 */
const runtimeRuns = new Map<string, AbortController>()

/** 全局默认是否启用了「本机运行时」当引擎：已选 defaultRuntime 且该运行时有可执行适配器才算。
 *  返回启用的运行时 kind；未启用返回 null（调用方回退自研 runAgent）。 */
export function runtimeEnabled(): RuntimeKind | null {
  const chosen = getSettings().defaultRuntime ?? null
  return chosen && RUNTIME_ADAPTERS_READY.includes(chosen) ? chosen : null
}

/** 这条会话该用哪个引擎：**会话覆盖优先于全局默认**。
 *  - 会话选了 'builtin' → 显式钉住内置自研引擎，返回 null（即便全局选了某个 CLI）。
 *  - 会话选了某 CLI 且它可用 → 用它。
 *  - 会话未设 → 跟随全局默认。
 *  每轮实时读库，所以切换下一轮即生效，无需重启或通知。 */
export function runtimeForSession(sessionId: string): RuntimeKind | null {
  let override: string | null = null
  try {
    override = dbGet<{ runtime: string | null }>(`SELECT runtime FROM sessions WHERE id = ?`, [sessionId])?.runtime ?? null
  } catch {
    /* 老库/无该行：跟随全局 */
  }
  if (override === 'builtin') return null
  if (override && RUNTIME_ADAPTERS_READY.includes(override as RuntimeKind)) return override as RuntimeKind
  return runtimeEnabled()
}

export interface RuntimeRunArgs {
  sessionId: string
  message: string
  /** 可选覆盖（渲染层 ChatHeader 选择器）；缺省取 settings.defaultChat*。 */
  providerId?: string
  modelId?: string
  /** 由调用方（ipc/agent）解析好的引擎；缺省时本函数自行按会话解析。 */
  kind?: RuntimeKind
}

/** 把一条会话派给本机运行时执行。全程事件经 win.webContents 出（AGENT_DELTA/PHASE/DONE/ERROR），
 *  与自研 runAgent 一致，渲染层无感。落库（user + assistant 行）由本函数负责，否则重开对话历史丢。 */
export async function runViaRuntime(args: RuntimeRunArgs, win: BrowserWindow): Promise<void> {
  const { sessionId, message } = args
  const sink = makeWindowSink(win)
  const fail = (error: string): void => sink.send(IPC.AGENT_ERROR, { sessionId, error })

  const kind = args.kind ?? runtimeForSession(sessionId)
  if (!kind) return fail('未启用本机运行时') // 理论上调用方已门控，兜底

  const settings = getSettings()
  const providerId = args.providerId || settings.defaultChatProviderId
  const modelId = args.modelId || settings.defaultChatModel
  if (!modelId) return fail('未设置默认对话模型，无法启动运行时')

  const provider = getProviders().find((p) => p.id === providerId)
  if (!provider) return fail('未找到所选模型的服务商配置，请到设置里检查')

  // 协议门控（镜像 master effectiveProtocol）——硬报错不静默降级：
  //   - gemini：没有对应 code CLI，运行时不支持。
  //   - claude 运行时 + 非 anthropic 协议：Claude Code 只说 Anthropic 协议。
  const protocol = effectiveProtocol(provider, modelId)
  if (protocol === 'gemini') {
    return fail('当前默认模型是 Gemini 协议，暂无对应的运行时；请切换模型或清除运行时选择')
  }
  if (kind === 'claude' && protocol !== 'anthropic') {
    return fail('默认模型不是 Claude 系，无法用 Claude Code 运行时；请切换到 OpenCode 或改用 Claude 模型')
  }

  // 工作目录：优先会话 pin 的目录（与内置引擎产物同落点），否则 per-session 隔离沙箱。
  let cwd = readSessionWorkingDir(sessionId)
  if (!cwd) {
    cwd = path.join(app.getPath('userData'), 'runtime-workspace', sessionId)
    try {
      fs.mkdirSync(cwd, { recursive: true })
    } catch (e) {
      return fail(`无法创建运行时工作目录：${(e as Error).message}`)
    }
  }

  // 落 user 行（与 engine 一致，非 groupTurn）——run 前落，重开对话不丢提问。
  try {
    dbRun(`INSERT INTO messages (id, session_id, role, content, attachments, created_at) VALUES (?, ?, 'user', ?, ?, ?)`, [
      randomUUID(),
      sessionId,
      message,
      null,
      Date.now(),
    ])
  } catch (e) {
    return fail(`保存用户消息失败：${(e as Error).message}`)
  }

  // 助手消息 id：流式 DELTA/DONE 与落库共用，避免分叉。
  const messageId = randomUUID()
  const taskId = randomUUID()

  // 新 run 抢占同会话旧 run（防两条流交错），并注册以便取消。
  runtimeRuns.get(sessionId)?.abort()
  const abort = new AbortController()
  runtimeRuns.set(sessionId, abort)

  const baseUrl = withApiVersion(provider.baseUrl) // 带 /v1（claude 适配器会剥 /vN、opencode 保留）

  // 起进程内 MCP 桥并为本 run 铸一枚一次性 token（生图/技能的入口）。桥起不来不该让整轮对话失败——
  // 降级成「没有独有工具的纯 CLI 会话」，与本次改动前的行为一致。
  let mcp: { url: string; token: string } | undefined
  let mcpToken: string | undefined
  try {
    const url = await ensureBridgeStarted()
    mcpToken = registerRun({ sessionId, messageId, sink, signal: abort.signal })
    mcp = { url, token: mcpToken }
  } catch (e) {
    console.warn('[runtime] MCP 桥启动失败，本轮无生图/技能：', (e as Error).message)
  }

  const task: RuntimeTask = {
    sessionId,
    taskId,
    message,
    cwd,
    messageId,
    model: modelId,
    providerId,
    providerName: provider.name,
    upstream: { baseUrl, apiKey: provider.apiKey, protocol: protocol === 'anthropic' ? 'anthropic' : 'openai' },
    mcp,
    collectToolCalls: () => getRunToolCalls(mcpToken),
    signal: abort.signal,
  }

  const runtime: AgentRuntime = kind === 'opencode' ? new OpenCodeRuntime() : new ClaudeRuntime()
  try {
    const result = await runtime.run(task, sink)
    const toolCallLog = result.toolCallLog ?? []
    // 落 assistant 行——仅当未被取消、且本 run 仍是该会话的当前 run（未被新 run 抢占）。
    // 判据是「有正文**或**有工具产物」：纯出图轮模型可能一个字都不说，只按正文判会把整条(连同图)丢掉。
    // 运行时已自行发 AGENT_DONE；invoker 只负责持久化，不重复发终帧。
    const worthSaving = !!result.text.trim() || toolCallLog.length > 0
    if (!abort.signal.aborted && runtimeRuns.get(sessionId) === abort && worthSaving) {
      try {
        // meta 一并落库：否则重开对话时「这条是哪个引擎答的」「耗时/服务商」全丢
        // （DONE 里带了，但那是一次性事件，不进历史）。
        const meta = {
          model: modelId,
          providerId,
          providerName: provider.name,
          runtime: kind,
        }
        dbRun(
          `INSERT INTO messages (id, session_id, role, content, tool_calls, meta, created_at, model) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
          [
            messageId,
            sessionId,
            result.text,
            toolCallLog.length ? JSON.stringify(toolCallLog) : null,
            JSON.stringify(meta),
            Date.now(),
            modelId,
          ]
        )
        dbRun(`UPDATE sessions SET updated_at = ? WHERE id = ?`, [Date.now(), sessionId])
      } catch (e) {
        console.warn('[runtime] persist assistant failed:', (e as Error).message)
      }
    }
  } catch (e) {
    if (!abort.signal.aborted) fail((e as Error).message || String(e))
  } finally {
    unregisterRun(mcpToken) // token 一次性：run 结束立刻失效
    try {
      await runtime.dispose()
    } catch {
      /* ignore */
    }
    if (runtimeRuns.get(sessionId) === abort) runtimeRuns.delete(sessionId)
  }
}

/** 取消某会话的运行时 run（AGENT_STOP 扇出调用；非运行时会话 no-op）。 */
export function stopRuntimeRun(sessionId: string): void {
  runtimeRuns.get(sessionId)?.abort()
}
