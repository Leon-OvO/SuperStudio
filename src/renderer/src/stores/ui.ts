import { create } from 'zustand'

type Page = 'chat' | 'workflow' | 'gallery' | 'knowledge' | 'settings'
type Theme = 'light' | 'dark'

export interface PendingChatAttachment {
  name: string
  path: string
  mimeType: string
}

interface UIState {
  currentPage: Page
  setPage: (page: Page) => void
  theme: Theme
  toggleTheme: () => void
  pendingWorkflowId: string | null
  setPendingWorkflowId: (id: string | null) => void
  pendingChatAttachments: PendingChatAttachment[] | null
  setPendingChatAttachments: (atts: PendingChatAttachment[] | null) => void
  pendingChatImageMode: boolean
  setPendingChatImageMode: (on: boolean) => void
}

const savedTheme = (localStorage.getItem('ss-theme') as Theme) || 'light'

export const useUIStore = create<UIState>((set, get) => ({
  currentPage: 'chat',
  setPage: (page) => set({ currentPage: page }),
  theme: savedTheme,
  toggleTheme: () => {
    const next: Theme = get().theme === 'light' ? 'dark' : 'light'
    localStorage.setItem('ss-theme', next)
    set({ theme: next })
  },
  pendingWorkflowId: null,
  setPendingWorkflowId: (id) => set({ pendingWorkflowId: id }),
  pendingChatAttachments: null,
  setPendingChatAttachments: (atts) => set({ pendingChatAttachments: atts }),
  pendingChatImageMode: false,
  setPendingChatImageMode: (on) => set({ pendingChatImageMode: on })
}))
