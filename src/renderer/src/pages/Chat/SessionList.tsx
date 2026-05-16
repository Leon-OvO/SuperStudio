import { useState, useMemo } from 'react'
import { Plus, MessageSquare, Trash2, Search, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Session } from '../../../../shared/ipc-types'
import { DateRangeFilter, resolveDateRange, type DateFilter } from './DateRangeFilter'

interface Props {
  sessions: Session[]
  activeId: string | null
  isRunning: boolean
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

const DAY = 86_400_000

interface SessionGroup {
  label: string
  rank: number
  items: Session[]
}

function bucketSession(ts: number, now: number): { label: string; rank: number } {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const t = startOfToday.getTime()
  if (ts >= t) return { label: '今天', rank: 0 }
  if (ts >= t - DAY) return { label: '昨天', rank: 1 }
  if (ts >= t - 7 * DAY) return { label: '过去 7 天', rank: 2 }
  if (ts >= t - 30 * DAY) return { label: '过去 30 天', rank: 3 }
  return { label: '更早', rank: 4 }
}

export function SessionList({ sessions, activeId, isRunning, onSelect, onNew, onDelete }: Props) {
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilter>({ kind: 'all' })

  const groups = useMemo<SessionGroup[]>(() => {
    const now = Date.now()
    const range = resolveDateRange(dateFilter, now)
    const q = query.trim().toLowerCase()
    const matched = sessions
      .filter(s => !q || s.title.toLowerCase().includes(q))
      .filter(s => {
        if (!range) return true
        const ts = s.updatedAt ?? s.createdAt
        return ts >= range.from && ts <= range.to
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))

    const map = new Map<string, SessionGroup>()
    for (const s of matched) {
      const ts = s.updatedAt ?? s.createdAt
      const { label, rank } = bucketSession(ts, now)
      const existing = map.get(label)
      if (existing) existing.items.push(s)
      else map.set(label, { label, rank, items: [s] })
    }
    return Array.from(map.values()).sort((a, b) => a.rank - b.rank)
  }, [sessions, query, dateFilter])

  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups])

  return (
    <aside className="w-56 flex flex-col border-r border-border bg-sidebar shrink-0">
      {/* New chat button */}
      <div className="p-2.5 border-b border-border/60">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm"
        >
          <Plus size={13} />
          新建对话
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pt-2 pb-1.5">
        <div className="relative flex items-center">
          <Search size={11} className="absolute left-2.5 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索对话…"
            className="w-full pl-7 pr-6 py-1.5 text-xs rounded-md bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none placeholder:text-muted-foreground/40 transition-all"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 text-muted-foreground/50 hover:text-muted-foreground"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Date range filter: presets + custom */}
      <div className="px-2.5 pb-2 border-b border-border/40">
        <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
      </div>

      {/* Grouped session list */}
      <div className="flex-1 overflow-y-auto py-1.5 px-1.5">
        {total === 0 ? (
          <p className="text-center text-[11px] text-muted-foreground/40 py-6">
            {query ? '无匹配对话' : dateFilter.kind === 'all' ? '暂无对话' : '该范围内暂无对话'}
          </p>
        ) : groups.map(group => (
          <section key={group.label} className="mb-2">
            <h4 className="px-2 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground/55 uppercase tracking-wider select-none">
              {group.label}
              <span className="ml-1.5 text-muted-foreground/40 font-normal normal-case">{group.items.length}</span>
            </h4>
            <div className="space-y-px">
              {group.items.map(session => (
                <div
                  key={session.id}
                  className={cn(
                    'group relative flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-all text-sm',
                    activeId === session.id
                      ? 'bg-primary/10 text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    isRunning && activeId !== session.id && 'opacity-40 cursor-not-allowed'
                  )}
                  onClick={() => !isRunning || activeId === session.id ? onSelect(session.id) : undefined}
                >
                  {activeId === session.id && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-r-full" />
                  )}
                  <MessageSquare size={12} className="shrink-0 opacity-60" />
                  <span className="flex-1 truncate leading-tight">{session.title}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(session.id) }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-destructive shrink-0"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  )
}
