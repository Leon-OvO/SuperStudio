import { useMemo, useState } from 'react'
import { X, FolderPlus, Check, PackageSearch } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { DiscoveredSkillInfo } from '../../../../shared/ipc-types'

const SOURCE_LABEL: Record<DiscoveredSkillInfo['source'], string> = {
  claude: 'Claude Code',
  project: '当前项目',
  custom: '自定义目录',
}

interface Props {
  discovered: DiscoveredSkillInfo[]
  onClose: () => void
  /** Import the chosen bundle paths. */
  onImport: (paths: string[]) => void | Promise<void>
  /** Pick a folder to add to the scan list, then re-scan. */
  onAddScanDir: () => void | Promise<void>
}

export function DiscoverDialog({ discovered, onClose, onImport, onAddScanDir }: Props) {
  // Importable = not already imported. Pre-select all importable ones.
  const importable = useMemo(() => discovered.filter(d => !d.alreadyImported), [discovered])
  const [selected, setSelected] = useState<Set<string>>(() => new Set(importable.map(d => d.path)))
  const [busy, setBusy] = useState(false)

  const toggle = (path: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path); else next.add(path)
      return next
    })
  }
  const allSelected = importable.length > 0 && importable.every(d => selected.has(d.path))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(importable.map(d => d.path)))
  }

  async function doImport() {
    const paths = importable.filter(d => selected.has(d.path)).map(d => d.path)
    if (!paths.length) return
    setBusy(true)
    try { await onImport(paths) } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-[560px] max-h-[78vh] flex flex-col rounded-xl border border-border bg-card shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border shrink-0">
          <PackageSearch size={16} className="text-primary" />
          <span className="text-sm font-semibold">导入本机已装技能</span>
          <span className="text-[11px] text-muted-foreground">共 {discovered.length} 个</span>
          <div className="flex-1" />
          <button onClick={onClose} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"><X size={15} /></button>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {discovered.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              没有发现可导入的本地技能。<br />可点下方「添加扫描目录」指向你的技能文件夹。
            </div>
          ) : (
            discovered.map(d => {
              const disabled = d.alreadyImported
              const checked = selected.has(d.path)
              return (
                <button
                  key={d.path}
                  disabled={disabled}
                  onClick={() => !disabled && toggle(d.path)}
                  className={cn(
                    'w-full flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left',
                    disabled ? 'opacity-50 cursor-default' : 'hover:bg-accent/50 cursor-pointer'
                  )}
                >
                  <span className={cn(
                    'mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0',
                    disabled ? 'border-border bg-muted' : checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                  )}>
                    {(checked || disabled) && <Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">{d.name}</span>
                      <span className="text-[10px] px-1 rounded bg-muted-foreground/15 text-muted-foreground shrink-0">{SOURCE_LABEL[d.source]}</span>
                      {disabled && <span className="text-[10px] text-emerald-600 shrink-0">已导入</span>}
                    </span>
                    {d.description && <span className="block text-[11px] text-muted-foreground truncate">{d.description}</span>}
                    <span className="block text-[10px] text-muted-foreground/50 truncate">{d.path} · {d.fileCount} 个文件</span>
                  </span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 h-14 border-t border-border shrink-0">
          <button
            onClick={onAddScanDir}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <FolderPlus size={13} /> 添加扫描目录
          </button>
          {importable.length > 0 && (
            <button onClick={toggleAll} className="text-xs text-muted-foreground hover:text-foreground px-1.5 py-1">
              {allSelected ? '取消全选' : '全选'}
            </button>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-accent">取消</button>
          <button
            onClick={doImport}
            disabled={busy || importable.filter(d => selected.has(d.path)).length === 0}
            className="px-3 py-1.5 rounded-md text-xs bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-40"
          >
            {busy ? '导入中…' : `导入所选 (${importable.filter(d => selected.has(d.path)).length})`}
          </button>
        </div>
      </div>
    </div>
  )
}
