import { useEffect, useLayoutEffect, useState } from 'react'
import { useUIStore } from './stores/ui'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatPage } from './pages/Chat'
import { WorkflowPage } from './pages/Workflow'
import { GalleryPage } from './pages/Gallery'
import { KnowledgePage } from './pages/Knowledge'
import { SettingsPage } from './pages/Settings'
import { ShortcutsHelp } from './components/ui/ShortcutsHelp'

type PageId = 'chat' | 'workflow' | 'gallery' | 'knowledge' | 'settings'

export default function App() {
  const { currentPage, setPage, theme, setPendingWorkflowId } = useUIStore()
  const [shortcutsOpen, setShortcutsOpen] = useState(false)

  // Apply dark class before first paint to avoid flash
  useLayoutEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') root.classList.add('dark')
    else root.classList.remove('dark')
  }, [theme])

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

      // Mod + 1-4 : nav to main pages
      const pageMap: Record<string, PageId> = { '1': 'chat', '2': 'workflow', '3': 'gallery', '4': 'knowledge' }
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
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setPage])

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-hidden">
          {currentPage === 'chat' && <ChatPage />}
          {currentPage === 'workflow' && <WorkflowPage />}
          {currentPage === 'gallery' && <GalleryPage />}
          {currentPage === 'knowledge' && <KnowledgePage />}
          {currentPage === 'settings' && <SettingsPage />}
        </main>
      </div>

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  )
}
