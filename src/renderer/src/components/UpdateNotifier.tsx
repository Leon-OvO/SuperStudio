import { useEffect, useState } from 'react'
import { Download, X, Sparkles } from 'lucide-react'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  remoteVersion: string | null
  remoteName: string | null
  body: string | null
  releaseUrl: string
  error?: string
}

const DISMISS_KEY = 'updater:dismissedVersion'

/**
 * Floating bottom-right card that pops up when the main process detects a
 * newer release on Gitee. Persists across navigation — user has to click
 * "下载新版本" (opens the Gitee release page) or "稍后" to dismiss.
 *
 * Dismissal is per-version: if you skip 0.3.0, you'll still see the banner
 * when 0.3.1 ships. Stored in localStorage so the choice survives reloads.
 */
export function UpdateNotifier() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)

  useEffect(() => {
    const off = window.api.onUpdateAvailable?.((data: unknown) => {
      const u = data as UpdateInfo
      if (!u?.hasUpdate || !u.remoteVersion) return
      // Skip if user already dismissed this exact version
      const dismissed = localStorage.getItem(DISMISS_KEY)
      if (dismissed === u.remoteVersion) return
      setInfo(u)
    })
    return off
  }, [])

  if (!info) return null

  const handleDownload = () => {
    window.api.openReleasePage?.(info.releaseUrl)
    // Don't auto-dismiss — user may want to keep the card open as a reminder
    // until they finish reading the changelog.
  }

  const handleDismiss = () => {
    if (info.remoteVersion) {
      localStorage.setItem(DISMISS_KEY, info.remoteVersion)
    }
    setInfo(null)
  }

  return (
    <div className="fixed bottom-4 right-4 z-[250] w-[360px] rounded-xl border border-border bg-popover shadow-2xl overflow-hidden">
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-2">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Sparkles size={15} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">发现新版本 v{info.remoteVersion}</div>
          <div className="text-[11px] text-muted-foreground">
            当前 v{info.currentVersion}
            {info.remoteName ? ` · ${info.remoteName}` : ''}
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 text-muted-foreground hover:text-foreground -mt-1 -mr-1 p-1"
          title="忽略此版本"
        >
          <X size={14} />
        </button>
      </div>

      {info.body && (
        <div className="px-4 pb-2 max-h-[140px] overflow-y-auto">
          <pre className="text-[11px] text-muted-foreground/90 leading-relaxed whitespace-pre-wrap font-sans">
            {info.body.length > 600 ? info.body.slice(0, 600) + '…' : info.body}
          </pre>
        </div>
      )}

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-1.5 border-t border-border/60 mt-1">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity"
        >
          <Download size={11} />
          下载新版本
        </button>
        <button
          onClick={handleDismiss}
          className="px-3 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          稍后
        </button>
      </div>
    </div>
  )
}
