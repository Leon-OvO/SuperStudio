import { CircleCheck, Circle, Loader2, AlertCircle, MinusCircle } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { Select } from '../../../components/ui/Select'
import type { VibeTaskInfo, EmployeeInfo } from '../../../../../shared/ipc-types'

interface Props {
  task: VibeTaskInfo
  isStreaming: boolean
  onToggleStatus?: (newStatus: 'pending' | 'done' | 'skipped') => void
  /** Hired employees, for the per-task assignee dropdown. */
  employees?: EmployeeInfo[]
  /** Reassign this task to an employee (null = unassign → falls back to request/default). */
  onReassign?: (employeeId: string | null) => void
  /** Revert ONLY this task's file changes (restore to the pre-apply snapshot, keeping other tasks' work). */
  onRevertTask?: (taskId: string) => void
  /** Disable reassign while a run is in flight. */
  disabled?: boolean
}

export function TaskRow({ task, isStreaming, onToggleStatus, employees, onReassign, onRevertTask, disabled }: Props) {
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
      {onReassign && employees && (
        <Select
          value={task.assigneeEmployeeId ?? ''}
          onChange={v => onReassign(v || null)}
          disabled={disabled}
          title="承接此子任务的员工（用其模型+人格执行）"
          className="shrink-0 mt-0.5 max-w-[110px]"
          options={[
            { value: '', label: '默认' },
            ...employees.map(e => ({ value: e.id, label: e.name })),
            ...(task.assigneeEmployeeId && !employees.some(e => e.id === task.assigneeEmployeeId)
              ? [{ value: task.assigneeEmployeeId, label: '（已离职）' }] : [])
          ]}
        />
      )}
      {!isDone && !isSkipped && onToggleStatus && (
        <button
          onClick={() => onToggleStatus('skipped')}
          className="opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground hover:text-foreground"
          title="跳过此任务"
        >
          跳过
        </button>
      )}
      {isDone && onRevertTask && (task.revertFileCount ?? 0) > 0 && !isStreaming && (
        <button
          onClick={() => onRevertTask(task.id)}
          className="opacity-0 group-hover:opacity-100 text-[10px] text-muted-foreground hover:text-destructive shrink-0"
          title={`撤销此任务改动：还原它改过的 ${task.revertFileCount} 个文件到执行前，保留其他任务的成果`}
        >
          撤销
        </button>
      )}
    </div>
  )
}
