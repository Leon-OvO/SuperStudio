import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Sparkles, ExternalLink, Database, Download, Upload, FileWarning, Trash2, Copy } from 'lucide-react'
import { useT } from '../../lib/i18n'

interface Props {
  onExportData: () => void
  onImportData: (strategy?: 'merge' | 'replace') => void
  exportRunning?: boolean
  importRunning?: boolean
  onExportChats?: () => void
  onImportChats?: (strategy?: 'merge' | 'replace') => void
  chatExportRunning?: boolean
  chatImportRunning?: boolean
}

export function About({
  onExportData, onImportData, exportRunning, importRunning,
  onExportChats, onImportChats, chatExportRunning, chatImportRunning
}: Props) {
  const [version, setVersion] = useState<string>('')
  const t = useT()

  useEffect(() => {
    window.api.appVersion?.().then((v: string) => setVersion(v)).catch(() => {})
  }, [])

  return (
    <div className="space-y-6 max-w-2xl">
      <header className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary flex items-center justify-center shadow-md shadow-primary/30">
          <Sparkles size={18} className="text-primary-foreground" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t('about.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('about.tagline')}</p>
        </div>
      </header>

      <section className="space-y-1.5">
        <div className="grid grid-cols-[120px_1fr] gap-y-2 text-sm">
          <span className="text-muted-foreground">{t('about.version')}</span>
          <span className="font-mono">{version || t('about.loading')}</span>
          <span className="text-muted-foreground">{t('about.platform')}</span>
          <span className="font-mono text-xs">{window.api.platform ?? 'unknown'}</span>
          <span className="text-muted-foreground">{t('about.repo')}</span>
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
        <h3 className="text-sm font-medium flex items-center gap-1.5"><Database size={13} /> {t('about.dataBackup')}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          一键打包导出所有本地配置（提供商、默认模型、MCP 服务器、应用设置）。
          换电脑或重装时导入这个文件即可恢复，无需逐项重填 API Key。
          <strong className="text-foreground"> 不</strong>包含对话记录、画廊文件、知识库向量等大体积数据。
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onExportData}
            disabled={exportRunning}
            className="btn-secondary"
          >
            {exportRunning ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t('about.exportConfig')}
          </button>
          <button
            onClick={() => onImportData('merge')}
            disabled={importRunning}
            className="btn-secondary"
            title="保留本机现有提供商和 MCP 服务器，相同 id 的会被文件里的覆盖"
          >
            {importRunning ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {t('about.importMerge')}
          </button>
          <button
            onClick={() => onImportData('replace')}
            disabled={importRunning}
            className="btn-secondary text-destructive hover:!bg-destructive/10"
            title="先清空本机配置再导入。本机有但文件没有的条目会被删除"
          >
            <Upload size={13} />
            {t('about.importReplace')}
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          导出文件中所有 API Key 已用机器密钥加密；移动到另一台机器后需要重新填写 Key，但其它设置都会保留。
        </p>
      </section>

      {onExportChats && (
        <section className="space-y-3 border-t border-border pt-5">
          <h3 className="text-sm font-medium flex items-center gap-1.5"><Database size={13} /> 对话备份</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            打包导出所有会话和消息内容（不含附件文件本身，只保留路径引用）。换机器或重装时可一键恢复。
            画廊图片 / 视频文件需要另行用 <strong className="text-foreground">画廊 → 批量保存到文件夹</strong> 备份。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onExportChats}
              disabled={chatExportRunning}
              className="btn-secondary"
            >
              {chatExportRunning ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              导出全部对话
            </button>
            <button
              onClick={() => onImportChats?.('merge')}
              disabled={chatImportRunning}
              className="btn-secondary"
              title="保留本机现有对话，文件里同 id 的对话会被跳过"
            >
              {chatImportRunning ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              合并导入
            </button>
            <button
              onClick={() => onImportChats?.('replace')}
              disabled={chatImportRunning}
              className="btn-secondary text-destructive hover:!bg-destructive/10"
              title="先清空本机所有对话和消息再导入"
            >
              <Upload size={13} />
              替换导入
            </button>
          </div>
        </section>
      )}

      <ErrorLogSection />

      <section className="space-y-2 border-t border-border pt-5 text-xs text-muted-foreground/80">
        <p>开源协议：MIT</p>
      </section>
    </div>
  )
}

interface LogEntry {
  ts: number
  level: 'error' | 'warn' | 'info'
  source: 'main' | 'renderer'
  message: string
  stack?: string
  context?: Record<string, unknown>
}

function ErrorLogSection() {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  async function refresh() {
    setLoading(true)
    try {
      const data = await window.api.listErrorLog?.() as LogEntry[]
      setEntries(data ?? [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (open) refresh() }, [open])

  async function clearAll() {
    if (!confirm('确定清空错误日志？已写入磁盘的旧条目也会被删除。')) return
    await window.api.clearErrorLog?.()
    setEntries([])
  }

  async function copyAll() {
    const text = entries.map(e =>
      `[${new Date(e.ts).toISOString()}] ${e.level.toUpperCase()} (${e.source}) ${e.message}` +
      (e.stack ? '\n' + e.stack : '')
    ).join('\n\n')
    try { await navigator.clipboard.writeText(text || '(空)') }
    catch (e) { console.error('clipboard write failed', e) }
  }

  const errorCount = entries.filter(e => e.level === 'error').length
  const warnCount = entries.filter(e => e.level === 'warn').length

  return (
    <section className="space-y-3 border-t border-border pt-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-1.5"><FileWarning size={13} /> 错误日志</h3>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? '收起' : '展开查看'}
        </button>
      </div>
      <p className="text-xs text-muted-foreground/80 leading-relaxed">
        记录主进程 / 渲染层最近 500 条 error / warn / info，全部存在你本机的
        <code className="mx-1 px-1 rounded bg-muted/60 font-mono text-[11px]">userData/logs/app.log.jsonl</code>，
        不会上传任何地方。出问题时复制日志贴给维护者最高效。
      </p>
      {open && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              共 <strong className="text-foreground">{entries.length}</strong> 条
              {errorCount > 0 && <> · <span className="text-destructive">{errorCount} 错误</span></>}
              {warnCount > 0 && <> · <span className="text-amber-600">{warnCount} 警告</span></>}
            </span>
            <button onClick={refresh} disabled={loading} className="ml-auto btn-secondary">
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              刷新
            </button>
            <button onClick={copyAll} disabled={entries.length === 0} className="btn-secondary">
              <Copy size={12} /> 复制
            </button>
            <button onClick={clearAll} disabled={entries.length === 0} className="btn-secondary">
              <Trash2 size={12} /> 清空
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-muted/20 text-[11px] font-mono divide-y divide-border/60">
            {entries.length === 0 ? (
              <div className="px-3 py-4 text-muted-foreground/60 text-center">{loading ? '加载中…' : '日志为空'}</div>
            ) : entries.slice().reverse().map((e, i) => (
              <details key={i} className="px-3 py-1.5 group" open={e.level === 'error' && i < 3}>
                <summary className={
                  'cursor-pointer truncate ' +
                  (e.level === 'error' ? 'text-destructive' : e.level === 'warn' ? 'text-amber-600' : 'text-foreground/80')
                }>
                  <span className="text-muted-foreground/60 mr-2">{new Date(e.ts).toLocaleTimeString('zh-CN')}</span>
                  <span className="text-[10px] uppercase mr-2">[{e.source}]</span>
                  {e.message}
                </summary>
                {e.stack && (
                  <pre className="mt-1 whitespace-pre-wrap text-[10px] text-muted-foreground/80 leading-snug">{e.stack}</pre>
                )}
              </details>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

