import { useEffect, useState } from 'react'
import { X, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toLocalFileUrl } from '../../lib/attachments'
import type { GalleryItem } from '../../../../shared/ipc-types'

/** Pick one or more images from the 素材库 — for a new card, or to add into a
 *  reference stack. Multi-select with an ordered index badge (reference order). */
export function GalleryPickerDialog({ onConfirm, onClose }: { onConfirm: (paths: string[]) => void; onClose: () => void }) {
  const [items, setItems] = useState<GalleryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    window.api.listGallery({ type: 'image' })
      .then((data: GalleryItem[]) => { if (!cancelled) setItems(data.filter(it => it.type === 'image')) })
      .catch(() => { /* keep empty */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const toggle = (p: string) => setSel(s => s.includes(p) ? s.filter(x => x !== p) : [...s, p])
  const confirm = () => { if (sel.length) onConfirm(sel); onClose() }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="w-[560px] max-w-full max-h-[78vh] flex flex-col bg-popover border border-border rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border">
          <h3 className="text-sm font-semibold flex-1">从素材库选图</h3>
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground"><X size={15} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="text-center text-xs text-muted-foreground py-10">加载中…</div>
          ) : items.length === 0 ? (
            <div className="text-center text-xs text-muted-foreground/80 py-10 leading-relaxed">素材库还没有图片。<br />可以直接把本地图片拖到画布上。</div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {items.map(it => {
                const idx = sel.indexOf(it.filePath)
                const picked = idx >= 0
                return (
                  <button
                    key={it.id}
                    onClick={() => toggle(it.filePath)}
                    className={cn('relative aspect-square rounded-lg overflow-hidden border transition-all',
                      picked ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/60')}
                  >
                    <img src={toLocalFileUrl(it.thumbnailPath || it.filePath)} alt="" loading="lazy" className="w-full h-full object-cover" />
                    {picked && (
                      <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[11px] grid place-items-center font-medium">{idx + 1}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border bg-muted/20">
          <span className="text-xs text-muted-foreground flex-1">已选 {sel.length} 张</span>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-accent/50">取消</button>
          <button onClick={confirm} disabled={!sel.length}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:opacity-90 disabled:opacity-40">
            <Check size={14} /> 添加{sel.length ? ` ${sel.length} 张` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
