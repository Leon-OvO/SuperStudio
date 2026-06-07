// PROPRIETARY OVERLAY — at the repo split this file is the overlay's; the
// deliverable core ships a no-op stub at this path (so core's main.tsx static
// import always resolves and the bundle stays free of account screens).
//
// Registers the supercode account screens into the renderer UI seam. Static
// imports → synchronous registration at module load (main.tsx imports this
// before React renders), so App's login gate sees the component with no race.
// Guarded by FLAVOR so a dwork build (before the physical split) bundles but
// never activates them.

import { FLAVOR } from '@shared/flavor'
import { setAccountUI } from './account-ui'
import { LoginScreen } from '../pages/Login'
import { AccountTab } from '../pages/Settings/AccountTab'
import { DashboardPage } from '../pages/Dashboard'

if (FLAVOR === 'superstudio') {
  setAccountUI({
    LoginComponent: LoginScreen,
    AccountTabComponent: AccountTab,
    DashboardComponent: DashboardPage,
  })
}
