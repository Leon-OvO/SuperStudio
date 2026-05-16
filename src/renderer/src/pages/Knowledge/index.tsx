import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Plus, FolderOpen, Trash2, FileText, Upload, Search, Loader2, RefreshCw,
  Eye, Edit3, FileSpreadsheet, X, ArrowLeft, CheckCircle2
} from 'lucide-react'
import { cn, formatDate } from '../../lib/utils'
import { renderMarkdown } from '../../lib/markdown'
import { useInputDialog } from '../../components/ui/InputDialog'

interface Space {
  id: string
  name: string
  global_enabled: number
  created_at: number
}

interface Page {
  id: string
  space_id: string
  title: string
  content: string
  updated_at: number
  created_at: number
}

interface Source {
  id: string
  space_id: string
  name: string
  file_path: string
  source_type: string
  chunk_count: number
  created_at: number
}

interface SearchHit {
  content: string
  score: number
  sourceId: string
  spaceId: string
  source: { title: string; kind: 'page' | 'file'; pageId?: string }
}

interface ImportProgress {
  sourceId: string
  name: string
  current: number
  total: number
}

type TabKind = 'pages' | 'sources'

export function KnowledgePage() {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [activeSpace, setActiveSpace] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKind>('pages')
  const [pages, setPages] = useState<Page[]>([])
  const [sources, setSources] = useState<Source[]>([])
  const [activePage, setActivePage] = useState<Page | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [highlightSnippet, setHighlightSnippet] = useState<string | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const inputDialog = useInputDialog()

  useEffect(() => {
    loadSpaces()
    const unsub = window.api.onKbImportProgress((event: unknown) => {
      setImportProgress(event as ImportProgress)
    })
    unsubRef.current = unsub
    return () => { unsubRef.current?.() }
  }, [])

  useEffect(() => {
    if (activeSpace) {
      loadPages(activeSpace)
      loadSources(activeSpace)
    } else {
      setPages([])
      setSources([])
    }
  }, [activeSpace])

  async function loadSpaces() {
    const data = await window.api.listSpaces()
    setSpaces(data)
    if (!activeSpace && data.length > 0) setActiveSpace(data[0].id)
  }

  async function loadPages(spaceId: string) {
    const data = await window.api.listPages(spaceId)
    setPages(data)
  }

  async function loadSources(spaceId: string) {
    const data = await window.api.listSources(spaceId)
    setSources(data)
  }

  async function createSpace() {
    const name = await inputDialog.ask({
      title: '新建知识空间',
      description: '为这个空间起一个名字，例如「产品文档」「客户案例」。',
      placeholder: '空间名称',
      confirmLabel: '创建'
    })
    if (!name) return
    const result = await window.api.saveSpace({ name, globalEnabled: false })
    await loadSpaces()
    if (result?.id) setActiveSpace(result.id)
  }

  async function deleteSpace(id: string) {
    if (!confirm('确定删除该知识空间及其所有内容？')) return
    await window.api.deleteSpace(id)
    if (activeSpace === id) setActiveSpace(null)
    setActivePage(null)
    await loadSpaces()
  }

  async function toggleGlobal(space: Space) {
    await window.api.saveSpace({ id: space.id, name: space.name, globalEnabled: !space.global_enabled })
    await loadSpaces()
  }

  async function createPage() {
    if (!activeSpace) return
    const result = await window.api.savePage({
      spaceId: activeSpace,
      title: '未命名',
      content: ''
    })
    await loadPages(activeSpace)
    const newPage = (await window.api.listPages(activeSpace)).find((p: Page) => p.id === result.id)
    if (newPage) {
      setActivePage(newPage)
      setTab('pages')
    }
  }

  // Used by auto-save: update DB without reloading the whole list
  const savePageQuiet = useCallback(async (page: Page): Promise<{ ok: boolean; indexError?: string }> => {
    const result = await window.api.savePage({
      id: page.id,
      spaceId: page.space_id,
      title: page.title,
      content: page.content
    })
    setPages(prev => prev.map(p => p.id === page.id ? { ...p, title: page.title, content: page.content, updated_at: Date.now() } : p))
    return result as { ok: boolean; indexError?: string }
  }, [])

  async function deletePage(id: string) {
    if (!confirm('确定删除该页面？')) return
    await window.api.deletePage(id)
    if (activePage?.id === id) setActivePage(null)
    if (activeSpace) await loadPages(activeSpace)
  }

  async function deleteSource(id: string) {
    if (!confirm('确定删除该导入文件及其向量？原始文件不会被删除。')) return
    await window.api.deleteSource(id)
    if (activeSpace) await loadSources(activeSpace)
  }

  async function importFile() {
    if (!activeSpace) return
    const paths = await window.api.openFileDialog({
      properties: ['openFile'],
      filters: [{ name: '文档', extensions: ['pdf', 'docx', 'txt', 'md'] }]
    })
    if (!paths?.length) return
    const filePath = paths[0]
    const name = filePath.split(/[\\/]/).pop() || filePath
    setImportProgress({ sourceId: '', name, current: 0, total: 1 })
    try {
      await window.api.importFile({ spaceId: activeSpace, filePath, name })
      await loadSources(activeSpace)
    } catch (e) {
      alert('导入失败：' + (e as Error).message)
    } finally {
      setImportProgress(null)
    }
  }

  async function reindexSpace() {
    if (!activeSpace) return
    if (!confirm('重建该空间的所有向量索引？\n会先删除旧向量再重新向量化所有页面和导入文件。')) return
    setReindexing(true)
    try {
      const result = await window.api.reindexSpace(activeSpace)
      if (result.errors?.length) {
        alert(`重建完成，但有 ${result.errors.length} 项失败：\n` +
          result.errors.slice(0, 3).map((e: { name: string; error: string }) => `· ${e.name}: ${e.error}`).join('\n'))
      } else {
        alert(`重建完成，共处理 ${result.total} 项。`)
      }
    } catch (e) {
      alert('重建失败：' + (e as Error).message)
    } finally {
      setReindexing(false)
      setImportProgress(null)
    }
  }

  async function runSearch() {
    if (!searchQuery.trim()) return
    const results = await window.api.searchKb(searchQuery, activeSpace ? [activeSpace] : undefined)
    setSearchResults(results)
  }

  async function openSearchHit(hit: SearchHit) {
    if (hit.source.kind === 'page' && hit.source.pageId) {
      // Find & open the page
      let target = pages.find(p => p.id === hit.source.pageId)
      if (!target) {
        // Page may belong to a different space (when searching globally)
        if (hit.spaceId !== activeSpace) {
          setActiveSpace(hit.spaceId)
          await new Promise(r => setTimeout(r, 50))
          const fresh = await window.api.listPages(hit.spaceId)
          target = fresh.find((p: Page) => p.id === hit.source.pageId)
        }
      }
      if (target) {
        setActivePage(target)
        setTab('pages')
        setSearchResults(null)
        setHighlightSnippet(hit.content)
        setTimeout(() => setHighlightSnippet(null), 4000)
      }
    } else {
      // File source — switch to sources tab and highlight
      setTab('sources')
      setSearchResults(null)
    }
  }

  return (
    <div className="flex h-full">
      {/* Spaces sidebar */}
      <aside className="w-52 shrink-0 border-r border-border bg-sidebar flex flex-col">
        <div className="p-3 border-b border-border">
          <button
            onClick={createSpace}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 hover:bg-primary/20 text-sm transition-colors"
          >
            <Plus size={14} /> 新建空间
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {spaces.map(s => (
            <div
              key={s.id}
              onClick={() => setActiveSpace(s.id)}
              className={cn(
                'group flex items-center gap-2 px-2 py-2 rounded-md cursor-pointer text-sm',
                activeSpace === s.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50'
              )}
            >
              <FolderOpen size={13} className="shrink-0" />
              <span className="flex-1 truncate">{s.name}</span>
              {s.global_enabled === 1 && <span className="text-[10px] text-primary" title="全局上下文已开启">★</span>}
              <button
                onClick={(e) => { e.stopPropagation(); deleteSpace(s.id) }}
                className="opacity-0 group-hover:opacity-100 hover:text-destructive"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* Pages / Sources list */}
      <aside className="w-64 shrink-0 border-r border-border bg-card flex flex-col">
        {/* Search + global */}
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex gap-1">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
              placeholder="语义搜索…"
              className="flex-1 px-2 py-1 rounded-md bg-card border border-border text-xs outline-none focus:ring-1 focus:ring-ring"
            />
            <button onClick={runSearch} className="p-1 rounded text-muted-foreground hover:text-foreground">
              <Search size={14} />
            </button>
          </div>

          {activeSpace && !searchResults && (
            <>
              {/* Tabs */}
              <div className="flex rounded-md border border-border overflow-hidden text-xs">
                <button
                  onClick={() => setTab('pages')}
                  className={cn(
                    'flex-1 px-2 py-1 flex items-center justify-center gap-1 transition-colors',
                    tab === 'pages' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  <FileText size={11} /> 页面 {pages.length > 0 && <span className="text-muted-foreground/60">({pages.length})</span>}
                </button>
                <button
                  onClick={() => setTab('sources')}
                  className={cn(
                    'flex-1 px-2 py-1 flex items-center justify-center gap-1 transition-colors border-l border-border',
                    tab === 'sources' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                  )}
                >
                  <FileSpreadsheet size={11} /> 文件 {sources.length > 0 && <span className="text-muted-foreground/60">({sources.length})</span>}
                </button>
              </div>

              {tab === 'pages' ? (
                <button onClick={createPage} className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-primary/10 hover:bg-primary/20">
                  <Plus size={12} /> 新建页面
                </button>
              ) : (
                <button
                  onClick={importFile}
                  disabled={!!importProgress}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 rounded text-xs bg-card border border-border hover:bg-accent disabled:opacity-50"
                >
                  {importProgress ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                  {importProgress ? '导入中…' : '导入文件'}
                </button>
              )}

              {/* Import / reindex progress bar */}
              {importProgress && importProgress.total > 0 && (
                <div className="space-y-1">
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-300 rounded-full"
                      style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground text-center truncate" title={importProgress.name}>
                    {importProgress.name ? `${importProgress.name} · ` : ''}{importProgress.current}/{importProgress.total}
                  </p>
                </div>
              )}

              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={!!spaces.find(s => s.id === activeSpace)?.global_enabled}
                  onChange={() => {
                    const s = spaces.find(x => x.id === activeSpace)
                    if (s) toggleGlobal(s)
                  }}
                />
                <span className="flex-1">作为全局上下文</span>
                <button
                  onClick={reindexSpace}
                  disabled={reindexing}
                  title="重建该空间的全部向量索引（切换 Embedding 模型后用）"
                  className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  {reindexing ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                </button>
              </label>
            </>
          )}
        </div>

        {/* Content list area */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {searchResults ? (
            <div className="space-y-2">
              <button onClick={() => setSearchResults(null)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <ArrowLeft size={11} /> 返回列表
              </button>
              {searchResults.length === 0 ? (
                <p className="text-xs text-muted-foreground">没有匹配的结果。</p>
              ) : searchResults.map((r, i) => (
                <button
                  key={i}
                  onClick={() => openSearchHit(r)}
                  className="w-full text-left p-2 border border-border rounded text-xs hover:bg-accent transition-colors group"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    {r.source.kind === 'page' ? <FileText size={11} /> : <FileSpreadsheet size={11} />}
                    <span className="font-medium truncate flex-1">{r.source.title}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{r.score.toFixed(2)}</span>
                  </div>
                  <p className="text-muted-foreground line-clamp-3 leading-snug">{r.content}</p>
                </button>
              ))}
            </div>
          ) : tab === 'pages' ? (
            pages.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 p-2">暂无页面，点上方「新建页面」开始。</p>
            ) : pages.map(p => (
              <div
                key={p.id}
                onClick={() => setActivePage(p)}
                className={cn(
                  'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-sm',
                  activePage?.id === p.id
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/50'
                )}
              >
                <FileText size={12} className="shrink-0" />
                <span className="flex-1 truncate">{p.title || '未命名'}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deletePage(p.id) }}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          ) : (
            sources.length === 0 ? (
              <p className="text-xs text-muted-foreground/60 p-2">暂无导入文件，点上方「导入文件」开始。</p>
            ) : sources.map(s => (
              <div
                key={s.id}
                className="group flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors"
                title={s.file_path}
              >
                <FileSpreadsheet size={12} className="shrink-0 mt-0.5 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs truncate">{s.name}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {s.chunk_count} 片段 · {formatDate(s.created_at)}
                  </div>
                </div>
                <button
                  onClick={() => deleteSource(s.id)}
                  className="opacity-0 group-hover:opacity-100 hover:text-destructive shrink-0"
                  title="删除该导入及其向量"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Editor / source preview */}
      <div className="flex-1 overflow-hidden">
        {activePage ? (
          <PageEditor
            key={activePage.id}
            initial={activePage}
            onSave={savePageQuiet}
            highlightSnippet={highlightSnippet}
            onClose={() => setActivePage(null)}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            {activeSpace ? '选择或新建一个页面开始编辑。' : '请先在左侧选择一个知识空间。'}
          </div>
        )}
      </div>

      {inputDialog.element}
    </div>
  )
}

type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

function PageEditor({
  initial,
  onSave,
  highlightSnippet,
  onClose
}: {
  initial: Page
  onSave: (p: Page) => Promise<{ ok: boolean; indexError?: string }>
  highlightSnippet: string | null
  onClose: () => void
}) {
  const [title, setTitle] = useState(initial.title)
  const [content, setContent] = useState(initial.content)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [indexError, setIndexError] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedRef = useRef({ title: initial.title, content: initial.content })

  // Debounced auto-save: schedule a save 1.5s after the last edit
  useEffect(() => {
    if (title === lastSavedRef.current.title && content === lastSavedRef.current.content) {
      return
    }
    setStatus('pending')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => { void doSave() }, 1500)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [title, content]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doSave() {
    setStatus('saving')
    try {
      const result = await onSave({ ...initial, title, content })
      lastSavedRef.current = { title, content }
      setStatus('saved')
      setIndexError(result.indexError || null)
      setTimeout(() => setStatus(s => s === 'saved' ? 'idle' : s), 2000)
    } catch (e) {
      console.error('[kb] auto-save failed:', e)
      setStatus('error')
    }
  }

  // Save immediately when navigating away (close button / unmount)
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        if (title !== lastSavedRef.current.title || content !== lastSavedRef.current.content) {
          void onSave({ ...initial, title, content })
        }
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to highlighted snippet when navigating from search
  const previewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!highlightSnippet || mode !== 'preview') return
    // Tiny snippet — find first matching block via text search
    const root = previewRef.current
    if (!root) return
    const snippetStart = highlightSnippet.slice(0, 40).trim()
    if (!snippetStart) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      if ((node.textContent || '').includes(snippetStart)) {
        ;(node.parentElement as HTMLElement | null)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        break
      }
    }
  }, [highlightSnippet, mode])

  const dirty = title !== lastSavedRef.current.title || content !== lastSavedRef.current.content

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b border-border flex items-center gap-2">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="flex-1 bg-transparent text-lg font-semibold outline-none"
          placeholder="页面标题"
        />

        <SaveStatusBadge status={status} dirty={dirty} indexError={indexError} />

        {/* Mode toggle */}
        <div className="flex rounded-md border border-border overflow-hidden text-xs">
          <button
            onClick={() => setMode('edit')}
            className={cn('px-2 py-1 flex items-center gap-1', mode === 'edit' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}
            title="编辑模式"
          >
            <Edit3 size={11} /> 编辑
          </button>
          <button
            onClick={() => setMode('preview')}
            className={cn('px-2 py-1 flex items-center gap-1 border-l border-border', mode === 'preview' ? 'bg-accent' : 'text-muted-foreground hover:bg-accent/50')}
            title="预览模式"
          >
            <Eye size={11} /> 预览
          </button>
        </div>

        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>

      {mode === 'edit' ? (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="在此编写 Markdown 内容。停止输入 1.5 秒后自动保存并向量化。支持 # 标题、**粗体**、`代码`、- 列表 等。"
          className="flex-1 p-4 bg-transparent outline-none resize-none text-sm font-mono leading-relaxed"
        />
      ) : (
        <div ref={previewRef} className="flex-1 overflow-y-auto p-6">
          {content.trim() ? renderMarkdown(content) : (
            <p className="text-muted-foreground text-sm italic">（暂无内容，切回「编辑」模式开始写作）</p>
          )}
        </div>
      )}
    </div>
  )
}

function SaveStatusBadge({ status, dirty, indexError }: { status: SaveStatus; dirty: boolean; indexError: string | null }) {
  if (indexError) {
    return (
      <span className="text-[10px] text-amber-600 flex items-center gap-1" title={indexError}>
        已保存（向量化失败）
      </span>
    )
  }
  if (status === 'saving') return <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Loader2 size={10} className="animate-spin" /> 保存中…</span>
  if (status === 'saved') return <span className="text-[10px] text-green-600 flex items-center gap-1"><CheckCircle2 size={10} /> 已保存</span>
  if (status === 'error') return <span className="text-[10px] text-destructive">保存失败</span>
  if (status === 'pending' || dirty) return <span className="text-[10px] text-muted-foreground/60">未保存…</span>
  return <span className="text-[10px] text-muted-foreground/40">就绪</span>
}
