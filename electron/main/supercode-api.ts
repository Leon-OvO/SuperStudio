/**
 * SuperCode.help REST API client for the main process.
 * All HTTP calls go through here; tokens never leave the main process.
 */

import { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-types'
import { logApiRequest, sanitizeUrl } from './services/request-log'

const BASE = 'https://www.supercode.help'
const MODELS_BASE = 'https://api.supercode.help'

// --- Types mirroring the API response shapes ---------------------------

export interface LoginResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export interface SuperCodeUser {
  id: number
  email: string
  username?: string
}

export interface SuperCodeKey {
  id: number
  key: string
  name: string
  group_id: number
  status: string
  quota: number
  quota_used: number
}

export interface AvailableGroup {
  id: number
  name: string
  status: string
  platform: string
}

/**
 * Snapshot from `GET /api/v1/subscription/me` — the user's current plan
 * status. Server returns a single object (or 404/401 when not subscribed),
 * with periods in ISO datetime and quotas in "opus-equivalent" units that
 * normalize across model tiers. `breakdown_by_model` lists per-model usage.
 */
export interface SubscriptionStatus {
  planType: string                // e.g. 'lite' | 'pro' | 'max'
  periodStart: number | null      // unix ms
  periodEnd: number | null        // unix ms
  quotaOpusEquivalent: number     // total allowance for the period (0 = unlimited / unset)
  usedOpusEquivalent: number      // used so far (same unit as quota)
  usedRawTotal: number            // raw token count for transparency
  breakdownByModel: { model: string; used: number }[]
  autoRenew: boolean
  status: string                  // 'active' | 'expired' | 'cancelled' | ...
}

export interface OpenAIModel {
  id: string
  object: string
}

// --- Token accessor (injected from auth-store) -------------------------

let _getToken: (() => string) | null = null
let _getRefreshToken: (() => string) | null = null
let _storeTokens: ((access: string, refresh: string) => void) | null = null
let _clearTokens: (() => void) | null = null
let _tryReLogin: (() => Promise<boolean>) | null = null

export function initApiClient(opts: {
  getToken: () => string
  getRefreshToken: () => string
  storeTokens: (access: string, refresh: string) => void
  clearTokens: () => void
  tryReLogin?: () => Promise<boolean>
}): void {
  _getToken = opts.getToken
  _getRefreshToken = opts.getRefreshToken
  _storeTokens = opts.storeTokens
  _clearTokens = opts.clearTokens
  _tryReLogin = opts.tryReLogin ?? null
}

// --- Core fetch wrapper ------------------------------------------------

async function rawFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = _getToken?.() ?? ''
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> ?? {})
  }
  const method = ((init?.method || 'GET') as string).toUpperCase()
  const reqBytes = typeof init?.body === 'string' ? Buffer.byteLength(init.body) : undefined
  const t0 = Date.now()
  try {
    const res = await fetch(url, { ...init, headers })
    logApiRequest({ kind: 'account', method, url: sanitizeUrl(url), status: res.status, ok: res.ok, durationMs: Date.now() - t0, reqBytes })
    return res
  } catch (e) {
    logApiRequest({ kind: 'account', method, url: sanitizeUrl(url), ok: false, durationMs: Date.now() - t0, reqBytes, error: String((e as Error)?.message || e) })
    throw e
  }
}

// --- Refresh single-flight ----------------------------------------------
//
// 服务端对 refresh_token 做轮转（每次刷新都下发新 refresh_token 且旧的失效）。
// 并发打多个接口同时收到 401 时，若各自独立发起 refresh，第 2..N 个请求会拿着
// 已经被第 1 个请求"消费掉"的旧 refresh_token 去刷新，必然失败，各自退到用明文
// 密码重登；若服务端把重复使用判定为"家族重放"甚至会吊销整族 refresh_token，
// 导致用户莫名其妙被强制登出。用一个模块级 in-flight promise 把并发 401 收拢成
// 一次真实的刷新（含兜底重登），其余调用者只是等这同一个 promise。
let refreshInFlight: Promise<boolean> | null = null

async function doRefresh(): Promise<boolean> {
  // 1) 优先走 refresh-token 流程（便宜，不用走一遍密码）
  let recovered = false
  const refreshToken = _getRefreshToken?.() ?? ''
  if (refreshToken) {
    try {
      const refreshRes = await fetch(`${BASE}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken })
      })
      if (refreshRes.ok) {
        const refreshData = await refreshRes.json() as LoginResponse
        _storeTokens?.(refreshData.access_token, refreshData.refresh_token)
        recovered = true
      }
    } catch { /* fall through to re-login */ }
  }

  // 2) refresh 失败/缺失时，兜底用已保存的凭据静默重登——必须在同一个
  //    in-flight 里执行，否则并发调用者各自触发兜底重登，等于没修。
  if (!recovered && _tryReLogin) {
    try {
      recovered = await _tryReLogin()
    } catch { recovered = false }
  }
  return recovered
}

/** 确保拿到一份新鲜会话；并发调用者共享同一次刷新（含兜底重登）。 */
function ensureFreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

/**
 * Fetch with auto-refresh on 401. Retries once after refreshing.
 * On refresh failure, clears tokens and emits AUTH_STATE_CHANGED to renderer.
 */
export async function superCodeFetch(url: string, init?: RequestInit): Promise<Response> {
  let res = await rawFetch(url, init)

  if (res.status === 401) {
    const recovered = await ensureFreshSession()

    if (!recovered) {
      handleAuthFailure()
      throw new Error('Session expired — please log in again')
    }
    // Retry original request with new token
    res = await rawFetch(url, init)
  }

  return res
}

function handleAuthFailure(): void {
  _clearTokens?.()
  // Notify all renderer windows
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.AUTH_STATE_CHANGED, { isLoggedIn: false, user: null, keyId: null, keyValue: '' })
  }
}

// --- API methods -------------------------------------------------------

export async function apiLogin(email: string, password: string): Promise<LoginResponse> {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string }
    throw new Error(body.detail || `登录失败 (${res.status})`)
  }
  return res.json() as Promise<LoginResponse>
}

export async function apiLogout(): Promise<void> {
  try {
    await superCodeFetch(`${BASE}/api/v1/auth/logout`, { method: 'POST' })
  } catch {
    // logout is always completed locally — ignore network errors
  }
}

export async function apiGetMe(): Promise<SuperCodeUser> {
  const res = await superCodeFetch(`${BASE}/api/v1/auth/me`)
  if (!res.ok) throw new Error(`获取用户信息失败 (${res.status})`)
  return res.json() as Promise<SuperCodeUser>
}

function unwrapArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    for (const key of ['data', 'items', 'keys', 'groups', 'list', 'results', 'records']) {
      const v = (raw as Record<string, unknown>)[key]
      if (Array.isArray(v)) return v as T[]
    }
  }
  return []
}

export async function apiListKeys(): Promise<SuperCodeKey[]> {
  const res = await superCodeFetch(`${BASE}/api/v1/keys`)
  if (!res.ok) throw new Error(`获取 Key 列表失败 (${res.status})`)
  const raw = await res.json()
  const list = unwrapArray<Record<string, unknown>>(raw)
  // Normalize field names — some APIs return `api_key`, `secret_key`, etc.
  // Some endpoints also mask the key value on list calls; we keep what we get.
  const normalized: SuperCodeKey[] = list.map(o => ({
    id: Number(o.id),
    key: String(o.key ?? o.api_key ?? o.secret_key ?? o.value ?? ''),
    name: String(o.name ?? ''),
    group_id: Number(o.group_id ?? o.groupId ?? 0),
    status: String(o.status ?? 'active'),
    quota: Number(o.quota ?? 0),
    quota_used: Number(o.quota_used ?? 0)
  }))
  if (normalized.length > 0) {
    const k = normalized[0]
    console.log(`[supercode-api] apiListKeys returned ${normalized.length} keys (first: id=${k.id} key.length=${k.key.length})`)
  }
  return normalized
}

/**
 * Get all available groups for the user.
 * NOTE: Despite the URL containing "available-platforms", this endpoint returns
 * the rich group data (id, name, platform, status). The similarly-named
 * /available-groups endpoint returns something different (user keys / empty).
 */
export async function apiGetAvailableGroups(): Promise<AvailableGroup[]> {
  const res = await superCodeFetch(`${BASE}/api/v1/keys/meta/available-platforms`)
  if (!res.ok) throw new Error(`获取可用分组失败 (${res.status})`)
  const raw = await res.json()
  console.log('[supercode-api] available-platforms raw (= groups):', JSON.stringify(raw).slice(0, 800))
  const list = unwrapArray<Record<string, unknown>>(raw)
  // Normalize field names — APIs vary in casing / naming
  const groups: AvailableGroup[] = list.map(o => ({
    id: Number(o.id ?? o.group_id ?? o.groupId ?? 0),
    name: String(o.name ?? o.group_name ?? o.groupName ?? ''),
    platform: String(o.platform ?? o.provider ?? o.type ?? ''),
    status: String(o.status ?? 'active')
  })).filter(g => g.id > 0 && g.platform)
  console.log(`[supercode-api] parsed ${groups.length} groups:`,
    JSON.stringify(groups.map(g => `${g.platform}:${g.name}#${g.id}(${g.status})`)))
  return groups
}

export async function apiCreateKey(name: string, groupId: number): Promise<SuperCodeKey> {
  const res = await superCodeFetch(`${BASE}/api/v1/keys`, {
    method: 'POST',
    body: JSON.stringify({ name, group_id: groupId })
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string }
    throw new Error(body.detail || `创建 Key 失败 (${res.status})`)
  }
  const raw = await res.json()
  // Try raw directly; if no top-level id/key, try .data wrapper
  function tryShape(o: unknown): Record<string, unknown> | null {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const r = o as Record<string, unknown>
    const hasKey = typeof r.key === 'string' || typeof r.api_key === 'string' || typeof r.value === 'string' || typeof r.secret_key === 'string'
    const hasId = r.id != null
    return (hasKey || hasId) ? r : null
  }
  const obj = tryShape(raw)
    ?? tryShape((raw as Record<string, unknown>)?.data)
    ?? (raw as Record<string, unknown>)

  const created: SuperCodeKey = {
    id: Number(obj.id),
    key: String(obj.key ?? obj.api_key ?? obj.secret_key ?? obj.value ?? ''),
    name: String(obj.name ?? name),
    group_id: Number(obj.group_id ?? groupId),
    status: String(obj.status ?? 'active'),
    quota: Number(obj.quota ?? 0),
    quota_used: Number(obj.quota_used ?? 0)
  }
  console.log(`[supercode-api] apiCreateKey id=${created.id} key.length=${created.key.length} first8=${created.key.slice(0, 8)}`)
  if (!created.key || !created.id) {
    console.warn('[supercode-api] apiCreateKey returned without key/id; raw:', JSON.stringify(raw).slice(0, 500))
    throw new Error('创建 Key 失败：服务器未返回密钥')
  }
  return created
}

/**
 * Fetch the user's current subscription status from `/api/v1/subscription/me`.
 * Returns null when the user has no plan (404) or isn't signed in (401) —
 * the UI shows an "尚未订阅" empty state in that case rather than an error,
 * since being on the free tier is a normal state, not a failure.
 */
export async function apiGetSubscriptionStatus(): Promise<SubscriptionStatus | null> {
  const res = await superCodeFetch(`${BASE}/api/v1/subscription/me`)
  if (res.status === 404 || res.status === 401) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取套餐状态失败 (${res.status}) ${body.slice(0, 200)}`)
  }
  // The endpoint may answer 200 with a literal `null` (or empty/unparseable)
  // body when the user has no active plan — treat that exactly like 404/401:
  // "no plan", not a crash. Reading `.breakdown_by_model` off a null `o` was the
  // source of `Cannot read properties of null (reading 'breakdown_by_model')`.
  const o = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!o || typeof o !== 'object') {
    console.log('[supercode-api] subscription/me returned null/empty body → no plan')
    return null
  }
  console.log('[supercode-api] subscription/me raw:', JSON.stringify(o).slice(0, 800))

  const parseTs = (v: unknown): number | null => {
    if (v == null) return null
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
    if (typeof v === 'string') {
      const t = Date.parse(v)
      return Number.isFinite(t) ? t : null
    }
    return null
  }

  const breakdown: { model: string; used: number }[] = Array.isArray(o.breakdown_by_model)
    ? (o.breakdown_by_model as unknown[]).map(b => {
        const r = (b ?? {}) as Record<string, unknown>
        return { model: String(r.model ?? ''), used: Number(r.used ?? 0) }
      }).filter(b => b.model)
    : []

  return {
    planType: String(o.plan_type ?? 'unknown'),
    periodStart: parseTs(o.period_start),
    periodEnd: parseTs(o.period_end),
    quotaOpusEquivalent: Number(o.quota_opus_equivalent ?? 0),
    usedOpusEquivalent: Number(o.used_opus_equivalent ?? 0),
    usedRawTotal: Number(o.used_raw_total ?? 0),
    breakdownByModel: breakdown,
    autoRenew: !!o.auto_renew,
    status: String(o.status ?? 'unknown')
  }
}

export async function apiDeleteKey(keyId: number): Promise<void> {
  const res = await superCodeFetch(`${BASE}/api/v1/keys/${keyId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`删除 Key 失败 (${res.status}) ${body.slice(0, 200)}`)
  }
}

/**
 * GET /api/v1/keys/{id} — returns the full key object with the **plaintext** `key`
 * value (the list endpoint masks it). Used to recover the real key on session
 * restore and for the Token-Plan-key "copy" button. Works for both standalone
 * keys and subscription keys because they share an id space.
 */
export async function apiGetKeyPlaintext(keyId: number): Promise<string> {
  const res = await superCodeFetch(`${BASE}/api/v1/keys/${keyId}`)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取 Key 明文失败 (${res.status}) ${body.slice(0, 200)}`)
  }
  const raw = await res.json() as Record<string, unknown>
  // Some servers wrap the response in { data: {...} }
  const obj: Record<string, unknown> = raw.id != null
    ? raw
    : ((raw.data as Record<string, unknown>) ?? raw)
  const key = String(obj.key ?? obj.api_key ?? obj.secret_key ?? obj.value ?? '')
  if (!key) {
    console.warn('[supercode-api] apiGetKeyPlaintext returned empty key; raw:', JSON.stringify(raw).slice(0, 500))
    throw new Error('服务器未返回 Key 明文')
  }
  return key
}

// --- Subscription keys -------------------------------------------------
//
// Subscription plans (lite / pro / max) use a SEPARATE key-management endpoint
// from the standalone /api/v1/keys flow. Subscription keys are bound to the
// user's active plan and carry richer group metadata (the group object comes
// embedded in the GET response, so we don't need a follow-up /available-platforms
// call to find them). For lite-plan users, the regular /api/v1/keys/meta endpoint
// may return zero groups even though they have a valid subscription — only the
// /subscription/keys endpoint surfaces those groups.

export interface SubscriptionKeyGroup {
  id: number
  name: string
  platform: string
  status: string
  subscription_type?: string
}

export interface SubscriptionKey {
  id: number
  key: string  // may be masked (e.g. "sk-d8d66...3b43") on GET
  name: string
  group_id: number
  status: string
  group?: SubscriptionKeyGroup
}

function parseSubscriptionKey(o: Record<string, unknown>): SubscriptionKey {
  const rawGroup = o.group as Record<string, unknown> | undefined
  const group: SubscriptionKeyGroup | undefined = rawGroup ? {
    id: Number(rawGroup.id ?? 0),
    name: String(rawGroup.name ?? ''),
    platform: String(rawGroup.platform ?? ''),
    status: String(rawGroup.status ?? 'active'),
    subscription_type: rawGroup.subscription_type != null ? String(rawGroup.subscription_type) : undefined
  } : undefined
  return {
    id: Number(o.id ?? 0),
    key: String(o.key ?? o.api_key ?? o.secret_key ?? o.value ?? ''),
    name: String(o.name ?? ''),
    group_id: Number(o.group_id ?? group?.id ?? 0),
    status: String(o.status ?? 'active'),
    group
  }
}

export async function apiListSubscriptionKeys(): Promise<SubscriptionKey[]> {
  const res = await superCodeFetch(`${BASE}/api/v1/subscription/keys`)
  // Treat 404 (no subscription) the same as an empty list — caller decides what to do.
  if (res.status === 404 || res.status === 401) return []
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`获取订阅 Key 失败 (${res.status}) ${body.slice(0, 200)}`)
  }
  const raw = await res.json()
  const list = unwrapArray<Record<string, unknown>>(raw)
  const parsed = list.map(parseSubscriptionKey)
  console.log(`[supercode-api] apiListSubscriptionKeys: ${parsed.length} keys (groups: ${
    JSON.stringify(parsed.map(k => `${k.group?.platform ?? '?'}:${k.group?.name ?? '?'}#${k.group?.id ?? '?'}`))
  })`)
  return parsed
}

export async function apiCreateSubscriptionKey(name: string, groupId?: number): Promise<SubscriptionKey> {
  // Some backends derive group_id automatically from the user's active plan
  // when omitted; others require it. Send group_id when we have one to avoid
  // ambiguity.
  const body: Record<string, unknown> = { name }
  if (groupId && groupId > 0) body.group_id = groupId

  const res = await superCodeFetch(`${BASE}/api/v1/subscription/keys`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ detail: res.statusText })) as { detail?: string }
    throw new Error(errBody.detail || `创建订阅 Key 失败 (${res.status})`)
  }
  const raw = await res.json()
  // Response may be either the bare key object or wrapped in { data: ... }
  const obj: Record<string, unknown> = (raw && typeof raw === 'object' && !Array.isArray(raw))
    ? (
        (raw as Record<string, unknown>).id != null
          ? (raw as Record<string, unknown>)
          : ((raw as Record<string, unknown>).data as Record<string, unknown>) ?? (raw as Record<string, unknown>)
      )
    : {}
  const parsed = parseSubscriptionKey(obj)
  console.log(`[supercode-api] apiCreateSubscriptionKey id=${parsed.id} key.length=${parsed.key.length}`)
  if (!parsed.id || !parsed.key) {
    console.warn('[supercode-api] apiCreateSubscriptionKey returned without key/id; raw:', JSON.stringify(raw).slice(0, 500))
    throw new Error('创建订阅 Key 失败：服务器未返回密钥')
  }
  return parsed
}

export async function apiDeleteSubscriptionKey(keyId: number): Promise<void> {
  const res = await superCodeFetch(`${BASE}/api/v1/subscription/keys/${keyId}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '')
    throw new Error(`删除订阅 Key 失败 (${res.status}) ${body.slice(0, 200)}`)
  }
}

/**
 * Filter a raw model id list down to those that belong to a given platform.
 * The supercode /v1/models endpoint returns ALL models the account has access
 * to, regardless of which key you call it with — so we filter client-side based
 * on well-known model-name patterns per platform.
 *
 * Returns the original list unchanged when platform is unknown / no rule matches.
 */
export function filterModelsForPlatform(models: string[], platform: string): string[] {
  const p = platform.toLowerCase()
  const rules: Record<string, RegExp> = {
    anthropic: /(^claude|^anthropic[.-])/i,
    openai: /(^(gpt|o[1-9]|chatgpt|text-davinci|text-embedding|whisper|tts|dall-e|dalle))/i,
    google: /(^(gemini|palm|bison|imagen))/i,
    gemini: /(^(gemini|palm|bison|imagen))/i,
    minimax: /(^(abab|minimax))/i,
    moonshot: /(^(moonshot|kimi))/i,
    deepseek: /(^deepseek)/i,
    zhipu: /(^(glm|chatglm))/i,
    qwen: /(^(qwen|tongyi))/i,
    doubao: /(^(doubao|ep-))/i,
    baichuan: /(^baichuan)/i,
    yi: /(^yi-)/i,
    xai: /(^grok)/i,
    grok: /(^grok)/i,
    mistral: /(^(mistral|mixtral|codestral))/i,
    cohere: /(^command)/i,
    perplexity: /(^(pplx|sonar))/i,
    groq: /(^(llama|gemma|mixtral))/i,
  }
  const rule = rules[p]
  if (!rule) return models  // unknown platform → don't filter
  const filtered = models.filter(m => rule.test(m))
  return filtered.length > 0 ? filtered : models  // empty match → fall back to full list
}

/**
 * Fetch the model list for a given API key.
 * The /v1/models endpoint at supercode is per-key — it returns exactly what
 * that key's upstream supports. We trust the server response and do NOT
 * filter by platform tag, because supercode's group "platform" label may not
 * match the actual upstream (e.g. an "Anthropic"-labeled group can be routed
 * to a MiniMax upstream by the server admin).
 */
export async function apiFetchModels(apiKey: string, platform?: string): Promise<string[]> {
  const res = await fetch(`${MODELS_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn(`[supercode-api] fetchModels failed: ${res.status} ${body.slice(0, 200)}`)
    throw new Error(`获取模型列表失败 (${res.status})`)
  }
  const raw = await res.json()
  // Try OpenAI-style { data: [...] }, then bare array, then other wrappers
  let list: unknown[] = []
  if (Array.isArray(raw)) list = raw
  else if (raw && typeof raw === 'object') {
    for (const key of ['data', 'items', 'models', 'list', 'results']) {
      const v = (raw as Record<string, unknown>)[key]
      if (Array.isArray(v)) { list = v; break }
    }
  }
  const ids = list.map(item => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>
      const id = obj.id ?? obj.model ?? obj.name
      return typeof id === 'string' ? id : ''
    }
    return ''
  }).filter(Boolean)
  console.log(`[supercode-api] fetchModels (label=${platform ?? '?'}, key.first8=${apiKey.slice(0,8)}): ${ids.length} models →`, JSON.stringify(ids))
  return ids
}


// --- ipcMain registration (called from ipc/index.ts) -------------------

export function registerSupercodeIpc(): void {
  // AUTH_LOGIN, AUTH_LOGOUT, AUTH_GET_STATE, SUPERCODE_INIT_ACCOUNT
  // are registered in ipc/auth.ts — this file only exports API functions
}
