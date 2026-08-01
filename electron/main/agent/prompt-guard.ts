/**
 * 提示词 ↔ 「本轮真实注册了哪些工具」的一致性护栏。
 *
 * 背景：提示词里若点名一个本轮【没有注册】的工具，模型只有两条路——要么幻觉出
 * 一次调用（被 SDK 拒绝），要么放弃动手、改成口头汇报"我已经…"。也就是说，我们
 * 一边用提示词指使模型去调不存在的工具，一边抱怨模型偷懒。
 *
 * 这里提供三件东西：
 *  1. `TOOL`：提示词正文里唯一允许出现的工具名来源（`as const`）。提示词写
 *     `${TOOL.runScript}` 而不是裸字符串 'run_script'，扫描器才有唯一真相源。
 *  2. `findPhantomToolMentions()`：扫描拼好的提示词，找出"提到了但本轮不存在"的工具名。
 *  3. `assertToolTableCovers()`：反向核对——真实注册的工具名若不在 `TOOL` 表里，
 *     说明有人新增工具却没登记，扫描器会漏检。开发期告警，避免表和现实脱节。
 *
 * 本文件必须保持零依赖（不 import electron / db / sdk），以便在 vitest 里直接跑。
 */

/**
 * 提示词正文可引用的工具名。**新增工具时必须在这里登记**，否则
 * `assertToolTableCovers()` 会在开发期告警。
 *
 * 注意：登记 ≠ 本轮一定存在。是否存在由 `availableTools`（本轮真实注册的键集合）
 * 决定，提示词按 presence 渲染。
 */
export const TOOL = {
  webSearch: 'web_search',
  webOpen: 'web_open',
  webSnapshot: 'web_snapshot',
  webClick: 'web_click',
  webFill: 'web_fill',
  webUpload: 'web_upload',
  xhsPublish: 'xhs_publish',
  imageGenerate: 'image_generate',
  videoGenerate: 'video_generate',
  visionAnalyze: 'vision_analyze',
  fileRead: 'file_read',
  listDir: 'list_dir',
  fileWrite: 'file_write',
  writeTextFile: 'write_text_file',
  sshExec: 'ssh_exec',
  runScript: 'run_script',
  askUser: 'ask_user',
  loadSkill: 'load_skill',
  readSkillFile: 'read_skill_file',
  bash: 'bash',
  computer: 'computer',
  finish: 'finish',
} as const

export type ToolKey = keyof typeof TOOL
export type ToolName = (typeof TOOL)[ToolKey]

/** `TOOL` 表里登记过的全部工具名（扫描器的基础词表）。 */
export const KNOWN_TOOL_NAMES: readonly string[] = Object.freeze(Object.values(TOOL))

/**
 * 工具名在中文提示词里常紧贴中文标点（"调用 file_write（本机执行）"），`\b`
 * 对中文没有意义，所以自己写边界：前后不得是 ASCII 字母/数字/下划线。这样
 * `web_search` 不会被 `mcp__web_search` 或 `web_searcher` 误命中。
 */
function mentionRegex(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`)
}

/** 提示词里出现过的工具名（按词表匹配），返回去重后的名字集合。 */
export function extractToolMentions(
  prompt: string,
  vocabulary: Iterable<string> = KNOWN_TOOL_NAMES
): Set<string> {
  const hit = new Set<string>()
  if (!prompt) return hit
  for (const name of vocabulary) {
    if (mentionRegex(name).test(prompt)) hit.add(name)
  }
  return hit
}

/**
 * 「提到了但本轮不存在」的工具名，按字典序返回（便于断言与日志稳定）。
 *
 * `vocabulary` 默认取 `TOOL` 表 ∪ 本轮真实注册的名字——加上后者是为了让扫描器
 * 也认识 MCP 工具之类不在表里的名字（它们存在，所以永远不会被判为幻影）。
 */
export function findPhantomToolMentions(
  prompt: string,
  availableTools: ReadonlySet<string>,
  vocabulary?: Iterable<string>
): string[] {
  const vocab = new Set<string>(vocabulary ?? KNOWN_TOOL_NAMES)
  for (const n of availableTools) vocab.add(n)
  const mentioned = extractToolMentions(prompt, vocab)
  return [...mentioned].filter(n => !availableTools.has(n)).sort()
}

/**
 * 反向核对：真实注册了、却没在 `TOOL` 表里登记的工具名。
 * MCP 工具用 `<slug>__<tool>` 形式命名、由用户配置动态产生，不该要求登记，跳过。
 */
export function assertToolTableCovers(registeredNames: Iterable<string>): string[] {
  const known = new Set<string>(KNOWN_TOOL_NAMES)
  const missing: string[] = []
  for (const n of registeredNames) {
    if (n.includes('__')) continue // MCP 限定名，动态产生
    if (!known.has(n)) missing.push(n)
  }
  return missing.sort()
}

/**
 * stable（可缓存前缀）段的体积预算。超了不是错误，但意味着每轮都要为一大坨
 * 静态文字付 cache-write / 首轮全价，且挤压历史预算——开发期出个声。
 */
export const STABLE_PROMPT_BUDGET_CHARS = 24000

/** 超预算时返回一句中文告警，否则 null。 */
export function checkStablePromptBudget(
  stableLength: number,
  budget = STABLE_PROMPT_BUDGET_CHARS
): string | null {
  if (stableLength <= budget) return null
  return `系统提示 stable 段 ${stableLength} 字符，超出预算 ${budget}——每轮都要为这段静态文字付费，请精简或改为按需渲染。`
}

/**
 * 开发期护栏总入口：扫描 + 体积预算，返回是否全部通过。
 * `enabled=false`（打包后的正式版）时直接返回 true，一行都不跑。
 */
export function reportPromptIssues(opts: {
  label: string
  prompt: string
  stableLength: number
  availableTools: ReadonlySet<string>
  registeredNames?: Iterable<string>
  enabled: boolean
  warn?: (msg: string) => void
}): boolean {
  if (!opts.enabled) return true
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  let ok = true
  const phantom = findPhantomToolMentions(opts.prompt, opts.availableTools)
  if (phantom.length) {
    ok = false
    warn(`[prompt-guard] ${opts.label}: 提示词点名了本轮不存在的工具 → ${phantom.join(', ')}。` +
      `模型只能幻觉调用或退化成口头汇报，请把相关段落改成按 presence 渲染。`)
  }
  if (opts.registeredNames) {
    const missing = assertToolTableCovers(opts.registeredNames)
    if (missing.length) {
      ok = false
      warn(`[prompt-guard] ${opts.label}: 以下工具已注册但未登记进 TOOL 表 → ${missing.join(', ')}。` +
        `扫描器会漏检它们，请补登记。`)
    }
  }
  const budget = checkStablePromptBudget(opts.stableLength)
  if (budget) {
    ok = false
    warn(`[prompt-guard] ${opts.label}: ${budget}`)
  }
  return ok
}
