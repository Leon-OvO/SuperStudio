import { useEffect, useState, useMemo } from 'react'
import { Plus, Play, Pencil, Trash2, CheckCircle2, XCircle, MoonStar, Clock, Bot, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { Switch } from '../../components/ui/Switch'
import type { ScheduledTask } from '../../../../shared/ipc-types'
import { scheduleLabel, formatNextFire } from './scheduleLabel'
import { TEMPLATES, type ScheduledTaskTemplate } from './templates'
import { useScheduledNotifications } from '../../stores/scheduledNotifications'
import { useT } from '../../lib/i18n'

interface Props {
  onEdit: (task: ScheduledTask | null, fromTemplate?: ScheduledTaskTemplate) => void
  onOpenDetail: (taskId: string) => void
  onOpenBots: () => void
}

const MAX_TASKS = 20

export function TaskList({ onEdit, onOpenDetail, onOpenBots }: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [lastStatus, setLastStatus] = useState<Record<string, string>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const unreadMap = useScheduledNotifications(s => s.unread)
  const clearUnread = useScheduledNotifications(s => s.clear)
  const dlg = useConfirmDialog()
  const t = useT()

  async function refresh() {
    try {
      const list = await window.api.listScheduledTasks()
      setTasks(list)
      // For each task, fetch latest run status to show badge.
      const statusMap: Record<string, string> = {}
      await Promise.all(list.map(async t => {
        try {
          const runs = await window.api.listScheduledTaskRuns(t.id, 1)
          if (runs[0]) statusMap[t.id] = runs[0].status
        } catch { /* ignore per-task fetch errors */ }
      }))
      setLastStatus(statusMap)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [])

  // Live run state: a "running" indicator while a task is mid-run, and a refresh
  // when it completes so the status badge + next-fire update immediately.
  useEffect(() => {
    const offStart = window.api.onScheduledRunStarted?.(e => {
      setRunning(r => ({ ...r, [e.taskId]: true }))
    })
    const offDone = window.api.onScheduledRunCompleted(e => {
      setRunning(r => ({ ...r, [e.taskId]: false }))
      refresh()
    })
    return () => { offStart?.(); offDone() }
  }, [])

  async function handleToggle(task: ScheduledTask) {
    try {
      await window.api.setScheduledTaskEnabled(task.id, !task.enabled)
      await refresh()
    } catch (e) {
      toast.error('切换失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  async function handleDelete(task: ScheduledTask) {
    const ok = await dlg.confirm({
      title: '删除任务',
      message: `确定删除「${task.name}」？专属对话、消息记录、历史执行记录都会一并删除，无法恢复。`,
      confirmLabel: '删除',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await window.api.deleteScheduledTask(task.id)
      toast.success('已删除')
      await refresh()
    } catch (e) {
      toast.error('删除失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  async function handleTriggerNow(task: ScheduledTask) {
    // Optimistic "running" so the user gets instant feedback even before the
    // RUN_STARTED event lands; cleared by RUN_COMPLETED (or on error).
    setRunning(r => ({ ...r, [task.id]: true }))
    try {
      await window.api.triggerScheduledTaskNow(task.id)
      toast.success(`已触发「${task.name}」`)
    } catch (e) {
      setRunning(r => ({ ...r, [task.id]: false }))
      toast.error('触发失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  const atLimit = tasks.length >= MAX_TASKS

  const emptyState = useMemo(() => tasks.length === 0 && !loading, [tasks, loading])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-foreground">{t('sched.title')}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            到点自动跑一段 prompt，结果写进专属对话。{tasks.length}/{MAX_TASKS}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onOpenBots}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="配置通知机器人（钉钉 / 飞书 / 企业微信）"
          >
            <Bot size={13} />
            {t('sched.notifyBots')}
          </button>
          <button
            onClick={() => atLimit ? toast.error('最多 20 个任务。删除或暂停一些再试。') : onEdit(null)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
              atLimit
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-primary text-primary-foreground hover:opacity-90 active:scale-95 shadow-sm'
            )}
            title={atLimit ? '最多 20 个任务。删除或暂停一些再试。' : '新建任务'}
          >
            <Plus size={13} />
            {t('sched.newTask')}
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground py-12">{t('sched.loading')}</p>
        ) : emptyState ? (
          <EmptyState onPick={tpl => onEdit(null, tpl)} />
        ) : (
          <div className="space-y-2">
            {tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                lastStatus={lastStatus[task.id]}
                running={!!running[task.id]}
                unread={!!unreadMap[task.id]}
                onToggle={() => handleToggle(task)}
                onDelete={() => handleDelete(task)}
                onEdit={() => onEdit(task)}
                onOpen={() => { clearUnread(task.id); onOpenDetail(task.id) }}
                onTriggerNow={() => handleTriggerNow(task)}
              />
            ))}
          </div>
        )}
      </div>

      {dlg.element}
    </div>
  )
}

function TaskCard({
  task, lastStatus, running, unread, onToggle, onDelete, onEdit, onOpen, onTriggerNow
}: {
  task: ScheduledTask
  lastStatus?: string
  running: boolean
  unread: boolean
  onToggle: () => void
  onDelete: () => void
  onEdit: () => void
  onOpen: () => void
  onTriggerNow: () => void
}) {
  const t = useT()
  // A disabled one-shot that already fired = "done", not "paused".
  const onceDone = !task.enabled && task.scheduleKind === 'once' && !!task.lastFiredAt
  return (
    <div
      className={cn(
        'group flex items-center gap-3 px-4 py-3 rounded-lg border bg-card hover:border-primary/50 transition-all cursor-pointer',
        !task.enabled && !running && 'opacity-60',
        running && 'border-primary/60'
      )}
      onClick={onOpen}
    >
      {/* Status indicator */}
      <div className="shrink-0">
        {running
          ? <Loader2 size={18} className="text-primary animate-spin" />
          : !task.enabled
            ? (onceDone ? <CheckCircle2 size={18} className="text-emerald-500" /> : <MoonStar size={18} className="text-muted-foreground" />)
            : lastStatus === 'failed'
              ? <XCircle size={18} className="text-destructive" />
              : lastStatus === 'success'
                ? <CheckCircle2 size={18} className="text-emerald-500" />
                : <Clock size={18} className="text-primary" />
        }
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">{task.name}</span>
          {unread && (
            <span
              className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"
              title="有未读的执行结果"
            />
          )}
          {running && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">运行中…</span>
          )}
          {!task.enabled && !running && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {onceDone ? '已完成' : t('sched.paused')}
            </span>
          )}
          {task.consecutiveFailures >= 3 && task.enabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
              连续失败 {task.consecutiveFailures} 次
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
          <span>{scheduleLabel(task.scheduleKind, task.scheduleValue)}</span>
          {task.enabled && (
            <span>下次：{formatNextFire(task.nextFireAt)}</span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
        <button
          onClick={onTriggerNow}
          title="立即运行一次"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Play size={13} />
        </button>
        <Switch
          size="sm"
          checked={!!task.enabled}
          onChange={() => onToggle()}
          title={task.enabled ? '点击暂停' : '点击启用'}
          className="mx-1"
        />
        <button
          onClick={onEdit}
          title="编辑"
          className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={onDelete}
          title="删除"
          className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (tpl: ScheduledTaskTemplate) => void }) {
  const t = useT()
  return (
    <div className="max-w-2xl mx-auto py-8">
      <div className="text-center mb-6">
        <h2 className="text-base font-medium text-foreground">{t('sched.startFromTemplate')}</h2>
        <p className="text-xs text-muted-foreground mt-1">选一个常用场景，自动填好 prompt 和时间。也可直接「新建任务」从零开始。</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {TEMPLATES.map(tpl => (
          <button
            key={tpl.id}
            onClick={() => onPick(tpl)}
            className="text-left p-4 rounded-lg border border-border bg-card hover:border-primary/50 hover:shadow-sm transition-all"
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xl">{tpl.icon}</span>
              <span className="text-sm font-medium text-foreground">{tpl.name}</span>
            </div>
            <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">{tpl.prompt}</p>
            <p className="text-[10px] text-primary mt-2">
              {scheduleLabel(tpl.scheduleKind, tpl.scheduleValue)}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}
