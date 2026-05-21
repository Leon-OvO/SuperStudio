import { useEffect, useRef, useState } from 'react'
import { FolderOpen, FolderInput, Plus, Trash2, ChevronDown } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { RecentProject } from '../../../../../shared/ipc-types'

/** VS Code "command center" style pill — sits centered on the menu bar row.
 *  Click opens a dropdown with recent projects + open / new actions. */
export function ProjectPill({
  projectPath, onSwitchProject, onOpenExisting, onNewProject, onRemoveRecent
}: {
  projectPath: string | null
  onSwitchProject: (path: string) => void
  onOpenExisting: () => void
  onNewProject: () => void
  onRemoveRecent: (path: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [recents, setRecents] = useState<RecentProject[]>([])
  const ref = useRef<HTMLDivElement>(null)

  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : null

  async function refreshRecents() {
    const rs = await window.api.vibeListRecent?.() as RecentProject[] | undefined
    setRecents(rs ?? [])
  }
  useEffect(() => { refreshRecents() }, [projectPath])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-2 h-6 pl-2 pr-2.5 rounded-full text-xs border border-border/60 bg-background/60 hover:bg-accent/40 transition-colors',
          'min-w-[180px] max-w-[360px]',
          open && 'bg-accent border-primary/40'
        )}
        title={projectPath ?? '未打开项目'}
      >
        <FolderOpen size={11} className="text-amber-500 shrink-0" />
        <span className="flex-1 truncate text-left font-medium">
          {projectName ?? '未打开项目'}
        </span>
        <ChevronDown size={10} className={cn('text-muted-foreground/70 transition-transform shrink-0', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 w-80 rounded-lg border border-border bg-popover shadow-2xl py-1">
          {recents.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">暂无最近项目</div>
          ) : (
            <>
              <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">最近</div>
              {recents.map(r => (
                <div
                  key={r.path}
                  onClick={() => { onSwitchProject(r.path); setOpen(false) }}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 group cursor-pointer hover:bg-accent',
                    projectPath === r.path && 'bg-primary/10'
                  )}
                >
                  <FolderOpen size={11} className="text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{r.name}</div>
                    <div className="text-[10px] text-muted-foreground/60 font-mono truncate">{r.path}</div>
                  </div>
                  <button
                    onClick={async (e) => { e.stopPropagation(); await onRemoveRecent(r.path); refreshRecents() }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                    title="从最近移除"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="border-t border-border my-1" />
          <button
            onClick={() => { onOpenExisting(); setOpen(false) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
          >
            <FolderInput size={11} /> 打开本地文件夹...
          </button>
          <button
            onClick={() => { onNewProject(); setOpen(false) }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
          >
            <Plus size={11} /> 新建项目...
          </button>
        </div>
      )}
    </div>
  )
}
