import { useEffect, useState } from 'react'
import { FolderOpen, FolderInput, Plus, Sparkles, Clock, Trash2, ArrowRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { RecentProject } from '../../../../shared/ipc-types'

interface Props {
  onSwitchProject: (path: string) => void
  onOpenExisting: () => void
  onNewProject: () => void
  onRemoveRecent: (path: string) => Promise<void>
}

/** Vibe page "homepage" — shown whenever no project is open. Replaces the
 *  former tiny "go use the top bar" empty state with a real landing screen:
 *  two primary CTAs + a list of recent projects to one-click into. */
export function NoProjectLanding({ onSwitchProject, onOpenExisting, onNewProject, onRemoveRecent }: Props) {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try {
      const rs = await window.api.vibeListRecent?.() as RecentProject[] | undefined
      setRecents(rs ?? [])
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { refresh() }, [])

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-gradient-to-b from-background to-muted/20">
      <div className="max-w-3xl mx-auto px-8 py-12 space-y-10">
        {/* Hero */}
        <div className="text-center space-y-3">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/10 flex items-center justify-center ring-1 ring-primary/20">
            <Sparkles size={28} className="text-primary" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">开始一个构建项目</h1>
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            选择一个本地文件夹打开，或者从零开始新建一个项目。AI 会读懂代码，与你协作完成需求。
          </p>
        </div>

        {/* Primary CTAs */}
        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={onNewProject}
            className={cn(
              'group flex flex-col items-start gap-2 p-5 rounded-xl border border-border bg-card text-left',
              'hover:border-primary/40 hover:bg-primary/5 transition-all'
            )}
          >
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <Plus size={18} className="text-primary" />
            </div>
            <div className="space-y-0.5">
              <div className="text-sm font-semibold">新建项目</div>
              <div className="text-[12px] text-muted-foreground">从模板创建一个全新的本地项目</div>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-primary mt-auto pt-2 opacity-60 group-hover:opacity-100">
              开始 <ArrowRight size={11} />
            </div>
          </button>

          <button
            onClick={onOpenExisting}
            className={cn(
              'group flex flex-col items-start gap-2 p-5 rounded-xl border border-border bg-card text-left',
              'hover:border-primary/40 hover:bg-primary/5 transition-all'
            )}
          >
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center group-hover:bg-amber-500/20 transition-colors">
              <FolderInput size={18} className="text-amber-600 dark:text-amber-400" />
            </div>
            <div className="space-y-0.5">
              <div className="text-sm font-semibold">打开本地文件夹</div>
              <div className="text-[12px] text-muted-foreground">把现有项目接入，立即开始对话与改造</div>
            </div>
            <div className="flex items-center gap-1 text-[11px] text-primary mt-auto pt-2 opacity-60 group-hover:opacity-100">
              选择文件夹 <ArrowRight size={11} />
            </div>
          </button>
        </div>

        {/* Recent projects */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <Clock size={13} className="text-muted-foreground" />
            <h2 className="text-xs uppercase tracking-wider text-muted-foreground font-medium">最近项目</h2>
          </div>

          {loading ? (
            <div className="text-xs text-muted-foreground/60 px-3 py-6 text-center">加载中…</div>
          ) : recents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground/60">
              暂无最近项目 — 用上面的按钮开始
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
              {recents.map(r => (
                <div
                  key={r.path}
                  onClick={() => onSwitchProject(r.path)}
                  className="group flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-accent/40 transition-colors"
                >
                  <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                    <FolderOpen size={15} className="text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{r.name}</div>
                    <div className="text-[11px] text-muted-foreground/70 font-mono truncate">{r.path}</div>
                  </div>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      await onRemoveRecent(r.path)
                      refresh()
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-opacity"
                    title="从最近移除"
                  >
                    <Trash2 size={12} />
                  </button>
                  <ArrowRight size={13} className="text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="text-center text-[11px] text-muted-foreground/50">
          打开项目后，你可以使用 对话 / 探索 / 修复 / 新需求 四种模式与 AI 协作
        </div>
      </div>
    </div>
  )
}
