import { useEffect, useState } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Global toast singleton — replaces ad-hoc alert() popups.
 *
 *   import { toast } from '@/components/ui/Toast'
 *   toast.success('已保存')
 *   toast.error('保存失败：' + err.message)
 *   toast.info('已导出 3 项', { duration: 4000 })
 *
 * Mount <ToastHost /> once near the app root.
 */

type ToastTone = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  tone: ToastTone
  duration: number
}

interface ToastOptions {
  duration?: number
}

let listeners: Array<(t: ToastItem) => void> = []
let nextId = 1

function push(message: string, tone: ToastTone, opts?: ToastOptions) {
  // Errors linger longer by default — they're worth reading
  const defaultDuration = tone === 'error' ? 4500 : 2400
  const item: ToastItem = {
    id: nextId++,
    message,
    tone,
    duration: opts?.duration ?? defaultDuration
  }
  listeners.forEach(l => l(item))
}

export const toast = {
  success: (msg: string, opts?: ToastOptions) => push(msg, 'success', opts),
  error: (msg: string, opts?: ToastOptions) => push(msg, 'error', opts),
  info: (msg: string, opts?: ToastOptions) => push(msg, 'info', opts),
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])

  useEffect(() => {
    const l = (t: ToastItem) => {
      setItems(prev => [...prev, t])
      setTimeout(() => {
        setItems(prev => prev.filter(x => x.id !== t.id))
      }, t.duration)
    }
    listeners.push(l)
    return () => { listeners = listeners.filter(x => x !== l) }
  }, [])

  if (items.length === 0) return null

  return (
    <div className="fixed top-12 right-4 z-[300] flex flex-col gap-2 pointer-events-none max-w-[420px]">
      {items.map(t => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 px-3 py-2 rounded-lg shadow-lg border text-sm',
            t.tone === 'success' && 'bg-emerald-50 border-emerald-200 text-emerald-900 dark:bg-emerald-950/60 dark:border-emerald-800 dark:text-emerald-100',
            t.tone === 'error' && 'bg-destructive/10 border-destructive/30 text-destructive',
            t.tone === 'info' && 'bg-popover border-border text-foreground'
          )}
        >
          {t.tone === 'success' && <CheckCircle2 size={14} className="shrink-0 mt-0.5" />}
          {t.tone === 'error' && <AlertCircle size={14} className="shrink-0 mt-0.5" />}
          {t.tone === 'info' && <Info size={14} className="shrink-0 mt-0.5" />}
          <span className="flex-1 whitespace-pre-wrap break-words">{t.message}</span>
          <button
            onClick={() => setItems(prev => prev.filter(x => x.id !== t.id))}
            className="text-muted-foreground/60 hover:text-foreground -mr-1 mt-0.5 shrink-0"
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
