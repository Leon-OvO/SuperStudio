import { useEffect, useState } from 'react'
import { Download, RefreshCw, X, Loader2, AlertCircle } from 'lucide-react'

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'disabled'; reason: string }

/**
 * Bottom-right floating toast for auto-update state. Renders only when the
 * status is something the user can act on — available / downloading / ready
 * / error — and stays out of the way otherwise.
 */
export function UpdateToast() {
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Pull current status on mount (in case the event already fired before
    // the component subscribed) and subscribe to future changes.
    window.api.getUpdateStatus?.().then((s: UpdateStatus) => s && setStatus(s)).catch(() => {})
    const unsub = window.api.onUpdateStatus?.((s: unknown) => {
      setStatus(s as UpdateStatus)
      setDismissed(false)  // reset dismissal when state changes
    })
    return () => { unsub?.() }
  }, [])

  if (dismissed) return null
  if (status.kind === 'idle' || status.kind === 'not-available' || status.kind === 'disabled' || status.kind === 'checking') return null

  return (
    <div className="fixed bottom-4 right-4 z-[200] max-w-sm bg-popover border border-border rounded-lg shadow-xl text-sm overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <div className="shrink-0 mt-0.5">
          {status.kind === 'available' && <Download size={16} className="text-primary" />}
          {status.kind === 'downloading' && <Loader2 size={16} className="text-primary animate-spin" />}
          {status.kind === 'ready' && <RefreshCw size={16} className="text-green-600" />}
          {status.kind === 'error' && <AlertCircle size={16} className="text-destructive" />}
        </div>

        <div className="flex-1 min-w-0">
          {status.kind === 'available' && (
            <>
              <p className="font-medium">发现新版本 v{status.version}</p>
              <p className="text-xs text-muted-foreground mt-0.5">正在后台下载…</p>
            </>
          )}
          {status.kind === 'downloading' && (
            <>
              <p className="font-medium">正在下载更新</p>
              <div className="mt-1.5 h-1 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${status.percent}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">{status.percent}%</p>
            </>
          )}
          {status.kind === 'ready' && (
            <>
              <p className="font-medium">更新已就绪：v{status.version}</p>
              <p className="text-xs text-muted-foreground mt-0.5">重启应用即可完成升级。</p>
              <button
                onClick={() => window.api.installUpdate?.()}
                className="mt-2 px-3 py-1 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90"
              >
                重启并安装
              </button>
            </>
          )}
          {status.kind === 'error' && (
            <>
              <p className="font-medium">更新检查失败</p>
              <p className="text-xs text-muted-foreground mt-0.5 break-words">{status.message}</p>
            </>
          )}
        </div>

        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 p-1 -mr-1 text-muted-foreground hover:text-foreground rounded"
          title="稍后提示"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  )
}
