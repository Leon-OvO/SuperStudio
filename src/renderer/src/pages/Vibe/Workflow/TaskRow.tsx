import { CircleCheck, Circle, Loader2, AlertCircle, MinusCircle } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { VibeTaskInfo } from '../../../../../shared/ipc-types'

interface Props {
  task: VibeTaskInfo
  isStreaming: boolean
  onToggleStatus?: (newStatus: 'pending' | 'done' | 'skipped') => void
}

export function TaskRow({ task, isStreaming, onToggleStatus }: Props) {
  function icon() {
    if (isStreaming || task.status === 'running') return <Loader2 size={12} className="text-blue-500 animate-spin shrink-0" />
    if (task.status === 'done') return <CircleCheck size={12} className="text-emerald-500 shrink-0" />
    if (task.status === 'error') return <AlertCircle size={12} className="text-destructive shrink-0" />
    if (task.status === 'skipped') return <MinusCircle size={12} className="text-muted-foreground/60 shrink-0" />
    return <Circle size={12} className="text-muted-foreground shrink-0" />
  }

  const isDone = task.status === 'done'
  const isSkipped = task.status === 'skipped'

  return (
    <div className="flex items-start gap-2 px-3 py-1.5 text-xs hover:bg-accent/30 rounded group">
      <button
        onClick={() => onToggleStatus?.(
          task.status === 'done' ? 'pending' :
          task.status === 'skipped' ? 'pending' : 'done'
        )}
        title={isDone ? '标记为未完成' : '手动标记完成'}
        className="mt-0.5"
      >
        {icon()}
      </button>
      <div className="flex-1 min-w-0">
        <div className={cn(
          'font-medium',
          (isDone || isSkipped) && 'line-through text-muted-foreground'
        )}>
          <span className="text-muted-foreground/60 mr-1">{task.ord}.</span>
          {task.title}
        </div>
        {task.description && (
          <div className={cn('text-[11px] mt-0.5', isDone ? 'text-muted-foreground/50' : 'text-muted-foreground/80')}>
            {task.description}
          </div>
        )}
        {task.errorText && (
          <div className="text-[11px] text-destructive mt-0.5">⚠️ {task.errorText}</div>
        )}
      </div>
      {!isDone && !isSkipped && onToggleStatus && (
        <button
          onClick={() => onToggleStatus('skipped')}
          className="opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground hover:text-foreground"
          title="跳过此任务"
        >
          跳过
        </button>
      )}
    </div>
  )
}
