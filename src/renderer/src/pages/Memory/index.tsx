import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Plus, Trash2, Pin, PinOff, Archive, ArchiveRestore, Search, Eye, Edit3,
  User, FolderGit2, History, Sparkles, Brain, X, ShieldCheck, Upload, Download, Loader2
} from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import { renderMarkdown } from '../../lib/markdown'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

type MemoryKind = 'profile' | 'project' | 'episode' | 'skill' | 'correction'

interface Memory {
  id: string
  kind: MemoryKind
  scope_key: string | null
  title: string
  content: string
  tags: string | null
  source: string | null
  pinned: number
  status: string
  confidence: number | null
  created_at: number
  updated_at: number
}

const KINDS: { id: MemoryKind; label: string; icon: typeof User; hint: string }[] = [
  { id: 'profile', label: '用户画像', icon: User, hint: '关于你的持久事实、偏好、身份' },
  { id: 'project', label: '项目记忆', icon: FolderGit2, hint: '每个公司项目的事实、决策、约定' },
  { id: 'episode', label: '过往经历', icon: History, hint: '过去做过什么的摘要' },
  { id: 'skill', label: '技能', icon: Sparkles, hint: '可复用的做法 / 解决套路' },
  { id: 'correction', label: '交付标准', icon: ShieldCheck, hint: '你纠正过的交付要求，AI 以后会遵守（可删除）' },
]

export function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([])
  const [activeKind, setActiveKind] = useState<MemoryKind>('profile')
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<Memory | null>(null)
  const [autoCapture, setAutoCapture] = useState(true)
  const [importing, setImporting] = useState(false)
  const dlg = useConfirmDialog()

  const load = useCallback(async () => {
    const rows = (await window.api.listMemories(
      showArchived ? { status: 'archived' } : { status: 'active' }
    )) as Memory[]
    setMemories(rows)
  }, [showArchived])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    window.api.getSettings().then(s => setAutoCapture(s.memoryAutoCapture !== false)).catch(() => {})
    const off = window.api.onMemoryCaptured?.((info) => {
      if (info.count > 0) load()  // global toast is shown app-wide in App.tsx
    })
    return () => { off?.() }
  }, [load])

  const counts = KINDS.reduce((acc, k) => {
    acc[k.id] = memories.filter(m => m.kind === k.id).length
    return acc
  }, {} as Record<MemoryKind, number>)

  const visible = memories
    .filter(m => m.kind === activeKind)
    .filter(m => !query.trim() || (m.title + m.content + (m.tags || '')).toLowerCase().includes(query.toLowerCase()))

  async function createMemory() {
    const { id } = await window.api.saveMemory({ kind: activeKind, title: '新记忆', content: '', tags: [] })
    await load()
    const fresh = (await window.api.listMemories({ status: 'active' })) as Memory[]
    const m = fresh.find(x => x.id === id)
    if (m) setActive(m)
  }

  async function toggleAutoCapture() {
    const next = !autoCapture
    setAutoCapture(next)
    await window.api.setSettings({ memoryAutoCapture: next })
  }

  // Import external memory assets (.json / .jsonl / .md). Multi-select supported.
  async function importMems() {
    const paths = (await window.api.openFileDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Memory', extensions: ['json', 'jsonl', 'md'] }],
    })) as string[] | undefined
    if (!paths?.length) return
    setImporting(true)
    try {
      const r = await window.api.importMemories(paths)
      if (r.imported) {
        toast.success(`已导入 ${r.imported} 条记忆${r.skipped ? `（跳过 ${r.skipped}）` : ''}`)
        await load()
      } else {
        toast.error(r.errors.length ? '导入失败：' + r.errors[0] : `未导入（跳过 ${r.skipped} 条：重复或格式不符）`)
      }
    } catch (e) {
      toast.error('导入失败：' + (e as Error).message)
    } finally {
      setImporting(false)
    }
  }

  // Export all active memories to a JSON file (round-trips back via 导入).
  async function exportMems() {
    try {
      const r = await window.api.exportMemories()
      if (!r.canceled) toast.success(`已导出 ${r.count ?? 0} 条记忆到 ${r.filePath}`)
    } catch (e) {
      toast.error('导出失败：' + (e as Error).message)
    }
  }

  return (
    <div className="flex h-full">
      {/* Kind groups */}
      <aside className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="p-3 border-b border-border flex items-center gap-2 text-sm font-medium">
          <Brain size={15} className="text-primary" /> 记忆
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {KINDS.map(k => {
            const Icon = k.icon
            return (
              <button
                key={k.id}
                onClick={() => { setActiveKind(k.id); setActive(null) }}
                title={k.hint}
                className={cn(
                  'w-full flex items-center gap-2 px-2 py-2 rounded-md text-sm transition-colors',
                  activeKind === k.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                <Icon size={14} className="shrink-0" />
                <span className="flex-1 text-left truncate">{k.label}</span>
                {counts[k.id] > 0 && <span className="text-[10px] text-muted-foreground/60">{counts[k.id]}</span>}
              </button>
            )
          })}
        </div>
        <div className="p-2 border-t border-border space-y-1.5">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={autoCapture} onChange={toggleAutoCapture} />
            自动从对话/公司提炼记忆
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={showArchived} onChange={e => { setShowArchived(e.target.checked); setActive(null) }} />
            显示已归档
          </label>
        </div>
      </aside>

      {/* Memory list */}
      <aside className="w-72 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center gap-1 px-2 py-1 rounded-md bg-card border border-border">
            <Search size={13} className="text-muted-foreground" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索记忆…"
              className="flex-1 bg-transparent text-xs outline-none"
            />
          </div>
          <div className="flex gap-1.5">
            {!showArchived && (
              <button onClick={createMemory} className="flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-primary/10 hover:bg-primary/20">
                <Plus size={12} /> 新建{KINDS.find(k => k.id === activeKind)?.label}
              </button>
            )}
            <button
              onClick={importMems}
              disabled={importing}
              title="导入外部记忆资产（.json / .jsonl / .md，可多选）"
              className={cn('flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-border hover:bg-accent disabled:opacity-50', showArchived && 'flex-1')}
            >
              {importing ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />} 导入
            </button>
            <button
              onClick={exportMems}
              title="导出全部记忆为 JSON（可再导入）"
              className={cn('flex items-center justify-center gap-1 px-2 py-1 rounded text-xs border border-border hover:bg-accent', showArchived && 'flex-1')}
            >
              <Download size={12} /> 导出
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {visible.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 p-2">
              {showArchived ? '没有已归档的记忆。' : `还没有${KINDS.find(k => k.id === activeKind)?.label}。用得越多，这里会自动积累。`}
            </p>
          ) : visible.map(m => (
            <button
              key={m.id}
              onClick={() => setActive(m)}
              className={cn(
                'w-full text-left p-2 rounded-md border transition-colors',
                active?.id === m.id ? 'border-primary/40 bg-accent' : 'border-border hover:bg-accent/50'
              )}
            >
              <div className="flex items-center gap-1.5">
                {m.pinned === 1 && <Pin size={10} className="text-primary shrink-0" />}
                <span className="text-xs font-medium truncate flex-1">{m.title || '未命名'}</span>
              </div>
              <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">{m.content}</p>
              <div className="text-[10px] text-muted-foreground/50 mt-1">{formatDate(m.updated_at)}</div>
            </button>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {active ? (
          <MemoryEditor
            key={active.id}
            initial={active}
            onChanged={load}
            onClose={() => setActive(null)}
            dlg={dlg}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <Brain size={28} className="opacity-30" />
            <p>选择左侧一条记忆查看/编辑，或新建一条。</p>
            <p className="text-xs text-muted-foreground/60 max-w-sm text-center">
              记忆会在对话和公司里被自动召回，让助手越用越懂你。
            </p>
          </div>
        )}
      </div>

      {dlg.element}
    </div>
  )
}

function MemoryEditor({
  initial, onChanged, onClose, dlg
}: {
  initial: Memory
  onChanged: () => void
  onClose: () => void
  dlg: ReturnType<typeof useConfirmDialog>
}) {
  const [title, setTitle] = useState(initial.title)
  const [content, setContent] = useState(initial.content)
  const [tags, setTags] = useState<string>(() => {
    try { return (JSON.parse(initial.tags || '[]') as string[]).join('、') } catch { return '' }
  })
  const [pinned, setPinned] = useState(initial.pinned === 1)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saved, setSaved] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef({ title: initial.title, content: initial.content, tags })

  const doSave = useCallback(async () => {
    const tagArr = tags.split(/[、,，]/).map(s => s.trim()).filter(Boolean)
    await window.api.saveMemory({
      id: initial.id, kind: initial.kind, scopeKey: initial.scope_key,
      title, content, tags: tagArr, pinned
    })
    lastSaved.current = { title, content, tags }
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    onChanged()
  }, [initial.id, initial.kind, initial.scope_key, title, content, tags, pinned, onChanged])

  // Debounced auto-save (save is pure SQLite — instant + safe).
  useEffect(() => {
    if (title === lastSaved.current.title && content === lastSaved.current.content && tags === lastSaved.current.tags) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void doSave() }, 800)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [title, content, tags, doSave])

  async function togglePin() {
    const next = !pinned
    setPinned(next)
    await window.api.setMemoryPinned(initial.id, next)
    onChanged()
  }

  async function archive() {
    await window.api.archiveMemory(initial.id, initial.status === 'active')
    onChanged(); onClose()
  }

  async function remove() {
    if (!(await dlg.confirm({ message: '确定删除这条记忆？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteMemory(initial.id)
    onChanged(); onClose()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-2">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="flex-1 bg-transparent text-lg font-semibold outline-none"
          placeholder="记忆标题…"
        />
        {saved && <span className="text-[10px] text-green-600">已保存</span>}
        <button onClick={togglePin} title={pinned ? '取消置顶' : '置顶'} className="text-muted-foreground hover:text-primary">
          {pinned ? <Pin size={15} /> : <PinOff size={15} />}
        </button>
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          <button onClick={() => setMode('edit')} className={cn('px-2 py-1 flex items-center gap-1', mode === 'edit' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}>
            <Edit3 size={11} /> 编辑
          </button>
          <button onClick={() => setMode('preview')} className={cn('px-2 py-1 flex items-center gap-1 border-l border-border', mode === 'preview' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}>
            <Eye size={11} /> 预览
          </button>
        </div>
        <button onClick={archive} title={initial.status === 'active' ? '归档' : '取消归档'} className="text-muted-foreground hover:text-foreground">
          {initial.status === 'active' ? <Archive size={15} /> : <ArchiveRestore size={15} />}
        </button>
        <button onClick={remove} title="删除" className="text-muted-foreground hover:text-destructive">
          <Trash2 size={15} />
        </button>
        <button onClick={onClose} title="关闭" className="text-muted-foreground hover:text-foreground">
          <X size={16} />
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border flex items-center gap-2 text-xs">
        <span className="text-muted-foreground shrink-0">标签</span>
        <input
          value={tags}
          onChange={e => setTags(e.target.value)}
          placeholder="用顿号或逗号分隔，例如：偏好、中文、回复（用于召回匹配）"
          className="flex-1 bg-transparent outline-none"
        />
      </div>

      {mode === 'edit' ? (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="记忆内容（Markdown）。会在相关对话/公司里被自动召回。"
          className="flex-1 p-4 bg-transparent outline-none resize-none text-sm leading-relaxed"
        />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {content.trim() ? renderMarkdown(content) : <p className="text-muted-foreground text-sm italic">（暂无内容）</p>}
        </div>
      )}

      <div className="px-4 py-1.5 border-t border-border text-[10px] text-muted-foreground/60 flex items-center gap-3">
        <span>来源：{initial.source || 'manual'}</span>
        <span>创建：{formatDate(initial.created_at)}</span>
      </div>
    </div>
  )
}
