import { useEffect, useLayoutEffect } from 'react'
import { useUIStore } from './stores/ui'
import { Sidebar } from './components/layout/Sidebar'
import { TitleBar } from './components/layout/TitleBar'
import { ChatPage } from './pages/Chat'
import { WorkflowPage } from './pages/Workflow'
import { GalleryPage } from './pages/Gallery'
import { KnowledgePage } from './pages/Knowledge'
import { SettingsPage } from './pages/Settings'

export default function App() {
  const { currentPage, setPage, theme, setPendingWorkflowId } = useUIStore()

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
    </div>
  )
}
