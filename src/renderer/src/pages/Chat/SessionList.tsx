import { useState, useMemo, useRef, useEffect } from 'react'
import { Plus, MessageSquare, Trash2, Search, X, Loader2, Archive, ArchiveRestore, Users, Pin, PinOff, ChevronDown, ChevronRight } from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '../../lib/utils'
import type { Session, EmployeeInfo } from '../../../../shared/ipc-types'
import { DateRangeFilter, resolveDateRange, type DateFilter } from './DateRangeFilter'
import { formatCostUsd } from '../../lib/format-cost'
import { dept } from '../../lib/departments'
import { useUIStore } from '../../stores/ui'

interface Props {
  sessions: Session[]
  activeId: string | null
  /** Ids of sessions with an in-flight agent run (each shows a spinner on its
   *  row). Navigation is never blocked — clicking any session always switches. */
  runningSessionIds: string[]
  /** Hired employees — used to show a dept-emoji badge on employee-bound rows. */
  employees?: EmployeeInfo[]
  onSelect: (id: string) => void
  onNew: () => void
  /** Open the "新建群聊" dialog (multi-agent). */
  onNewGroup?: () => void
  onDelete: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
  /** Pin / unpin a session (top「置顶」section + excluded from auto-archive). */
  onPin: (id: string, pinned: boolean) => void
}

const DAY = 86_400_000

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

// Flat row representation for the virtualizer — alternates between date-bucket
// headers and session items so we can pump everything through a single
// useVirtualizer with row-type-aware height estimation.
type Row =
  | { kind: 'header'; label: string; count: number; collapsed: boolean }
  | { kind: 'session'; session: Session }

// Old buckets collapse by default so the list stays short; recent + 置顶 stay open.
const DEFAULT_COLLAPSED = ['过去 30 天', '更早']

const HEADER_HEIGHT = 30
const SESSION_HEIGHT = 38

export function SessionList({ sessions, activeId, runningSessionIds, employees, onSelect, onNew, onNewGroup, onDelete, onArchive, onPin }: Props) {
  const width = useUIStore(u => u.chatSidebarWidth)
  const employeeMap = useMemo(() => {
    const m = new Map<string, EmployeeInfo>()
    for (const e of employees ?? []) m.set(e.id, e)
    return m
  }, [employees])
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilter>({ kind: 'all' })
  const [contentMatchedIds, setContentMatchedIds] = useState<Set<string> | null>(null)
  const [searching, setSearching] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(DEFAULT_COLLAPSED))
  const scrollRef = useRef<HTMLDivElement>(null)
  function toggleCollapse(label: string) {
    setCollapsed(prev => { const n = new Set(prev); n.has(label) ? n.delete(label) : n.add(label); return n })
  }

  // Full-text search: when the user types a query, hit the backend for the
  // union of (title match) + (any message content match). Debounced so we
  // don't run a LIKE for every keystroke.
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) { setContentMatchedIds(null); return }
    setSearching(true)
    const handle = setTimeout(async () => {
      try {
        const result = await window.api.searchSessions?.(trimmed) as { matchedSessionIds: string[] } | undefined
        setContentMatchedIds(new Set(result?.matchedSessionIds ?? []))
      } finally {
        setSearching(false)
      }
    }, 200)
    return () => clearTimeout(handle)
  }, [query])

  const archivedCount = useMemo(() => sessions.filter(s => s.archived === 1).length, [sessions])

  const rows = useMemo<Row[]>(() => {
    const now = Date.now()
    const range = resolveDateRange(dateFilter, now)
    const q = query.trim().toLowerCase()
    const matched = sessions
      // Scheduled-task dedicated sessions live in the Scheduler page, not the
      // chat list. Filter them out unconditionally.
      .filter(s => s.isScheduled !== 1)
      .filter(s => showArchived || s.archived !== 1)
      .filter(s => {
        if (!q) return true
        // If FTS results are in, prefer them (covers title + message content);
        // otherwise fall back to client-side title contains while the request
        // is in flight so the UI doesn't blink to empty.
        if (contentMatchedIds) return contentMatchedIds.has(s.id)
        return s.title.toLowerCase().includes(q)
      })
      .filter(s => {
        if (!range) return true
        const ts = s.updatedAt ?? s.createdAt
        return ts >= range.from && ts <= range.to
      })
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))

    // While searching, force everything expanded so matches aren't hidden.
    const searching = !!q
    const isCollapsed = (label: string) => !searching && collapsed.has(label)
    const out: Row[] = []
    const emit = (label: string, items: Session[]) => {
      const c = isCollapsed(label)
      out.push({ kind: 'header', label, count: items.length, collapsed: c })
      if (!c) for (const s of items) out.push({ kind: 'session', session: s })
    }

    // Pinned conversations float to a top「置顶」section (kept out of time buckets).
    const pinned = matched.filter(s => s.pinned === 1)
    const rest = matched.filter(s => s.pinned !== 1)
    if (pinned.length) emit('置顶', pinned)

    const groups: Array<{ label: string; rank: number; items: Session[] }> = []
    const map = new Map<string, { label: string; rank: number; items: Session[] }>()
    for (const s of rest) {
      const ts = s.updatedAt ?? s.createdAt
      const { label, rank } = bucketSession(ts, now)
      const existing = map.get(label)
      if (existing) existing.items.push(s)
      else {
        const g = { label, rank, items: [s] }
        map.set(label, g)
        groups.push(g)
      }
    }
    groups.sort((a, b) => a.rank - b.rank)
    for (const g of groups) emit(g.label, g.items)

    return out
  }, [sessions, query, dateFilter, showArchived, contentMatchedIds, collapsed])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (row?.kind === 'header') return HEADER_HEIGHT
      return SESSION_HEIGHT
    },
    overscan: 6
  })

  const total = rows.filter(r => r.kind === 'session').length

  return (
    <aside style={{ width }} className="flex flex-col border-r border-border bg-sidebar shrink-0">
      {/* New chat + new group buttons */}
      <div className="p-2.5 border-b border-border/60 flex gap-2">
        <button
          onClick={onNew}
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm"
        >
          <Plus size={13} />
          新建对话
        </button>
        {onNewGroup && (
          <button
            onClick={onNewGroup}
            title="新建群聊：多名员工组队，互相讨论"
            className="shrink-0 flex items-center justify-center gap-1 px-2.5 py-2 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 active:scale-95 transition-all"
          >
            <Users size={13} />
            群聊
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-2.5 pt-2 pb-1.5">
        <div className="relative flex items-center">
          <Search size={11} className="absolute left-2.5 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索标题或消息内容…"
            className="w-full pl-7 pr-6 py-1.5 text-xs rounded-md bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none placeholder:text-muted-foreground/40 transition-all"
          />
          {query && (searching ? (
            <Loader2 size={11} className="absolute right-2 text-muted-foreground/60 animate-spin" />
          ) : (
            <button
              onClick={() => setQuery('')}
              className="absolute right-2 text-muted-foreground/50 hover:text-muted-foreground"
              title="清除搜索"
            >
              <X size={11} />
            </button>
          ))}
        </div>
      </div>

      {/* Date range filter: presets + custom */}
      <div className="px-2.5 pb-2 border-b border-border/40 space-y-1.5">
        <DateRangeFilter value={dateFilter} onChange={setDateFilter} />
        {archivedCount > 0 && (
          <button
            onClick={() => setShowArchived(v => !v)}
            className={cn(
              'w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px] transition-colors',
              showArchived
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground/70 hover:text-foreground hover:bg-muted/60'
            )}
          >
            <Archive size={10} />
            {showArchived ? '隐藏归档' : `显示归档 (${archivedCount})`}
          </button>
        )}
      </div>

      {/* Virtualized grouped session list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1.5">
        {total === 0 ? (
          <p className="text-center text-[11px] text-muted-foreground/40 py-6">
            {query ? '无匹配对话' : dateFilter.kind === 'all' ? '暂无对话' : '该范围内暂无对话'}
          </p>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
          >
            {virtualizer.getVirtualItems().map(v => {
              const row = rows[v.index]
              return (
                <div
                  key={v.key}
                  data-index={v.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${v.start}px)`,
                    height: v.size
                  }}
                >
                  {row.kind === 'header' ? (
                    <button
                      onClick={() => toggleCollapse(row.label)}
                      className="w-full flex items-center gap-1 px-1.5 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground/55 uppercase tracking-wider select-none hover:text-muted-foreground transition-colors"
                    >
                      {row.collapsed ? <ChevronRight size={12} className="shrink-0" /> : <ChevronDown size={12} className="shrink-0" />}
                      <span className="normal-case">{row.label}</span>
                      <span className="text-muted-foreground/40 font-normal normal-case">{row.count}</span>
                    </button>
                  ) : (
                    <SessionItem
                      session={row.session}
                      active={activeId === row.session.id}
                      running={runningSessionIds.includes(row.session.id)}
                      employee={row.session.employeeId ? employeeMap.get(row.session.employeeId) : undefined}
                      groupEmployees={row.session.groupEmployeeIds?.length
                        ? row.session.groupEmployeeIds.map(id => employeeMap.get(id)).filter((e): e is EmployeeInfo => !!e)
                        : undefined}
                      onSelect={onSelect}
                      onDelete={onDelete}
                      onArchive={onArchive}
                      onPin={onPin}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

function SessionItem({
  session, active, running, employee, groupEmployees, onSelect, onDelete, onArchive, onPin
}: {
  session: Session
  active: boolean
  running: boolean
  employee?: EmployeeInfo
  groupEmployees?: EmployeeInfo[]
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onArchive: (id: string, archived: boolean) => void
  onPin: (id: string, pinned: boolean) => void
}) {
  const isArchived = session.archived === 1
  const isPinned = session.pinned === 1
  const isGroup = !!groupEmployees && groupEmployees.length > 0
  const empDept = employee ? dept(employee.dept) : null
  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 mx-0 px-2.5 py-2 rounded-lg cursor-pointer transition-all text-sm',
        active
          ? 'bg-primary/10 text-foreground font-medium'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        isArchived && !active && 'opacity-60'
      )}
      onClick={() => onSelect(session.id)}
    >
      {active && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-primary rounded-r-full" />
      )}
      {running
        ? <Loader2 size={12} className="shrink-0 animate-spin text-primary" />
        : isArchived
          ? <Archive size={12} className="shrink-0 opacity-50" />
          : isGroup
            ? <span className="shrink-0 inline-flex items-center" title={`群聊：${groupEmployees!.map(e => e.name).join('、')}`}>
                <Users size={12} className="opacity-70" />
              </span>
            : empDept
              ? <span className="shrink-0 text-[13px] leading-none" title={`与员工「${employee!.name}」的对话`}>{empDept.emoji}</span>
              : <MessageSquare size={12} className="shrink-0 opacity-60" />}
      <span className="flex-1 truncate leading-tight">{session.title}</span>
      {isGroup && (
        <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums" title="群聊人数">{groupEmployees!.length}人</span>
      )}
      {session.totalCostUsd != null && session.totalCostUsd > 0 && (
        <span
          className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums opacity-100 group-hover:opacity-0 transition-opacity"
          title={`本对话累计消耗 ${formatCostUsd(session.totalCostUsd)}（输入 ${session.totalInputTokens ?? 0} / 输出 ${session.totalOutputTokens ?? 0} tokens）`}
        >
          {formatCostUsd(session.totalCostUsd)}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onPin(session.id, !isPinned) }}
        title={isPinned ? '取消置顶' : '置顶（排到列表最前，且不被自动归档）'}
        className={cn('transition-opacity p-0.5 rounded hover:text-foreground shrink-0',
          isPinned ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100')}
      >
        {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onArchive(session.id, !isArchived) }}
        title={isArchived ? '取消归档' : '归档（从列表隐藏，不删除）'}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-foreground shrink-0"
      >
        {isArchived ? <ArchiveRestore size={11} /> : <Archive size={11} />}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(session.id) }}
        title="永久删除"
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:text-destructive shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  )
}
