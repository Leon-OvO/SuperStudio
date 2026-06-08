import { Fragment, useEffect, useState } from 'react'
import { ArrowLeft, Play, Pencil, Trash2, CheckCircle2, XCircle, MoonStar, MessageSquare, History, Info, Loader2, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { formatCostUsd } from '../../lib/format-cost'
import type { ScheduledTask, ScheduledTaskRun, Message } from '../../../../shared/ipc-types'
import { scheduleLabel, formatTimestamp } from './scheduleLabel'
import { MessageList } from '../Chat/MessageList'
import { ImageEditor } from '../../components/ui/ImageEditor'
import { useScheduledNotifications } from '../../stores/scheduledNotifications'

interface Props {
  taskId: string
  onBack: () => void
  onEdit: (task: ScheduledTask) => void
}

type Tab = 'chat' | 'runs' | 'info'

export function TaskDetail({ taskId, onBack, onEdit }: Props) {
  const [task, setTask] = useState<ScheduledTask | null>(null)
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('chat')
  const [editorSrc, setEditorSrc] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const clearUnread = useScheduledNotifications(s => s.clear)
  const dlg = useConfirmDialog()

  async function refresh() {
    try {
      const [t, rs] = await Promise.all([
        window.api.getScheduledTask(taskId),
        window.api.listScheduledTaskRuns(taskId, 30)
      ])
      setTask(t)
      setRuns(rs)
      if (t?.sessionId) {
        const msgs = await window.api.listMessages(t.sessionId)
        setMessages(msgs)
      } else {
        setMessages([])
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { refresh() }, [taskId])

  // Opening the detail clears the unread indicator — the user has "seen" the
  // latest run by virtue of being on this page.
  useEffect(() => { clearUnread(taskId) }, [taskId, clearUnread])

  useEffect(() => {
    const offStart = window.api.onScheduledRunStarted?.(e => {
      if (e.taskId === taskId) setIsRunning(true)
    })
    const offDone = window.api.onScheduledRunCompleted(e => {
      if (e.taskId === taskId) {
        setIsRunning(false)
        refresh()
        // Re-clear because the just-arrived run would mark us unread again.
        clearUnread(taskId)
      }
    })
    return () => { offStart?.(); offDone() }
  }, [taskId, clearUnread])

  async function handleTrigger() {
    if (!task) return
    setIsRunning(true) // optimistic — cleared by RUN_COMPLETED (or on error)
    try {
      await window.api.triggerScheduledTaskNow(task.id)
      toast.success('已触发')
    } catch (e) {
      setIsRunning(false)
      toast.error('触发失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  async function handleClearChat() {
    if (!task?.sessionId || messages.length === 0) return
    const ok = await dlg.confirm({
      title: '清空对话',
      message: `确定清空「${task.name}」的全部对话消息（${messages.length} 条）？任务本身和执行历史不会被删除。此操作无法撤销。`,
      confirmLabel: '清空',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await window.api.clearSessionMessages(task.sessionId)
      setMessages([])
      toast.success('已清空对话')
    } catch (e) {
      toast.error('清空失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  if (loading) return <p className="text-center text-sm text-muted-foreground py-12">加载中…</p>
  if (!task) return <p className="text-center text-sm text-muted-foreground py-12">任务不存在</p>

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-3 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onBack}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground shrink-0"
            title="返回"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-foreground truncate">{task.name}</h1>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {scheduleLabel(task.scheduleKind, task.scheduleValue)}
              {' · '}
              {isRunning
                ? '运行中…'
                : task.enabled
                  ? `下次：${formatTimestamp(task.nextFireAt)}`
                  : (task.scheduleKind === 'once' && task.lastFiredAt ? '已完成（仅一次）' : '已暂停')}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {tab === 'chat' && task.sessionId && messages.length > 0 && (
            <button
              onClick={handleClearChat}
              title="清空当前任务的全部对话消息（不删除任务本身）"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-destructive hover:border-destructive/40 hover:bg-destructive/5 transition-colors"
            >
              <Trash2 size={12} /> 清空对话
            </button>
          )}
          <button
            onClick={handleTrigger}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-muted transition-colors"
          >
            <Play size={12} /> 立即运行一次
          </button>
          <button
            onClick={() => onEdit(task)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs hover:opacity-90 transition-opacity"
          >
            <Pencil size={12} /> 编辑
          </button>
        </div>
      </div>
      {dlg.element}

      {/* Tabs */}
      <div className="px-6 border-b border-border flex items-center gap-1 shrink-0">
        <TabBtn icon={MessageSquare} active={tab === 'chat'} onClick={() => setTab('chat')}>
          对话
          {messages.length > 0 && (
            <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums">{messages.length}</span>
          )}
        </TabBtn>
        <TabBtn icon={History} active={tab === 'runs'} onClick={() => setTab('runs')}>
          执行历史
          {runs.length > 0 && (
            <span className="ml-1.5 text-[10px] text-muted-foreground tabular-nums">{runs.length}</span>
          )}
        </TabBtn>
        <TabBtn icon={Info} active={tab === 'info'} onClick={() => setTab('info')}>
          详细信息
        </TabBtn>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden min-h-0">
        {tab === 'chat' && (
          task.sessionId ? (
            // MessageList's root uses flex-1 — give it a flex column parent so
            // it actually stretches and its inner overflow-y-auto can scroll.
            <div className="flex flex-col h-full min-h-0">
              {isRunning && (
                <div className="shrink-0 flex items-center gap-2 px-6 py-2 bg-primary/[0.06] border-b border-primary/20 text-xs text-primary">
                  <Loader2 size={13} className="animate-spin" />
                  正在运行…完成后结果会自动出现在下面。
                </div>
              )}
              <MessageList
                messages={messages}
                sessionId={task.sessionId}
                onEditImage={setEditorSrc}
                providersCount={1 /* suppress onboarding empty-state */}
                defaultChatModel="(任务默认)"
                isRunning={false}
              />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              任务尚未启用，启用后会自动创建专属对话。
            </div>
          )
        )}

        {tab === 'runs' && (
          <div className="h-full overflow-y-auto px-6 py-4">
            {runs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-8 text-center">还没有触发过</p>
            ) : (
              <div className="border border-border rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium w-5"></th>
                      <th className="text-left px-3 py-2 font-medium">时间</th>
                      <th className="text-left px-3 py-2 font-medium">状态</th>
                      <th className="text-right px-3 py-2 font-medium">耗时</th>
                      <th className="text-right px-3 py-2 font-medium">花费</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map(run => {
                      const jumpable = run.status === 'success' && !!run.messageId
                      const expandable = run.status === 'failed' && !!run.error
                      const actionable = jumpable || expandable
                      const expanded = expandedRunId === run.id
                      return (
                        <Fragment key={run.id}>
                          <tr
                            className={cn('border-t border-border', actionable && 'cursor-pointer hover:bg-muted/30')}
                            onClick={() => {
                              if (jumpable) setTab('chat')
                              else if (expandable) setExpandedRunId(prev => prev === run.id ? null : run.id)
                            }}
                            title={jumpable ? '查看本次结果' : expandable ? '点击展开错误' : undefined}
                          >
                            <td className="px-3 py-2 text-muted-foreground/60">
                              {actionable && <ChevronRight size={12} className={cn('transition-transform', expanded && 'rotate-90')} />}
                            </td>
                            <td className="px-3 py-2 tabular-nums text-foreground/90">{formatTimestamp(run.firedAt)}</td>
                            <td className="px-3 py-2"><StatusBadge status={run.status} error={run.error} /></td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {run.durationMs != null ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {run.cost != null ? formatCostUsd(run.cost) : '—'}
                            </td>
                          </tr>
                          {expandable && expanded && (
                            <tr className="border-t border-border bg-destructive/[0.04]">
                              <td />
                              <td colSpan={4} className="px-3 py-2 text-[11px] text-destructive whitespace-pre-wrap break-all leading-relaxed">
                                {run.error}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'info' && (
          <div className="h-full overflow-y-auto px-6 py-4 space-y-5">
            <section>
              <h2 className="text-xs font-medium text-foreground mb-2">Prompt</h2>
              <div className="p-3 rounded-md bg-muted/40 border border-border text-xs font-mono whitespace-pre-wrap leading-relaxed text-foreground/90">
                {task.prompt}
              </div>
            </section>

            <section className="grid grid-cols-2 gap-3 text-xs">
              <MetaItem label="模型" value={task.providerId || task.model ? `${task.providerId ?? '默认'} / ${task.model ?? '默认'}` : '默认'} />
              <MetaItem label="状态" value={task.enabled ? '已启用' : '已暂停'} />
              <MetaItem label="连续失败" value={String(task.consecutiveFailures)} />
              <MetaItem label="上次触发" value={formatTimestamp(task.lastFiredAt)} />
              <MetaItem label="创建于" value={formatTimestamp(task.createdAt)} />
              <MetaItem label="最近更新" value={formatTimestamp(task.updatedAt)} />
            </section>
          </div>
        )}
      </div>

      {editorSrc && (
        <ImageEditor
          src={editorSrc}
          sessionId={task.sessionId ?? undefined}
          onClose={() => setEditorSrc(null)}
        />
      )}
    </div>
  )
}

function TabBtn({
  icon: Icon, active, onClick, children
}: {
  icon: typeof MessageSquare
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-2 text-xs transition-colors border-b-2 -mb-px',
        active
          ? 'text-foreground border-primary font-medium'
          : 'text-muted-foreground border-transparent hover:text-foreground'
      )}
    >
      <Icon size={12} />
      {children}
    </button>
  )
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 rounded-md bg-muted/30 border border-border">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-xs text-foreground mt-1 break-all">{value}</p>
    </div>
  )
}

function StatusBadge({ status, error }: { status: string; error?: string | null }) {
  if (status === 'success') {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 size={11} /> 成功
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span
        className="inline-flex items-center gap-1 text-destructive cursor-help"
        title={error ?? '失败'}
      >
        <XCircle size={11} /> 失败
      </span>
    )
  }
  if (status === 'aborted_no_window') {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground" title="触发时应用未运行">
        <MoonStar size={11} /> 跳过（无窗口）
      </span>
    )
  }
  return <span className="text-muted-foreground">{status}</span>
}
