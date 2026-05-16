import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'

/**
 * Replacement for `window.prompt()` which is disabled in Electron.
 * Usage:
 *   const dlg = useInputDialog()
 *   const name = await dlg.ask({ title: '空间名称', placeholder: '例如 产品文档' })
 *   if (name) { ... }
 *   ...
 *   return <>{...}{dlg.element}</>
 */

interface AskOptions {
  title: string
  description?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  validate?: (value: string) => string | null
}

interface DialogState extends AskOptions {
  resolve: (value: string | null) => void
}

export function useInputDialog() {
  const [state, setState] = useState<DialogState | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const ask = useCallback((opts: AskOptions): Promise<string | null> => {
    return new Promise(resolve => {
      setValue(opts.defaultValue ?? '')
      setError(null)
      setState({ ...opts, resolve })
    })
  }, [])

  // Auto-focus when opened
  useEffect(() => {
    if (!state) return
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 30)
    return () => clearTimeout(t)
  }, [state])

  function close(result: string | null) {
    state?.resolve(result)
    setState(null)
  }

  function handleConfirm() {
    const trimmed = value.trim()
    if (!trimmed) {
      setError('请输入内容')
      return
    }
    if (state?.validate) {
      const err = state.validate(trimmed)
      if (err) {
        setError(err)
        return
      }
    }
    close(trimmed)
  }

  const element = state ? (
    <div
      className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => close(null)}
    >
      <div
        className="bg-popover border border-border rounded-xl shadow-2xl w-[400px] max-w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 p-4 border-b border-border">
          <h3 className="flex-1 font-semibold text-sm">{state.title}</h3>
          <button onClick={() => close(null)} className="text-muted-foreground hover:text-foreground">
            <X size={14} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {state.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{state.description}</p>
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={e => { setValue(e.target.value); if (error) setError(null) }}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleConfirm() }
              else if (e.key === 'Escape') { e.preventDefault(); close(null) }
            }}
            placeholder={state.placeholder}
            className="w-full px-3 py-2 rounded-md border border-border bg-card text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={() => close(null)}
            className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground font-medium hover:opacity-90 transition-opacity"
          >
            {state.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { ask, element }
}
