// Seam: KeyStore + ProviderKeyRecovery
//
// Found by the adversarial partition review: ipc/settings.ts statically imports
// getAllKeys/storeAllKeys from the proprietary ../auth-store and recovers masked
// keys via ../supercode-api. Without a seam, core can't compile once the overlay
// is removed.
//
// KeyStore abstracts local API-key persistence (the deliverable backs it with
// the existing encrypted provider store, services/store.ts). ProviderKeyRecovery
// abstracts "un-masking" a previously-stored key — a supercode-only concern, so
// the deliverable default is a no-op (BYOK keys are user-entered, never masked).
//
// Wiring (later tasks): ipc/settings.ts uses getProviderKeyRecovery().recover()
// instead of recoverSupercodeProviderKey(); the overlay injects the supercode
// recovery chain.

export interface KeyStore {
  getKey(providerId: string): string | null
  setKey(providerId: string, value: string): void
}

export interface ProviderKeyRecovery {
  /** Resolve the plaintext key for a provider whose stored key is masked.
   *  Returns null when recovery isn't applicable (BYOK default). */
  recover(providerId: string): Promise<string | null>
}

/** Deliverable default: no masked-key recovery (BYOK keys are entered in full). */
const noopProviderKeyRecovery: ProviderKeyRecovery = {
  async recover() {
    return null
  },
}

let recovery: ProviderKeyRecovery = noopProviderKeyRecovery

export function setProviderKeyRecovery(impl: ProviderKeyRecovery): void {
  recovery = impl
}

export function getProviderKeyRecovery(): ProviderKeyRecovery {
  return recovery
}
