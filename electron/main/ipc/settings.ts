import { ipcMain, dialog, BrowserWindow } from 'electron'
import fs from 'fs'
import { IPC } from '../../../src/shared/ipc-types'
import { getSettings, saveSettings, getProviders, saveProvider, deleteProvider, getMcpServers, saveMcpServer } from '../services/store'
import type { McpServerConfig, ProviderConfig } from '../../../src/shared/ipc-types'

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
    const baseUrl = (provider.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` }
    })
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`)
    const json = await res.json() as { data: { id: string }[] }
    return json.data.map(m => m.id)
  })

  /**
   * Test a provider configuration WITHOUT persisting it. Hits the cheapest
   * reachability endpoint per protocol and reports back a friendly result.
   */
  ipcMain.handle(IPC.PROVIDERS_TEST, async (_e, p: ProviderConfig) => {
    try {
      if (!p.apiKey) return { ok: false, error: 'API Key 为空' }
      if (p.type === 'openai' || p.type === 'custom') {
        const baseUrl = (p.baseUrl || 'https://api.openai.com').replace(/\/v1\/?$/, '')
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${p.apiKey}` }
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}` }
        }
        const json = await res.json() as { data?: Array<{ id: string }> }
        return { ok: true, modelCount: json.data?.length ?? 0 }
      }
      if (p.type === 'anthropic') {
        // Anthropic has no public `/v1/models` so we send a tiny ping with a
        // bogus model and parse the error type to distinguish "bad key" (401)
        // from other failures.
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': p.apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
        })
        if (res.status === 401) return { ok: false, error: 'API Key 无效（401）' }
        if (res.status === 403) return { ok: false, error: '权限不足（403）' }
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
        }
        return { ok: true }
      }
      if (p.type === 'gemini') {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(p.apiKey)}`)
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
        }
        const json = await res.json() as { models?: Array<unknown> }
        return { ok: true, modelCount: json.models?.length ?? 0 }
      }
      return { ok: false, error: `未知协议类型: ${p.type}` }
    } catch (e) {
      return { ok: false, error: (e as Error).message || '网络错误' }
    }
  })

  // ---- whole-app config backup ----------------------------------------
  //
  // Exports providers + settings + MCP servers as JSON. API keys are
  // re-encrypted via safeStorage on the destination machine — moving the
  // file across machines means secrets in it can't actually be decrypted
  // there, so the user has to re-fill keys after import. The other
  // settings (default model selections, MCP commands, base URLs, model
  // lists) all survive cleanly.

  ipcMain.handle(IPC.CONFIG_EXPORT, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const opts = {
      defaultPath: `superstudio-config-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (dlg.canceled || !dlg.filePath) return { canceled: true }

    // NOTE: getProviders / getMcpServers return DECRYPTED values from store.
    // We re-serialize as-is; on import we'll re-encrypt via the regular
    // save helpers so the keychain hop happens automatically.
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      providers: getProviders(),
      settings: getSettings(),
      mcpServers: getMcpServers()
    }
    fs.writeFileSync(dlg.filePath, JSON.stringify(payload, null, 2), 'utf8')
    return { canceled: false, filePath: dlg.filePath }
  })

  ipcMain.handle(IPC.CONFIG_IMPORT, async (e, opts?: { strategy?: 'merge' | 'replace' }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const strategy = opts?.strategy ?? 'merge'  // safe default
    const dlgOpts = {
      properties: ['openFile' as const],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    }
    const dlg = win ? await dialog.showOpenDialog(win, dlgOpts) : await dialog.showOpenDialog(dlgOpts)
    if (dlg.canceled || dlg.filePaths.length === 0) return { canceled: true }

    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(dlg.filePaths[0], 'utf8'))
    } catch (e) {
      return { canceled: false, error: '文件不是合法 JSON：' + (e as Error).message }
    }
    const data = parsed as {
      version?: number
      providers?: ProviderConfig[]
      settings?: Record<string, unknown>
      mcpServers?: McpServerConfig[]
    }
    if (!data || typeof data !== 'object' || (data.version !== 1)) {
      return { canceled: false, error: '不是 SuperStudio 配置导出文件（缺少 version=1）' }
    }

    // 'replace' = nuke local list first; 'merge' = keep existing IDs and only
    // overwrite when the imported file has the same id (saveProvider/saveMcpServer
    // already handle that idempotently because they update by id).
    if (strategy === 'replace') {
      for (const p of getProviders()) deleteProvider(p.id)
      const existingMcp = getMcpServers()
      const { deleteMcpServer } = await import('../services/store')
      for (const s of existingMcp) deleteMcpServer(s.id)
    }

    let imported = { providers: 0, mcp: 0, settings: 0 }
    for (const p of data.providers ?? []) {
      // Save through public helper so safeStorage re-encrypts the key for THIS machine
      saveProvider(p)
      imported.providers++
    }
    for (const s of data.mcpServers ?? []) {
      saveMcpServer(s)
      imported.mcp++
    }
    if (data.settings && typeof data.settings === 'object') {
      saveSettings(data.settings as Parameters<typeof saveSettings>[0])
      imported.settings = 1
    }
    return { canceled: false, imported, strategy, filePath: dlg.filePaths[0] }
  })
}
