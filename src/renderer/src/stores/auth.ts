import { create } from 'zustand'
import type { SuperCodeUser, AuthState, StoredKeyInfo } from '../../../shared/ipc-types'

interface AuthStore {
  isLoggedIn: boolean
  user: SuperCodeUser | null
  keyId: number | null
  keyValueMasked: string
  allKeys: StoredKeyInfo[]
  isInitializing: boolean
  initError: string | null

  setAuthState: (state: AuthState) => void
  setInitializing: (v: boolean) => void
  setInitError: (err: string | null) => void
  restoreSession: () => Promise<void>
}

export const useAuthStore = create<AuthStore>((set) => ({
  isLoggedIn: false,
  user: null,
  keyId: null,
  keyValueMasked: '',
  allKeys: [],
  isInitializing: true,
  initError: null,

  setAuthState: (state: AuthState) => set({
    isLoggedIn: state.isLoggedIn,
    user: state.user,
    keyId: state.keyId,
    keyValueMasked: state.keyValue,
    allKeys: state.allKeys ?? []
  }),

  setInitializing: (v) => set({ isInitializing: v }),
  setInitError: (err) => set({ initError: err }),

  restoreSession: async () => {
    set({ isInitializing: true, initError: null })
    try {
      const state = await window.api.getAuthState() as AuthState
      set({
        isLoggedIn: state.isLoggedIn,
        user: state.user,
        keyId: state.keyId,
        keyValueMasked: state.keyValue,
        allKeys: state.allKeys ?? [],
        isInitializing: false
      })
    } catch {
      set({ isLoggedIn: false, isInitializing: false })
    }
  }
}))

// Listen for AUTH_STATE_CHANGED events from main process
if (typeof window !== 'undefined' && window.api?.onAuthStateChanged) {
  window.api.onAuthStateChanged((state: unknown) => {
    useAuthStore.getState().setAuthState(state as AuthState)
  })
}
