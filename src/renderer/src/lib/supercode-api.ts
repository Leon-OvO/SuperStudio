/**
 * Renderer-side SuperCode API helpers — thin IPC wrappers.
 * No direct HTTP here; all calls go through main process.
 */

import type { AuthState } from '../../../shared/ipc-types'

export async function login(email: string, password: string): Promise<void> {
  await window.api.login(email, password)
}

export async function logout(): Promise<void> {
  await window.api.logout()
}

export async function getAuthState(): Promise<AuthState> {
  return window.api.getAuthState() as Promise<AuthState>
}

export async function initAccount(): Promise<AuthState> {
  return window.api.initAccount() as Promise<AuthState>
}
