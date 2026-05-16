import { useEffect, useRef, useState } from 'react'
import { Calendar, ChevronDown, X } from 'lucide-react'
import { cn } from '../../lib/utils'

const DAY = 86_400_000

export type PresetKey = 'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'last_month'

export type DateFilter =
  | { kind: 'all' }
  | { kind: 'preset'; preset: PresetKey }
  | { kind: 'custom'; from: number; to: number }

const PRESET_LABELS: Record<PresetKey, string> = {
  today: '今天',
  yesterday: '昨天',
  '7d': '过去 7 天',
  '30d': '过去 30 天',
  this_month: '本月',
  last_month: '上月'
}

/** Convert a filter into an actual [from, to] millisecond range. null = no filter. */
export function resolveDateRange(filter: DateFilter, now = Date.now()): { from: number; to: number } | null {
  if (filter.kind === 'all') return null
  if (filter.kind === 'custom') return { from: filter.from, to: filter.to }

  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const t = startOfToday.getTime()

  switch (filter.preset) {
    case 'today':       return { from: t, to: now }
    case 'yesterday':   return { from: t - DAY, to: t - 1 }
    case '7d':          return { from: t - 7 * DAY, to: now }
    case '30d':         return { from: t - 30 * DAY, to: now }
    case 'this_month': {
      const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0)
      return { from: d.getTime(), to: now }
    }
    case 'last_month': {
      const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0)
      const thisStart = d.getTime()
      d.setMonth(d.getMonth() - 1)
      return { from: d.getTime(), to: thisStart - 1 }
    }
  }
}

/** Format a date as "YYYY-MM-DD" in local time. */
function toISODate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse "YYYY-MM-DD" as local-time start-of-day. */
function fromISODate(s: string): number {
  if (!s) return NaN
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return NaN
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

function shortLabel(filter: DateFilter): string {
  if (filter.kind === 'all') return '全部时间'
  if (filter.kind === 'preset') return PRESET_LABELS[filter.preset]
  // custom — show MM-DD ~ MM-DD; full date shown in title
  const f = new Date(filter.from)
  const t = new Date(filter.to)
  const sameYear = f.getFullYear() === t.getFullYear()
  const fStr = `${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
  const tStr = `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  return sameYear ? `${fStr} ~ ${tStr}` : `${toISODate(filter.from)} ~ ${toISODate(filter.to)}`
}

interface Props {
  value: DateFilter
  onChange: (filter: DateFilter) => void
}

export function DateRangeFilter({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Custom-mode drafts (controlled inside the popover until user clicks 应用)
  const [fromStr, setFromStr] = useState('')
  const [toStr, setToStr] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)

  // Initialize drafts when opening
  useEffect(() => {
    if (!open) return
    if (value.kind === 'custom') {
      setFromStr(toISODate(value.from))
      setToStr(toISODate(value.to))
    } else {
      setFromStr('')
      setToStr('')
    }
    setCustomError(null)
  }, [open, value])

  // Close on outside click + Escape
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isActive = value.kind !== 'all'

  function selectPreset(key: PresetKey) {
    onChange({ kind: 'preset', preset: key })
    setOpen(false)
  }

  function applyCustom() {
    const f = fromISODate(fromStr)
    const t = fromISODate(toStr)
    if (Number.isNaN(f) || Number.isNaN(t)) {
      setCustomError('请选择起始与结束日期')
      return
    }
    if (f > t) {
      setCustomError('起始日期不能晚于结束日期')
      return
    }
    // Extend "to" to end-of-day so the chosen day is fully included
    const endOfTo = t + DAY - 1
    onChange({ kind: 'custom', from: f, to: endOfTo })
    setOpen(false)
  }

  function clearFilter() {
    onChange({ kind: 'all' })
    setOpen(false)
  }

  // The X icon clears without opening the popover
  function quickClear(e: React.MouseEvent) {
    e.stopPropagation()
    onChange({ kind: 'all' })
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title={value.kind === 'custom' ? `${toISODate(value.from)} ~ ${toISODate(value.to)}` : '日期筛选'}
        className={cn(
          'w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors',
          isActive
            ? 'bg-primary/10 text-primary border border-primary/30'
            : 'border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60'
        )}
      >
        <Calendar size={11} className="shrink-0" />
        <span className="flex-1 truncate text-left">{shortLabel(value)}</span>
        {isActive ? (
          <button
            onClick={quickClear}
            title="清除筛选"
            className="shrink-0 -mr-0.5 hover:bg-primary/15 rounded p-0.5"
          >
            <X size={10} />
          </button>
        ) : (
          <ChevronDown size={11} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
        )}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-popover border border-border rounded-lg shadow-xl p-3 space-y-3 min-w-[224px]">
          {/* Presets */}
          <div className="space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">快捷范围</p>
            <div className="grid grid-cols-2 gap-1">
              <PresetBtn label="全部" active={value.kind === 'all'} onClick={clearFilter} />
              {(Object.keys(PRESET_LABELS) as PresetKey[]).map(key => (
                <PresetBtn
                  key={key}
                  label={PRESET_LABELS[key]}
                  active={value.kind === 'preset' && value.preset === key}
                  onClick={() => selectPreset(key)}
                />
              ))}
            </div>
          </div>

          {/* Custom range */}
          <div className="space-y-1.5 pt-2 border-t border-border/60">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">自定义</p>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-5 shrink-0">从</label>
                <input
                  type="date"
                  value={fromStr}
                  max={toStr || undefined}
                  onChange={e => { setFromStr(e.target.value); setCustomError(null) }}
                  className="flex-1 px-2 py-1 text-xs rounded border border-border bg-card outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-muted-foreground w-5 shrink-0">至</label>
                <input
                  type="date"
                  value={toStr}
                  min={fromStr || undefined}
                  onChange={e => { setToStr(e.target.value); setCustomError(null) }}
                  className="flex-1 px-2 py-1 text-xs rounded border border-border bg-card outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {customError && (
                <p className="text-[10px] text-destructive">{customError}</p>
              )}
              <button
                onClick={applyCustom}
                disabled={!fromStr || !toStr}
                className={cn(
                  'w-full mt-1 px-2 py-1.5 rounded text-xs font-medium transition-colors',
                  fromStr && toStr
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                应用自定义范围
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PresetBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2 py-1.5 rounded text-[11px] transition-colors',
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
      )}
    >
      {label}
    </button>
  )
}
