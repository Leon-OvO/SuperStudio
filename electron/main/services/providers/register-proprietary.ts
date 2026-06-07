// PROPRIETARY OVERLAY — this file and everything it imports moves OUT of the
// deliverable core at the repo split. It registers the SuperStudio-only seam
// implementations. Core boots on the seam defaults (noop remote control, BYOK
// auth, empty talent), so removing this file leaves a working deliverable.
//
// Invoked from index.ts, guarded by `FLAVOR === 'superstudio'`, so a DWork build
// never activates these implementations even before the physical repo split.

import { setRemoteControlSource } from '../remote-control-source'
import { setAuthProvider } from '../auth-provider'
import { setProviderKeyRecovery } from '../key-store'
import { GitHubRemoteControlSource } from './github-remote-control'
import { SuperCodeAuthProvider, SuperCodeKeyRecovery } from './supercode-auth-provider'

export function registerProprietaryProviders(): void {
  // Seam 1 — RemoteControlSource: GitHub-hosted model.conf + release updates.
  setRemoteControlSource(new GitHubRemoteControlSource())

  // Seam 2 — AuthProvider + ProviderKeyRecovery: the supercode account system.
  // (TalentSource is loaded by core's default — the bundled catalog ships per
  //  entitlement, so no overlay injection is needed.)
  setAuthProvider(new SuperCodeAuthProvider())
  setProviderKeyRecovery(new SuperCodeKeyRecovery())
}
