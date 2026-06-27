import { ipcMain } from 'electron'
import { generateText } from 'ai'
import { IPC } from '../../../src/shared/ipc-types'
import { createLLMClient } from '../services/llm'
import { getSettings } from '../services/store'
import { getEmployee } from '../services/employees-db'
import { getSoul } from '../services/talent-pool'
import { loadImageParts } from '../services/vision-images'

interface AdviseParams { goal: string; referenceImagePaths?: string[]; expertIds: string[] }
interface ExpertAdvice { id: string; name: string; dept: string; text: string }

const ADVISE_TIMEOUT_MS = 45_000

/**
 * 画布「专家团出谋划策」: each chosen employee advises (in parallel, using their own
 * soul + model) on a single image-generation goal, then a synthesis pass fuses
 * everyone's advice into one image prompt. Mirrors CANVAS_EXPAND_PROMPT's
 * createLLMClient + generateText + reference-image pattern, multiplied per expert.
 */
export function canvasExpertHandlers(): void {
  ipcMain.handle(IPC.CANVAS_EXPERT_ADVISE, async (_e, params: AdviseParams) => {
    const settings = getSettings()
    const goal = String(params?.goal || '').trim()
    if (!goal) return { ok: false, error: '请先描述你想要的画面目标' }
    const expertIds = (params?.expertIds || []).filter(Boolean)
    if (!expertIds.length) return { ok: false, error: '请先选择至少一位专家' }

    const imageParts = loadImageParts(params?.referenceImagePaths)
    const hasImages = imageParts.length > 0
    const userContent = hasImages ? [{ type: 'text' as const, text: goal }, ...imageParts] : goal

    // Each expert advises in parallel with their own persona + assigned model.
    const results = await Promise.all(expertIds.map(async (id): Promise<ExpertAdvice | null> => {
      try {
        const emp = getEmployee(id)
        if (!emp) return null
        const soul = getSoul(emp.soulId)
        const providerId = emp.providerId || settings.defaultChatProviderId
        const model = emp.modelId || settings.defaultChatModel
        if (!providerId || !model) return null
        const system =
          `你是「${emp.name}」，正在为一次 AI 图像生成提供专业建议。\n\n` +
          `===== 你的专业人设（务必入戏）=====\n${(soul?.systemPrompt || '').trim()}\n===== 人设结束 =====\n\n` +
          `用户会给出图像生成目标（可能附参考图）。请【只从你的专业角度】给出 2–4 条精炼、可直接写进提示词的中文画面建议；忠于用户的核心主题，不改变主体，不要分点解释原理、不要客套，直接给可落地的画面描述词。`
        const llm = createLLMClient(providerId, model)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), ADVISE_TIMEOUT_MS)
        try {
          const { text } = await generateText({
            model: llm, system,
            messages: [{ role: 'user', content: userContent }],
            maxTokens: 400, abortSignal: controller.signal,
          })
          const t = text.trim()
          return t ? { id, name: emp.name, dept: emp.dept, text: t } : null
        } finally { clearTimeout(timer) }
      } catch { return null }
    }))
    const advices = results.filter((a): a is ExpertAdvice => !!a)
    if (!advices.length) return { ok: false, error: '专家未能给出建议（请检查员工的模型配置）' }

    // Synthesize everyone's advice into one image-generation prompt.
    let refinedPrompt = goal
    const synthProvider = settings.defaultChatProviderId
    const synthModel = settings.defaultChatModel
    if (synthProvider && synthModel) {
      try {
        const adviceBlock = advices.map(a => `【${a.name}】\n${a.text}`).join('\n\n')
        const system =
          '你是 AI 图像生成的提示词总监。把用户的目标与多位专家的建议融合成一段具体、有画面感的中文图像生成提示词：综合采纳灯光、光圈/镜头、构图、色彩、风格、质感等专业建议，但必须忠于用户原意、不改变核心主题、不加入与原意冲突的元素。直接输出最终提示词正文即可，不要解释、不要加引号、不要分点或编号。'
        const synthText = `用户目标：${goal}\n\n专家建议：\n${adviceBlock}`
        const synthUser = hasImages ? [{ type: 'text' as const, text: synthText }, ...imageParts] : synthText
        const llm = createLLMClient(synthProvider, synthModel)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), ADVISE_TIMEOUT_MS)
        try {
          const { text } = await generateText({
            model: llm, system,
            messages: [{ role: 'user', content: synthUser }],
            maxTokens: 600, abortSignal: controller.signal,
          })
          if (text.trim()) refinedPrompt = text.trim()
        } finally { clearTimeout(timer) }
      } catch { /* keep goal as the fallback prompt */ }
    }

    return { ok: true, advices, refinedPrompt }
  })
}
