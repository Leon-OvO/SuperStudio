import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  X, RefreshCw, Activity, Wallet, Database, Sparkles, ArrowDownToLine, ArrowUpFromLine,
} from 'lucide-react'
import { BRAND } from '@shared/brand'
import { cn } from '../lib/utils'
import { formatTokens, formatCostUsd } from '../lib/format-cost'
import { Select } from './ui/Select'
import type { UsageRange, UsageStats, UsageLogRow, UsageGroupRow } from '@shared/ipc-types'

const RANGES: { id: UsageRange; label: string }[] = [
  { id: 'today', label: '当天' },
  { id: 'last7d', label: '近 7 天' },
  { id: 'last30d', label: '近 30 天' },
  { id: 'all', label: '全部' },
  { id: 'custom', label: '自定义' },
]

type Tab = 'log' | 'provider' | 'model'

const pad2 = (n: number) => String(n).padStart(2, '0')
function startOfDayLocal(ts: number): number { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
function epochToDateStr(ts: number): string { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
function dateStrToEpoch(s: string): number | null { if (!s) return null; const t = new Date(`${s}T00:00:00`).getTime(); return Number.isFinite(t) ? t : null }

// Big "≈ 4.02 亿" subtitle for the hero token count.
function approxCn(n: number): string {
  if (n >= 1e8) return `≈ ${(n / 1e8).toFixed(2)} 亿 tokens`
  if (n >= 1e4) return `≈ ${(n / 1e4).toFixed(1)} 万 tokens`
  return `${n.toLocaleString()} tokens`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function UsageStatsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState<UsageRange>('today')
  const [data, setData] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('log')
  const [providerFilter, setProviderFilter] = useState('all')
  const [modelQuery, setModelQuery] = useState('')
  // Custom range: the date-input strings, plus the *applied* window that actually
  // drives loads (so editing a date doesn't refetch until 应用 / Enter).
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState('')
  // null on a side = open-ended (handler derives from the earliest record / now).
  const [customWin, setCustomWin] = useState<{ start: number | null; end: number | null } | null>(null)

  const load = useCallback(async () => {
    // 'custom' before a window is chosen → wait (selectRange seeds one immediately).
    if (range === 'custom' && !customWin) return
    setLoading(true)
    setError('')
    try {
      const custom = range === 'custom' && customWin
        ? { start: customWin.start ?? undefined, end: customWin.end ?? undefined }
        : undefined
      const res = await window.api.getUsageStats(range, custom)
      setData(res)
    } catch (e) {
      setError((e as Error)?.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [range, customWin])

  useEffect(() => { if (open) load() }, [open, load])

  const selectRange = useCallback((id: UsageRange) => {
    if (id === 'custom' && !customWin) {
      const end = startOfDayLocal(Date.now())
      const start = end - 6 * 86_400_000   // default: last 7 days inclusive
      setCustomStart(epochToDateStr(start))
      setCustomEnd(epochToDateStr(end))
      setCustomWin({ start, end })
    }
    setRange(id)
  }, [customWin])

  const applyCustom = useCallback(() => {
    const s = dateStrToEpoch(customStart)
    const e = dateStrToEpoch(customEnd)
    if (s == null && e == null) return
    // Pass blanks through as null (open-ended) — never coerce a cleared start to
    // epoch 0, which would drag the trend back to 1970.
    setCustomWin({ start: s, end: e })
  }, [customStart, customEnd])

  // Esc to close
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const s = data?.summary
  const hitPct = s ? s.cacheHitRate * 100 : 0

  // Filtered request log (provider + model search, client-side).
  const filteredLog = useMemo<UsageLogRow[]>(() => {
    if (!data) return []
    const q = modelQuery.trim().toLowerCase()
    return data.log.filter(r =>
      (providerFilter === 'all' || r.provider === providerFilter) &&
      (!q || r.model.toLowerCase().includes(q))
    )
  }, [data, providerFilter, modelQuery])

  const providerOptions = useMemo(() => [
    { value: 'all', label: '全部供应商' },
    ...(data?.byProvider ?? []).map(p => ({ value: p.key, label: p.key })),
  ], [data])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[140] bg-black/50 backdrop-blur-sm flex flex-col p-3 sm:p-5 animate-overlay-in"
      onClick={onClose}
    >
      <div
        className="mx-auto w-full max-w-5xl bg-background border border-border rounded-2xl shadow-2xl flex flex-col max-h-full overflow-hidden animate-dialog-in"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Title bar ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
          <div className="w-6 h-6 rounded-md bg-primary/15 flex items-center justify-center">
            <Activity size={14} className="text-primary" />
          </div>
          <h2 className="text-sm font-semibold flex-1">用量统计</h2>
          <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-0.5">
            {RANGES.map(r => (
              <button
                key={r.id}
                onClick={() => selectRange(r.id)}
                className={cn(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-all',
                  range === r.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={load}
            disabled={loading}
            title="刷新"
            className="p-1.5 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onClose}
            title="关闭"
            className="p-1.5 rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground transition-colors"
          >
            <X size={15} />
          </button>
        </div>

        {/* ── Custom date range row ── */}
        {range === 'custom' && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-border bg-muted/20 shrink-0 flex-wrap">
            <span className="text-xs text-muted-foreground shrink-0">自定义范围</span>
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={e => setCustomStart(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyCustom() }}
              className="input h-8 text-xs w-[150px]"
            />
            <span className="text-muted-foreground text-xs">—</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={e => setCustomEnd(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyCustom() }}
              className="input h-8 text-xs w-[150px]"
            />
            <button onClick={applyCustom} className="btn-primary h-8 text-xs px-3 shrink-0">应用</button>
          </div>
        )}

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-2.5 text-sm text-destructive flex items-center gap-3">
              <span className="flex-1">{error}</span>
              <button onClick={load} className="underline text-xs shrink-0">重试</button>
            </div>
          )}

          {/* ── Hero card ── */}
          <div className="rounded-2xl border border-border bg-gradient-to-br from-card to-card/40 p-5">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles size={14} className="text-primary" />
                <span className="font-medium text-foreground/80">{BRAND.productName} · 真实消耗 Tokens</span>
              </div>
              <div className="flex items-center gap-6 text-right">
                <div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1 justify-end"><Activity size={11} /> 总请求数</div>
                  <div className="text-lg font-semibold">{(s?.requests ?? 0).toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-[11px] text-muted-foreground flex items-center gap-1 justify-end"><Wallet size={11} /> 总成本</div>
                  <div className="text-lg font-semibold text-emerald-500">{formatCostUsd(s?.cost ?? 0)}</div>
                </div>
              </div>
            </div>

            <div className="mt-3">
              <div className="text-4xl font-bold tracking-tight tabular-nums">{(s?.totalTokens ?? 0).toLocaleString()}</div>
              <div className="text-xs text-muted-foreground mt-1">{approxCn(s?.totalTokens ?? 0)}</div>
            </div>

            {/* sub stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 mt-4">
              <StatMini icon={ArrowDownToLine} label="新增输入" value={formatTokens(s?.input ?? 0)} accent="text-sky-500" />
              <StatMini icon={ArrowUpFromLine} label="Output" value={formatTokens(s?.output ?? 0)} accent="text-amber-500" />
              <StatMini icon={Database} label="创建（缓存写）" value={formatTokens(s?.cacheWrite ?? 0)} accent="text-violet-500" />
              <StatMini icon={Sparkles} label="命中（缓存读）" value={formatTokens(s?.cacheRead ?? 0)} accent="text-emerald-500" />
            </div>

            {/* cache hit rate */}
            <div className="flex items-center gap-3 mt-4">
              <span className="text-xs text-muted-foreground shrink-0">缓存命中率</span>
              <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${Math.min(100, hitPct)}%` }} />
              </div>
              <span className="text-xs font-semibold text-emerald-500 w-12 text-right shrink-0">{hitPct.toFixed(1)}%</span>
            </div>
          </div>

          {/* ── Trend chart ── */}
          <section className="rounded-2xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold mb-3">使用趋势</h3>
            {(data?.trend.length ?? 0) === 0 ? (
              <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground">
                {loading ? <><RefreshCw size={14} className="animate-spin mr-2" /> 加载中…</> : '暂无数据'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={data?.trend} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="usageTokFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={20} />
                  <YAxis yAxisId="tok" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={42}
                    tickFormatter={(v: number) => formatTokens(v)} />
                  <YAxis yAxisId="cost" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={42}
                    tickFormatter={(v: number) => (v >= 1 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`)} />
                  <Tooltip content={<TrendTooltip />} />
                  <Area yAxisId="tok" type="monotone" dataKey="tokens" name="Tokens"
                    stroke="#8b5cf6" strokeWidth={2} fill="url(#usageTokFill)" />
                  <Line yAxisId="cost" type="monotone" dataKey="cost" name="成本"
                    stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </section>

          {/* ── Tabs ── */}
          <section className="rounded-2xl border border-border bg-card overflow-hidden">
            <div className="flex items-center gap-1 px-3 pt-3 border-b border-border flex-wrap">
              <TabBtn active={tab === 'log'} onClick={() => setTab('log')}>请求日志</TabBtn>
              <TabBtn active={tab === 'provider'} onClick={() => setTab('provider')}>Provider 统计</TabBtn>
              <TabBtn active={tab === 'model'} onClick={() => setTab('model')}>模型统计</TabBtn>
            </div>

            {tab === 'log' && (
              <>
                <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/60 flex-wrap">
                  <Select
                    value={providerFilter}
                    onChange={setProviderFilter}
                    options={providerOptions}
                    size="sm"
                    className="min-w-[140px]"
                    title="按供应商筛选"
                  />
                  <input
                    className="input h-8 text-xs flex-1 min-w-[160px]"
                    placeholder="搜索模型…"
                    value={modelQuery}
                    onChange={e => setModelQuery(e.target.value)}
                  />
                  <span className="text-[11px] text-muted-foreground ml-auto">
                    {filteredLog.length} 条{data?.logTruncated ? `（仅显示最近 ${data.log.length}）` : ''}
                  </span>
                </div>
                <LogTable rows={filteredLog} loading={loading} />
              </>
            )}

            {tab === 'provider' && <GroupTable rows={data?.byProvider ?? []} loading={loading} nameLabel="供应商" />}
            {tab === 'model' && <GroupTable rows={data?.byModel ?? []} loading={loading} nameLabel="模型" />}
          </section>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatMini({ icon: Icon, label, value, accent }: {
  icon: React.ElementType; label: string; value: string; accent: string
}) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Icon size={11} className={accent} /> {label}
      </div>
      <div className="text-lg font-semibold tracking-tight mt-0.5 tabular-nums">{value}</div>
    </div>
  )
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-2 text-xs font-medium -mb-px border-b-2 transition-colors',
        active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

function TrendTooltip({ active, payload, label }: {
  active?: boolean; label?: string
  payload?: Array<{ name: string; value: number; color: string }>
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-lg text-xs space-y-1">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{p.name === '成本' ? formatCostUsd(p.value) : formatTokens(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: UsageLogRow['status'] }) {
  if (status === 'error') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-600 dark:text-red-400">失败</span>
  if (status === 'partial') return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">中断</span>
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">成功</span>
}

function LogTable({ rows, loading }: { rows: UsageLogRow[]; loading: boolean }) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-muted-foreground">
        {loading ? <><RefreshCw size={14} className="animate-spin inline mr-1" /> 加载中…</> : '暂无请求记录'}
      </div>
    )
  }
  return (
    <div className="overflow-x-auto max-h-[42vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="text-[11px] text-muted-foreground border-b border-border">
            <th className="text-left px-4 py-2 font-medium">时间</th>
            <th className="text-left px-3 py-2 font-medium">来源</th>
            <th className="text-left px-3 py-2 font-medium">供应商</th>
            <th className="text-left px-3 py-2 font-medium">模型</th>
            <th className="text-right px-3 py-2 font-medium">输入</th>
            <th className="text-right px-3 py-2 font-medium">输出</th>
            <th className="text-right px-3 py-2 font-medium">成本</th>
            <th className="text-right px-3 py-2 font-medium">用时</th>
            <th className="text-center px-3 py-2 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors', i % 2 !== 0 && 'bg-muted/10')}>
              <td className="px-4 py-2 text-[11px] font-mono text-muted-foreground whitespace-nowrap">{fmtTime(r.ts)}</td>
              <td className="px-3 py-2 text-[11px] text-muted-foreground whitespace-nowrap">{r.source}</td>
              <td className="px-3 py-2 text-xs truncate max-w-[140px]">{r.provider}</td>
              <td className="px-3 py-2 text-xs font-mono truncate max-w-[160px]">{r.model}</td>
              <td className="px-3 py-2 text-right">
                <div className="font-mono text-xs">{formatTokens(r.input)}</div>
                {(r.cacheRead > 0 || r.cacheWrite > 0) && (
                  <div className="text-[10px] text-muted-foreground/70 font-mono whitespace-nowrap">
                    R{formatTokens(r.cacheRead)}·W{formatTokens(r.cacheWrite)}
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{formatTokens(r.output)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{r.cost == null ? '—' : formatCostUsd(r.cost)}</td>
              <td className="px-3 py-2 text-right font-mono text-[11px] text-muted-foreground">{fmtDuration(r.durationMs)}</td>
              <td className="px-3 py-2 text-center"><StatusBadge status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GroupTable({ rows, loading, nameLabel }: { rows: UsageGroupRow[]; loading: boolean; nameLabel: string }) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center text-sm text-muted-foreground">
        {loading ? <><RefreshCw size={14} className="animate-spin inline mr-1" /> 加载中…</> : '暂无数据'}
      </div>
    )
  }
  const maxTokens = Math.max(1, ...rows.map(r => r.tokens))
  return (
    <div className="overflow-x-auto max-h-[42vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card z-10">
          <tr className="text-[11px] text-muted-foreground border-b border-border">
            <th className="text-left px-4 py-2 font-medium">{nameLabel}</th>
            <th className="text-right px-3 py-2 font-medium">请求数</th>
            <th className="text-right px-3 py-2 font-medium">Tokens</th>
            <th className="text-right px-3 py-2 font-medium">成本</th>
            <th className="px-4 py-2 font-medium w-32">占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn('border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors', i % 2 !== 0 && 'bg-muted/10')}>
              <td className="px-4 py-2.5 text-xs font-mono truncate max-w-[220px]">{r.key}</td>
              <td className="px-3 py-2.5 text-right font-mono text-xs text-muted-foreground">{r.requests.toLocaleString()}</td>
              <td className="px-3 py-2.5 text-right font-mono text-xs">{formatTokens(r.tokens)}</td>
              <td className="px-3 py-2.5 text-right font-mono text-xs">{formatCostUsd(r.cost)}</td>
              <td className="px-4 py-2.5">
                <div className="bg-muted rounded-full h-1.5 overflow-hidden">
                  <div className="h-full bg-primary rounded-full" style={{ width: `${(r.tokens / maxTokens) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
