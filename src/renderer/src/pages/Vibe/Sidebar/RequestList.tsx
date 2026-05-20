import { Plus, Trash2, CircleCheck, Loader2, AlertCircle, MessageSquare, ListChecks, Search, Bug } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useConfirmDialog } from '../../../components/ui/ConfirmDialog'
import type { VibeRequestInfo, VibeRequestStatus, VibeRequestKind } from '../../../../../shared/ipc-types'

interface Props {
  requests: VibeRequestInfo[]
  activeRequestId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}

function statusIcon(status: VibeRequestStatus, kind: VibeRequestKind) {
  // Status takes priority — running / done shown the same regardless of kind
  if (status === 'applying') return <Loader2 size={11} className="text-blue-500 animate-spin" />
  if (status === 'done') return <CircleCheck size={11} className="text-emerald-500" />
  // Otherwise show kind-specific icon
  if (kind === 'chat')    return <MessageSquare size={11} className="text-slate-500" />
  if (kind === 'explore') return <Search size={11} className="text-sky-500" />
  if (kind === 'bugfix')  return <Bug size={11} className="text-rose-500" />
  return <ListChecks size={11} className="text-primary" />
}

export function RequestList({ requests, activeRequestId, onSelect, onDelete, onNew }: Props) {
  const dlg = useConfirmDialog()

  async function handleDelete(r: VibeRequestInfo) {
    const ok = await dlg.confirm({
      message: `删除对话「${r.title}」？\n会同时删除磁盘上的 openspec/changes/${r.slug}/`,
      tone: 'danger',
      confirmLabel: '删除'
    })
    if (ok) onDelete(r.id)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 shrink-0">
        <span className="text-[10px] uppercase text-muted-foreground/60 font-semibold">对话</span>
        <button
          onClick={onNew}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="新建对话"
        >
          <Plus size={12} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {requests.length === 0 ? (
          <div className="text-[11px] text-muted-foreground/60 text-center py-6 px-3">
            还没有对话。点 + 或在下方输入框描述要做什么。
          </div>
        ) : requests.map(r => (
          <div
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={cn(
              'group flex items-start gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-accent text-xs',
              activeRequestId === r.id && 'bg-primary/10 text-foreground'
            )}
          >
            <div className="mt-0.5 shrink-0">{statusIcon(r.status, r.kind)}</div>
            <div className="flex-1 min-w-0">
              <div className="truncate font-medium">{r.title}</div>
              <div className="truncate text-[10px] text-muted-foreground/60 font-mono">{r.slug}</div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleDelete(r) }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground hover:text-destructive shrink-0"
              title="删除"
            >
              <Trash2 size={10} />
            </button>
          </div>
        ))}
      </div>
      {dlg.element}
    </div>
  )
}

// Re-export so other files don't need to wrangle the unused-warning
export type { VibeRequestStatus }
export { AlertCircle }  // for future use
