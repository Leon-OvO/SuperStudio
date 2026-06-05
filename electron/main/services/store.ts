import Store from 'electron-store'
import { safeStorage, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { ProviderConfig, AppSettings, McpServerConfig, WebhookBot, RemoteModelConf } from '../../../src/shared/ipc-types'

interface StoreSchema {
  providers: ProviderConfig[]
  settings: AppSettings
  mcpServers: McpServerConfig[]
}

/** Built-in fallback default model NAMES used when no remote model.conf has been
 *  fetched yet (offline / first launch / file not published). The remote
 *  model.conf overrides these via the managed-default mechanism in model-conf.ts.
 *  Single source of truth — referenced by the store defaults, the initial
 *  `appliedModelConf` snapshot, and the settings-reset handler. */
export const BUILTIN_MODEL_DEFAULTS: Required<RemoteModelConf> = {
  defaultChatModel: '',
  defaultImageModel: 'dall-e-3',
  defaultVideoModel: 'doubao-seedance-2-0',
  defaultEmbeddingModel: 'text-embedding-3-small',
}

const defaults: StoreSchema = {
  providers: [],
  mcpServers: [],
  settings: {
    defaultChatModel: BUILTIN_MODEL_DEFAULTS.defaultChatModel,
    defaultChatProviderId: '',
    defaultImageModel: BUILTIN_MODEL_DEFAULTS.defaultImageModel,
    defaultImageProviderId: '',
    defaultVideoModel: BUILTIN_MODEL_DEFAULTS.defaultVideoModel,
    defaultVideoProviderId: '',
    defaultEmbeddingModel: BUILTIN_MODEL_DEFAULTS.defaultEmbeddingModel,
    defaultEmbeddingProviderId: '',
    searchApiKey: '',
    searchProvider: 'bing',
    searxngUrl: '',
    searchBrowserVisible: false,
    kbGlobalEnabled: false,
    kbGlobalSpaceIds: [],
    memoryAutoCapture: true,
    computerUseEnabled: false,
    computerUsePrivacyCurtain: false,
    dataDirectory: '',
    autoModelEnabled: false,
    autoModelMode: 'standard',
    autoModelRoutes: {},
    autoModelSmartModel: '',
    buildRecentProjectDirs: [],
    vibeAutoApply: false,
    autoLaunch: false,
    shellIntegrationEnabled: true,
    startupPage: 'chat',
    webhookBots: [],
    proxyMode: 'off',
    proxyHost: '',
    proxyPort: 0,
    debugTrace: false,
    chatThinkingMode: 'auto',
    // Seed the managed-default snapshot with the built-in names, so on a fresh
    // install every default still equals its snapshot → the first model.conf
    // sync is free to update them. Diverges the moment the user picks their own.
    appliedModelConf: { ...BUILTIN_MODEL_DEFAULTS },
  }
}

// Legacy encryption key — used only for one-shot migration of pre-existing
// config files. Do NOT use for new writes.
const LEGACY_ENCRYPTION_KEY = 'superstudio-secure-key-v1'

// --- safeStorage helpers ------------------------------------------------
//
// Real secret protection: safeStorage delegates to the OS keychain (DPAPI on
// Windows, Keychain on macOS, libsecret on Linux). We prefix encrypted values
// with ENC_PREFIX so we can transparently handle legacy plaintext fields too.

const ENC_PREFIX = 'ss:enc1:'

function canEncrypt(): boolean {
  try { return safeStorage.isEncryptionAvailable() } catch { return false }
}

let warnedNoEncryption = false
function encryptString(plain: string): string {
  if (!plain) return ''
  if (!canEncrypt()) {
    if (!warnedNoEncryption) {
      console.warn('[store] safeStorage not available — secrets stored as plaintext')
      warnedNoEncryption = true
    }
    return plain
  }
  return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
}

function decryptString(value: string): string {
  if (!value) return ''
  if (!value.startsWith(ENC_PREFIX)) return value  // legacy plaintext / freshly-migrated
  if (!canEncrypt()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch (e) {
    console.warn('[store] failed to decrypt a secret (OS keychain mismatch?):', (e as Error).message)
    return ''
  }
}

export function encryptSecret(plain: string): string { return encryptString(plain) }
export function decryptSecret(value: string): string { return decryptString(value) }

function mapValues<T>(obj: Record<string, T>, fn: (v: T) => T): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(obj)) out[k] = fn(v)
  return out
}

// Webhook bots carry credentials in their URL (access_token) and optional 加签
// secret, so both are encrypted at rest just like provider API keys.
function encryptBots(bots: WebhookBot[]): WebhookBot[] {
  return (bots ?? []).map(b => ({
    ...b,
    url: encryptString(b.url || ''),
    secret: b.secret ? encryptString(b.secret) : b.secret
  }))
}
function decryptBots(bots: WebhookBot[]): WebhookBot[] {
  return (bots ?? []).map(b => ({
    ...b,
    url: decryptString(b.url || ''),
    secret: b.secret ? decryptString(b.secret) : b.secret
  }))
}

// --- Lazy store + one-shot migration -----------------------------------
//
// We create the store on first access (post-app.ready) because safeStorage
// requires the app to be ready. The constructor may throw SyntaxError when
// the on-disk config.json is still encrypted with the legacy key — in that
// case we re-open it with the old key, snapshot the data, delete the old
// file, and re-write under the new safeStorage scheme.

let storeInstance: Store<StoreSchema> | null = null

function createOrMigrateStore(): Store<StoreSchema> {
  // Path 1: fresh install OR already-migrated — plain constructor succeeds
  try {
    return new Store<StoreSchema>({ name: 'config', defaults })
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e
    console.log('[store] detected legacy encrypted config — migrating to safeStorage-backed encryption')
  }

  // Path 2: legacy-encrypted file found. Read with old key, snapshot, wipe, rewrite.
  let snapshot: StoreSchema
  try {
    const legacy = new Store<StoreSchema>({
      name: 'config',
      encryptionKey: LEGACY_ENCRYPTION_KEY,
      defaults
    })
    snapshot = {
      providers: (legacy.get('providers') ?? []) as ProviderConfig[],
      settings: { ...defaults.settings, ...((legacy.get('settings') as AppSettings | undefined) ?? {}) },
      mcpServers: (legacy.get('mcpServers') ?? []) as McpServerConfig[]
    }
  } catch (e) {
    console.warn('[store] legacy-key decryption also failed — config will be reset to defaults:', (e as Error).message)
    snapshot = JSON.parse(JSON.stringify(defaults))
  }

  // Delete the encrypted file so the next constructor sees a clean slate
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath)
  } catch (e) {
    console.warn('[store] could not remove old config file:', (e as Error).message)
  }

  const fresh = new Store<StoreSchema>({ name: 'config', defaults })
  // Re-encrypt every secret field with safeStorage before writing back
  fresh.set('providers', snapshot.providers.map(p => ({
    ...p,
    apiKey: encryptString(p.apiKey || '')
  })))
  fresh.set('settings', {
    ...snapshot.settings,
    searchApiKey: encryptString(snapshot.settings.searchApiKey || '')
  })
  fresh.set('mcpServers', snapshot.mcpServers.map(s => ({
    ...s,
    env: s.env ? mapValues(s.env, encryptString) : s.env,
    headers: s.headers ? mapValues(s.headers, encryptString) : s.headers
  })))
  console.log(`[store] migration complete: ${snapshot.providers.length} provider(s), ${snapshot.mcpServers.length} MCP server(s) re-encrypted`)
  return fresh
}

function getStore(): Store<StoreSchema> {
  if (!storeInstance) storeInstance = createOrMigrateStore()
  return storeInstance
}

// --- Providers ---------------------------------------------------------

export function getProviders(): ProviderConfig[] {
  const raw = (getStore().get('providers') ?? []) as ProviderConfig[]
  return raw.map(p => ({ ...p, apiKey: decryptString(p.apiKey || '') }))
}

export function saveProvider(provider: ProviderConfig): void {
  const list = (getStore().get('providers') ?? []) as ProviderConfig[]
  const encrypted: ProviderConfig = { ...provider, apiKey: encryptString(provider.apiKey || '') }
  const idx = list.findIndex(p => p.id === provider.id)
  if (idx >= 0) list[idx] = encrypted
  else list.push(encrypted)
  getStore().set('providers', list)
}

export function deleteProvider(id: string): void {
  const list = (getStore().get('providers') ?? []) as ProviderConfig[]
  getStore().set('providers', list.filter(p => p.id !== id))
}

// --- Settings ----------------------------------------------------------

export function getSettings(): AppSettings {
  const raw = getStore().get('settings') as AppSettings
  // Merge defaults so newly-added keys (autoLaunch, shellIntegrationEnabled, …)
  // surface as their declared default on installs upgraded from older versions.
  return {
    ...defaults.settings,
    ...raw,
    searchApiKey: decryptString(raw.searchApiKey || ''),
    webhookBots: decryptBots(raw.webhookBots ?? [])
  }
}

export function saveSettings(settings: Partial<AppSettings>): void {
  const current = (getStore().get('settings') ?? defaults.settings) as AppSettings
  const merged = { ...current, ...settings }
  const toPersist: AppSettings = {
    ...merged,
    searchApiKey: 'searchApiKey' in settings
      ? encryptString(merged.searchApiKey || '')
      : (current.searchApiKey || ''),
    webhookBots: 'webhookBots' in settings
      ? encryptBots(merged.webhookBots ?? [])
      : (current.webhookBots ?? [])
  }
  getStore().set('settings', toPersist)
}

export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****'
  return `${key.slice(0, 4)}****${key.slice(-4)}`
}

// --- MCP servers -------------------------------------------------------

export function getMcpServers(): McpServerConfig[] {
  const raw = (getStore().get('mcpServers') ?? []) as McpServerConfig[]
  return raw.map(s => ({
    ...s,
    env: s.env ? mapValues(s.env, decryptString) : s.env,
    headers: s.headers ? mapValues(s.headers, decryptString) : s.headers
  }))
}

export function saveMcpServer(server: McpServerConfig): void {
  const list = (getStore().get('mcpServers') ?? []) as McpServerConfig[]
  const encrypted: McpServerConfig = {
    ...server,
    env: server.env ? mapValues(server.env, encryptString) : server.env,
    headers: server.headers ? mapValues(server.headers, encryptString) : server.headers
  }
  const idx = list.findIndex(s => s.id === server.id)
  if (idx >= 0) list[idx] = encrypted
  else list.push(encrypted)
  getStore().set('mcpServers', list)
}

export function deleteMcpServer(id: string): void {
  const list = (getStore().get('mcpServers') ?? []) as McpServerConfig[]
  getStore().set('mcpServers', list.filter(s => s.id !== id))
}
