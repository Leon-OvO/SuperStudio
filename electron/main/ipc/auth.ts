/**
 * IPC handlers for SuperCode account auth and account setup.
 */

import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'
import type { AuthState, StoredKeyInfo, GroupKeyOptions, SubscriptionKeyView } from '../../../src/shared/ipc-types'
import {
  storeTokens, getAccessToken, getRefreshToken, storeUser, getUser,
  storeAllKeys, getAllKeys, getKeyValue, clearAuth, isLoggedIn,
  storeKeysMeta, getKeysMeta, getSelectedKeyIds, setSelectedKeyId,
  storeCredentials, getCredentials, clearCredentials
} from '../auth-store'
import type { RawKeyEntry, KeyMeta } from '../auth-store'
import {
  initApiClient, apiLogin, apiLogout, apiGetMe,
  apiListKeys, apiGetAvailableGroups, apiCreateKey, apiDeleteKey, apiFetchModels,
  apiGetSubscriptionStatus,
  apiListSubscriptionKeys, apiCreateSubscriptionKey, apiDeleteSubscriptionKey,
  apiGetKeyPlaintext
} from '../supercode-api'
import type { SuperCodeKey, AvailableGroup, SubscriptionKey } from '../supercode-api'
import { saveProvider, getProviders, getSettings, saveSettings, maskApiKey, deleteProvider } from '../services/store'

// Wire up the API client with auth-store accessors.
// tryReLogin enables silent re-auth using stored email+password when refresh fails.
async function tryReLogin(): Promise<boolean> {
  const creds = getCredentials()
  if (!creds) return false
  try {
    const tokens = await apiLogin(creds.email, creds.password)
    storeTokens(tokens.access_token, tokens.refresh_token)
    console.log('[auth] silent re-login succeeded')
    return true
  } catch (e) {
    console.warn('[auth] silent re-login failed:', (e as Error).message)
    return false
  }
}

initApiClient({
  getToken: getAccessToken,
  getRefreshToken,
  storeTokens,
  clearTokens: clearAuth,
  tryReLogin
})

function buildAuthState(): AuthState {
  const user = getUser()
  const allRaw = getAllKeys()
  const firstKey = allRaw[0]
  const allKeys: StoredKeyInfo[] = allRaw.map(k => ({
    id: k.id,
    groupId: k.groupId,
    platform: k.platform,
    groupName: k.groupName,
    keyMasked: maskApiKey(k.key)
  }))
  return {
    isLoggedIn: isLoggedIn(),
    user,
    keyId: firstKey?.id ?? null,
    keyValue: firstKey ? maskApiKey(firstKey.key) : '',
    allKeys
  }
}

function broadcastAuthState(state: AuthState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.AUTH_STATE_CHANGED, state)
  }
}

/** Delete all supercode-managed providers from the config store */
function deleteAllSupercodeProviders(): void {
  const providers = getProviders()
  for (const p of providers) {
    if (p.source === 'supercode') deleteProvider(p.id)
  }
}

/** Detect masked / placeholder key values returned by list endpoints.
 *  The /keys and /subscription/keys list calls mask the actual value
 *  (e.g. "sk-d8d66...3b43"); we have to hit /keys/{id} to recover plaintext. */
function looksLikeRealKey(k: string | undefined | null): boolean {
  if (!k || typeof k !== 'string') return false
  if (k.length < 20) return false
  if (k.includes('*') || k.includes('...')) return false
  return true
}

interface SetupResult {
  hasLegacyProviders: boolean
}

/** Run the full account setup sequence: getMe → keys per group → models → ProviderConfigs */
async function runAccountSetup(onStep?: (step: number) => void): Promise<SetupResult> {
  // Detect legacy (non-supercode) providers before setup begins
  const existingProviders = getProviders()
  const hasLegacyProviders = existingProviders.some(p => p.source !== 'supercode')

  // Step 1: verify identity
  onStep?.(1)
  const user = await apiGetMe()
  storeUser(user)

  // Step 2: ensure one API key exists per available platform
  //
  // We fetch from three endpoints in parallel:
  //   - /api/v1/keys                 — standalone (pay-as-you-go) keys
  //   - /api/v1/keys/meta/available-platforms — groups available for standalone keys
  //   - /api/v1/subscription/keys    — keys tied to an active subscription plan
  //                                    (lite/pro/max). Each response carries its
  //                                    own embedded `group` object, so we can
  //                                    derive subscription-only groups from it
  //                                    without a separate platforms call.
  //
  // For lite-plan users, /available-platforms typically returns empty even though
  // the user has a valid subscription. We have to look at /subscription/keys to
  // discover what platforms they actually have access to.
  onStep?.(2)
  const [existingKeys, groups, subscriptionKeys] = await Promise.all([
    apiListKeys(),
    apiGetAvailableGroups(),
    apiListSubscriptionKeys().catch(e => {
      console.warn('[auth] apiListSubscriptionKeys failed (continuing without subscription keys):', (e as Error).message)
      return []
    })
  ])
  console.log('[auth] groups (from /available-platforms):',
    JSON.stringify(groups.map(g => ({ id: g.id, name: g.name, platform: g.platform, status: g.status }))))
  console.log('[auth] existing-keys (from /api/v1/keys):',
    JSON.stringify(existingKeys.slice(0, 10).map(k => ({ id: k.id, name: k.name, group_id: k.group_id, status: k.status }))))
  console.log('[auth] subscription-keys (from /api/v1/subscription/keys):',
    JSON.stringify(subscriptionKeys.slice(0, 10).map(k => ({
      id: k.id, name: k.name, group_id: k.group_id, status: k.status,
      groupPlatform: k.group?.platform, groupName: k.group?.name, groupType: k.group?.subscription_type
    }))))

  // Track which group ids came from subscription keys — those need the
  // /api/v1/subscription/keys POST endpoint when we create, not /api/v1/keys.
  const subscriptionGroupIds = new Set<number>()
  for (const sk of subscriptionKeys) {
    if (sk.group?.id) subscriptionGroupIds.add(sk.group.id)
    else if (sk.group_id) subscriptionGroupIds.add(sk.group_id)
  }

  // Merge groups: regular + ones derived from subscription keys (dedup by id).
  const knownGroupIds = new Set(groups.map(g => g.id))
  const mergedGroups: AvailableGroup[] = [...groups]
  for (const sk of subscriptionKeys) {
    if (!sk.group || !sk.group.id || knownGroupIds.has(sk.group.id)) continue
    mergedGroups.push({
      id: sk.group.id,
      name: sk.group.name,
      platform: sk.group.platform,
      status: sk.group.status
    })
    knownGroupIds.add(sk.group.id)
  }

  // Merge keys: regular + subscription (dedup by id).
  const knownKeyIds = new Set(existingKeys.map(k => k.id))
  const mergedExistingKeys: SuperCodeKey[] = [...existingKeys]
  for (const sk of subscriptionKeys) {
    if (knownKeyIds.has(sk.id)) continue
    mergedExistingKeys.push({
      id: sk.id,
      key: sk.key,
      name: sk.name,
      group_id: sk.group_id || sk.group?.id || 0,
      status: sk.status,
      quota: 0,
      quota_used: 0
    })
    knownKeyIds.add(sk.id)
  }

  // Be lenient about "active" status — different API versions report it as
  // "active" / "enabled" / "ok" / 1 / true. Only filter out things we know
  // are explicitly bad.
  const DISABLED = new Set(['disabled', 'banned', 'inactive', 'deleted', 'suspended', '0', 'false'])
  const activeGroups = mergedGroups.filter(g => {
    const s = String(g.status ?? '').toLowerCase()
    return !DISABLED.has(s)
  })
  console.log(`[auth] active groups (merged): ${activeGroups.length}/${mergedGroups.length}`,
    JSON.stringify(activeGroups.map(g => `${g.platform}:${g.name}#${g.id}${subscriptionGroupIds.has(g.id) ? '(sub)' : ''}`)))
  if (activeGroups.length === 0) {
    throw new Error('没有可用的 API Key 分组 — 当前账号未开通任何模型平台，请到 supercode.help 升级套餐或联系管理员')
  }

  // Alias so the rest of the function uses the merged list.
  const allExistingKeys = mergedExistingKeys

  // Derive the per-platform list directly from active groups
  const platformList = Array.from(new Set(activeGroups.map(g => g.platform)))
  console.log('[auth] will set up platforms:', JSON.stringify(platformList))

  // Helper: choose the correct creation endpoint based on whether the target
  // group is subscription-bound (discovered via /subscription/keys) or
  // standalone (discovered via /available-platforms).
  async function createKeyForGroup(groupName: string, groupId: number): Promise<{ id: number; key: string }> {
    const isSubscription = subscriptionGroupIds.has(groupId)
    console.log(`[auth] creating key via ${isSubscription ? '/subscription/keys' : '/keys'} for group#${groupId} (${groupName})`)
    if (isSubscription) {
      const sk = await apiCreateSubscriptionKey(`SuperStudio-${groupName}`, groupId)
      return { id: sk.id, key: sk.key }
    }
    const r = await apiCreateKey(`SuperStudio-${groupName}`, groupId)
    return { id: r.id, key: r.key }
  }

  // Store full key metadata (no key values) for display in AccountTab
  const keysMeta: KeyMeta[] = allExistingKeys.map(k => ({
    id: k.id,
    name: k.name,
    groupId: k.group_id,
    platform: activeGroups.find(g => g.id === k.group_id)?.platform ?? 'unknown',
    groupName: activeGroups.find(g => g.id === k.group_id)?.name ?? k.name,
    keyMasked: maskApiKey(k.key),
    status: k.status
  }))
  storeKeysMeta(keysMeta)

  // Respect per-group key selection made in settings
  const selectedKeyIds = getSelectedKeyIds()
  // Cache previously stored keys — `apiListKeys()` may return key values masked,
  // so we need to look up the real key from our local cache by id
  const previouslyStored = new Map(getAllKeys().map(k => [k.id, k.key]))

  // For each available platform, ensure exactly one active key exists
  const collectedKeys: RawKeyEntry[] = []
  for (const platform of platformList) {
    const platformGroups = activeGroups.filter(g => g.platform === platform)
    if (platformGroups.length === 0) {
      console.warn(`[auth] platform "${platform}" has no active groups, skipping`)
      continue
    }

    // Find any existing key for this platform across its groups.
    // Fallback to name-prefix matching when group_id from the API is missing /
    // mismatched — prevents creating a duplicate of our own auto-created key.
    const keysForPlatform = allExistingKeys.filter(k => {
      if (platformGroups.some(g => g.id === k.group_id)) return true
      if (typeof k.name === 'string' && k.name.startsWith('SuperStudio-')) {
        const suffix = k.name.slice('SuperStudio-'.length)
        // Match if the key's name suffix starts with any of this platform's group names
        if (platformGroups.some(g => suffix === g.name || suffix.startsWith(g.name + '-'))) return true
      }
      return false
    })
    if (keysForPlatform.length > 0) {
      console.log(`[auth] platform "${platform}" → reusing existing keys:`,
        JSON.stringify(keysForPlatform.map(k => ({ id: k.id, name: k.name, group_id: k.group_id }))))
    } else {
      console.log(`[auth] platform "${platform}" → no existing key, will create`)
    }

    if (keysForPlatform.length > 0) {
      // Pick priority:
      //   1. User-explicitly-selected key (if still present)
      //   2. A key whose plaintext value we can recover (locally cached OR API
      //      returned in cleartext) — this prevents recreating duplicates every
      //      time we re-run setup, since we'll always pick the one we know works
      //   3. Fall back to the first key (will trigger recreate path below)
      const allSelectedIds = Object.values(selectedKeyIds)
      const preferred =
        keysForPlatform.find(k => allSelectedIds.includes(k.id) && previouslyStored.has(k.id)) ??
        keysForPlatform.find(k => previouslyStored.has(k.id)) ??
        keysForPlatform.find(k => looksLikeRealKey(k.key)) ??
        keysForPlatform[0]
      // If the matched group_id doesn't exist (e.g., key created in another
      // tenant's group), fall back to the first active group for this platform
      const group = platformGroups.find(g => g.id === preferred.group_id) ?? platformGroups[0]
      console.log(`[auth] platform "${platform}" → picked key id=${preferred.id} (cached=${previouslyStored.has(preferred.id)}, apiRealKey=${looksLikeRealKey(preferred.key)})`)

      // Determine the real key value: API may have returned a masked or empty
      // value, in which case fall back to (1) local cache, (2) the /keys/{id}
      // GET endpoint which returns plaintext, and only then (3) recreate.
      // Recreate is a last resort because subscription plans cap key count at 1
      // and recreation churns the user's saved key everywhere.
      let keyValue = preferred.key
      if (!looksLikeRealKey(keyValue)) {
        const cached = previouslyStored.get(preferred.id)
        if (looksLikeRealKey(cached)) {
          console.log(`[auth] using cached key value for id=${preferred.id} (API returned masked/empty)`)
          keyValue = cached!
        } else {
          // Try fetching plaintext from /api/v1/keys/{id} — works for both
          // standalone and subscription keys (shared id space).
          try {
            const plain = await apiGetKeyPlaintext(preferred.id)
            if (looksLikeRealKey(plain)) {
              console.log(`[auth] recovered plaintext for key id=${preferred.id} via /keys/{id}`)
              keyValue = plain
            }
          } catch (e) {
            console.warn(`[auth] apiGetKeyPlaintext failed for id=${preferred.id}:`, (e as Error).message)
          }
        }
        if (!looksLikeRealKey(keyValue)) {
          // Still no valid key — recreate as last resort
          console.warn(`[auth] key id=${preferred.id} has no recoverable value, recreating via createKeyForGroup`)
          try {
            const created = await createKeyForGroup(group.name, group.id)
            keyValue = created.key
            // Update meta to reflect the new key
            keysMeta.push({
              id: created.id, name: `SuperStudio-${group.name}`, groupId: group.id,
              platform: group.platform, groupName: group.name,
              keyMasked: maskApiKey(created.key), status: 'active'
            })
            storeKeysMeta(keysMeta)
            collectedKeys.push({
              id: created.id, key: created.key, groupId: group.id,
              platform: group.platform, groupName: group.name
            })
            continue
          } catch (e) {
            console.warn(`[auth] recreation failed for platform "${platform}":`, (e as Error).message)
            continue
          }
        }
      }
      collectedKeys.push({
        id: preferred.id,
        key: keyValue,
        groupId: group.id,
        platform: group.platform,
        groupName: group.name
      })
    } else {
      // No key exists for this platform — auto-create one using the first group
      const targetGroup = platformGroups[0]
      try {
        const created = await createKeyForGroup(targetGroup.name, targetGroup.id)
        collectedKeys.push({
          id: created.id,
          key: created.key,
          groupId: targetGroup.id,
          platform: targetGroup.platform,
          groupName: targetGroup.name
        })
        keysMeta.push({
          id: created.id,
          name: `SuperStudio-${targetGroup.name}`,
          groupId: targetGroup.id,
          platform: targetGroup.platform,
          groupName: targetGroup.name,
          keyMasked: maskApiKey(created.key),
          status: 'active'
        })
        storeKeysMeta(keysMeta)
      } catch (e) {
        console.warn(`[auth] failed to create key for platform "${platform}":`, (e as Error).message)
      }
    }
  }

  if (collectedKeys.length === 0) throw new Error('无法获取或创建 API Key，请稍后重试')
  storeAllKeys(collectedKeys)

  // Step 3: fetch models per key and upsert ProviderConfig per group
  onStep?.(3)
  // Remove stale supercode providers before re-creating
  deleteAllSupercodeProviders()

  for (const keyEntry of collectedKeys) {
    let models: string[] = []
    try {
      models = await apiFetchModels(keyEntry.key, keyEntry.platform)
    } catch (e) {
      console.warn(`[auth] fetchModels failed for group ${keyEntry.groupId}:`, (e as Error).message)
    }
    saveProvider({
      id: `supercode-${keyEntry.groupId}`,
      name: keyEntry.groupName,
      type: 'custom',
      apiKey: keyEntry.key,
      baseUrl: 'https://api.supercode.help/v1',
      models,
      source: 'supercode',
      platform: keyEntry.platform
    })
  }

  // Step 4: auto-fix defaultChatProviderId if it points to a missing provider (task 13.3)
  onStep?.(4)
  const settings = getSettings()
  const allProviders = getProviders()
  if (!settings.defaultChatProviderId || !allProviders.find(p => p.id === settings.defaultChatProviderId)) {
    // Pick the provider whose models include a GPT-4o or Claude model
    const preferred = allProviders.find(p =>
      p.source === 'supercode' && p.models.some(m => /gpt-4o(?!-mini)/i.test(m) || /claude/i.test(m))
    ) ?? allProviders.find(p => p.source === 'supercode')
    if (preferred) {
      const chatModel = preferred.models.find(m => /gpt-4o(?!-mini)/i.test(m) || /claude-3-5-sonnet/i.test(m)) ?? preferred.models[0] ?? ''
      saveSettings({
        defaultChatProviderId: preferred.id,
        defaultChatModel: chatModel
      })
    }
  }

  return { hasLegacyProviders }
}

export async function tryRestoreSession(): Promise<boolean> {
  // 1) Try with the saved access token first (cheap)
  if (isLoggedIn()) {
    try {
      const user = await apiGetMe()
      storeUser(user)
      return true
    } catch { /* fall through to refresh */ }

    // 2) Try refresh token flow
    const refreshToken = getRefreshToken()
    if (refreshToken) {
      try {
        const res = await fetch('https://www.supercode.help/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken })
        })
        if (res.ok) {
          const data = await res.json() as { access_token: string; refresh_token: string }
          storeTokens(data.access_token, data.refresh_token)
          const user = await apiGetMe()
          storeUser(user)
          return true
        }
      } catch { /* fall through to silent re-login */ }
    }
  }

  // 3) Last resort: silent re-login with stored credentials (auto-recover from token expiry)
  const ok = await tryReLogin()
  if (ok) {
    try {
      const user = await apiGetMe()
      storeUser(user)
      return true
    } catch { /* fall through to clearAuth */ }
  }

  clearAuth()
  return false
}

export function authHandlers(): void {
  // AUTH_GET_STATE
  ipcMain.handle(IPC.AUTH_GET_STATE, (): AuthState => buildAuthState())

  // AUTH_LOGIN
  ipcMain.handle(IPC.AUTH_LOGIN, async (_e, email: string, password: string, remember = true) => {
    const tokens = await apiLogin(email, password)
    storeTokens(tokens.access_token, tokens.refresh_token)
    // Save credentials only if user opted in; otherwise wipe any old saved creds.
    // Without saved creds, silent token-refresh-via-relogin won't work — user
    // will be prompted to log in again when the refresh_token also expires.
    if (remember) storeCredentials(email, password)
    else clearCredentials()
    return { ok: true }
  })

  // AUTH_LOGOUT — explicit user logout. Clears tokens, user, keys, and the
  // supercode providers, but KEEPS the saved email/password so the login form
  // can pre-fill on next launch (matches the user-facing 保持登录 semantics).
  ipcMain.handle(IPC.AUTH_LOGOUT, async () => {
    await apiLogout()
    clearAuth()
    deleteAllSupercodeProviders()
    const state: AuthState = { isLoggedIn: false, user: null, keyId: null, keyValue: '', allKeys: [] }
    broadcastAuthState(state)
    return { ok: true }
  })

  // AUTH_GET_SAVED_CREDS — returns the stored email/password (decrypted) so the
  // login form can pre-fill after an explicit logout. Returns null when nothing
  // was ever saved (user never checked 保持登录). The password is sent over the
  // IPC bridge only to the same renderer that just authenticated previously.
  ipcMain.handle(IPC.AUTH_GET_SAVED_CREDS, () => {
    return getCredentials()
  })

  // SUPERCODE_INIT_ACCOUNT — called by LoginScreen during post-login setup
  // and by AccountTab on manual reset. Returns the new auth state but does
  // NOT broadcast it: doing so would flip `isLoggedIn` to true in the auth
  // store while LoginScreen is still showing its setup-step UI, tearing the
  // screen down mid-flow and revealing the data-directory gate before the
  // user has actually finished logging in. The two callers (LoginScreen and
  // AccountTab) both call setAuthState(result) themselves once they're
  // ready to transition.
  ipcMain.handle(IPC.SUPERCODE_INIT_ACCOUNT, async () => {
    const { hasLegacyProviders } = await runAccountSetup()
    const state = buildAuthState()
    return { ...state, hasLegacyProviders }
  })

  // ACCOUNT_LIST_KEY_OPTIONS — grouped per platform for the key switcher UI.
  // Always re-fetches from the server so the list reflects deletions/additions
  // made elsewhere (e.g. on the supercode.help web UI) — never serves stale meta.
  //
  // Merges keys from BOTH /api/v1/keys (standalone) and /api/v1/subscription/keys
  // (plan-bound). Subscription keys carry their own embedded `group` object, so
  // they show up in the UI even when /available-platforms returns nothing — this
  // is the common case for lite-plan users.
  ipcMain.handle(IPC.ACCOUNT_LIST_KEY_OPTIONS, async (): Promise<GroupKeyOptions[]> => {
    const [freshKeys, freshGroups, freshSubKeys] = await Promise.all([
      apiListKeys(),
      apiGetAvailableGroups(),
      apiListSubscriptionKeys().catch(e => {
        console.warn('[auth] ACCOUNT_LIST_KEY_OPTIONS: subscription keys fetch failed:', (e as Error).message)
        return []
      })
    ])
    const groupById = new Map(freshGroups.map(g => [g.id, g]))

    // Subscription keys live in the 当前套餐 section, NOT in this API Keys list.
    // Filter them out by id so we don't show duplicate entries.
    const subscriptionKeyIds = new Set(freshSubKeys.map(k => k.id))
    const standaloneKeys = freshKeys.filter(k => !subscriptionKeyIds.has(k.id))

    // Rebuild keysMeta from standalone data only
    const refreshedMeta: KeyMeta[] = standaloneKeys.map(k => {
      const grp = groupById.get(k.group_id)
      return {
        id: k.id,
        name: k.name,
        groupId: k.group_id,
        platform: grp?.platform ?? 'unknown',
        groupName: grp?.name ?? k.name,
        keyMasked: maskApiKey(k.key),
        status: k.status
      }
    })
    storeKeysMeta(refreshedMeta)

    const selectedIds = getSelectedKeyIds()
    // Group by groupId
    const byGroup = new Map<number, KeyMeta[]>()
    for (const m of refreshedMeta) {
      if (!byGroup.has(m.groupId)) byGroup.set(m.groupId, [])
      byGroup.get(m.groupId)!.push(m)
    }

    const result: GroupKeyOptions[] = []
    for (const [groupId, keys] of byGroup) {
      const first = keys[0]
      const selectedKeyId = selectedIds[groupId]
        ? (keys.some(k => k.id === selectedIds[groupId]) ? selectedIds[groupId] : null)
        : null
      result.push({
        groupId,
        groupName: first.groupName,
        platform: first.platform,
        keys: keys.map(k => ({ id: k.id, name: k.name, keyMasked: k.keyMasked, status: k.status })),
        selectedKeyId
      })
    }
    return result
  })

  // ACCOUNT_SELECT_KEY — switch the active key for a platform and refresh its provider.
  // Looks up the key in BOTH the standalone and subscription pools — same id
  // space, different routes.
  ipcMain.handle(IPC.ACCOUNT_SELECT_KEY, async (_e, { groupId, keyId }: { groupId: number; keyId: number }) => {
    const [freshKeys, freshSubKeys] = await Promise.all([
      apiListKeys(),
      apiListSubscriptionKeys().catch(() => [])
    ])
    const regular = freshKeys.find(k => k.id === keyId && k.group_id === groupId)
    let targetKeyValue: string | undefined
    let targetId = keyId
    if (regular) {
      targetKeyValue = regular.key
    } else {
      const sub = freshSubKeys.find(k => k.id === keyId && (k.group_id === groupId || k.group?.id === groupId))
      if (sub) {
        targetKeyValue = sub.key
        targetId = sub.id
      }
    }
    if (!targetKeyValue) throw new Error('找不到指定的 Key')

    // Persist user's selection
    setSelectedKeyId(groupId, targetId)

    // Update the active key in allKeysJson
    const currentKeys = getAllKeys()
    const updated = currentKeys.map(k =>
      k.groupId === groupId
        ? { ...k, id: targetId, key: targetKeyValue! }
        : k
    )
    storeAllKeys(updated)

    // Re-fetch models and update ProviderConfig for this group
    const entry = updated.find(k => k.groupId === groupId)!
    let models: string[] = []
    try { models = await apiFetchModels(entry.key, entry.platform) } catch { /* keep empty */ }
    saveProvider({
      id: `supercode-${groupId}`,
      name: entry.groupName,
      type: 'custom',
      apiKey: entry.key,
      baseUrl: 'https://api.supercode.help/v1',
      models,
      source: 'supercode',
      platform: entry.platform
    })

    const state = buildAuthState()
    broadcastAuthState(state)
    return state
  })

  // ACCOUNT_DELETE_KEY — delete a key on the server + clean up local state.
  // Try the standalone endpoint first; if the key isn't there (404), fall back
  // to the subscription endpoint. The two key sets share an id space but live
  // behind different routes, and we don't track origin per-key locally.
  ipcMain.handle(IPC.ACCOUNT_DELETE_KEY, async (_e, { keyId }: { keyId: number }) => {
    let deleted = false
    try {
      await apiDeleteKey(keyId)
      deleted = true
    } catch (e) {
      console.warn(`[auth] apiDeleteKey failed for id=${keyId}, trying subscription endpoint:`, (e as Error).message)
    }
    if (!deleted) {
      try {
        await apiDeleteSubscriptionKey(keyId)
      } catch (e) {
        throw new Error(`删除 Key 失败：${(e as Error).message}`)
      }
    }
    // Drop from keysMeta
    const meta = getKeysMeta().filter(k => k.id !== keyId)
    storeKeysMeta(meta)
    // If this was an active key, drop from allKeys too
    const remaining = getAllKeys().filter(k => k.id !== keyId)
    storeAllKeys(remaining)
    // If selectedKeyIds pointed at it, clear that mapping
    const sel = getSelectedKeyIds()
    for (const [groupId, kid] of Object.entries(sel)) {
      if (kid === keyId) setSelectedKeyId(Number(groupId), 0)
    }
    return { ok: true }
  })

  // ACCOUNT_LIST_GROUPS — return all active groups (for the create-key picker)
  ipcMain.handle(IPC.ACCOUNT_LIST_GROUPS, async () => {
    const groups = await apiGetAvailableGroups()
    return groups
      .filter(g => g.status === 'active')
      .map(g => ({ id: g.id, name: g.name, platform: g.platform, status: g.status }))
  })

  // ACCOUNT_REVEAL_KEY — return the plaintext key value for copy-to-clipboard.
  //
  // The /keys and /subscription/keys LIST endpoints mask values (e.g.
  // "sk-d8d66...3b43") — so we can't just return whatever those return. We
  // resolve in this order:
  //   1. Cached real value in allKeys (set during runAccountSetup / sync)
  //   2. GET /api/v1/keys/{id} — authoritative plaintext, works for both
  //      standalone and subscription keys (shared id space)
  //   3. List scan as last resort (only useful if a key snuck through without
  //      masking)
  ipcMain.handle(IPC.ACCOUNT_REVEAL_KEY, async (_e, { keyId }: { keyId: number }) => {
    // 1) Cache hit with a real (non-masked) value
    const cached = getAllKeys().find(k => k.id === keyId)?.key
    if (looksLikeRealKey(cached)) return { key: cached }

    // 2) Authoritative plaintext endpoint
    try {
      const plain = await apiGetKeyPlaintext(keyId)
      if (looksLikeRealKey(plain)) {
        // Warm the cache so subsequent reveals are instant
        const allKeys = getAllKeys()
        const idx = allKeys.findIndex(k => k.id === keyId)
        if (idx >= 0) {
          allKeys[idx] = { ...allKeys[idx], key: plain }
          storeAllKeys(allKeys)
        }
        return { key: plain }
      }
    } catch (e) {
      console.warn(`[auth] ACCOUNT_REVEAL_KEY: /keys/{id} failed for id=${keyId}:`, (e as Error).message)
    }

    // 3) Last-resort list scan
    const [fresh, freshSub] = await Promise.all([
      apiListKeys(),
      apiListSubscriptionKeys().catch(() => [])
    ])
    const target = fresh.find(k => k.id === keyId) ?? freshSub.find(k => k.id === keyId)
    if (!target) throw new Error('找不到指定的 Key')
    if (!looksLikeRealKey(target.key)) {
      throw new Error('服务器返回的 Key 已遮蔽，无法复制完整 Key — 请尝试「重置」重新生成')
    }
    return { key: target.key }
  })

  // ACCOUNT_CREATE_KEY — manually create a new key for a group. Routes to the
  // subscription endpoint when the target group is a subscription-bound group
  // (lite/pro/max plan), otherwise uses the standalone keys endpoint.
  ipcMain.handle(IPC.ACCOUNT_CREATE_KEY, async (_e, { groupId, name }: { groupId: number; name?: string }) => {
    const [groups, subKeys] = await Promise.all([
      apiGetAvailableGroups(),
      apiListSubscriptionKeys().catch(() => [])
    ])
    // Combine: if the group exists only in subscription keys' embedded data,
    // pick it up from there.
    let group = groups.find(g => g.id === groupId)
    let isSubscription = false
    if (!group) {
      const sk = subKeys.find(k => k.group?.id === groupId)
      if (sk?.group) {
        group = { id: sk.group.id, name: sk.group.name, platform: sk.group.platform, status: sk.group.status }
        isSubscription = true
      }
    } else if (subKeys.some(k => (k.group?.id ?? k.group_id) === groupId)) {
      isSubscription = true
    }
    if (!group) throw new Error('找不到指定的分组')
    const keyName = name?.trim() || `SuperStudio-${group.name}-${Date.now().toString(36)}`
    const created = isSubscription
      ? await apiCreateSubscriptionKey(keyName, groupId)
      : await apiCreateKey(keyName, groupId)

    // Update keysMeta to include the new key
    const meta = getKeysMeta()
    meta.push({
      id: created.id,
      name: keyName,
      groupId: group.id,
      platform: group.platform,
      groupName: group.name,
      keyMasked: maskApiKey(created.key),
      status: 'active'
    })
    storeKeysMeta(meta)

    return {
      id: created.id,
      groupId: group.id,
      platform: group.platform,
      groupName: group.name,
      name: keyName,
      keyMasked: maskApiKey(created.key)
    }
  })

  // ACCOUNT_GET_STATUS — current Token Plan status (single object, or null
  // when the user has no active plan). Errors bubble up so the UI can render
  // an inline retry rather than show empty silently.
  ipcMain.handle(IPC.ACCOUNT_GET_STATUS, async () => {
    return await apiGetSubscriptionStatus()
  })

  // ----- Subscription (Token Plan) key — single key per user, lives next to
  // the plan card rather than mixed with standalone API keys. The server caps
  // subscription keys at one per user, so the UI offers list / ensure / delete
  // / reset rather than freeform create.
  //
  // Shared helpers below:

  /** Read the user's current Token Plan key (first/only one) along with the
   *  group it's bound to. Returns nulls when nothing's set up yet. */
  async function readSubscriptionKeyView(): Promise<SubscriptionKeyView> {
    const subKeys = await apiListSubscriptionKeys()
    const first: SubscriptionKey | undefined = subKeys[0]
    if (!first) return { group: null, key: null }
    const group = first.group ? {
      id: first.group.id,
      name: first.group.name,
      platform: first.group.platform
    } : null
    return {
      group,
      key: {
        id: first.id,
        name: first.name,
        keyMasked: maskApiKey(first.key),
        status: first.status
      }
    }
  }

  /** Recover the plaintext value of a subscription key (list endpoint masks it).
   *  Falls back to local cache if the API also returns masked from /keys/{id}. */
  async function recoverSubscriptionKeyValue(keyId: number, listValue: string): Promise<string | null> {
    if (listValue && !listValue.includes('*') && !listValue.includes('...') && listValue.length >= 20) {
      return listValue
    }
    const cached = getAllKeys().find(k => k.id === keyId)?.key
    if (cached && !cached.includes('*') && !cached.includes('...') && cached.length >= 20) return cached
    try {
      const plain = await apiGetKeyPlaintext(keyId)
      if (plain && !plain.includes('*') && !plain.includes('...') && plain.length >= 20) return plain
    } catch (e) {
      console.warn(`[auth] recoverSubscriptionKeyValue(id=${keyId}) failed:`, (e as Error).message)
    }
    return null
  }

  /** Sync the local supercode provider for a subscription key — fetches its
   *  model list and upserts the ProviderConfig so it appears in Settings → 模型.
   *  Also updates the cached allKeys + keysMeta so other handlers stay coherent.
   *
   *  Guards against persisting a masked apiKey — if `plaintext` looks masked,
   *  tries /keys/{id} as a last-chance recovery before bailing. A masked key
   *  in the provider config would 401 against /v1/models and leave the picker
   *  empty with no obvious recovery path. */
  async function syncSubscriptionProvider(
    key: SubscriptionKey,
    plaintext: string
  ): Promise<void> {
    const group = key.group
    if (!group) {
      console.warn(`[auth] syncSubscriptionProvider: key id=${key.id} has no group, cannot create provider`)
      return
    }
    let realKey = plaintext
    if (!looksLikeRealKey(realKey)) {
      try {
        const recovered = await apiGetKeyPlaintext(key.id)
        if (looksLikeRealKey(recovered)) realKey = recovered
      } catch (e) {
        console.warn(`[auth] syncSubscriptionProvider: /keys/${key.id} recovery failed:`, (e as Error).message)
      }
    }
    if (!looksLikeRealKey(realKey)) {
      console.warn(`[auth] syncSubscriptionProvider: refusing to save masked key for id=${key.id}; provider not synced`)
      return
    }
    let models: string[] = []
    try { models = await apiFetchModels(realKey, group.platform) }
    catch (e) { console.warn(`[auth] syncSubscriptionProvider: fetchModels failed:`, (e as Error).message) }
    saveProvider({
      id: `supercode-${group.id}`,
      name: group.name,
      type: 'custom',
      apiKey: realKey,
      baseUrl: 'https://api.supercode.help/v1',
      models,
      source: 'supercode',
      platform: group.platform
    })

    // Update the cached allKeys so other handlers (REVEAL_KEY, etc.) can find it
    const allKeys = getAllKeys()
    const idx = allKeys.findIndex(k => k.groupId === group.id)
    const entry: RawKeyEntry = {
      id: key.id,
      key: realKey,
      groupId: group.id,
      platform: group.platform,
      groupName: group.name
    }
    if (idx >= 0) allKeys[idx] = entry
    else allKeys.push(entry)
    storeAllKeys(allKeys)

    // Mirror into keysMeta so other lookups stay consistent
    const meta = getKeysMeta()
    const metaIdx = meta.findIndex(m => m.id === key.id)
    const metaEntry: KeyMeta = {
      id: key.id,
      name: key.name,
      groupId: group.id,
      platform: group.platform,
      groupName: group.name,
      keyMasked: maskApiKey(realKey),
      status: key.status
    }
    if (metaIdx >= 0) meta[metaIdx] = metaEntry
    else meta.push(metaEntry)
    storeKeysMeta(meta)
  }

  // SUBSCRIPTION_KEY_LIST — read-only view for AccountTab's 当前套餐 section.
  ipcMain.handle(IPC.SUBSCRIPTION_KEY_LIST, async (): Promise<SubscriptionKeyView> => {
    return await readSubscriptionKeyView()
  })

  // SUBSCRIPTION_KEY_ENSURE — idempotent: ensure a Token Plan key exists for
  // the user's active subscription, and that its provider is synced so it
  // appears in Settings → 模型. If a key already exists, recover its plaintext
  // value (via /keys/{id}) and just refresh the provider — never create a
  // second key (the server caps at 1 per user). If nothing exists, derive the
  // group from /subscription/me + /available-platforms and create one.
  ipcMain.handle(IPC.SUBSCRIPTION_KEY_ENSURE, async (): Promise<SubscriptionKeyView> => {
    const existing = await apiListSubscriptionKeys()
    if (existing.length > 0) {
      const sk = existing[0]
      const plain = await recoverSubscriptionKeyValue(sk.id, sk.key)
      if (plain) await syncSubscriptionProvider(sk, plain)
      else console.warn(`[auth] SUBSCRIPTION_KEY_ENSURE: could not recover plaintext for id=${sk.id}; provider not synced`)
      return await readSubscriptionKeyView()
    }

    // No subscription key yet — figure out which group to bind to.
    // First check the plan status: must be active to create.
    const status = await apiGetSubscriptionStatus()
    if (!status || status.status !== 'active') {
      throw new Error('当前账号没有有效订阅，无法创建 Token Plan Key')
    }

    // Discover the right group. The user's subscription should expose a
    // group via /available-platforms whose platform matches the plan; if
    // /available-platforms returns nothing (common on lite), fall back to
    // any group the server will accept (group_id omitted → server picks).
    const groups = await apiGetAvailableGroups()
    let groupId = 0
    let groupName = `${status.planType}-plan`
    if (groups.length > 0) {
      // Pick first active group — for subscription users there's usually just one
      const g = groups.find(gg => String(gg.status).toLowerCase() !== 'disabled') ?? groups[0]
      groupId = g.id
      groupName = g.name
    }

    const created = await apiCreateSubscriptionKey(`SuperStudio-${groupName}`, groupId || undefined)
    // The create response should include the group object; if not, re-list to pick it up
    let key = created
    if (!key.group) {
      const refreshed = await apiListSubscriptionKeys()
      const match = refreshed.find(k => k.id === created.id)
      if (match) key = match
    }
    if (key.key && key.group) {
      await syncSubscriptionProvider(key, key.key)
    } else {
      console.warn('[auth] SUBSCRIPTION_KEY_ENSURE: created key missing group or value; provider not synced')
    }

    const view = await readSubscriptionKeyView()
    broadcastAuthState(buildAuthState())
    return view
  })

  // SUBSCRIPTION_KEY_DELETE — remove the user's single Token Plan key plus the
  // corresponding supercode provider so it no longer appears in Settings → 模型.
  ipcMain.handle(IPC.SUBSCRIPTION_KEY_DELETE, async (_e, { keyId }: { keyId: number }) => {
    // Look up the key's group BEFORE deletion so we know which provider to remove
    const existing = await apiListSubscriptionKeys()
    const target = existing.find(k => k.id === keyId)
    const groupId = target?.group?.id ?? target?.group_id ?? 0

    await apiDeleteSubscriptionKey(keyId)

    if (groupId > 0) {
      deleteProvider(`supercode-${groupId}`)
    }
    // Clean up cached entries
    const remainingAll = getAllKeys().filter(k => k.id !== keyId)
    storeAllKeys(remainingAll)
    const remainingMeta = getKeysMeta().filter(m => m.id !== keyId)
    storeKeysMeta(remainingMeta)
    const sel = getSelectedKeyIds()
    for (const [gid, kid] of Object.entries(sel)) {
      if (kid === keyId) setSelectedKeyId(Number(gid), 0)
    }
    broadcastAuthState(buildAuthState())
    return { ok: true }
  })

  // SUBSCRIPTION_KEY_RESET — destructive: delete the existing key and create a
  // fresh one. Use case: user lost the plaintext value and our /keys/{id}
  // recovery also returned masked, so the only way to get a usable key is to
  // recreate. Returns the new key's view.
  ipcMain.handle(IPC.SUBSCRIPTION_KEY_RESET, async (): Promise<SubscriptionKeyView> => {
    const existing = await apiListSubscriptionKeys()
    for (const k of existing) {
      const gid = k.group?.id ?? k.group_id ?? 0
      try { await apiDeleteSubscriptionKey(k.id) }
      catch (e) { console.warn(`[auth] SUBSCRIPTION_KEY_RESET: delete id=${k.id} failed:`, (e as Error).message) }
      if (gid > 0) deleteProvider(`supercode-${gid}`)
    }
    // Clear cached entries for any deleted ids
    const deletedIds = new Set(existing.map(k => k.id))
    storeAllKeys(getAllKeys().filter(k => !deletedIds.has(k.id)))
    storeKeysMeta(getKeysMeta().filter(m => !deletedIds.has(m.id)))

    // Now create a fresh one via the ensure flow
    const status = await apiGetSubscriptionStatus()
    if (!status || status.status !== 'active') {
      throw new Error('当前账号没有有效订阅，无法重置 Token Plan Key')
    }
    const groups = await apiGetAvailableGroups()
    let groupId = 0
    let groupName = `${status.planType}-plan`
    if (groups.length > 0) {
      const g = groups.find(gg => String(gg.status).toLowerCase() !== 'disabled') ?? groups[0]
      groupId = g.id
      groupName = g.name
    }
    const created = await apiCreateSubscriptionKey(`SuperStudio-${groupName}`, groupId || undefined)
    let key = created
    if (!key.group) {
      const refreshed = await apiListSubscriptionKeys()
      const match = refreshed.find(k => k.id === created.id)
      if (match) key = match
    }
    if (key.key && key.group) await syncSubscriptionProvider(key, key.key)

    const view = await readSubscriptionKeyView()
    broadcastAuthState(buildAuthState())
    return view
  })
}
