import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Save, AlertTriangle, ChevronDown, ChevronUp, Monitor } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { Select } from '../../components/ui/Select'
import type { ScheduledTask, ScheduledTaskInput, ScheduleKind, ScheduleValue, ProviderConfig, WebhookBot, AppSettings } from '../../../../shared/ipc-types'
import { TEMPLATES, type ScheduledTaskTemplate } from './templates'

interface Props {
  task: ScheduledTask | null
  fromTemplate?: ScheduledTaskTemplate
  onBack: () => void
  onSaved: (task: ScheduledTask) => void
}

const WEEKDAYS = [
  { d: 1, label: '一' },
  { d: 2, label: '二' },
  { d: 3, label: '三' },
  { d: 4, label: '四' },
  { d: 5, label: '五' },
  { d: 6, label: '六' },
  { d: 0, label: '日' }
]

function defaultValue(kind: ScheduleKind): ScheduleValue {
  if (kind === 'daily') return { time: '09:00' }
  if (kind === 'weekly') return { days: [1, 2, 3, 4, 5], time: '09:00' }
  return { day: 1, time: '09:00' }
}

export function TaskForm({ task, fromTemplate, onBack, onSaved }: Props) {
  const seed: ScheduledTaskTemplate | null = fromTemplate ?? (
    !task ? TEMPLATES[0] : null
  )
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

  useEffect(() => {
    window.api.listProviders().then(list => setProviders(list as ProviderConfig[])).catch(() => {})
    window.api.getSettings().then(s => {
      setBots((s as AppSettings).webhookBots ?? [])
      setComputerUseEnabled((s as AppSettings).computerUseEnabled === true)
    }).catch(() => {})
  }, [])

  function switchKind(next: ScheduleKind) {
    setKind(next)
    setValue(defaultValue(next))
  }

  const time = useMemo(() => {
    if (kind === 'daily') return (value as { time: string }).time
    if (kind === 'weekly') return (value as { days: number[]; time: string }).time
    return (value as { day: number; time: string }).time
  }, [kind, value])

  function setTime(t: string) {
    if (kind === 'daily') setValue({ time: t })
    else if (kind === 'weekly') setValue({ days: (value as { days: number[] }).days, time: t })
    else setValue({ day: (value as { day: number }).day, time: t })
  }

  function toggleDay(d: number) {
    if (kind !== 'weekly') return
    const v = value as { days: number[]; time: string }
    const has = v.days.includes(d)
    const days = has ? v.days.filter(x => x !== d) : [...v.days, d]
    setValue({ days, time: v.time })
  }

  function setMonthDay(d: number) {
    if (kind !== 'monthly') return
    setValue({ day: d, time: (value as { day: number; time: string }).time })
  }

  function validate(): string | null {
    if (!name.trim()) return '请填写任务名称'
    if (!prompt.trim()) return '请填写 prompt'
    if (kind === 'weekly') {
      const v = value as { days: number[]; time: string }
      if (!v.days?.length) return '每周至少选一天'
    }
    if (kind === 'monthly') {
      const v = value as { day: number; time: string }
      if (!Number.isFinite(v.day) || v.day < 1 || v.day > 31) return '日期必须在 1–31 之间'
    }
    return null
  }

  async function handleSave() {
    const err = validate()
    if (err) { toast.error(err); return }
    setSaving(true)
    try {
      const input: ScheduledTaskInput = {
        name: name.trim(),
        prompt: prompt.trim(),
        scheduleKind: kind,
        scheduleValue: value,
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            title="返回"
          >
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
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">任务名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如：每日早报"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors"
              maxLength={60}
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">Prompt（每次触发都会原样发送）</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              rows={6}
              placeholder="例如：请帮我汇总今天值得关注的科技新闻 5 条…"
              className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors resize-y font-mono leading-relaxed"
            />
          </div>

          {/* Trigger — three modes */}
          <div>
            <label className="block text-xs font-medium text-foreground mb-1.5">触发时间</label>

            <div className="flex gap-1 mb-3 p-1 rounded-md bg-muted/50 w-fit">
              {(['daily', 'weekly', 'monthly'] as const).map(k => (
                <button
                  key={k}
                  onClick={() => switchKind(k)}
                  className={cn(
                    'px-3 py-1 text-xs rounded transition-colors',
                    kind === k
                      ? 'bg-background text-foreground shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {k === 'daily' ? '每天' : k === 'weekly' ? '每周' : '每月'}
                </button>
              ))}
            </div>

            {kind === 'weekly' && (
              <div className="mb-3">
                <p className="text-[11px] text-muted-foreground mb-1.5">选择星期（多选）</p>
                <div className="flex gap-1.5">
                  {WEEKDAYS.map(({ d, label }) => {
                    const active = (value as { days: number[] }).days?.includes(d)
                    return (
                      <button
                        key={d}
                        onClick={() => toggleDay(d)}
                        className={cn(
                          'w-9 h-9 rounded-md text-xs font-medium transition-colors',
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70'
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
                  type="number"
                  min={1}
                  max={31}
                  value={(value as { day: number }).day}
                  onChange={e => setMonthDay(parseInt(e.target.value, 10) || 1)}
                  className="w-24 px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
                />
              </div>
            )}

            <div>
              <p className="text-[11px] text-muted-foreground mb-1.5">时间（本地时区，24 小时制）</p>
              <input
                type="time"
                value={time}
                onChange={e => setTime(e.target.value || '09:00')}
                className="px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none"
              />
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
                  value={webhookBotId}
                  onChange={setWebhookBotId}
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
                    value={providerId}
                    onChange={v => { setProviderId(v); setModel('') }}
                    options={[{ value: '', label: '（使用默认）' }, ...providerOptions]}
                    size="md"
                  />
                </div>
                {providerId && (
                  <div>
                    <label className="block text-[11px] text-muted-foreground mb-1">模型</label>
                    <Select
                      value={model}
                      onChange={setModel}
                      options={[{ value: '', label: '（使用默认）' }, ...modelOptions]}
                      size="md"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Computer-use mode — high-risk, unattended desktop control. Only
              shown when the Computer Use plugin is enabled (设置 → 插件). */}
          {computerUseEnabled && (
          <div className={cn(
            'rounded-md border transition-colors',
            computerMode ? 'border-red-500/50 bg-red-500/[0.06]' : 'border-border'
          )}>
            <button
              onClick={() => setComputerMode(v => !v)}
              className="w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left"
            >
              <span className="flex items-center gap-2 min-w-0">
                <Monitor size={15} className={cn('shrink-0', computerMode ? 'text-red-600' : 'text-muted-foreground')} />
                <span className="min-w-0">
                  <span className={cn('block text-xs font-medium', computerMode ? 'text-red-600' : 'text-foreground')}>电脑操控（让 AI 自动操作本机）</span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">到点后 AI 会看屏幕、自动操作鼠标键盘来完成任务</span>
                </span>
              </span>
              <span className={cn(
                'shrink-0 w-9 h-5 rounded-full transition-colors relative',
                computerMode ? 'bg-red-500' : 'bg-muted'
              )}>
                <span className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
                  computerMode ? 'left-[18px]' : 'left-0.5'
                )} />
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
              任务只在 SuperStudio 运行时执行。若关闭应用，错过 24 小时以内会在下次启动时补跑一次；超过 24 小时则跳过。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
