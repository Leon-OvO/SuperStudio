import { useEffect, useMemo, useState } from 'react'
import { BRAND } from '@shared/brand'
import { ArrowLeft, Save, AlertTriangle, ChevronDown, ChevronUp, Monitor, CalendarClock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { Select } from '../../components/ui/Select'
import type { ScheduledTask, ScheduledTaskInput, ScheduleKind, ScheduleValue, ProviderConfig, WebhookBot, AppSettings } from '../../../../shared/ipc-types'
import { TEMPLATES, type ScheduledTaskTemplate } from './templates'
import { formatWhen, formatRelativeFromNow } from './scheduleLabel'

interface Props {
  task: ScheduledTask | null
  fromTemplate?: ScheduledTaskTemplate
  onBack: () => void
  onSaved: (task: ScheduledTask) => void
}

const WEEKDAYS = [
  { d: 1, label: '一' }, { d: 2, label: '二' }, { d: 3, label: '三' },
  { d: 4, label: '四' }, { d: 5, label: '五' }, { d: 6, label: '六' }, { d: 0, label: '日' }
]

const KINDS: { k: ScheduleKind; label: string }[] = [
  { k: 'daily', label: '每天' },
  { k: 'weekly', label: '每周' },
  { k: 'monthly', label: '每月' },
  { k: 'interval', label: '间隔' },
  { k: 'once', label: '仅一次' },
]

const INTERVAL_PRESETS = [
  { m: 15, label: '15 分钟' }, { m: 30, label: '30 分钟' }, { m: 60, label: '1 小时' },
  { m: 120, label: '2 小时' }, { m: 360, label: '6 小时' }, { m: 720, label: '12 小时' },
]

function todayPlus(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function defaultValue(kind: ScheduleKind): ScheduleValue {
  if (kind === 'daily') return { time: '09:00' }
  if (kind === 'weekly') return { days: [1, 2, 3, 4, 5], time: '09:00' }
  if (kind === 'monthly') return { day: 1, time: '09:00' }
  if (kind === 'interval') return { everyMinutes: 30 }
  return { date: todayPlus(1), time: '09:00' } // once → tomorrow 09:00 (safely future)
}

export function TaskForm({ task, fromTemplate, onBack, onSaved }: Props) {
  // New tasks start BLANK — only a template (empty-state pick or chip) pre-fills.
  const seed = fromTemplate ?? null
  const [name, setName] = useState(task?.name ?? seed?.name ?? '')
  const [prompt, setPrompt] = useState(task?.prompt ?? seed?.prompt ?? '')
  const [kind, setKind] = useState<ScheduleKind>(task?.scheduleKind ?? seed?.scheduleKind ?? 'daily')
  const [value, setValue] = useState<ScheduleValue>(task?.scheduleValue ?? seed?.scheduleValue ?? defaultValue('daily'))
  const [advancedOpen, setAdvancedOpen] = useState(!!(task?.providerId || task?.model))
  const [providerId, setProviderId] = useState<string>(task?.providerId ?? '')
  const [model, setModel] = useState<string>(task?.model ?? '')
  const [webhookBotId, setWebhookBotId] = useState<string>(task?.webhookBotId ?? '')
  const [computerMode, setComputerMode] = useState(task?.computerMode ?? false)
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [bots, setBots] = useState<WebhookBot[]>([])
  const [computerUseEnabled, setComputerUseEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  // Live "next fire" preview (computed by main so it always matches reality).
  const [preview, setPreview] = useState<{ nextFireAt: number } | { error: string } | null>(null)

  useEffect(() => {
    window.api.listProviders().then(list => setProviders(list as ProviderConfig[])).catch(() => {})
    window.api.getSettings().then(s => {
      setBots((s as AppSettings).webhookBots ?? [])
      setComputerUseEnabled((s as AppSettings).computerUseEnabled === true)
    }).catch(() => {})
  }, [])

  // Debounced live preview whenever the schedule changes.
  useEffect(() => {
    let cancelled = false
    const t = setTimeout(() => {
      window.api.previewScheduledNext?.(kind, value)
        .then(r => { if (!cancelled) setPreview(r) })
        .catch(() => { if (!cancelled) setPreview(null) })
    }, 200)
    return () => { cancelled = true; clearTimeout(t) }
  }, [kind, value])

  function switchKind(next: ScheduleKind) {
    setKind(next)
    setValue(defaultValue(next))
  }

  function applyTemplate(tpl: ScheduledTaskTemplate) {
    setName(tpl.name)
    setPrompt(tpl.prompt)
    setKind(tpl.scheduleKind)
    setValue(tpl.scheduleValue)
  }

  const time = useMemo(() => {
    if (kind === 'daily') return (value as { time: string }).time
    if (kind === 'weekly') return (value as { days: number[]; time: string }).time
    if (kind === 'monthly') return (value as { day: number; time: string }).time
    if (kind === 'once') return (value as { date: string; time: string }).time
    return '' // interval has no wall-clock time
  }, [kind, value])

  function setTime(t: string) {
    if (kind === 'daily') setValue({ time: t })
    else if (kind === 'weekly') setValue({ days: (value as { days: number[] }).days, time: t })
    else if (kind === 'monthly') setValue({ day: (value as { day: number }).day, time: t })
    else if (kind === 'once') setValue({ date: (value as { date: string }).date, time: t })
  }

  function toggleDay(d: number) {
    if (kind !== 'weekly') return
    const v = value as { days: number[]; time: string }
    const has = v.days.includes(d)
    const days = has ? v.days.filter(x => x !== d) : [...v.days, d]
    setValue({ days, time: v.time })
  }
  function setWeekdays(days: number[]) {
    if (kind !== 'weekly') return
    setValue({ days, time: (value as { time: string }).time })
  }

  function validate(): string | null {
    if (!name.trim()) return '请填写任务名称'
    if (!prompt.trim()) return '请填写 prompt'
    if (kind === 'weekly') {
      if (!(value as { days: number[] }).days?.length) return '每周至少选一天'
    }
    if (kind === 'monthly') {
      const d = (value as { day: number }).day
      if (!Number.isFinite(d) || d < 1 || d > 31) return '日期必须在 1–31 之间'
    }
    if (kind === 'interval') {
      const n = (value as { everyMinutes: number }).everyMinutes
      if (!Number.isFinite(n) || n < 1) return '间隔至少 1 分钟'
    }
    if (kind === 'once') {
      const v = value as { date: string; time: string }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return '请选择日期'
      const at = new Date(`${v.date}T${v.time || '00:00'}`).getTime()
      if (Number.isFinite(at) && at <= Date.now()) return '「仅一次」必须选择将来的时间'
    }
    return null
  }

  async function handleSave() {
    const err = validate()
    if (err) { toast.error(err); return }
    setSaving(true)
    try {
      const input: ScheduledTaskInput = {
        name: name.trim(), prompt: prompt.trim(),
        scheduleKind: kind, scheduleValue: value,
        providerId: advancedOpen && providerId ? providerId : null,
        model: advancedOpen && model ? model : null,
        webhookBotId: webhookBotId || null,
        computerMode,
        enabled: task?.enabled ?? true
      }
      const saved = task
        ? await window.api.updateScheduledTask(task.id, input)
        : await window.api.createScheduledTask(input)
      toast.success(task ? '已保存' : '已创建')
      onSaved(saved)
    } catch (e) {
      toast.error('保存失败：' + ((e as Error).message ?? '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  const providerOptions = providers.map(p => ({ value: p.id, label: p.name }))
  const modelOptions = useMemo(() => {
    const p = providers.find(p => p.id === providerId)
    return (p?.models ?? []).map(m => ({ value: m, label: m }))
  }, [providers, providerId])

  const intervalMinutes = kind === 'interval' ? (value as { everyMinutes: number }).everyMinutes : 0

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="返回">
            <ArrowLeft size={16} />
          </button>
          <h1 className="text-lg font-semibold text-foreground">{task ? '编辑任务' : '新建任务'}</h1>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm disabled:opacity-50"
        >
          <Save size={13} />
          {saving ? '保存中…' : '保存'}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-2xl mx-auto space-y-5">
          {/* Template chips — only when creating a fresh task */}
          {!task && (
            <div>
              <label className="block text-xs font-medium text-foreground mb-1.5">快速套用模板（可选）</label>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map(tpl => (
                  <button
                    key={tpl.id}
                    onClick={() => applyTemplate(tpl)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border bg-card text-xs text-foreground hover:border-primary/50 hover:bg-muted/40 transition-colors"
                  >
                    <span>{tpl.icon}</span> {tpl.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">任务名称</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="例如：每日早报"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors"
              maxLength={60}
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Prompt（每次触发都会原样发送）</label>
            <textarea
              value={prompt} onChange={e => setPrompt(e.target.value)} rows={6}
              placeholder="例如：请帮我汇总今天值得关注的科技新闻 5 条…"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors resize-y font-mono leading-relaxed"
            />
          </div>

          {/* Trigger */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">触发时间</label>

            <div className="flex flex-wrap gap-1 mb-3 p-1 rounded-md bg-muted/50 w-fit">
              {KINDS.map(({ k, label }) => (
                <button
                  key={k} onClick={() => switchKind(k)}
                  className={cn(
                    'px-3 py-1 text-xs rounded transition-colors',
                    kind === k ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {kind === 'weekly' && (
              <div className="mb-3">
                <div className="flex items-center gap-2 mb-1.5">
                  <p className="text-[11px] text-muted-foreground">选择星期（多选）</p>
                  <button onClick={() => setWeekdays([1, 2, 3, 4, 5])} className="text-[11px] text-primary hover:underline">工作日</button>
                  <button onClick={() => setWeekdays([0, 6])} className="text-[11px] text-primary hover:underline">周末</button>
                  <button onClick={() => setWeekdays([0, 1, 2, 3, 4, 5, 6])} className="text-[11px] text-primary hover:underline">每天</button>
                </div>
                <div className="flex gap-1.5">
                  {WEEKDAYS.map(({ d, label }) => {
                    const active = (value as { days: number[] }).days?.includes(d)
                    return (
                      <button
                        key={d} onClick={() => toggleDay(d)}
                        className={cn(
                          'w-9 h-9 rounded-md text-xs font-medium transition-colors',
                          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {kind === 'monthly' && (
              <div className="mb-3">
                <p className="text-[11px] text-muted-foreground mb-1.5">每月几号（1–31，29/30/31 在没有的月份会被跳过）</p>
                <input
                  type="number" min={1} max={31}
                  value={(value as { day: number }).day}
                  onChange={e => setValue({ day: parseInt(e.target.value, 10) || 1, time })}
                  className="w-24 px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
                />
              </div>
            )}

            {kind === 'interval' && (
              <div className="mb-3">
                <p className="text-[11px] text-muted-foreground mb-1.5">每隔多久跑一次</p>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {INTERVAL_PRESETS.map(p => (
                    <button
                      key={p.m} onClick={() => setValue({ everyMinutes: p.m })}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs transition-colors',
                        intervalMinutes === p.m ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">自定义</span>
                  <input
                    type="number" min={1} max={10080}
                    value={intervalMinutes}
                    onChange={e => setValue({ everyMinutes: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                    className="w-24 px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
                  />
                  <span className="text-[11px] text-muted-foreground">分钟</span>
                </div>
              </div>
            )}

            {kind === 'once' && (
              <div className="mb-3">
                <p className="text-[11px] text-muted-foreground mb-1.5">日期（只触发这一次，跑完自动停用）</p>
                <input
                  type="date"
                  value={(value as { date: string }).date}
                  min={todayPlus(0)}
                  onChange={e => setValue({ date: e.target.value || todayPlus(1), time })}
                  className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
                />
              </div>
            )}

            {kind !== 'interval' && (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1.5">时间（本地时区，24 小时制）</p>
                <input
                  type="time" value={time}
                  onChange={e => setTime(e.target.value || '09:00')}
                  className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
                />
              </div>
            )}

            {/* Live next-fire preview */}
            <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-md bg-primary/[0.06] border border-primary/20 text-xs">
              <CalendarClock size={14} className="text-primary shrink-0" />
              {preview && 'nextFireAt' in preview ? (
                <span className="text-foreground/90">
                  下次触发：<b>{formatWhen(preview.nextFireAt)}</b>
                  <span className="text-muted-foreground ml-1.5">（{formatRelativeFromNow(preview.nextFireAt)}）</span>
                </span>
              ) : (
                <span className="text-muted-foreground">{preview && 'error' in preview ? '当前设置无法计算下次触发时间' : '计算中…'}</span>
              )}
            </div>
          </div>

          {/* Notification bot */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">结果通知（可选）</label>
            {bots.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                还没有配置机器人。回到「定时任务」列表，点右上角「通知机器人」即可添加钉钉 / 飞书 / 企业微信机器人。
              </p>
            ) : (
              <>
                <Select
                  value={webhookBotId} onChange={setWebhookBotId}
                  options={[
                    { value: '', label: '不发送通知' },
                    ...bots.map(b => ({
                      value: b.id,
                      label: `${b.name}（${b.type === 'dingtalk' ? '钉钉' : b.type === 'feishu' ? '飞书' : '企业微信'}）${b.enabled ? '' : ' · 已停用'}`
                    }))
                  ]}
                  size="md"
                />
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  每次运行（含手动「立即运行」）结束后，把结果推送到所选机器人；成功推送结果内容，失败推送错误提示。
                </p>
              </>
            )}
          </div>

          {/* Advanced */}
          <div className="border border-border rounded-md">
            <button
              onClick={() => setAdvancedOpen(v => !v)}
              className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-foreground hover:bg-muted/40 rounded-md"
            >
              <span>高级（模型覆盖）</span>
              {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {advancedOpen && (
              <div className="px-3 py-3 border-t border-border space-y-3">
                <p className="text-[11px] text-muted-foreground">不填则使用全局默认对话模型。</p>
                <div>
                  <label className="block text-[11px] text-muted-foreground mb-1">提供商</label>
                  <Select
                    value={providerId} onChange={v => { setProviderId(v); setModel('') }}
                    options={[{ value: '', label: '（使用默认）' }, ...providerOptions]} size="md"
                  />
                </div>
                {providerId && (
                  <div>
                    <label className="block text-[11px] text-muted-foreground mb-1">模型</label>
                    <Select
                      value={model} onChange={setModel}
                      options={[{ value: '', label: '（使用默认）' }, ...modelOptions]} size="md"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Computer-use mode */}
          {computerUseEnabled && (
          <div className={cn('rounded-md border transition-colors', computerMode ? 'border-red-500/50 bg-red-500/[0.06]' : 'border-border')}>
            <button onClick={() => setComputerMode(v => !v)} className="w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left">
              <span className="flex items-center gap-2 min-w-0">
                <Monitor size={15} className={cn('shrink-0', computerMode ? 'text-red-600' : 'text-muted-foreground')} />
                <span className="min-w-0">
                  <span className={cn('block text-xs font-medium', computerMode ? 'text-red-600' : 'text-foreground')}>电脑操控（让 AI 自动操作本机）</span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">到点后 AI 会看屏幕、自动操作鼠标键盘来完成任务</span>
                </span>
              </span>
              <span className={cn('shrink-0 w-9 h-5 rounded-full transition-colors relative', computerMode ? 'bg-red-500' : 'bg-muted')}>
                <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', computerMode ? 'left-[18px]' : 'left-0.5')} />
              </span>
            </button>
            {computerMode && (
              <div className="px-3 pb-3 -mt-0.5">
                <p className="text-[11px] leading-relaxed text-red-600/90 dark:text-red-400/90">
                  ⚠️ 高危：定时无人值守时 AI 将自动操控你的电脑（点击 / 输入到任意程序），运行期间屏幕上有红色提示，可按 <b>Esc</b> 急停。需选择带视觉的 Claude 模型才会生效。
                </p>
              </div>
            )}
          </div>
          )}

          {/* Notice */}
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed">
              任务只在 {BRAND.displayName} 运行时执行。若关闭应用，错过 24 小时以内会在下次启动时补跑一次；超过 24 小时则跳过。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
