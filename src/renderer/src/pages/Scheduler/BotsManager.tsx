import { useEffect, useState } from 'react'
import { ArrowLeft, Plus, Pencil, Trash2, Save, X, Bot, ShieldCheck } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toast } from '../../components/ui/Toast'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import type { AppSettings, WebhookBot, WebhookBotType } from '../../../../shared/ipc-types'

interface Props {
  onBack: () => void
}

interface TypeMeta {
  label: string
  /** Single-glyph avatar text. */
  short: string
  /** Tailwind classes for the colored avatar / chip. */
  badge: string
  supportsSecret: boolean
}

const TYPE_META: Record<WebhookBotType, TypeMeta> = {
  dingtalk: { label: '钉钉', short: '钉', badge: 'bg-blue-500/15 text-blue-600 dark:text-blue-400', supportsSecret: true },
  feishu: { label: '飞书', short: '飞', badge: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400', supportsSecret: true },
  wechat_work: { label: '企业微信', short: '企', badge: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', supportsSecret: false }
}

const TYPE_ORDER: WebhookBotType[] = ['dingtalk', 'feishu', 'wechat_work']

function maskUrl(url: string): string {
  if (!url) return ''
  return url.length <= 48 ? url : `${url.slice(0, 32)}……${url.slice(-10)}`
}

export function BotsManager({ onBack }: Props) {
  const [bots, setBots] = useState<WebhookBot[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<WebhookBot | null>(null)
  const dlg = useConfirmDialog()

  useEffect(() => {
    window.api.getSettings()
      .then((s) => setBots((s as AppSettings).webhookBots ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function persist(next: WebhookBot[]) {
    setBots(next)
    await window.api.setSettings({ webhookBots: next })
  }

  function startAdd() {
    setEditing({ id: crypto.randomUUID(), type: 'dingtalk', name: '', url: '', secret: '', enabled: true })
  }

  async function handleSave(bot: WebhookBot) {
    if (!bot.name.trim()) { toast.error('请填写机器人名称'); return }
    if (!bot.url.trim()) { toast.error('请填写 Webhook 地址'); return }
    const cleaned: WebhookBot = {
      ...bot,
      name: bot.name.trim(),
      url: bot.url.trim(),
      secret: TYPE_META[bot.type].supportsSecret ? (bot.secret?.trim() || '') : ''
    }
    const idx = bots.findIndex(b => b.id === cleaned.id)
    const next = idx >= 0 ? bots.map(b => b.id === cleaned.id ? cleaned : b) : [...bots, cleaned]
    try {
      await persist(next)
      toast.success(idx >= 0 ? '已保存' : '已添加')
      setEditing(null)
    } catch (e) {
      toast.error('保存失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  async function handleDelete(bot: WebhookBot) {
    const ok = await dlg.confirm({
      title: '删除机器人',
      message: `确定删除「${bot.name}」？引用了它的定时任务将不再发送通知。`,
      confirmLabel: '删除',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await persist(bots.filter(b => b.id !== bot.id))
      toast.success('已删除')
    } catch (e) {
      toast.error('删除失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  async function handleToggle(bot: WebhookBot) {
    try {
      await persist(bots.map(b => b.id === bot.id ? { ...b, enabled: !b.enabled } : b))
    } catch (e) {
      toast.error('切换失败：' + ((e as Error).message ?? '未知错误'))
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="返回"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <h1 className="text-lg font-semibold text-foreground">通知机器人</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              全局配置一次，在每个定时任务里选择即可把结果推送到群。
            </p>
          </div>
        </div>
        {!editing && (
          <button
            onClick={startAdd}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm"
          >
            <Plus size={13} />
            添加机器人
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-xl mx-auto space-y-2.5">
          {editing && (
            <BotEditor
              bot={editing}
              isNew={!bots.some(b => b.id === editing.id)}
              onChange={setEditing}
              onSave={() => handleSave(editing)}
              onCancel={() => setEditing(null)}
            />
          )}

          {loading ? (
            <p className="text-center text-sm text-muted-foreground py-12">加载中…</p>
          ) : bots.length === 0 && !editing ? (
            <div className="text-center py-16 border border-dashed border-border rounded-xl">
              <Bot size={30} className="mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">还没有机器人</p>
              <p className="text-xs text-muted-foreground/70 mt-1">点击右上角「添加机器人」开始。</p>
            </div>
          ) : (
            bots.map(bot => {
              const meta = TYPE_META[bot.type]
              return (
                <div
                  key={bot.id}
                  className={cn(
                    'group flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border bg-card transition-colors hover:border-border/60',
                    !bot.enabled && 'opacity-60'
                  )}
                >
                  <div className={cn(
                    'shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-[15px] font-semibold',
                    meta.badge
                  )}>
                    {meta.short}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground truncate">{bot.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{meta.label}</span>
                      {bot.secret && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                          <ShieldCheck size={10} />加签
                        </span>
                      )}
                      {!bot.enabled && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">已停用</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 truncate mt-1 font-mono">{maskUrl(bot.url)}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleToggle(bot)}
                      title={bot.enabled ? '点击停用' : '点击启用'}
                      role="switch"
                      aria-checked={bot.enabled}
                      className={cn(
                        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors mr-1',
                        bot.enabled ? 'bg-primary' : 'bg-muted-foreground/30 hover:bg-muted-foreground/40'
                      )}
                    >
                      <span className={cn(
                        'inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform',
                        bot.enabled ? 'translate-x-[15px]' : 'translate-x-0.5'
                      )} />
                    </button>
                    <button
                      onClick={() => setEditing(bot)}
                      title="编辑"
                      className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(bot)}
                      title="删除"
                      className="p-1.5 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {dlg.element}
    </div>
  )
}

function BotEditor({
  bot, isNew, onChange, onSave, onCancel
}: {
  bot: WebhookBot
  isNew: boolean
  onChange: (b: WebhookBot) => void
  onSave: () => void
  onCancel: () => void
}) {
  const meta = TYPE_META[bot.type]
  return (
    <div className="rounded-xl border border-primary/30 bg-card p-4 space-y-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{isNew ? '添加机器人' : '编辑机器人'}</h3>
        <button
          onClick={onCancel}
          title="取消"
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Type — segmented */}
      <div>
        <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">类型</label>
        <div className="grid grid-cols-3 gap-2">
          {TYPE_ORDER.map(type => {
            const m = TYPE_META[type]
            const active = bot.type === type
            return (
              <button
                key={type}
                onClick={() => onChange({ ...bot, type })}
                className={cn(
                  'flex items-center justify-center gap-1.5 h-9 rounded-lg border text-xs transition-all',
                  active
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span className={cn('w-5 h-5 rounded flex items-center justify-center text-[11px] font-semibold', m.badge)}>
                  {m.short}
                </span>
                {m.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Name */}
      <div>
        <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">名称</label>
        <input
          type="text"
          value={bot.name}
          onChange={e => onChange({ ...bot, name: e.target.value })}
          placeholder="例如：研发群早报"
          maxLength={40}
          className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors"
        />
      </div>

      {/* URL */}
      <div>
        <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">Webhook 地址</label>
        <input
          type="text"
          value={bot.url}
          onChange={e => onChange({ ...bot, url: e.target.value })}
          placeholder="群机器人「Webhook」完整地址（含 access_token / key）"
          className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors font-mono"
        />
      </div>

      {/* Secret (DingTalk / Feishu only) */}
      {meta.supportsSecret && (
        <div>
          <label className="block text-[11px] font-medium text-muted-foreground mb-1.5">加签密钥（可选）</label>
          <input
            type="password"
            value={bot.secret ?? ''}
            onChange={e => onChange({ ...bot, secret: e.target.value })}
            placeholder="若机器人安全设置选了「加签」，填这里的 secret"
            className="w-full px-3 py-2 text-sm rounded-md border border-border bg-background focus:border-primary outline-none transition-colors font-mono"
          />
          <p className="text-[10px] text-muted-foreground/80 mt-1.5 leading-relaxed">
            机器人安全设置若选「自定义关键词」或「IP 白名单」则留空；选「加签」必须填，否则推送会报错。
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          取消
        </button>
        <button
          onClick={onSave}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 active:scale-95 transition-all shadow-sm"
        >
          <Save size={13} />
          保存
        </button>
      </div>
    </div>
  )
}
