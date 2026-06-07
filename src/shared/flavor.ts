// Build-time product flavor.
//
// The flavor is selected by the FLAVOR env var at build time and injected into
// every bundle (main / preload / renderer) as the global constant
// `__APP_FLAVOR__` via vite `define` (see electron.vite.config.ts).
//
// We read it through a `typeof` guard so contexts that DON'T inject the define
// — vitest (node env), bare `tsc`, ts-node — fall back to 'superstudio' instead
// of throwing. `typeof <undeclared-identifier>` returns the string 'undefined'
// rather than a ReferenceError, which is what makes the guard safe.

declare const __APP_FLAVOR__: string | undefined

export type Flavor = 'superstudio' | 'dwork'

/** How the app sources model credentials.
 *  - 'hosted': a hosted account injects providers (proprietary overlay).
 *  - 'byok':   user brings their own API URL/KEY (deliverable default). */
export type AccountMode = 'hosted' | 'byok'

function resolveFlavor(): Flavor {
  const injected = typeof __APP_FLAVOR__ !== 'undefined' ? __APP_FLAVOR__ : undefined
  return injected === 'dwork' ? 'dwork' : 'superstudio'
}

export const FLAVOR: Flavor = resolveFlavor()

export const ACCOUNT_MODE: AccountMode = FLAVOR === 'dwork' ? 'byok' : 'hosted'

export const IS_DWORK: boolean = FLAVOR === 'dwork'
