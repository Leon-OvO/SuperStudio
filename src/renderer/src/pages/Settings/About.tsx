import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Check, AlertCircle, Sparkles, ExternalLink, Database, Download, Upload } from 'lucide-react'

interface UpdateStatusView {
  kind: string
  version?: string
  percent?: number
  message?: string
  reason?: string
}

interface Props {
  onExportData: () => void
  onImportData: () => void
  exportRunning?: boolean
  importRunning?: boolean
}

export function About({ onExportData, onImportData, exportRunning, importRunning }: Props) {
  const [version, setVersion] = useState<string>('')
  const [status, setStatus] = useState<UpdateStatusView>({ kind: 'idle' })
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.api.appVersion?.().then((v: string) => setVersion(v)).catch(() => {})
    window.api.getUpdateStatus?.().then((s: UpdateStatusView) => s && setStatus(s)).catch(() => {})
    const unsub = window.api.onUpdateStatus?.((s: unknown) => setStatus(s as UpdateStatusView))
    return () => { unsub?.() }
  }, [])

  async function manualCheck() {
    setChecking(true)
    try {
      await window.api.checkForUpdates?.()
    } finally {
      // The actual state will arrive via onUpdateStatus; clear the spinner soon after
      setTimeout(() => setChecking(false), 1500)
    }
  }

  function statusLabel(): { tone: 'idle' | 'good' | 'work' | 'bad' | 'mute'; text: string } {
    switch (status.kind) {
      case 'idle':           return { tone: 'idle', text: '尚未检查' }
      case 'checking':       return { tone: 'work', text: '正在检查更新…' }
      case 'available':      return { tone: 'work', text: `发现新版本 v${status.version}，正在后台下载` }
      case 'not-available':  return { tone: 'good', text: '当前已是最新版本' }
      case 'downloading':    return { tone: 'work', text: `下载中 ${status.percent ?? 0}%` }
      case 'ready':          return { tone: 'good', text: `v${status.version} 已就绪，重启即安装` }
      case 'error':          return { tone: 'bad',  text: `检查失败：${status.message ?? '未知错误'}` }
      case 'disabled':       return { tone: 'mute', text: status.reason ?? '已禁用' }
      default:               return { tone: 'idle', text: status.kind }
    }
  }

  const label = statusLabel()

  return (
    <div className="space-y-6 max-w-2xl">
      <header className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center shadow-md shadow-primary/30">
          <Sparkles size={18} className="text-primary-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">SuperStudio</h2>
          <p className="text-xs text-muted-foreground">本地优先的 AI 桌面工作台</p>
        </div>
      </header>

      <section className="space-y-1.5">
        <div className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <span className="text-muted-foreground">版本</span>
          <span className="font-mono">{version || '加载中…'}</span>
          <span className="text-muted-foreground">平台</span>
          <span className="font-mono text-xs">{window.api.platform ?? 'unknown'}</span>
          <span className="text-muted-foreground">仓库</span>
          <a
            href="https://gitee.com/leonops/SuperStudio"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline inline-flex items-center gap-1"
          >
            gitee.com/leonops/SuperStudio
            <ExternalLink size={11} />
          </a>
        </div>
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><RefreshCw size={13} /> 自动更新</h3>
        <div className="flex items-center gap-3 text-sm">
          <StatusIcon tone={label.tone} />
          <span className={label.tone === 'bad' ? 'text-destructive' : 'text-foreground/85'}>{label.text}</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={manualCheck}
            disabled={checking || status.kind === 'checking' || status.kind === 'disabled'}
            className="btn-secondary"
          >
            {checking || status.kind === 'checking' ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            立即检查
          </button>
          {status.kind === 'ready' && (
            <button onClick={() => window.api.installUpdate?.()} className="btn-primary">
              重启并安装 v{status.version}
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          更新来自 GitHub Releases，应用启动后会自动检查，运行中每小时复查一次。开发模式下不检查。
        </p>
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Database size={13} /> 数据备份</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          一键打包导出所有本地配置（提供商、默认模型、MCP 服务器、应用设置）。
          换电脑或重装时导入这个文件即可恢复，无需逐项重填 API Key。
          <strong className="text-foreground"> 不</strong>包含对话记录、画廊文件、知识库向量等大体积数据。
        </p>
        <div className="flex gap-2">
          <button
            onClick={onExportData}
            disabled={exportRunning}
            className="btn-secondary"
          >
            {exportRunning ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            导出配置
          </button>
          <button
            onClick={onImportData}
            disabled={importRunning}
            className="btn-secondary"
          >
            {importRunning ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            导入配置
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          导出文件中所有 API Key 已用机器密钥加密；移动到另一台机器后需要重新填写 Key，但其它设置都会保留。
        </p>
      </section>

      <section className="space-y-2 border-t border-border pt-5 text-xs text-muted-foreground/80">
        <p>开源协议：MIT</p>
      </section>
    </div>
  )
}

function StatusIcon({ tone }: { tone: 'idle' | 'good' | 'work' | 'bad' | 'mute' }) {
  const cls = 'shrink-0'
  switch (tone) {
    case 'good': return <Check size={14} className={cls + ' text-emerald-600'} />
    case 'bad':  return <AlertCircle size={14} className={cls + ' text-destructive'} />
    case 'work': return <Loader2 size={14} className={cls + ' animate-spin text-primary'} />
    default:     return <span className={cls + ' w-3.5 h-3.5 rounded-full bg-muted-foreground/30'} />
  }
}
