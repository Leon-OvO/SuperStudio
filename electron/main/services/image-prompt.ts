import { generateText } from 'ai'
import { createLLMClient } from './llm'
import type { AppSettings } from '../../../src/shared/ipc-types'

/**
 * 出图前的"忠实提示词构造层"。永远不要把用户当轮原话直接当图像提示词——而是用对话
 * 模型读上下文（最近几轮 + 已生成的文案 + @引用）+ 本轮诉求，产出一段可直接喂图模的
 * 画面描述。两条硬约束：① 只输出画面描述本身，不带任何解释/前后缀（否则会污染图模）；
 * ② 忠实保留用户硬约束（数量/否定/主体/画面文字/风格）。失败时回退为用户原话，绝不
 * 因为改写挂了就出不了图。
 *
 * 业界标准件（DALL·E 3 之后）：用户输入与图模之间固定隔一层 LLM 改写。
 */

const REWRITE_SYSTEM = `你是"图像提示词构造器"。把用户的真实出图意图 + 给定的上下文/文案，改写成一段可直接喂给图像模型的【画面描述】。

严格规则：
1. 只输出画面描述本身——不要任何解释、前后缀、引号，不要"好的""以下是""提示词："之类的话。
2. 忠实保留用户的硬约束：数量、否定（如"不要出现人物"）、指定的主体、画面里要出现的文字、指定风格——绝不丢。
3. 描述要具体可画：主体、场景、构图、光线、色调、风格、质感。
4. 若上下文里有一篇文案，就【围绕该文案的主题】构造画面，而不是把用户最后一句话当画面（用户最后一句往往是"还是不对""配个图"这类，本身不是画面）。
5. 中英文均可，但要让图像模型听得懂；控制在约 120 字内。`

export async function buildImagePrompt(opts: {
  /** 本轮用户诉求（原话）。 */
  userMessage: string
  /** 最近对话 / 已生成文案 / @引用 拼成的上下文。 */
  context?: string
  settings: AppSettings
  timeoutMs?: number
}): Promise<string> {
  const { userMessage, context, settings, timeoutMs = 12000 } = opts
  const fallback = (userMessage || '').trim()
  try {
    if (!settings.defaultChatProviderId || !settings.defaultChatModel) return fallback
    const llm = createLLMClient(settings.defaultChatProviderId, settings.defaultChatModel)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const parts: string[] = []
      if (context && context.trim()) parts.push(`【上下文 / 已生成文案（围绕它来画）】\n${context.trim().slice(0, 4000)}`)
      parts.push(`【用户这轮的出图诉求】\n${fallback}`)
      parts.push('请据此输出一段画面描述（只输出描述本身）：')
      const { text } = await generateText({
        model: llm,
        system: REWRITE_SYSTEM,
        prompt: parts.join('\n\n'),
        temperature: 0.4,
        maxTokens: 320,
        abortSignal: controller.signal
      })
      const out = text.trim()
      return out.length >= 4 ? out : fallback
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return fallback
  }
}

export interface ScenePrompt {
  /** 简短场景名（如「改造后全景」），用于画廊 sceneLabel；可空。 */
  label: string
  /** 该场景的纯画面 prompt。 */
  prompt: string
}

const SET_SYSTEM = `你是"配图/分镜提示词构造器"。根据用户诉求 + 上下文，产出【最多 N 条】画面提示词，只输出一个 JSON 数组：[{"scene_label":"简短场景名","prompt":"画面描述"}]，不要任何额外文字、不要代码块围栏。

规则：
1. 只输出 JSON 数组本身。
2. 每条 prompt 是可直接喂图模的纯画面描述，忠实保留用户硬约束（数量/否定/主体/画面文字/风格）。
3. 若用户是"给一段文案 / 内容配多张图"：N 条要覆盖【不同方面 / 场景】（如 改造前 / 施工中 / 改造后 / 细节特写 …），不要互相重复。
4. 若用户是"同一主体的多个候选"：N 条围绕同一主体，构图 / 角度 / 光线略有差异。
5. 各条共享统一的风格基调，保证整套观感一致。`

/**
 * 多图扇出：把"给文案配 N 张图"拆成 N 条【不同】画面 prompt（修复"配 6 张图 = 同一
 * prompt 出 6 份"）。count===1 直接复用 buildImagePrompt。失败 / 解析不出时回退为单条
 * （调用方据此走"单 prompt 出 N 张变体"的老路径，绝不因为拆解失败就出不了图）。
 */
export async function buildImagePromptSet(opts: {
  userMessage: string
  context?: string
  count: number
  settings: AppSettings
  timeoutMs?: number
}): Promise<ScenePrompt[]> {
  const { userMessage, context, count, settings, timeoutMs = 15000 } = opts
  const n = Math.min(Math.max(count, 1), 4)
  const single = async (): Promise<ScenePrompt[]> => [{ label: '', prompt: await buildImagePrompt({ userMessage, context, settings }) }]
  if (n === 1) return single()
  try {
    if (!settings.defaultChatProviderId || !settings.defaultChatModel) return single()
    const llm = createLLMClient(settings.defaultChatProviderId, settings.defaultChatModel)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const parts: string[] = []
      if (context && context.trim()) parts.push(`【上下文 / 已生成文案（围绕它来配图）】\n${context.trim().slice(0, 4000)}`)
      parts.push(`【用户这轮的出图诉求】\n${userMessage.trim()}`)
      parts.push(`请输出最多 ${n} 条 JSON 数组（只输出数组本身）：`)
      const { text } = await generateText({
        model: llm,
        system: SET_SYSTEM.replace(/N/g, String(n)),
        prompt: parts.join('\n\n'),
        temperature: 0.5,
        maxTokens: 900,
        abortSignal: controller.signal
      })
      const scenes = parseScenes(text).slice(0, n)
      return scenes.length >= 2 ? scenes : single()
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return single()
  }
}

/** 从 LLM 文本里抠出 [{scene_label, prompt}] 数组，容忍代码块围栏/前后噪声。 */
function parseScenes(text: string): ScenePrompt[] {
  const raw = (text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as Array<{ scene_label?: string; label?: string; prompt?: string }>
    if (!Array.isArray(arr)) return []
    return arr
      .map(o => ({ label: String(o.scene_label || o.label || '').slice(0, 24), prompt: String(o.prompt || '').trim() }))
      .filter(s => s.prompt.length >= 4)
  } catch {
    return []
  }
}
