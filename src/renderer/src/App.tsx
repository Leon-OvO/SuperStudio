import { useEffect, useLayoutEffect, useState } from 'react'
import { useUIStore } from './stores/ui'
import { useAuthStore } from './stores/auth'
import { useVibeStore } from './pages/Vibe/store'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { DashboardPage } from './pages/Dashboard'
import { ChatPage } from './pages/Chat'
import { WorkflowPage } from './pages/Workflow'
import { GalleryPage } from './pages/Gallery'
import { KnowledgePage } from './pages/Knowledge'
import { VibePage } from './pages/Vibe'
import { SkillsPage } from './pages/Skills'
import { SettingsPage } from './pages/Settings'
import { ShortcutsHelp } from './components/ui/ShortcutsHelp'
import { CommandPalette } from './components/ui/CommandPalette'
import { ToastHost } from './components/ui/Toast'
import { LoginScreen } from './pages/Login'
import { DataDirectorySetup } from './components/DataDirectorySetup'
import { ChatModelSetup } from './components/ChatModelSetup'

type PageId = 'dashboard' | 'chat' | 'workflow' | 'gallery' | 'knowledge' | 'vibe' | 'skills' | 'settings'

export default function App() {
  const { currentPage, setPage, theme, setPendingWorkflowId } = useUIStore()
  const { isLoggedIn, isInitializing, restoreSession } = useAuthStore()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // null = still loading settings; true/false = whether the user has set
  // a custom data directory. We block the main UI until it's true so users
  // make a conscious storage choice on first run instead of silently writing
  // gigabytes of media into AppData.
  const [dataDirReady, setDataDirReady] = useState<boolean | null>(null)
  // Same pattern for the default chat model. Checked only after dataDirReady
  // is true, so the two gates render sequentially rather than fighting each
  // other. `true` means either the user has saved a default or they chose to
  // skip (in which case Chat/Vibe will surface the picker on demand).
  const [chatModelReady, setChatModelReady] = useState<boolean | null>(null)

  useEffect(() => {
    restoreSession()
  }, [])

  // Re-check the data-directory setting whenever the user transitions into a
  // logged-in state. Logged-out users see the login screen first; we only
  // gate the main UI behind the directory choice, not the login itself.
  useEffect(() => {
    if (!isLoggedIn) { setDataDirReady(null); setChatModelReady(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const s = await window.api.getSettings()
        if (!cancelled) {
          setDataDirReady(!!s.dataDirectory)
          setChatModelReady(!!(s.defaultChatProviderId && s.defaultChatModel))
        }
      } catch {
        // If settings can't be read at all, don't lock the user out — fall
        // through to the main UI so they can recover via Settings manually.
        if (!cancelled) { setDataDirReady(true); setChatModelReady(true) }
      }
    })()
    return () => { cancelled = true }
  }, [isLoggedIn])

  // Apply dark class before first paint to avoid flash
  useLayoutEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [theme])

  // Tag <html> with the OS so platform-specific font-smoothing rules apply
  useLayoutEffect(() => {
    const root = document.documentElement
    const platform = window.api?.platform
    root.classList.remove('platform-win', 'platform-mac', 'platform-linux')
    if (platform === 'win32') root.classList.add('platform-win')
    else if (platform === 'darwin') root.classList.add('platform-mac')
    else root.classList.add('platform-linux')
  }, [])

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { page: string; workflowId?: string }
      if (detail?.page) {
        if (detail.page === 'workflow' && detail.workflowId) {
          setPendingWorkflowId(detail.workflowId)
        }
        setPage(detail.page as Parameters<typeof setPage>[0])
      }
    }
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [setPage, setPendingWorkflowId])

  // --- Global keyboard shortcuts ---
  // Skipped when the user is in a text input / textarea / contenteditable, so
  // we don't intercept Ctrl+N inside a textarea (etc). Single-key shortcuts
  // would be hostile inside text inputs — only handle modifier combos here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const target = e.target as HTMLElement | null
      const inTextField = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )

      const key = e.key.toLowerCase()

      // Mod + / : show shortcuts help (works everywhere)
      if (key === '/' || (e.shiftKey && key === '?')) {
        e.preventDefault()
        setShortcutsOpen(o => !o)
        return
      }

      // Mod + , : open settings
      if (key === ',') {
        e.preventDefault()
        setPage('settings')
        return
      }

      // Mod + 0-4 : nav to main pages
      const pageMap: Record<string, PageId> = { '0': 'dashboard', '1': 'chat', '2': 'workflow', '3': 'gallery', '4': 'knowledge', '5': 'vibe', '6': 'skills' }
      if (pageMap[e.key]) {
        // Don't hijack number input inside text fields
        if (inTextField) return
        e.preventDefault()
        setPage(pageMap[e.key])
        return
      }

      // Mod + N : new chat (dispatch event ChatPage listens for)
      if (key === 'n') {
        if (inTextField) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'chat' } }))
        window.dispatchEvent(new CustomEvent('app:new-chat'))
        return
      }

      // Mod + K : toggle command palette (works inside text fields too)
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPage])

  // MenuBar (Vibe page) dispatches these so menu items can open globally-
  // owned modals without prop-drilling. Toggle is intentional — clicking the
  // menu item twice should close it again.
  useEffect(() => {
    const onPalette = () => setPaletteOpen(o => !o)
    const onShortcuts = () => setShortcutsOpen(o => !o)
    window.addEventListener('app:open-palette', onPalette)
    window.addEventListener('app:open-shortcuts', onShortcuts)
    return () => {
      window.removeEventListener('app:open-palette', onPalette)
      window.removeEventListener('app:open-shortcuts', onShortcuts)
    }
  }, [])

  // OS-level "用 SuperStudio 打开" — Explorer right-click forwards a path here.
  // We park the target on the Vibe store and switch the active page; VibePage
  // picks the target up on (re)mount. Storing in the store instead of firing
  // a DOM event removes the mount-timing race — the event used to fire 60ms
  // after setPage('vibe'), which sometimes beat VibePage's listener attach,
  // and the file silently failed to open.
  useEffect(() => {
    const off = window.api.onOpenPathFromShell?.((payload: unknown) => {
      const target = typeof payload === 'string'
        ? { path: payload, kind: 'dir' as const }
        : payload as { path: string; kind: 'file' | 'dir'; parent?: string }
      useVibeStore.getState().setPendingShellOpen(target)
      setPage('vibe')
    })
    return off
  }, [setPage])

  if (isInitializing) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          正在启动…
        </div>
      </div>
    )
  }

  if (!isLoggedIn) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <LoginScreen />
      </div>
    )
  }

  // Logged in but data directory check hasn't resolved yet — render the
  // chrome but not the main UI to avoid a flash of the wrong screen.
  if (dataDirReady === null) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
      </div>
    )
  }

  if (!dataDirReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <DataDirectorySetup onDone={() => setDataDirReady(true)} />
      </div>
    )
  }

  // Once the data directory is set, ensure the user has picked a default
  // chat model. We deliberately don't gate image/video/embedding here —
  // most users won't touch those tabs on day one.
  if (chatModelReady === null) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
      </div>
    )
  }

  if (!chatModelReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
        <TitleBar />
        <ChatModelSetup onDone={() => setChatModelReady(true)} />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {currentPage === 'dashboard' && <DashboardPage />}
          {currentPage === 'chat' && <ChatPage />}
          {currentPage === 'workflow' && <WorkflowPage />}
          {currentPage === 'gallery' && <GalleryPage />}
          {currentPage === 'knowledge' && <KnowledgePage />}
          {currentPage === 'vibe' && <VibePage />}
          {currentPage === 'skills' && <SkillsPage />}
          {currentPage === 'settings' && <SettingsPage />}
        </main>
      </div>

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ToastHost />
    </div>
  )
}
