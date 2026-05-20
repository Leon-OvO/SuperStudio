import { useEffect, useRef, useState } from 'react'
import { RefreshCw, MonitorPlay, Globe, ExternalLink, AlertTriangle, Loader2, FolderOpen, Home } from 'lucide-react'
import { cn } from '../../lib/utils'

interface Props {
  projectPath: string | null
  refreshToken: number
}

type LoadState = 'idle' | 'loading' | 'loaded' | 'error'

export function PreviewPane({ projectPath, refreshToken }: Props) {
  const projectIndexUrl = projectPath ? toFileUrl(projectPath) : ''
  const [url, setUrl] = useState(projectIndexUrl)
  const [iframeKey, setIframeKey] = useState(0)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [loadError, setLoadError] = useState<string | null>(null)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  // CRITICAL: every time projectPath changes, hard-reset URL state.
  // We use projectPath itself as the dep instead of the derived URL,
  // because the URL function is pure and projectPath is the source of truth.
  useEffect(() => {
    const next = projectPath ? toFileUrl(projectPath) : ''
    console.log('[preview] project changed to:', projectPath, '→ url:', next)
    setUrl(next)
    setIframeKey(k => k + 1)
    setLoadState(projectPath ? 'idle' : 'idle')
    setLoadError(null)
  }, [projectPath])

  // External refresh signal
  useEffect(() => {
    if (refreshToken === 0) return
    console.log('[preview] refresh triggered, token=', refreshToken)
    setIframeKey(k => k + 1)
    setLoadState('idle')
    setLoadError(null)
  }, [refreshToken])

  // Watchdog
  useEffect(() => {
    if (loadState !== 'loading') return
    const t = setTimeout(() => {
      setLoadState('error')
      setLoadError('加载超时（8 秒未响应）— 可能是 local-file 协议被拒，看主进程日志的 [local-file] 行')
    }, 8000)
    return () => clearTimeout(t)
  }, [loadState, iframeKey])

  function resetToProjectIndex() {
    setUrl(projectIndexUrl)
    setIframeKey(k => k + 1)
    setLoadState('idle')
    setLoadError(null)
  }

  function openProjectInFolder() {
    if (projectPath) {
      window.api.showItemInFolder?.(projectPath).catch(() => {/* ignore */})
    }
  }

  if (!projectPath) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-xs h-full">
        <div className="text-center space-y-2">
          <MonitorPlay size={28} className="mx-auto text-muted-foreground/40" />
          <p>打开项目后这里会显示实时预览</p>
        </div>
      </div>
    )
  }

  // Highlight if user has typed something that doesn't match the project's own URL
  const urlMismatch = url !== projectIndexUrl && !url.startsWith('http://localhost') && !url.startsWith('https://localhost')

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Active project header — source of truth, always visible */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/60 bg-card/40 shrink-0">
        <FolderOpen size={11} className="text-amber-500 shrink-0" />
        <span className="text-[10px] uppercase text-muted-foreground/60">项目</span>
        <span className="text-[11px] font-mono truncate flex-1" title={projectPath}>{projectPath}</span>
        <button
          onClick={openProjectInFolder}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          title="在文件管理器中打开"
        >
          <ExternalLink size={11} />
        </button>
      </div>

      {/* URL bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border shrink-0">
        <Globe size={12} className={cn('shrink-0 ml-1', urlMismatch ? 'text-amber-500' : 'text-muted-foreground/60')} />
        <input
          type="text"
          value={url}
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setIframeKey(k => k + 1); setLoadState('idle') } }}
          className={cn(
            'flex-1 h-7 px-2 rounded bg-muted/40 text-[11px] font-mono outline-none focus:bg-card focus:ring-1 focus:ring-ring/20',
            urlMismatch && 'ring-1 ring-amber-500/40'
          )}
          placeholder="local-file://... 或 http://localhost:5173"
          spellCheck={false}
        />
        {urlMismatch && (
          <button
            onClick={resetToProjectIndex}
            className="h-7 px-2 rounded text-[10px] text-amber-600 hover:bg-amber-500/10 transition-colors flex items-center gap-1"
            title="重置为项目首页 index.html"
          >
            <Home size={10} /> 重置
          </button>
        )}
        <button
          onClick={() => { setIframeKey(k => k + 1); setLoadState('idle'); setLoadError(null) }}
          className="h-7 px-2 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="重新加载"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => window.open(url, '_blank')}
          className="h-7 px-2 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title="在外部浏览器打开"
        >
          <ExternalLink size={12} />
        </button>
      </div>

      {/* Status strip */}
      <div className={cn(
        'px-3 py-1 text-[10px] flex items-center gap-1.5 shrink-0 transition-colors',
        loadState === 'loaded' && 'bg-emerald-500/5 text-emerald-700 dark:text-emerald-400',
        loadState === 'loading' && 'bg-blue-500/5 text-blue-700 dark:text-blue-400',
        loadState === 'error' && 'bg-destructive/10 text-destructive',
        loadState === 'idle' && 'bg-muted/30 text-muted-foreground'
      )}>
        {loadState === 'loading' && <><Loader2 size={9} className="animate-spin" /> 加载中…</>}
        {loadState === 'loaded' && <>✓ 已加载</>}
        {loadState === 'error' && <><AlertTriangle size={10} /> {loadError ?? '加载失败'}</>}
        {loadState === 'idle' && <>就绪</>}
      </div>

      {/* iframe */}
      <div className="flex-1 bg-white relative">
        {url ? (
          <iframe
            ref={iframeRef}
            key={iframeKey}
            src={url}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            title="项目预览"
            onLoadStart={() => { setLoadState('loading'); console.log('[preview] iframe loading:', url) }}
            onLoad={() => { setLoadState('loaded'); setLoadError(null); console.log('[preview] iframe loaded:', url) }}
            onError={(e) => {
              setLoadState('error')
              setLoadError('iframe 加载报错（看 DevTools console）')
              console.error('[preview] iframe error:', e)
            }}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground/50 text-xs">
            输入 URL 或点击刷新
          </div>
        )}
      </div>
    </div>
  )
}

function toFileUrl(projectPath: string): string {
  const p = projectPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const m = p.match(/^([a-zA-Z]):\/(.*)$/)
  if (m) {
    const drive = m[1].toLowerCase()
    const rest = m[2].split('/').filter(Boolean).map(encodeURIComponent).join('/')
    return `local-file://${drive}/${rest}/index.html`
  }
  const encoded = p.split('/').filter(Boolean).map(encodeURIComponent).join('/')
  return `local-file:///${encoded}/index.html`
}
