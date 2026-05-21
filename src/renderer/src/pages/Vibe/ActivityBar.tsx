import { MessageSquare, FolderTree } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/ui'

export type ActivityPanel = 'requests' | 'files'

const ITEMS: Array<{
  id: ActivityPanel
  label: string
  Icon: typeof MessageSquare
}> = [
  { id: 'requests', label: '对话', Icon: MessageSquare },
  { id: 'files',    label: '文件', Icon: FolderTree }
]

/** VS Code–style vertical icon column on the very left edge. Click an icon to
 *  switch which panel the sidebar renders. Clicking the active icon again
 *  collapses the sidebar entirely. */
export function ActivityBar() {
  const active = useUIStore(u => u.vibeActivity)
  const setActive = useUIStore(u => u.setVibeActivity)
  const sidebarOpen = useUIStore(u => u.vibeSidebarOpen)
  const setSidebarOpen = useUIStore(u => u.setVibeSidebarOpen)

  return (
    <div className="w-11 shrink-0 flex flex-col items-center bg-card/40 border-r border-border/60 py-2 gap-1">
      {ITEMS.map(it => {
        const isActive = active === it.id && sidebarOpen
        return (
          <button
            key={it.id}
            onClick={() => {
              if (active === it.id && sidebarOpen) {
                setSidebarOpen(false)
              } else {
                setActive(it.id)
                setSidebarOpen(true)
              }
            }}
            className={cn(
              'relative w-9 h-9 rounded-lg flex items-center justify-center transition-all',
              isActive
                ? 'text-foreground bg-accent'
                : 'text-muted-foreground/70 hover:text-foreground hover:bg-accent/40'
            )}
            title={it.label}
          >
            <it.Icon size={17} />
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-r bg-primary" />
            )}
          </button>
        )
      })}
    </div>
  )
}
