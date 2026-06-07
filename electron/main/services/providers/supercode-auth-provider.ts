// PROPRIETARY OVERLAY — moves OUT of the deliverable core at the repo split.
//
// Wraps the existing supercode account system behind the core AuthProvider /
// ProviderKeyRecovery seams. Core never imports this; it's injected for the
// SuperStudio flavor by register-proprietary.ts. Everything supercode-specific
// (supercode-api, auth-store, ipc/auth, ipc/dashboard, the brand→capability
// mapping, masked-key recovery) lives here.

import type { AuthProvider, AuthSnapshot } from '../auth-provider'
import type { ProviderKeyRecovery } from '../key-store'
import type { ProviderConfig } from '../../../../src/shared/ipc-types'
import { tryRestoreSession, authHandlers } from '../../ipc/auth'
import { dashboardHandlers } from '../../ipc/dashboard'
import { getProviders, saveProvider } from '../store'
import { getAllKeys, storeAllKeys } from '../../auth-store'
import { apiGetKeyPlaintext, apiListKeys, apiListSubscriptionKeys } from '../../supercode-api'

/** Detect masked / placeholder key values returned by list endpoints. */
function looksLikeRealKey(k: string | undefined | null): boolean {
  if (!k || typeof k !== 'string') return false
  if (k.length < 20) return false
  if (k.includes('*') || k.includes('...')) return false
  return true
}

export class SuperCodeAuthProvider implements AuthProvider {
  async restore(): Promise<AuthSnapshot> {
    const ok = await tryRestoreSession()
    // Brand→capability backfill: existing supercode providers predate the
    // `anthropicNative` flag, so stamp it once at boot. New providers get it at
    // creation (ipc/auth.ts). Idempotent — only writes when the flag is unset.
    for (const p of getProviders()) {
      if (p.source === 'supercode' && p.anthropicNative !== true) {
        saveProvider({ ...p, anthropicNative: true })
      }
    }
    return { isLoggedIn: ok }
  }

  registerIpcHandlers(): void {
    authHandlers()
    dashboardHandlers()
  }
}

/**
 * Recover the plaintext for a supercode provider whose persisted `apiKey` is
 * masked (left over from an earlier sync). Maps `supercode-{groupId}` → key id
 * via the cached allKeys (falling back to a live scan) and fetches the
 * plaintext via /api/v1/keys/{id}, updating the saved provider in place.
 */
export class SuperCodeKeyRecovery implements ProviderKeyRecovery {
  async recover(providerId: string): Promise<string | null> {
    const provider = getProviders().find((p) => p.id === providerId) as ProviderConfig | undefined
    if (!provider || provider.source !== 'supercode') return null
    const m = /^supercode-(\d+)$/.exec(provider.id)
    if (!m) return null
    const groupId = Number(m[1])

    // 1) Cached key id
    let keyId = getAllKeys().find((k) => k.groupId === groupId)?.id ?? 0
    // 2) Live scan across both pools if not cached
    if (!keyId) {
      try {
        const [fresh, freshSub] = await Promise.all([
          apiListKeys().catch(() => []),
          apiListSubscriptionKeys().catch(() => []),
        ])
        keyId = fresh.find((k) => k.group_id === groupId)?.id
          ?? freshSub.find((k) => (k.group?.id ?? k.group_id) === groupId)?.id
          ?? 0
      } catch { /* fall through */ }
    }
    if (!keyId) {
      console.warn(`[supercode] recover: no key id found for groupId=${groupId}`)
      return null
    }

    try {
      const plain = await apiGetKeyPlaintext(keyId)
      if (!looksLikeRealKey(plain)) return null
      saveProvider({ ...provider, apiKey: plain })
      const allKeys = getAllKeys()
      const idx = allKeys.findIndex((k) => k.id === keyId)
      if (idx >= 0) {
        allKeys[idx] = { ...allKeys[idx], key: plain }
        storeAllKeys(allKeys)
      }
      console.log(`[supercode] recovered plaintext for ${provider.id} via /keys/${keyId}`)
      return plain
    } catch (e) {
      console.warn(`[supercode] recover failed for ${provider.id}:`, (e as Error).message)
      return null
    }
  }
}
