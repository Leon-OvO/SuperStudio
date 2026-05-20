import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import {
  Trash2, Image as ImageIcon, Video as VideoIcon, X, CheckSquare, Square, Search,
  ChevronLeft, ChevronRight, Copy, Download, FolderOpen, Check, ImagePlus, Wand2,
  FolderDown
} from 'lucide-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { GalleryItem } from '../../../../shared/ipc-types'
import { cn, formatDate } from '../../lib/utils'
import { copyImageToClipboard } from '../../lib/clipboard'
import { useImageContextMenu } from '../../components/ui/ImageContextMenu'
import { useUIStore } from '../../stores/ui'
import { Select } from '../../components/ui/Select'
import { ImageEditor } from '../../components/ui/ImageEditor'
import { useConfirmDialog } from '../../components/ui/ConfirmDialog'
import { toast } from '../../components/ui/Toast'

function toLocalUrl(p: string): string {
  const fwd = p.replace(/\\/g, '/').replace(/^\//, '')
  return `local-file:///${fwd}`
}

type Filter = 'all' | 'image' | 'video'
type Source = 'all' | 'chat' | 'workflow'

function getDateGroup(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  const day = 86400000
  if (diff < day && new Date(ts).getDate() === new Date().getDate()) return '今天'
  if (diff < 2 * day) return '昨天'
  const weekAgo = 7 * day
  if (diff < weekAgo) return '本周'
  return '更早'
}

const DATE_GROUP_ORDER = ['今天', '昨天', '本周', '更早']

export function GalleryPage() {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [source, setSource] = useState<Source>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [editorItem, setEditorItem] = useState<GalleryItem | null>(null)
  const ctxMenu = useImageContextMenu()
  const dlg = useConfirmDialog()
  const { setPendingChatAttachments, setPendingChatImageMode, setPage: setUIPage } = useUIStore()

  const useAsReference = useCallback((item: GalleryItem) => {
    if (item.type !== 'image') return
    const filename = item.filePath.split(/[\\/]/).pop() || 'reference.png'
    const ext = filename.split('.').pop()?.toLowerCase() || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
               : ext === 'webp' ? 'image/webp'
               : ext === 'gif' ? 'image/gif'
               : 'image/png'
    setPendingChatAttachments([{ name: filename, path: item.filePath, mimeType: mime }])
    setPendingChatImageMode(true)
    setUIPage('chat')
  }, [setPendingChatAttachments, setPendingChatImageMode, setUIPage])

  useEffect(() => { reload() }, [filter, source])

  async function reload() {
    setLoading(true)
    try {
      const filters: Record<string, string> = {}
      if (filter !== 'all') filters.type = filter
      if (source !== 'all') filters.source = source
      const data = await window.api.listGallery(filters)
      setItems(data)
      setSelected(new Set())
    } finally {
      setLoading(false)
    }
  }

  async function handleDelete(id: number) {
    if (!(await dlg.confirm({ message: '确定删除该项？', tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.deleteGalleryItem(id)
    await reload()
  }

  async function handleBatchDelete() {
    if (selected.size === 0) return
    if (!(await dlg.confirm({ message: `确定删除选中的 ${selected.size} 项？`, tone: 'danger', confirmLabel: '删除' }))) return
    await window.api.batchDeleteGallery(Array.from(selected))
    await reload()
  }

  async function handleBatchSave() {
    if (selected.size === 0) return
    const result = await window.api.batchSaveGallery(Array.from(selected))
    if (result.canceled) return
    const failed = result.failures?.length ?? 0
    if (failed > 0) {
      toast.error(`已保存 ${result.saved} 项到 ${result.targetDir}\n${failed} 项保存失败（源文件可能已被删除）`, { duration: 5000 })
    } else {
      toast.success(`已保存 ${result.saved} 项到 ${result.targetDir}`)
    }
  }

  function handleBatchUseAsReference() {
    if (selected.size === 0) return
    const imageItems = items.filter(i => selected.has(i.id) && i.type === 'image')
    if (imageItems.length === 0) {
      toast.info('选中的项目中没有图片')
      return
    }
    const attachments = imageItems.map(item => {
      const filename = item.filePath.split(/[\\/]/).pop() || 'reference.png'
      const ext = filename.split('.').pop()?.toLowerCase() || 'png'
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
                 : ext === 'webp' ? 'image/webp'
                 : ext === 'gif' ? 'image/gif'
                 : 'image/png'
      return { name: filename, path: item.filePath, mimeType: mime }
    })
    setPendingChatAttachments(attachments)
    setPendingChatImageMode(true)
    setUIPage('chat')
  }

  function toggleSelect(id: number) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id); else next.add(id)
    setSelected(next)
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    const q = query.toLowerCase()
    return items.filter(i => i.prompt.toLowerCase().includes(q))
  }, [items, query])

  function toggleAll() {
    if (selected.size === filtered.length) setSelected(new Set())
    else setSelected(new Set(filtered.map(i => i.id)))
  }

  const allSelected = useMemo(() => filtered.length > 0 && selected.size === filtered.length, [filtered, selected])

  // Group by date
  const grouped = useMemo(() => {
    const groups: Record<string, GalleryItem[]> = {}
    for (const item of filtered) {
      const g = getDateGroup(item.createdAt)
      if (!groups[g]) groups[g] = []
      groups[g].push(item)
    }
    return DATE_GROUP_ORDER.filter(g => groups[g]?.length).map(g => ({ label: g, items: groups[g] }))
  }, [filtered])

  function openPreview(item: GalleryItem) {
    const idx = filtered.findIndex(i => i.id === item.id)
    if (idx >= 0) setPreviewIndex(idx)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="px-6 py-3.5 border-b border-border flex items-center gap-3 shrink-0">
        <h2 className="text-base font-semibold">画廊</h2>

        {/* Search */}
        <div className="relative flex items-center ml-2 flex-1 max-w-xs">
          <Search size={12} className="absolute left-2.5 text-muted-foreground/50 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索提示词…"
            className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg bg-muted/60 border border-transparent focus:border-border focus:bg-background outline-none placeholder:text-muted-foreground/40 transition-all"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-2.5 text-muted-foreground/50 hover:text-muted-foreground">
              <X size={11} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 ml-auto text-xs">
          <FilterBtn active={filter === 'all'} onClick={() => setFilter('all')}>全部</FilterBtn>
          <FilterBtn active={filter === 'image'} onClick={() => setFilter('image')}>图片</FilterBtn>
          <FilterBtn active={filter === 'video'} onClick={() => setFilter('video')}>视频</FilterBtn>
        </div>
        <Select<Source>
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: '全部来源' },
            { value: 'chat', label: '对话' },
            { value: 'workflow', label: '工作流' }
          ]}
          size="sm"
          title="按来源筛选"
        />
      </header>

      {/* Toolbar */}
      {filtered.length > 0 && (
        <div className="px-6 py-2 border-b border-border/60 flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <button onClick={toggleAll} className="flex items-center gap-1.5 hover:text-foreground transition-colors">
            {allSelected ? <CheckSquare size={13} /> : <Square size={13} />}
            {allSelected ? '取消全选' : '全选'}
          </button>
          {selected.size > 0 ? (
            <>
              <span className="text-foreground/60">已选 {selected.size} 项</span>
              <div className="ml-auto flex items-center gap-3">
                <button
                  onClick={handleBatchUseAsReference}
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                  title="将选中的图片用作下次对话的参考图"
                >
                  <ImagePlus size={12} /> 用作参考图
                </button>
                <button
                  onClick={handleBatchSave}
                  className="flex items-center gap-1.5 hover:text-foreground transition-colors"
                  title="将选中项导出到本地文件夹"
                >
                  <FolderDown size={12} /> 保存到文件夹
                </button>
                <button
                  onClick={handleBatchDelete}
                  className="flex items-center gap-1.5 text-destructive hover:opacity-80 transition-opacity"
                >
                  <Trash2 size={12} /> 删除选中
                </button>
                <span className="text-muted-foreground/50">{filtered.length} 项</span>
              </div>
            </>
          ) : (
            <span className="ml-auto text-muted-foreground/50">{filtered.length} 项</span>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-center text-muted-foreground text-sm py-20">加载中…</p>
      ) : filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-muted-foreground text-sm">
            <p className="text-3xl mb-3">🖼️</p>
            <p>{query ? '未找到匹配的内容' : '暂无内容，去「对话」或「工作流」生成一些试试。'}</p>
          </div>
        </div>
      ) : (
        <VirtualGalleryGrid
          grouped={grouped}
          selectedIds={selected}
          onToggleSelect={toggleSelect}
          onPreviewItem={openPreview}
          onDeleteItem={handleDelete}
          onUseAsReference={useAsReference}
          onEditItem={setEditorItem}
          ctxMenu={ctxMenu}
        />
      )}

      {previewIndex !== null && filtered[previewIndex] && (
        <PreviewModal
          items={filtered}
          index={previewIndex}
          onIndexChange={setPreviewIndex}
          onClose={() => setPreviewIndex(null)}
          onUseAsReference={useAsReference}
          onEdit={(item) => { setEditorItem(item); setPreviewIndex(null) }}
          onDelete={async (id) => {
            await handleDelete(id)
            setPreviewIndex(null)
          }}
        />
      )}

      {ctxMenu.element}

      {editorItem && (
        <ImageEditor
          src={toLocalUrl(editorItem.filePath)}
          onClose={() => setEditorItem(null)}
          onApplied={() => reload()}
        />
      )}

      {dlg.element}
    </div>
  )
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-lg transition-all text-xs',
        active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}

interface CardProps {
  item: GalleryItem
  selected: boolean
  onToggle: () => void
  onPreview: () => void
  onDelete: () => void
  onUseAsReference?: () => void
  onEdit?: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

/** Detect Tailwind breakpoint columns from container width. Matches the
 *  original `grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5` recipe. */
function columnsForWidth(w: number): number {
  if (w >= 1280) return 5
  if (w >= 1024) return 4
  if (w >= 768) return 3
  return 2
}

type GridRow =
  | { kind: 'header'; label: string; itemCount: number }
  | { kind: 'items'; items: GalleryItem[] }

interface VirtualGridProps {
  grouped: Array<{ label: string; items: GalleryItem[] }>
  selectedIds: Set<number>
  onToggleSelect: (id: number) => void
  onPreviewItem: (item: GalleryItem) => void
  onDeleteItem: (id: number) => void
  onUseAsReference: (item: GalleryItem) => void
  onEditItem: (item: GalleryItem) => void
  ctxMenu: ReturnType<typeof useImageContextMenu>
}

/**
 * Virtualized gallery grid. Packs each group into a header row plus N item
 * rows of `cols` cells each. Column count + cell size react to the scroll
 * container width via ResizeObserver, matching the responsive Tailwind grid
 * the page used before virtualization.
 */
function VirtualGalleryGrid({
  grouped, selectedIds, onToggleSelect, onPreviewItem, onDeleteItem,
  onUseAsReference, onEditItem, ctxMenu
}: VirtualGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setContainerWidth(el.clientWidth)
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const PADDING_X = 24       // p-6 horizontal
  const GAP = 12             // gap-3
  const HEADER_H = 36        // section header row height including spacing
  const ROW_GAP = 12         // vertical gap between rows

  const cols = Math.max(1, columnsForWidth(containerWidth))
  const usable = Math.max(0, containerWidth - PADDING_X * 2 - GAP * (cols - 1))
  const cellSize = containerWidth > 0 ? Math.floor(usable / cols) : 200  // aspect-square: width === height

  // Build flat rows
  const rows = useMemo<GridRow[]>(() => {
    const out: GridRow[] = []
    for (const g of grouped) {
      out.push({ kind: 'header', label: g.label, itemCount: g.items.length })
      for (let i = 0; i < g.items.length; i += cols) {
        out.push({ kind: 'items', items: g.items.slice(i, i + cols) })
      }
    }
    return out
  }, [grouped, cols])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return HEADER_H
      return row.kind === 'header' ? HEADER_H : cellSize + ROW_GAP
    },
    overscan: 4,
    getItemKey: (index) => {
      const r = rows[index]
      if (!r) return index
      if (r.kind === 'header') return `h:${r.label}`
      return `i:${r.items.map(it => it.id).join(',')}`
    }
  })

  // Recompute estimateSize results when column geometry changes
  useEffect(() => {
    virtualizer.measure()
  }, [cols, cellSize, virtualizer])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-6">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map(v => {
          const row = rows[v.index]
          if (!row) return null
          return (
            <div
              key={v.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${v.start}px)`,
                height: v.size
              }}
            >
              {row.kind === 'header' ? (
                <h3 className="text-xs font-semibold text-muted-foreground/60 uppercase tracking-widest mb-3 pt-2">
                  {row.label}
                  <span className="ml-2 text-muted-foreground/40 font-normal normal-case tracking-normal">{row.itemCount}</span>
                </h3>
              ) : (
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    gap: `${GAP}px`
                  }}
                >
                  {row.items.map(item => (
                    <GalleryCard
                      key={item.id}
                      item={item}
                      selected={selectedIds.has(item.id)}
                      onToggle={() => onToggleSelect(item.id)}
                      onPreview={() => onPreviewItem(item)}
                      onDelete={() => onDeleteItem(item.id)}
                      onUseAsReference={item.type === 'image' ? () => onUseAsReference(item) : undefined}
                      onEdit={item.type === 'image' ? () => onEditItem(item) : undefined}
                      onContextMenu={(e) => {
                        if (item.type !== 'image') return
                        ctxMenu.open(e, {
                          filePath: item.filePath,
                          src: toLocalUrl(item.filePath),
                          onPreview: () => onPreviewItem(item),
                          onEdit: () => onEditItem(item)
                        })
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function GalleryCard({ item, selected, onToggle, onPreview, onDelete, onUseAsReference, onEdit, onContextMenu }: CardProps) {
  return (
    <div
      className={cn(
        'group relative aspect-square rounded-xl overflow-hidden border bg-card cursor-pointer transition-all duration-200',
        selected ? 'border-primary ring-2 ring-primary shadow-md' : 'border-border/60 shadow-sm hover:shadow-md hover:border-border'
      )}
      onContextMenu={onContextMenu}
    >
      <div onClick={onPreview} className="w-full h-full">
        {item.type === 'image' ? (
          <img
            src={toLocalUrl(item.filePath)}
            alt={item.prompt}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-muted">
            {item.thumbnailPath ? (
              <img src={toLocalUrl(item.thumbnailPath!)} alt="" className="w-full h-full object-cover" />
            ) : (
              <VideoIcon size={36} className="text-muted-foreground" />
            )}
            <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded-md bg-black/60 text-white text-[10px] font-medium">视频</div>
          </div>
        )}
      </div>

      {/* Checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        className={cn(
          'absolute top-2 left-2 w-5 h-5 rounded-md flex items-center justify-center text-white transition-opacity',
          selected ? 'opacity-100 bg-primary' : 'opacity-0 group-hover:opacity-100 bg-black/50 backdrop-blur-sm'
        )}
      >
        {selected ? <CheckSquare size={12} /> : <Square size={12} />}
      </button>

      {/* Top-right actions */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {onEdit && (
          <button
            onClick={(e) => { e.stopPropagation(); onEdit() }}
            title="编辑（局部修改 / 抠图 / 改字 / 扩图）"
            className="w-6 h-6 rounded-md bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-primary transition-colors"
          >
            <Wand2 size={11} />
          </button>
        )}
        {onUseAsReference && (
          <button
            onClick={(e) => { e.stopPropagation(); onUseAsReference() }}
            title="用作图片生成的参考图"
            className="w-6 h-6 rounded-md bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-primary transition-colors"
          >
            <ImagePlus size={11} />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          title="删除"
          className="w-6 h-6 rounded-md bg-black/40 backdrop-blur-sm flex items-center justify-center text-white hover:bg-destructive transition-colors"
        >
          <Trash2 size={11} />
        </button>
      </div>

      {/* Info overlay */}
      <div className="absolute bottom-0 inset-x-0 p-2.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent text-white opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="line-clamp-2 text-[11px] leading-snug">{item.prompt}</p>
        <p className="text-white/50 text-[10px] mt-1">{formatDate(item.createdAt)}</p>
      </div>
    </div>
  )
}

interface PreviewProps {
  items: GalleryItem[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
  onDelete: (id: number) => void
  onUseAsReference: (item: GalleryItem) => void
  onEdit: (item: GalleryItem) => void
}

function PreviewModal({ items, index, onIndexChange, onClose, onDelete, onUseAsReference, onEdit }: PreviewProps) {
  const item = items[index]
  const [toast, setToast] = useState<string | null>(null)
  const dlg = useConfirmDialog()

  const hasPrev = index > 0
  const hasNext = index < items.length - 1

  const go = useCallback((delta: number) => {
    const next = index + delta
    if (next < 0 || next >= items.length) return
    onIndexChange(next)
  }, [index, items.length, onIndexChange])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }, [])

  async function handleCopy() {
    if (item.type !== 'image') return
    const ok = await copyImageToClipboard(toLocalUrl(item.filePath))
    showToast(ok ? '已复制到剪贴板' : '复制失败')
  }

  async function handleSaveAs() {
    try {
      const result = await window.api.saveFileAs(item.filePath)
      if (!result.canceled) showToast('已保存')
    } catch (e) {
      showToast('保存失败：' + (e as Error).message)
    }
  }

  async function handleReveal() {
    try {
      await window.api.showItemInFolder(item.filePath)
    } catch (e) {
      showToast('打开失败：' + (e as Error).message)
    }
  }

  async function handleDeleteCurrent() {
    if (!(await dlg.confirm({ message: '确定删除当前项？', tone: 'danger', confirmLabel: '删除' }))) return
    onDelete(item.id)
  }

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'Escape') onClose()
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
        // Only intercept Ctrl/Cmd+C if user isn't selecting text
        const sel = window.getSelection()?.toString()
        if (!sel) {
          e.preventDefault()
          handleCopy()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, onClose]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null

  return (
    <div
      className="fixed inset-0 bg-black/85 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={onClose}
    >
      {/* Close */}
      <button
        onClick={onClose}
        title="关闭 (Esc)"
        className="absolute top-4 right-4 p-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors z-10"
      >
        <X size={18} />
      </button>

      {/* Position indicator */}
      <div className="absolute top-4 left-4 text-white/80 text-xs px-3 py-1.5 rounded-full bg-white/10 z-10 select-none">
        {index + 1} / {items.length}
      </div>

      {/* Prev */}
      {hasPrev && (
        <button
          onClick={(e) => { e.stopPropagation(); go(-1) }}
          title="上一张 (←)"
          className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors z-10"
        >
          <ChevronLeft size={22} />
        </button>
      )}
      {/* Next */}
      {hasNext && (
        <button
          onClick={(e) => { e.stopPropagation(); go(1) }}
          title="下一张 (→)"
          className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors z-10"
        >
          <ChevronRight size={22} />
        </button>
      )}

      {/* Content */}
      <div className="max-w-5xl max-h-full flex flex-col items-center gap-4 px-8" onClick={e => e.stopPropagation()}>
        {item.type === 'image' ? (
          <img
            key={item.id}
            src={toLocalUrl(item.filePath)}
            alt={item.prompt}
            className="max-h-[72vh] rounded-xl shadow-2xl object-contain"
          />
        ) : (
          <video
            key={item.id}
            src={toLocalUrl(item.filePath)}
            controls
            autoPlay
            className="max-h-[72vh] rounded-xl shadow-2xl"
          />
        )}

        {/* Action toolbar */}
        <div className="flex items-center gap-1.5 bg-white/10 backdrop-blur rounded-full p-1">
          {item.type === 'image' && (
            <>
              <ToolbarButton onClick={() => onEdit(item)} icon={<Wand2 size={13} />} label="编辑" />
              <ToolbarButton onClick={() => onUseAsReference(item)} icon={<ImagePlus size={13} />} label="用作参考图" />
              <ToolbarButton onClick={handleCopy} icon={<Copy size={13} />} label="复制" hint="Ctrl+C" />
            </>
          )}
          <ToolbarButton onClick={handleSaveAs} icon={<Download size={13} />} label="另存为" />
          <ToolbarButton onClick={handleReveal} icon={<FolderOpen size={13} />} label="文件夹中显示" />
          <ToolbarButton onClick={handleDeleteCurrent} icon={<Trash2 size={13} />} label="删除" danger />
        </div>

        {/* Metadata panel */}
        <div className="bg-card/90 backdrop-blur border border-border/60 rounded-xl p-4 max-w-2xl w-full text-sm space-y-1.5">
          <p className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            {item.type === 'image' ? <ImageIcon size={12} /> : <VideoIcon size={12} />}
            <span>{item.modelName || '未知模型'}</span>
            <span>·</span>
            <span>{formatDate(item.createdAt)}</span>
            <span>·</span>
            <span>{item.source === 'chat' ? '对话' : '工作流'}</span>
          </p>
          <p className="whitespace-pre-wrap break-words text-foreground/80">{item.prompt}</p>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-foreground/90 text-background px-3.5 py-1.5 rounded-lg text-xs shadow-lg flex items-center gap-1.5 z-20 pointer-events-none">
          <Check size={12} />
          {toast}
        </div>
      )}
      {dlg.element}
    </div>
  )
}

function ToolbarButton({
  onClick, icon, label, hint, danger
}: {
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint?: string
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      title={hint ? `${label} (${hint})` : label}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors text-white',
        danger ? 'hover:bg-destructive/80' : 'hover:bg-white/15'
      )}
    >
      {icon}
      {label}
    </button>
  )
}
