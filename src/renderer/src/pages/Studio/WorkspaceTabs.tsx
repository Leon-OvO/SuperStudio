import { Plus, X, FileImage } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface WorkspaceTab { id: string; name: string }

/**
 * Browser-style strip of open canvases (Phase 1). Tabs are bookmarks over the
 * single mounted canvas editor — selecting one re-opens it via Studio's openNonce
 * mechanism; only one canvas is mounted at a time (true multi-mount deferred).
 * When the active canvas is a fresh unsaved one (activeId null), a leading
 * "未命名画布" chip is shown until autosave gives it an id.
 */
export function WorkspaceTabs({ tabs, activeId, unsavedActive, onSelect, onClose, onNew }: {
  tabs: WorkspaceTab[]
  activeId: string | null
  unsavedActive: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className="shrink-0 flex items-center gap-1 px-2 h-9 border-b border-border bg-background/60 overflow-x-auto scrollbar-none">
      {unsavedActive && (
        <div className="flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-lg text-xs shrink-0 bg-card text-foreground border border-border shadow-sm">
          <FileImage size={12} className="text-muted-foreground" />
          <span className="max-w-[140px] truncate">未命名画布</span>
        </div>
      )}
      {tabs.map(t => {
        const active = !unsavedActive && t.id === activeId
        return (
          <div
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              'group flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-lg text-xs shrink-0 cursor-pointer transition-colors',
              active
                ? 'bg-card text-foreground border border-border shadow-sm'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent/50 border border-transparent'
            )}
          >
            <FileImage size={12} className={active ? 'text-primary' : 'text-muted-foreground/70'} />
            <span className="max-w-[140px] truncate">{t.name}</span>
            <button
              onClick={e => { e.stopPropagation(); onClose(t.id) }}
              title="关闭标签"
              className={cn('p-0.5 rounded hover:bg-accent text-muted-foreground/60 hover:text-foreground transition-opacity',
                active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
      <button onClick={onNew} title="新建画布"
        className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 shrink-0">
        <Plus size={15} />
      </button>
    </div>
  )
}
