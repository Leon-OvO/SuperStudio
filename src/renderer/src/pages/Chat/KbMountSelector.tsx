import { useEffect, useState } from 'react'
import { BookOpen, X } from 'lucide-react'
import { cn } from '../../lib/utils'

interface Space {
  id: string
  name: string
  global_enabled: number
}

interface Props {
  mountedIds: string[]
  onChange: (ids: string[]) => void
}

export function KbMountSelector({ mountedIds, onChange }: Props) {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    window.api.listSpaces().then(setSpaces)
  }, [open])

  const toggle = (id: string) => {
    onChange(mountedIds.includes(id) ? mountedIds.filter(x => x !== id) : [...mountedIds, id])
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        title="挂载知识空间"
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded text-xs border transition-colors',
          mountedIds.length
            ? 'border-primary/60 bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80'
        )}
      >
        <BookOpen size={12} />
        {mountedIds.length > 0 ? `知识库 (${mountedIds.length})` : '知识库'}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full mb-1 left-0 z-20 bg-popover border border-border rounded-lg shadow-lg p-2 min-w-[180px] max-h-60 overflow-y-auto">
            <div className="flex items-center justify-between mb-1 px-1">
              <span className="text-xs font-medium text-muted-foreground">挂载知识空间</span>
              <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
                <X size={12} />
              </button>
            </div>
            {spaces.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">暂无知识空间</p>
            ) : spaces.map(s => (
              <label key={s.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-accent cursor-pointer text-xs">
                <input
                  type="checkbox"
                  checked={mountedIds.includes(s.id)}
                  onChange={() => toggle(s.id)}
                  className="rounded"
                />
                <span className="flex-1 truncate">{s.name}</span>
                {s.global_enabled === 1 && (
                  <span className="text-[10px] text-primary shrink-0">全局</span>
                )}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
