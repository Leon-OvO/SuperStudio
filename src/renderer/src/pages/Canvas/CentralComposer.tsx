import { useEffect, useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import { GenPromptBar, applyScene, type ImageCardData } from './canvas-nodes'
import { useCanvasBridge } from './CanvasBridge'

/**
 * Central composer — a floating island for canvas-wide generation. Collapsed to a
 * pill by default (the canvas must not open with an input box). When expanded it
 * renders the SAME GenPromptBar used under nodes (inline @ chips, identical look).
 * Generate merges the selected node(s) with the @-introduced refs; with no
 * selection it fans at center.
 */
export function CentralComposer() {
  const bridge = useCanvasBridge()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')   // persisted prompt — survives generate / remount

  // Escape collapses the composer (GenPromptBar stops Esc when its @ menu is open).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const handleSubmit = (p: string, count: number, size: string, quality: string, scene: string, refs: string[]) => {
    const prompt = applyScene(scene, p)
    const selPaths = bridge.selImageNodes.map(n => (n.data as ImageCardData).path).filter((x): x is string => !!x)
    const allRefs = [...new Set([...selPaths, ...refs])]
    // @'d images that are canvas nodes → connect them to the result (visible reference).
    const refNodeIds = refs.map(path => bridge.nodes.find(n => (n.data as ImageCardData | undefined)?.path === path)?.id).filter((id): id is string => !!id)
    const sources = [...new Set([...bridge.selectedIds, ...refNodeIds])]
    setBusy(true)
    try {
      if (sources.length && allRefs.length) bridge.runImageGen(allRefs, prompt, count, sources, size, quality)
      else bridge.runImageGenStandalone(allRefs, prompt, count, size, quality)
    } finally {
      setTimeout(() => setBusy(false), 400)
    }
  }

  // Default (collapsed): a small trigger pill, no open input box.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        onPointerDown={e => e.stopPropagation()}
        title="生成图片（「@」引入参考）"
        className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 pl-3 pr-4 h-10 rounded-full bg-card/95 backdrop-blur-md border border-border shadow-[0_8px_30px_rgba(0,0,0,0.12)] hover:border-primary/40 hover:shadow-xl transition-all text-sm text-muted-foreground"
      >
        <Sparkles size={15} className="text-primary" />
        <span>描述生成图片，「@」引入参考</span>
      </button>
    )
  }

  return (
    <div onPointerDown={e => e.stopPropagation()} className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-30">
      <div className="relative">
        <button onClick={() => setOpen(false)} title="收起（Esc）"
          className="absolute -top-2 -right-2 z-40 w-6 h-6 grid place-items-center rounded-full bg-card border border-border shadow text-muted-foreground hover:text-foreground hover:bg-accent">
          <X size={13} />
        </button>
        <GenPromptBar busy={busy} placeholder="描述要生成的画面…「@」引入参考图"
          value={draft} onChange={setDraft} onSubmit={handleSubmit} />
      </div>
    </div>
  )
}
