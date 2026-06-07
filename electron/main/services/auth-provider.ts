// Seam: AuthProvider (main-process side)
//
// Inverts core's dependency on the proprietary supercode account system. Core's
// boot (index.ts) calls getAuthProvider().restore(); IPC registration
// (ipc/index.ts) calls getAuthProvider().registerIpcHandlers() instead of
// statically importing ./ipc/auth + ./ipc/dashboard. The deliverable ships a
// BYOK provider: always "logged in", no remote account, AUTH_GET_STATE is a
// shell. The proprietary overlay injects a SuperCode provider (see
// services/providers/supercode-auth-provider.ts).
//
// The renderer-side login UI is handled separately; this seam only owns the
// main-process restore + which IPC handlers get registered.

import { ipcMain } from 'electron'
import { IPC } from '../../../src/shared/ipc-types'

export interface AuthUserLike {
  id?: string | number
  email?: string
  name?: string
}

export interface AuthSnapshot {
  isLoggedIn: boolean
  user?: AuthUserLike | null
}

export interface AuthProvider {
  /** Restore session at boot. BYOK resolves immediately as logged-in. */
  restore(): Promise<AuthSnapshot>
  /** Register this provider's IPC handlers. BYOK only needs AUTH_GET_STATE. */
  registerIpcHandlers(): void
  /** Optional hook invoked when the Settings page opens (e.g. subscription sync). */
  onSettingsOpen?(): Promise<void>
}

/** Deliverable default: bring-your-own-key. No login screen, no remote account;
 *  the app is always usable and providers are configured locally. */
const byokAuthProvider: AuthProvider = {
  async restore() {
    return { isLoggedIn: true, user: null }
  },
  registerIpcHandlers() {
    // The renderer's auth store calls AUTH_GET_STATE on boot; answer "always
    // logged in" with an empty account shape so BYOK skips the login gate.
    ipcMain.handle(IPC.AUTH_GET_STATE, () => ({
      isLoggedIn: true,
      user: null,
      keyId: null,
      keyValue: '',
      allKeys: [],
    }))
  },
}

let current: AuthProvider = byokAuthProvider

export function setAuthProvider(provider: AuthProvider): void {
  current = provider
}

export function getAuthProvider(): AuthProvider {
  return current
}
