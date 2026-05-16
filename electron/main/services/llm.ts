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
      const client = createOpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl })
      return client(modelId)
    }
    case 'custom': {
      const client = createOpenAI({
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl || 'https://api.openai.com/v1'
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
