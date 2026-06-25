import { ipcMain } from 'electron'
import {
  IPC,
  type UsageRange,
  type UsageCustomRange,
  type UsageStats,
  type UsageLogRow,
  type UsageTrendBucket,
  type UsageGroupRow,
} from '../../../src/shared/ipc-types'
import { dbAll } from '../db/sqlite'

// How many request rows to ship to the renderer for the 请求日志 table. Summary
// / trend / per-provider / per-model aggregates are computed from the FULL set;
// only the raw row list is capped (the table is virtualization-free).
const LOG_CAP = 1000

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfToday(): number {
  return startOfDay(Date.now())
}

function rangeSince(range: UsageRange): number {
  const now = Date.now()
  switch (range) {
    case 'today': return startOfToday()
    case 'last7d': return now - 7 * 86_400_000
    case 'last30d': return now - 30 * 86_400_000
    case 'all': return 0
    default: return startOfToday()
  }
}

/** Resolve the half-open [since, until) epoch window a request covers. For
 *  'custom', start snaps to 00:00 of its day and end extends to 24:00 of its day
 *  (so the end date is fully inclusive); reversed dates are normalized. */
function resolveWindow(range: UsageRange, custom?: UsageCustomRange): { since: number; until: number } {
  if (range === 'custom') {
    let startDay = custom?.start != null ? startOfDay(custom.start) : null
    let endDay = custom?.end != null ? startOfDay(custom.end) : null
    if (startDay != null && endDay != null && startDay > endDay) {
      const t = startDay; startDay = endDay; endDay = t
    }
    return {
      since: startDay ?? 0,
      until: endDay != null ? endDay + 86_400_000 : UNBOUNDED,
    }
  }
  return { since: rangeSince(range), until: UNBOUNDED }
}

// Internal normalized shape — one per assistant message that carries usage.
interface Rec {
  ts: number
  source: string
  provider: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number | null
  durationMs: number | null
  status: UsageLogRow['status']
}

function hasUsage(r: Rec): boolean {
  return r.input > 0 || r.output > 0 || r.cacheRead > 0 || r.cacheWrite > 0 || (r.cost ?? 0) > 0
}

interface MsgRow {
  created_at: number
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  meta: string | null
  speaker_employee_id: string | null
  groupEmployeeIds: string | null
}

interface VibeRow {
  created_at: number
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
  is_error: number | null
}

function collectRecords(since: number, until: number): Rec[] {
  const out: Rec[] = []

  // ── Chat + group-chat: messages table ──────────────────────────────────
  const msgRows = dbAll<MsgRow>(
    `SELECT m.created_at, m.model, m.input_tokens, m.output_tokens, m.cost_usd, m.meta,
            m.speaker_employee_id AS speaker_employee_id,
            s.group_employee_ids  AS groupEmployeeIds
       FROM messages m
       LEFT JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'assistant' AND m.created_at >= ? AND m.created_at < ?`,
    [since, until]
  )
  for (const m of msgRows) {
    let meta: Record<string, unknown> = {}
    if (m.meta) { try { meta = JSON.parse(m.meta) as Record<string, unknown> } catch { /* malformed → {} */ } }
    const debug = (meta.debug ?? {}) as Record<string, unknown>
    const isGroup = !!m.groupEmployeeIds || !!m.speaker_employee_id
    const status: UsageLogRow['status'] =
      debug.streamErr ? 'error' : (meta.incomplete ? 'partial' : 'ok')
    out.push({
      ts: m.created_at,
      source: isGroup ? '群聊' : '对话',
      provider: (meta.providerName as string) || (meta.providerId as string) || '—',
      model: m.model || (meta.model as string) || '—',
      input: num(m.input_tokens),
      output: num(m.output_tokens),
      cacheRead: num(meta.cacheReadTokens),
      cacheWrite: num(meta.cacheWriteTokens),
      cost: typeof m.cost_usd === 'number' && Number.isFinite(m.cost_usd) ? m.cost_usd : null,
      durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
      status,
    })
  }

  // ── Workbench: vibe_messages table (no meta JSON → no cache/provider) ───
  const vibeRows = dbAll<VibeRow>(
    `SELECT created_at, model, input_tokens, output_tokens, cost_usd, is_error
       FROM vibe_messages
      WHERE role = 'assistant' AND created_at >= ? AND created_at < ?`,
    [since, until]
  )
  for (const v of vibeRows) {
    out.push({
      ts: v.created_at,
      source: '工作台',
      provider: '—',
      model: v.model || '—',
      input: num(v.input_tokens),
      output: num(v.output_tokens),
      cacheRead: 0,
      cacheWrite: 0,
      cost: typeof v.cost_usd === 'number' && Number.isFinite(v.cost_usd) ? v.cost_usd : null,
      durationMs: null,
      status: v.is_error ? 'error' : 'ok',
    })
  }

  return out.filter(hasUsage).sort((a, b) => b.ts - a.ts)
}

function buildTrend(records: Rec[], opts: { since: number; until: number; range: UsageRange }): UsageTrendBucket[] {
  const now = Date.now()
  const spanEnd = Math.min(opts.until, now)
  // The lower edge is "open" for 'all' AND for a custom range whose start was left
  // blank (resolveWindow returns since≈0). In both cases derive the visible start
  // from the earliest record — never seed empty buckets back to 1970. reduce, not
  // Math.min(...spread), so a 100k+ row history can't blow the argument-count limit.
  const openLower = opts.range === 'all' || opts.since <= 0
  const earliest = records.length ? records.reduce((m, r) => (r.ts < m ? r.ts : m), spanEnd) : spanEnd
  const spanStart = openLower ? earliest : opts.since

  // Bucket granularity: hourly only when the window is short enough to read.
  const hourly = opts.range === 'today'
    ? true
    : openLower
      ? false
      : (spanEnd - spanStart) <= 48 * 3_600_000   // last7d/30d → daily; bounded custom → span-based

  // Disambiguate labels when the window straddles >1 calendar day (hourly) or >1
  // calendar year (daily), else recharts renders duplicate category ticks.
  const pad = (n: number) => String(n).padStart(2, '0')
  const multiDay = new Date(spanStart).setHours(0, 0, 0, 0) !== new Date(spanEnd).setHours(0, 0, 0, 0)
  const multiYear = new Date(spanStart).getFullYear() !== new Date(spanEnd).getFullYear()
  const keyOf = (ts: number): { sort: number; label: string } => {
    const d = new Date(ts)
    if (hourly) {
      d.setMinutes(0, 0, 0)
      const hhmm = `${pad(d.getHours())}:00`
      return { sort: d.getTime(), label: multiDay ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}` : hhmm }
    }
    d.setHours(0, 0, 0, 0)
    const mmdd = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    return { sort: d.getTime(), label: multiYear ? `${d.getFullYear()}-${mmdd}` : mmdd }
  }

  const buckets = new Map<number, UsageTrendBucket>()

  // Seed empty buckets across an explicit, bounded lower edge so the area chart
  // spans the whole window (the "flat → peaks" shape). Skipped when the lower edge
  // is open — there the actual records (added below) drive the buckets.
  if (!openLower && spanEnd >= spanStart) {
    const step = hourly ? 3_600_000 : 86_400_000
    let cur = keyOf(spanStart).sort
    const last = keyOf(spanEnd).sort
    let guard = 0
    while (cur <= last && guard++ < 2000) {   // guard caps absurdly wide custom spans
      const { sort, label } = keyOf(cur)
      if (!buckets.has(sort)) buckets.set(sort, { label, tokens: 0, cost: 0 })
      cur += step
    }
  }

  for (const r of records) {
    const { sort, label } = keyOf(r.ts)
    let b = buckets.get(sort)
    if (!b) { b = { label, tokens: 0, cost: 0 }; buckets.set(sort, b) }
    b.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
    b.cost += r.cost ?? 0
  }

  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)
}

function groupBy(records: Rec[], pick: (r: Rec) => string): UsageGroupRow[] {
  const map = new Map<string, UsageGroupRow>()
  for (const r of records) {
    const key = pick(r) || '—'
    let g = map.get(key)
    if (!g) { g = { key, requests: 0, tokens: 0, cost: 0 }; map.set(key, g) }
    g.requests += 1
    g.tokens += r.input + r.output + r.cacheRead + r.cacheWrite
    g.cost += r.cost ?? 0
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 30)
}

function computeStats(range: UsageRange, custom?: UsageCustomRange): UsageStats {
  const { since, until } = resolveWindow(range, custom)
  const records = collectRecords(since, until)

  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0
  for (const r of records) {
    input += r.input; output += r.output
    cacheRead += r.cacheRead; cacheWrite += r.cacheWrite
    cost += r.cost ?? 0
  }
  const totalTokens = input + output + cacheRead + cacheWrite
  const cacheDenom = cacheRead + cacheWrite + input
  const cacheHitRate = cacheDenom > 0 ? cacheRead / cacheDenom : 0

  return {
    range,
    generatedAt: Date.now(),
    summary: { requests: records.length, input, output, cacheWrite, cacheRead, totalTokens, cost, cacheHitRate },
    trend: buildTrend(records, { since, until, range }),
    byProvider: groupBy(records, r => r.provider),
    byModel: groupBy(records, r => r.model),
    log: records.slice(0, LOG_CAP),
    logTruncated: records.length > LOG_CAP,
  }
}

const VALID_RANGES: ReadonlySet<UsageRange> = new Set<UsageRange>(['today', 'last7d', 'last30d', 'all', 'custom'])

export function usageHandlers(): void {
  ipcMain.handle(IPC.USAGE_STATS, (_e, range: UsageRange = 'today', custom?: UsageCustomRange) => {
    try {
      const safe = VALID_RANGES.has(range) ? range : 'today'
      return computeStats(safe, custom)
    } catch (e) {
      console.error('[usage] stats failed:', (e as Error)?.message ?? e)
      const empty: UsageStats = {
        range: 'today',
        generatedAt: Date.now(),
        summary: { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, totalTokens: 0, cost: 0, cacheHitRate: 0 },
        trend: [], byProvider: [], byModel: [], log: [], logTruncated: false,
      }
      return empty
    }
  })
}
