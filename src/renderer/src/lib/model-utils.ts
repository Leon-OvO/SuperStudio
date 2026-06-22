import type { ProviderConfig } from '../../../shared/ipc-types'

/** A Claude-family model (the family that supports Anthropic extended thinking).
 *  Mirrors `isClaudeModel()` in electron/main/services/llm.ts. Fable's id may be
 *  `claude-fable-5` or just `fable-5`. This is a FAMILY detector, not a per-version
 *  allowlist — it adapts to any Claude model rather than enumerating "which models". */
export function isClaudeFamilyModel(modelId: string | undefined): boolean {
  return /claude|fable/i.test(modelId || '')
}

/**
 * Whether to show the 思考模式 control — ADAPTIVE. A model can do extended thinking
 * iff it's Claude-family; so we show the control whenever the selected model is
 * Claude-family, OR the provider is anthropic-capable (covers anthropic-type
 * providers whose model id is non-obvious). NO hardcoded version allowlist.
 *
 * Note on delivery: thinking only actually reaches the wire on the anthropic-native
 * protocol — i.e. a `type: 'anthropic'` provider, or a custom/openai provider with
 * 「支持 Anthropic 原生协议」(`anthropicNative`) enabled. On a plain openai-compat
 * Claude endpoint the backend drops the thinking options (no-op) until that flag is
 * set. We still SHOW the control for any Claude model (the user asked for it to be
 * available whenever the model can think); the backend adapts the rest.
 */
export function supportsThinkingMode(
  provider: ProviderConfig | undefined,
  modelId: string | undefined
): boolean {
  if (isClaudeFamilyModel(modelId)) return true
  if (!provider) return false
  return provider.type === 'anthropic' || provider.anthropicNative === true
}
