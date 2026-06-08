import { useState } from 'react'
import { FolderOpen, Loader2, Info, Zap } from 'lucide-react'
import type { AppSettings } from '../../../shared/ipc-types'

interface Props {
  /** Called after settings have been saved with the chosen path. */
  onDone: () => void
}

/**
 * Blocking first-run gate that requires the user to pick a data directory
 * before the rest of the app loads. Without a custom path the app falls back
 * to system AppData, which makes the install hard to back up or migrate.
 * The Settings UI still lets the user change it later — this just guarantees
 * the initial choice is conscious.
 */
export function DataDirectorySetup({ onDone }: Props): JSX.Element {
  const [selected, setSelected] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>('')

  async function pickDirectory() {
    setError('')
    const paths = await window.api.openFileDialog?.({ properties: ['openDirectory'] }) as string[] | undefined
    if (paths?.[0]) setSelected(paths[0])
  }

  async function confirm() {
    if (!selected) {
      setError('请先选择一个目录')
      return
    }
    setSaving(true)
    setError('')
    try {
      const current = await window.api.getSettings() as AppSettings
      await window.api.setSettings({ ...current, dataDirectory: selected })
      onDone()
    } catch (e) {
      setError('保存失败：' + ((e as Error).message || '未知错误'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center p-6">
      <div className="w-[480px] space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-primary flex items-center justify-center">
            <Zap size={20} className="text-primary-foreground" fill="currentColor" />
          </div>
          <h1 className="text-xl font-semibold">设置数据目录</h1>
          <p className="text-sm text-muted-foreground">
            选择一个文件夹用于存放图片、视频、知识库和数据库。这一步是必需的，方便你后续备份和迁移数据。
          </p>
        </div>

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <div className="flex items-start gap-2 text-xs text-foreground/80">
            <Info size={14} className="text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>建议选择非系统盘（例如 D:\SuperStudio）下一个独立目录。</p>
              <p>选定后可随时在「设置 → 模型 → 数据存储」中更改，但更改后需要手动迁移已有文件。</p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={pickDirectory}
            disabled={saving}
            className="w-full px-3 py-2.5 rounded-lg border border-dashed border-border hover:border-primary hover:bg-accent transition-colors flex items-center gap-2 text-sm"
          >
            <FolderOpen size={16} className="text-muted-foreground" />
            <span className={selected ? 'text-foreground' : 'text-muted-foreground'}>
              {selected || '点击选择目录…'}
            </span>
          </button>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <button
          type="button"
          onClick={confirm}
          disabled={!selected || saving}
          className="btn-primary w-full flex items-center justify-center gap-2"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          确认并进入应用
        </button>
      </div>
    </div>
  )
}
