import { useState, useMemo } from 'react'
import {
  Plus, Trash2, CircleCheck, Loader2, AlertCircle,
  MessageSquare, ListChecks, Search as SearchIcon, Bug, Filter
} from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { DateRangeFilter, resolveDateRange, type DateFilter } from '../../Chat/DateRangeFilter'
import type { VibeRequestInfo, VibeRequestStatus, VibeRequestKind } from '../../../../../shared/ipc-types'

interface Props {
  requests: VibeRequestInfo[]
  activeRequestId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onNew: () => void
}

const KIND_META: Record<VibeRequestKind, {
  label: string
  Icon: typeof MessageSquare
  /** Tailwind text colour for the kind chip */
  chip: string
}> = {
  chat:    { label: '对话', Icon: MessageSquare, chip: 'text-slate-600 dark:text-slate-300 bg-slate-500/10' },
  explore: { label: '探索', Icon: SearchIcon,    chip: 'text-sky-600 dark:text-sky-300 bg-sky-500/10' },
  bugfix:  { label: '修复', Icon: Bug,           chip: 'text-rose-600 dark:text-rose-300 bg-rose-500/10' },
  change:  { label: '需求', Icon: ListChecks,    chip: 'text-primary bg-primary/10' }
}

function statusBadge(status: VibeRequestStatus) {
  if (status === 'applying') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-300 text-[10px] font-medium">
        <Loader2 size={9} className="animate-spin" />
        进行中
      </span>
    )
  }
  if (status === 'done') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 text-[10px] font-medium">
        <CircleCheck size={9} />
        已完成
      </span>
    )
  }
  if (status === 'proposed') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-300 text-[10px] font-medium">
        <AlertCircle size={9} />
        待应用
      </span>
    )
  }
  return null
}

function relativeTime(epochMs: number | null | undefined): string {
  if (!epochMs) return ''
  const diff = Date.now() - epochMs
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(epochMs)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function RequestList({ requests, activeRequestId, onSelect, onDelete, onNew }: Props) {
  const dlg = useConfirmDialog()
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<VibeRequestKind | 'all'>('all')
  const [dateFilter, setDateFilter] = useState<DateFilter>({ kind: 'all' })

  async function handleDelete(r: VibeRequestInfo) {
    const ok = await dlg.confirm({
      message: `删除对话「${r.title}」？\n会同时删除磁盘上的 openspec/changes/${r.slug}/`,
      tone: 'danger',
      confirmLabel: '删除'
    })
    if (ok) onDelete(r.id)
  }

  const dateRange = useMemo(() => resolveDateRange(dateFilter), [dateFilter])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return requests.filter(r => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (dateRange) {
        const t = r.createdAt ?? 0
        if (t < dateRange.from || t > dateRange.to) return false
      }
      if (!q) return true
      return r.title.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q)
    })
  }, [requests, query, kindFilter, dateRange])

  const counts = useMemo(() => {
    const c: Record<VibeRequestKind | 'all', number> = { all: requests.length, chat: 0, explore: 0, bugfix: 0, change: 0 }
    for (const r of requests) c[r.kind]++
    return c
  }, [requests])

  return (
    <div className="flex flex-col h-full bg-card">
      {/* Header with title + new button */}
      <div className="flex items-center justify-between px-3 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare size={13} className="text-primary" />
          <span className="text-[12px] font-semibold tracking-tight">对话</span>
          <span className="text-[11px] text-muted-foreground tabular-nums">{requests.length}</span>
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-1 h-6 px-2 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:opacity-90 shadow-sm"
          title="新建对话"
        >
          <Plus size={11} />
          <span>新建</span>
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-2 shrink-0">
        <div className="relative">
          <SearchIcon size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索对话…"
            className="w-full h-7 pl-7 pr-2 rounded-md bg-background border border-border text-[11px] outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* Kind filter chips */}
      <div className="px-3 pb-1.5 shrink-0 flex items-center gap-1 flex-wrap">
        <Filter size={10} className="text-muted-foreground mr-0.5" />
        {(['all', 'change', 'chat', 'explore', 'bugfix'] as const).map(k => {
          const label = k === 'all' ? '全部' : KIND_META[k].label
          const active = kindFilter === k
          return (
            <button
              key={k}
              onClick={() => setKindFilter(k)}
              className={cn(
                'h-6 px-2 rounded-md text-[11px] transition-colors flex items-center gap-1',
                active
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'
              )}
            >
              {label}
              {counts[k] > 0 && <span className="text-muted-foreground/70 tabular-nums">{counts[k]}</span>}
            </button>
          )
        })}
      </div>

      {/* Date filter (presets + custom range, popover) */}
      <div className="px-3 pb-2 shrink-0">
        <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {filtered.length === 0 ? (
          <div className="text-[12px] text-muted-foreground text-center py-8 px-3 leading-relaxed">
            {requests.length === 0
              ? '还没有对话。点「新建」或在底部对话框输入需求开始。'
              : '没有匹配的结果'}
          </div>
        ) : filtered.map(r => {
          const meta = KIND_META[r.kind]
          const KindIcon = meta.Icon
          const isActive = activeRequestId === r.id
          return (
            <div
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={cn(
                'group relative flex flex-col gap-1 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                isActive
                  ? 'bg-primary/10 ring-1 ring-primary/30'
                  : 'hover:bg-accent/40'
              )}
            >
              <div className="flex items-start gap-2 min-w-0">
                <div className={cn('mt-0.5 shrink-0 w-5 h-5 rounded-md flex items-center justify-center', meta.chip)}>
                  <KindIcon size={11} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={cn('truncate text-[12px] font-medium leading-tight', isActive ? 'text-foreground' : 'text-foreground/90')}>
                    {r.title}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground mt-0.5">
                    {r.slug}
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(r) }}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 transition-opacity"
                  title="删除"
                >
                  <Trash2 size={10} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 pl-7 text-[11px] text-muted-foreground">
                {statusBadge(r.status)}
                <span className="ml-auto tabular-nums">{relativeTime(r.createdAt)}</span>
              </div>
            </div>
          )
        })}
      </div>
      {dlg.element}
    </div>
  )
}

// Re-export so other files don't need to wrangle the unused-warning
export type { VibeRequestStatus }
export { AlertCircle }  // for future use
