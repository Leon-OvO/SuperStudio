import { useMemo, useState } from 'react'
import { Plus, Edit2, Trash2, Eye, EyeOff, Copy, Check, Search, X, Loader2, CheckCircle2, XCircle, Zap } from 'lucide-react'
import type { ProviderConfig } from '../../../../shared/ipc-types'
import { Select } from '../../components/ui/Select'
import { toast } from '../../components/ui/Toast'
import { cn } from '../../lib/utils'

type SortKey = 'name' | 'type' | 'status'
type TestState = 'testing' | 'ok' | 'fail'

const TYPE_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  custom: '自定义'
}

interface Props {
  providers: ProviderConfig[]
  onEdit: (p: ProviderConfig) => void
  onDelete: (id: string) => void
  onCreate: () => void
}

export function ProviderList({ providers, onEdit, onDelete, onCreate }: Props) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [status, setStatus] = useState<Record<string, TestState>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [bulkTesting, setBulkTesting] = useState(false)

  // For sort=status: failed first (most actionable), then testing, ok, untested.
  const statusRank = (id: string): number => {
    const st = status[id]
    return st === 'fail' ? 0 : st === 'testing' ? 1 : st === 'ok' ? 2 : 3
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? providers.filter(p =>
          (p.name + ' ' + p.type + ' ' + (p.baseUrl || '') + ' ' + p.models.join(' ')).toLowerCase().includes(q))
      : providers.slice()
    list.sort((a, b) => {
      if (sortKey === 'type') return a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'zh')
      if (sortKey === 'status') return statusRank(a.id) - statusRank(b.id) || a.name.localeCompare(b.name, 'zh')
      return a.name.localeCompare(b.name, 'zh')
    })
    return list
    // statusRank reads `status`, so include it so sort=status reorders live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, query, sortKey, status])

  async function testOne(p: ProviderConfig): Promise<void> {
    setStatus(s => ({ ...s, [p.id]: 'testing' }))
    setErrors(e => { const n = { ...e }; delete n[p.id]; return n })
    try {
      const r = (await window.api.testProvider(p)) as { ok: boolean; modelCount?: number; error?: string }
      setStatus(s => ({ ...s, [p.id]: r.ok ? 'ok' : 'fail' }))
      if (!r.ok) setErrors(e => ({ ...e, [p.id]: r.error || '连接失败' }))
    } catch (err) {
      setStatus(s => ({ ...s, [p.id]: 'fail' }))
      setErrors(e => ({ ...e, [p.id]: (err as Error).message }))
    }
  }

  async function testAll(): Promise<void> {
    if (bulkTesting) return
    setBulkTesting(true)
    try {
      const queue = [...filtered]
      const worker = async (): Promise<void> => { while (queue.length) { const p = queue.shift(); if (p) await testOne(p) } }
      await Promise.all([worker(), worker(), worker(), worker()]) // ~4 并发
    } finally {
      setBulkTesting(false)
    }
  }

  async function copyKey(p: ProviderConfig): Promise<void> {
    if (!p.apiKey) { toast.error('该提供商未设置密钥'); return }
    try {
      await navigator.clipboard.writeText(p.apiKey)
      setCopiedId(p.id)
      setTimeout(() => setCopiedId(prev => (prev === p.id ? null : prev)), 1500)
    } catch (e) {
      toast.error('复制失败：' + (e as Error).message)
    }
  }

  const toggleReveal = (id: string): void =>
    setRevealed(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const statusDot = (id: string) => {
    const st = status[id]
    if (st === 'testing') return <Loader2 size={13} className="animate-spin text-muted-foreground shrink-0" />
    if (st === 'ok') return <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
    if (st === 'fail') return <XCircle size={13} className="text-destructive shrink-0" />
    return <span className="w-[7px] h-[7px] rounded-full bg-muted-foreground/30 shrink-0" />
  }

  const renderRow = (p: ProviderConfig) => {
    const isRevealed = revealed.has(p.id)
    return (
      <div key={p.id} className="group border border-border rounded-lg px-3 py-2.5 flex items-center gap-3 bg-card shadow-sm">
        {statusDot(p.id)}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{p.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase shrink-0">{p.type}</span>
            {p.anthropicNative && <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">native</span>}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 truncate">
            {p.baseUrl || '默认端点'} · {p.models.length} 个模型
            {errors[p.id] && <span className="text-destructive"> · {errors[p.id]}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
            <span className="shrink-0">密钥：</span>
            <span className={cn('font-mono truncate', isRevealed && 'text-foreground')}>
              {isRevealed ? (p.apiKey || '（空）') : maskKey(p.apiKey)}
            </span>
            {p.apiKey && (
              <>
                <button onClick={() => toggleReveal(p.id)} title={isRevealed ? '隐藏' : '查看'} className="p-0.5 hover:text-foreground shrink-0">
                  {isRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
                <button onClick={() => copyKey(p)} title="复制密钥" className="p-0.5 hover:text-foreground shrink-0">
                  {copiedId === p.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button onClick={() => testOne(p)} disabled={status[p.id] === 'testing'}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded disabled:opacity-50" title="测试连接">
            <Zap size={14} />
          </button>
          <button onClick={() => onEdit(p)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded" title="编辑">
            <Edit2 size={14} />
          </button>
          <button onClick={() => onDelete(p.id)} className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-accent rounded" title="删除">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">AI 提供商</h2>
          <p className="text-sm text-muted-foreground">为每个提供商配置 API 密钥和可用模型。</p>
        </div>
        <button onClick={onCreate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 transition-colors shrink-0">
          <Plus size={14} /> 添加提供商
        </button>
      </div>

      {providers.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
          尚未配置任何提供商，点击「添加提供商」开始。
        </div>
      ) : (
        <>
          {/* toolbar: 搜索 + 排序 + 全部测试 */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索 名称 / 类型 / 地址 / 模型…"
                className="h-8 w-full pl-8 pr-7 text-sm rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40" />
              {query && <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground"><X size={12} /></button>}
            </div>
            <Select<SortKey>
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: 'name', label: '按名称' },
                { value: 'type', label: '按类型' },
                { value: 'status', label: '按状态' }
              ]}
              size="sm"
            />
            <button onClick={testAll} disabled={bulkTesting || filtered.length === 0}
              className="flex items-center gap-1.5 px-2.5 h-8 rounded-md border border-border bg-card hover:bg-accent text-xs disabled:opacity-50 whitespace-nowrap">
              {bulkTesting ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />} 全部测试
            </button>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-6">没有匹配的提供商</div>
          ) : sortKey === 'type' ? (
            <div className="space-y-4">
              {groupByType(filtered).map(([type, items]) => (
                <div key={type} className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide px-1">
                    {TYPE_LABEL[type] || type} · {items.length}
                  </div>
                  <div className="space-y-2">{items.map(renderRow)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">{filtered.map(renderRow)}</div>
          )}
        </>
      )}
    </div>
  )
}

function groupByType(list: ProviderConfig[]): Array<[string, ProviderConfig[]]> {
  const map = new Map<string, ProviderConfig[]>()
  for (const p of list) {
    if (!map.has(p.type)) map.set(p.type, [])
    map.get(p.type)!.push(p)
  }
  return [...map.entries()]
}

function maskKey(key: string): string {
  if (!key) return '（空）'
  if (key.length <= 8) return '****'
  return key.slice(0, 4) + '****' + key.slice(-4)
}
