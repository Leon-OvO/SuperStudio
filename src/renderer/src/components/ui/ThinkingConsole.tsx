import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { scrubAddresses } from '../../../../shared/scrub'

export type ThinkingVariant = 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix'

// ONE honest phase label per variant — a truthful statement of the current
// stage, shown only until real activity arrives. We deliberately do NOT rotate
// fabricated sub-steps ("组织思路…","查阅相关信息…") any more: those were fake and
// misleading. Real tool/step lines (liveLine) and the streamed answer/reasoning
// are the actual process; this label is just a placeholder while the model is
// genuinely working but hasn't emitted anything concrete yet.
const PHASE_LABEL: Record<ThinkingVariant, string> = {
  propose: '正在拆解需求…',
  apply:   '正在执行任务…',
  explore: '正在分析…',
  chat:    '正在思考…',
  bugfix:  '正在排查…'
}

const MAX_LINES = 4
const TICK_MS = 1000  // elapsed-clock cadence

interface Props {
  active: boolean
  variant: ThinkingVariant
  /** Real status line (a tool/step message). Scrubbed + deduped into the buffer. */
  liveLine?: string
  /** Run start (ms). Changing it resets the buffer + elapsed clock — this is how
   *  a single mounted instance (AgentProgress) avoids bleeding session A's log
   *  into session B. */
  startedAt?: number
  className?: string
  /** Honest placeholder shown when there's no real activity yet. Defaults to the
   *  variant's phase label. Pass `null` to suppress it entirely — use that when a
   *  richer status banner already states the phase (avoids a duplicate "思考中"). */
  idleLabel?: string | null
  /** Live coarse phase from the engine (等待响应 / 思考 / 执行 X / 输出中). When set it
   *  becomes the honest headline + drives a per-phase sub-clock. */
  phaseLabel?: string
  /** Unix ms when the current phase began — drives the per-phase clock. */
  phaseStartedAt?: number
  /** Health of the current phase — turns the indicator amber as a model slows /
   *  approaches the stall timeout. */
  phaseStatus?: 'ok' | 'slow' | 'timeout-soon'
}

/** Compact terminal-style "is working" indicator: a spinner + REAL elapsed time
 *  and a short buffer of REAL activity lines (tool/step messages). When nothing
 *  concrete has happened yet it shows a single honest phase label — never
 *  fabricated activity. The engine's live phase (when provided) becomes the
 *  headline with its own sub-clock + a pre-timeout warning. */
export function ThinkingConsole({ active, variant, liveLine, startedAt, className, idleLabel, phaseLabel, phaseStartedAt, phaseStatus }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [phaseElapsed, setPhaseElapsed] = useState(0)
  const startRef = useRef<number>(startedAt ?? Date.now())

  // Reset on (re)start or variant change.
  useEffect(() => {
    startRef.current = startedAt ?? Date.now()
    setElapsed(0)
    setLines([])
  }, [startedAt, variant])

  // Elapsed clock only — no fabricated phrase rotation. Also ticks the per-phase
  // sub-clock off phaseStartedAt so a long single phase reads as live, not frozen.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
      if (phaseStartedAt) setPhaseElapsed(Math.max(0, Math.floor((Date.now() - phaseStartedAt) / 1000)))
    }, TICK_MS)
    return () => clearInterval(id)
  }, [active, phaseStartedAt])

  // Recompute the phase clock immediately when the phase changes.
  useEffect(() => {
    setPhaseElapsed(phaseStartedAt ? Math.max(0, Math.floor((Date.now() - phaseStartedAt) / 1000)) : 0)
  }, [phaseStartedAt])

  // Fold each REAL status line into the buffer (scrubbed of addresses + deduped).
  useEffect(() => {
    if (!active || !liveLine) return
    const clean = scrubAddresses(liveLine).trim()
    if (!clean) return
    setLines(prev => (prev[prev.length - 1] === clean ? prev : [...prev, clean].slice(-MAX_LINES)))
  }, [liveLine, active])

  if (!active) return null

  const fmt = (sec: number): string => {
    const mm = Math.floor(sec / 60)
    const ss = sec % 60
    return mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`
  }
  const elapsedLabel = fmt(elapsed)
  const warn = phaseStatus === 'slow' || phaseStatus === 'timeout-soon'
  // No real activity yet → one honest phase label (the model IS working; we just
  // don't fabricate what it's doing). `idleLabel={null}` suppresses it when a
  // surrounding banner already states the phase. The live engine phase wins.
  const fallback = idleLabel === undefined ? (PHASE_LABEL[variant] ?? PHASE_LABEL.chat) : idleLabel
  const headline = phaseLabel ?? (lines.length ? undefined : fallback)
  const shown = lines.length ? lines : (fallback && !phaseLabel ? [fallback] : [])

  return (
    <div className={cn(
      'rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed',
      warn ? 'border-amber-400/60 bg-amber-400/[0.06]' : 'border-border/60',
      className
    )}>
      <div className={cn('flex items-center gap-1.5 mb-0.5', warn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/70')}>
        <Loader2 size={10} className={cn('animate-spin shrink-0', warn ? 'text-amber-500' : 'text-primary')} />
        {/* Heartbeat dot — proves "still alive" even during a long silent phase. */}
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0 animate-pulse', warn ? 'bg-amber-500' : 'bg-primary/70')} />
        <span className="text-[10px] truncate">{headline ?? '运行中'}</span>
        {phaseLabel && phaseStartedAt != null && (
          <span className="tabular-nums text-[10px] opacity-70">· {fmt(phaseElapsed)}</span>
        )}
        <span className="ml-auto tabular-nums text-[10px] shrink-0">已用时 {elapsedLabel}</span>
      </div>
      {phaseStatus === 'timeout-soon' && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400 mb-0.5">即将超时——可点「停止」后重试，或检查模型 / 网络代理。</div>
      )}
      {shown.map((ln, i) => {
        const last = i === shown.length - 1
        return (
          <div key={i} className={cn('truncate', last ? 'text-foreground/80' : 'text-muted-foreground/45')}>
            <span className="text-primary/60 mr-1">›</span>
            {ln}
            {last && <span className="office-type ml-0.5 text-primary">▍</span>}
          </div>
        )
      })}
    </div>
  )
}
