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
  timeoutMs = 6000
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
- change: 要写代码 / 改代码 / 从零开发（新增功能、改造现有代码、从零做一个新项目·网站·应用、实现一个完整功能）—— 需要拆解成多步任务实现。
- bugfix: 报告一个已存在的故障/错误/异常行为要修（"点击没反应""报错 xxx""样式错位""崩溃了"）。
- explore: 纯只读地理解/调研现有代码，且明确不需要改动（"这段代码怎么工作""为什么这样设计""找一下哪里处理了登录"）。
- chat: 打招呼、与本项目代码无关的闲聊、或纯知识问答（"你好""React 和 Vue 哪个好""tailwind 怎么写渐变"）。

判定优先级（重要）：
1. 只要请求最终需要**实际写或改代码**（哪怕同时夹带大量背景说明、项目管理/流程要求、长篇描述，或要求"先调研/先复习资料再实现"），一律归 change —— 这些前置说明不改变"动手做"的本质。
2. explore 仅用于用户明确"我只想看懂/调研、先别动代码"的纯只读场景。
3. chat 仅用于打招呼 / 与代码无关 / 纯知识问答。
4. 在 change 与 explore（或 change 与 chat）之间拿不准时，优先 change。

示例：
用户：这个项目的路由是怎么配置的，先别改 → {"intent":"explore"}
用户：保存按钮点了没反应，控制台报 undefined → {"intent":"bugfix"}
用户：帮我加一个导出 PDF 的功能 → {"intent":"change"}
用户：我要做一个面向中职学生的教学网站，要有教师端实时大屏、学生在线练习与量化统计、实训提交，请先复习资料再制定开发计划逐步实现 → {"intent":"change"}
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
  timeoutMs = 6000
): Promise<VibeIntent> {
  try {
    const llm = createLLMClient(providerId, model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { text } = await generateText({
        model: llm,
        system: VIBE_CLASSIFIER_SYSTEM,
        // 放宽到 1200 字：长需求里的"实现要求"往往在后半段，截太短会只看到
        // 开头的背景/管理描述而误判成 chat，错过 change。
        prompt: message.slice(0, 1200),
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

// ── 出图意图分类（逐轮判定：要不要出图 / 是改上一张 / 还是纯对话）──────────────
export type ImageTurnIntent = 'generate' | 'edit' | 'chat'
const IMG_VALID: ImageTurnIntent[] = ['generate', 'edit', 'chat']

const IMAGE_INTENT_SYSTEM = `你是一个"出图意图"分类器。判断用户这轮到底要不要生成/修改图片，只输出 JSON：{"intent":"<label>"}，不要解释。

标签：
- generate: 明确想要一张/多张【新图】（"画一张…""给这篇文案配图""生成图片""做张海报"）。
- edit: 想在【上一张已生成的图】基础上修改（"还是不对""换成暖色""把人物去掉""保持构图再调一下""更装修风一点"）—— 通常是对上一张图的纠正/微调。
- chat: 不是要图，而是提问、抱怨、闲聊、求解释（"为什么你无法生成图片""这图和文案没关系""你能做什么""怎么用"）—— 应当用文字回答，绝不出图。

判定要点（重要）：
1. 用户在【抱怨/质疑/提问】时归 chat，哪怕句子里出现"图片"二字——"为什么不能生成图片"是 chat，不是 generate。
2. 只有针对上一张图的增量修改（还是不对/再改改/换X/调Y/保持Z/更…一点）才归 edit；没有上一张图时把 edit 当 generate。
3. 拿不准：有明确画面诉求→generate；针对上一张的修改→edit；其余→chat。

示例：
用户：帮我画一只猫 → {"intent":"generate"}
用户：给这篇文案配 6 张图 → {"intent":"generate"}
用户：为什么你无法生成图片 → {"intent":"chat"}
用户：这张图和文案完全没关系 → {"intent":"chat"}
用户：还是不对，要更装修风 → {"intent":"edit"}
用户：把背景换成夜晚 → {"intent":"edit"}`

/**
 * 判断"出图会话"里这一轮的意图，避免图像模型/强制出图把【每一轮】都强行出图
 * （含把提问/抱怨当画面去画）。失败时默认 'generate'（已在出图态，倾向保留出图happy path）；
 * 无上一张图时 edit 降级为 generate。短超时，绝不拖慢发送。
 */
export async function classifyImageTurnIntent(
  message: string,
  providerId: string,
  model: string,
  hasBaseImage: boolean,
  timeoutMs = 6000
): Promise<ImageTurnIntent> {
  try {
    if (!providerId || !model) return 'generate'
    const llm = createLLMClient(providerId, model)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { text } = await generateText({
        model: llm,
        system: IMAGE_INTENT_SYSTEM,
        prompt: message.slice(0, 400),
        temperature: 0,
        maxTokens: 30,
        abortSignal: controller.signal
      })
      const match = text.match(/"intent"\s*:\s*"(\w+)"/)
      let label = match?.[1] as ImageTurnIntent | undefined
      if (!label || !IMG_VALID.includes(label)) label = 'generate'
      if (label === 'edit' && !hasBaseImage) label = 'generate'
      return label
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return 'generate'
  }
}
