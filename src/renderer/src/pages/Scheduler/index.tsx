import { useEffect, useState } from 'react'
import type { ScheduledTask } from '../../../../shared/ipc-types'
import { TaskList } from './TaskList'
import { TaskForm } from './TaskForm'
import { TaskDetail } from './TaskDetail'
import { BotsManager } from './BotsManager'
import type { ScheduledTaskTemplate } from './templates'

type View =
  | { kind: 'list' }
  | { kind: 'form'; task: ScheduledTask | null; fromTemplate?: ScheduledTaskTemplate }
  | { kind: 'detail'; taskId: string }
  | { kind: 'bots' }

export function SchedulerPage() {
  const [view, setView] = useState<View>({ kind: 'list' })

  // Notification-click bridge: App.tsx forwards SCHEDULER_FOCUS_TASK as a DOM
  // event so we can jump straight into the task's detail view.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ taskId?: string }>).detail
      if (detail?.taskId) setView({ kind: 'detail', taskId: detail.taskId })
    }
    window.addEventListener('app:scheduler-open-task', onOpen)
    return () => window.removeEventListener('app:scheduler-open-task', onOpen)
  }, [])

  if (view.kind === 'form') {
    return (
      <TaskForm
        task={view.task}
        fromTemplate={view.fromTemplate}
        onBack={() => setView({ kind: 'list' })}
        onSaved={(saved) => setView({ kind: 'detail', taskId: saved.id })}
      />
    )
  }

  if (view.kind === 'detail') {
    return (
      <TaskDetail
        taskId={view.taskId}
        onBack={() => setView({ kind: 'list' })}
        onEdit={(t) => setView({ kind: 'form', task: t })}
      />
    )
  }

  if (view.kind === 'bots') {
    return <BotsManager onBack={() => setView({ kind: 'list' })} />
  }

  return (
    <TaskList
      onEdit={(task, fromTemplate) => setView({ kind: 'form', task, fromTemplate })}
      onOpenDetail={(taskId) => setView({ kind: 'detail', taskId })}
      onOpenBots={() => setView({ kind: 'bots' })}
    />
  )
}
