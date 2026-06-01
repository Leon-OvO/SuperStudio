import { generateText } from 'ai'
import { createLLMClient } from '../services/llm'
import type { AutoModelIntent, VibeIntent } from '../../../src/shared/ipc-types'

const VALID: AutoModelIntent[] = ['vision', 'code', 'math', 'creative', 'quick', 'default']

// Label definitions + few-shot examples make the classifier far more stable
// than a bare label list, and routing it through the SDK (not a hardcoded
// OpenAI fetch) makes it work for Anthropic/Gemini-native providers too.
const CLASSIFIER_SYSTEM = `你是一个意图分类器。把用户消息归类为下列之一，只输出 JSON：{"intent":"<label>"}，不要解释。

标签定义：
- vision: 需要看图/分析图片（用户提到"这张图/分析图片/截图里…"）
- code: 写代码、调试、解释程序、技术实现、算法、SQL/API
- math: 数学计算、推导、证明、公式
- creative: 创意写作（故事/文案/诗歌/剧本/续写/小说）
- quick: 简短的事实问答或闲聊，无需深度推理
- default: 不属于以上任何一类，或需要综合能力的一般任务

示例：
用户：帮我用 Python 写个快速排序 → {"intent":"code"}
用户：求 ∫x²dx → {"intent":"math"}
用户：给我的猫咖写一段开业文案 → {"intent":"creative"}
用户：今天星期几 → {"intent":"quick"}
用户：帮我把这份季度报告总结成要点 → {"intent":"default"}`

/**
 * Classify a chat message into an AutoModelIntent using the configured smart
 * model. Returns 'default' on any failure (caller falls back to heuristics).
 * Bounded by a short timeout so a slow classifier never stalls sending.
 */
export async function classifyIntent(
  message: string,
  providerId: string,
  model: string,
  timeoutMs = 2500
): Promise<AutoModelIntent> {
  try {
    const llm = createLLMClient(providerId, model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { text } = await generateText({
        model: llm,
        system: CLASSIFIER_SYSTEM,
        prompt: message.slice(0, 300),
        temperature: 0,
        maxTokens: 30,
        abortSignal: controller.signal
      })
      const match = text.match(/"intent"\s*:\s*"(\w+)"/)
      const label = match?.[1] as AutoModelIntent | undefined
      return label && VALID.includes(label) ? label : 'default'
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return 'default'
  }
}

// ── Vibe（构建工作台）意图分类 ──────────────────────────────────────────────
const VIBE_VALID: VibeIntent[] = ['chat', 'explore', 'bugfix', 'change']

const VIBE_CLASSIFIER_SYSTEM = `你是一个研发意图分类器。判断用户在代码项目里想做什么，只输出 JSON：{"intent":"<label>"}，不要解释。

标签定义：
- explore: 想理解/调研现有代码（"这段代码怎么工作""为什么这样设计""找一下哪里处理了登录"）—— 只读，不改代码。
- bugfix: 报告一个故障/错误/异常行为要修（"点击没反应""报错 xxx""样式错位""崩溃了"）。
- change: 要新增功能或改造（"加一个深色模式按钮""把所有 var 改成 let""为页面加 SEO meta"）—— 需要拆解成任务实现。
- chat: 一般问答/闲聊/与本项目代码无关的问题（"你好""React 和 Vue 哪个好"）。

示例：
用户：这个项目的路由是怎么配置的 → {"intent":"explore"}
用户：保存按钮点了没反应，控制台报 undefined → {"intent":"bugfix"}
用户：帮我加一个导出 PDF 的功能 → {"intent":"change"}
用户：顺便问下 tailwind 怎么写渐变 → {"intent":"chat"}`

/**
 * Classify a Vibe workbench message into one of chat/explore/bugfix/change.
 * Falls back to 'chat' on any failure (the safest, least-destructive path —
 * full tools but no task decomposition). Bounded by a short timeout.
 */
export async function classifyVibeIntent(
  message: string,
  providerId: string,
  model: string,
  timeoutMs = 2500
): Promise<VibeIntent> {
  try {
    const llm = createLLMClient(providerId, model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { text } = await generateText({
        model: llm,
        system: VIBE_CLASSIFIER_SYSTEM,
        prompt: message.slice(0, 400),
        temperature: 0,
        maxTokens: 30,
        abortSignal: controller.signal
      })
      const match = text.match(/"intent"\s*:\s*"(\w+)"/)
      const label = match?.[1] as VibeIntent | undefined
      return label && VIBE_VALID.includes(label) ? label : 'chat'
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return 'chat'
  }
}
