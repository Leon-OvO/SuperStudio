import { useEffect, useState, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, BarChart, Bar
} from 'recharts'
import {
  Wallet, Activity, TrendingUp, Cpu, Zap,
  RefreshCw, ChevronDown, Calendar, ChevronRight
} from 'lucide-react'
import { cn } from '../../lib/utils'

// ---------------------------------------------------------------------------
// Flexible deep-pick: tries every provided key (including `obj.today.key`)
// ---------------------------------------------------------------------------

function pick(obj: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && isFinite(v)) return v
  }
  // Also try under common nested wrapper keys
  for (const wrapper of ['today', 'summary', 'stats', 'data', 'usage']) {
    const sub = obj[wrapper]
    if (sub && typeof sub === 'object') {
      const s = sub as Record<string, unknown>
      for (const k of keys) {
        const v = s[k]
        if (typeof v === 'number' && isFinite(v)) return v
      }
    }
  }
  return undefined
}

// Normalise a cache-hit-rate value that might be 0-1 or 0-100
function normRate(v: number | undefined): number | undefined {
  if (v == null) return undefined
  if (v > 1) return v / 100   // already a percentage
  return v
}

// ---------------------------------------------------------------------------
// Pull a list from an API response — handles both array and wrapped shapes
// ---------------------------------------------------------------------------

function extractList<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    for (const k of ['items', 'data', 'results', 'list', 'records', 'trend', 'logs']) {
      if (Array.isArray(r[k])) return r[k] as T[]
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmt$(v: number | undefined) {
  if (v == null) return '—'
  return `$${v.toFixed(4)}`
}

function fmtK(v: number | undefined) {
  if (v == null) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`
  return String(Math.round(v))
}

function fmtPct(v: number | undefined) {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function fmtDate(d: string | undefined) {
  if (!d) return ''
  try { return new Date(d).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) }
  catch { return d }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RawObj = Record<string, unknown>

type Preset = 'today' | 'last7d' | 'last30d' | 'custom'

const PRESETS: { id: Preset; label: string }[] = [
  { id: 'today', label: '今日' },
  { id: 'last7d', label: '近 7 天' },
  { id: 'last30d', label: '近 30 天' },
  { id: 'custom', label: '自定义' },
]

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({ icon: Icon, label, value, sub, accent, accentBg }: {
  icon: React.ElementType
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  accent?: string
  accentBg?: string
}) {
  return (
    <div className="flex-1 min-w-0 bg-card border border-border rounded-xl p-4 hover:shadow-md hover:border-border/80 transition-all relative overflow-hidden group">
      <div className={cn(
        'absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-0 group-hover:opacity-100 blur-2xl transition-opacity',
        accentBg ?? 'bg-primary/20'
      )} />
      <div className="relative space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium">
          <div className={cn('p-1 rounded-md', accentBg ?? 'bg-primary/10')}>
            <Icon size={12} className={accent ?? 'text-primary'} />
          </div>
          {label}
        </div>
        <div className="text-2xl font-bold tracking-tight truncate">{value}</div>
        {sub && <div className="text-xs text-muted-foreground truncate">{sub}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chart tooltip
// ---------------------------------------------------------------------------

function CustomTooltip({ active, payload, label, unit }: {
  active?: boolean
  payload?: Array<{ name: string; value: number; color: string }>
  label?: string
  unit?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-lg text-xs space-y-1">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}:</span>
          <span className="font-medium">{unit === '$' ? `$${p.value.toFixed(4)}` : fmtK(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Raw debug panel (collapsed by default — helps identify API field names)
// ---------------------------------------------------------------------------

function DebugPanel({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      open={open}
      onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}
      className="border border-border/50 rounded-lg overflow-hidden"
    >
      <summary className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground">
        <ChevronRight size={11} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        调试：原始 API 数据（用于诊断字段名）
      </summary>
      <pre className="text-[10px] font-mono leading-snug text-muted-foreground/70 bg-muted/30 px-4 py-3 overflow-x-auto max-h-60">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Dashboard Page
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const [preset, setPreset] = useState<Preset>('last7d')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [showDatePicker, setShowDatePicker] = useState(false)

  const [rawStats, setRawStats] = useState<RawObj>({})
  const [trend, setTrend] = useState<RawObj[]>([])
  const [models, setModels] = useState<RawObj[]>([])
  const [keysUsage, setKeysUsage] = useState<RawObj[]>([])
  const [keyNames, setKeyNames] = useState<Record<string, { name: string; platform: string; groupName: string }>>({})
  const [rawAll, setRawAll] = useState<RawObj>({})

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)

  const dateParams = useCallback(() => {
    if (preset === 'custom') {
      return { start_date: startDate || undefined, end_date: endDate || undefined }
    }
    return { preset }
  }, [preset, startDate, endDate])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = dateParams()
      const [statsRaw, trendRaw, modelsRaw, keysRaw] = await Promise.all([
        window.api.getDashboardStats().catch((e: Error) => { console.warn('[dash] stats err:', e); return {} }),
        window.api.getDashboardTrend(params).catch((e: Error) => { console.warn('[dash] trend err:', e); return {} }),
        window.api.getDashboardModels(params).catch((e: Error) => { console.warn('[dash] models err:', e); return {} }),
        window.api.getDashboardKeysUsage(params).catch((e: Error) => { console.warn('[dash] keys err:', e); return {} }),
      ])
      console.log('[Dashboard] raw stats:', statsRaw)
      console.log('[Dashboard] raw trend:', trendRaw)
      console.log('[Dashboard] raw models:', modelsRaw)
      console.log('[Dashboard] raw keys:', keysRaw)

      setRawStats((statsRaw ?? {}) as RawObj)
      setTrend(extractList<RawObj>(trendRaw))
      setModels(extractList<RawObj>(modelsRaw))

      // Handle new shape: { items, names } from dashboard.ts main handler;
      // also handle bare arrays and other wrappers for safety
      const keysObj = (keysRaw ?? {}) as RawObj
      let keysList: RawObj[] = []
      if (Array.isArray(keysObj.items)) keysList = keysObj.items as RawObj[]
      else if (Array.isArray(keysObj.raw)) keysList = keysObj.raw as RawObj[]
      else if (keysObj.raw && typeof keysObj.raw === 'object') keysList = extractList<RawObj>(keysObj.raw)
      else keysList = extractList<RawObj>(keysObj)
      // Also handle the { stats: { id: {...} } } shape directly here
      if (keysList.length === 0 && keysObj.stats && typeof keysObj.stats === 'object' && !Array.isArray(keysObj.stats)) {
        keysList = Object.values(keysObj.stats as Record<string, RawObj>)
      }
      setKeysUsage(keysList)
      setKeyNames((keysObj.names as Record<string, { name: string; platform: string; groupName: string }>) ?? {})

      setRawAll({
        stats: statsRaw,
        trend: trendRaw,
        models: modelsRaw,
        keys: keysRaw
      })
      setLastRefresh(new Date())
    } catch (e) {
      setError((e as Error).message || '加载失败')
    } finally {
      setLoading(false)
    }
  }, [dateParams])

  useEffect(() => { load() }, [load])

  // ── Stats card values ──────────────────────────────────────────────────
  const balance = rawStats.balance as number | undefined

  const todayReqs = pick(rawStats,
    'today_requests', 'today_count', 'request_count',
    'requests', 'total_requests', 'count')

  const todayIn = pick(rawStats,
    'today_input_tokens', 'today_tokens_in', 'input_tokens',
    'prompt_tokens', 'tokens_in')

  const todayOut = pick(rawStats,
    'today_output_tokens', 'today_tokens_out', 'output_tokens',
    'completion_tokens', 'tokens_out')

  const todayTokens = todayIn != null || todayOut != null
    ? (todayIn ?? 0) + (todayOut ?? 0)
    : pick(rawStats, 'today_tokens', 'total_tokens', 'tokens', 'token_count')

  // 实际消费 = total_actual_cost (after discounts/credits)
  const todayCost = pick(rawStats,
    'today_actual_cost', 'total_actual_cost', 'actual_cost',
    'today_cost_actual', 'spend')

  // 原价 = total_cost (list price before discounts)
  const todayCostOrig = pick(rawStats,
    'today_cost', 'total_cost', 'cost',
    'today_original_cost', 'original_cost', 'list_price')

  const cacheRateRaw = pick(rawStats,
    'today_cache_hit_rate', 'cache_hit_rate', 'cache_rate',
    'today_cache_rate', 'hit_rate', 'cache_ratio')
  const cacheRate = normRate(cacheRateRaw)

  // ── Trend chart data ───────────────────────────────────────────────────
  const chartTrend = trend.map(t => {
    const dateStr = (t.date ?? t.day ?? t.time ?? t.created_at ?? '') as string
    const inTok = pick(t,
      'input_tokens', 'tokens_in', 'prompt_tokens',
      'today_input_tokens', 'in_tokens') ?? 0
    const outTok = pick(t,
      'output_tokens', 'tokens_out', 'completion_tokens',
      'today_output_tokens', 'out_tokens') ?? 0
    const totalTok = inTok + outTok || (pick(t, 'tokens', 'total_tokens', 'token_count') ?? 0)
    // 实际消费 = actual_cost / total_actual_cost
    const cost = pick(t,
      'total_actual_cost', 'actual_cost', 'today_actual_cost', 'spend') ?? 0
    // 原价 = cost / total_cost
    const origCost = pick(t,
      'total_cost', 'cost', 'today_cost',
      'original_cost', 'list_price') ?? 0
    const reqs = pick(t, 'requests', 'request_count', 'count', 'total_requests') ?? 0
    return {
      date: fmtDate(dateStr),
      rawDate: dateStr,
      '输入 Token': inTok,
      '输出 Token': outTok,
      'Total Token': totalTok,
      '实际消费': cost,
      '原价': origCost,
      requests: reqs
    }
  })

  // ── Per-key totals for percentage (actual consumption) ────────────────
  const totalKeyCost = keysUsage.reduce((s, k) => {
    return s + (pick(k, 'total_actual_cost', 'actual_cost', 'spend', 'cost') ?? 0)
  }, 0)

  const hasTokenData = chartTrend.some(d => d['输入 Token'] > 0 || d['输出 Token'] > 0 || d['Total Token'] > 0)
  const hasCostData = chartTrend.some(d => d['实际消费'] > 0)

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-border shrink-0 flex-wrap bg-gradient-to-b from-card/40 to-transparent">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold">仪表盘</h1>
          <p className="text-xs text-muted-foreground mt-0.5">查看账户余额、Token 使用和每日消费明细</p>
        </div>

        {/* Date presets */}
        <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1">
          {PRESETS.map(p => (
            <button
              key={p.id}
              onClick={() => {
                setPreset(p.id)
                if (p.id !== 'custom') setShowDatePicker(false)
                else setShowDatePicker(true)
              }}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium transition-all',
                preset === p.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Custom range */}
        {preset === 'custom' && (
          <div className="relative">
            <button
              onClick={() => setShowDatePicker(o => !o)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5"
            >
              <Calendar size={12} />
              {startDate && endDate ? `${startDate} ~ ${endDate}` : '选择日期范围'}
              <ChevronDown size={11} className={showDatePicker ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            {showDatePicker && (
              <div className="absolute top-[calc(100%+6px)] right-0 bg-popover border border-border rounded-xl shadow-xl p-4 z-50 space-y-3 min-w-[280px]">
                <div className="flex items-center gap-3 text-sm">
                  <div className="space-y-1 flex-1">
                    <label className="text-xs text-muted-foreground">开始日期</label>
                    <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="input text-xs w-full" />
                  </div>
                  <span className="text-muted-foreground shrink-0 mt-4">—</span>
                  <div className="space-y-1 flex-1">
                    <label className="text-xs text-muted-foreground">结束日期</label>
                    <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="input text-xs w-full" />
                  </div>
                </div>
                <button onClick={() => { setShowDatePicker(false); load() }} className="btn-primary w-full text-xs py-1.5">
                  应用
                </button>
              </div>
            )}
          </div>
        )}

        <button
          onClick={load}
          disabled={loading}
          title="刷新"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          {lastRefresh
            ? lastRefresh.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
            : '刷新'}
        </button>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">

        {error && (
          <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive flex items-center gap-3">
            <span className="flex-1">{error}</span>
            <button onClick={load} className="underline text-xs shrink-0">重试</button>
          </div>
        )}

        {/* ── Stat cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard icon={Wallet} label="账户余额"
            accent="text-emerald-500" accentBg="bg-emerald-500/10"
            value={balance != null ? `$${balance.toFixed(2)}` : '—'} />
          <StatCard icon={Activity} label="今日请求"
            accent="text-sky-500" accentBg="bg-sky-500/10"
            value={todayReqs != null ? todayReqs.toLocaleString() : '—'}
            sub="次" />
          <StatCard icon={TrendingUp} label="今日消耗"
            accent="text-amber-500" accentBg="bg-amber-500/10"
            value={fmt$(todayCost)}
            sub={todayCostOrig != null ? `原价 ${fmt$(todayCostOrig)}` : undefined} />
          <StatCard icon={Cpu} label="今日 Token"
            accent="text-blue-500" accentBg="bg-blue-500/10"
            value={fmtK(todayTokens)}
            sub={todayIn != null ? `输入 ${fmtK(todayIn)} · 输出 ${fmtK(todayOut)}` : undefined} />
          <StatCard icon={Zap} label="平均缓存率"
            accent="text-violet-500" accentBg="bg-violet-500/10"
            value={fmtPct(cacheRate)} />
        </div>

        {/* ── Two-column: Token + Cost trends ── */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">

        {/* ── Token trend chart ── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-blue-500" />
            <h2 className="text-sm font-semibold">Token 使用趋势</h2>
          </div>
          {loading && trend.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              <RefreshCw size={14} className="animate-spin mr-2" /> 加载中…
            </div>
          ) : chartTrend.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={v => v >= 1000 ? `${(v / 1000).toFixed(0)}K` : String(v)} />
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                {hasTokenData ? (
                  <>
                    <Line type="monotone" dataKey="输入 Token" stroke="hsl(210,80%,56%)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                    <Line type="monotone" dataKey="输出 Token" stroke="hsl(142,76%,46%)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                  </>
                ) : (
                  <Line type="monotone" dataKey="Total Token" stroke="hsl(210,80%,56%)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </section>

        {/* ── Cost trend chart ── */}
        <section className="bg-card border border-border rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp size={14} className="text-amber-500" />
            <h2 className="text-sm font-semibold">消费趋势</h2>
          </div>
          {loading && trend.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
              <RefreshCw size={14} className="animate-spin mr-2" /> 加载中…
            </div>
          ) : chartTrend.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartTrend} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false}
                  tickFormatter={v => `$${v.toFixed(3)}`} />
                <Tooltip content={<CustomTooltip unit="$" />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="实际消费" stroke="hsl(38,92%,50%)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                {hasCostData && chartTrend.some(d => d['原价'] > 0) && (
                  <Line type="monotone" dataKey="原价" stroke="hsl(0,0%,60%)" strokeWidth={1.5} strokeDasharray="4 2" dot={false} activeDot={{ r: 4 }} />
                )}
              </LineChart>
            </ResponsiveContainer>
          )}
        </section>

        </div>

        {/* ── Model bar chart ── */}
        {models.length > 0 && (
          <section className="bg-card border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-sky-500" />
              <h2 className="text-sm font-semibold">模型请求分布</h2>
              <span className="text-xs text-muted-foreground">前 10</span>
            </div>
            <ResponsiveContainer width="100%" height={Math.max(160, Math.min(models.length, 10) * 32 + 32)}>
              <BarChart
                data={models.slice(0, 10).map(m => ({
                  model: (() => {
                    const name = String(m.model ?? m.model_name ?? m.name ?? '')
                    return name.length > 22 ? name.slice(0, 22) + '…' : name
                  })(),
                  请求数: pick(m, 'requests', 'request_count', 'count') ?? 0,
                }))}
                layout="vertical"
                margin={{ top: 0, right: 24, bottom: 0, left: 90 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" strokeOpacity={0.5} horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="model" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={90} />
                <Tooltip />
                <Bar dataKey="请求数" fill="hsl(210,80%,56%)" radius={[0, 3, 3, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </section>
        )}

        {/* ── Daily detail table (always visible) ── */}
        <section className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Calendar size={14} className="text-muted-foreground" />
            <h2 className="text-sm font-semibold">每日明细</h2>
            <span className="text-xs text-muted-foreground ml-auto">{chartTrend.length} 天</span>
          </div>
          {chartTrend.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {loading ? <><RefreshCw size={14} className="animate-spin inline mr-1" /> 加载中…</> : '暂无明细数据'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-5 py-2.5 font-medium">日期</th>
                    <th className="text-right px-5 py-2.5 font-medium">消费金额（实际）</th>
                    <th className="text-right px-5 py-2.5 font-medium">Tokens</th>
                    <th className="text-right px-5 py-2.5 font-medium">请求数</th>
                  </tr>
                </thead>
                <tbody>
                  {[...chartTrend].sort((a, b) => b.rawDate.localeCompare(a.rawDate)).map((row, i) => (
                    <tr key={i} className={cn(
                      'border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors',
                      i % 2 !== 0 && 'bg-muted/10'
                    )}>
                      <td className="px-5 py-2.5 text-xs font-mono text-muted-foreground">{row.date || row.rawDate}</td>
                      <td className="px-5 py-2.5 text-right font-mono text-xs">${(row['实际消费']).toFixed(4)}</td>
                      <td className="px-5 py-2.5 text-right font-mono text-xs">{fmtK(row['Total Token'] || row['输入 Token'] + row['输出 Token'])}</td>
                      <td className="px-5 py-2.5 text-right font-mono text-xs">{row.requests.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── API Key distribution ── */}
        <section className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-5 py-3 border-b border-border flex items-center gap-2">
            <Wallet size={14} className="text-emerald-500" />
            <h2 className="text-sm font-semibold">API Key 消费分布</h2>
            <span className="text-xs text-muted-foreground ml-auto">{keysUsage.length} 个 Key</span>
          </div>
          {keysUsage.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              {loading ? <><RefreshCw size={14} className="animate-spin inline mr-1" /> 加载中…</> : '暂无数据'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left px-5 py-2.5 font-medium">名称</th>
                    <th className="text-right px-5 py-2.5 font-medium">请求数</th>
                    <th className="text-right px-5 py-2.5 font-medium">Tokens</th>
                    <th className="text-right px-5 py-2.5 font-medium">消费（实际）</th>
                    <th className="px-5 py-2.5 font-medium w-36">占比</th>
                  </tr>
                </thead>
                <tbody>
                  {[...keysUsage].sort((a, b) =>
                    (pick(b, 'total_actual_cost', 'actual_cost', 'spend', 'cost') ?? 0) -
                    (pick(a, 'total_actual_cost', 'actual_cost', 'spend', 'cost') ?? 0)
                  ).map((k, i) => {
                    const cost = pick(k, 'total_actual_cost', 'actual_cost', 'spend', 'cost') ?? 0
                    const origCost = pick(k, 'total_cost', 'cost', 'list_price', 'original_cost') ?? 0
                    const inTok = pick(k, 'input_tokens', 'tokens_in', 'prompt_tokens') ?? 0
                    const outTok = pick(k, 'output_tokens', 'tokens_out', 'completion_tokens') ?? 0
                    const tokens = inTok + outTok || (pick(k, 'tokens', 'total_tokens', 'token_count') ?? 0)
                    const reqs = pick(k, 'requests', 'request_count', 'count', 'total_requests') ?? 0
                    const pct = totalKeyCost > 0 ? (cost / totalKeyCost) * 100 : 0
                    const keyId = (k.api_key_id ?? k.key_id ?? k.id) as number | string | undefined
                    const lookup = keyId != null ? keyNames[String(keyId)] : undefined
                    const name = lookup?.name
                      ?? String(k.name ?? k.key_name ?? k.group_name ?? `Key ${keyId ?? i + 1}`)
                    const platform = lookup?.platform ?? (k.platform as string | undefined) ?? ''
                    return (
                      <tr key={i} className={cn(
                        'border-b border-border/40 last:border-0 hover:bg-muted/30 transition-colors',
                        i % 2 !== 0 && 'bg-muted/10'
                      )}>
                        <td className="px-5 py-3 text-sm">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{name}</span>
                            {platform && (
                              <span className="text-[10px] uppercase text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded shrink-0">
                                {platform}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{reqs.toLocaleString()}</td>
                        <td className="px-5 py-3 text-right font-mono text-xs text-muted-foreground">{fmtK(tokens)}</td>
                        <td className="px-5 py-3 text-right font-mono text-xs">
                          <div>${cost.toFixed(4)}</div>
                          {origCost > 0 && origCost !== cost && (
                            <div className="text-[10px] text-muted-foreground/60 line-through">${origCost.toFixed(4)}</div>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 bg-muted rounded-full h-1.5 overflow-hidden">
                              <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs text-muted-foreground w-10 text-right shrink-0">{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Debug panel (collapsed) ── */}
        {Object.keys(rawAll).length > 0 && <DebugPanel data={rawAll} />}

      </div>
    </div>
  )
}
