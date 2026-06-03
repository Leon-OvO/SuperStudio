import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { scrubAddresses } from '../../../../shared/scrub'

export type ThinkingVariant = 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix'

// Canned activity phrases per variant — written constants, so they never carry
// an address. They rotate to keep the log moving even when the backend is quiet
// (e.g. `propose` forces a single tool call and emits no text for 10-30s).
const PHRASES: Record<ThinkingVariant, string[]> = {
  propose: ['读取项目结构…', '理解需求要点…', '拆解任务边界…', '排布执行顺序…', '匹配部门与员工…', '校验任务清单…', '生成方案…'],
  apply:   ['定位相关文件…', '阅读上下文…', '编写代码…', '应用修改…', '运行自检…', '核对改动…'],
  explore: ['检索代码…', '阅读关键文件…', '梳理调用关系…', '归纳结论…'],
  bugfix:  ['复现问题…', '定位可疑代码…', '分析根因…', '修补并验证…'],
  chat:    ['理解你的问题…', '组织思路…', '查阅相关信息…', '正在组织回复…']
}

const MAX_LINES = 4
const TICK_MS = 1000          // elapsed-clock cadence
const PHRASE_EVERY_TICKS = 2  // advance a canned phrase every ~2s

interface Props {
  active: boolean
  variant: ThinkingVariant
  /** Optional real status line (e.g. a tool/step message). Scrubbed + deduped. */
  liveLine?: string
  /** Run start (ms). Changing it resets the buffer + elapsed clock — this is how
   *  a single mounted instance (AgentProgress) avoids bleeding session A's log
   *  into session B. */
  startedAt?: number
  className?: string
}

/** Compact terminal-style "is working" log: a spinner + elapsed time and a
 *  short scrolling buffer of activity lines (canned rotation folded together
 *  with any real status). Reuses the existing `.office-type` blink for the
 *  cursor (already covered by prefers-reduced-motion in globals.css). */
export function ThinkingConsole({ active, variant, liveLine, startedAt, className }: Props) {
  const [lines, setLines] = useState<string[]>([])
  const [elapsed, setElapsed] = useState(0)
  const phrasesRef = useRef<string[]>(PHRASES[variant] ?? PHRASES.chat)
  phrasesRef.current = PHRASES[variant] ?? PHRASES.chat
  const phraseIdxRef = useRef(0)
  const startRef = useRef<number>(startedAt ?? Date.now())

  // Reset on (re)start or variant change — seed with the first phrase so the
  // log is never empty.
  useEffect(() => {
    startRef.current = startedAt ?? Date.now()
    phraseIdxRef.current = 0
    setElapsed(0)
    setLines([phrasesRef.current[0]])
  }, [startedAt, variant])

  // One interval drives both the elapsed clock and the phrase rotation.
  useEffect(() => {
    if (!active) return
    let n = 0
    const id = setInterval(() => {
      n++
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
      if (n % PHRASE_EVERY_TICKS === 0) {
        const list = phrasesRef.current
        phraseIdxRef.current = (phraseIdxRef.current + 1) % list.length
        const next = list[phraseIdxRef.current]
        setLines(prev => (prev[prev.length - 1] === next ? prev : [...prev, next].slice(-MAX_LINES)))
      }
    }, TICK_MS)
    return () => clearInterval(id)
  }, [active])

  // Fold a real status line into the same buffer (scrubbed of addresses + deduped).
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
      {lines.map((ln, i) => {
        const last = i === lines.length - 1
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
