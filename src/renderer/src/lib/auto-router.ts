import type { AppSettings, ProviderConfig, AutoModelIntent, Attachment } from '../../../shared/ipc-types'

export interface RouterResult {
  providerId: string
  model: string
  intent: AutoModelIntent
}

// --- Standard mode: keyword/heuristic rules (priority order) -----------

const CODE_RE = /代码|函数|bug|debug|python|javascript|typescript|java|golang|rust|sql|api|算法|编程|脚本|class |interface |import |export /i
const MATH_RE = /计算|积分|微分|方程|证明|数学|推导|math|calculus|formula|equation|derivative|matrix/i
const CREATIVE_RE = /写一篇|写一个故事|续写|诗歌|文案|剧本|创意|write.*story|写作|小说/i
const VISION_QUESTION_RE = /分析.*图|看.*图|这张图|图片.*内容|image.*anal|what.*image|describe.*image/i
const IMAGE_GEN_RE = /画一张|生成图|image.*generat|create.*image|dall-e/i

function detectStandardIntent(message: string, attachments: Attachment[]): AutoModelIntent {
  // 1. Vision: image attachment present OR vision question
  const hasImageAttachment = attachments.some(a => a.mimeType.startsWith('image/'))
  if (hasImageAttachment || VISION_QUESTION_RE.test(message)) return 'vision'

  // 2. Skip image-gen — not a chat intent, but match 'code' or 'default'
  if (IMAGE_GEN_RE.test(message)) return 'default'

  // 3. Code
  if (CODE_RE.test(message)) return 'code'

  // 4. Math
  if (MATH_RE.test(message)) return 'math'

  // 5. Creative
  if (CREATIVE_RE.test(message)) return 'creative'

  // 6. Quick: short message, no attachment, no code block
  if (message.length <= 80 && !attachments.length && !message.includes('```')) return 'quick'

  return 'default'
}

// --- Smart mode: LLM classifier (runs in MAIN via IPC) -----------------
//
// The classifier prompt + the actual model call live in the main process
// (electron/main/agent/classify.ts) so it goes through createLLMClient and
// therefore works for Anthropic/Gemini-native providers — a hardcoded
// /chat/completions fetch only worked for OpenAI-compatible ones. The renderer
// just delegates over IPC; on any failure the caller falls back to heuristics.

const VALID: AutoModelIntent[] = ['vision', 'code', 'math', 'creative', 'quick', 'default']

async function detectSmartIntent(
  message: string,
  classifierProviderId: string,
  classifierModel: string
): Promise<AutoModelIntent> {
  try {
    const label = await window.api.classifyIntent(message, classifierProviderId, classifierModel)
    return VALID.includes(label as AutoModelIntent) ? (label as AutoModelIntent) : 'default'
  } catch {
    return 'default'
  }
}

// --- Route lookup ------------------------------------------------------

function lookupRoute(intent: AutoModelIntent, settings: AppSettings): { providerId: string; model: string } | null {
  const routes = settings.autoModelRoutes ?? {}
  const entry = routes[intent] || routes['default'] || ''
  if (!entry) return null
  const [providerId, model] = entry.split('::')
  if (!providerId || !model) return null
  return { providerId, model }
}

// --- Public API --------------------------------------------------------

export async function resolveModel(
  message: string,
  attachments: Attachment[],
  settings: AppSettings,
  _providers: ProviderConfig[]
): Promise<RouterResult | null> {
  if (!settings.autoModelEnabled) return null

  let intent: AutoModelIntent

  if (settings.autoModelMode === 'smart' && settings.autoModelSmartModel) {
    const [pid, m] = settings.autoModelSmartModel.split('::')
    if (pid && m) {
      try {
        intent = await detectSmartIntent(message, pid, m)
      } catch {
        intent = detectStandardIntent(message, attachments)
      }
    } else {
      intent = detectStandardIntent(message, attachments)
    }
  } else {
    intent = detectStandardIntent(message, attachments)
  }

  const route = lookupRoute(intent, settings)
  if (!route) return null

  return { ...route, intent }
}
