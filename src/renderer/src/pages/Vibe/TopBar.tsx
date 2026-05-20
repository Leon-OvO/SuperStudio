import { useEffect, useRef, useState } from 'react'
import { Code2, ChevronDown, FolderOpen, FolderInput, Plus, Trash2, Monitor, MonitorOff, TerminalSquare } from 'lucide-react'
import { cn } from '../../lib/utils'
import { ModelPicker } from './ModelPicker'
import type { RecentProject } from '../../../../shared/ipc-types'

interface Props {
  projectPath: string | null
  providerId: string | null
  modelId: string | null
  showPreview: boolean
  showTerminal: boolean
  onSwitchProject: (path: string) => void
  onOpenExisting: () => void
  onNewProject: () => void
  onRemoveRecent: (path: string) => Promise<void>
  onModelChange: (providerId: string, modelId: string) => void
  onTogglePreview: () => void
  onToggleTerminal: () => void
}

export function TopBar({
  projectPath, providerId, modelId, showPreview, showTerminal,
  onSwitchProject, onOpenExisting, onNewProject, onRemoveRecent, onModelChange, onTogglePreview, onToggleTerminal
}: Props) {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : null

  async function refreshRecents() {
    const rs = await window.api.vibeListRecent?.() as RecentProject[] | undefined
    setRecents(rs ?? [])
  }
  useEffect(() => { refreshRecents() }, [projectPath])

  useEffect(() => {
    if (!menuOpen) return
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0 bg-card">
      <Code2 size={14} className="text-primary shrink-0" />
      <span className="text-xs font-semibold mr-1">构建</span>

      {/* Project picker */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          className={cn(
            'flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs transition-colors hover:bg-accent',
            menuOpen && 'bg-accent'
          )}
        >
          <FolderOpen size={11} className="text-amber-500" />
          <span className="font-medium max-w-[200px] truncate">{projectName ?? '未打开项目'}</span>
          <ChevronDown size={10} className={cn('transition-transform', menuOpen && 'rotate-180')} />
        </button>

        {menuOpen && (
          <div className="absolute top-full mt-1 left-0 z-50 w-80 rounded-lg border border-border bg-popover shadow-2xl py-1">
            {recents.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">暂无最近项目</div>
            ) : (
              <>
                <div className="px-3 py-1 text-[10px] uppercase text-muted-foreground/60">最近</div>
                {recents.map(r => (
                  <div
                    key={r.path}
                    onClick={() => { onSwitchProject(r.path); setMenuOpen(false) }}
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
              onClick={() => { onOpenExisting(); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
            >
              <FolderInput size={11} /> 打开本地文件夹...
            </button>
            <button
              onClick={() => { onNewProject(); setMenuOpen(false) }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
            >
              <Plus size={11} /> 新建项目...
            </button>
          </div>
        )}
      </div>

      {/* Model picker */}
      <ModelPicker
        projectPath={projectPath}
        providerId={providerId}
        modelId={modelId}
        onChange={onModelChange}
      />

      <div className="flex-1" />

      {/* Terminal toggle */}
      <button
        onClick={onToggleTerminal}
        disabled={!projectPath}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs transition-colors',
          showTerminal ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-accent',
          !projectPath && 'opacity-40 cursor-not-allowed'
        )}
        title="切换终端 (Ctrl+`)"
      >
        <TerminalSquare size={11} />
        终端
      </button>

      {/* Preview toggle */}
      <button
        onClick={onTogglePreview}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2.5 rounded-md border text-xs transition-colors',
          showPreview ? 'border-primary text-primary bg-primary/10' : 'border-border hover:bg-accent'
        )}
        title="切换浏览器预览面板"
      >
        {showPreview ? <Monitor size={11} /> : <MonitorOff size={11} />}
        预览
      </button>
    </div>
  )
}
