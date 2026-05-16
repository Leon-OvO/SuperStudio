import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import { getSettings, saveSettings, getProviders, saveProvider, deleteProvider } from '../services/store'
import { createLLMClient } from '../services/llm'

export function settingsHandlers(): void {
  ipcMain.handle(IPC.SETTINGS_GET, () => getSettings())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, data) => saveSettings(data))

  ipcMain.handle(IPC.PROVIDERS_LIST, () => getProviders())
  ipcMain.handle(IPC.PROVIDERS_SAVE, (_e, provider) => {
    saveProvider(provider)
    return { ok: true }
  })
  ipcMain.handle(IPC.PROVIDERS_DELETE, (_e, id) => {
    deleteProvider(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.PROVIDERS_FETCH_MODELS, async (_e, providerId: string) => {
    const providers = getProviders()
    const provider = providers.find(p => p.id === providerId)
    if (!provider) throw new Error('Provider not found')
    if (provider.type !== 'openai' && provider.type !== 'custom') {
      throw new Error('Auto-fetch only supported for OpenAI-compatible providers')
    }
    const baseUrl = provider.baseUrl || 'https://api.openai.com'
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` }
    })
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`)
    const json = await res.json() as { data: { id: string }[] }
    return json.data.map(m => m.id)
  })
}
