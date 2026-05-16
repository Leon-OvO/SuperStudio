import Store from 'electron-store'
import { ProviderConfig, AppSettings, McpServerConfig } from '../../../src/shared/ipc-types'

interface StoreSchema {
  providers: ProviderConfig[]
  settings: AppSettings
  mcpServers: McpServerConfig[]
}

const defaults: StoreSchema = {
  providers: [],
  mcpServers: [],
  settings: {
    defaultChatModel: '',
    defaultChatProviderId: '',
    defaultImageModel: 'dall-e-3',
    defaultImageProviderId: '',
    defaultVideoModel: 'doubao-seedance-2-0',
    defaultVideoProviderId: '',
    defaultEmbeddingModel: 'text-embedding-3-small',
    defaultEmbeddingProviderId: '',
    searchApiKey: '',
    searchProvider: 'tavily',
    kbGlobalEnabled: false,
    kbGlobalSpaceIds: [],
    dataDirectory: '',
  }
}

export const store = new Store<StoreSchema>({
  name: 'config',
  encryptionKey: 'superstudio-secure-key-v1',
  defaults
})

export function getProviders(): ProviderConfig[] {
  return store.get('providers')
}

export function saveProvider(provider: ProviderConfig): void {
  const providers = getProviders()
  const idx = providers.findIndex(p => p.id === provider.id)
  if (idx >= 0) {
    providers[idx] = provider
  } else {
    providers.push(provider)
  }
  store.set('providers', providers)
}

export function deleteProvider(id: string): void {
  const providers = getProviders().filter(p => p.id !== id)
  store.set('providers', providers)
}

export function getSettings(): AppSettings {
  return store.get('settings')
}

export function saveSettings(settings: Partial<AppSettings>): void {
  const current = getSettings()
  store.set('settings', { ...current, ...settings })
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

export function getMcpServers(): McpServerConfig[] {
  return store.get('mcpServers') ?? []
}

export function saveMcpServer(server: McpServerConfig): void {
  const list = getMcpServers()
  const idx = list.findIndex(s => s.id === server.id)
  if (idx >= 0) list[idx] = server
  else list.push(server)
  store.set('mcpServers', list)
}

export function deleteMcpServer(id: string): void {
  store.set('mcpServers', getMcpServers().filter(s => s.id !== id))
}
