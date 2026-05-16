import { useChatStore } from '../../stores/chat'
import { CheckCircle, XCircle, Loader2, ChevronDown, ChevronUp, Film } from 'lucide-react'
import { useState, useEffect } from 'react'
import { cn } from '../../lib/utils'

interface VideoProgressEvent {
  sessionId: string
  jobId: string
  elapsedSeconds: number
  status: 'waiting' | 'done' | 'failed'
}

export function AgentProgress() {
  const { isRunning, currentSteps, activeSessionId } = useChatStore()
  const [expanded, setExpanded] = useState(true)
  const [videoProgress, setVideoProgress] = useState<VideoProgressEvent | null>(null)

  useEffect(() => {
    const unsub = window.api.onVideoProgress((event: unknown) => {
      const e = event as VideoProgressEvent
      if (e.sessionId === activeSessionId) {
        setVideoProgress(e)
      }
    })
    return () => { unsub?.() }
  }, [activeSessionId])

  // Clear video progress when agent stops
  useEffect(() => {
    if (!isRunning) setVideoProgress(null)
  }, [isRunning])

  if (!isRunning && currentSteps.length === 0) return null

  const latestStep = currentSteps[currentSteps.length - 1]

  return (
    <div className="border-t border-border bg-card/50 px-4 py-2">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        {isRunning && <Loader2 size={14} className="animate-spin text-primary shrink-0" />}
        <span className="text-xs text-muted-foreground flex-1 truncate">
          {isRunning && latestStep ? `${latestStep.name}…` : 'Agent 已完成'}
        </span>
        {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
      </div>

      {expanded && (
        <div className="mt-2 space-y-1">
          {currentSteps.map((step, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              {step.status === 'running' && <Loader2 size={12} className="animate-spin text-primary mt-0.5 shrink-0" />}
              {step.status === 'done' && <CheckCircle size={12} className="text-green-500 mt-0.5 shrink-0" />}
              {step.status === 'error' && <XCircle size={12} className="text-destructive mt-0.5 shrink-0" />}
              <div className="flex-1 min-w-0">
                <span className={cn('font-medium', step.status === 'done' && 'text-muted-foreground')}>
                  {step.name}
                </span>
                {step.message && (
                  <span className="ml-1 text-muted-foreground truncate">{step.message}</span>
                )}
                {/* Video polling progress */}
                {step.toolName === 'video_generate' && step.status === 'running' && videoProgress && (
                  <div className="mt-1 flex items-center gap-2">
                    <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-1000"
                        style={{ width: `${Math.min((videoProgress.elapsedSeconds / 600) * 100, 95)}%` }}
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
                        src={`file://${step.artifact.path}`}
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
