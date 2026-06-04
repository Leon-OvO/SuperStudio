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
}

/** Compact terminal-style "is working" indicator: a spinner + REAL elapsed time
 *  and a short buffer of REAL activity lines (tool/step messages). When nothing
 *  concrete has happened yet it shows a single honest phase label — never
 *  fabricated activity. */
export function ThinkingConsole({ active, variant, liveLine, startedAt, className, idleLabel }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef<number>(startedAt ?? Date.now())

  // Reset on (re)start or variant change.
  useEffect(() => {
    startRef.current = startedAt ?? Date.now()
    setElapsed(0)
    setLines([])
  }, [startedAt, variant])

  // Elapsed clock only — no fabricated phrase rotation.
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), TICK_MS)
    return () => clearInterval(id)
  }, [active])

  // Fold each REAL status line into the buffer (scrubbed of addresses + deduped).
  useEffect(() => {
    if (!active || !liveLine) return
    const clean = scrubAddresses(liveLine).trim()
    if (!clean) return
    setLines(prev => (prev[prev.length - 1] === clean ? prev : [...prev, clean].slice(-MAX_LINES)))
  }, [liveLine, active])

  if (!active) return null

  const mm = Math.floor(elapsed / 60)
  const ss = elapsed % 60
  const elapsedLabel = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`
  // No real activity yet → one honest phase label (the model IS working; we just
  // don't fabricate what it's doing). `idleLabel={null}` suppresses it when a
  // surrounding banner already states the phase.
  const fallback = idleLabel === undefined ? (PHASE_LABEL[variant] ?? PHASE_LABEL.chat) : idleLabel
  const shown = lines.length ? lines : (fallback ? [fallback] : [])

  return (
    <div className={cn(
      'rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed',
      className
    )}>
      <div className="flex items-center gap-1.5 text-muted-foreground/70 mb-0.5">
        <Loader2 size={10} className="animate-spin text-primary shrink-0" />
        <span className="text-[10px]">运行中</span>
        <span className="ml-auto tabular-nums text-[10px]">已用时 {elapsedLabel}</span>
      </div>
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
