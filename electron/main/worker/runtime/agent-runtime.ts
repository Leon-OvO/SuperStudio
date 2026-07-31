import type { AgentSink } from '../../agent/sink'

/**
 * 外部 code-agent 运行时抽象（PRD 第四部分·Agent 运行时底层升级）。
 *
 * 背景：自研 `agent/engine.ts`（单 streamText 扁平工具循环，无子代理/规划/上下文压缩）
 * 跑「硬活」（代码/多步工程/文件重构）能力弱。方案：让用户在本机选一款专业 code CLI
 * （Claude Code / OpenCode）当对话引擎，跑硬活时把这条会话派给它执行。
 *
 * **模型出口 = 直连 supercode**（与 master `createLLMClient` 同一凭据来源）：invoker 从
 * provider 记录解析 `{baseUrl, apiKey, protocol, model}`，经子进程 env 注入 CLI——**不经 BFF**。
 *
 * 事件统一映射到既有 `AGENT_DELTA/PHASE/DONE/ERROR`（走传入的 {@link AgentSink}），
 * 渲染层与自研 runAgent 无感。
 *
 * 路由策略（见 project-agent-runtime-pivot 记忆）：仅文本/代码硬活走运行时；媒体（出图/视频/
 * 画布/小红书）+ Computer Use 仍走成熟的自研直连。运行时不接管这些模态。
 */
export interface RuntimeTask {
  /** 本地会话 id——事件 payload.sessionId 用它，与 runAgent 对齐。 */
  sessionId: string
  /** 任务 id——仅用于日志/取消/端口派生。 */
  taskId: string
  /** 用户消息（提示词）。 */
  message: string
  /** 工作目录（隔离沙箱，代码类任务在此读写）。 */
  cwd: string
  /** 助手消息 id——invoker 生成，流式 `AGENT_DELTA/DONE` 与落库共用同一个 id（否则流式与持久化分叉）。 */
  messageId: string
  /** 真实模型 id（直连出口，非中性档）——claude 走 `--model`、opencode 走 `-m ss/<model>`。 */
  model: string
  /** 真实 provider（DONE meta 回显用）。 */
  providerId: string
  providerName: string
  /** 直连上游凭据（镜像 `createLLMClient`）：
   *  - `baseUrl`：invoker 传 `withApiVersion(provider.baseUrl)`（带 `/v1`）；claude 适配器剥 `/vN`、opencode 保留。为空=打官方端点。
   *  - `apiKey`：真实 key（claude 发 `x-api-key`、opencode 走 openai-compat）。
   *  - `protocol`：CLI 协议门控（claude 只服务 anthropic）。 */
  upstream: { baseUrl?: string; apiKey: string; protocol: 'anthropic' | 'openai' }
  /** 进程内 MCP 桥（services/mcp-bridge）——把自研独有能力（生图/技能）暴露给 CLI 的工具循环。
   *  适配器把它注入 CLI 的 MCP 配置；`token` 是本次 run 的一次性凭据，**不得落日志**。 */
  mcp?: { url: string; token: string }
  /** 取回本次 run 经 MCP 桥产生的工具流水。由 invoker 注入（适配器因此不必依赖桥模块）。 */
  collectToolCalls?: () => RuntimeToolCall[]
  /** 取消信号——abort 后运行时应尽快停流并释放。 */
  signal?: AbortSignal
}

export interface RuntimeToolCall {
  toolName: string
  args: Record<string, unknown>
  result: unknown
}

export interface RuntimeResult {
  /** 汇总的助手文本（用于 DONE content / 上层落库）。 */
  text: string
  /** 经 MCP 桥调用的工具流水。CLI 的 stdout **丢弃工具结果**，所以产物（生图等）只能由
   *  桥在进程内采集；上层据此渲染图片气泡并落库 messages.tool_calls。 */
  toolCallLog?: RuntimeToolCall[]
}

/**
 * 一个可插拔的运行时（Claude Code / OpenCode / …）。由本地 invoker `runViaRuntime` 按
 * 用户所选 `defaultRuntime` 选用；未选中则走既有自研 `runAgent`。
 */
export interface AgentRuntime {
  /** 运行时名（日志/灰度开关值，如 'opencode'）。 */
  readonly name: string
  /** 跑一个任务；全程事件经 sink 出（channel=AGENT_*），返回汇总文本。 */
  run(task: RuntimeTask, sink: AgentSink): Promise<RuntimeResult>
  /** 释放常驻资源（server 子进程等）。无常驻资源可空实现。 */
  dispose(): Promise<void>
}
