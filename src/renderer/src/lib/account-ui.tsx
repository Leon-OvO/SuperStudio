import type { ComponentType } from 'react'

// Renderer UI seam for account-only screens. Core declares the slots and renders
// whatever is registered; the deliverable (BYOK) registers nothing (login is
// skipped, the account tab falls back to the local ProviderManager, the
// dashboard is hidden). The proprietary overlay registers the real components
// via register-account-ui (which core ships as a no-op stub and the overlay
// overwrites at build).

export interface AccountUI {
  /** Full-screen login gate. Undefined → no login (BYOK). */
  LoginComponent?: ComponentType
  /** Settings "account" tab. Undefined → Settings uses the local ProviderManager. */
  AccountTabComponent?: ComponentType<any>
  /** Dashboard / usage page. Undefined → dashboard hidden (BYOK). */
  DashboardComponent?: ComponentType
}

let registry: AccountUI = {}

export function setAccountUI(ui: AccountUI): void {
  registry = { ...registry, ...ui }
}

export function getAccountUI(): AccountUI {
  return registry
}
