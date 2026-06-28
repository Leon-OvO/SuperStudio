import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Replacement for `window.confirm()`. Same shape as useInputDialog: hook
 * returns an imperative `confirm()` plus a `{element}` to drop into JSX.
 *
 *   const dlg = useConfirmDialog()
 *   if (!(await dlg.confirm('确定删除？'))) return
 *   if (!(await dlg.confirm({ message: '替换将清空本机数据', tone: 'danger' }))) return
 *   return <>{...}{dlg.element}</>
 */

interface ConfirmOptions {
  title?: string
  message: string
  /** Optional verbatim snippet (e.g. a shell command) shown in a dedicated
   *  monospace, wrapping, scrollable block — far more readable than cramming a
   *  long command into the prose message. Widens the dialog when present. */
  code?: string
  /** Small muted label above the code block (e.g. "将执行的命令"). */
  codeLabel?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'default' | 'danger'
}

interface DialogState extends ConfirmOptions {
  resolve: (value: boolean) => void
}

export function useConfirmDialog() {
  const [state, setState] = useState<DialogState | null>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback((opts: ConfirmOptions | string): Promise<boolean> => {
    const normalized: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts
    return new Promise(resolve => setState({ ...normalized, resolve }))
  }, [])

  useEffect(() => {
    if (!state) return
    const t = setTimeout(() => confirmBtnRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [state])

  function close(result: boolean) {
    state?.resolve(result)
    setState(null)
  }

  const element = state ? (
    <div
      className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 animate-overlay-in"
      onClick={() => close(false)}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); close(false) }
      }}
    >
      <div
        className={
          'bg-popover border border-border rounded-xl shadow-2xl max-w-full animate-dialog-in ' +
          (state.code ? 'w-[560px]' : 'w-[420px]')
        }
        onClick={e => e.stopPropagation()}
      >
        <div className="p-5 flex items-start gap-3">
          {state.tone === 'danger' && (
            <AlertTriangle size={20} className="text-destructive shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            {state.title && (
              <h3 className="font-semibold text-sm mb-2">{state.title}</h3>
            )}
            <p className="text-sm text-foreground/85 whitespace-pre-wrap break-words leading-relaxed max-h-[40vh] overflow-y-auto overflow-x-hidden">
              {state.message}
            </p>
            {state.code && (
              <div className="mt-3">
                {state.codeLabel && (
                  <div className="text-[11px] text-muted-foreground mb-1">{state.codeLabel}</div>
                )}
                <pre className="text-xs font-mono bg-muted/70 border border-border rounded-lg px-3 py-2.5 whitespace-pre-wrap break-all max-h-[34vh] overflow-y-auto leading-relaxed text-foreground/90 select-text">{state.code}</pre>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={() => close(false)}
            className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            {state.cancelLabel ?? '取消'}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => close(true)}
            className={
              'px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90 transition-opacity ' +
              (state.tone === 'danger'
                ? 'bg-destructive text-destructive-foreground'
                : 'bg-primary text-primary-foreground')
            }
          >
            {state.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { confirm, element }
}
