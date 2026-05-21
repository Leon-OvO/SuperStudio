import { create } from 'zustand'

type Page = 'dashboard' | 'chat' | 'workflow' | 'gallery' | 'knowledge' | 'vibe' | 'skills' | 'settings'
type Theme = 'light' | 'dark'
type VibeActivity = 'requests' | 'files'

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
  /** Height (px) of the Vibe-page terminal drawer. Persisted across reloads. */
  terminalHeight: number
  setTerminalHeight: (n: number) => void
  /** Which panel the Vibe page sidebar is currently showing — only one at a
   *  time (VS Code activity-bar pattern), not stacked. */
  vibeActivity: VibeActivity
  setVibeActivity: (a: VibeActivity) => void
  vibeSidebarOpen: boolean
  setVibeSidebarOpen: (v: boolean) => void
  /** Width (px) of the Vibe-page left sidebar (requests / files panel). */
  vibeSidebarWidth: number
  setVibeSidebarWidth: (n: number) => void
}

const savedTheme = (localStorage.getItem('ss-theme') as Theme) || 'light'
const savedTermHeight = (() => {
  const raw = localStorage.getItem('ss-terminal-height')
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? Math.max(120, Math.min(600, n)) : 240
})()
const savedVibeActivity = ((localStorage.getItem('ss-vibe-activity') as VibeActivity) || 'requests')
const savedVibeSidebarOpen = localStorage.getItem('ss-vibe-sidebar-open') !== '0'
const savedVibeSidebarWidth = (() => {
  const raw = localStorage.getItem('ss-vibe-sidebar-width')
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? Math.max(180, Math.min(560, n)) : 260
})()

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
  setPendingChatImageMode: (on) => set({ pendingChatImageMode: on }),
  terminalHeight: savedTermHeight,
  setTerminalHeight: (n) => {
    const clamped = Math.max(120, Math.min(600, Math.floor(n)))
    localStorage.setItem('ss-terminal-height', String(clamped))
    set({ terminalHeight: clamped })
  },
  vibeActivity: savedVibeActivity,
  setVibeActivity: (a) => {
    localStorage.setItem('ss-vibe-activity', a)
    set({ vibeActivity: a })
  },
  vibeSidebarOpen: savedVibeSidebarOpen,
  setVibeSidebarOpen: (v) => {
    localStorage.setItem('ss-vibe-sidebar-open', v ? '1' : '0')
    set({ vibeSidebarOpen: v })
  },
  vibeSidebarWidth: savedVibeSidebarWidth,
  setVibeSidebarWidth: (n) => {
    const clamped = Math.max(180, Math.min(560, Math.floor(n)))
    localStorage.setItem('ss-vibe-sidebar-width', String(clamped))
    set({ vibeSidebarWidth: clamped })
  }
}))
