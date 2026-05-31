import type { ProviderConfig } from '../../../../src/shared/ipc-types'
import type { VideoProviderAdapter } from './types'
import { openAiCompatAdapter } from './openai-compat'

/**
 * Ordered list of registered adapters. Detection is first-match-wins, so
 * provider-specific adapters (e.g. Kling, Sora-native) MUST be inserted
 * above `openAiCompatAdapter` — it's the catch-all fallback.
 *
 * When adding a new provider:
 *   1. Create `./<name>.ts` exporting a `VideoProviderAdapter`
 *   2. Implement `matches()` strictly (e.g. baseUrl host check + model prefix)
 *   3. Insert it before the catch-all in the array below
 */
const ADAPTERS: VideoProviderAdapter[] = [
  openAiCompatAdapter
]

export function pickAdapter(provider: ProviderConfig, model: string): VideoProviderAdapter {
  for (const a of ADAPTERS) {
    if (a.matches(provider, model)) return a
  }
  // Unreachable while openAiCompatAdapter is the catch-all, but guard so a
  // future refactor (someone tightening matches()) fails loudly here instead
  // of returning undefined to the caller.
  throw new Error(`No video adapter matched provider=${provider.name} model=${model}`)
}

export type { VideoProviderAdapter, VideoJobInput, AdapterContext, SubmitResult, PollResult } from './types'
