import { create } from 'zustand'
import { BRAND } from '@shared/brand'

type Page = 'dashboard' | 'chat' | 'workflow' | 'gallery' | 'memory' | 'vibe' | 'skills' | 'scheduler' | 'video' | 'company' | 'settings'
type Theme = 'light' | 'dark'
/** Skin = whole-app color palette. Replaces the old binary light/dark toggle —
 *  each skin maps to a light-or-dark base so Monaco / xterm can still pick a
 *  compatible variant via the derived `theme` field.
 *  'dwork' is the Bootstrap-v5-styled light skin used by the DWork flavor. */
export type Skin = 'classic' | 'warm' | 'cold' | 'twilight' | 'terminal' | 'dwork'
export const SKIN_IS_DARK: Record<Skin, boolean> = {
  classic: false,
  warm: false,
  cold: true,
  twilight: true,
  terminal: true,
  dwork: false
}
type VibeActivity = 'requests' | 'files'

export interface PendingChatAttachment {
  name: string
  path: string
  mimeType: string
}

interface UIState {
  currentPage: Page
  setPage: (page: Page) => void
  /** Currently active skin — source of truth for color palette. */
  skin: Skin
  setSkin: (s: Skin) => void
  /** Derived from skin — 'dark' when skin is cold/twilight, 'light' otherwise.
   *  Kept so legacy consumers (Monaco editor, xterm) don't all need updating. */
  theme: Theme
  /** Quick-toggle between a light skin and a dark skin. Sidebar / MenuBar use
   *  this for the one-click "切换主题" button. Cycles classic ↔ twilight. */
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
  /** Width (px) of the Chat-page left session list. */
  chatSidebarWidth: number
  setChatSidebarWidth: (n: number) => void
  /** Whether the main left nav rail shows labels (expanded) or icons-only. */
  sidebarExpanded: boolean
  setSidebarExpanded: (v: boolean) => void
}

const SKIN_KEYS: Skin[] = ['classic', 'warm', 'cold', 'twilight', 'terminal', 'dwork']
// First-run default skin is brand-driven: DWork boots into the Bootstrap-styled
// skin, SuperStudio into classic. Falls back to classic if a brand names a skin
// that isn't registered.
const DEFAULT_SKIN: Skin = SKIN_KEYS.includes(BRAND.defaultSkin as Skin)
  ? (BRAND.defaultSkin as Skin)
  : 'classic'
const savedSkin: Skin = (() => {
  const raw = localStorage.getItem('ss-skin')
  if (raw && SKIN_KEYS.includes(raw as Skin)) return raw as Skin
  // Migrate from pre-skin builds: dark → twilight, anything else → brand default.
  const legacy = localStorage.getItem('ss-theme')
  return legacy === 'dark' ? 'twilight' : DEFAULT_SKIN
})()
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
const savedChatSidebarWidth = (() => {
  const raw = localStorage.getItem('ss-chat-sidebar-width')
  const n = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(n) ? Math.max(180, Math.min(440, n)) : 224
})()
// Default to expanded (labels shown) — only collapse when the user opted in.
const savedSidebarExpanded = localStorage.getItem('ss-sidebar-expanded') !== '0'

export const useUIStore = create<UIState>((set, get) => ({
  currentPage: 'chat',
  setPage: (page) => set({ currentPage: page }),
  skin: savedSkin,
  setSkin: (s) => {
    localStorage.setItem('ss-skin', s)
    set({ skin: s, theme: SKIN_IS_DARK[s] ? 'dark' : 'light' })
  },
  theme: SKIN_IS_DARK[savedSkin] ? 'dark' : 'light',
  toggleTheme: () => {
    // Light↔dark one-click toggle: cycle classic ↔ twilight. Users who want a
    // specific skin pick it from Settings → 全局 → 皮肤 instead.
    const current = get().skin
    const next: Skin = SKIN_IS_DARK[current] ? 'classic' : 'twilight'
    localStorage.setItem('ss-skin', next)
    set({ skin: next, theme: SKIN_IS_DARK[next] ? 'dark' : 'light' })
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
  },
  chatSidebarWidth: savedChatSidebarWidth,
  setChatSidebarWidth: (n) => {
    const clamped = Math.max(180, Math.min(440, Math.floor(n)))
    localStorage.setItem('ss-chat-sidebar-width', String(clamped))
    set({ chatSidebarWidth: clamped })
  },
  sidebarExpanded: savedSidebarExpanded,
  setSidebarExpanded: (v) => {
    localStorage.setItem('ss-sidebar-expanded', v ? '1' : '0')
    set({ sidebarExpanded: v })
  }
}))
