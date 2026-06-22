/**
 * Token + USD cost formatting helpers shared by Chat and Vibe message UIs.
 * Cost is in USD; tokens are raw counts.
 */

/**
 * Display tokens compactly: 12345 → "12.3k", 950 → "950".
 */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * Display a USD cost. Picks digits so tiny amounts ($0.000012) and big amounts
 * ($12.34) both read sensibly.
 */
export function formatCostUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.0001) return `<$0.0001`
  if (usd < 0.01)  return `$${usd.toFixed(4)}`
  if (usd < 1)     return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Treat null / undefined / NaN / non-finite as "no data". */
function realNumber(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return n
}

/**
 * "1.2k → 3.4k tok · 缓存 8.1k · $0.0023" — one-line summary for a single LLM
 * exchange. The "缓存 Xk" segment is the prompt-cache HIT (cacheRead) tokens — it
 * makes caching visible so you can tell it's actually working. Returns null when
 * there's nothing meaningful to show (the provider didn't report usage, or every
 * value is NaN/0).
 */
export function formatUsageLine(args: {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  costUsd?: number | null
}): string | null {
  const inTok = realNumber(args.inputTokens)
  const outTok = realNumber(args.outputTokens)
  const cacheRead = realNumber(args.cacheReadTokens)
  const cost = realNumber(args.costUsd)
  // Treat all-zero as missing too — providers that don't track usage often
  // return zeros rather than nulls, and "0 → 0 tok · $0" is just noise.
  const hasTokens = (inTok != null && inTok > 0) || (outTok != null && outTok > 0)
  const hasCache = cacheRead != null && cacheRead > 0
  const hasCost = cost != null && cost > 0
  if (!hasTokens && !hasCost) return null
  const parts: string[] = []
  if (hasTokens) parts.push(`${formatTokens(inTok)} → ${formatTokens(outTok)} tok`)
  if (hasCache)  parts.push(`缓存 ${formatTokens(cacheRead)}`)
  if (hasCost)   parts.push(formatCostUsd(cost))
  return parts.join(' · ')
}
