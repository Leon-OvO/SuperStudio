import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  PanelLeftClose, PanelLeftOpen, FolderTree, ChevronRight, ChevronDown, Folder,
  Layers, Upload, RefreshCw, Search, Loader2, Film, X
} from 'lucide-react'
import { toLocalFileUrl } from '../../../lib/attachments'
import { toast } from '../../../components/ui/Toast'
import { Select } from '../../../components/ui/Select'
import type { GalleryItem } from '../../../../../shared/ipc-types'
import { useCanvasBridge } from '../CanvasBridge'
import { buildShotTree, type ShotTreeNode, type ShotTreeGroup } from './shot-tree'

/** MIME used for in-app asset drags from this tree to the canvas (see Canvas onDrop). */
export const ASSET_DRAG_MIME = 'application/x-canvas-asset'

type TypeFilter = 'all' | 'image' | 'video'

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

/**
 * LEFT pane — 素材 / 分镜树. Loads gallery items, derives a Shot→Group→file tree
 * (shot-tree.ts), and lets you click/drag an asset onto the canvas. Upload reuses
 * the existing gallery import.
 */
export function ShotTreePanel({ collapsed, onToggleCollapse }: {
  collapsed: boolean
  onToggleCollapse: () => void
}) {
  const bridge = useCanvasBridge()
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.api.listGallery({}) as GalleryItem[]
      // Re-approve every path so the local-file:// protocol renders (in-memory,
      // cleared on restart — same discipline as canvas loadCanvas).
      list.forEach(it => {
        if (it.filePath) window.api.approvePath?.(it.filePath)
        if (it.thumbnailPath) window.api.approvePath?.(it.thumbnailPath)
      })
      setItems(list)
    } catch { /* keep prior */ } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const upload = useCallback(async () => {
    try {
      const r = await window.api.importGallery() as { canceled: boolean; imported: number }
      if (r?.canceled) return
      if (r.imported > 0) { toast.success(`已导入 ${r.imported} 个素材`); void load() }
    } catch (e) { toast.error('导入失败：' + (e as Error).message) }
  }, [load])

  const tree = useMemo(() => {
    let r = items.filter(i => i.type !== 'audio') // canvas tree is visual assets only
    if (typeFilter !== 'all') r = r.filter(i => i.type === typeFilter)
    const q = query.trim().toLowerCase()
    if (q) r = r.filter(i => (i.sceneLabel || '').toLowerCase().includes(q) || (i.prompt || '').toLowerCase().includes(q) || baseName(i.filePath).toLowerCase().includes(q))
    return buildShotTree(r)
  }, [items, typeFilter, query])

  if (collapsed) {
    return (
      <div className="shrink-0 w-11 border-r border-border bg-card/40 flex flex-col items-center py-2 gap-2">
        <button onClick={onToggleCollapse} title="展开素材栏"
          className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/60">
          <PanelLeftOpen size={16} />
        </button>
        <FolderTree size={15} className="text-muted-foreground/50 mt-1" />
      </div>
    )
  }

  return (
    <div className="shrink-0 w-64 border-r border-border bg-card/40 flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 h-10 px-3 flex items-center gap-2 border-b border-border/60">
        <FolderTree size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium flex-1 truncate">素材 / 分镜</span>
        <button onClick={() => void load()} title="刷新" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        <button onClick={onToggleCollapse} title="收起素材栏" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/60">
          <PanelLeftClose size={15} />
        </button>
      </div>

      {/* Filters */}
      <div className="shrink-0 px-2.5 py-2 flex items-center gap-1.5 border-b border-border/40">
        <Select
          size="sm"
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as TypeFilter)}
          title="类型"
          options={[
            { value: 'all', label: '全部' },
            { value: 'image', label: '图片' },
            { value: 'video', label: '视频' },
          ]}
        />
        <div className="relative flex-1">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索素材"
            className="h-7 w-full pl-6 pr-6 text-xs rounded-md border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary/40"
          />
          {query && (
            <button onClick={() => setQuery('')} className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground/70 hover:text-foreground">
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-prominent py-1">
        {tree.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground/60 leading-relaxed">
            {loading ? '加载中…' : '还没有素材。点下方「上传」或在画布生成后会出现在这里。'}
          </div>
        ) : (
          tree.map(shot => <ShotRow key={shot.key} shot={shot} onPick={bridge.addAtCenter} />)
        )}
      </div>

      {/* Upload */}
      <div className="shrink-0 p-2 border-t border-border/60">
        <button onClick={upload}
          className="w-full flex items-center justify-center gap-1.5 h-8 text-xs rounded-lg border border-border bg-card hover:bg-accent/50 text-foreground transition-colors">
          <Upload size={13} /> 上传素材
        </button>
      </div>
    </div>
  )
}

function ShotRow({ shot, onPick }: { shot: ShotTreeNode; onPick: (p: string) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs hover:bg-accent/40 text-left">
        {open ? <ChevronDown size={12} className="text-muted-foreground/70 shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground/70 shrink-0" />}
        <Folder size={13} className="text-muted-foreground shrink-0" />
        <span className="flex-1 truncate font-medium">{shot.label}</span>
        <span className="text-[10px] text-muted-foreground/50 tabular-nums">{shot.count}</span>
      </button>
      {open && (
        <div>
          {shot.groups.map(g => <GroupRow key={g.key} group={g} onPick={onPick} />)}
          {shot.singles.map(it => <AssetLeaf key={it.id} item={it} indent={2} onPick={onPick} />)}
        </div>
      )}
    </div>
  )
}

function GroupRow({ group, onPick }: { group: ShotTreeGroup; onPick: (p: string) => void }) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 pl-5 pr-2.5 py-1 text-xs hover:bg-accent/40 text-left">
        {open ? <ChevronDown size={11} className="text-muted-foreground/60 shrink-0" /> : <ChevronRight size={11} className="text-muted-foreground/60 shrink-0" />}
        <Layers size={12} className="text-muted-foreground/80 shrink-0" />
        <span className="flex-1 truncate text-muted-foreground">{group.label}</span>
      </button>
      {open && group.items.map(it => <AssetLeaf key={it.id} item={it} indent={3} onPick={onPick} />)}
    </div>
  )
}

function AssetLeaf({ item, indent, onPick }: { item: GalleryItem; indent: number; onPick: (p: string) => void }) {
  const thumb = item.thumbnailPath || item.filePath
  const isVideo = item.type === 'video'
  const name = baseName(item.filePath)
  return (
    <button
      draggable
      onDragStart={e => {
        e.dataTransfer.setData(ASSET_DRAG_MIME, item.filePath)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={() => onPick(item.filePath)}
      title={`${name}（点击放到画布，或拖到画布）`}
      style={{ paddingLeft: indent * 14 + 6 }}
      className="w-full flex items-center gap-2 pr-2.5 py-1 hover:bg-accent/40 text-left group"
    >
      <span className="relative w-7 h-7 rounded bg-muted/50 overflow-hidden shrink-0 grid place-items-center">
        <img src={toLocalFileUrl(thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
        {isVideo && (
          <span className="absolute inset-0 grid place-items-center bg-black/30">
            <Film size={11} className="text-white" />
          </span>
        )}
      </span>
      <span className="flex-1 truncate text-[11px] text-foreground/90">{name}</span>
    </button>
  )
}
