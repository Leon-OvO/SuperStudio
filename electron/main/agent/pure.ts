/**
 * Pure, dependency-free helpers extracted from the agent layer.
 *
 * Everything here must stay free of `electron`, DB, and SDK imports (type-only
 * imports are fine — they're erased at compile time) so it can be unit-tested
 * under vitest without booting the Electron/main runtime.
 */

import type { InstalledSkill } from '../services/skills-db'
import type { McpTool } from '../services/mcp'

/** First-message → session title. Emoji prefix for media turns, 22-char clamp. */
export function buildAutoTitle(message: string, isImage: boolean, isVideo: boolean): string {
  const clean = message.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
  const prefix = isImage ? '🖼 ' : isVideo ? '🎬 ' : ''
  const body = clean.slice(0, 22)
  return prefix + body + (clean.length > 22 ? '…' : '')
}

/**
 * Union of the per-skill tool whitelists, or `null` when the filter should be
 * disabled. Any active skill WITHOUT a whitelist (unrestricted) removes the
 * filter entirely — returning null means "allow every tool".
 */
export function computeToolAllowSet(skills: InstalledSkill[]): Set<string> | null {
  if (!skills.length) return null
  const allowed = new Set<string>()
  for (const s of skills) {
    if (!s.toolWhitelist) return null // any unrestricted skill removes the filter
    for (const name of s.toolWhitelist) allowed.add(name)
  }
  return allowed
}

/** Extract an image size (WxH) from free text, with portrait/landscape hints. */
export function parseSizeFromMessage(msg: string): string {
  const m = msg.match(/(\d{3,4})\s*[xX×]\s*(\d{3,4})/)
  if (m) return `${m[1]}x${m[2]}`
  if (/竖[图圖]|纵向|竖版|portrait/i.test(msg)) return '1024x1792'
  if (/横[图圖]|横向|横版|landscape/i.test(msg)) return '1792x1024'
  return '1024x1024'
}

/** Map a raw provider/SDK error into a localized, actionable message. */
export function friendlyError(message: string, cause?: unknown): string {
  const causeStr = cause ? String(cause) : ''
  const full = `${message} ${causeStr}`.toLowerCase()

  if (full.includes('temporarily unavailable') || full.includes('service unavailable') || full.includes('503')) {
    return `服务暂时不可用（503）。这通常是模型服务过载，请稍等片刻后重试。\n\n原始信息：${message}`
  }
  if (full.includes('rate limit') || full.includes('429') || full.includes('too many requests')) {
    return `请求频率超限（429 Rate Limit）。请稍等几秒后重试，或切换到其他模型。\n\n原始信息：${message}`
  }
  if (full.includes('401') || full.includes('invalid api key') || full.includes('unauthorized')) {
    return `API Key 无效或未授权（401）。请到「设置 → 提供商」检查 API Key 是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('403') || full.includes('forbidden')) {
    return `访问被拒绝（403）。请确认 API Key 有权限调用该模型。\n\n原始信息：${message}`
  }
  if (full.includes('404') || full.includes('model not found') || full.includes('no such model')) {
    return `模型不存在（404）。请到「设置 → 默认模型」检查模型名称是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('connection') || full.includes('econnrefused') || full.includes('network')) {
    return `网络连接失败。请检查网络连接和 Base URL 配置是否正确。\n\n原始信息：${message}`
  }
  if (full.includes('timeout') || full.includes('timed out')) {
    return `请求超时。模型响应时间过长，请重试或尝试更短的输入。\n\n原始信息：${message}`
  }
  if (full.includes('context length') || full.includes('token') || full.includes('maximum context')) {
    return `输入内容超过模型最大上下文长度。请缩短消息或开启新会话。\n\n原始信息：${message}`
  }

  return causeStr ? `${message}\n原因：${causeStr}` : message
}

/**
 * Kahn topological sort. Returns node ids in dependency order; nodes in a cycle
 * are dropped (never reach in-degree 0), matching the prior inline behavior.
 * Generic over minimal {id} / {source,target} shapes to stay decoupled.
 */
export function topologicalSort(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>
): string[] {
  const inDegree: Record<string, number> = {}
  const adj: Record<string, string[]> = {}

  for (const n of nodes) { inDegree[n.id] = 0; adj[n.id] = [] }
  for (const e of edges) {
    // Both endpoints must be known nodes — an edge to a non-existent target
    // would otherwise enqueue a phantom id whose adj is undefined and crash.
    if (!adj[e.source] || !(e.target in inDegree)) continue
    adj[e.source].push(e.target)
    inDegree[e.target] += 1
  }

  const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id)
  const result: string[] = []

  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of adj[id]) {
      inDegree[next]--
      if (inDegree[next] === 0) queue.push(next)
    }
  }
  return result
}

/**
 * Kahn topological sort by LEVELS — each inner array is a set of nodes whose
 * dependencies are all satisfied and which can run concurrently. Used by the
 * workflow engine to fan out independent branches.
 */
export function topologicalLevels(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<{ source: string; target: string }>
): string[][] {
  const inDegree: Record<string, number> = {}
  const adj: Record<string, string[]> = {}

  for (const n of nodes) { inDegree[n.id] = 0; adj[n.id] = [] }
  for (const e of edges) {
    if (!adj[e.source] || !(e.target in inDegree)) continue
    adj[e.source].push(e.target)
    inDegree[e.target] += 1
  }

  let frontier = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id)
  const levels: string[][] = []
  while (frontier.length) {
    levels.push(frontier)
    const next: string[] = []
    for (const id of frontier) {
      for (const child of adj[id]) {
        inDegree[child]--
        if (inDegree[child] === 0) next.push(child)
      }
    }
    frontier = next
  }
  return levels
}

/** Build qualified MCP tool descriptors from a server's raw tool list. */
export function flattenMcpTools(
  serverId: string,
  serverName: string,
  slug: string,
  rawTools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>
): McpTool[] {
  return rawTools.map(t => ({
    serverId,
    serverName,
    qualifiedName: `${slug}__${t.name}`,
    toolName: t.name,
    description: t.description,
    inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
  }))
}

/**
 * Truncate a model-facing tool result that may be huge (full PDF dump, a long
 * web page, a verbose MCP payload) so it can't blow the context window. The
 * full value is kept elsewhere (toolCallLog) for export — only the copy fed
 * back to the model is trimmed. Objects are JSON-stringified for measurement
 * and returned as-is when under the cap.
 */
export function truncateToolResult<T>(value: T, maxChars = 12000): T | string {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value
    return value.slice(0, maxChars) + `\n\n…[truncated ${value.length - maxChars} chars — call again with a narrower range if you need the rest]`
  }
  try {
    const json = JSON.stringify(value)
    if (json.length <= maxChars) return value
    return json.slice(0, maxChars) + `\n\n…[truncated ${json.length - maxChars} chars]`
  } catch {
    return value
  }
}
