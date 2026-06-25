import { useEffect, useMemo, useState } from 'react'
import type { Node } from '@xyflow/react'
import { AtSign, Image as ImageIcon, Layers, FolderOpen } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toLocalFileUrl } from '../../lib/attachments'
import type { GalleryItem } from '../../../../shared/ipc-types'
import type { ImageCardData, RefStackData } from './canvas-nodes'
import type { InlineRef } from '../Chat/RichComposer'

/** Max 素材库 results per @ query — empty query lists recent (mirrors Chat). */
const MENTION_GALLERY_LIMIT = 40

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p
const mimeOf = (p: string): string => {
  const ext = (p.split('.').pop() || '').toLowerCase()
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg'
}
const imageRef = (path: string, label: string): InlineRef => ({ kind: 'image', path, label, mime: mimeOf(path) })

interface PickerItem { key: string; label: string; group: string; thumb?: string; icon?: React.ReactNode; resolve: () => InlineRef[] | Promise<InlineRef[]> }

/**
 * @-mention PICKER for the canvas prompt bar (RichComposer host). Given the active
 * @query + the canvas nodes, it surfaces reference IMAGES from: 画布图片 /
 * 参考组 / 素材库 (browsable, empty query = recent — aligns with Chat) / 本地文件.
 * Picking calls `onInsert(InlineRef[])`, which the host turns into inline chips via
 * RichComposer.insertRef. Returns the menu node + keyboard handler.
 */
export function useCanvasMentionPicker({ query, nodes, onInsert }: {
  query: string | null
  nodes: Node[]
  onInsert: (refs: InlineRef[]) => void
}) {
  const [gallery, setGallery] = useState<GalleryItem[]>([])
  const [hi, setHi] = useState(0)
  const open = query !== null

  // Browse 素材库 whenever the @ menu is open (empty query → recent), debounced.
  useEffect(() => {
    if (query == null) { setGallery([]); return }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await window.api.searchGallery(query, MENTION_GALLERY_LIMIT) as GalleryItem[]
        if (!cancelled) setGallery((r || []).filter(i => i.type === 'image'))
      } catch { if (!cancelled) setGallery([]) }
    }, 180)
    return () => { cancelled = true; clearTimeout(t) }
  }, [query])

  const items = useMemo<PickerItem[]>(() => {
    if (!open) return []
    const q = (query ?? '').toLowerCase()
    const out: PickerItem[] = []
    for (const n of nodes) {
      if (n.type !== 'image_card') continue
      const d = n.data as ImageCardData
      if (!d.path || d.kind === 'video' || d.status === 'generating' || d.status === 'error') continue
      const label = (typeof d.prompt === 'string' && d.prompt.trim()) ? d.prompt.trim().slice(0, 20) : baseName(d.path)
      if (q && !label.toLowerCase().includes(q)) continue
      const path = d.path
      out.push({ key: `c:${n.id}`, label, group: '画布图片', thumb: path, icon: <ImageIcon size={11} />, resolve: () => [imageRef(path, label)] })
    }
    for (const n of nodes) {
      if (n.type !== 'ref_stack') continue
      const sr = (n.data as RefStackData).refs || []
      if (!sr.length) continue
      const label = `参考组 · ${sr.length} 张`
      if (q && !label.toLowerCase().includes(q)) continue
      out.push({ key: `s:${n.id}`, label, group: '参考组', thumb: sr[0], icon: <Layers size={11} />, resolve: () => sr.map(p => imageRef(p, baseName(p))) })
    }
    for (const g of gallery) {
      const label = (g.prompt?.trim() || baseName(g.filePath)).slice(0, 20)
      out.push({ key: `g:${g.id}`, label, group: '素材库', thumb: g.thumbnailPath || g.filePath, icon: <ImageIcon size={11} />, resolve: async () => { await window.api.approvePath?.(g.filePath); return [imageRef(g.filePath, label)] } })
    }
    out.push({ key: 'local', label: '从本地选择图片…', group: '本地', icon: <FolderOpen size={11} />, resolve: async () => {
      const paths = await window.api.openFileDialog({ properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] }) as string[] | undefined
      if (!paths?.length) return []
      for (const p of paths) await window.api.approvePath?.(p)
      return paths.map(p => imageRef(p, baseName(p)))
    } })
    return out
  }, [open, query, nodes, gallery])

  useEffect(() => { setHi(0) }, [query, open])

  const pick = async (it: PickerItem) => { const refs = await it.resolve(); if (refs.length) onInsert(refs) }

  /** Consume ↑↓ / Enter / Tab while the menu is open. Returns true if handled. */
  const handleKeyDown = (e: React.KeyboardEvent): boolean => {
    if (!open || !items.length) return false
    if (e.key === 'ArrowDown') { setHi(h => (h + 1) % items.length); return true }
    if (e.key === 'ArrowUp') { setHi(h => (h - 1 + items.length) % items.length); return true }
    if (e.key === 'Enter' || e.key === 'Tab') { void pick(items[Math.min(hi, items.length - 1)]); return true }
    return false
  }

  const menu = (open && items.length > 0) ? (
    <div className="absolute bottom-full left-3 mb-2 w-72 max-h-72 overflow-auto rounded-xl border border-border bg-popover shadow-xl py-1 z-30">
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/60 flex items-center gap-1"><AtSign size={9} /> 引入参考图</div>
      {items.map((it, i) => {
        const showGroup = i === 0 || items[i - 1].group !== it.group
        return (
          <div key={it.key}>
            {showGroup && <div className="px-3 pt-1 pb-0.5 text-[10px] text-muted-foreground/50">{it.group}</div>}
            <button
              onMouseEnter={() => setHi(i)}
              onMouseDown={e => { e.preventDefault(); void pick(it) }}
              className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-left', i === hi ? 'bg-accent' : 'hover:bg-accent/50')}
            >
              {it.thumb
                ? <img src={toLocalFileUrl(it.thumb)} alt="" className="w-6 h-6 rounded object-cover shrink-0 bg-muted/50" />
                : <span className="w-6 h-6 rounded grid place-items-center bg-muted/50 text-muted-foreground shrink-0">{it.icon}</span>}
              <span className="flex-1 truncate text-[12px]">{it.label}</span>
            </button>
          </div>
        )
      })}
    </div>
  ) : null

  return { open, menu, handleKeyDown }
}
