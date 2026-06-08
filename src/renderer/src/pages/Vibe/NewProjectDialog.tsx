import { useState, useEffect } from 'react'
import { BRAND } from '@shared/brand'
import { X, Loader2, Plus, Folder, AlertTriangle } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (path: string) => void | Promise<void>
}

type LocationMode = 'managed' | 'custom'

export function NewProjectDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [mode, setMode] = useState<LocationMode>('managed')
  const [customLocation, setCustomLocation] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setMode('managed')
      setCustomLocation('')
      setError(null)
    }
  }, [open])

  if (!open) return null

  async function pickCustomLocation() {
    try {
      const paths = await window.api.openFileDialog({ properties: ['openDirectory'] })
      if (paths?.[0]) setCustomLocation(paths[0])
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function submit() {
    const trimmedName = name.trim()
    if (!trimmedName) { setError('请输入项目名称'); return }
    if (/[\\/:*?"<>|]/.test(trimmedName)) { setError('项目名称包含非法字符'); return }
    if (mode === 'custom' && !customLocation) { setError('请选择存放目录'); return }
    setCreating(true)
    setError(null)
    try {
      const result = await window.api.vibeNewProject({
        name: trimmedName,
        location: mode === 'custom' ? customLocation : undefined
      }) as { path: string }
      await onCreated(result.path)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-popover border border-border rounded-xl shadow-2xl w-[480px] max-w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Plus size={14} /> 新建项目
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">项目名称</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例如 my-landing-page"
              className="input w-full"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">存放位置</label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-border hover:bg-accent/30">
                <input
                  type="radio"
                  checked={mode === 'managed'}
                  onChange={() => setMode('managed')}
                  className="mt-0.5 accent-primary"
                />
                <div className="flex-1 text-xs">
                  <div className="font-medium">应用管理（推荐）</div>
                  <div className="text-muted-foreground mt-0.5">
                    存放在 {BRAND.displayName} 的数据目录下，无需自己维护
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-border hover:bg-accent/30">
                <input
                  type="radio"
                  checked={mode === 'custom'}
                  onChange={() => setMode('custom')}
                  className="mt-0.5 accent-primary"
                />
                <div className="flex-1 text-xs">
                  <div className="font-medium">自定义路径</div>
                  <div className="mt-1 flex gap-1.5">
                    <input
                      type="text"
                      value={customLocation}
                      onChange={e => setCustomLocation(e.target.value)}
                      placeholder="选择一个文件夹…"
                      className="flex-1 input !py-1 text-[11px] font-mono"
                      disabled={mode !== 'custom'}
                    />
                    <button
                      type="button"
                      onClick={pickCustomLocation}
                      disabled={mode !== 'custom'}
                      className="px-2 rounded border border-border text-[11px] hover:bg-accent disabled:opacity-50 flex items-center gap-1"
                    >
                      <Folder size={11} /> 浏览
                    </button>
                  </div>
                  {mode === 'custom' && customLocation && name && (
                    <div className="text-muted-foreground/60 mt-1 font-mono text-[10px] truncate">
                      → {customLocation}/{name}
                    </div>
                  )}
                </div>
              </label>
            </div>
          </div>

          <div className="flex items-start gap-2 text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded px-2.5 py-2">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <div>AI 会直接修改这个文件夹里的文件。重要项目请先 <code className="font-mono">git commit</code> 一下。</div>
          </div>

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} className="btn-secondary text-sm">取消</button>
          <button
            onClick={submit}
            disabled={creating || !name.trim()}
            className="btn-primary text-sm flex items-center gap-1.5"
          >
            {creating && <Loader2 size={12} className="animate-spin" />}
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
