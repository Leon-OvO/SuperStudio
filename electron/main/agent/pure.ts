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
export function friendlyError(message: string, cause?: unknown, statusCode?: number): string {
  const causeStr = cause ? String(cause) : ''
  const full = `${message} ${causeStr}`.toLowerCase()

  if (statusCode === 503 || full.includes('temporarily unavailable') || full.includes('service unavailable') || full.includes('503')) {
    return `服务暂时不可用（503）。这通常是模型服务过载，请稍等片刻后重试。\n\n原始信息：${message}`
  }
  // 网关/中转转发失败（502/504/529 或「Upstream request failed / bad gateway / overloaded」）。
  // 引擎已带退避自动重试若干次；走到这里说明重试仍未成功 → 提示稍后再试（可重试）。
  if (statusCode === 502 || statusCode === 504 || statusCode === 529 ||
      full.includes('upstream request failed') || full.includes('upstream error') ||
      full.includes('bad gateway') || full.includes('gateway time') ||
      full.includes('overloaded') || full.includes('502') || full.includes('504') || full.includes('529')) {
    return `上游服务暂时不可用（网关/中转转发失败）。已自动重试多次仍未成功，请稍后再试或切换模型。\n\n原始信息：${message}`
  }
  if (statusCode === 429 || full.includes('rate limit') || full.includes('429') || full.includes('too many requests')) {
    return `请求频率超限（429 Rate Limit）。请稍等几秒后重试，或切换到其他模型。\n\n原始信息：${message}`
  }
  // Auth failures: match the HTTP 401 status AND the many server-side phrasings
  // (OpenAI「invalid api key」, LiteLLM「authentication error / invalid proxy
  // server token / token_not_found / unable to find token」, etc.) — the message
  // text often has NONE of the simple keywords, so without statusCode it slips
  // through to the raw English dump.
  const authText =
    full.includes('unauthorized') || full.includes('authentication') ||
    full.includes('invalid api key') || full.includes('incorrect api key') ||
    full.includes('invalid proxy server token') || full.includes('token_not_found') ||
    full.includes('unable to find token') || full.includes('verificationtoken') ||
    full.includes('no api key') || full.includes('api key not found') ||
    full.includes('expired') && full.includes('key')
  if (statusCode === 401 || (statusCode === undefined && full.includes('401')) || authText) {
    return `API Key 无效或已失效，接口认证未通过。请到「设置 → 提供商」检查并更新该接口的 API Key；若密钥本应有效，可能是它被重置或过期，需重新获取。\n\n原始信息：${message}`
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
  // Context-overflow detection. `token` must CO-OCCUR with overflow wording — a
  // bare "token" match wrongly flagged empty-response errors whose diagnostic dump
  // contains usage={"promptTokens":…} as "context too long".
  const ctxOverflow =
    full.includes('context length') ||
    full.includes('context window') ||
    full.includes('maximum context') ||
    full.includes('context_length_exceeded') ||
    full.includes('string too long') ||
    /(maximum|exceed|too many|too long|reduce|limit of)[^.]{0,40}tokens?\b/.test(full) ||
    /tokens?\b[^.]{0,40}(exceed|limit|maximum|too long|too many)/.test(full)
  if (ctxOverflow) {
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

/** Rough token estimate (≈4 chars/token) — dependency-free, good enough for
 *  budgeting history. Errs slightly high for CJK, which is safe (trims more). */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4)
}

/**
 * Trim conversation history to fit a token budget, dropping the OLDEST turns
 * first. Always keeps the most recent message even if it alone exceeds the
 * budget (the model call will then surface the real overflow). Returns a new
 * array; input is not mutated.
 */
export function trimHistoryToBudget<T extends { content: string }>(
  history: ReadonlyArray<T>,
  budgetTokens: number
): T[] {
  if (history.length === 0) return []
  // Walk newest→oldest accumulating tokens; keep until the budget is hit.
  const kept: T[] = []
  let total = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const cost = estimateTokens(history[i].content)
    if (kept.length > 0 && total + cost > budgetTokens) break
    kept.push(history[i])
    total += cost
  }
  return kept.reverse()
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

// Placeholder/truncation idioms a model emits when it lazily writes a STUB instead
// of the full file ("// ...rest unchanged", "其余省略", "(rest of the code)"). Used
// by write_text_file to REFUSE such a write, because that tool overwrites the file
// wholesale (after backing up) — a stub would silently destroy the real content.
// Patterns are deliberately specific (a marker/comment + a rest/省略/unchanged word,
// or an explicit Chinese "其余<名词>…省略/保持不变" construct) to avoid false
// positives on legitimate prose that merely happens to contain "..." or "省略".
const TRUNCATION_MARKERS: RegExp[] = [
  /(?:\/\/|#|--)\s*\.{2,}\s*(?:rest|remaining|unchanged|the rest|其余|省略|余下)/i,
  /\/\*\s*\.{2,}[\s\S]{0,40}?(?:rest|remaining|unchanged|其余|省略)[\s\S]{0,40}?\*\//i,
  /<!--\s*\.{2,}[\s\S]{0,40}?(?:rest|remaining|unchanged|其余|省略)[\s\S]{0,40}?-->/i,
  /\(\s*(?:the\s+)?(?:rest|remaining)\s+of\s+[^)]{0,40}?(?:code|file|content|implementation)[^)]{0,20}?\)/i,
  /(?:其余|以下|后续|剩余|其它|其他)(?:的)?(?:代码|内容|部分|行|配置|逻辑|函数|字段|数据)?\s*(?:保持不变|保持原样|此处省略|这里省略|省略|略去|未作改动|未改动|不再赘述)/,
  /(?:省略|略去)(?:其余|余下|后续|剩余|以下|部分|若干|\s*N\s*行)/,
]

/** True if `content` looks like a truncated stub / contains a "rest omitted"
 *  placeholder rather than the complete file body. Conservative by design. */
export function looksTruncated(content: string): boolean {
  if (!content) return false
  return TRUNCATION_MARKERS.some(re => re.test(content))
}

/** 零宽空格：插进 `<` 与标签名之间，肉眼与语义都不变，但不再是一个标签。 */
const ZWSP = '​'

/**
 * 中和正文里的控制标签，防止「包裹层被正文撬开」。
 *
 * 我们把不可信内容（召回的长期记忆、环境快照）包在 `<untrusted_content>` /
 * `<environment_context>` 里告诉模型"这是数据不是指令"。可这些正文本身是 LLM 抽取后
 * 写进 SQLite 的——只要有一条记忆正文里含 `</untrusted_content>`，整条注入防线就被
 * 提前闭合，后面的内容就"越狱"成了系统级指令。
 *
 * 处理方式是【插零宽空格而不是删除】：正文语义一个字都不丢（用户看导出、模型读记忆
 * 都还是原话），但它不再被解析成我们的控制标签。闭标签先处理（它才是撬锁的那把）。
 *
 * @param text 待中和的正文
 * @param tags 需要中和的标签名（不含尖括号）
 */
export function neutralizeTags(text: string, tags: readonly string[]): string {
  if (!text) return text
  let out = text
  for (const tag of tags) {
    const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 1) 闭标签：`</tag>`、`< / tag >` 都算。
    out = out.replace(new RegExp(`<\\s*/\\s*(${esc})\\s*>`, 'gi'), `<${ZWSP}/$1>`)
    // 2) 开标签（含带属性的 `<tag source="x">`）：伪造一个开标签同样能骗过分段。
    out = out.replace(new RegExp(`<\\s*(${esc})(\\s[^>]*)?>`, 'gi'), (_m, name: string, attrs?: string) => `<${ZWSP}${name}${attrs ?? ''}>`)
  }
  return out
}

/**
 * 高置信「空转」签名：模型换个无意义参数就能绕过按 args 计数的重复护栏
 * （反复 `run_script('echo ok')` / `cd .` / `ssh_exec('true')` 空烧步数预算）。
 * 命中这张表的调用会被折叠到一个常量 key 上计数，且阈值更低。
 *
 * 判定刻意保守：命令里只要出现重定向 / 管道 / 分号 / `&&` 等组合结构，就【不】判为
 * 空转——`true > /tmp/flag`、`echo ok && python x.py` 都是有副作用的真实工作。
 */
const NOOP_COMBINATORS = /[|<>;&`$(){}]/
const NOOP_COMMANDS: RegExp[] = [
  /^true$/i,
  /^:$/,
  /^cd$/i,
  /^cd\s+\.$/i,
  /^cd\s+\.\/?$/i,
  /^pwd$/i,
  /^echo$/i,
  /^echo\s+(?:"[^"]*"|'[^']*'|[\w一-龥.,!?-]+)$/i,
  /^exit\s+0$/i,
  /^rem\b.*$/i,
  /^sleep\s+\d+(?:\.\d+)?$/i,
  /^timeout\s+\/t\s+\d+$/i,
  /^ver$/i,
  /^whoami$/i,
]

/**
 * 若这次工具调用是「确定没有任何副作用的空转」，返回一个稳定签名（用作重复护栏的
 * 常量 key）；否则返回 null。
 *
 * 只覆盖本机/远程执行类工具的 command 参数——其它工具的"重复"由原来的按 args 计数
 * 负责，这里绝不扩大打击面。
 */
export function noopSignature(toolName: string, args: unknown): string | null {
  if (toolName !== 'run_script' && toolName !== 'ssh_exec' && toolName !== 'bash') return null
  const cmd = (args as { command?: unknown } | null | undefined)?.command
  if (typeof cmd !== 'string') return null
  const trimmed = cmd.trim()
  if (!trimmed || trimmed.length > 120) return null
  if (NOOP_COMBINATORS.test(trimmed)) return null
  if (!NOOP_COMMANDS.some(re => re.test(trimmed))) return null
  // 常量 key：换参数也逃不掉。工具名保留，便于日志定位。
  return `${toolName}:<noop>`
}

/**
 * runShell 结果里需要透给模型的那部分（结构化取值，避免 pure.ts 依赖 services/shell，
 * 保持本模块零副作用可直测）。
 */
export interface ShellOutcome {
  code: number
  timedOut: boolean
  killedBy?: 'timeout' | 'abort' | 'output_limit' | null
  truncated?: boolean
  drained?: boolean
  bytes?: { stdout: number; stderr: number }
  logPath?: string
  diagnostics?: string
}

/**
 * 把 runShell 的「诊断类」字段折成一小段附加到工具返回值上的对象。
 *
 * 存在的理由：shell 层已经算好了退出码成因、截断字节数、全量日志路径，但对话引擎的
 * run_script / ssh_exec 过去只摘 {code,stdout,stderr,timedOut} 四个字段，诊断全被丢在
 * 半路——模型看到一个被截断的失败输出，既不知道自己只看到了一部分，也不知道全量在哪。
 *
 * 成功且未截断时返回空对象：正常路径一个字节的噪音都不加（这些内容会进提示词、进导出）。
 * 调用方按 `{ ...固有字段, ...shellDiagnosticFields(r) }` 展开即可，不同工具的固有字段
 * 形状（run_script 用 code、ssh_exec 用 exitCode）互不影响。
 */
export function shellDiagnosticFields(r: ShellOutcome): Record<string, unknown> {
  const extra: Record<string, unknown> = {}
  if (r.truncated) {
    extra.truncated = true
    if (r.bytes) extra.totalOutputBytes = r.bytes.stdout + r.bytes.stderr
    extra.note = '输出过长，中间部分已省略（首尾已保留）。需要完整输出时读取 logPath 指向的日志文件。'
  }
  if (r.drained === false) {
    extra.outputIncomplete = true
  }
  if (r.killedBy) extra.killedBy = r.killedBy
  if (r.diagnostics) extra.diagnostics = r.diagnostics
  // 日志路径只在「有话要说」时给：截断了、或这轮失败了，模型才需要去翻全量。
  if (r.logPath && (r.truncated || r.diagnostics || r.drained === false)) extra.logPath = r.logPath
  return extra
}
