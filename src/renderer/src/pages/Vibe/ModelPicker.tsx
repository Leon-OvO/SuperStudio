import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Bot, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ProviderConfig } from '../../../../shared/ipc-types'

interface Props {
  projectPath: string | null
  providerId: string | null
  modelId: string | null
  onChange: (providerId: string, modelId: string) => void
}

export function ModelPicker({ providerId, modelId, onChange }: Props) {
  const [providers, setProviders] = useState<ProviderConfig[]>([])
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  // Anchor position is computed in layout so the portal lands at the right spot
  // even when the trigger sits inside a transformed/clipped parent (Vibe page
  // has iframe + Monaco editor, both create new stacking contexts).
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    window.api.listProviders?.().then((ps: unknown) => setProviders((ps as ProviderConfig[]) ?? []))
  }, [])

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const update = () => {
      const r = btnRef.current!.getBoundingClientRect()
      const POP_W = 360
      const MARGIN = 8
      // Prefer aligning the popover's left edge with the button's left edge.
      // But clamp into the viewport so the right side never gets clipped —
      // common case: this ModelPicker sits in the Vibe header on the right
      // side of the screen, so r.left + 360 easily overflows.
      const maxLeft = window.innerWidth - POP_W - MARGIN
      const left = Math.max(MARGIN, Math.min(r.left, maxLeft))
      setPos({ top: r.bottom + 4, left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const activeProvider = providers.find(p => p.id === providerId)
  const label = activeProvider && modelId
    ? `${activeProvider.name} · ${modelId}`
    : '选择模型…'

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border text-xs transition-colors hover:bg-accent',
          open && 'bg-accent'
        )}
        title="选择模型"
      >
        <Bot size={11} className="text-violet-500 shrink-0" />
        <span className="font-medium max-w-[260px] truncate">{label}</span>
        <ChevronDown size={10} className={cn('transition-transform', open && 'rotate-180')} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
          className="w-[360px] max-h-[500px] overflow-y-auto rounded-lg border border-border bg-popover shadow-2xl py-1"
        >
          {providers.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-muted-foreground text-center">
              暂无可用 provider —— 请先到「账号」中初始化
            </div>
          ) : (
            providers.map(p => (
              <div key={p.id}>
                <div className="px-3 py-1.5 text-[10px] uppercase text-muted-foreground/60 sticky top-0 bg-popover">
                  {p.name} <span className="opacity-50 normal-case">· {p.type}</span>
                </div>
                {p.models.length === 0 ? (
                  <div className="px-3 py-1 text-[11px] text-muted-foreground/60 italic">
                    无可用模型 (到「设置 → 模型」点 🔁 拉取)
                  </div>
                ) : p.models.map(m => {
                  const isActive = p.id === providerId && m === modelId
                  return (
                    <button
                      key={`${p.id}::${m}`}
                      onClick={() => { onChange(p.id, m); setOpen(false) }}
                      className={cn(
                        'w-full text-left px-4 py-1.5 text-xs flex items-center gap-2 hover:bg-accent',
                        isActive && 'bg-primary/10'
                      )}
                    >
                      <span className="flex-1 font-mono truncate">{m}</span>
                      {isActive && <Check size={11} className="text-primary" />}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>,
        document.body
      )}
    </>
  )
}
