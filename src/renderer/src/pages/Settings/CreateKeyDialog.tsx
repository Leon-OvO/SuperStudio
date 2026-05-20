import { useState, useEffect } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { Select } from '../../components/ui/Select'
import type { AvailableGroupInfo } from '../../../../shared/ipc-types'

interface Props {
  open: boolean
  defaultGroupId?: number
  onClose: () => void
  onCreated: () => void | Promise<void>
}

export function CreateKeyDialog({ open, defaultGroupId, onClose, onCreated }: Props) {
  const [groups, setGroups] = useState<AvailableGroupInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<string>('')
  const [name, setName] = useState('')

  useEffect(() => {
    if (!open) return
    setError(null)
    setLoading(true)
    window.api.listAvailableGroups?.()
      .then((g: AvailableGroupInfo[] | undefined) => {
        const list = g ?? []
        setGroups(list)
        const initial = defaultGroupId && list.some(x => x.id === defaultGroupId)
          ? String(defaultGroupId)
          : (list[0] ? String(list[0].id) : '')
        setGroupId(initial)
        const grp = list.find(x => String(x.id) === initial)
        setName(grp
          ? `SuperStudio-${grp.name}-${new Date().toLocaleDateString('zh-CN').replace(/\//g, '')}`
          : ''
        )
      })
      .catch(e => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [open, defaultGroupId])

  useEffect(() => {
    const grp = groups.find(g => String(g.id) === groupId)
    if (grp) {
      setName(`SuperStudio-${grp.name}-${new Date().toLocaleDateString('zh-CN').replace(/\//g, '')}`)
    }
  }, [groupId, groups])

  if (!open) return null

  async function handleSubmit() {
    const id = parseInt(groupId, 10)
    if (!id) { setError('请选择分组'); return }
    const trimmed = name.trim()
    if (!trimmed) { setError('请输入 Key 名称'); return }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.createKey?.({ groupId: id, name: trimmed })
      await onCreated()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-popover border border-border rounded-xl shadow-2xl w-[440px] max-w-full"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Plus size={14} /> 新建 API Key
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
              <Loader2 size={14} className="animate-spin" /> 加载分组…
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              没有可用的分组。
            </p>
          ) : (
            <>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">分组（决定平台和定价）</label>
                <Select
                  value={groupId}
                  onChange={setGroupId}
                  options={groups.map(g => ({
                    value: String(g.id),
                    label: `${g.name} · ${g.platform}`
                  }))}
                  size="md"
                  className="w-full [&>span]:w-full"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Key 名称</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="input w-full"
                  placeholder="例如 SuperStudio-备用"
                  autoFocus
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleSubmit() }
                  }}
                />
              </div>
            </>
          )}

          {error && (
            <p className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} className="btn-secondary text-sm">
            取消
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || loading || groups.length === 0}
            className="btn-primary text-sm flex items-center gap-1.5"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
