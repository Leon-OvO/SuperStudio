import { useEffect, useMemo, useRef, useState } from 'react'
import { Square, Play, Brain, Zap, MessageSquare, Search, Bug, Coins, User } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { TaskRow } from './TaskRow'
import { MessageBubble } from './MessageBubble'
import { MessagesMinimap } from './MessagesMinimap'
import { Select } from '../../../components/ui/Select'
import { ThinkingConsole } from '../../../components/ui/ThinkingConsole'
import { formatCostUsd, formatTokens } from '../../../lib/format-cost'
import { VibeComposer, INTENT_META, type VibeMode } from '../Composer'
import { type ThinkingMode } from '../../../components/ThinkingModePicker'
import type { ComposerAttachment } from '../../../lib/attachments'
import type { VibeRequestInfo, VibeTaskInfo, VibeMessageInfo, VibeIntent } from '../../../../../shared/ipc-types'
import { useEmployeesStore } from '../../../stores/employees'

interface Props {
  request: VibeRequestInfo | null
  tasks: VibeTaskInfo[]
  messages: VibeMessageInfo[]
  streamingTaskId: string | null
  running: 'propose' | 'apply' | 'explore' | 'chat' | 'bugfix' | null
  /** Unified send: auto-detect intent unless forceIntent is given (manual lock). */
  onRun: (prompt: string, requestId?: string, forceIntent?: VibeIntent, attachments?: ComposerAttachment[], thinkingMode?: ThinkingMode, forceSkillIds?: string[]) => void
  /** Project model (gates the 思考模式 picker); '' → global default. */
  providerId?: string
  model?: string
  onApply: () => void
  onStop: () => void
  onToggleTaskStatus: (taskId: string, status: 'pending' | 'done' | 'skipped') => void
  /** Reassign a sub-task to an employee (null = back to request/default). */
  onReassignTask: (taskId: string, employeeId: string | null) => void
  /** Revert ONLY this task's file changes (restore to the pre-apply snapshot). */
  onRevertTask?: (taskId: string) => void
}

export function RequestTabContent({
  request, tasks, messages, streamingTaskId, running,
  onRun, providerId = '', model = '', onApply, onStop, onToggleTaskStatus, onReassignTask, onRevertTask
}: Props) {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  // Mode: 'auto' = let the backend classify; a VibeIntent = manual lock.
  const [mode, setMode] = useState<VibeMode>('auto')
  const [thinkingMode, setThinkingMode] = useState<ThinkingMode>('auto')
  // Run start — drives the ThinkingConsole "已用时" clock; reset whenever the
  // run (re)starts (e.g. propose → apply) or the user switches request tabs.
  const [runStartedAt, setRunStartedAt] = useState<number | undefined>(undefined)
  useEffect(() => {
    setRunStartedAt(running ? Date.now() : undefined)
  }, [running, request?.id])

  // Real activity line for the ThinkingConsole — the latest tool call / status
  // message, so the workbench shows what's ACTUALLY happening (not canned text).
  const liveLine = useMemo(() => {
    if (!running) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'tool' && m.toolName) return `调用 ${m.toolName}…`
      if (m.role === 'system' && m.content) return m.content
    }
    return undefined
  }, [messages, running])
  const messagesRef = useRef<HTMLDivElement>(null)
  const messagesContentRef = useRef<HTMLDivElement>(null)

  // AI-company: which hired employee承接 this request. Reads the SHARED employee
  // store so a hire/fire in the 人才市场 tab is reflected here immediately (the
  // IDE stays mounted across tab switches, so a once-on-mount fetch went stale).
  const employees = useEmployeesStore(s => s.employees)
  const refreshEmployees = useEmployeesStore(s => s.refresh)
  const [assignee, setAssignee] = useState<string | null>(request?.assigneeEmployeeId ?? null)
  useEffect(() => { refreshEmployees() }, [refreshEmployees])
  useEffect(() => { setAssignee(request?.assigneeEmployeeId ?? null) }, [request?.id, request?.assigneeEmployeeId])
  async function changeAssignee(id: string | null) {
    if (!request) return
    setAssignee(id)
    try { await window.api.vibeRequestSetAssignee(request.id, id) } catch { /* non-fatal */ }
  }
  // Sticky-bottom flag: true ⇒ auto-scroll on content growth. Flips to false
  // when the user scrolls up; flips back to true when they scroll near bottom.
  const stickRef = useRef(true)

  // When switching requests, reset mode + 思考模式 to auto + snap to bottom
  useEffect(() => {
    setMode('auto')
    setThinkingMode('auto')
    stickRef.current = true
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [request?.id])

  // Auto-scroll: ResizeObserver on inner content fires whenever messages grow
  // (new bubble, streaming text accumulation, task expansions, etc).
  // We only scroll when stickRef is true.
  useEffect(() => {
    const scroller = messagesRef.current
    const content = messagesContentRef.current
    if (!scroller || !content) return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  function onMessagesScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = fromBottom < 40
  }

  const hasTasks = tasks.length > 0
  const doneCount = tasks.filter(t => t.status === 'done').length
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const hasPending = pendingCount > 0

  // Per-request rollup: total tokens + cost across every assistant turn in this
  // conversation. Memoised so we don't re-walk messages every render.
  const usageTotal = useMemo(() => {
    let inTok = 0, outTok = 0, cost = 0, any = false
    for (const m of messages) {
      if (m.inputTokens  != null) { inTok += m.inputTokens; any = true }
      if (m.outputTokens != null) { outTok += m.outputTokens; any = true }
      if (m.costUsd      != null) { cost  += m.costUsd; any = true }
    }
    return any ? { inputTokens: inTok, outputTokens: outTok, costUsd: cost } : null
  }, [messages])
  const stage: 'explore' | 'planned' | 'done' =
    !hasTasks ? 'explore' :
    pendingCount === 0 ? 'done' : 'planned'
  // Parallel apply may have several running tasks at once — banner summarizes them.
  const runningTasks = tasks.filter(t => t.status === 'running')

  function submit(forceSkillIds?: string[]) {
    const t = input.trim()
    // Allow attachment-only sends (e.g. "看看这张图" pasted with no text).
    if ((!t && attachments.length === 0) || running || !request) return
    onRun(t, request.id, mode === 'auto' ? undefined : mode, attachments.length ? attachments : undefined, thinkingMode === 'auto' ? undefined : thinkingMode, forceSkillIds)
    setInput('')
    setAttachments([])
    // User just sent a message — always pin them to the bottom.
    stickRef.current = true
    requestAnimationFrame(() => {
      const el = messagesRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
  }

  if (!request) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        请求不存在或已删除
      </div>
    )
  }

  const requestKind = request.kind as VibeIntent
  const kindMeta = INTENT_META[requestKind] ?? INTENT_META.change
  const KindIcon = kindMeta.Icon
  const isChange = requestKind === 'change'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header — title + kind badge + stage breadcrumb (only for change) */}
      <div className="flex items-start gap-3 px-5 py-3 border-b border-border bg-card/60 shrink-0">
        <div className={cn(
          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border',
          kindMeta.bg
        )}>
          <KindIcon size={14} className={kindMeta.color} />
        </div>
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="text-sm font-semibold truncate">{request.title}</div>
          {request.summary && (
            <div className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{request.summary}</div>
          )}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-1">
            <span className={cn('px-1.5 py-px rounded text-[10px] uppercase font-semibold border', kindMeta.bg, kindMeta.color)}>
              {kindMeta.label}
            </span>
            {isChange && (
              <>
                <StageBreadcrumb stage={stage} hasTasks={hasTasks} doneCount={doneCount} totalTasks={tasks.length} />
              </>
            )}
            <span className="text-muted-foreground/60">·</span>
            <span className="truncate">{request.slug}</span>
            {isChange && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="inline-flex items-center gap-1" title="默认承接人：未单独指派的子任务用 TA（用其底层模型与岗位人格执行）">
                  <User size={12} className="text-muted-foreground/70 shrink-0" />
                  <Select
                    value={assignee ?? ''}
                    onChange={v => changeAssignee(v || null)}
                    className="max-w-[130px]"
                    options={[
                      { value: '', label: '默认承接人' },
                      ...employees.map(emp => ({ value: emp.id, label: emp.name })),
                      ...(assignee && !employees.some(e => e.id === assignee) ? [{ value: assignee, label: '（已离职）' }] : [])
                    ]}
                  />
                </span>
              </>
            )}
            {usageTotal && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span
                  className="inline-flex items-center gap-1 px-1.5 py-px rounded bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[10px] font-medium tabular-nums"
                  title={`本对话累计消耗：输入 ${usageTotal.inputTokens.toLocaleString()} tokens，输出 ${usageTotal.outputTokens.toLocaleString()} tokens`}
                >
                  <Coins size={9} />
                  {formatTokens(usageTotal.inputTokens + usageTotal.outputTokens)} tok · {formatCostUsd(usageTotal.costUsd)}
                </span>
              </>
            )}
          </div>
        </div>
        {hasPending && (
          <button
            onClick={running === 'apply' ? onStop : onApply}
            disabled={running === 'propose'}
            className={cn(
              'flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-medium transition-colors disabled:opacity-50 shrink-0',
              running === 'apply'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            )}
          >
            {running === 'apply'
              ? <><Square size={11} /> 停止</>
              : <><Play size={11} /> 执行剩余任务</>
            }
          </button>
        )}
      </div>

      {/* Running banner */}
      {running && (
        <div className="px-5 py-2.5 bg-primary/5 border-b border-primary/20 shrink-0 space-y-2">
          <div className="flex items-center gap-2.5">
          {running === 'chat' ? (
            <>
              <MessageSquare size={14} className="text-slate-500 animate-pulse shrink-0" />
              <div className="flex-1">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-300">AI 正在回复…</div>
              </div>
            </>
          ) : running === 'explore' ? (
            <>
              <Search size={14} className="text-sky-500 animate-pulse shrink-0" />
              <div className="flex-1">
                <div className="text-xs font-medium text-sky-700 dark:text-sky-300">AI 正在探索项目…</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">只读模式（不会修改任何文件）</div>
              </div>
            </>
          ) : running === 'bugfix' ? (
            <>
              <Bug size={14} className="text-rose-500 animate-pulse shrink-0" />
              <div className="flex-1">
                <div className="text-xs font-medium text-rose-700 dark:text-rose-300">AI 正在定位并修复 BUG…</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">自动模式，无需手动确认</div>
              </div>
            </>
          ) : running === 'propose' ? (
            <>
              <Brain size={14} className="text-primary animate-pulse shrink-0" />
              <div className="flex-1">
                <div className="text-xs font-medium text-primary">AI 正在拆解需求…</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">分析中，通常需要 10-30 秒</div>
              </div>
            </>
          ) : (
            <>
              <Zap size={14} className="text-amber-500 animate-pulse shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium">
                  {runningTasks.length > 1
                    ? <>执行中: <span className="text-amber-600">{runningTasks.length} 个任务并行</span></>
                    : runningTasks.length === 1
                      ? <>执行中: <span className="text-amber-600">任务 {runningTasks[0].ord} · {runningTasks[0].title}</span></>
                      : '准备执行任务…'
                  }
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {doneCount}/{tasks.length} 已完成 · 实时查看下方工具调用
                </div>
              </div>
            </>
          )}
          <button onClick={onStop} className="text-xs px-2 py-1 rounded text-destructive hover:bg-destructive/10">
            <Square size={10} className="inline mr-1" />停止
          </button>
          </div>
          {/* Real activity log — elapsed clock + the latest actual tool/status
              line. idleLabel=null: the banner above already states the phase, so
              don't repeat it here (avoids a duplicate "思考中"). */}
          <ThinkingConsole active variant={running} startedAt={runStartedAt} liveLine={liveLine} idleLabel={null} />
        </div>
      )}

      {/* Body — tasks panel auto-appears when tasks exist (change kind only) */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {hasTasks && (
          <div className="w-[320px] shrink-0 border-r border-border/60 overflow-y-auto py-2 bg-card/30">
            <div className="px-3 py-1 text-[10px] uppercase text-muted-foreground/80 font-semibold tracking-wider">
              任务列表
            </div>
            <div className="px-1">
              {tasks.map(t => (
                <TaskRow
                  key={t.id}
                  task={t}
                  isStreaming={streamingTaskId === t.id}
                  onToggleStatus={running === 'apply' ? undefined : (st) => onToggleTaskStatus(t.id, st)}
                  employees={employees}
                  onReassign={(empId) => onReassignTask(t.id, empId)}
                  onRevertTask={running === 'apply' ? undefined : onRevertTask}
                  disabled={running === 'apply'}
                />
              ))}
            </div>
          </div>
        )}

        {/* Messages column + VS Code-style minimap on the right.
            Native scrollbar is replaced by the minimap (it does both the
            "where am I" indicator AND the click-to-jump affordance). */}
        <div className="flex-1 min-w-0 flex">
          <div
            ref={messagesRef}
            onScroll={onMessagesScroll}
            className="flex-1 min-w-0 overflow-y-auto py-3 px-5 scrollbar-prominent"
          >
            <div ref={messagesContentRef} className="space-y-1">
              <div className="text-[10px] uppercase text-muted-foreground/70 font-semibold mb-1 tracking-wider">
                {hasTasks ? '对话与工作过程' : '对话'}
              </div>
              {messages.length === 0 ? (
                <div className="text-[12px] text-muted-foreground text-center py-6">
                  {running ? '等待 AI 响应…' : '问问题开始对话'}
                </div>
              ) : (
                messages.map(m => (
                  <div
                    key={m.id}
                    data-msg-id={m.id}
                    data-msg-role={m.role}
                    data-msg-error={m.isError ? '1' : '0'}
                  >
                    <MessageBubble msg={m} />
                  </div>
                ))
              )}
            </div>
          </div>
          <MessagesMinimap scrollRef={messagesRef} messages={messages} />
        </div>
      </div>

      {/* Input — pinned to bottom; shared VibeComposer (same visual language as
          the 对话 page's ChatInput). */}
      <div className="border-t border-border px-4 pt-3 pb-2 shrink-0 bg-card/30">
        <VibeComposer
          value={input}
          onChange={setInput}
          mode={mode}
          onModeChange={setMode}
          thinkingMode={thinkingMode}
          onThinkingModeChange={setThinkingMode}
          providerId={providerId}
          model={model}
          running={running}
          onSubmit={submit}
          onStop={onStop}
          attachments={attachments}
          setAttachments={setAttachments}
        />
      </div>
    </div>
  )
}

// ============================================================================
// Stage breadcrumb (only shown for 'change' kind)
// ============================================================================

function StageBreadcrumb({
  stage, hasTasks, doneCount, totalTasks
}: {
  stage: 'explore' | 'planned' | 'done'
  hasTasks: boolean
  doneCount: number
  totalTasks: number
}) {
  const Step = ({ label, active, complete }: { label: string; active: boolean; complete: boolean }) => (
    <span className={cn(
      'px-1.5 py-px rounded text-[9px] uppercase font-semibold',
      complete ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' :
      active ? 'bg-primary/15 text-primary' : 'bg-muted/40 text-muted-foreground/50'
    )}>
      {label}
    </span>
  )
  return (
    <div className="flex items-center gap-1">
      <Step label="拆解" active={stage === 'planned' && doneCount === 0} complete={hasTasks} />
      <span className="text-muted-foreground/40">→</span>
      <Step
        label={totalTasks > 0 ? `${doneCount}/${totalTasks}` : '执行'}
        active={stage === 'planned' && doneCount > 0}
        complete={stage === 'done'}
      />
    </div>
  )
}
