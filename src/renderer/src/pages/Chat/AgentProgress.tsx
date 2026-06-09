import { useChatStore } from '../../stores/chat'
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Film } from 'lucide-react'
import { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'
import { ThinkingConsole } from '../../components/ui/ThinkingConsole'
import { scrubAddresses } from '../../../../shared/scrub'
import type { VideoProgressEvent } from '../../../../shared/ipc-types'

/** Real phase of the in-flight assistant turn, derived from its streamed content:
 *  - empty / open <think> block        → still thinking
 *  - visible text after any think block → already streaming the answer
 *  Lets the status say "正在输出回复…" instead of a wrong "正在思考…" during output. */
function isAnswering(content: string): boolean {
  if (!content) return false
  const withoutClosed = content.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, '')
  if (/<(think|thinking|reasoning)>[\s\S]*$/.test(withoutClosed)) return false  // open think → still reasoning
  return withoutClosed.trim().length > 0
}

export function AgentProgress() {
  const { runningSessionIds, stepsBySession, activeSessionId, messages } = useChatStore()
  // Only reflect a run that belongs to the session currently on screen.
  const isRunning = activeSessionId !== null && runningSessionIds.includes(activeSessionId)
  const currentSteps = activeSessionId ? (stepsBySession[activeSessionId] ?? []) : []
  // Latest streamed assistant content → thinking vs answering.
  const sessionMsgs = activeSessionId ? (messages[activeSessionId] ?? []) : []
  const lastMsg = sessionMsgs[sessionMsgs.length - 1]
  const answering = lastMsg?.role === 'assistant' && isAnswering(lastMsg.content || '')
  const [expanded, setExpanded] = useState(true)
  const [videoProgress, setVideoProgress] = useState<VideoProgressEvent | null>(null)
  // Run start (per viewed session) — drives the "已用时" clock + resets the
  // ThinkingConsole buffer when the run (re)starts or the user switches session.
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setStartedAt(isRunning ? Date.now() : undefined)
  }, [isRunning, activeSessionId])

  useEffect(() => {
    const unsub = window.api.onVideoProgress((event: unknown) => {
      const e = event as VideoProgressEvent
      // Chat-initiated video jobs use the sessionId as their clientJobId
      // (video.ts emit() falls back to sessionId when no explicit job id is set).
      if (e.clientJobId === activeSessionId) {
        setVideoProgress(e)
      }
    })
    return () => { unsub?.() }
  }, [activeSessionId])

  // Clear video progress when agent stops
  useEffect(() => {
    if (!isRunning) setVideoProgress(null)
  }, [isRunning])

  // Steps are cleared on run start/stop, so a non-empty list always belongs to
  // the in-flight run. Hide the panel unless that run is the active session's.
  if (!isRunning) return null

  const latestStep = currentSteps[currentSteps.length - 1]

  return (
    <div className="border-t border-border bg-card/50 px-4 py-2">
      {/* Single "is working" indicator — spinner + real elapsed + the latest real
          tool/step line (or an honest "正在思考…" before anything concrete). */}
      <ThinkingConsole
        active={isRunning}
        variant="chat"
        startedAt={startedAt}
        liveLine={latestStep ? scrubAddresses(latestStep.message || latestStep.name) : undefined}
        idleLabel={answering ? '正在输出回复…' : '正在思考…'}
      />

      {/* Expand toggle — only when there's real detail to show. */}
      {currentSteps.length > 0 && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {expanded ? '收起执行详情' : `执行详情（${currentSteps.length} 步）`}
        </button>
      )}

      {expanded && (
        <div className="mt-2 space-y-1">
          {currentSteps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              {step.status === 'running' && <Loader2 size={12} className="animate-spin text-primary mt-0.5 shrink-0" />}
              {step.status === 'done' && <CheckCircle size={12} className="text-green-500 mt-0.5 shrink-0" />}
              {step.status === 'error' && <XCircle size={12} className="text-destructive mt-0.5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <span className={cn('font-medium', step.status === 'done' && 'text-muted-foreground')}>
                  {scrubAddresses(step.name)}
                </span>
                {step.message && (
                  <span className="ml-1 text-muted-foreground truncate">{scrubAddresses(step.message)}</span>
                )}
                {/* Video polling progress */}
                {step.toolName === 'video_generate' && step.status === 'running' && videoProgress && (
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-1000"
                        style={{ width: `${Math.min((videoProgress.elapsedSeconds / Math.max(videoProgress.etaSeconds ?? 600, 1)) * 100, 95)}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground text-[10px] shrink-0">
                      {Math.floor(videoProgress.elapsedSeconds / 60)}:{String(videoProgress.elapsedSeconds % 60).padStart(2, '0')}
                    </span>
                    <Film size={10} className="text-muted-foreground shrink-0" />
                  </div>
                )}
                {step.artifact && (
                  <div className="mt-1">
                    {step.artifact.type === 'image' && (
                      <img
                        // Must use the app's allowlisted local-file:// protocol (raw
                        // file:// is blocked in the renderer) + forward slashes.
                        src={`local-file:///${step.artifact.path.replace(/\\/g, '/').replace(/^\//, '')}`}
                        alt="Generated"
                        className="max-w-[200px] rounded border border-border"
                      />
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
