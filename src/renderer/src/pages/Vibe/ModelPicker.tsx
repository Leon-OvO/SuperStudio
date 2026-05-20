import { useEffect, useRef, useState } from 'react'
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
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.listProviders?.().then((ps: unknown) => setProviders((ps as ProviderConfig[]) ?? []))
  }, [])

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const activeProvider = providers.find(p => p.id === providerId)
  const label = activeProvider && modelId
    ? `${activeProvider.name} · ${modelId}`
    : '选择模型…'

  return (
    <div className="relative" ref={ref}>
      <button
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

      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-[360px] max-h-[500px] overflow-y-auto rounded-lg border border-border bg-popover shadow-2xl py-1">
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
        </div>
      )}
    </div>
  )
}
