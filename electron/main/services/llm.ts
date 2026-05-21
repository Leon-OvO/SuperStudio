import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { LanguageModel } from 'ai'
import { getProviders } from './store'
import type { ProviderConfig } from '../../../src/shared/ipc-types'

export function createLLMClient(providerId: string, modelId: string): LanguageModel {
  const providers = getProviders()
  const provider = providers.find(p => p.id === providerId)
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  return buildModel(provider, modelId)
}

export function buildModel(provider: ProviderConfig, modelId: string): LanguageModel {
  switch (provider.type) {
    case 'openai': {
      // `strict` makes the SDK send `stream_options: { include_usage: true }`,
      // without which streaming responses don't carry token counts.
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
        compatibility: 'strict'
      })
      return client(modelId)
    }
    case 'custom': {
      // Same as 'openai' — most modern OpenAI-compatible proxies (OpenRouter,
      // Together, Groq, SuperCode gateway, etc.) honor `stream_options` and
      // need it on to return usage. If a downstream proxy chokes on the field,
      // it'd need a per-provider opt-out — add one then.
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || 'https://api.openai.com/v1',
        compatibility: 'strict'
      })
      return client(modelId)
    }
    case 'anthropic': {
      const client = createAnthropic({ apiKey: provider.apiKey })
      return client(modelId as Parameters<typeof client>[0])
    }
    case 'gemini': {
      const client = createGoogleGenerativeAI({ apiKey: provider.apiKey })
      return client(modelId)
    }
    default:
      throw new Error(`Unknown provider type: ${provider.type}`)
  }
}
